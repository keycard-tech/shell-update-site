// The last build step: the mirror goes into dist/ next to the pages, and only if it is whole.
// A missing file there is a 404, and GitHub Pages answers a 404 with an HTML page, which the update pages
// then hand to JSON.parse.

import { cp, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { ARTIFACTS, DOCUMENTS } from "./site.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const MIRROR = resolve(ROOT, process.argv[2] ?? "pages/media");
const DIST = resolve(ROOT, process.argv[3] ?? "dist");

const absent = [];

for (const file of [...Object.values(ARTIFACTS), ...DOCUMENTS]) {
  await readFile(join(MIRROR, file)).catch(() => absent.push(file));
}

await readFile(join(DIST, "index.html")).catch(() => absent.push(`${DIST}/index.html (build the pages first)`));

if (absent.length > 0) {
  console.error(`refusing to publish, ${MIRROR} has no ${absent.join(", ")}. Run npm run sync to completion.`);
  process.exit(1);
}

// A document naming an artifact the mirror does not hold sends the page to the same 404.
for (const [name, key] of [["get-firmware.json", "fw_path"], ["get-db.json", "db_path"]]) {
  const named = JSON.parse(await readFile(join(MIRROR, name), "utf8"))[key];

  await readFile(join(MIRROR, named)).catch(() => {
    throw new Error(`${name} points at ${named}, which ${MIRROR} does not contain`);
  });
}

const mirrored = join(DIST, "media");

await rm(mirrored, { recursive: true, force: true });
await cp(MIRROR, mirrored, { recursive: true });
await cp(resolve(ROOT, "CNAME"), join(DIST, "CNAME"));
await writeFile(join(DIST, ".nojekyll"), "");

const size = async (file) => (await readFile(join(mirrored, file))).byteLength;

console.log(`dist/media: ${await size(ARTIFACTS.firmware)} bytes of firmware, ${await size(ARTIFACTS.database)} of database, ${DOCUMENTS.length} documents, CNAME, .nojekyll`);
