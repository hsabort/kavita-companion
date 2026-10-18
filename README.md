# Kavita stack with kavita-companion

A self-hosted [Kavita](https://www.kavitareader.com/) server for manga, comics and books, plus
**kavita-companion**: an upload portal that lets Kavita users send files to the server, and lets
Kavita admins check, correct and approve them before they appear in the library.

Everything runs in Docker and comes up with one script.

## What you get

- **Kavita** over HTTPS, with its library folders mounted read-only.
- **kavita-companion** (the upload portal), styled like Kavita and linked from each user's Kavita
  sidebar ("Uploads"), which signs them in automatically.
  - Sign in with your Kavita account; Read Only accounts can't upload.
  - Resumable uploads (up to 8 GB per file) that survive dropped connections.
  - Every file is checked: real file type, duplicates, archive safety.
  - Admin review queue with covers, embedded metadata, warnings and batch approval. Approved files
    get the corrected metadata written into them (comics are saved as CBZ with a clean
    ComicInfo.xml) and are filed into the right series folder; Kavita picks them up within a minute.
- **Caddy** in front of both, with Let's Encrypt certificates renewed automatically.

## Quick start

Requirements: a Linux host with Docker and the compose plugin, a domain name pointing at it, and
a way for Let's Encrypt to reach it on port 80 (see [docs/install.md](docs/install.md)).

```bash
git clone https://github.com/hsabort/kavita-companion.git /srv/kavita
cd /srv/kavita
./setup.sh
```

`setup.sh` asks for your domain, ports and media folder, writes `.env`, creates the folders, builds
and starts everything, creates the Kavita admin account and the Manga/Comics/Books libraries, and
connects the portal to Kavita. Run it again any time; it keeps what already works.

Then open `https://<domain>:<KAVITA_HTTPS_PORT>` for Kavita and `https://<domain>:<COMPANION_HTTPS_PORT>`
for the upload portal. Each user signs in to the portal once with their Kavita password; after that
"Uploads" is in their Kavita sidebar.

## Using the published image

The upload portal is published to GitHub Container Registry and can be pulled without signing in
(public, `linux/amd64`): `ghcr.io/hsabort/kavita-companion`.

To run a released build instead of building from source, set it in `.env` and re-run `./setup.sh`:

```dotenv
COMPANION_IMAGE=ghcr.io/hsabort/kavita-companion:0.2.1
```

`./setup.sh` then pulls the image instead of building it (`docker compose pull kavita-companion &&
docker compose up -d` does the same). Any other compose file can use the image directly, e.g.
`image: ghcr.io/hsabort/kavita-companion:latest`. Tags and rollback are in
[docs/operations.md](docs/operations.md).

## Documentation

| Document | For |
|---|---|
| [docs/install.md](docs/install.md) | Requirements, DNS, ports, HTTPS certificates, running `setup.sh`, special hosts (Incus/LXC) |
| [docs/user-guide.md](docs/user-guide.md) | Uploading, and reviewing uploads as an admin |
| [docs/operations.md](docs/operations.md) | Start/stop, logs, backups and restore, upgrades, troubleshooting |
| [docs/architecture.md](docs/architecture.md) | How the pieces fit together, data flow, storage layout |
| [docs/security.md](docs/security.md) | Security model, exposure, secrets |
| [docs/development.md](docs/development.md) | Working on kavita-companion, building, tests |
| [docs/kavita-api.md](docs/kavita-api.md) | Kavita API behaviour this project relies on (verified) |
| [docs/decisions.md](docs/decisions.md) | Why things are the way they are |
| [docs/roadmap.md](docs/roadmap.md) | Planned features (design only, not built yet) |
| [docs/metadata-providers.md](docs/metadata-providers.md) | External metadata-provider research (roadmap §5 phase 2) |
| [docs/roadmap-phase2.md](docs/roadmap-phase2.md) | Concrete plan for direct metadata integration (roadmap §5 phase 2) |
| [docs/product-review-plan.md](docs/product-review-plan.md) | Baseline product-review plan (UI/UX, QA, compliance, security) |
| [host/README.md](host/README.md) | Notes for running inside an unprivileged Incus/LXC container |
| [CHANGELOG.md](CHANGELOG.md) | What changed |
| [NOTICE.md](NOTICE.md) | Licences of included third-party material |

## Repository layout

```
compose.yaml          the whole stack (Kavita, Caddy, kavita-companion)
compose.test.yaml     overlay for the test environment (reuses live's certificate)
.env.example          every setting, documented (setup.sh creates .env from it)
.env.test.example     test-environment settings (docs/development.md)
setup.sh              install / update script
caddy/Caddyfile       HTTPS front end (live)
caddy/Caddyfile.test  HTTPS front end for the test environment
kavita-companion/     the upload portal (TypeScript, Node 24)
scripts/              admin helpers: backup.sh, kavita-api.py
tests/                acceptance tests (API + browser) and their runner
host/                 host-specific helpers (Docker install, Incus/LXC notes)
docs/                 documentation
data/                 runtime data: databases, certificates (not in git)
```

## Status

Version 0.2.0. See [CHANGELOG.md](CHANGELOG.md) for what's done and what's next.

## License

Apache License 2.0 ([LICENSE](LICENSE)) — Copyright 2026 James VanTassel. Contributions are accepted
under the same licence with a `Signed-off-by` sign-off; see [CONTRIBUTING.md](CONTRIBUTING.md).

The **container image** is a combined work and is not Apache-2.0 on its own: it bundles 7-Zip
(LGPL 2.1+ with the unRAR restriction) and KindleUnpack (GPL-3.0-only), so the image as a whole is
distributed under GPL-3.0. The Poppins and League Spartan fonts (SIL OFL 1.1) are included
unmodified. See [NOTICE.md](NOTICE.md) for the full set.

Kavita itself is a separate project, run here from the
[linuxserver.io image](https://docs.linuxserver.io/images/docker-kavita/); this repository contains no
Kavita source, schema, strings or assets — see [docs/clean-room.md](docs/clean-room.md).

## Provenance

This project was written by AI coding agents working under human direction. The architecture, product
decisions and behaviour were chosen and reviewed by James VanTassel; the code was produced by agents.
It is developed under a clean-room discipline so that no third-party source, schema, strings or assets
are carried into it, and every dependency is under a permissive licence. See
[docs/clean-room.md](docs/clean-room.md).
