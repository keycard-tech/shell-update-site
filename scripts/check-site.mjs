// Walks a built site through the Pages server: a page is only correct if the URL a visitor follows renders it.

import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { DB_MAGIC, databaseMagic, databaseVersion, firmwareVersion, sha256 } from "./binfmt.mjs";
import { PAGES, URLS, PAGE_DOCUMENTS, artifactsOf, at, linkOf, prefix } from "./site.mjs";
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

// Reported rather than thrown, so one bad artifact does not hide the state of the rest of the site.
const versionInside = (kind, bytes) => {
  if (kind === "firmware") return firmwareVersion(bytes);
  if (databaseMagic(bytes) !== DB_MAGIC) return "bad magic";

  return databaseVersion(bytes);
};

const documents = new Map();

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
    for (const { document } of PAGE_DOCUMENTS) {
      const fetched = await get(new URL(mediaPrefix + document, landed.url).href);

      if (fetched.status !== 200) fail(link, `${fetched.status} ${mediaPrefix + document}`);
      // the artifacts a document names are relative to the document, not to the page that fetched it
      else documents.set(document, { at: fetched.url, ...JSON.parse(Buffer.from(await fetched.body()).toString()) });
    }
  }

  console.log(`${link} ${refs.length} refs, ${broken.length} broken${mediaPrefix ? `, media ${mediaPrefix}` : ""}`);
}

for (const [name, path] of Object.entries(URLS)) {
  const landed = await get(origin + at(path));

  if (landed.status !== 200) fail(`url:${name}`, `${landed.status} at ${at(path)}`);
  else console.log(`url ${name} -> ${landed.url.slice(origin.length)}`);
}

// Every artifact a document names has to be served, carry the version the document claims, and hash to what it publishes.
for (const { kind, document } of PAGE_DOCUMENTS) {
  const read = documents.get(document);

  if (read === undefined) fail(document, "never fetched by any page");
  else {
    for (const { path, hash } of artifactsOf(read)) {
      const artifact = await get(new URL(path, read.at).href);
      const bytes = Buffer.from(await artifact.body());
      const served = sha256(bytes);
      const inside = versionInside(kind, bytes);

      console.log(`${document} ${path}: ${read.version} ${served.slice(0, 16)}… ${bytes.length} bytes, in-bin ${inside}`);

      if (artifact.status !== 200) fail(document, `${artifact.status} for ${path}`);
      if (String(read.version) !== inside) fail(document, `version ${read.version} is not the version in ${path}`);
      if (hash !== undefined && hash !== served) fail(document, `${path} is ${served}, the document says ${hash}`);
    }
  }
}

await close();

if (failures.length > 0) {
  for (const failure of failures) console.error(`BROKEN ${failure}`);
  process.exit(1);
}

console.log(`${PAGES.length} pages, ${Object.keys(URLS).length} urls, no broken ref`);
