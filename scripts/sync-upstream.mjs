// GitHub serves release assets without CORS headers, so the bytes a page flashes are mirrored at build time

import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { DB_FORMAT, DB_MAGIC, databaseFormat, databaseMagic, databaseVersion, firmwareVersion, flashImage, readUnits, sha256, unitsHeader } from "./binfmt.mjs";
import { SIG_SIZE } from "../src/js/shvr/format.ts";
import { ARTIFACTS, UNITS_VERIFY_KEY } from "./site.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

// What a Shell is flashed with, and the name its release gives it in *-sha256.txt; anchored, so bootloader and experimental images are never taken for one
const FIRMWARE_VARIANTS = [
  {
    id: "multicoin",
    label: "omni",
    // The code the device reports as fwVariant, which is not the image header's flags byte (32 on the btc build)
    device: 0,
    file: ARTIFACTS.firmware,
    match: /^shellos-\d{8}-(\d+\.\d+\.\d+)\.bin$/,
    checksumOf: (name) => name,
    required: true,
  },
  {
    id: "btc",
    label: "btc",
    device: 1,
    file: ARTIFACTS.firmwareBtc,
    match: /^shellos-\d{8}-(\d+\.\d+\.\d+)-btc-only\.bin$/,
    checksumOf: (name) => name.replace(/^shellos-/, "shellos-btc-").replace(/-btc-only\.bin$/, ".bin"),
    required: false,
  },
];

const RELEASES = {
  firmware: {
    repo: "keycard-tech/keycard-shell",
    variants: FIRMWARE_VARIANTS,
    flashHash: flashImage,
    readVersion: firmwareVersion,
  },
  database: {
    repo: "keycard-tech/keycard-eth-db",
    variants: [
      {
        id: "database",
        file: ARTIFACTS.database,
        match: /^shelldb-(\d{8})\.bin$/,
        // Its sha256 file lists the file as built (db.bin), not as uploaded (shelldb-<date>.bin)
        checksumOf: () => "db.bin",
        required: true,
      },
    ],
    flashHash: (file) => sha256(file.subarray(0, file.length - SIG_SIZE)),
    readVersion: releaseDatabase,
  },
  // The device allowlist: certified by the signature inside the file rather than by a sha256 file in the release, and its tag is the build date the header carries — confirmed against 20261112, the first release, which uploads shell-verification-db.bin and nothing else
  units: {
    repo: "keycard-tech/shell-units",
    signed: true,
    // shell-units may have published nothing at all, which is not a failure; see syncUnits
    allowAbsence: true,
    variants: [
      {
        id: "allowlist",
        file: ARTIFACTS.units,
        match: /^shell-verification-db\.bin$/,
        checksumOf: (name) => name,
        required: true,
      },
    ],
    // The digest the signature covers: everything before the trailing 64 bytes, as in eth-db
    flashHash: (file) => sha256(file.subarray(0, file.length - SIG_SIZE)),
    // Throws with the reason shell-units' own reader would refuse the file for
    readVersion: (file) => readUnits(file, UNITS_VERIFY_KEY).version,
    // For the log and sync.json only: row_count is padded to a power of two and is not a device count
    describe: (file) => {
      const { rowCount, salt } = unitsHeader(file);

      return { rows: rowCount, salt };
    },
  },
};

const DATABASE_ZIP = /^db-(\d{8})-reproduction\.zip$/;

// Upstream uploads a release from more than one job, so the file certifying an image can turn up minutes later
const UPLOAD_ATTEMPTS = Number(process.env.SYNC_UPLOAD_ATTEMPTS ?? 5);
const UPLOAD_DELAY_MS = Number(process.env.SYNC_UPLOAD_DELAY_SECONDS ?? 60) * 1000;

const args = process.argv.slice(2);
const arg = (name, fallback) => (args.includes(`--${name}`) ? args[args.indexOf(`--${name}`) + 1] : fallback);

