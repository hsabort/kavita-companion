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
| `providers/attribution.ts` | The required credit for a provider, composed from its adapter metadata (label + licence) so it cannot drift |
| `providers/routes.ts` | Admin provider settings (list, key, enable), diagnostics, and the About → Metadata sources list |
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
- **Reviewer flow (W8)** (`review.ts`, reviewer-only, CSRF via the global Origin hook):
  `GET|POST /api/review/:id/match` searches the providers enabled for the upload's media (from its
  library type) using the card's current series/number/year, falling back to the upload's parsed
  defaults; it returns ranked `candidates[]` (each with its source label, attribution and licence) plus
  a `providers[]` list marking disabled/no-key/cooldown/error/off-media so a blank result is
  explainable. `POST /api/review/:id/apply` body `{ provider, externalId, mode: "fill"|"overwrite",
  fields?, current?, locked?, refresh? }` fetches the confirmed candidate (cache-first) and merges it
  onto the card's current values with the W1 merge rules: `fill` proposes only blanks (existing values
  come back as `conflicts[]`), `overwrite` replaces exactly the selected `fields`. It returns
  `{ fields, provenance, conflicts, attribution, licence, cached }` and never writes to disk — the
  reviewer's final form values are what `/approve` writes.
- **Attribution** (`providers/attribution.ts`): the credit shown on the card and on
  **About → Metadata sources** is composed from the adapter's own label + licence
  (`"Comic data from Metron, CC BY-SA 4.0"`), and `GET /api/metadata-sources` (any signed-in user) lists
  every provider's credit and licence URL, so a licence change cannot silently drop the attribution.
  Reviewers also get a **Metadata providers** panel on About to turn a provider on, set/clear its key
  and run the probe; keys are write-only and never rendered back.

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

### Grand Comics Database (GCD) (comics fallback, phase 2 W3)

`providers/gcd.ts` is the comics **fallback**: `providers/index.ts` registers it with `priority: 20`
(Metron is `10`), so `enabledFor("comic")` is tried primary-then-fallback. It is **off by default** and
**keyless** — enabling it is enough; an optional free-account key of the form `user:pass` is sent as
HTTP Basic and raises GCD's anonymous 30 requests/hour to 2,000/day. Licence `CC BY-SA 4.0`;
`covers: "none"` (GCD cover art belongs to the rights holders, never fetched/proxied/written). Base:
`PROVIDER_GCD_BASE` (default `https://www.comics.org`).

