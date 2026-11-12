# Keeping the site in sync with the latest release

The page scripts read the firmware and database as same-origin files, because GitHub serves release
assets without `Access-Control-Allow-Origin`: a request for
`github.com/…/releases/download/…` redirects to `release-assets.githubusercontent.com`, which
answers without that header, so a page on GitHub Pages cannot read the bytes it is about to flash.
`scripts/sync-upstream.mjs` downloads them at build time instead.

That makes one question worth answering carefully: how does a release published to
[keycard-shell](https://github.com/keycard-tech/keycard-shell) or
[keycard-eth-db](https://github.com/keycard-tech/keycard-eth-db) reach this site?

## 1. On release, automatically (~1–2 minutes)

Copy [upstream-release-trigger.yml](upstream-release-trigger.yml) into `.github/workflows/` of both
upstream repos and give them a token that may start our workflow:

1. Create a fine-grained personal access token with **only** `keycard-tech/shell-update-site` in its
   repository scope and the **Actions: Read and write** permission. It must belong to an account with
   write access to that repository.
2. Store it as `UPDATE_SITE_SYNC_TOKEN` — once for the whole org, so both repos share it:

   ```console
   gh secret set UPDATE_SITE_SYNC_TOKEN --org keycard-tech < token.txt
   ```

Publishing, editing or deleting a release then dispatches `upstream-release` here, and this repo's
`sync and deploy` workflow rebuilds and republishes the site. Without touching either upstream repo,
you can fire the same path by hand to check your setup:

```console
gh api repos/keycard-tech/shell-update-site/dispatches -f event_type=upstream-release
```

## 2. On release, by hand (no token anywhere)

If you would rather not put a token in the release repos, make this the last step of the release
checklist — it is the same workflow the dispatch runs:

```console
gh workflow run sync-and-deploy.yml -R keycard-tech/shell-update-site
```

Or: Actions → *sync and deploy* → **Run workflow**.

## 3. On a schedule, as a backstop

The workflow also runs every 15 minutes, so a release that slipped through 1 or 2 is picked up on its own —
but a schedule is the slowest of the three paths, and until `upstream-release-trigger.yml` is installed in both
upstream repos it is the only one:

- GitHub does not start scheduled runs on the dot. Under load a run scheduled for `:00` can start many
  minutes later, and a run scheduled for a popular minute waits behind everyone else's.
- `concurrency.group: pages` with `cancel-in-progress: false` means a run started while another is still going
  waits for it rather than racing it.
- The sync itself waits up to `SYNC_UPLOAD_ATTEMPTS` × `SYNC_UPLOAD_DELAY_SECONDS` (5 × 60 s) when the newest
  release has started publishing but has not finished, which is common because a release is uploaded from more
  than one job.
- The deployment at the end takes another minute or so.

GitHub also stops running schedules on repositories inactive for 60 days, which is why 1 or 2 remain the
primary path.

## What a run does

Every run re-reads both repositories and rebuilds the whole mirror in `pages/media.tmp`, so a single dispatch
refreshes firmware and database together; there is nothing to select per release. Each artifact is verified
against the checksum the release publishes (`tools/firmware-hash.py` and `tools/database-hash.py` algorithms,
the same ones the bootloader and the device use) and against the version inside the binary, and the new mirror
is swapped in only once both sides are done — a run that fails leaves the previous mirror and the previous
site exactly as they were. `npm run check` then walks the built site, and the deploy step never runs without it.

A release that cannot be verified is not the same as a corrupted one. If the newest release has not finished
uploading — no `*-sha256.txt` yet, or one that does not name the image — the run waits, then mirrors the last
complete release and records the refusal in `media/sync.json` under `incomplete`. A checksum that disagrees
stops the run.

To ask the same question without building anything:

```console
npm run sync -- --dry-run
```

```
firmware: upstream 1.5.2, mirrored 1.5.2 (up to date)
database: upstream 20261111, mirrored 20261111 (out of date)
```

| File under `media/` | Written from | Read by |
| --- | --- | --- |
| `get-firmware.json` | latest firmware release | `update.html`, `air-gapped.html` |
| `get-db.json` | latest database release | the same two pages |
| `get-firmwares.json` | every firmware release | `release-notes.html` |
| `get-dbs.json` | every database release | `db-version-history.html` |
| `firmware.bin`, `db.bin` | latest verified release | transferred to the device |
| `changelogs/<version>.md` | the body of every firmware release | `release-notes.html` |
| `sync.json` | provenance for the logs and `--dry-run` | nothing at runtime |

Older firmware and database releases are not mirrored: the version history links each reproduction zip
to the release it belongs to. Only the bytes a device is flashed with need to be same-origin.
