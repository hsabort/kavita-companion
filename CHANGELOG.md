# Changelog

## Unreleased

Added:
- **Library view (phase 2, M5)**: a thin, **reviewer-only** tab over Kavita's own catalogue, for finding
  and fixing thin metadata. **Browse** searches (Kavita's own search) or lists a library, with a library
  filter and a per-series metadata signal (summary / writer / genre / year). **Needs metadata** lists
  series missing any of those key fields, with the exact fields. Each row opens the series in Kavita and,
  where the portal has a file for it, jumps into the review card or the "find an approved file to fix"
  search. Read-only and bounded: a request checks at most 50 series (one cached
  `Series/metadata` call each, cached for a minute; Refresh re-checks). Endpoints
  `GET /api/library/series` and `GET /api/library/incomplete`. Tests: `tests/test_library.py` and
  `tests/browser/library_page.py`. See [docs/architecture.md](docs/architecture.md#library-view-phase-2-m5)
  and [docs/user-guide.md](docs/user-guide.md#library-kavita-admins).

## 0.5.0 — 2026-10-16

Added:
- **Hardcover books adapter (phase 2, W6)**: Hardcover joins the provider framework as the books
  primary (ordered before Open Library). **Off by default** and keyed — it needs a free per-install
  personal access token, sent as `Authorization: Bearer`, never shipped. It searches Hardcover's
  Typesense "Book" index (GraphQL) and maps one book to Series (the featured `book_series`), Volume/
  Number (`position`), Title, Summary, Year, Writer (`contributions`, Author/Writer roles),
  Publisher/LanguageISO/PageCount (the default ebook edition), and never fetches covers. ISBN is read
  but not mapped (our field set/OPF writer has no ISBN slot yet — a documented gap). Book data from
  Hardcover. See [docs/architecture.md](docs/architecture.md#hardcover-books-primary-phase-2-w6).
- **Open Library books fallback (phase 2, W7)**: a keyless REST fallback for books; **off by default**.
  It searches `/search.json` (title or `isbn:`), fetches a work plus its first edition and resolves
  author keys to names, then maps Title, Summary (`description` object or string), Year, Writer,
  Publisher, LanguageISO (MARC `eng`→`en`) and Subjects→Genre/Tags. Open Library requires a truthful
  User-Agent (the shared client sends one) and IA asserts no new copyright; covers are never fetched.
  Book data from Open Library (Internet Archive). See
  [docs/architecture.md](docs/architecture.md#open-library-books-fallback-phase-2-w7).
- **PRH is deferred**: Penguin Random House stays an opt-in follow-up (the only source of a true
  Imprint and a real AgeRating proxy); it is not built in this change.
- Both adapters register with the same admin surface (enable/key/probe) and are covered by the fast
  tier: `tests/test_providers_hardcover.py` and `tests/test_providers_openlibrary.py` against the shared
  `tests/provider_fake.py` (no network, no real keys).

## 0.4.0 — 2026-10-16

Added:
- **MangaDex manga adapter (phase 2, W4)**: MangaDex joins the provider framework as the manga primary
  (ordered before AniList). Keyless and server-side only; **off by default**. It maps a manga's
  localized title/description, year, author → Writer, artist → Penciller, genre tags vs other tags,
  `originalLanguage` → LanguageISO and `contentRating` → AgeRating, and deliberately does **not** map
  the series-level `lastChapter`/`lastVolume` as an issue number. Its Acceptable Usage Policy requires a
  credit and forbids ads/paid use and image hotlinking, so the credit is the licence name and covers are
  never fetched. Manga data from MangaDex. See
  [docs/architecture.md](docs/architecture.md#mangadex-manga-primary-phase-2-w4).
- **AniList manga/light-novel adapter (phase 2, W5)**: a keyless GraphQL fallback for manga (and light
  novels); **off by default**. One query returns the full selection, mapped to Series (english‖romaji),
  Summary, Year, staff roles → Writer/Penciller (cross-role de-duplicated), genres, tags,
  `countryOfOrigin` → LanguageISO and the coarse `isAdult` → AgeRating. `chapters`/`volumes` are not
  mapped as an issue number. AniList's strict no-data-storage terms are respected with a short cache
  TTL. Manga/LN data from AniList. See
  [docs/architecture.md](docs/architecture.md#anilist-mangalight-novel-fallback-phase-2-w5).
- Both adapters register with the same admin surface (enable/key/probe) and are covered by the fast
  tier: `tests/test_providers_mangadex.py` and `tests/test_providers_anilist.py` against the shared
  `tests/provider_fake.py` (no network, no keys).

## 0.3.1 — 2026-10-16

Added:
- **GCD comics-fallback adapter (phase 2, W3)**: the Grand Comics Database joins Metron as the comics
  fallback (ordered by priority). Keyless; an optional free-account `user:pass` key raises the anonymous
  30/hour limit to 2,000/day and is sent as HTTP Basic. It maps GCD's free-text, `;`-separated credits
  into Writer/Penciller/Inker/Colorist/CoverArtist, strips `None`/`?` placeholders and HTML, and never
  fetches GCD's cover art. Data from the Grand Comics Database (GCD), CC BY-SA 4.0. See
  [docs/architecture.md](docs/architecture.md). A reviewer can enable it under About → Metadata providers.

## 0.3.0 — 2026-10-16

Added:
- **Metadata-provider framework (phase 2, W1)**: the portal can now talk to external metadata
  providers through one adapter contract (`src/providers/`), with a registry, a shared outbound HTTP
  client (truthful User-Agent, timeouts, retries/back-off, `Retry-After`, a per-provider rate limit and
  a response size cap), an encrypted per-provider key store (`provider_config`), a read-through
  `metadata_cache` with per-provider TTL, `provider_links`, and a field-merge step that never
  overwrites a value the file already has unless asked and reports every conflict.
  **External metadata is off by default** and there are **no provider adapters yet** (Metron etc. come
  later): only a built-in test stub. Admins manage providers via
  `GET/POST /api/admin/providers` (reviewer-only; keys are never returned). See
  [docs/architecture.md](docs/architecture.md#metadata-providers-phase-2).
- **Metron adapter (phase 2, W2)**: the first real metadata provider. Comics only; **off by default**
  and usable only once an admin enables it *and* supplies a free per-install Metron bearer token. It
  searches Metron's issue list and maps one issue to our ComicInfo fields (series/number/volume/title/
  summary/year/publisher/imprint/genre/tags/language/age rating) plus creator roles
  (Writer/Penciller/Inker/Colorist/CoverArtist), caches records with the shared TTL, and never fetches
  Metron's fair-use cover images. Data from Metron, CC BY-SA 4.0
  (<https://creativecommons.org/licenses/by-sa/4.0/>). See
  [docs/architecture.md](docs/architecture.md#metron-comics-adapter-phase-2-w2).
- **Find metadata on the review card (phase 2, W8/M1)**: a reviewer can now search the enabled
  external providers for a pending file and fill its fields, without leaving the queue.
  **Find metadata** lists ranked candidates (source, title, year, publisher, match band); picking one
  and pressing **Apply selected fields** fills the blanks by default (an explicit **Overwrite existing
  values** is opt-in), showing a per-field source chip and an *Applied from Metron (CC BY-SA 4.0)* line.
  Values the file already has are never replaced silently — they come back under *Kept your values*.
  A new **About** tab has **Metadata sources** (every provider's required credit and licence, rendered
  from the adapters so it cannot drift) and, for admins, a **Metadata providers** panel to turn a
  provider on, set or clear its key and **Test** it (keys are write-only). Reviewer-only
  `GET|POST /api/review/:id/match` and `POST /api/review/:id/apply`, cache-first, one lookup per
  action, nothing auto-applied. See
  [docs/architecture.md](docs/architecture.md#metadata-providers-phase-2) and
  [docs/user-guide.md](docs/user-guide.md).

## 0.2.8 — 2026-10-16

Added:
- **Reconnect the Kavita sidebar link** without signing in again: on the portal's **Upload** tab,
  **Add Uploads to your Kavita sidebar** (re)creates the user's own "Uploads ↗" entry — and repairs it
  if its auth key was deleted in Kavita — using the Kavita session the portal already holds for them
  (`POST /api/sidebar/connect`). See [docs/user-guide.md](docs/user-guide.md).

Documentation:
- [docs/metadata-providers.md](docs/metadata-providers.md): research into external metadata providers for
  roadmap §5 phase 2 — manga/comic/book sources and Kavita+ — with a field-coverage matrix, licensing
  notes and the open decisions (no provider integration is built).

## 0.2.7 — 2026-10-16

Added:
- **Metadata auto-fill**: when an upload's series already exists in Kavita, the review card offers
  **use Kavita's …** to fill the shared fields (year, credits, publisher, genre, tags, language) from
  that series' existing metadata. See [docs/user-guide.md](docs/user-guide.md).

## 0.2.6 — 2026-10-16

Added:
- The portal is now tabbed — **Upload**, **Review**, **Requests**, **Activity** and **Notifications** —
  showing only the tabs your Kavita role allows. The current tab is kept in the address (`#review`), so
  refresh and back/forward work, and the tab bar can be driven with the arrow keys.

Changed:
- The Kavita sidebar entry is labelled **Uploads ↗**: Kavita uses one string for both the entry's label
  and its hover tooltip and adds no icon of its own, so the arrow marks that it opens in a new tab.

## 0.2.5 — 2026-10-16

Added:
- Reviewers can **Preview** a pending comic: page through its images in the portal before approving
  (Previous/Next or the arrow keys), without downloading it. See [docs/user-guide.md](docs/user-guide.md).

## 0.2.4 — 2026-10-16

Added:
- A **Requests** board: users ask for a series or issue; Kavita admins see the open queue and can
  **Decline** or **Mark fulfilled**, and approving a matching upload fulfils the request automatically
  (and notifies the requester if they set notifications up). See [docs/user-guide.md](docs/user-guide.md).

## 0.2.3 — 2026-10-16

Added:
- **Notifications**: each user can be told — through a webhook, an ntfy topic or a Discord webhook —
  when their uploads are approved or rejected, when a file of theirs in the library is corrected, or
  when a file is discarded or found to be a duplicate. Configured under **Notifications** in the portal;
  off by default. New setting `NOTIFY_ALLOW_PRIVATE` for self-hosted LAN targets
  (see [docs/security.md](docs/security.md)). See [docs/user-guide.md](docs/user-guide.md).

## 0.2.2 — 2026-10-16

Added:
- An **Activity** panel for Kavita admins, below the review queue: recent sign-ins (and failed ones),
  uploads, approvals, rejections and fixes, with action/username filters and paging, plus cards for
  what is waiting for review and the last seven days. See [docs/user-guide.md](docs/user-guide.md).

## 0.2.1 — 2026-10-16

Added:
- Published the portal image to GitHub Container Registry (`ghcr.io/hsabort/kavita-companion`, public).
  Set `COMPANION_IMAGE` in `.env` to run a released build instead of building from source; `./setup.sh`
  pulls it. See [docs/operations.md](docs/operations.md).

## 0.2.0 — 2026-10-15

Added:
- The portal follows each user's Kavita theme (the built-in Dark theme, any theme from Kavita's catalogue,
  or an uploaded one): colours are read from the theme and applied to the whole portal, including the
  upload panel's light/dark mode. A theme changed in Kavita shows up as soon as you switch back to the
  portal's tab (the portal keeps the user's Kavita session, encrypted, to read it; new setting
  `COMPANION_SECRET`, generated by `setup.sh`).
- GPL-3.0-or-later licence, `NOTICE.md` and the font licences.
- **In Kavita ✓**: after an approval the portal checks that Kavita lists the file and links to its series
  ("Open in Kavita") for the admin and the uploader; a second scan is requested after 3 minutes and the
  file is flagged after 15 (with "Check again"). Files approved earlier were checked too.
- **Fix** for approved files: open any approved file (Recent decisions, or search), change library,
  series, numbers, title, file name or metadata, and save. The file is rewritten in the background
  (comic archives become CBZ with a clean ComicInfo.xml), moved if needed, empty series folders are
  removed and Kavita rescans both places. A failed fix leaves the library file unchanged.

Changed:
- Sign-in limits count only failed attempts (10 per account and address, 30 per address, per 15 minutes).


## 0.1.0 — 2026-10-15

First version.

**Stack**
- Kavita (linuxserver image, pinned), Caddy with Let's Encrypt (HTTP-01 on a configurable port),
  kavita-companion; one `compose.yaml`, all settings in `.env`.
- `setup.sh`: interactive or `--non-interactive` install/update; creates the Kavita admin, Manga/Comics/Books
  libraries and the portal's key on first run; safe to rerun.
- `scripts/backup.sh`, `scripts/kavita-api.py`; acceptance tests with `tests/run.sh`.
- Hardening: read-only containers, dropped capabilities, log rotation, private Docker network,
  Kavita's plain HTTP never public, PROXY protocol support for real client IPs.

**kavita-companion (upload portal)**
- Sign in with Kavita accounts; permissions from Kavita roles, re-checked every 2 minutes.
- Resumable uploads (tus/Uppy, 8 GB per file) with limits, file-type detection and duplicate checks.
- Admin review queue: covers, embedded metadata, grouped batches, file-name templates, warnings
  (series mismatch, near-miss series, number already present), approve/reject/restore, download.
- Approval writes the approved metadata into the file (ComicInfo.xml / EPUB OPF), repacks comic
  archives as CBZ, files them into the right series folder and triggers a Kavita scan.
- Kavita look and feel; "Uploads" link in each user's Kavita sidebar with automatic sign-in.
- Audit log, daily database snapshots, rate limits, CSRF protection, strict security headers.
