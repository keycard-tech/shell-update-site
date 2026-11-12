// Copies the mirror into dist/, whole or not at all: a missing file there is a 404, and Pages answers 404s with HTML.

import { cp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { ARTIFACTS, DOCUMENTS, PAGE_DOCUMENTS, artifactsOf } from "./site.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const MIRROR = resolve(ROOT, process.argv[2] ?? "pages/media");
const DIST = resolve(ROOT, process.argv[3] ?? "dist");

const missing = async (files, dir) => {
  const absent = [];

  for (const file of files) await stat(join(dir, file)).catch(() => absent.push(file));

  return absent;
};

const incomplete = await missing(DOCUMENTS, MIRROR);

if (incomplete.length > 0) {
  console.error(`${MIRROR} is missing ${incomplete.join(", ")}: run npm run sync to completion. Nothing was copied.`);
  process.exit(1);
}

if ((await missing(["index.html"], DIST)).length > 0) {
  console.error(`${DIST} holds no built pages: run npm run build first. Nothing was copied.`);
  process.exit(1);
}

// Every artifact a document names has to be there, and inside media/: anywhere else is the same 404.
const artifacts = [];

for (const { document } of PAGE_DOCUMENTS) {
  for (const { path } of artifactsOf(JSON.parse(await readFile(join(MIRROR, document), "utf8")))) {
    if (!Object.values(ARTIFACTS).includes(path)) throw new Error(`${document} names ${path}, which is not a mirrored artifact`);

    if ((await missing([path], MIRROR)).length > 0) throw new Error(`${document} names ${path}, which ${MIRROR} does not contain`);

    artifacts.push(path);
  }
}

const mirrored = join(DIST, "media");

await rm(mirrored, { recursive: true, force: true });
await cp(MIRROR, mirrored, { recursive: true });
await cp(resolve(ROOT, "CNAME"), join(DIST, "CNAME"));
await writeFile(join(DIST, ".nojekyll"), "");

const size = async (file) => (await stat(join(mirrored, file))).size;

const [sizes, documents] = await Promise.all([
  Promise.all(artifacts.map(async (path) => `${path} ${await size(path)}B`)),
  readdir(mirrored).then((files) => files.filter((name) => name.endsWith(".json")).length),
]);

console.log(`dist/media: ${sizes.join(" ")}, ${documents} documents, CNAME, .nojekyll`);
