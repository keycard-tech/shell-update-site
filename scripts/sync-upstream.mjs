// GitHub serves release assets without CORS headers, so the bytes a page flashes are mirrored at build time.

import { createHash } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { ARTIFACTS } from "./site.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

// Shell flash geometry, from keycard-shell/tools/common.py and stm32/Core/Inc/stm32.h.
const PAGE_SIZE = 8192;
const FW_PAGE_COUNT = 76;
const FW_IV_SIZE = 588;
const SIG_SIZE = 64;
// The header is the signature over the image, then four version bytes: major, minor, patch, flags.
const FW_VERSION_OFFSET = FW_IV_SIZE + SIG_SIZE;
// keycard-eth-db/tools/shell-db.py opens the database with struct.pack("<HHI", 0x4532, 4, version).
const DB_MAGIC = 0x4532;
const DB_FORMAT = 4;

// A release carries other images (bootloader, dev, btc-only); the pattern is the one that gets flashed.
const RELEASES = {
  firmware: {
    repo: "keycard-tech/keycard-shell",
    match: /^shellos-\d{8}-(\d+\.\d+\.\d+)\.bin$/,
    // Its sha256 file lists the asset by uploaded name.
    checksum: (asset) => asset.name,
    flashHash: flashImage,
    file: ARTIFACTS.firmware,
    readVersion: firmwareVersion,
  },
  database: {
    repo: "keycard-tech/keycard-eth-db",
    match: /^shelldb-(\d{8})\.bin$/,
    // Its sha256 file lists the file as built (db.bin), not as uploaded (shelldb-<date>.bin).
    checksum: () => "db.bin",
    flashHash: (bytes) => sha256(bytes.subarray(0, bytes.length - SIG_SIZE)),
    file: ARTIFACTS.database,
    readVersion: databaseVersion,
  },
};

const DATABASE_ZIP = /^db-(\d{8})-reproduction\.zip$/;

const args = process.argv.slice(2);
const arg = (name, fallback) => (args.includes(`--${name}`) ? args[args.indexOf(`--${name}`) + 1] : fallback);

const MIRROR = resolve(ROOT, arg("media", "pages/media"));
// A sync that fails halfway must not cost the site the artifacts it already had, so the new mirror is
// built in a sibling directory and swapped in only after every release was downloaded and verified.
const MEDIA = `${MIRROR}.tmp`;
const DRY_RUN = args.includes("--dry-run");

// Upstream publishes a release from more than one job, so the checksum file can arrive minutes after the
// image it certifies.
const UPLOAD_ATTEMPTS = Number(process.env.SYNC_UPLOAD_ATTEMPTS ?? 5);
const UPLOAD_DELAY_MS = Number(process.env.SYNC_UPLOAD_DELAY_SECONDS ?? 60) * 1000;

// Releases that could not be verified, recorded in sync.json: the site is meant to keep serving the last
// complete release rather than stop.
const incomplete = [];

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

const sha256 = (data) => createHash("sha256").update(data).digest("hex");

// The digest the bootloader verifies and the releases publish: not a plain sha256sum of the file.
function flashImage(bytes) {
  const image = Buffer.alloc(PAGE_SIZE * FW_PAGE_COUNT, 0xff);
  bytes.copy(image);

  return sha256(Buffer.concat([image.subarray(0, FW_IV_SIZE), image.subarray(FW_IV_SIZE + SIG_SIZE)]));
}

function firmwareVersion(bytes) {
  const [major, minor, patch, flags] = bytes.subarray(FW_VERSION_OFFSET, FW_VERSION_OFFSET + 4);

  if (flags !== 0) throw new Error(`image is a beta or variant build (flags byte ${flags}), not the release the site offers`);

  return `${major}.${minor}.${patch}`;
}

function databaseVersion(bytes) {
  if (bytes.readUInt16LE(0) !== DB_MAGIC) throw new Error(`file starts with magic ${bytes.readUInt16LE(0).toString(16)}, not the Shell database magic 0x4532`);

  const format = bytes.readUInt16LE(2);

  if (format !== DB_FORMAT) console.warn(`database format is ${format}, this script expects ${DB_FORMAT}`);

  return String(bytes.readUInt32LE(4));
}

async function releases(kind) {
  const all = await json(`https://api.github.com/repos/${RELEASES[kind].repo}/releases?per_page=100`);
  const published = all.filter((release) => !release.draft && !release.prerelease);

  if (published.length !== all.length) console.log(`${RELEASES[kind].repo}: ${all.length - published.length} draft or prerelease skipped`);

  return published;
}

const versionOf = (tag) => tag.replace(/^v/, "");

const assetIn = (release, pattern) => (release.assets ?? []).filter((a) => pattern.test(a.name));

// keycard-shell-webapp stored timestamps as '%Y-%m-%d %H:%M' and the page scripts re-parse that shape.
const timestamp = (iso) => iso.slice(0, 16).replace("T", " ");

async function publishedChecksum(release, name) {
  const [file] = assetIn(release, /-sha256\.txt$/);

  if (file === undefined) return undefined;

  const lines = (await text(file.browser_download_url))
    .split("\n")
    .filter((line) => !line.startsWith("#") && line.trim() !== "")
    .map((line) => line.trim().split(/\s+/));

  return lines.find(([, entry]) => entry === name)?.[0];
}

// What a release has to offer to be mirrored: the image, and a published checksum that names it. Either can
// be missing simply because upstream uploads a release from more than one job.
async function readiness(kind, release) {
  const [asset] = assetIn(release, RELEASES[kind].match);

  if (asset === undefined) return { reason: "no image asset" };
  if (assetIn(release, /-sha256\.txt$/).length === 0) return { reason: "publishes no sha256 file" };

  const published = await publishedChecksum(release, RELEASES[kind].checksum(asset));

  return published === undefined ? { reason: `${asset.name} is not in the published sha256 file` } : { asset, published };
}

