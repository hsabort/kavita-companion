# Tests

Acceptance tests that exercise the **running** stack described by `../.env` over its public HTTPS
address, the same way users do. They create their own uploads and clean up after themselves (including
files they approve into the library and the matching Kavita series).

## Test accounts

The tests need three Kavita accounts, created in Kavita (Settings → Users) and listed in `.env`:

| Setting | Account | Roles | Library access |
|---|---|---|---|
| `TEST_UPLOADER_USERNAME` / `_PASSWORD` | e.g. `test-uploader` | Login (default roles) | all libraries |
| `TEST_READONLY_USERNAME` / `_PASSWORD` | e.g. `test-readonly` | Login, **Read Only** | all libraries |
| `TEST_ADMIN_USERNAME` / `_PASSWORD` | e.g. `test-admin` | Login, **Admin** | all libraries |

Use long random passwords (`tests/rotate_test_admin_password.py` sets one for the admin account).
On a production server, delete these accounts and clear the `TEST_*` lines when you're done testing.

On the test environment ([docs/development.md](../docs/development.md)) create them in one step with
`python3 tests/create_test_accounts.py`, which invites the three accounts, sets their roles and library
access, and fills the `TEST_*` lines in `.env` (passwords are generated, never printed).

## Running

```bash
tests/run.sh                 # the API tests (fast + slow)
tests/run.sh --fast          # the quick tier (no library writes)
tests/run.sh --slow          # the tier that writes to the library and rescans Kavita
tests/run.sh --browser       # plus headless-browser tests (Playwright in Docker; screenshots in tests/screenshots/)
tests/run.sh --roles         # plus test_roles_and_limits.py (see below)
tests/run.sh --all           # everything
tests/run.sh --repeat 3      # run the fast tier 3 times, reporting anything that failed once
tests/run.sh --only test_review
```

A full run restarts `kavita-companion` first, which clears its in-memory failed-sign-in counters so
repeated runs don't lock the test accounts out.

Requirements on the host: `python3` (standard library only) and Docker. `test_metadata.py` builds
`.cb7` archives with the 7-Zip inside the `kavita-companion:local` image.

Shared helpers live in `tests/harness.py` (`app()`, `kavita()`, `login()`, `upload()`, `wait_until()`,
`wait_pending()`, `wait_approved()`, `check()`, `finish()`), so each test file holds only its own setup
and assertions. Three files keep genuinely bespoke helpers alongside the harness, because the harness
function does not fit what they check:

- `test_auth.py` — needs the raw response headers (`call()`), a header-based `login()` and
  `session_cookie()` for the cookie-flag, CSRF and permission checks, and drives the deliberate
  failed-login loop that trips the rate limit.
- `test_uploads.py` — steps the resumable tus protocol itself (`request()`, `tus_create/patch/head/upload()`,
  `interrupted_patch()`) to send chunks, drop a connection mid-PATCH and resume from the reported offset.
- `test_themes.py` — a cookie-jar `portal_session()` for the password and sidebar sign-in flows, where the
  harness's cached session cookie is the wrong shape.

`test_roles_and_limits.py` also keeps its own `request()`/`kavita()`/`wait_for()` helpers: it changes
test-uploader's roles and watches the live session refresh, which is outside the shared fast/slow tiers.

`test_library.py` seeds and removes one tiny series with `tests/library_fixture.py` (a one-file CBZ
with partial metadata written straight into the test comics library, then a Kavita folder scan), so the
missing-field detection is checked against real Kavita state without the slow upload flow.