// The new mirror is assembled in STAGING and swapped into MIRROR only once it verifies, so a failed run keeps the old one
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

function releaseDatabase(file) {
  const magic = databaseMagic(file);

  if (magic !== DB_MAGIC) throw new Error(`file starts with magic ${magic.toString(16)}, not the Shell database magic 0x4532`);

  const format = databaseFormat(file);

  if (format !== DB_FORMAT) console.warn(`database format is ${format}, this script expects ${DB_FORMAT}`);

  return databaseVersion(file);
}

const versionOf = (tag) => tag.replace(/^v/, "");
const assetIn = (release, pattern) => (release.assets ?? []).filter((asset) => pattern.test(asset.name));

// keycard-shell-webapp stored timestamps as '%Y-%m-%d %H:%M' and the page scripts re-parse that shape
const timestamp = (iso) => iso.slice(0, 16).replace("T", " ");

async function releases(kind) {
  const all = await json(`https://api.github.com/repos/${RELEASES[kind].repo}/releases?per_page=100`);
  const published = all.filter((release) => !release.draft && !release.prerelease);

  if (published.length !== all.length) console.log(`${RELEASES[kind].repo}: ${all.length - published.length} draft or prerelease skipped`);

  return published;
}

const releaseByTag = (kind, tag) => json(`https://api.github.com/repos/${RELEASES[kind].repo}/releases/tags/${tag}`);

// The lines of the release's *-sha256.txt, as a map from the name it uses to the hash it publishes
async function publishedChecksums(release) {
  const [file] = assetIn(release, /-sha256\.txt$/);

  if (file === undefined) return undefined;

  const lines = (await text(file.browser_download_url))
    .split("\n")
    .filter((line) => !line.startsWith("#") && line.trim() !== "")
    .map((line) => line.trim().split(/\s+/));

  return new Map(lines.map(([hash, name]) => [name, hash]));
}

// A variant absent from the release is simply absent; one uploaded but unnamed by the checksum file means the upload is unfinished
async function readiness(kind, release) {
  const published = await publishedChecksums(release);
  const signed = RELEASES[kind].signed === true;

  if (published === undefined && !signed) return { ok: false, reason: "publishes no sha256 file" };

  const images = [];
  const missing = [];

  for (const variant of RELEASES[kind].variants) {
    const [asset] = assetIn(release, variant.match);

    if (asset === undefined) {
      if (variant.required) return { ok: false, reason: `no ${variant.id} image asset` };

      continue;
    }

    const hash = published?.get(variant.checksumOf(asset.name));

    if (hash === undefined) {
      // Nothing to cross-check the download against, so verifyAndWrite's signature check is the certification
      if (signed) {
        images.push({ variant, asset, published: undefined });
        continue;
      }

      if (variant.required) return { ok: false, reason: `${asset.name} is not in the published sha256 file` };

      missing.push(`${asset.name} is not in the published sha256 file`);
      continue;
    }

    images.push({ variant, asset, published: hash });
  }

  return { ok: true, images, missing };
}

// A release that has some files but not the ones needed is most likely still being uploaded
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

const write = async (file, data) => {
  await mkdir(dirname(join(STAGING, file)), { recursive: true });
  await writeFile(join(STAGING, file), data);
};

const writeJson = (file, value) => write(file, `${JSON.stringify(value, null, 2)}\n`);

// A checksum that disagrees is corruption, not something to mirror around
async function verifyAndWrite(kind, release, { variant, asset, published }) {
  const data = await bytes(asset.browser_download_url);

  if (data.byteLength !== asset.size) throw new Error(`${asset.name}: got ${data.byteLength} of ${asset.size} bytes`);

  const flashHash = RELEASES[kind].flashHash(data);

  let version;

  try {
    version = RELEASES[kind].readVersion(data);
  } catch (err) {
    // The reader says what it refused, and which asset it refused has to travel with the message
    throw new Error(`${asset.name}: ${err.message}`);
  }

  if (published !== undefined && published !== flashHash) throw new Error(`${asset.name}: ${flashHash} does not match the published ${published}`);
  if (version !== versionOf(release.tag_name)) throw new Error(`${asset.name}: carries version ${version}, its release is tagged ${release.tag_name}`);

  await write(variant.file, data);

  return {
    id: variant.id,
    label: variant.label,
    device: variant.device,
    file: variant.file,
    asset: asset.name,
    size: asset.size,
    hash: sha256(data),
    flash_hash: flashHash,
    ...(RELEASES[kind].describe?.(data) ?? {}),
  };
}

