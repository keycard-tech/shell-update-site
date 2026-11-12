// Renders templates/*.html (copied verbatim from keycard-shell-webapp) into static pages,
// implementing the handful of Django template tags those templates use. Nothing else parses them.
//
// URLS, STATIC_ROOTS and MEDIA below stand in for keycard_shell/urls.py, Django's static files app
// and MEDIA_ROOT: they are the only place a page path, an asset path or the unported verify URL is
// written. Pages, media and the built assets are siblings, so every URL here is relative and the same
// dist/ serves from a project page or a domain root. Parcel resolves relative URLs from the shared
// root of its entries rather than from each entry, which is what makes the flat layout a requirement.

import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const TEMPLATES = join(ROOT, "templates");
const OUTPUT = join(ROOT, "pages");

// {% static %} prefix -> build-time source directory, which Parcel replaces with hashed output paths.
const STATIC_ROOTS = { "keycard_shell/": "src/", "admin/img/": "src/img/" };
const MEDIA = "media/";

// Django url name -> page. "device:verify-index" is not ported, so it keeps pointing at the live site.
const URLS = {
  "landing": "index.html",
  "db:update-index": "update.html",
  "db:air-gapped-update": "air-gapped.html",
  "db:db-version-history": "db-version-history.html",
  "firmware:release-notes": "release-notes.html",
  "device:verify-index": "https://shell.keycard.tech/verify/",
};

// Template -> file under pages/, which Parcel builds into every entry of one site.
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

  // ../ because the rendered page sits in pages/, one level below src/.
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

  // Django keeps the block of the child template, and of the base where the child defines none.
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
