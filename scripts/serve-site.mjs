// Serves a directory the way GitHub Pages serves a site: index.html inside a path, and a 301 from a
// directory to its trailing-slash form. `npm start` is no substitute for this: the Parcel dev server answers
// a path it does not know with index.html and status 200, so the documents and artifacts that the update
// pages fetch at runtime come back as HTML, and JSON.parse reports `Unexpected token '<'`.

import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { dirname, extname, join, normalize, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { prefix } from "./site.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

const TYPES = {
  ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".json": "application/json",
  ".svg": "image/svg+xml", ".png": "image/png", ".webp": "image/webp", ".ico": "image/x-icon",
  ".txt": "text/plain", ".woff2": "font/woff2", ".map": "application/json",
};

export const pagesServer = ({ dir, base = "/" }) => {
  const root = prefix(base);

  return createServer(async (req, res) => {
    const path = decodeURIComponent(req.url.split("?")[0]);

    if (!path.startsWith(root)) return res.writeHead(404).end("outside the site base");

    const local = path.slice(root.length - 1);
    const file = normalize(join(dir, local));

    if (!file.startsWith(dir)) return res.writeHead(403).end();

    const body = await readFile(file).then((data) => ({ data })).catch(async () =>
      readFile(join(file, "index.html")).then((data) => ({ data, dir: true })).catch(() => null)
    );

    if (body === null) return res.writeHead(404).end("not found");

    if (body.dir && !path.endsWith("/")) return res.writeHead(301, { Location: `${path}/` }).end();

    const type = TYPES[extname(body.dir ? join(file, "index.html") : file)] ?? "application/octet-stream";

    res.writeHead(200, { "Content-Type": type }).end(body.data);
  });
};

export const listen = async ({ dir, base = "/", port = 0 }) => {
  const server = pagesServer({ dir, base });

  await new Promise((done) => server.listen(port, "127.0.0.1", done));

  return { origin: `http://127.0.0.1:${server.address().port}`, close: () => new Promise((done) => server.close(done)) };
};

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const base = process.env.SITE_BASE ?? "/";
  const dir = resolve(ROOT, process.argv[2] ?? "dist");
  const site = await listen({ dir, base, port: Number(process.env.PORT ?? 8080) });

  console.log(`${dir} at ${site.origin}${prefix(base)}`);
}
