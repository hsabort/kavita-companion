# Architecture

## Components

```
                 Internet
                    │  HTTPS :KAVITA_HTTPS_PORT          HTTPS :COMPANION_HTTPS_PORT
                    │  (+ :ACME_HTTP_PORT for Let's Encrypt checks)
                    ▼
            ┌───────────────┐
            │     caddy     │  TLS (Let's Encrypt), reverse proxy, optional PROXY protocol
            └──┬─────────┬──┘
               │         │                      Docker network DOCKER_SUBNET
       kavita:5000   kavita-companion:3000
               │         │
     ┌─────────▼──┐   ┌──▼───────────────────┐
     │   kavita   │◄──┤   kavita-companion   │  calls Kavita's REST API (admin auth key,
     │ (linuxsrv) │   │  Fastify + tus + SQL │  and users' own sessions for sign-in)
     └─────┬──────┘   └───┬──────────────────┘
           │ read-only    │ read-write
           ▼              ▼
     MEDIA_ROOT/{manga,comics,books}     MEDIA_ROOT/.incoming (upload staging)
```

| Service | Image | Role |
|---|---|---|
| `kavita` | `lscr.io/linuxserver/kavita` (pinned) | The reader. Library folders are mounted read-only. Its plain HTTP port is published only on the Docker network gateway for local admin tools. |
| `caddy` | `caddy` (pinned) | The only public entry point. HTTPS for both apps, certificates via Let's Encrypt HTTP-01. |
| `kavita-companion` | built from `kavita-companion/`, or `ghcr.io/hsabort/kavita-companion` | The upload portal. Not published; reached through Caddy. |

All three run as the unprivileged `PUID:PGID` user (Kavita drops to it after start-up).

## kavita-companion internals

`kavita-companion/src/`:

