# Changelog

## 0.9.0 — 2026-10-18

Changed:
- **The default image is now permissive.** The published default (`:X.Y.Z`, and what `:latest` means)
  no longer bundles the GPL/LGPL tools. 7-Zip (LGPL) and KindleUnpack (GPL-3.0-only) move to an
  optional `-formats` image (`:X.Y.Z-formats`), which is a combined work and is never tagged `latest`;
  the default image is `Apache-2.0 AND OFL-1.1` on its own. Zip reading no longer shells out to 7-Zip:
  `.zip`, `.cbz`, `.epub` and a mislabelled `.cbr`/`.cb7` whose bytes are really a zip are read
  in-process, and `.pdf` is unaffected — all of them keep working on either image.
- **What the default image gives up.** Reading `.rar`/`.cbr`(rar)/`.7z`/`.cb7`, and converting
  `.mobi`/`.azw`/`.azw3` to EPUB, now need the `-formats` image. There is no permissive RAR or MOBI
  reader, so those formats genuinely cannot be reimplemented; the `-formats` image carries them.
- **A file the default image cannot handle is refused with the image that can.** The refusal names the
  `-formats` tag for the running release (`ghcr.io/hsabort/kavita-companion:0.9.0-formats`), and is
  surfaced on upload (the row ends `invalid` with that reason), on the page preview (415) and on Fix —
  never a generic error or a silent failure. The health endpoint reports the capability set, and
  Fix/Approve is disabled for an item whose format needs an absent capability.
- **The images now ship their licences.** `LICENSE`, `NOTICE.md` and the fonts' OFL texts are copied
  into the default image, whose `org.opencontainers.image.licenses` label reads `Apache-2.0 AND
  OFL-1.1` because it contains nothing non-permissive. The `-formats` image additionally carries
  7-Zip's and KindleUnpack's licence texts — plus the `loguru` MIT text KindleUnpack's wheel omits,
  fetched at build time pinned by URL and SHA-256 — and its label reads `Apache-2.0 AND OFL-1.1 AND
  GPL-3.0-only AND LGPL-2.1-or-later`. The Docker build context is now the repository root, so the
  licence files have a single source of truth.
- **Relicensed to Apache-2.0.** The repository was GPL-3.0-or-later; it is now the Apache License 2.0,
  Copyright 2026 James VanTassel (`LICENSE`, `NOTICE.md`, `README.md`, `package.json`). Copies
  distributed earlier keep their GPL-3.0-or-later rights — a licence change cannot withdraw them. New
  contributions need a `Signed-off-by` sign-off; see the new `CONTRIBUTING.md`.
- **A dependency licence gate runs in CI.** `npm run licences` fails on any GPL, AGPL, LGPL or
  undeclared dependency.
- **The portal's mark is our own.** The logo and favicon were Kavita assets (GPL-3.0); they are
  replaced by an original mark (`public/assets/img/logo.svg`, `favicon.svg`).
- **Clean-room remediation.** Removed the vendored Kavita OpenAPI description
  (`docs/reference/`), the Kavita-source citations in `public/style.css`, `docs/kavita-api.md` and
  `docs/research/R4-kavita-native.md`, and the hardcoded fallback palette in `src/themes.ts` that had
  been read out of Kavita's source. Theme variables a theme does not define now fall back to the
  portal's own stylesheet defaults. The rules are documented in `docs/clean-room.md`.

Fixed:
- **Archive handling is hardened on the in-process zip path.** The shared checks — no absolute paths,
  no `..` components, no links, an entry cap, a total-size cap and a post-extraction tree check — are
  now enforced and tested on the zip reader too, not only the 7-Zip path, with adversarial fixtures
  (absolute path, `..`, symlink, entry flood, zip bomb, encrypted archive).

Migrating:
- **A deployment that needs `.rar`/`.cb7`/`.7z` or MOBI/AZW/AZW3 must switch before upgrading.** Move
  it to the formats image with `COMPANION_IMAGE=ghcr.io/hsabort/kavita-companion:0.9.0-formats`, or,
  building from source, `COMPANION_BUILD_TARGET=runtime-formats`; otherwise those formats are refused
  after the upgrade (see `docs/operations.md`).