- **Search** (`search(key, query)`): `GET {base}/api/series/name/<name>/issue/<n>/[year/<y>/]` (an issue
  number is required — without one GCD can't return fetchable issues) → `Candidate[]`; alternate-cover
  variants (`variant_of`) are dropped; bands/scores as for Metron.
- **Fetch** (`fetch(key, externalId)`): `GET {base}/api/issue/{id}/` → Series (`series_name`, minus the
  "(2012 series)" disambiguator), Number, Volume, Title (first interior story), Summary (joined
  synopses), Year (`key_date`), Publisher (`indicia_publisher`), Imprint (`brand_emblem`), Genre/Tags
  (aggregated from `story_set[]`), AgeRating (mapped onto our list), and the credits split from GCD's
  **free-text**, `;`-separated `script`/`pencils`/`inks`/`colors` (dropping `None`/`?` placeholders;
  the cover story gives CoverArtist). All text via `plainText`; records read through `metadata_cache`.
- **Rate limit**: anonymous 30/hour → `minIntervalMs: 120000`; with a key the adapter narrows it
  (`PROVIDER_GCD_MIN_INTERVAL_MS[_AUTHED]`). `429`/`Retry-After` handled by `http.ts`.
- **Probe**: `POST /api/admin/providers/gcd/test`. Tests: `tests/test_providers_gcd.py`.

### MangaDex (manga primary, phase 2 W4)

`providers/mangadex.ts` is the manga **primary**: `providers/index.ts` registers it with `priority: 10`
(AniList is `20`), so `enabledFor("manga")` is tried primary-then-fallback. It is **off by default** and
**keyless** — enabling it is enough. MangaDex's Acceptable Usage Policy requires a **credit**, forbids
using the data for ads/paid services, forbids hotlinking images, and requires a truthful User-Agent and
**server-side** calls (the API has no third-party CORS, so the browser never calls it). The adapter
therefore declares the credit as its licence name, `covers: "none"` (no image is ever fetched, proxied
or written) and the shared UA. Base: `PROVIDER_MANGADEX_BASE` (default `https://api.mangadex.org`).

- **Search** (`search(key, query)`): `GET {base}/manga?title=<title>&limit=8&order[relevance]=desc` →
  `Candidate[]`; `externalId` = manga id, `title` = the localized title (preferring `en`), `year`.
  MangaDex is **series-level**: it carries no issue number, so a caller's chapter number is not a
  discriminating signal and candidates are banded on the series title + year only (`exact` when both
  agree, `near` on a title match, else `loose`).
- **Fetch** (`fetch(key, externalId)`): `GET {base}/manga/{id}?includes[]=author&includes[]=artist&includes[]=cover_art`
  → a `FetchedRecord` mapped to our ComicInfo names: Series (localized title, prefer `en`), Summary
  (`description`, prefer `en`, through `plainText` with the common credit/support preamble dropped),
  Year (`year`), Writer (the `author` relationships), Penciller (the `artist` relationships), Genre
  (tags whose `attributes.group` is `"genre"`), Tags (every other tag group), LanguageISO
  (`originalLanguage`, only when it looks like a code) and AgeRating (`contentRating` →
  `safe`=Everyone / `suggestive`=Teen / `erotica`=Mature 17+ / `pornographic`=Adults Only 18+).
  `lastChapter`/`lastVolume` are optional series-wide counts and are deliberately **not** mapped to
  Number/Volume. All text goes through `plainText`; records are read through `metadata_cache` with the
  configured TTL (default 7 days for MangaDex).
- **Rate limit**: ~5 requests/s per IP → `minIntervalMs: 250` (`PROVIDER_MANGADEX_MIN_INTERVAL_MS`);
  `429`/`Retry-After` handled by `http.ts`.
- **Probe**: `POST /api/admin/providers/mangadex/test` (one small manga list). Tests:
  `tests/test_providers_mangadex.py`.

### AniList (manga/light-novel fallback, phase 2 W5)

`providers/anilist.ts` is the manga **fallback**: registered with `priority: 20`, so it is tried after
MangaDex. It is **off by default** and **keyless** — reads need no auth (OAuth is only for
private/mutations, which we never do). AniList's terms are the strictest of the providers: the API must
not be used as a backup/data-storage service and bulk hoarding is forbidden, so lookups stay
per-review and the read-through cache TTL is deliberately **short** (default 3 days). Licence `AniList`
(<https://docs.anilist.co/>), `covers: "none"`. Base: `PROVIDER_ANILIST_BASE` (default
`https://graphql.anilist.co`).

- **Query**: one GraphQL selection is used for both steps — `Media(search:…)` for a search and
  `Media(id:…)` for a fetch, requesting `id title{romaji english native} synonyms
  description(asHtml:false) startDate{year} genres tags{name rank category} staff(edges{role node{name}})
  isAdult countryOfOrigin chapters volumes format`. It is a `POST` with a JSON body; a GraphQL
  `errors[]` in a 200 body is turned into a typed provider error.
- **Search** (`search(key, query)`): at most one candidate (AniList returns a single best match),
  banded/scored on the title (english, else romaji) and `startDate.year` exactly as MangaDex.
- **Fetch** (`fetch(key, externalId)`): by integer media id → Series (english, else romaji, else
  native), Summary (`description`), Year (`startDate.year`, only a four-digit value), Writer (staff
  roles matching `story|writer`, de-duplicated), Penciller (roles matching `art|illustration|pencil`,
  de-duplicated — a "Story & Art" credit appears in both buckets but never twice in one), Genre
  (`genres`), Tags (`tags[].name`), LanguageISO (`countryOfOrigin` mapped: JP→ja, KR→ko, CN→zh,
  TW→zh-tw, HK→zh-hk) and AgeRating from the coarse `isAdult` boolean (`true`=Mature 17+,
  `false`=Everyone — we never invent finer granularity). `chapters`/`volumes` are frequently null and
  series-level, so they are **not** mapped to Number/Volume.
- **Rate limit**: 90/min documented but currently degraded to 30/min → `minIntervalMs: 2000`
  (`PROVIDER_ANILIST_MIN_INTERVAL_MS`); `429`/`Retry-After` handled by `http.ts`.
- **Probe**: `POST /api/admin/providers/anilist/test` (one minimal search). Tests:
  `tests/test_providers_anilist.py`.