// What a release offers to be flashed; a release without any, bootloader-only for instance, has nothing to announce
const imagesIn = (kind, release) => RELEASES[kind].variants.flatMap((variant) => assetIn(release, variant.match));

// Newest first: mirror the first release that verifies, report the ones passed over, wait only on the newest
async function mirrorLatest(kind, published) {
  const skipped = [];

  if (published.length === 0 && RELEASES[kind].allowAbsence === true) {
    return { current: null, history: [], skipped: [], note: `${RELEASES[kind].repo} has published no release yet` };
  }

  for (const [index, tagged] of published.entries()) {
    const { release, ready } = await awaitUpload(kind, tagged, index === 0 ? UPLOAD_ATTEMPTS : 0);

    if (!ready.ok) {
      console.warn(`${release.tag_name}: ${ready.reason}, not mirrored`);
      skipped.push({ kind, tag: release.tag_name, reason: ready.reason });
      continue;
    }

    for (const reason of ready.missing) {
      console.warn(`${release.tag_name}: ${reason}, that image is not offered`);
      skipped.push({ kind, tag: release.tag_name, reason });
    }

    const variants = [];

    for (const image of ready.images) variants.push(await verifyAndWrite(kind, release, image));

    return { current: { version: versionOf(release.tag_name), tag: release.tag_name, release: release.html_url, variants }, index, release, skipped };
  }

  return { current: null, skipped };
}

// The history starts at the mirrored release, whose freshest reading is the one that was verified
const releasesBelow = (published, mirrored) =>
  published.slice(mirrored.index).map((release) => (release.tag_name === mirrored.release.tag_name ? mirrored.release : release));