## 0.8.1 — 2026-10-18

Fixed:
- **An approved book is always readable by Kavita.** Kavita's EPUB reader (VersOne) is stricter than
  the portal's, and calibre/mobiunpack output trips it two ways: an OPF `<guide>` whose `<reference>`
  items have no `href` ("Incorrect EPUB guide: item href is missing") and a bare `&` in the NCX
  ("TOC file is not a valid XML file"). Either one left the book on disk but invisible to Kavita. The
  approve step now drops the guide and escapes bare ampersands in the OPF and NCX before repacking,
  so the stored file always parses (`test_epub_repair.py`).

## 0.8.0 — 2026-10-17

Added:
- **Names are cleaned before they reach the library.** A new `cleanName()` drops release/scene tags
  (`(2020) (Digital) (Zone-Empire)`, `(LuCaZ)`, `(-KS-)`), bare years and year ranges, and orphan
  brackets (`(Dungeon Delver` becomes `Dungeon Delver`), then collapses whitespace. It is
  applied to a comic/manga's series folder and file name at approval, and to the series the review
  card suggests.
- **A book's title is tidied too.** `cleanBookTitle()` drops a repeated series prefix
  (`Dungeon Delver: A LitRPG/Gamelit Adventure` -> `A LitRPG/Gamelit Adventure`) and a trailing
  series blurb (`The Gate of the Silver Gods: Dungeon Delver Book 4` ->
  `The Gate of the Silver Gods`). A title with no series (`Vermilion: Requiem`) is left alone. The
  portal's destination preview uses the same rules, so it matches what the server writes.
- **Two round-trip traps are closed.** A standalone book no longer gets its author written as
  `calibre:series` (so re-uploading its own file cannot turn it into a series book), and an embedded
  series that merely repeats the author is ignored. A series that already names the volume
  (`Ironclad v1`) no longer produces a doubled volume (`Ironclad v1 v01 #001.cbz` -> `Ironclad v1 #001.cbz`).
- **A `Vol.` trade no longer suggests an issue number.** Kavita sometimes reads one out of the
  subtitle (`… Midnight Part 01`), which would become a spurious `#001`; a file with an explicit
  `Vol.` marker and a volume now suggests the volume alone (the reviewer can still type a number).

Changed:
- **The test suite refuses to run against the live library.** `tests/settings.py` — imported by every
  test, and checked by `tests/run.sh` before it restarts anything — aborts unless the `.env` sets
  `TEST_STACK=1` and its media root is not the live `/srv/media`. A live `.env` has neither, so a stray
  `tests/run.sh` in the production checkout stops with a clear message instead of uploading into,
  renaming or deleting real files.
- **The image workflow scans before it publishes.** `.github/workflows/image.yml` now builds into the
  local Docker store, runs Trivy, and only pushes to GHCR once the HIGH/CRITICAL gate passes, so a
  flagged image is never published.
- **The runtime image no longer ships pip, setuptools or the npm CLI.** The KindleUnpack venv keeps only
  what `mobi` uses at runtime, and npm is dropped after `npm ci`; this clears the HIGH advisories Trivy
  found in those packages' vendored dependencies (and shrinks the image), so the gate passes.

Fixed:
- **A standalone book's "Fix" form no longer turns its author into a series.** Fixing a standalone
  book (whose folder is the author) seeded `Series` from that folder, so re-saving it produced
  `<Author> - <Title>` and sometimes a spurious number. The Fix form now uses the same defaults as the
  review card, so the author-as-series guard and the file-name title fallback apply.

## 0.7.0 — 2026-10-17

Added:
- **Books identify from their file name and embedded metadata, title-first.** A bare or oddly-named
  EPUB now yields a real Title instead of a mangled series: `Cross-Fire.epub` is the title `Cross-Fire`
  (not series `Cross`), `Ashfall 01 - The Cinder Throne.epub` splits into Series/Number/Title, and
  `Author - Title` keeps the title clean and supplies the author. Embedded metadata still wins over
  the guess, and everything stays editable.
