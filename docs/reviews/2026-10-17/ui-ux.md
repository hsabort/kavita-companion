# UI/UX baseline review — kavita-companion portal

**Date:** 2026-10-17 · **Area:** 1 (UI/UX) of `docs/product-review-plan.md` · **Reviewer:** UI/UX review agent
**Stack:** **test** only — portal `https://paragon.greyarea.contact:20006`, Kavita `…:20007`, worktree `/srv/kavita-test` (branch
`develop`, portal `0.6.9`). The live stack (`…:20004`) was never touched.
**Method:** Playwright (Chromium, `mcr.microsoft.com/playwright/python:v1.62.0-noble`) driving the real portal as the three test
accounts, plus a read of `kavita-companion/web/main.js`, `public/index.html`, `public/style.css` and `src/*.ts`.
Desktop 1440×900 and phone 390×844 (mobile UA, DSF 3). Console, `pageerror`, failed requests and HTTP≥400 were captured on every page.
**Evidence:** screenshots in `docs/reviews/2026-10-17/ui-ux-shots/` (61 files, referenced per finding). Harness: `/tmp/opencode/uiux/uiux.py`
(throwaway, outside the repo).

## Severity rubric

| Severity | Meaning |
|---|---|
| **High** | A normal failure leaves the user stuck or shows them wrong information about their own data, with no in-UI way forward. |
| **Medium** | A feature is confusing, wrong or inaccessible for a subset of users; a workaround exists but is not discoverable. |
| **Low** | Polish, inconsistency, or a spec-level gap with limited practical impact. |

## Summary

| ID | Sev | Finding | Where |
|---|---|---|---|
| H1 | **High** | A failed `/api/me` renders a blank page (no sign-in, no error, no retry) | `web/main.js:1697`, `public/index.html:28,45` |
| M1 | Medium | The Notifications tab shows an empty page until its `<details>` is clicked a second time | `public/index.html:52,206`, `web/main.js:107` |
| M2 | Medium | Failed requests are rendered as *empty states* ("You haven't uploaded anything yet"), others fail silently | `web/main.js:305-311,1068-1070,1355,1604-1606` |
| M3 | Medium | A 500 from `/api/me` is shown as an ordinary sign-in page | `web/main.js:55-60,74-96,1697` |
| M4 | Medium | Activity prints raw internal action names (9 actions have no label and no filter option) | `web/main.js:1280-1297`, `public/index.html:128-146` |
| M5 | Medium | Provider API-key fields have no accessible name | `web/main.js:1243` |
| M6 | Medium | The Find-metadata dialog declares `aria-modal` but does not isolate the page behind it | `web/main.js:574-602` |
| M7 | Medium | A metadata source that fails is silently dropped when another one answers | `web/main.js:663-693` |
| L1 | Low | The tablist is not programmatically connected to its panels | `public/index.html:46-54`, `web/main.js:112-124` |
| L2 | Low | Dialog plumbing: mounted inside the review card, page not scroll-locked | `web/main.js:801`, `public/style.css:421-433` |
| L3 | Low | Duplicate `<datalist id="series-list-2">` (concurrent creation) | `web/main.js:402-410` |
| L4 | Low | Reject uses `prompt()`, Withdraw uses `confirm()` | `web/main.js:925,345` |
| L5 | Low | The page-preview overlay is not a dialog | `public/index.html:257-267`, `web/main.js:1552-1562` |
| L6 | Low | Several controls are below the WCAG 2.2 24px target-size minimum | `public/style.css:164-179` |
| L7 | Low | The 7-tab strip is cut off on a phone with no scroll affordance | `public/style.css:332` |
| L8 | Low | The request form is not a `<form>`, so Enter does nothing | `public/index.html:179-196` |
| L9 | Low | The 10-second poll rebuilds the uploads list and drops focus | `web/main.js:94,305-311` |
| L10 | Low | Per-file fields are skipped for multi-file groups (footnote only); candidate radios are an unlabelled group | `web/main.js:626-640,719-731` |
| L11 | Low | An expired session drops the user on the sign-in form with no explanation | `web/main.js:307` |
| L12 | Low | The URL hash can name a tab the account cannot see | `web/main.js:112-124,149-152` |
| L13 | Low | A provider that is on but has no key leaves no trace on the review card (dead message path) | `src/review.ts:218-230`, `web/main.js:545-551` |
| L14 | Low | Collapsed `<details>` hide the only entry points to the fix flow on the Review tab | `public/index.html:67-76` |

