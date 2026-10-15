# Notes for Claude

Kavita + **kavita-companion** (upload portal) + Caddy, all in `compose.yaml`, configured by `.env`.
Start with `README.md`; details are in `docs/` — keep them current when behaviour changes
(`docs/kavita-api.md` for anything learned about Kavita's API, `docs/decisions.md` for choices,
`CHANGELOG.md` for user-visible changes).

## Status

0.2.0 (theme sync, In Kavita ✓ confirmation, Fix for approved files, licence) — see CHANGELOG.
Real users (jim, and others) use the portal: never touch their uploads or library files.

## Working here

- Repository: `/srv/kavita` (code) with runtime data in `/srv/kavita/data` and media in `/srv/media`
  (moved from `~/projects/kavita` and `~/media` on 2026-10-15). Never commit `.env`, `data/`, `backups/`.
  The test environment is a git worktree at `/srv/kavita-test` (branch `develop`).
- Rebuild the portal: `docker compose up -d --build kavita-companion`. Caddy config change:
  `docker compose restart caddy`.
- Kavita API from the host: `python3 scripts/kavita-api.py METHOD PATH [JSON] [--as uploader|readonly|admin]`.
- Tests: run them in the test worktree `/srv/kavita-test` against the test stack, not here (they create
  series and change roles; see docs/development.md). `tests/run.sh [--browser] [--roles]` needs the
  TEST_* accounts (`tests/README.md`); `tests/create_test_accounts.py` creates them. On the live stack,
  never run `--roles` while real people use the portal: it changes test-uploader's roles. More than two
  full runs within 15 minutes trips the per-address failed sign-in limit (restart kavita-companion).
- Never commit or push until the user has created the repository and provided credentials for it.
- No Node on the host: build/type-check inside Docker (`docs/development.md`).

## Environment gotchas (the original host)

- Unprivileged Incus/LXC container: Docker storage driver btrfs, nesting enabled (`host/README.md`).
- The Incus host forwards public ports 20001–20099 to this container's **127.0.0.1** with the PROXY
  protocol; anything bound to 127.0.0.1/0.0.0.0 in that range is public and must accept PROXY headers
  (or sit behind Caddy). SSH (20000) has its own forward without it. When asking the owner to change
  host forwards, give all steps as one paste.
- Only ports 20001–20099 may be published on this host.
- Let's Encrypt HTTP-01 reaches Caddy via Apache on the Incus host forwarding
  `/.well-known/acme-challenge/` to port 20003.
- Real users (jim, and others) use the portal: check `audit_log` for recent activity before anything
  disruptive, and never touch non-test uploads or library files.
