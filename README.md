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

GNU General Public License v3.0 or later ([LICENSE](LICENSE)), matching Kavita's GPL v3. Kavita's logo,
favicon and API description (GPL v3) and the Poppins and League Spartan fonts (SIL OFL 1.1) are included
unmodified; see [NOTICE.md](NOTICE.md). Kavita itself is a separate project, run here from the
[linuxserver.io image](https://docs.linuxserver.io/images/docker-kavita/).
