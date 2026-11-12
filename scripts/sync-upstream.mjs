// Mirrors the latest Keycard firmware and database releases into the site as same-origin files.
//
// GitHub serves release assets without Access-Control-Allow-Origin, so a page on GitHub Pages cannot
// fetch() the bytes it is about to flash onto a device. This script downloads them at build time and
// writes the four JSON documents keycard-shell-webapp's Django views served, in the same shapes and
// under the same names, so the page scripts are unchanged apart from the prefix they fetch behind.
//
// media/ holds one current firmware.bin and db.bin, overwritten in place by each release, plus the
// changelog per firmware release, which is the only history a page needs. Everything older stays on
// the release it belongs to and is linked from there.
//
// Each artifact is checked against the checksum its release publishes and against the version written
// inside the binary, and the JSON is written last: an interrupted or wrong sync can never point a page
// at a missing or mismatched file.

import { createHash } from "node:crypto";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

// Properties of the Shell's flash and of the image the bootloader verifies, from
// keycard-shell/tools/common.py and stm32/Core/Inc/stm32.h.
const PAGE_SIZE = 8192;
const FW_PAGE_COUNT = 76;
const FW_IV_SIZE = 588;
const SIG_SIZE = 64;
// The linker script lays the header out as the signature over the image, then the four version bytes:
// major, minor, patch, and beta/variant flags.
const FW_VERSION_OFFSET = FW_IV_SIZE + SIG_SIZE;
// keycard-eth-db/tools/shell-db.py opens the database with struct.pack("<HHI", 0x4532, 4, version).
const DB_MAGIC = 0x4532;
const DB_FORMAT = 4;

// Release assets are named by hand, so each is matched rather than trusted. The firmware pattern
// excludes the bootloader, dev and experimental btc-only images sharing a release.
const RELEASES = {
  firmware: {
    repo: "keycard-tech/keycard-shell",
    match: /^shellos-\d{8}-(\d+\.\d+\.\d+)\.bin$/,
    // The release's sha256 file lists this asset by its uploaded name and hashes the flashed image.
    checksum: (asset) => asset.name,
    hash: flashImage,
    file: "firmware.bin",
    readVersion: firmwareVersion,
  },
  database: {
    repo: "keycard-tech/keycard-eth-db",
    match: /^shelldb-(\d{8})\.bin$/,
    // That repo's sha256 file lists the file as it was built (db.bin), not as it was uploaded.
    checksum: () => "db.bin",
    hash: (bytes) => sha256(bytes.subarray(0, bytes.length - SIG_SIZE)),
    file: "db.bin",
    readVersion: databaseVersion,
  },
};

// The version history page links the reproduction zip of every release, which the browser downloads
// rather than flashes, so it needs no same-origin copy.
const DATABASE_ZIP = /^db-(\d{8})-reproduction\.zip$/;

const args = process.argv.slice(2);
const arg = (name, fallback) => (args.includes(`--${name}`) ? args[args.indexOf(`--${name}`) + 1] : fallback);

const MEDIA = resolve(ROOT, arg("media", "pages/media"));
const DRY_RUN = args.includes("--dry-run");

const token = process.env.GH_TOKEN ?? process.env.GITHUB_TOKEN;

async function request(url, accept = "application/vnd.github+json") {
  const response = await fetch(url, {
    headers: {
      "User-Agent": "keycard-tech/shell-update-site",
      Accept: accept,
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
  });

  if (!response.ok) throw new Error(`${response.status} ${response.statusText} for ${url}`);
  return response;
}

const json = async (url) => request(url).then((r) => r.json());
const text = async (url) => request(url, "text/plain").then((r) => r.text());
const bytes = async (url) => request(url, "application/octet-stream").then((r) => r.arrayBuffer().then((b) => Buffer.from(b)));

const sha256 = (data) => createHash("sha256").update(data).digest("hex");

// Not the sha256sum of the file: keycard-shell/tools/firmware-hash.py pads the image to its flash size
// and skips the signature, which is what the bootloader verifies.
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

// Drafts and prereleases never reach a device; keycard-shell-webapp only served published firmware.
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
  const file = assetIn(release, /-sha256\.txt$/)[0];

  if (file === undefined) throw new Error(`${release.tag_name} publishes no sha256 file`);

  const lines = (await text(file.browser_download_url))
    .split("\n")
    .filter((line) => !line.startsWith("#") && line.trim() !== "")
    .map((line) => line.trim().split(/\s+/));

  return lines.find(([, entry]) => entry === name)?.[0];
}

