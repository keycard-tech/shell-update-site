// Serves dist/ the way GitHub Pages does and walks every page, link, asset and artifact it references.
// A page is only correct if the URL a visitor follows is the one that renders it.

import { createHash } from "node:crypto";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { PAGES, URLS, at, linkOf, prefix } from "./site.mjs";
import { listen } from "./serve-site.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const DIST = resolve(ROOT, process.argv.includes("--dist") ? process.argv[process.argv.indexOf("--dist") + 1] : "dist");
const BASE = prefix(process.env.SITE_BASE ?? "/");

const { origin, close } = await listen({ dir: DIST, base: BASE });

const failures = [];
const fail = (page, what) => failures.push(`${page}: ${what}`);

const get = async (url) => {
  const response = await fetch(url, { redirect: "manual" });

  if (response.status === 301 || response.status === 302) {
    const target = new URL(response.headers.get("location"), url).href;
    const landed = await fetch(target, { redirect: "manual" });

    return { status: landed.status, url: target, body: () => landed.arrayBuffer() };
  }

  return { status: response.status, url, body: () => response.arrayBuffer() };
};

const refsIn = (html) =>
  [...html.matchAll(/(?:href|src)=("|')(.*?)\1|(?:href|src)=([^\s"'>]+)/g)]
    .map(([, , quoted, bare]) => quoted ?? bare)
    .filter((ref) => ref !== undefined && !/^(https?:|mailto:|javascript:|#|data:)/.test(ref) && ref !== "");

const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");

// The same reads the sync makes: keycard-shell/tools/firmware-hash.py and keycard-eth-db/tools/shell-db.py.
const firmwareVersion = (bytes) => [...bytes.subarray(652, 655)].join(".");
const databaseVersion = (bytes) => (bytes.readUInt16LE(0) === 0x4532 ? String(bytes.readUInt32LE(4)) : "bad magic");

const media = new Map();

for (const page of PAGES) {
  const link = linkOf(page);
  const landed = await get(origin + link);
  const html = Buffer.from(await landed.body()).toString();

  if (landed.status !== 200) fail(link, `${landed.status} at ${link}`);
  else if (!landed.url.endsWith(link)) fail(link, `served from ${landed.url}`);

  const refs = [...new Set(refsIn(html))];
  const checked = await Promise.all(refs.map(async (ref) => ({ ref, ...await get(new URL(ref, landed.url).href) })));
  const broken = checked.filter((entry) => entry.status !== 200);

  for (const entry of broken) fail(link, `${entry.status} ${entry.ref}`);

  const value = html.match(/id=("|')[\w-]*media-prefix\1[^>]*?value=("|')(.*?)\2|id=[\w-]*media-prefix[^>]*?value=([^\s>]+)/);
  const mediaPrefix = value?.[3] ?? value?.[4];

  if (mediaPrefix !== undefined) {
    for (const name of ["get-firmware.json", "get-db.json"]) {
      const document = await get(new URL(mediaPrefix + name, landed.url).href);

      if (document.status !== 200) fail(link, `${document.status} ${mediaPrefix + name}`);
      // fw_path and db_path are relative to the JSON, not to the page that fetched it.
      else media.set(name, { at: document.url, ...JSON.parse(Buffer.from(await document.body()).toString()) });
    }
  }

  console.log(`${link} ${refs.length} refs, ${broken.length} broken${mediaPrefix ? `, media ${mediaPrefix}` : ""}`);
}

for (const [name, path] of Object.entries(URLS)) {
  const landed = await get(origin + at(path));

  if (landed.status !== 200) fail(`url:${name}`, `${landed.status} at ${at(path)}`);
  else console.log(`url ${name} -> ${landed.url.slice(origin.length)}`);
}

for (const [name, key] of [["get-firmware.json", "fw_path"], ["get-db.json", "db_path"]]) {
  const document = media.get(name);

  if (document === undefined) fail(name, "never fetched by any page");
  else {
    const artifact = await get(new URL(document[key], document.at).href);
    const bytes = Buffer.from(await artifact.body());
    const inside = name === "get-firmware.json" ? firmwareVersion(bytes) : databaseVersion(bytes);

    console.log(`${name}: ${document.version} ${sha256(bytes).slice(0, 16)}… ${bytes.length} bytes, in-bin ${inside}`);

    if (artifact.status !== 200) fail(name, `${artifact.status} for ${document[key]}`);
    if (String(document.version) !== inside) fail(name, `version ${document.version} is not the version in ${document[key]}`);
  }
}

await close();

if (failures.length > 0) {
  for (const failure of failures) console.error(`BROKEN ${failure}`);
  process.exit(1);
}

console.log(`${PAGES.length} pages, ${Object.keys(URLS).length} urls, no broken ref`);
