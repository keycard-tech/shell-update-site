// GitHub serves release assets without CORS headers, so the bytes a page flashes are mirrored at build time.

import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { DB_FORMAT, DB_MAGIC, SIG_SIZE, databaseFormat, databaseMagic, databaseVersion, firmwareFlags, firmwareVersion, flashImage, sha256 } from "./binfmt.mjs";
import { ARTIFACTS } from "./site.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

// A release carries other images (bootloader, dev, btc-only); the pattern is the one that gets flashed.
const RELEASES = {
  firmware: {
    repo: "keycard-tech/keycard-shell",
    match: /^shellos-\d{8}-(\d+\.\d+\.\d+)\.bin$/,
    // Its sha256 file lists the asset by uploaded name.
    checksum: (asset) => asset.name,
    flashHash: flashImage,
    file: ARTIFACTS.firmware,
    readVersion: releaseFirmware,
  },
  database: {
    repo: "keycard-tech/keycard-eth-db",
    match: /^shelldb-(\d{8})\.bin$/,
    // Its sha256 file lists the file as built (db.bin), not as uploaded (shelldb-<date>.bin).
    checksum: () => "db.bin",
    flashHash: (bytes) => sha256(bytes.subarray(0, bytes.length - SIG_SIZE)),
    file: ARTIFACTS.database,
    readVersion: releaseDatabase,
  },
};

const DATABASE_ZIP = /^db-(\d{8})-reproduction\.zip$/;

// Upstream uploads a release from more than one job, so the file certifying an image can turn up minutes later.
const UPLOAD_ATTEMPTS = Number(process.env.SYNC_UPLOAD_ATTEMPTS ?? 5);
const UPLOAD_DELAY_MS = Number(process.env.SYNC_UPLOAD_DELAY_SECONDS ?? 60) * 1000;

const args = process.argv.slice(2);
const arg = (name, fallback) => (args.includes(`--${name}`) ? args[args.indexOf(`--${name}`) + 1] : fallback);

// The new mirror is assembled in STAGING and swapped into MIRROR only once it verifies, so a failed run keeps the old one.
const MIRROR = resolve(ROOT, arg("media", "pages/media"));
const STAGING = `${MIRROR}.tmp`;
const DRY_RUN = args.includes("--dry-run");

const token = process.env.GH_TOKEN ?? process.env.GITHUB_TOKEN;
let rateLimited = false;