Also checked and **clean**: labels on every portal form control, live regions, focus rings, colour contrast, phone reflow, the
happy-path console/network (0 errors on all 7 tabs, both viewports). Details in "Verified good".

---

## High

### H1 — A failed `/api/me` renders a blank page (no sign-in, no error, no retry)

* **Repro**
  1. Open `https://paragon.greyarea.contact:20006/` with `/api/me` failing — e.g. DevTools → Network → *Block request URL* `me`,
     or take the connection down for that request (a proxy/Caddy hiccup, or a flaky mobile link, hits the same path).
  2. Load the page and wait ~3 s.
* **Expected:** either the sign-in card, or the session view with an inline "the portal is unreachable, retrying" message and a retry.
* **Actual:** `<main>` is empty — only the navbar (logo + "Kavita · Uploads") is drawn. `#login-view` stays `hidden` (it is `hidden`
  in the markup until JS reveals it) and `#home-view` is never revealed, because the module's last statement is a top-level
  `await refreshMe()` and a rejected `fetch` rejects the whole module. Console: `Failed to fetch` + `net::ERR_FAILED`; measured
  `{login:false, home:false, mainText:""}`. Reloading does not help while the failure lasts, and the user has no hint that
  anything went wrong (not even a spinner).
* **Evidence:** `ui-ux-shots/d13-me-network-error.png` (blank page), harness line `-- api-me-abort: console-errors=2 failed-requests=1`.
* **Suggested fix:** wrap the bootstrap (`main.js:1697`) in `try/catch`, always un-hide one of the two views, and show a retry
  banner; consider a timeout on `/api/me`.

## Medium

### M1 — The Notifications tab shows an empty page until its `<details>` is clicked a second time

* **Repro:** sign in as any uploader → click the **Notifications** tab.
* **Expected:** the notification preferences (channel, address, events) are visible on the tab.
* **Actual:** the whole panel is one `<details id="notify-wrap">` that `selectTab()` un-hides but never opens, so the tab paints a
  single collapsed summary "▶ Notifications" and leaves the rest of the page empty. The user must click the summary *after* having clicked the
  tab. The same happens for the phone layout (`p07-uploader-notifications.png`). Every other tab renders its content directly.
* **Evidence:** `ui-ux-shots/d04-tab-notifications.png`, `ui-ux-shots/p07-uploader-notifications.png`
  (harness: `#notify-wrap@open=None`, panel list `[]`).
* **Suggested fix:** make the tab's `onShow` set `open` (or drop the `<details>` when it is used as a tab panel).

### M2 — Failed requests are rendered as empty states, or ignored silently

* **Repro:** with the portal healthy, make one API request fail (DevTools → Block request URL, or a 500) and visit the tab:
  1. Block/500 `/api/uploads`, reload → *"You haven't uploaded anything yet."* (`d15-uploads-500.png`), even though the account
     has 59 uploads.
  2. 500 `/api/requests` → *"You haven't asked for anything yet."* (`d19-requests-500.png`), though the account has requests.
  3. 500 `/api/admin/activity` → *"No activity yet."* and no insight cards (`d20-activity-500.png`).
  4. 500 `/api/review` → the previous list, or *"Nothing is waiting for review."*, with no message (`d16-review-500.png`).