| File | Covers |
|---|---|
| `test_auth.py` | Health, security headers, sign-in/out, session cookie flags, CSRF, permissions, rate limit |
| `test_uploads.py` | Resumable uploads incl. a dropped connection, refusals, type and duplicate checks, limits, ownership, withdraw |
| `test_review.py` | Review queue: permissions, suggestions, approval into new/existing series, name clashes, `../` safety, reject/restore, Kavita shows the result |
| `test_themes.py` | Theme sync: signed-out default, Dracula and Light via password sign-in, theme change via the sidebar link, an open session following changes made in Kavita (stored session encrypted), back to Dark. Temporarily installs catalogue themes and restores Kavita afterwards. |
| `test_metadata.py` | Inspection (cover, pages, embedded metadata, warnings), metadata written into CBZ/EPUB, CB7→CBZ, PDF, unsafe archives |
| `test_fix.py` | "In Kavita ✓" confirmation and links, Fix: move to another series, old series dropped by Kavita, fix in place, name clash refused, permissions, search |
| `test_activity.py` | Admin Activity panel: reviewer-only access, action/username filters, paging, insights shape and counts |
| `test_library.py` | Library view (phase 2, M5): reviewer-only browse/search and "needs metadata" queue, their envelope and pagination shapes, and missing-field detection (summary/writer/genre/year) against a real series seeded by `tests/library_fixture.py` — created with Writer+Year and no Summary/Genre, then completed in Kavita and re-checked with `refresh=1`. The fixture series is removed afterwards. |
| `test_notifications.py` | Per-user notifications: preference rules, SSRF/target validation, and webhook delivery for the test/invalid/rejected events (runs a receiver on the host) |
| `test_requests.py` | Request board: create/list/decline/fulfil, permissions, and a matching approval fulfilling a request automatically |
| `test_preview.py` | Reviewer page preview: pages served in order, bounds refused, reviewer-only |
| `test_metadata_match.py` | Metadata auto-fill: a matching Kavita series' metadata is suggested for a new upload |
| `test_providers_framework.py` | External-metadata framework (phase 2, W1): provider registry enable/disable + keyed-gating, the shared HTTP client (retry on 429/500, truthful User-Agent, size cap), sealed key round-trip + redaction, cache TTL, and merge precedence/no-overwrite. Uses `tests/provider_fake.py` (stdlib fake provider) pointed at via `PROVIDER_STUB_BASE`; no network, no real keys |
| `test_providers_metron.py` | Metron comics adapter (phase 2, W2): registration contract (CC BY-SA 4.0, comic fields, covers `none`, keyed), keyed-gating, search → candidates with band/score ordering, fetch → full ComicInfo mapping (credits → Writer/Penciller/Inker/Colorist/CoverArtist, plainText stripping), read-through record cache, and 429 + `Retry-After` / 500 retry plus an HTML body being refused. Uses `tests/provider_fake.py` via `PROVIDER_METRON_BASE`; no network, no real keys |
| `test_providers_gcd.py` | GCD comics-fallback adapter (phase 2, W3): registration contract (CC BY-SA 4.0, keyless), keyless usability, search → candidates (variants dropped, band/score), fetch → ComicInfo mapping (free-text `;`-separated credits split, placeholders dropped, `plainText` stripping), record cache, optional `user:pass` → HTTP Basic, and 429 + `Retry-After` / non-JSON refusal. Uses `tests/provider_fake.py` via `PROVIDER_GCD_BASE`; no network, no real keys |
| `test_providers_mangadex.py` | MangaDex manga-primary adapter (phase 2, W4): registration contract (MangaDex credit, manga-only, covers `none`, keyless), keyless usability, search → candidates with band/score (series-level: no issue number), fetch → ComicInfo mapping (localized `en` preference, `plainText` + credit-preamble stripping, genre vs theme/format tag split, author → Writer / artist → Penciller, `contentRating` → AgeRating, `originalLanguage` → LanguageISO, and no Number/Volume from `lastChapter`/`lastVolume`), record cache, 429 + `Retry-After` / non-JSON refusal. Uses `tests/provider_fake.py` via `PROVIDER_MANGADEX_BASE`; no network, no real keys |
| `test_providers_anilist.py` | AniList manga-fallback adapter (phase 2, W5): registration contract (AniList licence, manga-only, covers `none`, keyless), keyless usability, the GraphQL POST body (search vs by-id), search → one candidate with band/score, fetch → ComicInfo mapping (english‖romaji title, `plainText` summary, `startDate.year`, staff roles → Writer/Penciller with cross-role de-duplication, genres, ranked tags, `countryOfOrigin` → LanguageISO, `isAdult` → AgeRating in two coarse buckets, no Number/Volume from `chapters`/`volumes`), record cache, 429 + `Retry-After` / non-JSON refusal. Uses `tests/provider_fake.py` via `PROVIDER_ANILIST_BASE`; no network, no real keys |
| `test_providers_hardcover.py` | Hardcover book-primary adapter (phase 2, W6): registration contract (Hardcover licence, book-only, covers `none`, keyed), keyed-gating (no-key never called), the GraphQL POST body (Typesense Book search vs by-id `books(where:…)`) plus the `Authorization: Bearer` header, search → ranked candidates with band/score, fetch → the book mapping (featured series → Series, position → Number/Volume, `plainText` summary, contributions → Writer with roles filtered, default edition → Publisher/LanguageISO/PageCount, `eng` → `en`, nulls skipped), record cache, 429 + `Retry-After` / non-JSON refusal. Uses `tests/provider_fake.py` via `PROVIDER_HARDCOVER_BASE`; no network, no real key |
| `test_providers_openlibrary.py` | Open Library book-fallback adapter (phase 2, W7): registration contract (Open Library (Internet Archive) licence, book-only, covers `none`, keyless), keyless usability, the REST calls (`/search.json` incl. `q=isbn:…`, `/isbn/{isbn}.json`, `/books/{olid}.json`, `/works/{id}.json`, `/works/{id}/editions.json`, `/authors/{id}.json`), search → ranked candidates with band/score, fetch → the book mapping (description object → `plainText` summary, `first_publish_date` year, author keys → Writer, edition `publishers`, MARC `eng` → `en`, subjects → Genre/Tags heuristic), fetch by work id and by ISBN, record cache, 429 + `Retry-After` / non-JSON refusal. Uses `tests/provider_fake.py` via `PROVIDER_OPENLIBRARY_BASE`; no network, no keys |
| `test_providers_match.py` | Review-card metadata (phase 2, W8): access control + CSRF for `/match` and `/apply`, the About metadata-sources credit, `/match` from the upload's parsed defaults, and `/apply` merge rules — fill blanks, conflicts instead of silent overwrites, explicit overwrite, the field allow-list, cache-first fetch. Uses `tests/provider_fake.py` via `PROVIDER_METRON_BASE`; the pending upload is withdrawn, no library writes |
| `test_sidebar_label.py` | The Kavita sidebar entry is named `Uploads ↗` (creates/repairs it on sign-in) |
| `test_sidebar_connect.py` | `POST /api/sidebar/connect` reconnects a signed-in uploader's sidebar entry from their stored Kavita session (signed-out 401, Read Only 403, the entry comes back) |
| `test_roles_and_limits.py` | Role changes in Kavita reach open sessions; general rate limit. **Changes test-uploader's roles for ~5 minutes** and therefore refuses to run if a real person signed in within the last hour or uploaded in the last 30 minutes (`--force` overrides). |
| `browser/upload_page.py` | The upload page on desktop and phone sizes, no console errors; the sidebar-reconnect button reports an outcome |
| `browser/review_page.py` | The review screen, cover, destination preview, approval |
| `browser/fix_page.py` | Recent decisions shows "In Kavita ✓", the link opens the right Kavita series page, Fix… editor saves |
| `browser/kavita_integration.py` | Sign in to Kavita, click **Uploads** in its sidebar, land in the portal signed in; password sign-in adds the sidebar link |
| `browser/activity_page.py` | The admin Activity panel renders (cards + entries) and is hidden from non-admins |
| `browser/library_page.py` | The reviewer-only Library tab (phase 2, M5): Browse/Needs-metadata sub-views, the library filter and search controls (empty state for no match), phone layout and no console errors; hidden from non-admins |
| `browser/notifications_page.py` | The Notifications panel is shown to uploaders (save works) and hidden from read-only accounts |
| `browser/requests_page.py` | A user asks for a title; a reviewer sees it in the open queue and declines it |
| `browser/suggestion_card.py` | The review card's **Find metadata** flow (phase 2, W8): the turned-off state, enabling Metron + key + Test on the About panel, candidates → apply → filled fields + source chips + *Applied from Metron (CC BY-SA 4.0)*, responsive on phone. `tests/run.sh` starts `tests/provider_fake.py` on the host for the browser tier (the portal reaches it through the Docker gateway); the upload is withdrawn and Metron left off |

`settings.py` reads `.env`; library ids are looked up by name (Manga, Comics, Books).

**Sign-in limits:** a full run makes about 12 deliberately failed sign-ins (to test the limits), and the
portal allows 30 failed sign-ins per address per 15 minutes. Running the full suite more than twice in
15 minutes from the same host therefore locks that host out of signing in until the window passes
(or `docker compose restart kavita-companion`, which clears the in-memory counters).