| File | Does |
|---|---|
| `server.ts` | Fastify app: security headers, CSRF origin check, rate limits, sign-in (password and Kavita sidebar link), hourly jobs |
| `auth.ts` | Sessions (cookie `__Host-kc_session`, SHA-256 of the token in SQLite), permissions from Kavita roles, live role re-check |
| `uploads.ts` | Resumable uploads (tus protocol at `/files`), limits, file-type detection, duplicate check, "your uploads" API |
| `inspect.ts` | Reads each pending upload once: page count and list, cover, embedded metadata |
| `review.ts` | Review queue API, approval plan and background approval job, reject/restore, page preview, metadata suggestions, cleanup |
| `archive.ts` | Safe wrappers around 7-Zip (read) and yazl (write zips) |
| `metadata.ts` | Read/write ComicInfo.xml and EPUB OPF metadata, preserving everything not edited |
| `sidebar.ts` | Adds the "Uploads" link to a user's Kavita sidebar |
| `themes.ts` | Follows the user's Kavita theme: reads the theme's colour variables and maps them onto the portal's design tokens |
| `kavita.ts` | Kavita REST API client |
| `db.ts` | SQLite (Node's built-in `node:sqlite`): sessions, uploads, audit log |
| `activity.ts` | Admin Activity panel: recent audit-log entries (filters, paging) and a few counts |
| `notify.ts` | Per-user notifications (webhook / ntfy / Discord): preferences, target checks and a delivery outbox |
| `requests.ts` | Request board: users ask for titles, admins decide, and matching approvals fulfil requests |
| `backup.ts` | Daily `VACUUM INTO` snapshot of the database |
| `providers/types.ts` | The provider-adapter contract: `Provider`, `Candidate`, `FetchedRecord`, `MatchQuery`, `MediaKind` |
| `providers/registry.ts` | Which adapters exist and which are usable now (enable flag + key), and `enabledFor(media)` |
| `providers/http.ts` | The single outbound path: truthful User-Agent, timeout, retries/backoff, `Retry-After`, per-provider token bucket, response size cap, JSON parse, HTML strip |
| `providers/cache.ts` | `metadata_cache` read-through with a per-provider TTL |
| `providers/links.ts` | `provider_links`: a reviewed series -> its external id, so a repeat upload skips search |
| `providers/merge.ts` | Merge fetched records with the file/form values: per-field precedence, no silent overwrite, provenance, conflicts, validation |
| `providers/routes.ts` | Admin provider settings (list, key, enable) and diagnostics |
| `providers/stub.ts` | Built-in test-only provider (registered when `PROVIDERS_STUB=true`) |
| `setup-kavita.ts` | First-run setup used by `setup.sh` (admin, libraries, auth key) |

The browser side (`kavita-companion/web/main.js`, bundled with esbuild) uses Uppy for uploads.

## Upload to library: the data flow

1. **Upload.** The browser sends the file in 25 MB chunks with the tus protocol. Before any data is
   accepted the server checks the user (signed in, not Read Only), the file name and type, the size
   (≤ 8 GB), the chosen library, the user's limits (≤ 3 at once, ≤ 50 GB waiting) and free disk.
   Chunks land in `MEDIA_ROOT/.incoming/partial/`. A dropped connection resumes from the last byte.
2. **Check.** When complete: the real file type is read from its first bytes, a SHA-256 is compared
   against everything waiting or in the library, and failures are deleted with a reason shown to the
   uploader. Good files move to `.incoming/pending/<id>.<ext>` and are inspected (cover, pages,
   embedded metadata).
3. **Review.** Kavita admins see the queue, grouped by uploader + library + series. Defaults come from
   the file's embedded metadata, with gaps filled by Kavita's own file-name parser; warnings flag
   mismatches, duplicates in the series, missing numbers, unsafe archives.
4. **Approve** (background job, one at a time): extract → write the approved metadata (ComicInfo.xml
   for comics, OPF for EPUB) → repack (comics always become CBZ) → write as `.kc-<id>.part` in the
   series folder → rename → ask Kavita to scan that folder. Kavita shows it about a minute later.
   Failures return the upload to the queue with the reason.
5. **Reject** with a reason (shown to the uploader); the file is kept 7 days so it can be restored.

## Storage layout

```
MEDIA_ROOT/                 (default /srv/media)
  manga/ comics/ books/     Kavita libraries: one folder per series (Kavita ignores files at the root)
  .incoming/                upload staging, invisible to Kavita
    partial/                uploads in progress
    pending/                checked, waiting for review
    covers/                 cover images for the review screen
    work/                   temporary space for approvals
DATA_ROOT/                  (default ./data)
  kavita/                   Kavita's database, settings, covers, logs
  companion/companion.db    portal database (sessions, uploads, audit log)
  companion/backups/        daily snapshots of companion.db (14 kept)
  caddy/                    certificates and Caddy state
```

Staging is inside `MEDIA_ROOT` on purpose: it is the same filesystem as the libraries, so approving
even an 8 GB file is a rename, not a copy.

## Networking

- Only Caddy's ports are published. Kavita's HTTP port is bound to `DOCKER_GATEWAY`, which is reachable
  from the host but not from outside.
- Caddy accepts a PROXY protocol header only from `DOCKER_GATEWAY` and uses it when present. This lets
  a host-level TCP forwarder (such as an Incus proxy device) pass the real client IP through Docker's
  userland proxy. On ordinary hosts no header arrives and nothing changes.
- kavita-companion trusts `X-Forwarded-For` only from `DOCKER_SUBNET` (i.e. Caddy).

## Theme sync

Kavita themes are CSS files that override Kavita's CSS variables inside `:root .bg-<name> { … }`; the
built-in **Dark** theme has no file. At sign-in (password or sidebar link) the portal reads the user's
theme from their Kavita preferences and stores its id with the session. `/api/me` returns that theme's
colours mapped onto the portal's tokens (`public/style.css` lists the pairs; surfaces, borders and
focus rings are derived from the theme's text colour so any theme works). Signed-out pages use the
server's default theme. The portal keeps the user's Kavita session (encrypted) with the portal session
and re-reads the theme preference when the page asks (`/api/theme`): whenever the tab comes back into
view or gains focus, and every 30 seconds. So a theme changed in Kavita shows up as soon as the user
switches back to the portal tab.

## After approval: confirmation and fixes

- Every minute the portal checks recently approved or fixed files against Kavita: it finds the series
  whose folder holds the file and checks that Kavita lists the exact file path. Confirmed files get the
  Kavita series id (used for the "Open in Kavita" link, `/library/<libraryId>/series/<seriesId>`).
  Not listed after 3 minutes: another scan of that folder is requested. After 15 minutes: marked
  missing with a note. Files approved before this existed are checked once as well.
- **Fix** uses the same background job as approval, starting from the library file instead of the
  pending upload: the source is never modified, the new file is written as `.kc-<id>.part` beside the
  destination and renamed into place (replacing the file when the name is unchanged), then the old file
  and an emptied folder are removed and both locations are rescanned (a whole-library scan when the old
  folder is gone, so Kavita drops the old series).

## Metadata providers (phase 2)

The portal can fetch metadata from external providers and write it into a file at approval. **Off by
default**: `METADATA_EXTERNAL_ENABLED` is false and every provider is off until an admin turns it on
(Activity → Metadata sources).

- **Contract** (`providers/types.ts`): each adapter implements `search(key, query)` → candidates and
  `fetch(key, externalId)` → one `FetchedRecord` already mapped to our ComicInfo field names, with its
  licence and media. Keyedness, cache TTL and rate limit are registry metadata, not part of the
  interface, so the contract stays stable.
- **Registry** (`providers/registry.ts`): a provider is *usable* when external metadata is on, its
  enable flag is set (a `provider_config` row, or `PROVIDER_<ID>_ENABLED`) and, for a keyed provider, a
  key is present. Keys are AES-256-GCM sealed (`seal.ts`) in `provider_config`; a `PROVIDER_<ID>_KEY`
  `.env` value overrides the stored one. No key is ever returned by an API or written to logs.
- **Outbound HTTP** (`providers/http.ts`): one shared client for every provider call — a truthful
  `User-Agent` (`kavita-companion/<version> (+<PUBLIC_ORIGIN>)`), a short timeout, bounded retries with
  exponential backoff + jitter on network errors/5xx/429, `Retry-After` honoured as a cooldown, a
  per-provider token bucket, a response size cap, defensive JSON parsing and an HTML-stripping hook.
  A private/LAN base URL is refused unless `PROVIDERS_ALLOW_PRIVATE` is set.
- **Cache and links**: `metadata_cache` is a read-through cache keyed by provider + external id with a
  per-provider TTL (default 30 days); `provider_links` remembers a reviewed series' external id so a
  repeat upload skips search. Nothing is ever prefetched in bulk — a lookup is one explicit request.
- **Merge** (`providers/merge.ts`): fetched records are merged with the values the file/form already
  has. A non-empty current value is never overwritten silently (it is offered as a conflict); `force`
  accepts an explicit overwrite; `locked` fields are never proposed. Each proposed field carries its
  source provider (provenance) and is validated (Year, AgeRating, LanguageISO, length) before use.
- **Admin API** (`providers/routes.ts`, reviewer-only): `GET /api/admin/providers` lists id, label,
  licence, media, enabled/configured/hasKey; `POST /api/admin/providers` sets/clears a key and toggles
  one; `POST /api/admin/providers/:id/test` is a cheap validity probe.
  `POST /api/admin/providers/:id/preview` is a diagnostic (search → fetch → merge, or a merge-only dry
  run) used by the framework tests.

Tests: `tests/test_providers_framework.py` exercises all of the above against `tests/provider_fake.py`
(a stdlib fake) with no network and no real keys.

### Metron (comics adapter, phase 2 W2)

`providers/metron.ts` is the first real adapter; `providers/index.ts` registers it (imported by
`server.ts`), so it exists but is **off by default** — it becomes usable only when external metadata is
on, its enable flag is set *and* a bearer token is present (the registry resolves `PROVIDER_METRON_KEY`
or the sealed `provider_config` value). It declares `media: ["comic"]`, the ComicInfo fields it can
supply, `covers: "none"` (Metron's cover images are fair-use and excluded from CC BY-SA 4.0, so they are
never fetched, proxied or written) and the `CC BY-SA 4.0` licence. Base URL: `PROVIDER_METRON_BASE`
(default `https://metron.cloud`).

- **Search** (`search(key, query)`): one `GET {base}/api/issue/?series_name=<title>&number=<n>&series_year_began=<year>`
  (Metron's ranked issue list) → `Candidate[]`; `externalId` = issue id, `title` = `series.name`,
  `year` = `series.year_began`, `publisher` = `publisher.name`, `number`. Banded `exact` (series name +
  number + year), `near` (name + number) or `loose`, with a matching score.
- **Fetch** (`fetch(key, externalId)`): `GET {base}/api/issue/{id}/` → a `FetchedRecord` mapped to our
  ComicInfo names: Series/Number/Volume/Title/Summary/Year/Publisher/Imprint/Genre/Tags/LanguageISO/
  AgeRating, plus the credits→roles split (Writer/Penciller/Inker/Colorist/CoverArtist from `credits`
  role names, case-insensitive). All text goes through `plainText`. Records are read through the
  `metadata_cache` with the configured TTL (default 30 days), so a repeat fetch is one call.
- **Links**: `fetch` has no library/series context, so `linkMetronSeries(libraryId, seriesName, externalId)`
  is the helper the review flow calls on confirmation to persist a `provider_links` row.
- **Rate limit**: 20 requests/minute, so it registers `minIntervalMs: 3000` and passes the same spacing
  to the shared client; `429`/`Retry-After` are handled by `http.ts`.
- **Probe**: `POST /api/admin/providers/metron/test` fetches one known issue detail through the shared
  client. Tests: `tests/test_providers_metron.py` against `tests/provider_fake.py` (no network, no keys).