async function syncFirmware() {
  const published = await releases("firmware");
  const mirrored = await mirrorLatest("firmware", published);

  if (mirrored.current === null) throw new Error(`no release of ${RELEASES.firmware.repo} offers a verifiable firmware image`);

  const notes = [];

  for (const release of releasesBelow(published, mirrored)) {
    if (imagesIn("firmware", release).length === 0) continue;

    const version = versionOf(release.tag_name);

    // release_notes.ts reads line 1 as the date and renders the rest as markdown; release bodies carry CRLF
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

    // The history page links this zip, so a release without one has nothing to show
    if (zip === undefined) {
      console.warn(`${release.tag_name}: no reproduction zip, left out of the history`);
      continue;
    }

    // eth-db commits manifest.txt at the tag, naming the three sources it fetched
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

// Absence stays legal (nothing published, nothing ready) but an uncertifiable release fails the run, because a page reads get-units.json
async function syncUnits(previous) {
  const mirrored = await mirrorLatest("units", await releases("units"));

  if (mirrored.current !== null) {
    await writeJson("get-units.json", { version: mirrored.current.version, variants: mirrored.current.variants.map(publicVariant) });

    return mirrored;
  }

  // Whatever is mirrored now — signed, certified when taken — is carried into the new mirror
  const carried = ["get-units.json", ARTIFACTS.units].map((file) =>
    readFile(join(MIRROR, file))
      .then((data) => write(file, data))
      .catch(() => null),
  );

  if ((await Promise.all(carried)).some((data) => data === null)) return mirrored;

  const document = JSON.parse(await readFile(join(MIRROR, "get-units.json"), "utf8"));
  const reason = mirrored.note ?? `${RELEASES.units.repo} published nothing ready to mirror`;

  return {
    ...mirrored,
    current: previous?.units ?? { version: document.version, variants: document.variants },
    skipped: [...mirrored.skipped, { kind: "units", tag: document.version, reason }],
    kept: reason,
  };
}

async function rebuild(previous) {
  const firmware = await syncFirmware();
  const database = await syncDatabase();
  const units = await syncUnits(previous);
  const db = database.current.variants[0];

  // The documents name the artifacts, so they are written once every image is downloaded and verified
  await writeJson("get-firmware.json", { version: firmware.current.version, variants: firmware.current.variants.map(publicVariant) });
  await writeJson("get-db.json", { db_path: db.file, hash: db.hash, version: database.current.version });
  await writeJson("get-firmwares.json", firmware.notes);
  await writeJson("get-dbs.json", database.history);
  await writeJson("sync.json", {
    synced_at: new Date().toISOString(),
    firmware: firmware.current,
    database: database.current,
    units: units.current,
    incomplete: [...firmware.skipped, ...database.skipped, ...units.skipped],
  });

  // The old mirror moves aside rather than being deleted first, so there is never a moment with no mirror
  const stale = `${MIRROR}.old`;

  await rm(stale, { recursive: true, force: true });
  await rename(MIRROR, stale).catch(() => null);
  await rename(STAGING, MIRROR);
  await rm(stale, { recursive: true, force: true });

  for (const [kind, { current }] of [["firmware", firmware], ["database", database]]) {
    const before = previous?.[kind]?.version;

    console.log(`${kind}: ${current.version}${before && before !== current.version ? ` (was ${before})` : ""} ${current.variants.map((image) => `${image.file} ${image.hash}`).join(" ")}`);
  }

  for (const { kind, tag, reason } of [...firmware.skipped, ...database.skipped, ...units.skipped]) {
    console.warn(`${kind}: ${tag} was not mirrored (${reason})`);
  }

  const { current, kept, note } = units;

  if (current === null) {
    console.log(`units: ${note ?? "nothing mirrored"}`);
  } else {
    const [{ file, hash, rows, salt }] = current.variants;
    const detail = rows === undefined ? "" : ` (rows ${rows}, salt ${String(salt).slice(0, 8)}…)`;

    console.log(`units: ${current.version} ${file} ${hash}${detail}${kept ? `, kept: ${kept}` : ""}`);
  }
}

// What a page needs about one mirrored image: where it is, what it hashes to, and the fwVariant code of the device that runs it
const publicVariant = ({ id, label, device, file, hash }) => ({ id, label, device, path: file, hash });

const previous = await readFile(join(MIRROR, "sync.json"), "utf8").then(JSON.parse).catch(() => null);

if (DRY_RUN) {
  for (const kind of Object.keys(RELEASES)) {
    const mirrored = previous?.[kind]?.version ?? "nothing";

    try {
      const [latest] = await releases(kind);

      console.log(
        latest === undefined
          ? `${kind}: ${RELEASES[kind].repo} has published no release`
          : `${kind}: upstream ${versionOf(latest.tag_name)}, mirrored ${mirrored}${versionOf(latest.tag_name) === mirrored ? " (up to date)" : " (out of date)"}`,
      );
    } catch (err) {
      // Not being allowed to ask is not the same as nothing being published
      console.log(`${kind}: ${err.message}, mirrored ${mirrored}`);
    }
  }

  process.exit(0);
}

await rm(STAGING, { recursive: true, force: true });

try {
  await rebuild(previous);
} catch (err) {
  // Quota exhaustion is no verdict on the releases: keep the verified mirror, but never tolerate it when a token was sent
  if (!rateLimited || token !== undefined || previous === null) throw err;

  console.warn(
    `out of quota, keeping what is mirrored: firmware ${previous.firmware.version}, database ${previous.database.version}, units ${previous.units?.version ?? "none"}, synced ${previous.synced_at}`,
  );
  console.warn(`set GH_TOKEN to look for a newer release`);
  process.exit(0);
}
