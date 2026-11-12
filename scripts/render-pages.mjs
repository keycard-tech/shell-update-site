// Renders the upstream Django templates into flat sibling pages/, implementing only the tags they use.

import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const TEMPLATES = join(ROOT, "templates");
const OUTPUT = join(ROOT, "pages");

const STATIC_ROOTS = { "keycard_shell/": "src/", "admin/img/": "src/img/" };
const MEDIA = "media/";

const URLS = {
  "landing": "index.html",
  "db:update-index": "update.html",
  "db:air-gapped-update": "air-gapped.html",
  "db:db-version-history": "db-version-history.html",
  "firmware:release-notes": "release-notes.html",
  "device:verify-index": "https://shell.keycard.tech/verify/",
};

const PAGES = [
  { template: "landing.html", url: "index.html" },
  { template: "shell_update.html", url: "update.html" },
  { template: "air_gapped_update.html", url: "air-gapped.html" },
  { template: "db_version_history.html", url: "db-version-history.html" },
  { template: "fw_release_notes.html", url: "release-notes.html" },
];

const BLOCK = /{%\s*block\s+(\w+)\s*%}([\s\S]*?){%\s*endblock(?:\s+\w+)?\s*%}/g;
const INCLUDE = /{%\s*include\s+'([^']+)'\s*%}/g;

function staticPath(name) {
  const clean = name.replace(/^\//, "");
  const prefix = Object.keys(STATIC_ROOTS).find((root) => clean.startsWith(root));

  if (prefix === undefined) throw new Error(`${name} is not in STATIC_ROOTS`);

  return `../${STATIC_ROOTS[prefix]}${clean.slice(prefix.length).replace(/\.js$/, ".ts")}`;
}

function resolveTags(html) {
  return html
    .replace(/{%\s*static\s+'([^']+)'\s*%}/g, (_, name) => staticPath(name))
    .replace(/{%\s*url\s+'([^']+)'\s*%}/g, (_, name) => {
      if (URLS[name] === undefined) throw new Error(`${name} is not in URLS`);
      return URLS[name];
    })
    .replace(/{%\s*get_media_prefix\s*%}/g, MEDIA)
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

  const merged = base.replace(BLOCK, (_, name, body) => defined.get(name) ?? body);

  return { html: resolveTags(await expandIncludes(merged)), title: (defined.get("title") ?? "").trim() };
}

await rm(OUTPUT, { recursive: true, force: true });

for (const page of PAGES) {
  const { html, title } = await renderPage(page);

  await mkdir(OUTPUT, { recursive: true });
  await writeFile(join(OUTPUT, page.url), html);
  console.log(`${page.template} -> pages/${page.url} "${title}"`);
}
