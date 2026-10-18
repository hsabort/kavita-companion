# Notes for Claude

Kavita + **kavita-companion** (upload portal) + Caddy, all in `compose.yaml`, configured by `.env`.
Start with `README.md`; details are in `docs/` — keep them current when behaviour changes
(`docs/kavita-api.md` for anything learned about Kavita's API, `docs/decisions.md` for choices,
`CHANGELOG.md` for user-visible changes).

## Status

0.2.0 (theme sync, In Kavita ✓ confirmation, Fix for approved files, licence) — see CHANGELOG.
Real users use the portal: never touch their uploads or library files.

## Working here

- This checkout holds the code; runtime data and the media root live where `.env` points them
  (`README.md`). Never commit `.env`, `data/`, `backups/`.
- Keep a **second checkout** as the test environment — a git worktree on a scratch branch — so
  experiments never touch the live library. `tests/settings.py` aborts unless the checkout is marked
  as a test stack and its media root is not the live one (see `docs/development.md`).
- Rebuild the portal: `docker compose up -d --build kavita-companion`. Caddy config change:
  `docker compose restart caddy`.
- Kavita API from the host: `python3 scripts/kavita-api.py METHOD PATH [JSON] [--as uploader|readonly|admin]`.
- Tests: run them in the test checkout against the test stack, not here (they create series and change
  roles; see `docs/development.md`). `tests/run.sh [--browser] [--roles]` needs the `TEST_*` accounts
  (`tests/README.md`); `tests/create_test_accounts.py` creates them. On the live stack, never run
  `--roles` while real people use the portal: it changes test-uploader's roles. More than two full
  runs within 15 minutes trips the per-address failed sign-in limit (restart kavita-companion).
- No Node on the host: build/type-check inside Docker (`docs/development.md`).

## Environment gotchas

- The app runs in an **unprivileged container**. Docker uses the btrfs storage driver with nesting
  enabled; the host side is described in `host/README.md`.
- **Anything the host publishes is public.** Bind a port only behind Caddy, or make the service accept
  PROXY headers itself. When asking the host owner to change a forward, give every step as one paste.
- Only the host's reserved port range may be published. See `host/README.md` for the range and for how
  certificate challenges are relayed to Caddy.
- Real users use the portal: check `audit_log` for recent activity before anything disruptive, and
  never touch non-test uploads or library files.
