# Kavita stack with kavita-companion

A self-hosted [Kavita](https://www.kavitareader.com/) server for manga, comics and books, plus
**kavita-companion**: an upload portal that lets Kavita users send files to the server, and lets
Kavita admins check, correct and approve them before they appear in the library.

Everything runs in Docker and comes up with one script.

> **Project status: end of development.** kavita-companion is no longer under active development and
> is not accepting contributions. It is left here as a working, self-contained tool: the published
> images and the documentation below are accurate for the frozen release, and nothing further is
> planned. The reusable naming/metadata **rules and fixture corpus** this project produced
> (`docs/companion-rules-v1.md`, `tests/conformance/`, `tests/fixtures/`) were handed to the Lectern
> project as a language-neutral specification, and the repository is Apache-2.0 so its code can be
> reused. Issues that are known and were not fixed are listed under
> [Known limits](docs/security.md#known-limits).

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
(public, `linux/amd64`): `ghcr.io/hsabort/kavita-companion`. There are **two images**:

- the **permissive default** (`ghcr.io/hsabort/kavita-companion:X.Y.Z`, and what an unqualified pull
  means) — reads `.zip`, `.cbz`, `.epub`, `.pdf`, and any `.cbr` whose bytes are really a zip;
- the **formats image** (`ghcr.io/hsabort/kavita-companion:X.Y.Z-formats`) — the default plus 7-Zip
  and KindleUnpack, so it can also read `.rar`/`.cb7`/`.7z` and convert `.mobi`/`.azw`/`.azw3` to
  EPUB. It is a combined GPL work and is never tagged `latest`.

The default gives up exactly those extras: reading `.rar`, `.cb7` and `.7z`, and MOBI/AZW/AZW3
conversion. Everything else — `.zip`, `.cbz`, `.epub`, `.pdf`, and a `.cbr` whose bytes are really a
zip — still works. An upload of a file the image can't handle is refused with a message naming the
formats image, never a silent failure.

### Run a released image (prebuilt)

To run a released build instead of building from source, set `COMPANION_IMAGE` in `.env` and re-run
`./setup.sh` (it pulls the image instead of building; `docker compose pull kavita-companion && docker
compose up -d` does the same):

```dotenv
# the permissive default; 0.2.1 is an old concrete release, shown as an example
COMPANION_IMAGE=ghcr.io/hsabort/kavita-companion:0.2.1
```

For the formats image, append `-formats` to the release's tag — `X.Y.Z-formats` for release `X.Y.Z`:

```dotenv
COMPANION_IMAGE=ghcr.io/hsabort/kavita-companion:X.Y.Z-formats
```

### Build from source

Leave `COMPANION_IMAGE` empty (the default) and choose the target with `COMPANION_BUILD_TARGET`:
`runtime` (the default) builds the permissive image, and `runtime-formats` builds the combined work:

```dotenv
COMPANION_BUILD_TARGET=runtime-formats
```

Then `./setup.sh` builds and starts it (`docker compose up -d --build kavita-companion` does the
same). Any other compose file can use the image directly, e.g.
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

**Frozen at 0.9.0** (2026-10-18). Development has ended; see the note at the top. The stack is
deployable as-is and the acceptance tests pass against it. [CHANGELOG.md](CHANGELOG.md) records what
was built; [docs/roadmap.md](docs/roadmap.md) and [docs/roadmap-phase2.md](docs/roadmap-phase2.md)
are unbuilt design, kept for reference.

## License

Apache License 2.0 ([LICENSE](LICENSE)) — Copyright 2026 James VanTassel. The repository is frozen and
contributions are closed (see [CONTRIBUTING.md](CONTRIBUTING.md)); code from this project may be
reused under the terms of that licence.

Two container images are published. The **permissive default** (`:X.Y.Z`, and what `:latest` means)
contains only this repository's Apache-2.0 code and the SIL OFL 1.1 Poppins and League Spartan fonts,
so it is `Apache-2.0 AND OFL-1.1`. The **formats image** (`:X.Y.Z-formats`) is a combined work: the
default plus 7-Zip (LGPL 2.1+ with the unRAR restriction) and KindleUnpack (GPL-3.0-only), so it is
`Apache-2.0 AND OFL-1.1 AND GPL-3.0-only AND LGPL-2.1-or-later` and is never tagged `latest`. See
[NOTICE.md](NOTICE.md) for the full set.

Kavita itself is a separate project, run here from the
[linuxserver.io image](https://docs.linuxserver.io/images/docker-kavita/); this repository contains no
Kavita source, schema, strings or assets — see [docs/clean-room.md](docs/clean-room.md).

## Provenance

This project was written by AI coding agents working under human direction. The architecture, product
decisions and behaviour were chosen and reviewed by James VanTassel; the code was produced by agents.
It is developed under a clean-room discipline so that no third-party source, schema, strings or assets
are carried into it, and every dependency is under a permissive licence. See
[docs/clean-room.md](docs/clean-room.md).