* **Expected:** a distinct, visible error state ("Couldn't load your uploads — Retry"), never the *empty* copy.
* **Actual:** `refreshUploads()` only special-cases 401; on any other status `body.uploads` is `undefined`, the list is cleared and
  the empty state shows (`main.js:311`). `refreshRequests()` (`main.js:1605`), `refreshActivity()` (`main.js:1348`) and
  `refreshReview()` (`main.js:1070`) `return` on any non-200 and leave whatever was on screen. Only `/api/library/*`,
  `/api/metadata-sources` and the provider panel (`.row-status.error`) report failures.
  Related nuance: the empty message never mentions the filter — with `action=session_revoked` + a user that matches nothing the page
  still says "No activity yet." (`d23-activity-filtered-empty.png`).
* **Evidence:** `d15-uploads-500.png`, `d16-review-500.png`, `d19-requests-500.png`, `d20-activity-500.png`,
  `d23-activity-filtered-empty.png`; measured status text and visibility in the harness log.
* **Suggested fix:** one shared `renderError(status, node, message)` helper; distinguish "no data" from "couldn't load"; give the
  activity empty state filter-aware copy.

### M3 — A 500 from `/api/me` is shown as an ordinary sign-in page

* **Repro:** 500 the `/api/me` request (not a network failure) and load the page.
* **Expected:** either the signed-in view (if the cookie is still good) or an explicit "the server is having trouble" state.
* **Actual:** the sign-in card is shown with an empty error line (`login-error=""`), so a user who is signed in is silently treated
  as signed out. Typing the password re-tries `/api/login`, which also fails, and they get "Sign-in failed." — pointing them at
  their credentials instead of the outage. (`fetchMe` → `show(null)` for every non-200, `main.js:55-60`.)
* **Evidence:** `ui-ux-shots/d14-me-500.png`; harness `{} /api/me 500 -> {"login": true, "err": "", "who": ""}`.
* **Suggested fix:** distinguish 401 (signed out) from 5xx/network (degraded) and surface the second in `#login-error`/a banner.

### M4 — Activity prints raw internal action names and cannot filter them

* **Repro:** Review/admin account → **Activity** tab, clear the filters.
* **Expected:** every row reads as a sentence ("test-admin turned a metadata provider on").
* **Actual:** actions with no `ACTIVITY_LABEL` entry are printed verbatim — `test-admin provider_key_cleared`,
  `test-admin provider_disabled`, `test-admin provider_match`, `test-admin provider_apply`, … 12 of the first 50 rows in the test
  audit log are untranslated. The Action dropdown offers 16 values while the server writes at least 25
  (`provider_enabled/disabled/key_set/key_cleared/match/preview/apply`, `upload_converted`, `upload_fix_failed`, …), so those events
  can be neither read in plain words nor filtered (an empty filter result then reads "No activity yet.").
* **Evidence:** `ui-ux-shots/d33-activity-raw-actions.png` (harness: `activity rows with raw action names (12): [...]`).
* **Suggested fix:** derive the dropdown and labels from one shared list of audit actions; add a fallback that humanises unknown
  actions (`provider_apply` → "applied provider metadata").

### M5 — Provider API-key fields have no accessible name

* **Repro:** admin account → **About** → *Metadata providers*; inspect the key fields (or navigate by screen reader).
* **Expected:** each key field is announced with its provider, e.g. "Metron API key".
* **Actual:** four `<input type="password" placeholder="Paste key…">` with no `<label>`, `aria-label` or `aria-labelledby`
  (`main.js:1243`); AT announces "password, Paste key…" with no idea which provider it belongs to. Placeholder-as-label also
  disappears as soon as anything is typed.
* **Evidence:** `ui-ux-shots/d06-about-providers.png`, `ui-ux-shots/d08-about-provider-on.png`; harness
  `provider key inputs: [{"label": 0, "aria": null, ...}]` for all four rows.
