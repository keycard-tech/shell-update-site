// The site's URL tree: the one place a page path, a link target, the media prefix or the site base is written.

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

// The mirror the pages read: the two artifacts under names that never change, and the documents that name them.
export const ARTIFACTS = { firmware: "firmware.bin", database: "db.bin" };
export const DOCUMENTS = ["get-firmware.json", "get-db.json", "get-firmwares.json", "get-dbs.json", "sync.json"];

// The two documents an update page reads, the artifact each names relative to itself, and their release kind.
export const UPDATES = [
  { kind: "firmware", document: "get-firmware.json", key: "fw_path", artifact: ARTIFACTS.firmware },
  { kind: "database", document: "get-db.json", key: "db_path", artifact: ARTIFACTS.database },
];

export const at = (path) => (BASE.endsWith("/") ? BASE + path : `${BASE}/${path}`);

// "update/air-gapped/index.html" is linked as "/update/air-gapped", not as ".../index.html".
export const linkOf = (page) => at(page.path.replace(/index\.html$/, ""));

export const prefix = (base) => (base.endsWith("/") ? base : `${base}/`);
