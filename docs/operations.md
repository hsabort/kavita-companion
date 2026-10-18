# Operations

Run everything from the repository folder (e.g. `/srv/kavita`).

## Everyday commands

| Task | Command |
|---|---|
| Status | `docker compose ps` |
| Start / apply `.env` changes | `docker compose up -d` |
| Stop | `docker compose down` |
| Logs | `docker compose logs -f kavita` (or `caddy`, `kavita-companion`) |
| Rebuild the portal after code changes | `docker compose up -d --build kavita-companion` |
| Reload Caddy after editing `caddy/Caddyfile` | `docker compose restart caddy` |
| Kavita API from the host | `python3 scripts/kavita-api.py GET /api/Library/libraries` |

Logs are capped at 5 × 10 MB per container.

## Backups

**What to back up**

| What | Where | How |
|---|---|---|
| Settings and secrets | `.env` | `scripts/backup.sh` |
| Kavita (database, users, reading progress, covers) | `data/kavita/` | `scripts/backup.sh`; Kavita also keeps its own backups in `data/kavita/backups/` |
| Portal database (uploads, history, audit log) | `data/companion/` | `scripts/backup.sh`; the portal also snapshots it daily to `data/companion/backups/` (14 kept) |
| Certificates | `data/caddy/` | `scripts/backup.sh` (can also simply be re-issued) |
| The library itself | `MEDIA_ROOT` | your usual file backup (it is large and not included) |

`scripts/backup.sh [folder]` stops Kavita and the portal for a few seconds, writes
`backups/kavita-stack-<date>.tar.gz` (readable only by you, since it contains `.env`), and starts them again.
Copy those archives off the server.

**Restore**

```bash
docker compose down
tar -xzf kavita-stack-<date>.tar.gz          # restores .env and data/ into the repository folder
# put the media library back at MEDIA_ROOT if needed
./setup.sh                                    # checks everything and starts the stack
```

## Upgrades

Versions are pinned in `.env` so upgrades are deliberate.

- **Kavita:** read the release notes, run `scripts/backup.sh`, change `KAVITA_IMAGE_TAG`, then
  `docker compose pull kavita && docker compose up -d`. Afterwards check the portal still works
  (`tests/run.sh` if test accounts are set up): it relies on the Kavita API behaviour listed in
  [kavita-api.md](kavita-api.md), and its look copies Kavita's theme.
- **Caddy:** change `CADDY_IMAGE_TAG`, then `docker compose pull caddy && docker compose up -d`.
- **kavita-companion (built from source):** `git pull`, then `./setup.sh` (adds any new settings to `.env`,
  rebuilds, restarts). The portal's database migrates itself on start.
