// npm start: parcel watch plus the Pages server, because parcel serve answers unbuilt paths such as media/ with index.html

import { spawn } from "node:child_process";
import { rm, symlink } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { PAGES, prefix } from "./site.mjs";
import { listen } from "./serve-site.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const DIST = join(ROOT, ".parcel-dev");
const BASE = process.env.SITE_BASE ?? "/";
const PORT = Number(process.env.PORT ?? 1234);
// `parcel watch` starts a server of its own whatever it is told, and that one has no /media: keep it off PORT
const PARCEL_PORT = PORT + 1;

// The mirror is linked, not copied: a sync that runs later is visible without rebuilding anything
const linkMedia = async () => {
  const target = join(DIST, "media");

  await rm(target, { recursive: true, force: true });
  await symlink(join("..", "pages", "media"), target).catch((err) => console.warn(`media link failed (${err.code}): run node scripts/install-media.mjs pages/media ${DIST}`));
};

const parcel = spawn(
  "npx",
  ["parcel", "watch", "--no-hmr", "--port", String(PARCEL_PORT), "--dist-dir", DIST, "--cache-dir", join(DIST, "cache"), "--public-url", BASE, ...PAGES.map((page) => join("pages", page.path))],
  { cwd: ROOT, stdio: ["ignore", "pipe", "inherit"], env: process.env }
);

parcel.stdout.on("data", (chunk) => {
  const text = chunk.toString();

  process.stdout.write(text);
  if (text.includes("Built in")) linkMedia();
});

parcel.on("exit", (code, signal) => {
  if (code !== 0 && code !== null) console.error(`parcel exited with ${code ?? signal}`);
  process.exit(code ?? 1);
});

await linkMedia();

const site = await listen({ dir: DIST, base: BASE, port: PORT }).catch((err) => {
  if (err.code !== "EADDRINUSE") throw err;

  console.error(`port ${PORT} is taken; start with PORT=1240 npm start`);
  parcel.kill();
  process.exit(1);
});

console.log(`dev site at ${site.origin}${prefix(BASE)} — rebuilds on change, Ctrl-C to stop`);
console.log(`not http://localhost:${PARCEL_PORT}: that is parcel watch's own server, and it has no media/`);

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => {
    parcel.kill(signal);
    site.close().then(() => process.exit(0));
  });
}
