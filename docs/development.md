# Development

## Layout of `kavita-companion/`

```
src/            server (TypeScript, Node 24, ES modules) — see docs/architecture.md for each file
web/main.js     browser code (bundled with Uppy by esbuild into public/build/)
public/         index.html, style.css, assets/ (Kavita's fonts and icons, see assets/fonts/README.txt)
Dockerfile      3 stages: 7-Zip download (pinned + checksum), build, runtime
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

## Tests

Acceptance tests run against the live stack described by `.env`. See [tests/README.md](../tests/README.md).

```bash
tests/run.sh             # API tests
tests/run.sh --browser   # plus headless-browser tests
```

## Admin helper

`scripts/kavita-api.py METHOD PATH [JSON] [--as uploader|readonly|admin]` calls Kavita's API from the
host, authenticated with the portal's key (or as a test user). Kavita's Swagger UI isn't served in
production builds; the API description for the pinned version is in
`docs/reference/kavita-openapi-v0.9.1.4.json`.