* **Suggested fix:** `aria-label="<provider> API key"` (or a visually hidden `<label>`), matching `#providers-panel` rows.

### M6 — The Find-metadata dialog declares `aria-modal` but does not isolate the page behind it

* **Repro:** admin → Review → *Find metadata* on any card; then try to reach the page behind (mouse, or Tab/shift-Tab after clicking
  the backdrop area, or an AT's browse mode).
* **Expected:** with `aria-modal="true"`, the background is inert/`aria-hidden` and only the dialog is reachable.
* **Actual:** only `Tab` keydowns *inside* the dialog are trapped. `#review-refresh` still takes focus while the modal is open
  (measured `canFocusBackground: true`), the background is neither `inert` nor `aria-hidden`, and the dialog has no
  `aria-describedby`. `body` keeps `overflow: visible`, so the page behind still scrolls under the fixed overlay. Good news:
  `role=dialog`, `aria-modal`, `aria-labelledby` and focus-return-to-trigger **are** correct, and Tab/Escape/backdrop-click all work.
* **Evidence:** `ui-ux-shots/d09-meta-candidates.png`, `ui-ux-shots/p04-meta-dialog.png`; harness
  `dialog semantics: {"role":"dialog","modal":"true","labelledby":"metadata-dialog-title-…","canFocusBackground":true,"bodyOverflow":"visible"}`.
* **Suggested fix:** set `inert` on `#home-view` while the overlay is open (and `overflow:hidden` on `<body>`); keep the existing trap.

### M7 — A metadata source that fails is silently dropped when another one answers

* **Repro:** enable Metron (key set, fixture fake reachable) **and** the test-stub provider (key set, endpoint dead), then
  *Find metadata* on a comics card.
* **Expected:** the candidates from the working source, plus a note that the other source could not be reached.
* **Actual:** only the working source's attribution line is rendered; the failure appears nowhere. The per-provider reasons are only
  printed when the candidate list is empty, so a reviewer cannot tell a complete result from a partial one. (When *no* provider
  answers, the explanation is good: "Test stub provider couldn't be reached (stub: fetch failed).")
* **Evidence:** `ui-ux-shots/d39-meta-one-source-down.png` (compare `d38-meta-unreachable.png`, which lists every provider's reason).
* **Suggested fix:** always render skipped-provider lines (perhaps one line: "1 source couldn't be reached — details"), not only in
  the zero-candidate branch (`main.js:663-693`).

## Low

### L1 — The tablist is not programmatically connected to its panels

* `role="tab"` buttons carry `aria-selected`, but no `aria-controls`, the panels have no `role="tabpanel"`, and every tab stays in
  the Tab order (no roving `tabindex`). A screen reader hears "tab, selected" with no way to jump to the panel it opened, and the
  `#tabs`/`Library views` tablists are announced as widgets that do not exist structurally.
* Left/Right arrow switching works and focus follows (`main.js:138-148`), but the arrows do **not** wrap from the last tab to the
  first (ARIA practice) — pressing ArrowLeft on Upload does nothing.
* Evidence: every `d04-tab-*.png`; harness `panels=[] controls=null` for all 9 tabs. Fix: add `id`/`aria-controls` on the panels,
  `role="tabpanel"` + `tabindex="-1"`, and wrap the arrow index.

### L2 — Dialog plumbing: mounted inside the card, page not scroll-locked

* The overlay/dialog is appended into `.review-group` (`main.js:801`), so each card carries its own hidden dialog (measured: **3**
  dialogs in the DOM for 3 pending cards) and any review-list re-render (Refresh, poll, tab switch) tears an open dialog down.
  `body` is never scroll-locked while it is open. Evidence: `d09-meta-candidates.png`, `p04-meta-dialog.png`.
* Fix: one dialog node at document level, opened with the card's data.

### L3 — Duplicate `<datalist id="series-list-2">`

* Two concurrent `ensureDatalist()` calls both pass the "does it exist?" check before either appends, so the series suggestions
  datalist exists 3× with the same id for 3 cards. `document.getElementById` then returns whichever is first, and the `list=`
  attribute may point at a stale copy that a later render removes.
* Evidence: harness `dupes=['series-list-2']`, `datalists: ["series-list-2","series-list-2","series-list-2"]`;
  screenshot `d31-review-card.png`. Fix: cache the promise, not the DOM lookup (`main.js:402-410`).

### L4 — Reject uses `prompt()`, Withdraw uses `confirm()`

* Rejecting a file opens a native browser prompt ("Why is "…" rejected? The uploader will see this.") and Withdraw a native
  confirm ("Withdraw "…"? The file will be deleted."). They cannot be styled to match the portal, block the page, allow a single
  line with no validation, and on a phone a long reason is awkward to type or paste.
* Evidence: harness captured the dialogs verbatim while exercising `d31-review-card.png` / `d34-upload-in-progress.png`.
* Fix: a small in-page reason field (the dialog component already exists) and an explicit confirm row.

### L5 — The page-preview overlay is not a dialog

* `#page-preview` (full-screen page preview from a review card) has no `role`/`aria-modal`/label, focus is not moved into it (the
  triggering button keeps focus), the page behind stays focusable, and `#preview-img`'s alt is the generic "Page preview".
  Escape and the Close button work; Previous/Next are real buttons.
* Evidence: `ui-ux-shots/d32-page-preview.png`; harness `{"role":null,"ariaModal":null,"label":null,"imgAlt":"Page preview"}`.

### L6 — Several controls are below the WCAG 2.2 24px target-size minimum

* Measured on a 390px phone: the Uppy "browse files"/"browse folders" links **17px** tall, `Download` **22px**, "Back to Kavita"
  **23px**, licence links **19px** (all `<a>`/`.link`, not `.btn`). `.btn.small` buttons are 29px, so buttons are fine; the inline
  text controls are the problem, and they sit in dense rows (review card actions, library rows, About sources).
* Evidence: `p02-tab-review.png`, `p02-tab-library.png`, `p02-tab-upload.png`, `p02-tab-about.png`; harness target lists.
* Fix: give inline link controls `padding: .25rem .35rem` / `min-height: 24px`.

### L7 — The 7-tab strip is cut off on a phone with no scroll affordance

* Admin strip: 635px of tabs inside a 358px `overflow-x: auto` strip on a 390px viewport — the About tab's right edge is at 651px,
  i.e. Activity/Notifications/About are off-screen. There is no fade, arrow, wrap or any hint that the strip scrolls, and the
  active-tab underline can be invisible when the selected tab is off-screen.
* Evidence: `ui-ux-shots/p03-review-card.png` (strip truncated), `p02-tab-about.png`; harness
  `{"clientWidth":358,"scrollWidth":635,"lastTabRight":651,"aboutOffscreen":true}`.
* Fix: allow the strip to wrap on narrow screens, or add a scroll shadow/`scroll-snap` hint.

### L8 — The request form is not a `<form>`, so Enter does nothing

* "Ask for it" lives in a `<div class="request-form">` with `type="button"` (`main.js:1642`), so pressing Enter in Title/Issue/Note
  submits nothing (measured: 0 → 0 rows, empty status) and there is no native validation; the maxlength counts are the only guard
  besides the inline "Enter a title." check.
* Evidence: `ui-ux-shots/d24-requests-validation.png`, `d40-requests-after-ask.png`.

### L9 — The 10-second poll rebuilds the uploads list and drops focus

* `refreshUploads()` runs every 10 s and calls `list.replaceChildren(...)` (`main.js:305-311`), so a keyboard user parked on a
  Withdraw button is thrown back to `<body>` (measured `BUTTON:Withdraw` → `BODY`). The Review tab is careful about this (drafts and
  DOM identity are preserved across its polls); "Your uploads" is not.
* Evidence: harness line `focus over the 10s uploads poll: 'BUTTON:Withdraw' -> 'BODY…'`; screenshot `d04-tab-upload.png`.
* Fix: patch changed rows in place, or skip the rebuild when focus is inside the list.

### L10 — Metadata-dialog polish for batches and groups

* On a multi-file group card, applying a candidate fills the shared fields and then only says "Per-file fields (Number, Title,
  Summary) weren't applied to a multi-file group" — the reviewer must open each row by hand for `#1..N`, and the note uses
  comma-joined internal field names (`d37-meta-group-applied.png`, `d36-meta-group.png`).
* The candidate radios share a generated name but sit in a plain `<div class="candidates">` with no `fieldset`/`legend` or
  `role="radiogroup"`, so AT reports ungrouped radios per card (`main.js:719-731`).
* Fix: offer "fill each file's number from the file name / sequence" for groups, and wrap candidates in a labelled group.

### L11 — An expired session drops the user on the sign-in form with no explanation

* When a poll returns 401 the app calls `show(null)` (`main.js:307`): the sign-in card appears with an empty error line and any
  in-flight upload context vanishes. Measured after clearing cookies: `{login:true, err:"", notice:""}`.
* Evidence: `ui-ux-shots/d26-session-expired.png`. Fix: `notice("Your session expired — sign in again to continue.", problem=true)`.

### L12 — The URL hash can name a tab the account cannot see

* On an in-session hash change to a hidden tab (`#review`, `#library`, `#notifications` for a read-only account) `selectTab()`
  returns early *after* the browser has changed the hash, so the URL says `#library` while the Requests panel is what is shown
  (and `tab-requests` stays `aria-selected`). A fresh load on the same URL falls back correctly to `#requests`.
* Evidence: `ui-ux-shots/d42-readonly-bad-hash.png`; harness
  `in-page hash -> #library: {"hash":"#library","visible":["requests-section"],"selected":["tab-requests"]}`.
* Fix: in `selectTab()`, rewrite the hash back to the visible tab when the requested one is not permitted.

### L13 — A provider that is on but has no key leaves no trace on the review card

* `GET /api/review` advertises only providers that are **enabled and configured** (`src/review.ts:218-230`), so with Metron on and
  keyless the card shows no *Find metadata* button at all (verified by API: `enabled=true, configured=false` → `metadata.providers []`).
  The dialog's own "needs a key (an admin can add one under Metadata providers)" message is therefore unreachable, and the reviewer
  cannot tell that external metadata is on but unusable. The About panel does say "On — needs a key", so this is a discoverability
  gap rather than a broken flow.

### L14 — Collapsed `<details>` hide the only entry points to the fix flow on the Review tab

* "Recent decisions" and "Find an approved file to fix" are collapsed `<details>` at the bottom of a long page
  (`index.html:67-76`), so approving/fixing an already-approved file looks like a different feature. The Library tab's "Fix in
  portal" does open the details and prefill the search (`main.js:1403-1410`), which mitigates it — worth keeping in mind before
  moving or nesting either block.

---

## Verified good (evidence-backed, no action needed)

* **Happy-path console/network is clean.** 0 console errors, 0 `pageerror`, 0 failed requests, 0 HTTP≥400 across all 7 tabs on
  desktop and phone, for admin, uploader and read-only users (harness `-- <section>: console-errors=0 …`). No CSP violations, no
  404s for `/build/app.js`, `/build/app.css`, fonts or images.
* **Labelling.** Every portal form control (login, upload, review card, library filters, activity filters, requests, notifications,
  provider panel) resolved an accessible name — only the provider key fields (M5) fail. `imgsNoAlt=[]`.
* **Colour contrast passes WCAG AA** on the portal's own text (computed with OKLab→sRGB compositing):
  `.hint`/`.empty`/inactive tab 6.04:1, `label`/`.muted` 5.08:1, `.upload-meta` 5.52:1, `.banner` 11.71:1, `.chip` 10.16:1,
  Uppy note 8.64:1, Uppy drop-title 11.19:1, "browse files" 6.28:1. The login card fails nothing either.
* **Focus is visible from the keyboard** on tabs and nav links (`box-shadow: … 0.15rem` ring, measured 2.4px on the black navbar
  and light-on-dark elsewhere), and the keyboard Tab order is a sane DOM order: brand → Back to Kavita → Sign out → tabs →
  section controls → list rows → wrap.
* **Tab flow.** All 7 tabs switch panels correctly, keep `aria-selected`, and write the hash; deep links (`/#library`) work for
  permitted tabs; a reviewer lands on Review, an uploader on Upload, a read-only user on Requests; hidden tabs really are hidden
  (`readonly: ['tab-requests','tab-about']`, `uploader: ['tab-upload','tab-requests','tab-notifications','tab-about']`).
* **The Find-metadata dialog** is a labelled `role=dialog` with `aria-modal`, moves focus to the panel on open, traps Tab, closes on
  Escape/backdrop/Close, returns focus to its trigger, keeps applied values through a re-render, refuses an empty field selection
  with an inline message, and credits each provider with a licence link. On a phone it fits (358px wide, actions end at 715px of
  844px) and it is reachable with the same keyboard flow.
* **Upload area.** Uppy renders the themed dashboard, the accepted types/size limit are stated, an unsupported file is refused with
  "You can only upload: .cbz … .azw3" and is not queued, the library picker starts on "Choose a library…" and is enforced before
  upload, and a 2-file upload of the same series becomes one group card with shared fields and "Approve all 2".
* **Empty states exist and are worded well** when the data really is empty (library search, "Needs metadata", open requests,
  approved-file search, review queue, uploads) — the problem is only when a *failure* borrows them (M2).
* **Phone reflow.** No page-level horizontal scroll on any tab (390/390 on all 7, plus login and the review card); the review card
  stacks the cover above the fields; tables and the tab strip scroll internally by design.
* **Motion/theme.** Theme tokens follow Kavita, `prefers-reduced-motion` is respected for transitions, and `[hidden]` is
  force-hidden so author display rules can't leak panels.

## Environment, test data and cleanliness

* Work was done against the **test** stack only; the live portal was never addressed (`…:20004`).
* Test data created and removed: two pending uploads `UIUX Group <tag> #1/#2.cbz` (uploaded through the real uploader, then
  withdrawn — files deleted, both out of the queue: `pending=0`), one request `ZZ Audit Request <n>` (declined again), provider keys
  set/cleared and the test-stub/Metron providers left **off and keyless** (verified: `stub:false:false, metron:false:false, …`).
  Nothing was approved, rejected, fixed or written to the media library; the Reject prompt was dismissed, and the metadata dialog's
  *Apply* only fills card fields (no write until Approve).
* Screenshots: `docs/reviews/2026-10-17/ui-ux-shots/` — `d*` desktop (1440×900), `p*` phone (390×844).

## Coverage limits (not tested here)

* No screen-reader session (NVDA/VoiceOver) and no 200% zoom/reflow pass; a11y findings come from the DOM/ARIA/CSS audit plus
  Playwright's focus behaviour.
* Chromium only (no Firefox/WebKit); no real touch/gesture testing.
* Rate-limit UI (429 lockout copy) and the notification webhook/ntfy delivery paths were not exercised; real
  ComicVine/Google Books are out of scope by decision, and Metron was exercised only through the local fixture fake.
* Single-user-at-a-time: concurrent reviewers, upload queues under load, and Kavita-side rendering were not in scope.
* The multi-file group card was exercised with two files of the same series; larger batches, mixed libraries and a partially-failed
  batch were not.