- **kavita-companion (released image):** change `COMPANION_IMAGE` in `.env` to a published tag (see
  [kavita-companion images](#kavita-companion-images-ghcr) below), then `./setup.sh` to pull and restart.

## kavita-companion images (GHCR)

CI publishes the portal image to `ghcr.io/hsabort/kavita-companion`:

| Trigger | Tags pushed |
|---|---|
| a version tag `vX.Y.Z` | `X.Y.Z`, `X.Y`, `latest` — each with a `-formats` counterpart (`X.Y.Z-formats`, `X.Y-formats`, `latest-formats`) |
| a push to `main` | `edge` and `sha-<short>` — each with a `-formats` counterpart |
| a pull request | none (build check only) |

Every published tag has a `-formats` counterpart, built from the same commit and carrying the GPL
tools. `latest` is **always** the permissive image, so an unqualified pull never gets the combined
work.

The package is **public**, so it can be pulled without logging in — in this stack or anywhere else:

```yaml
# any docker-compose.yml
services:
  kavita-companion:
    image: ghcr.io/hsabort/kavita-companion:0.2.1
```

To run a released image instead of building from source, set it in `.env` and apply:

```bash
# .env
COMPANION_IMAGE=ghcr.io/hsabort/kavita-companion:0.2.1
```
```bash
./setup.sh                       # or: docker compose pull kavita-companion && docker compose up -d
```

Roll back by pointing `COMPANION_IMAGE` at an earlier tag and pulling again. Leave `COMPANION_IMAGE`
empty to build from `./kavita-companion` (the default, and what the test environment does).

### Which image: permissive default or formats

Two images are published from one Dockerfile:

| Image | Reads / converts | Licence |
|---|---|---|
| `X.Y.Z` — the **permissive default**, and what `latest` means | `.zip`, `.cbz`, `.epub`, `.pdf`, and a `.cbr` whose bytes are really a zip | permissive (`Apache-2.0 AND OFL-1.1`) |
| `X.Y.Z-formats` — the **combined work** | all of the above **plus** reading `.rar`/`.cb7`/`.7z` and converting `.mobi`/`.azw`/`.azw3` to EPUB | `Apache-2.0 AND OFL-1.1 AND GPL-3.0-only AND LGPL-2.1-or-later`; never tagged `latest` |

The formats image adds 7-Zip and KindleUnpack. The default image refuses a file it cannot handle with
a message naming the formats image — never a silent failure.

**Switch to the formats image (prebuilt):**

```bash
# .env
COMPANION_IMAGE=ghcr.io/hsabort/kavita-companion:X.Y.Z-formats
```
```bash
./setup.sh                       # or: docker compose pull kavita-companion && docker compose up -d
```

**Switch to the formats image (building from source):**

```bash
# .env
COMPANION_BUILD_TARGET=runtime-formats
```
```bash
docker compose up -d --build kavita-companion
```

**Switch back to the permissive default:** empty `COMPANION_BUILD_TARGET` (the variable is read with
`:-` semantics, so an empty value selects the default `runtime` target) and either point
`COMPANION_IMAGE` at a plain tag or empty it to build from source, then apply the same way.

### Migrating a deployment that needs the extras

A stack that reads `.rar`/`.cb7`/`.7z` or converts MOBI/AZW/AZW3 needs the formats image. Move it
before upgrading to a release that ships the split, either with
`COMPANION_IMAGE=ghcr.io/hsabort/kavita-companion:X.Y.Z-formats`, or, building from source,
`COMPANION_BUILD_TARGET=runtime-formats`. Otherwise those formats are refused after the upgrade.

## Moving the media library

Stop the stack, move the folder (keep `manga/`, `comics/`, `books/`, `.incoming/` together; moving
within the same disk is instant), set `MEDIA_ROOT` in `.env`, run `docker compose up -d`. Kavita's
paths (`/data/...` inside the container) don't change, so nothing needs re-scanning.

## Users

- Users are Kavita accounts; manage them in Kavita. Anyone who isn't **Read Only** can upload;
  **Admins** review. Role changes reach open portal sessions within about 2 minutes, and removing a
  user's Login role or deleting them signs them out.
- If someone's "Uploads" sidebar link stops working (e.g. they deleted its key in Kavita), they sign in
  to the portal with their password once and it is repaired, or — if they are already signed in — they
  press **Add Uploads to your Kavita sidebar** on the portal's **Upload** tab. Either way the portal
  uses their own Kavita session (the endpoint is `POST /api/sidebar/connect`).

## Housekeeping (automatic)

Hourly: expired sessions removed; uploads with no data for 24 h removed; rejected files deleted after
7 days (the record and reason stay); daily database snapshot.

## Metadata providers (phase 2)

The portal can fill a reviewed file's metadata from external sources — comics **Metron → GCD**,
manga/light novels **MangaDex → AniList**, books **Hardcover → Open Library**. This is **off by
default**: with `METADATA_EXTERNAL_ENABLED=false` nothing is ever fetched, and each provider is off
until an admin turns it on. Nothing is fetched in the background or in bulk; a source is called only
when a reviewer presses **Find metadata** on a file. Obligations, caching and key handling are in
[compliance.md](compliance.md).

- **Turn a provider on/off:** the **About** tab → **Metadata sources** panel (reviewers/admins), or
  `PROVIDER_<ID>_ENABLED=true` in `.env`. The panel also shows the cache size and a **Test** button.
- **Keys:** supply your own per-install key — Metron bearer token (`PROVIDER_METRON_KEY` or the panel),
  Hardcover personal access token (`PROVIDER_HARDCOVER_KEY`), or an optional GCD account
  (`PROVIDER_GCD_KEY`, `user:pass`). MangaDex, AniList and Open Library need none. A key set in `.env`
  wins over the panel; keys are sealed at rest and never shown again. Ship no keys.
- **Politeness:** set `COMPANION_CONTACT_EMAIL` so the shared `User-Agent` identifies the instance (Open
  Library's faster tier, and good manners generally). Rate limits and `Retry-After` are honoured.
- **Turning a provider off** (or clearing its key) purges its cached records and series links and is
  recorded in the activity log.
- **Cache:** `metadata_cache` in `data/companion/companion.db`, with a per-provider TTL (Metron/GCD/
  Hardcover/Open Library 30 d, MangaDex 7 d, AniList 3 d); expired rows are purged hourly.

## Troubleshooting

| Symptom | Check |
|---|---|
| Browser certificate warning | `docker compose logs caddy` for ACME errors. Let's Encrypt must reach `http://<DOMAIN>/.well-known/acme-challenge/` on port 80 and get Caddy on `ACME_HTTP_PORT` (docs/install.md). |
| Portal says Kavita is unreachable | `docker compose ps`, `docker compose logs kavita` |
| Upload refused | The message says why (type, size, quota, disk space). Limits are in `.env`. |
| Approved file not in Kavita | Kavita scans the series folder about a minute after approval. Kavita ignores files at a library's root; the portal never puts them there. Check `docker compose logs kavita` for scan errors. |
| Approval failed | The reason is on the review card and in `docker compose logs kavita-companion`; the upload stays in the queue. |
| "Kavita hasn't listed this file" | Run a scan of that library in Kavita, then **Check again**. Kavita ignores files at a library's root and won't remove series while a library folder is empty. |
| Wrong name/series/metadata on an approved file | Use **Fix…** (Recent decisions, or *Find an approved file to fix*). |
| **Find metadata** shows nothing | Check **About → Metadata sources**: the source may be off, need a key, or be in a rate-limit cool-down ("On — needs a key"). Nothing is fetched automatically. |
| A metadata provider can't be reached | The review card keeps working; the lookup just reports the failure. Check `docker compose logs kavita-companion` and the provider's status page. |
| Every visitor has the same IP in the audit log | A TCP forwarder in front of the host hides client IPs; see "Special hosts" in docs/install.md. |
| `setup.sh` says the portal key doesn't work | It makes a new one; have an admin's credentials ready. |
