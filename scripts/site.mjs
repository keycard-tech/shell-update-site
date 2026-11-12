// The site's URL tree: the one place a page path, a link target, the media prefix or the site base is written

import { readFileSync } from "node:fs";

export const BASE = process.env.SITE_BASE ?? "/";

export const STATIC_ROOTS = { "keycard_shell/": "src/", "admin/img/": "src/img/" };

export const URLS = {
  "landing": "",
  "db:update-index": "update/",
  "db:air-gapped-update": "update/air-gapped",
  "db:db-version-history": "update/db-version-history",
  "firmware:release-notes": "firmware/release-notes",
  "device:verify-index": "verify/",
};

export const PAGES = [
  { template: "landing.html", path: "index.html" },
  { template: "shell_update.html", path: "update/index.html" },
  { template: "air_gapped_update.html", path: "update/air-gapped/index.html" },
  { template: "db_version_history.html", path: "update/db-version-history/index.html" },
  { template: "fw_release_notes.html", path: "firmware/release-notes/index.html" },
  { template: "verify.html", path: "verify/index.html" },
];

export const MEDIA = "media/";

// The mirror the pages read: the artifacts under names that never change, and the documents that name them
export const ARTIFACTS = {
  firmware: "firmware.bin",
  firmwareBtc: "firmware-btc.bin",
  database: "db.bin",
  units: "units.bin",
};
export const DOCUMENTS = ["get-firmware.json", "get-db.json", "get-units.json", "get-firmwares.json", "get-dbs.json", "sync.json"];

// The pinned key the allowlist signature is checked against, never inferred from where the file was downloaded from
export const UNITS_VERIFY_KEY = JSON.parse(readFileSync(new URL("../trust.json", import.meta.url))).unitsVerifyKey;

// A release kind is fatal to the sync exactly when a page reads it; one no page reads is only a warning
export const PAGE_DOCUMENTS = [
  { kind: "firmware", document: "get-firmware.json" },
  { kind: "database", document: "get-db.json" },
  { kind: "units", document: "get-units.json" },
];

// The artifacts a document names, by path relative to itself and by the hash it publishes for them
export const artifactsOf = (document) =>
  document.variants !== undefined
    ? document.variants.map(({ path, hash }) => ({ path, hash }))
    : [{ path: document.db_path, hash: document.hash }];

export const at = (path) => (BASE.endsWith("/") ? BASE + path : `${BASE}/${path}`);

// "update/air-gapped/index.html" is linked as "/update/air-gapped", not as ".../index.html"
export const linkOf = (page) => at(page.path.replace(/index\.html$/, ""));

export const prefix = (base) => (base.endsWith("/") ? base : `${base}/`);
