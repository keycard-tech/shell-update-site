// Renders the upstream Django templates into the URL tree of scripts/site.mjs, using only the tags they use

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { MEDIA, PAGES, STATIC_ROOTS, URLS, at } from "./site.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const TEMPLATES = join(ROOT, "templates");
const OUTPUT = join(ROOT, "pages");

const BLOCK = /{%\s*block\s+(\w+)\s*%}([\s\S]*?){%\s*endblock(?:\s+\w+)?\s*%}/g;
const INCLUDE = /{%\s*include\s+'([^']+)'\s*%}/g;

function staticPath(name, depth) {
  const clean = name.replace(/^\//, "");
  const prefix = Object.keys(STATIC_ROOTS).find((root) => clean.startsWith(root));

  if (prefix === undefined) throw new Error(`${name} is not in STATIC_ROOTS`);

  return `${"../".repeat(depth)}${STATIC_ROOTS[prefix]}${clean.slice(prefix.length).replace(/\.js$/, ".ts")}`;
}

function resolveTags(html, depth) {
  return html
    .replace(/{%\s*static\s+'([^']+)'\s*%}/g, (_, name) => staticPath(name, depth))
    .replace(/{%\s*url\s+'([^']+)'\s*%}/g, (_, name) => {
      if (URLS[name] === undefined) throw new Error(`${name} is not in URLS`);
      return at(URLS[name]);
    })
    .replace(/{%\s*get_media_prefix\s*%}/g, at(MEDIA))
    .replace(/{%\s*now\s+'Y'\s*%}/g, String(new Date().getFullYear()))
    .replace(/{%\s*(load|extends)[^%]*%}\n/g, "");
}

async function expandIncludes(html) {
  for (const match of [...html.matchAll(INCLUDE)]) {
    const partial = await readFile(join(TEMPLATES, match[1].replace("./", "")), "utf8");
    html = html.replace(match[0], await expandIncludes(partial));
  }

  return html;
}

async function renderPage(page) {
  const source = await readFile(join(TEMPLATES, page.template), "utf8");
  const defined = new Map([...source.matchAll(BLOCK)].map(([, name, body]) => [name, body]));
  const base = await readFile(join(TEMPLATES, "base.html"), "utf8");
  const depth = page.path.split("/").length;

  const merged = base.replace(BLOCK, (_, name, body) => defined.get(name) ?? body);

  return { html: resolveTags(await expandIncludes(merged), depth), title: (defined.get("title") ?? "").trim() };
}

// Pages are overwritten, never cleared with the directory: pages/media holds the mirrored artifacts inside it
for (const page of PAGES) {
  const { html, title } = await renderPage(page);

  await mkdir(join(OUTPUT, dirname(page.path)), { recursive: true });
  await writeFile(join(OUTPUT, page.path), html);
  console.log(`${page.template} -> pages/${page.path} "${title}"`);
}
