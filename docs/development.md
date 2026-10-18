# Development

## Layout of `kavita-companion/`

```
src/            server (TypeScript, Node 24, ES modules) — see docs/architecture.md for each file
web/main.js     browser code (bundled with Uppy by esbuild into public/build/)
public/         index.html, style.css, assets/ (Kavita's fonts and icons, see assets/fonts/README.txt)
Dockerfile      5 stages: 7-Zip download (pinned + checksum), build, base, then the `runtime-formats` and `runtime` targets (`runtime` is last, so a bare build is the permissive default)
build-web.mjs   esbuild bundle step
```

Dependencies are pinned exactly in `package.json` and locked in `package-lock.json`. Node isn't needed
on the host: everything builds inside Docker.

## Build and run

```bash
docker compose up -d --build kavita-companion     # rebuild and restart the portal
docker compose logs -f kavita-companion
```

Type-check without building the image:

```bash
cd kavita-companion
docker run --rm -u "$(id -u):$(id -g)" -e npm_config_cache=/tmp/npm -v "$PWD":/app -w /app node:24.21.0-alpine \
  sh -c 'npm ci --ignore-scripts >/dev/null && npx tsc -p . --noEmit'; rm -rf node_modules
```

Updating dependencies: change the version in `package.json`, then regenerate the lock file the same way
with `npm install --package-lock-only --ignore-scripts`.

## Releases and deploying live

`main` is the deployable branch; work happens on short-lived feature branches (the test worktree is on
`develop`). CI (`.github/workflows/ci.yml`) type-checks and builds on every push and pull request.

To cut a release:

1. Bump the version in `kavita-companion/package.json` and `package-lock.json`.
2. Move the `Unreleased` items in `CHANGELOG.md` under a new `## <version> — <date>` heading.
3. Commit, then tag: `git tag v<version> && git push origin main --tags`.
4. Update live: `cd /srv/kavita && git pull && ./setup.sh` (adds new settings, rebuilds the portal,
   restarts the stack). Verify with `tests/run.sh` **in the test worktree** first.

The portal database migrates itself on start; see [operations.md](operations.md) for backups and
rollback.

## Conventions

- Settings come from environment variables (`src/config.ts`), set in `compose.yaml` from `.env`. A new
  setting needs a line in `.env.example` (with a comment) and, if users must choose it, a prompt in
  `setup.sh`.
- Database changes: add columns in `src/db.ts` with the `PRAGMA table_info` check so existing databases
  migrate on start.
- Messages shown to users say what happened and what to do, in plain words.
- The look follows Kavita's dark theme tokens (see `public/style.css` header); keep new UI on those tokens.
- Anything that depends on Kavita API behaviour should be checked against the live server and recorded
  in [kavita-api.md](kavita-api.md).

## Test environment

Tests create series, approve files and (with `--roles`) change roles, so they must not run against the
live stack. A second, fully isolated stack runs beside it as its own compose project: a git worktree
at `../kavita-test` on a development branch.

```bash
git worktree add -b develop ../kavita-test main      # once
cd ../kavita-test
cp .env.test.example .env && chmod 600 .env            # once (never committed)
COMPOSE_ENV_FILES=.env KAVITA_ADMIN_USERNAME=admin KAVITA_ADMIN_PASSWORD='...' \
  ./setup.sh --non-interactive                         # once: creates the test Kavita + libraries
./setup.sh                                             # after that: (re)build and start it
```

It differs from live only through that `.env`: project `kavita-test`, ports 20006/20007/20008 (Kavita
local 20002), Docker subnet `172.31.0.0/24`, `MEDIA_ROOT=/srv/media-test`, `DATA_ROOT=./data-test` and
portal image `kavita-companion:test` (via `COMPANION_IMAGE`). It loads `compose.test.yaml` and `caddy/Caddyfile.test`, which
**reuse the live stack's Let's Encrypt certificate** (the domain's HTTP-01 challenge can only reach one
stack). Restart the test Caddy after the live certificate renews: `docker compose restart caddy`.

The test stack builds the **formats** image, not the permissive default: the slow tier needs the
GPL/LGPL extras — `tests/test_uploads.py` asserts a MOBI upload is converted to EPUB, and
`tests/test_metadata.py` builds a `.cb7` with `7zzs` and uploads it for the portal to read. `compose.test.yaml` carries that as a
tracked default (`target: ${COMPANION_BUILD_TARGET:-runtime-formats}`), so a rebuild stays on the
formats image without depending on the untracked `.env`; the overlay wins because it is listed second
in `COMPOSE_FILE`. `compose.yaml` on its own defaults to the permissive `runtime` target, which is
what an operator building from source gets.

The `TEST_*` Kavita accounts must exist in the test stack (create them once in the test Kavita,
Settings → Users). Work on a feature branch in the worktree, then merge to `main` and update live with
`git pull && ./setup.sh`.

The test `.env` also carries `TEST_STACK=1`, which `tests/settings.py` requires: the suite refuses to
run when it is missing, or when the resolved media root is the live `/srv/media` (see
[tests/README.md](../tests/README.md)). That is what keeps a stray run in the live checkout away from
the live library.

## Tests

Acceptance tests run against the stack described by the checkout's `.env` (the test environment above).
See [tests/README.md](../tests/README.md).

```bash
tests/run.sh             # the API tests (fast + slow)
tests/run.sh --fast      # the quick tier (no library writes) — the one to use while developing
tests/run.sh --browser   # plus headless-browser tests
tests/run.sh --roles     # plus test_roles_and_limits.py (safe on the test stack)
tests/run.sh --repeat 3  # run the fast tier 3 times and report anything that failed
```

## Admin helper

`scripts/kavita-api.py METHOD PATH [JSON] [--as uploader|readonly|admin]` calls Kavita's API from the
host, authenticated with the portal's key (or as a test user). Kavita's Swagger UI isn't served in
production builds; use Kavita's own published API documentation for the pinned version.
