# Roadmap

Planned features for kavita-companion, in the spirit of the existing design (see
[decisions.md](decisions.md)): extend what Kavita users can do, keep every file reviewed before it
reaches readers, reuse Kavita's accounts and API, and match Kavita's look. This is a design document —
nothing here is built yet.

Each feature below lists what it adds, how it works, the data it needs, the Kavita API it calls, the UI,
security notes and the tests it needs. New settings go in `.env` → `compose.yaml` → `src/config.ts`; new
columns/tables go in `src/db.ts` with the `PRAGMA table_info` migration; every user-visible change gets a
`CHANGELOG.md` entry and relevant doc updates. Features ship on a branch in `/srv/kavita-test`, pass
`tests/run.sh --browser --roles`, merge to `main`, and are published to GHCR on the next version tag
([development.md](development.md)).

Status key: **planned** (specced here) · **idea** (raised, not specced).

---

## 1. Notifications — built

Shipped in 0.2.3: per-user webhook / ntfy / Discord notifications for approved, rejected, fixed,
invalid and duplicate events (`src/notify.ts`), with an outbox worker and an SSRF-guarded target check.
Email (Kavita's SMTP) remains a later step. Tests in `tests/test_notifications.py`.

**Goal.** Tell uploaders what happened to their upload (approved, rejected, fixed, or discarded as
invalid/duplicate) instead of making them re-open the portal. Optionally tell reviewers that something
new is waiting.

**How it works.**
- The events already exist as `audit()` calls in `src/review.ts` and `src/uploads.ts`
  (`upload_approved`, `upload_rejected`, `upload_fixed`, `upload_invalid`, `upload_duplicate`,
  `upload_started`). A notifier subscribes at those points rather than duplicating logic.
- Delivery is asynchronous and best-effort: rows go into an **outbox** table; a small worker (the
  existing hourly/minute job loop in `src/server.ts`) drains it with retries and a timeout. Approval
  never waits on, or fails because of, a notification.
- Channels, in order of effort:
  1. **Webhook** — `POST` a JSON body to a user-supplied URL (no new dependency; `fetch`).
  2. **ntfy** — `POST` to a topic URL (`https://ntfy.sh/<topic>` or self-hosted). Same code path as a
     webhook with a different body.
  3. **Discord** — a webhook whose body is `{"content": "..."}`.
  4. **Email** — reuse **Kavita's own SMTP** settings, read with the portal's admin key from
     `GET /api/Settings → smtpConfig` (`senderAddress`, `host`, `port`, `userName`, `password`,
     `enableSsl`). Needs a mail library (`nodemailer`); Phase 2, so Phase 1 ships without it.

**Data.** New tables in `src/db.ts`:
- `notification_prefs (user_id PK, events TEXT, channel TEXT, target TEXT, enabled INTEGER, updated_at)` —
  per Kavita user. There is no admin endpoint for another user's preferences
  ([kavita-api.md](kavita-api.md)), so this is owned by the portal, not Kavita.
- `notifications (id PK, user_id, event, payload TEXT, created_at, attempts, delivered_at, last_error)` —
  the outbox, for retries and to avoid duplicates.

**UI.** A small "Notifications" panel in the portal's account area: on/off, channel, target, and which
events. Admins get an extra option to be told about new uploads.

**Kavita API.** `GET /api/Settings` (admin key) for SMTP only.

**Security.** Targets are user-supplied URLs and are called server-side, so this is an SSRF risk:
accept `https://` only, refuse loopback/link-local/private ranges by default, cap response size, short
timeouts, and log failures to `audit_log`. Notification payloads contain only the user's own file names
and statuses — never secrets or other users' data.

**Tests.** `tests/test_notifications.py` stands up a tiny local HTTP receiver, sets a webhook pref,
uploads and approves a file, and asserts delivery of the right event; checks opt-out and that a bad
target never blocks approval.

**Effort.** M (Phase 1 webhook/ntfy/Discord); +S to add email.

---

## 2. Requests board — built

Shipped in 0.2.4: a Requests board (`src/requests.ts`) where users ask for a series/issue and admins
decline or fulfil; a matching approval fulfils a request automatically and notifies the requester.
Tests in `tests/test_requests.py`.

**Goal.** Let users ask for a series or issue they can't upload themselves; let admins see and fulfil
requests; automatically mark a request fulfilled when a matching upload is approved.

**How it works.**
- Users create a request (series name, optional number/volume, library, a short note). Requests are
  plain text, length-limited and rate-limited.
- When an upload is approved, a matching function compares (library, normalized series name, number)
  against open requests; on a match the request becomes `fulfilled`, linked to the upload, and — if
  Notifications (§1) is on — the requester is told.
- Optional tie-in to Kavita **Want to Read**: show whether the series already exists and is wanted
  (`GET /api/want-to-read?seriesId=`, `POST /api/want-to-read/v2` lists a user's wanted series), so the
  board can suggest existing series and avoid duplicate asks.
- Admin aid: `GET /api/Series/next-expected?seriesId=` gives the next expected issue of a series, which
  the board can surface as "Series X is waiting for #n" suggestions. *(Missing-issue detection; idea
  raised alongside.)*

**Data.** `requests (id PK, user_id, username, title, series_name, number, library_id, note, status
[open|fulfilled|declined], created_at, decided_by, decided_at, fulfilled_upload_id)`.

**UI.** A **Requests** area: for everyone, "Ask for a title" + "My requests"; for reviewers, a list with
Decline and a link to the fulfilled upload. Matches Kavita's design tokens.

**Kavita API.** `GET /api/want-to-read`, `POST /api/want-to-read/v2`, `GET /api/Series/next-expected`
(all optional/first pass can be portal-only).

**Security.** Only the requester sees their own requests; only reviewers see all. Escape notes as text
(never HTML), cap length, rate-limit.

**Tests.** `tests/test_requests.py`: create/list/decline; permissions; auto-fulfil on a matching
approval; no match leaves it open.

**Effort.** M.

---

## 3. Reviewer preview — built

Shipped in 0.2.5: a reviewer can page through a pending comic before approving (page entry names are
recorded at inspection; `GET /api/review/:id/page/:n` serves one page through the existing safe-archive
path). Tests in `tests/test_preview.py` and `tests/browser/review_page.py`.

**Goal.** Let a reviewer page through a pending file before approving it (today only the cover is shown),
and optionally choose the cover.

**How it works.**
- Page list: `src/inspect.ts` already opens each pending upload once (cover, page count, metadata).
  Extend it to record the ordered image entry names in the `inspection` JSON (comics) — no per-page
  extraction at inspection time.
- On demand, a new reviewer-only route streams one page: `GET /api/review/:id/page/:n`. It extracts that
  single entry with the same safe-archive path used today (`src/archive.ts`, after the listing checks:
  no absolute paths / `..` / links, entry-count and expanded-size limits), caches it under
  `.incoming/work`, and serves it with the correct content type. Cache entries expire with the upload.
- The browser (`web/main.js`) shows a lightbox/thumbnail strip on the review card using the existing
  Kavita-tile look. Content-Security-Policy already allows `img-src 'self' blob: data:`.
- **Cover choice** (Phase 2): Kavita's cover is the first image, so choosing a different cover means
  reordering the archive at repack time — one extra field (`cover_page`) and a reorder step in the
  approval job. Phase 1 is read-only paging.
- Formats: comic archives first (`.cbz/.cbr/.cb7/.zip/.rar/.7z`). EPUB/PDF preview is a later step
  (EPUB needs XHTML rendering; PDF needs a renderer) — out of scope for Phase 1.

**Data.** Reuse `inspection` (add `pageNames`); add `cover_page` (INTEGER) when Phase 2 lands.

**Kavita API.** None (files are staged, not yet in Kavita).

**Security.** Reviewer-only; entry names come only from a validated archive listing (never a request
path); per-page size cap; no caching of other users' files.

**Tests.** Extend `tests/test_review.py` / `tests/browser/review_page.py`: fetch page 1 and a middle page,
assert image bytes and content type; assert a non-reviewer gets 403 and a `../` entry is refused.

**Effort.** M (Phase 1).

---

## 4. Admin activity page — built

Shipped in 0.2.2: a reviewer-only **Activity** panel (`src/activity.ts`, `GET /api/admin/activity` and
`GET /api/admin/insights`) with recent audit-log entries (action/username filters, keyset paging) and
summary counts. Tests in `tests/test_activity.py`.

**Goal.** Give admins a view of what's happening in the portal without shelling in.

**How it works.**
- `GET /api/admin/activity?action=&username=&before=&limit=` (reviewer-only): recent rows from the
  existing `audit_log`, newest first, with simple filters and paging.
- `GET /api/admin/insights` (reviewer-only): counts from `uploads` — waiting, in the last 7 days, total
  waiting size, approvals/rejections, top uploaders. Hand-drawn SVG bars (no chart library).
- Optional later: blend Kavita reader stats (`GET /api/Stats/most-active-users`, `files-added-over-time`)
  — marked as an idea; the first pass is portal data only.

**Data.** None new (reads `audit_log` and `uploads`).

**UI.** An **Activity** tab for reviewers, styled with the Kavita tokens; filter row, table, small charts.

**Security.** Reviewer-only; the audit log already stores client IPs — show them only to reviewers.

**Tests.** `tests/test_activity.py`: permissions, filtering, paging, and a stable shape for insights.

**Effort.** S–M.

---

## 5. Metadata auto-fill / match — planned

**Goal.** Prefill the review editor with the best matching metadata so admins type less and files land
with correct names and tags.

**How it works.**
- **Kavita-only first pass (no API keys):** find the most likely existing series
  (`GET /api/Search/search`, `POST /api/Series/v2`, reusing the near-miss logic already in
  `src/review.ts`), then read it with `GET /api/Series/metadata?seriesId=` (summary, genres, tags,
  writers, publishers, characters, ageRating, releaseYear, language, publicationStatus) and
  `GET /api/Series/series-detail?seriesId=` for folder/naming context. Those values prefill the shared
  fields in the review editor; the admin can still change everything, and the approved values are what
  get written into ComicInfo.xml / the EPUB OPF as today.
- **External providers (optional, later):** MangaDex and AniList are open; ComicVine needs a key.
  Behind an optional setting, with caching, rate limits, request timeouts, and HTML stripped from
  summaries. Off by default.

**Data.** No schema change; a short-lived in-memory/on-disk cache for lookups (as `src/themes.ts` caches
theme reads).

**UI.** A "Suggested from Kavita" chip/section on the review card with a one-click "Use these", plus the
existing manual fields.

**Security.** Server-side lookups only; external calls are outbound from the container with timeouts and
size caps; provider text is treated as untrusted (no HTML).

**Tests.** `tests/test_metadata_match.py`: an upload whose series already exists gets prefilled shared
fields; an unknown title leaves fields blank; a provider outage doesn't break review.

**Effort.** M (Kavita-only), L (with external providers).

---

## 6. Test harness refactor — planned

Make the acceptance tests shorter to write, faster to run, and clearer about what tends to break.

- **Shared harness** (`tests/harness.py`): one `app()/kavita()/login(role)` (with a cached session
  cookie), `upload()` (tus), `wait_until()` polling instead of fixed sleeps, `wait_pending/approved`, and
  a `check()`/`finish()` summary. The nine API files and seven browser files stop re-implementing these
  (which is how copy-paste bugs like the CSP `wait_for_function` and `Cookie: None` slips happened).
- **Speed**: a test-only `ROLE_RECHECK_MS` setting (default stays 2 minutes; small in the test `.env`)
  cuts the roles test from ~4 minutes to seconds. `run.sh` gains tiers: `--fast` (auth, activity, preview,
  notifications, requests — no library writes), `--slow` (uploads, review, metadata, fix, themes),
  `--browser`, `--roles`, `--all` (default).
- **Repeated failure points**: run `test_auth` alone (its deliberate failed logins count against the
  per-address limit); restart the portal at the start of a run to clear the counters; a selector-based
  `wait_for_text` helper that documents the "CSP blocks eval-based waits" rule in one place; and a
  `--repeat N` mode that runs the fast tier N times and lists anything that failed at least once.
- **Cleanup on failure**: each test removes the series/files it created even when an assertion fails.

**Effort.** M.

## 7. Tabbed companion UI — planned

The page stacks everything today (login → review → activity → upload → your uploads → requests →
notifications). Split it into tabs with a bar under the navbar (`role="tablist"`):

| Tab | Shown to | Contents |
|---|---|---|
| Upload | anyone who can upload | upload panel + Your uploads |
| Review | admins | queue + Recent decisions + fix search |
| Requests | everyone | ask + my requests (+ open queue for admins) |
| Activity | admins | insights + activity log |
| Notifications | anyone who can upload | settings panel |

- The current tab lives in `location.hash` (`#review`), so refresh and back/forward work; the default is
  Review for admins, Upload otherwise.
- Proper `role="tab"`/`aria-selected`/tabpanel, arrow-key navigation and visible focus from the existing
  Kavita tokens; the tab bar scrolls horizontally on phones.
- Front end only (`index.html`, `web/main.js`, `style.css`); the element ids stay, so the JS wiring barely
  changes, and the page-preview overlay stays global.

**Effort.** M.

## 8. Kavita sidebar label — planned

Mark the "Uploads" sidebar entry as opening in a new tab. Kavita renders an external source as a
`target="_blank"` link with a fixed `fa-server` icon, and uses one string (`SideNavStream.name`) for both
its label and its hover tooltip, so the indicator has to live in the text: set the name to **`Uploads ↗`**
with `POST /api/Stream/update-sidenav-stream`, idempotently at sign-in (existing links are renamed the
next time the user signs in). See [decisions.md](decisions.md) #15 for why nothing is injected into
Kavita's page.

**Effort.** S.

---

## Suggested order

Already shipped: Admin activity page (§4, 0.2.2), Notifications (§1, 0.2.3), Requests board (§2, 0.2.4),
Reviewer preview (§3, 0.2.5).

Next:

1. **Test harness refactor (§6)** — speeds up verifying everything after it.
2. **Sidebar label (§8)** — tiny and independent.
3. **Tabbed UI (§7)** — user-visible; §5 composes into the new Review tab.
4. **Metadata auto-fill (§5)** — largest; benefits from the review UI.

Not chosen this round but cheap and complementary: a **supply-chain bundle** (Dependabot/Renovate, a
Trivy image scan and SBOM/provenance in `.github/workflows/image.yml`), and a **"connect your Kavita
sidebar" self-serve page** for users who never sign in with a password.