- **Canonical book names.** An approved book is written as **`<Series> #<n> - <Title>.epub`**; a
  standalone book as **`<Title>.epub`** in the author's folder (else the title's). A standalone book
  no longer needs an invented series to be approved.
- **A book is renamed to that canonical name before it reaches a reviewer**, and the review card
  shows the renamed file (with the original upload name beside it).

Changed:
- **"Find metadata" searches books by Title**, with the series used only as a ranking hint (Hardcover's
  featured series breaks a tie between equally-scored title matches). Comics and manga are unchanged.
  Editing a book's Series field re-runs the search with that hint.

## 0.6.9 — 2026-10-16

Added:
- **Kindle books (`.mobi`/`.azw`/`.azw3`) can be uploaded to a Books library.** Kavita reads EPUB and PDF
  only, so on upload the portal converts a Kindle ebook to EPUB with **KindleUnpack** and hands the EPUB
  to the normal review flow — nothing else about review or approval changes. Conversion runs in the
  portal image (Python + the `mobi` package, GPL-3.0; see `NOTICE.md`): KF8 books come out as a finished
  EPUB, MOBI6 books are assembled from KindleUnpack's HTML tree. **DRM-protected or unreadable files are
  refused with a clear reason** — DRM is never stripped. Kindle formats are accepted only in a Books
  library (415 elsewhere).

## 0.6.8 — 2026-10-16

Changed:
- **"Find metadata" is now a focused modal dialog** instead of an inline panel inside the review card:
  candidates, per-field source chips, conflicts, attribution/licence and a "N fields will change"
  summary, with an explicit Apply (and a note in fix mode). It closes on Escape/Close/click-outside,
  keeps focus inside the dialog and returns it to the trigger, and fits a phone. Applied values still
  flow through the same card / `reviewDrafts` path, so nothing else changed.
- **A long provider rate-limit is skipped, not slept through.** The token bucket now refuses to hold an
  HTTP request for a wait over 3 s: it records a cooldown and reports it ("rate-limited — try again in
  ~N min") to the match list and the apply route instead of blocking. Short intervals (MangaDex 250 ms,
  AniList 2 s, …) still wait exactly as before. Removes the hang with GCD's 120 s anonymous spacing.

Fixed:
- **A valid EPUB is no longer discarded as "a zip file".** The upload check required the spec's exact
  canonical layout (a stored `mimetype` entry first); real EPUBs that differ — an extra field on that
  entry, a deflated member, or a different first entry — were misread as plain zips and thrown away. It
  now falls back to the archive's required `META-INF/container.xml`, matching what Kavita can read. (A
  plain zip renamed `.epub` is still rejected.) Regression test added.
- **Comics are Kavita LibraryType 5**, so the 0.6.6 "never offer a comic a Volume" filter now actually
  fires (it compared against 1 and never matched). The write path already dropped the tag, so no file
  was harmed, but the apply panel no longer offers a Volume for comics. Regression test added.

## 0.6.7 — 2026-10-16

Changed:
- **GCD's optional account key is manageable in the portal.** GCD is keyless, so it was registered as
  "no key needed" and the About → Metadata providers panel hid the key field even once one was saved.
  A new `optionalKey` registration flag makes the panel offer Save/Clear and show "Has key" for GCD, and
  the admin API now reports `hasKey` for any provider that has one. GCD's key is a free comics.org
  account's `user:pass`, sent as HTTP Basic (raises its limit from 30/hour to 2,000/day).

## 0.6.6 — 2026-10-16

Fixed:
- **Applying provider metadata could make a comic vanish from Kavita.** Kavita treats a comic whose
  ComicInfo carries a `<Volume>` that the folder doesn't encode as a *different series*; a folder scan
  can't create that series, so it silently drops the file and removes its chapters. The comic write path
  now never emits `<Volume>` and clears any that an older write left behind, and a comic no longer offers
  one in the apply panel (Kavita derives volume from the folder/filename). Found when fixing Starfall
  #076/#077 on the live server; regression tests added to `tests/test_fix.py`.

