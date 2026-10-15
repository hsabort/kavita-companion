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
- **kavita-companion:** `git pull`, then `./setup.sh` (adds any new settings to `.env`, rebuilds, restarts).
  The portal's database migrates itself on start.

## Moving the media library

Stop the stack, move the folder (keep `manga/`, `comics/`, `books/`, `.incoming/` together; moving
within the same disk is instant), set `MEDIA_ROOT` in `.env`, run `docker compose up -d`. Kavita's
paths (`/data/...` inside the container) don't change, so nothing needs re-scanning.

## Users

- Users are Kavita accounts; manage them in Kavita. Anyone who isn't **Read Only** can upload;
  **Admins** review. Role changes reach open portal sessions within about 2 minutes, and removing a
  user's Login role or deleting them signs them out.
- If someone's "Uploads" sidebar link stops working (e.g. they deleted its key in Kavita), they sign in
  to the portal with their password once and it is repaired.

## Housekeeping (automatic)

Hourly: expired sessions removed; uploads with no data for 24 h removed; rejected files deleted after
7 days (the record and reason stay); daily database snapshot.

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
| Every visitor has the same IP in the audit log | A TCP forwarder in front of the host hides client IPs; see "Special hosts" in docs/install.md. |
| `setup.sh` says the portal key doesn't work | It makes a new one; have an admin's credentials ready. |