async function request(url, accept = "application/vnd.github+json") {
  const response = await fetch(url, {
    headers: {
      "User-Agent": "keycard-tech/shell-update-site",
      Accept: accept,
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
  });

  if (!response.ok) {
    const limited = response.status === 403 || response.status === 429;

    rateLimited ||= limited;

    const hint = token === undefined && limited ? " (set GH_TOKEN: GitHub answers 60 unauthenticated requests an hour)" : "";

    throw new Error(`${response.status} ${response.statusText} for ${url}${hint}`);
  }

  return response;
}

const json = async (url) => request(url).then((r) => r.json());
const text = async (url) => request(url, "text/plain").then((r) => r.text());
const bytes = async (url) => request(url, "application/octet-stream").then((r) => r.arrayBuffer().then((b) => Buffer.from(b)));

const sleep = (ms) => new Promise((wait) => setTimeout(wait, ms));

// What the site offers is a release build: not a beta or a variant, and a real Shell database.
function releaseFirmware(image) {
  const flags = firmwareFlags(image);

  if (flags !== 0) throw new Error(`image is a beta or variant build (flags byte ${flags}), not the release the site offers`);

  return firmwareVersion(image);
}

function releaseDatabase(file) {
  const magic = databaseMagic(file);

  if (magic !== DB_MAGIC) throw new Error(`file starts with magic ${magic.toString(16)}, not the Shell database magic 0x4532`);

  const format = databaseFormat(file);

  if (format !== DB_FORMAT) console.warn(`database format is ${format}, this script expects ${DB_FORMAT}`);

  return databaseVersion(file);
}

const versionOf = (tag) => tag.replace(/^v/, "");
const assetIn = (release, pattern) => (release.assets ?? []).filter((asset) => pattern.test(asset.name));

// keycard-shell-webapp stored timestamps as '%Y-%m-%d %H:%M' and the page scripts re-parse that shape.
const timestamp = (iso) => iso.slice(0, 16).replace("T", " ");

async function releases(kind) {
  const all = await json(`https://api.github.com/repos/${RELEASES[kind].repo}/releases?per_page=100`);
  const published = all.filter((release) => !release.draft && !release.prerelease);

  if (published.length !== all.length) console.log(`${RELEASES[kind].repo}: ${all.length - published.length} draft or prerelease skipped`);

  return published;
}

const releaseByTag = (kind, tag) => json(`https://api.github.com/repos/${RELEASES[kind].repo}/releases/tags/${tag}`);

// The hash the release publishes for this artifact, or undefined if the release does not publish one for it.
async function publishedChecksum(release, name) {
  const [file] = assetIn(release, /-sha256\.txt$/);

  if (file === undefined) return undefined;

  const lines = (await text(file.browser_download_url))
    .split("\n")
    .filter((line) => !line.startsWith("#") && line.trim() !== "")
    .map((line) => line.trim().split(/\s+/));

  return lines.find(([, entry]) => entry === name)?.[0];
}

// To be mirrored a release needs the image and a published checksum naming it.
async function readiness(kind, release) {
  const [asset] = assetIn(release, RELEASES[kind].match);

  if (asset === undefined) return { ok: false, reason: "no image asset" };
  if (assetIn(release, /-sha256\.txt$/).length === 0) return { ok: false, reason: "publishes no sha256 file" };

  const published = await publishedChecksum(release, RELEASES[kind].checksum(asset));

  return published === undefined
    ? { ok: false, reason: `${asset.name} is not in the published sha256 file` }
    : { ok: true, asset, published };
}

// A release that has some files but not the ones needed is most likely still being uploaded.
const uploadStarted = (release) => (release.assets ?? []).length > 0;

async function awaitUpload(kind, release, retries) {
  let ready = await readiness(kind, release);

  for (let attempt = 1; !ready.ok && uploadStarted(release) && attempt <= retries; attempt++) {
    console.warn(`${release.tag_name}: ${ready.reason}, waiting ${UPLOAD_DELAY_MS / 1000}s for the upload (${attempt}/${retries})`);
    await sleep(UPLOAD_DELAY_MS);
    release = await releaseByTag(kind, release.tag_name);
    ready = await readiness(kind, release);
  }

  return { release, ready };
}

// A checksum that disagrees is corruption and stops the run; a missing file only means the release is unverifiable.
const write = async (file, data) => {
  await mkdir(dirname(join(STAGING, file)), { recursive: true });
  await writeFile(join(STAGING, file), data);
};

const writeJson = (file, value) => write(file, `${JSON.stringify(value, null, 2)}\n`);

async function verifyAndWrite(kind, release, asset, published) {
  const artifact = RELEASES[kind];
  const data = await bytes(asset.browser_download_url);

  if (data.byteLength !== asset.size) throw new Error(`${asset.name}: got ${data.byteLength} of ${asset.size} bytes`);

  const flashHash = artifact.flashHash(data);
  const version = artifact.readVersion(data);

  if (published !== flashHash) throw new Error(`${asset.name}: ${flashHash} does not match the published ${published}`);
  if (version !== versionOf(release.tag_name)) throw new Error(`${asset.name}: carries version ${version}, its release is tagged ${release.tag_name}`);

  await write(artifact.file, data);

  return { version, tag: release.tag_name, release: release.html_url, asset: asset.name, size: asset.size, hash: sha256(data), flash_hash: flashHash };
}

// Newest first: mirror the first release that verifies, report the ones passed over, wait only on the newest.
async function mirrorLatest(kind, published) {
  const skipped = [];

  for (const [index, tagged] of published.entries()) {
    const { release, ready } = await awaitUpload(kind, tagged, index === 0 ? UPLOAD_ATTEMPTS : 0);

    if (!ready.ok) {
      console.warn(`${release.tag_name}: ${ready.reason}, not mirrored`);
      skipped.push({ kind, tag: release.tag_name, reason: ready.reason });
      continue;
    }

    return { current: await verifyAndWrite(kind, release, ready.asset, ready.published), release, index, skipped };
  }

  return { current: null, skipped };
}

// The history starts at the mirrored release, whose freshest reading is the one that was verified.
const releasesBelow = (published, mirrored) =>
  published.slice(mirrored.index).map((release) => (release.tag_name === mirrored.release.tag_name ? mirrored.release : release));

async function syncFirmware() {
  const published = await releases("firmware");
  const mirrored = await mirrorLatest("firmware", published);

  if (mirrored.current === null) throw new Error(`no release of ${RELEASES.firmware.repo} offers a verifiable firmware image`);

  const notes = [];

  for (const release of releasesBelow(published, mirrored)) {
    if (assetIn(release, RELEASES.firmware.match).length === 0) continue;

    const version = versionOf(release.tag_name);

    // release_notes.ts reads line 1 as the date and renders the rest as markdown; release bodies carry CRLF.
    notes.push({ version, changelog: `changelogs/${version}.md` });
    await write(`changelogs/${version}.md`, `${timestamp(release.published_at)}\n${(release.body ?? "").replace(/\r\n/g, "\n")}`);
  }

  return { current: mirrored.current, skipped: mirrored.skipped, notes };
}

async function syncDatabase() {
  const repo = RELEASES.database.repo;
  const published = await releases("database");
  const mirrored = await mirrorLatest("database", published);

  if (mirrored.current === null) throw new Error(`no release of ${repo} offers a verifiable database`);

  const history = [];

  for (const release of releasesBelow(published, mirrored)) {
    const version = versionOf(release.tag_name);
    const [zip] = assetIn(release, DATABASE_ZIP);

    // The history page links this zip, so a release without one has nothing to show.
    if (zip === undefined) {
      console.warn(`${release.tag_name}: no reproduction zip, left out of the history`);
      continue;
    }

    // eth-db commits manifest.txt at the tag, naming the three sources it fetched.
    const manifest = await text(`https://raw.githubusercontent.com/${repo}/${release.tag_name}/manifest.txt`).catch((err) => {
      console.warn(`${release.tag_name}: ${err.message}, left out of the history`);
      return null;
    });

    if (manifest === null) continue;

    const source = (label) => manifest.match(new RegExp(`^${label}:\\s*(\\S+)`, "m"))?.[1];
    const links = { token_link: source("ERC20 token list source"), chain_link: source("Chain list source"), abi_link: source("ABI list source") };

    if (Object.values(links).some((link) => link === undefined)) {
      console.warn(`${release.tag_name}: manifest.txt does not name all three sources, left out of the history`);
      continue;
    }

    history.push({ zip_path: zip.browser_download_url, version, creation_date: timestamp(release.published_at), ...links });
  }

  return { current: mirrored.current, skipped: mirrored.skipped, history };
}

async function rebuild(previous) {
  const firmware = await syncFirmware();
  const database = await syncDatabase();

  // The documents name the artifacts, so they are written once both sides are downloaded and verified.
  await writeJson("get-firmware.json", { fw_path: RELEASES.firmware.file, version: firmware.current.version, hash: firmware.current.hash });
  await writeJson("get-db.json", { db_path: RELEASES.database.file, hash: database.current.hash, version: database.current.version });
  await writeJson("get-firmwares.json", firmware.notes);
  await writeJson("get-dbs.json", database.history);
  await writeJson("sync.json", {
    synced_at: new Date().toISOString(),
    firmware: firmware.current,
    database: database.current,
    incomplete: [...firmware.skipped, ...database.skipped],
  });

  // The old mirror moves aside rather than being deleted first, so there is never a moment with no mirror.
  const stale = `${MIRROR}.old`;

  await rm(stale, { recursive: true, force: true });
  await rename(MIRROR, stale).catch(() => null);
  await rename(STAGING, MIRROR);
  await rm(stale, { recursive: true, force: true });

  for (const [kind, { current }] of [["firmware", firmware], ["database", database]]) {
    const before = previous?.[kind]?.version;

    console.log(`${kind}: ${current.version}${before && before !== current.version ? ` (was ${before})` : ""} ${current.hash} ${current.asset}`);
  }

  for (const { kind, tag, reason } of [...firmware.skipped, ...database.skipped]) console.warn(`${kind}: ${tag} was not mirrored (${reason})`);
}

const previous = await readFile(join(MIRROR, "sync.json"), "utf8").then(JSON.parse).catch(() => null);

if (DRY_RUN) {
  for (const kind of Object.keys(RELEASES)) {
    const version = versionOf((await releases(kind))[0].tag_name);
    const mirrored = previous?.[kind]?.version ?? "nothing";

    console.log(`${kind}: upstream ${version}, mirrored ${mirrored}${mirrored === version ? " (up to date)" : " (out of date)"}`);
  }

  process.exit(0);
}

await rm(STAGING, { recursive: true, force: true });

try {
  await rebuild(previous);
} catch (err) {
  // Quota exhaustion is no verdict on the releases: keep the verified mirror, but never tolerate it when a token was sent.
  if (!rateLimited || token !== undefined || previous === null) throw err;

  console.warn(`out of quota, keeping what is mirrored: firmware ${previous.firmware.version}, database ${previous.database.version}, synced ${previous.synced_at}`);
  console.warn(`set GH_TOKEN to look for a newer release`);
  process.exit(0);
}