// The version a device reports after an update is the one in the binary, so that is the version the
// site compares against; the tag is only where it is looked up.
async function mirrorLatest(kind, release) {
  const artifact = RELEASES[kind];
  const [asset] = assetIn(release, artifact.match);

  if (asset === undefined) return null;

  const data = await bytes(asset.browser_download_url);

  if (data.byteLength !== asset.size) throw new Error(`${asset.name}: got ${data.byteLength} of ${asset.size} bytes`);

  const hash = artifact.hash(data);
  const published = await publishedChecksum(release, artifact.checksum(asset));
  const version = artifact.readVersion(data);

  if (published === undefined) throw new Error(`${release.tag_name}: ${asset.name} is not in the published sha256 file`);
  if (published !== hash) throw new Error(`${asset.name}: ${hash} does not match the published ${published}`);
  if (version !== versionOf(release.tag_name)) throw new Error(`${asset.name}: carries version ${version}, its release is tagged ${release.tag_name}`);

  await write(artifact.file, data);

  return { version, tag: release.tag_name, release: release.html_url, asset: asset.name, size: asset.size, hash };
}

const write = async (file, data) => {
  await mkdir(dirname(join(MEDIA, file)), { recursive: true });
  await writeFile(join(MEDIA, file), data);
};

const writeJson = (file, value) => write(file, `${JSON.stringify(value, null, 2)}\n`);

async function syncFirmware() {
  const published = await releases("firmware");
  const notes = [];
  const carriers = [];

  for (const release of published) {
    const version = versionOf(release.tag_name);

    if (assetIn(release, RELEASES.firmware.match).length === 0) {
      console.warn(`${release.tag_name}: no asset matches ${RELEASES.firmware.match}, skipped`);
      continue;
    }

    carriers.push(release);

    // release_notes.ts reads the changelog's first line as the release date and renders the rest as
    // markdown, which is the shape keycard-shell-webapp kept on disk. Release bodies carry CRLF.
    notes.push({ version, changelog: `changelogs/${version}.md` });
    await write(`changelogs/${version}.md`, `${timestamp(release.published_at)}\n${(release.body ?? "").replace(/\r\n/g, "\n")}`);
  }

  if (carriers.length === 0) throw new Error(`no release of ${RELEASES.firmware.repo} carries a firmware image`);

  return { current: await mirrorLatest("firmware", carriers[0]), notes };
}

async function syncDatabase() {
  const repo = RELEASES.database.repo;
  const published = await releases("database");
  const history = [];
  const carriers = [];

  for (const release of published) {
    const version = versionOf(release.tag_name);
    const [zip] = assetIn(release, DATABASE_ZIP);

    if (zip === undefined || assetIn(release, RELEASES.database.match).length === 0) {
      console.warn(`${release.tag_name}: no database image or reproduction zip, skipped`);
      continue;
    }

    // The version history page names the three source lists of every release, which eth-db commits
    // beside the sources it fetched.
    const manifest = await text(`https://raw.githubusercontent.com/${repo}/${release.tag_name}/manifest.txt`).catch((err) => {
      console.warn(`${release.tag_name}: ${err.message}, skipped`);
      return null;
    });

    if (manifest === null) continue;

    const source = (label) => manifest.match(new RegExp(`^${label}:\\s*(\\S+)`, "m"))?.[1];
    const links = { token_link: source("ERC20 token list source"), chain_link: source("Chain list source"), abi_link: source("ABI list source") };

    if (Object.values(links).some((link) => link === undefined)) {
      console.warn(`${release.tag_name}: manifest.txt does not name all three sources, skipped`);
      continue;
    }

    history.push({ zip_path: zip.browser_download_url, version, creation_date: timestamp(release.published_at), ...links });
    carriers.push(release);
  }

  if (carriers.length === 0) throw new Error(`no release of ${repo} carries a database`);

  return { current: await mirrorLatest("database", carriers[0]), history };
}

const previous = await readFile(join(MEDIA, "sync.json"), "utf8").then(JSON.parse).catch(() => null);

if (DRY_RUN) {
  for (const kind of Object.keys(RELEASES)) {
    const version = versionOf((await releases(kind))[0].tag_name);
    const mirrored = previous?.[kind]?.version ?? "nothing";

    console.log(`${kind}: upstream ${version}, mirrored ${mirrored}${mirrored === version ? " (up to date)" : " (out of date)"}`);
  }

  process.exit(0);
}

await rm(MEDIA, { recursive: true, force: true });

const firmware = await syncFirmware();
const database = await syncDatabase();

await writeJson("get-firmware.json", { fw_path: RELEASES.firmware.file, version: firmware.current.version, hash: firmware.current.hash });
await writeJson("get-db.json", { db_path: RELEASES.database.file, hash: database.current.hash, version: database.current.version });
await writeJson("get-firmwares.json", firmware.notes);
await writeJson("get-dbs.json", database.history);
await writeJson("sync.json", { synced_at: new Date().toISOString(), firmware: firmware.current, database: database.current });

for (const kind of Object.keys(RELEASES)) {
  const current = kind === "firmware" ? firmware.current : database.current;
  const before = previous?.[kind]?.version;

  console.log(`${kind}: ${current.version}${before && before !== current.version ? ` (was ${before})` : ""} ${current.hash} ${current.asset}`);
}