const sleep = (ms) => new Promise((wait) => setTimeout(wait, ms));

// A release that has started to publish files but is not complete yet is most likely still being uploaded.
const uploading = (release) => (release.assets ?? []).length > 0;

// A published checksum that disagrees with the artifact is tampering or corruption and stops the build; a
// missing file only means the release cannot be verified, so the previous complete one is used instead.
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

// Walks the releases newest first and mirrors the first that can be verified. Only the newest one is waited
// for, because anything older either finished or never will.
async function mirrorLatest(kind, published) {
  const repo = RELEASES[kind].repo;

  for (const [index, tagged] of published.entries()) {
    let release = tagged;
    let ready = await readiness(kind, release);

    for (let attempt = 1; "reason" in ready && index === 0 && uploading(release) && attempt <= UPLOAD_ATTEMPTS; attempt++) {
      console.warn(`${release.tag_name}: ${ready.reason}, waiting ${UPLOAD_DELAY_MS / 1000}s for the upload (${attempt}/${UPLOAD_ATTEMPTS})`);
      await sleep(UPLOAD_DELAY_MS);
      release = await json(`https://api.github.com/repos/${repo}/releases/tags/${tagged.tag_name}`);
      ready = await readiness(kind, release);
    }

    if ("reason" in ready) {
      console.warn(`${release.tag_name}: ${ready.reason}, not mirrored`);
      incomplete.push({ kind, tag: release.tag_name, reason: ready.reason });
      continue;
    }

    return { ...(await verifyAndWrite(kind, release, ready.asset, ready.published)), index, releaseObject: release };
  }

  return null;
}

const write = async (file, data) => {
  await mkdir(dirname(join(MEDIA, file)), { recursive: true });
  await writeFile(join(MEDIA, file), data);
};

const writeJson = (file, value) => write(file, `${JSON.stringify(value, null, 2)}\n`);

// What sync.json keeps about a mirrored artifact, without the bookkeeping mirrorLatest carries along.
const publishedFields = ({ index, releaseObject, ...fields }) => fields;

// The newest release is re-read while waiting for its upload, so its changelog comes from that reading.
const releasesFrom = (published, mirrored) =>
  published.slice(mirrored.index).map((release) => (release.tag_name === mirrored.tag ? mirrored.releaseObject : release));

async function syncFirmware() {
  const published = await releases("firmware");
  const current = await mirrorLatest("firmware", published);

  if (current === null) throw new Error(`no release of ${RELEASES.firmware.repo} offers a verifiable firmware image`);

  const notes = [];

  for (const release of releasesFrom(published, current)) {
    if (assetIn(release, RELEASES.firmware.match).length === 0) continue;

    const version = versionOf(release.tag_name);

    // release_notes.ts reads line 1 as the date and renders the rest as markdown; release bodies carry CRLF.
    notes.push({ version, changelog: `changelogs/${version}.md` });
    await write(`changelogs/${version}.md`, `${timestamp(release.published_at)}\n${(release.body ?? "").replace(/\r\n/g, "\n")}`);
  }

  return { current, notes };
}

async function syncDatabase() {
  const repo = RELEASES.database.repo;
  const published = await releases("database");
  const current = await mirrorLatest("database", published);

  if (current === null) throw new Error(`no release of ${repo} offers a verifiable database`);

  const history = [];

  for (const release of releasesFrom(published, current)) {
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

  return { current, history };
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

await rm(MEDIA, { recursive: true, force: true });

try {
  await mirror();
} catch (err) {
  // Only a build without credentials can run out of quota, and that limit says nothing about the releases.
  // What is already mirrored was verified when it was written, so a rate-limited sync leaves it in place
  // rather than refusing to build; a build that did authenticate must not tolerate it, or it would publish a
  // stale site out of a job that was supposed to fail.
  if (!rateLimited || token !== undefined || previous === null) throw err;

  console.warn(`out of quota, keeping what is mirrored: firmware ${previous.firmware.version}, database ${previous.database.version}, synced ${previous.synced_at}`);
  console.warn(`set GH_TOKEN to look for a newer release`);
  process.exit(0);
}

async function mirror() {
  const firmware = await syncFirmware();
  const database = await syncDatabase();

  // Written last, so a page can never point at an artifact that was not verified.
  await writeJson("get-firmware.json", { fw_path: RELEASES.firmware.file, version: firmware.current.version, hash: firmware.current.hash });
  await writeJson("get-db.json", { db_path: RELEASES.database.file, hash: database.current.hash, version: database.current.version });
  await writeJson("get-firmwares.json", firmware.notes);
  await writeJson("get-dbs.json", database.history);
  await writeJson("sync.json", {
    synced_at: new Date().toISOString(),
    firmware: publishedFields(firmware.current),
    database: publishedFields(database.current),
    incomplete,
  });

  // Renaming over the old mirror would leave a moment with no mirror at all, so the old one moves aside first.
  const stale = `${MIRROR}.old`;

  await rm(stale, { recursive: true, force: true });
  await rename(MIRROR, stale).catch(() => null);
  await rename(MEDIA, MIRROR);
  await rm(stale, { recursive: true, force: true });

  for (const kind of Object.keys(RELEASES)) {
    const current = kind === "firmware" ? firmware.current : database.current;
    const before = previous?.[kind]?.version;

    console.log(`${kind}: ${current.version}${before && before !== current.version ? ` (was ${before})` : ""} ${current.hash} ${current.asset}`);
  }

  for (const { kind, tag, reason } of incomplete) console.warn(`${kind}: ${tag} was not mirrored (${reason})`);
}
