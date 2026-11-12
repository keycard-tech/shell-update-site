// Copies the mirror into dist/, whole or not at all: a missing file there is a 404, and Pages answers 404s with HTML.

import { cp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { ARTIFACTS, DOCUMENTS, UPDATES } from "./site.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const MIRROR = resolve(ROOT, process.argv[2] ?? "pages/media");
const DIST = resolve(ROOT, process.argv[3] ?? "dist");

const missing = async (files, dir) => {
  const absent = [];

  for (const file of files) await stat(join(dir, file)).catch(() => absent.push(file));

  return absent;
};

const incomplete = await missing([...Object.values(ARTIFACTS), ...DOCUMENTS], MIRROR);

if (incomplete.length > 0) {
  console.error(`${MIRROR} is missing ${incomplete.join(", ")}: run npm run sync to completion. Nothing was copied.`);
  process.exit(1);
}

if ((await missing(["index.html"], DIST)).length > 0) {
  console.error(`${DIST} holds no built pages: run npm run build first. Nothing was copied.`);
  process.exit(1);
}

// A document pointing anywhere else would send the page to the same 404.
for (const { document, key, artifact } of UPDATES) {
  const named = JSON.parse(await readFile(join(MIRROR, document), "utf8"))[key];

  if (named !== artifact) throw new Error(`${document} points at ${named}, expected ${artifact}`);
}

const mirrored = join(DIST, "media");

await rm(mirrored, { recursive: true, force: true });
await cp(MIRROR, mirrored, { recursive: true });
await cp(resolve(ROOT, "CNAME"), join(DIST, "CNAME"));
await writeFile(join(DIST, ".nojekyll"), "");

const size = async (file) => (await stat(join(mirrored, file))).size;

console.log(`dist/media: ${await size(ARTIFACTS.firmware)} bytes of firmware, ${await size(ARTIFACTS.database)} of database, ${DOCUMENTS.length} documents, CNAME, .nojekyll`);
