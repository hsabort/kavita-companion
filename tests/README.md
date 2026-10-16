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
`check()`, `finish()`), so each test file holds only its own setup and assertions.

| File | Covers |
|---|---|
| `test_auth.py` | Health, security headers, sign-in/out, session cookie flags, CSRF, permissions, rate limit |
| `test_uploads.py` | Resumable uploads incl. a dropped connection, refusals, type and duplicate checks, limits, ownership, withdraw |
| `test_review.py` | Review queue: permissions, suggestions, approval into new/existing series, name clashes, `../` safety, reject/restore, Kavita shows the result |
| `test_themes.py` | Theme sync: signed-out default, Dracula and Light via password sign-in, theme change via the sidebar link, an open session following changes made in Kavita (stored session encrypted), back to Dark. Temporarily installs catalogue themes and restores Kavita afterwards. |
| `test_metadata.py` | Inspection (cover, pages, embedded metadata, warnings), metadata written into CBZ/EPUB, CB7→CBZ, PDF, unsafe archives |
| `test_fix.py` | "In Kavita ✓" confirmation and links, Fix: move to another series, old series dropped by Kavita, fix in place, name clash refused, permissions, search |
| `test_activity.py` | Admin Activity panel: reviewer-only access, action/username filters, paging, insights shape and counts |
| `test_notifications.py` | Per-user notifications: preference rules, SSRF/target validation, and webhook delivery for the test/invalid/rejected events (runs a receiver on the host) |
| `test_requests.py` | Request board: create/list/decline/fulfil, permissions, and a matching approval fulfilling a request automatically |
| `test_preview.py` | Reviewer page preview: pages served in order, bounds refused, reviewer-only |
| `test_sidebar_label.py` | The Kavita sidebar entry is named `Uploads ↗` (creates/repairs it on sign-in) |
| `test_roles_and_limits.py` | Role changes in Kavita reach open sessions; general rate limit. **Changes test-uploader's roles for ~5 minutes** and therefore refuses to run if a real person signed in within the last hour or uploaded in the last 30 minutes (`--force` overrides). |
| `browser/upload_page.py` | The upload page on desktop and phone sizes, no console errors |
| `browser/review_page.py` | The review screen, cover, destination preview, approval |
| `browser/fix_page.py` | Recent decisions shows "In Kavita ✓", the link opens the right Kavita series page, Fix… editor saves |
| `browser/kavita_integration.py` | Sign in to Kavita, click **Uploads** in its sidebar, land in the portal signed in; password sign-in adds the sidebar link |
| `browser/activity_page.py` | The admin Activity panel renders (cards + entries) and is hidden from non-admins |
| `browser/notifications_page.py` | The Notifications panel is shown to uploaders (save works) and hidden from read-only accounts |
| `browser/requests_page.py` | A user asks for a title; a reviewer sees it in the open queue and declines it |

`settings.py` reads `.env`; library ids are looked up by name (Manga, Comics, Books).

**Sign-in limits:** a full run makes about 12 deliberately failed sign-ins (to test the limits), and the
portal allows 30 failed sign-ins per address per 15 minutes. Running the full suite more than twice in
15 minutes from the same host therefore locks that host out of signing in until the window passes
(or `docker compose restart kavita-companion`, which clears the in-memory counters).