## 0.6.5 — 2026-10-16

Fixed:
- **Reviewer edits and applied metadata are no longer lost on a re-render.** The review form lived
  only in the DOM, so switching tabs (or pressing Refresh) rebuilt the cards from server defaults and
  silently discarded anything typed or applied before Approve — an applied Metron suggestion could
  reach approval as just `Number`/`Series`. In-progress values are now kept in a per-upload draft and
  restored on re-render, then cleared once a decision is made (browser regression added).

## 0.6.4 — 2026-10-16

Fixed:
- **AniList** (found by a real-API smoke test, follow-up to 0.6.3): the staff selection used
  `node { name }`, but AniList's `Staff.name` is an object, so the query still errored. It is now
  `node { name { full } }` and the adapter reads `name.full`, so AniList Writer/Penciller populate.

## 0.6.3 — 2026-10-16

Fixed:
- **AniList** (found by a real-API smoke test): the GraphQL selection used `staff(edges { … })`, which
  AniList rejects as a syntax error, so every AniList request failed. Corrected to `staff { edges { … } }`.
- **Open Library probe**: Open Library rejects a bare common word as a search ("Invalid query; … not
  allowed: the"), so the admin **Test** button wrongly reported it unreachable. The probe now uses a
  query OL accepts (the adapter's real search was always fine).

## 0.6.2 — 2026-10-16

Fixed:
- **Metron credits** (found by a real-API smoke test): real Metron sends each credit's `creator` as a
  **name string** and its `role` as an **array**, and uses the role name **Artist** for interior art.
  The adapter read `creator` as an object and didn't map `Artist`, so Writer/Penciller/Inker/Colorist/
  CoverArtist came back empty. Fixed, with the test fixture corrected to Metron's real shape.
- **Forced refresh** now truly bypasses a provider's own record cache (it previously bypassed only the
  route's), so a refresh re-fetches from the provider.

## 0.6.1 — 2026-10-16

Compliance polish and verification (phase 2, M6) — no new features, no version bump.

- **No-bulk / per-review safeguard, now tested.** `tests/test_providers_safeguard.py` (fast tier) proves
  that one reviewer **Find metadata** action makes at most one search per enabled provider (candidates
  bounded at 8, and no pre-fetch), that a **Library** browse or "needs metadata" queue makes **no**
  external provider call at all, and that nothing is fetched in the background. The invariant is stated
  in code where a bulk path could appear (`src/review.ts` `matchFor`, `src/library.ts`,
  `src/providers/routes.ts`).
- **Key handling.** Documented the policy (sealed at rest with AES-256-GCM, write-only in the UI, never
  returned by a route, never logged) in the new [docs/compliance.md](docs/compliance.md) and
  [docs/security.md](docs/security.md); the request-log URL redactor now also strips `key`, `token`,
  `api_key` and `access_token` query parameters defensively.
- **Attribution / licence wording.** Tightened the licence labels for MangaDex, AniList, Hardcover and
  Open Library so the composed credit no longer repeats the provider name (e.g. *Book data from
  Hardcover, API Terms*); Metron/GCD keep their exact CC BY-SA 4.0 credits. A framework test now asserts
  every registered provider surfaces a licence name + URL, an attribution credit that names it.
- **Docs.** Added [docs/compliance.md](docs/compliance.md) (per-provider obligations, CC BY-SA ShareAlike
  scope, no-bulk rule, caching policy, key handling, allow/opt-in/exclude defaults, and a "not legal
  advice" note); updated [docs/user-guide.md](docs/user-guide.md),
  [docs/operations.md](docs/operations.md) and [docs/security.md](docs/security.md). Reconciled
  `docs/roadmap-phase2.md` with the agreed decisions (Kavita+ delegation out of scope; ComicVine and
  Google Books excluded; PRH deferred; no legal pass required to ship).

## 0.6.0 — 2026-10-16

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
