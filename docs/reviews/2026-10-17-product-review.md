# kavita-companion — product review (baseline)

**Date:** 2026-10-17 · **Status:** findings + remediation plan · **Scope:** whole stack (`compose.yaml`, Kavita
image, Caddy, portal) · **Method:** read-only review agents, test stack only · **Plan:**
`docs/product-review-plan.md`

**Stacks.** Live (`/srv/kavita`, portal `…:20004`) was **never touched**; everything ran against the
**test stack** (the test worktree, portal `…:20006`, Kavita `…:20007`). State was left as found.

**Anti-goals honoured:** no rewrites, no new features, no live/host changes, no vibes-only findings — every
finding below carries `file:line` / a repro / an output.

**Severity rubric.** *Critical* = data loss or a live security breach · *High* = a feature broken for a
user/admin, or an exploitable exposure · *Medium* = correctness/abuse with real cost or an inaccessible
subset · *Low* = rough edge / polish.

**Team (8 reviewers + orchestrator).** `code-architect`, `metadata-reviewer`, `test-quality-reviewer`,
`supply-chain-reviewer`, `ops-reviewer`, `compliance-reviewer` (parallel); `ui-ux-reviewer`, `qa-reviewer`,
`appsec-redteam` (sequential, stack-touching). New roles this review vs. the last: **metadata**,
**code-architect**, **test-quality**, **appsec**, **supply-chain**, **ops**. Raw detail:
`docs/reviews/2026-10-17/{ui-ux,qa,appsec}.md` + `ui-ux-shots/` (61 screenshots).

---

## Executive summary

**≈1 Critical · ≈19 High · ≈36 Medium · ≈48 Low.**

### The six that matter most

1. **C1 — the test runner can mutate the live library** (ops). `tests/run.sh` guards only on `TEST_*`
   secrets being set, and the **live `.env` has them set**; a documented `cd /srv/kavita && tests/run.sh`
   approves uploads into the live library, writes files, rescans live Kavita and (browser tier)
   `rm -rf`'s live `Browser Review*` series. `docs/development.md:64` states the intent; nothing enforces
   it. **This is the one to fix first.**
2. **The test stack is publicly reachable with its SSRF guards off, and it holds default-password
   accounts** (ops H1/H2). `…:20006` is internet-facing with `NOTIFY_ALLOW_PRIVATE=true` /
   `PROVIDERS_ALLOW_PRIVATE=true`, and live Kavita has a `test-uploader` / `ChangeMe123!` account.
3. **Converted MOBI/AZW books can't be downloaded** (qa F1) — `/api/review/:id/download` announces the
   *MOBI's* size for the smaller converted EPUB → the client hangs / gets 0 bytes. The reviewer can't open
   the file they're approving; `/api/uploads` and the card also show the wrong size.
4. **A failed `/api/me` renders a blank page** — no sign-in, no error, no retry (ui H1). Every other
   failure mode (5xx, expired session) mis-renders too (ui M2/M3/M11).
5. **Deploy/supply chain is trusted, not verified** (supply H1–H3): Actions pinned to mutable tags, the
   image **pushed to GHCR before the Trivy gate**, and deployment binds a mutable tag with no signature.
6. **The notification SSRF guard is bypassable** (appsec F1): IPv6 literals, trailing dots and
   loopback-resolving DNS names slip past the hostname filter, and `deliver()` follows redirects into
   private space — the redirect bypass works even with `NOTIFY_ALLOW_PRIVATE=false`. An uploader-supplied
   target can reach Kavita's API, the Docker gateway and `169.254.169.254`.

### Themes

- **Metadata & Kavita compatibility is the deepest risk area** — and the newest reviewer earned its place:
  the write path can silently damage or misrepresent a file (`apply` "fill" overwrites the file's own
  `Number`; provider text with control chars yields ComicInfo Kavita rejects; PDFs discard every reviewed
  field; `refresh` is ignored by `/apply`).
- **The library-type enum is duplicated as literals in ≥4 places** and has already shipped two bugs
  (0.6.6's no-op `Volume` filter; the Kindle guard disagreeing with the media mapping) — a single shared
  constant would remove a whole class.
- **Uploads are validated by magic bytes only**; archive structure, sniffer trust, and expansion limits
  are checked late (at approval) or not at all.
- **Failure is often invisible**: empty states stand in for errors (ui M2), a dropped metadata source is
  hidden (ui M7), provider links are a documented-but-dead subsystem (code H1 / metadata #8).
- **Test quality, not quantity, is the gap**: the suite is broad and real, but the security guards are
  never exercised (SSRF/archive limits untested), fixtures are synthetic and masked three shipped bugs,
  and a security assertion has an operator-precedence bug that can pass while an escape file exists.

### What's genuinely solid (don't regress it)

No secrets in git history; exact app dependency pins; SBOM+provenance published; coherent GPL licensing;
no dangerous workflow triggers. The portal's auth gates, ownership checks, `X-KC-User` isolation,
traversal sanitisation, `<Volume>` drop, and XSS-safety (no `innerHTML`) all held under adversarial
probing (qa "Verified-correct", ui "Verified good").

---

## 1. Runtime / upload pipeline (QA) — `docs/reviews/2026-10-17/qa.md`

| Sev | Finding | Where |
|---|---|---|
| **High** | Converted MOBI/AZW download sets the MOBI's `Content-Length`; client hangs / 0 bytes; size wrong in `/api/uploads` + card | `src/uploads.ts` (`checkCompletedUpload` keeps `size`), `src/review.ts:966-975` |
| **Med** | Zip-bomb amplification: `maxExpanded = max(size*3, size+GB)` and the disk pre-check uses the *compressed* size — a 122 KB `.cbz` became a 126 MB library file (1028×) | `src/review.ts:556-563` |
| **Med** | EPUB sniffer accepts a 94-byte non-archive with a forged `PK…mimetype…` header → reaches the queue as `pending` | `src/uploads.ts:229-237` |
| Low/Med | `maxConcurrentPerUser` slots held up to 24 h by rows that sent **no bytes**; misleading 429 | `src/uploads.ts:175-178`, `config.ts:59` |
| Low | `GET /api/review/series?libraryId=abc` → `500` echoing Kavita's error, not `400` | `src/review.ts:827-843` |
| Low | `GET /login?apiKey=…` is state-changing with **no Origin/CSRF check** (login CSRF; also ends the victim's session) | `src/server.ts:174-190` vs `:75-80` |
| Low | Restart between conversion and `setPending` orphans the EPUB and marks the row `invalid`; leaked `pending/` file | `src/uploads.ts:337-347` |
| Low | Unsafe archives (`../`, absolute, symlink, >20k entries) are accepted as `pending` and only refused at **Approve** | `src/uploads.ts:214-221`, `src/inspect.ts:68`, `src/review.ts:563` |

## 2. Metadata & Kavita compatibility — metadata-reviewer

| Sev | Finding | Where |
|---|---|---|
| **High** | `apply` "fill" overwrites the file's own per-file `Number`/`Title`/`Summary`/`Volume` (card sends a partial `current`, so `?? defaults` never runs; proposed as *fill*, not conflict) | `web/main.js:605-609`, `src/review.ts:377-379`, `src/providers/merge.ts:76-84` |
| **High** | `/apply` ignores `refresh` — adapters read-through-cache, so it returns stale data yet reports `cached:false` (the 0.6.2 fix missed this route) | `src/review.ts:370-375` vs `src/providers/routes.ts:190` |
| Med | A 429 `Retry-After` still **sleeps** the full wait (the cooldown-skip covered only the token bucket) → up to ≈240 s hang | `src/providers/http.ts:196-204` vs `:83-94` |
| Med | C0 control chars are written verbatim into ComicInfo/OPF → .NET (Kavita) rejects the file, metadata silently ignored | `src/metadata.ts:46-54,71-108,162-173`, `src/review.ts:468` |
| Med | A file can be approved into a library whose file-type whitelist excludes it — written but never scanned | `src/uploads.ts:35-49,169-171`, `src/review.ts:486-523` |
| Med | PDFs: **every** reviewed/applied field is silently discarded on approve | `src/review.ts:551-555` |
| Low | EPUB writer drops XML attributes on replaced list nodes; `Writer: ","` can delete all `dc:creator` | `src/metadata.ts:162-168` |
| Low | Provider series links never persisted despite the docs (dead subsystem) | `src/providers/links.ts`, adapters |
| Low | container.xml lookup case-sensitive on write, case-insensitive on read | `src/inspect.ts:95` vs `src/review.ts:588` |
| Low | AniList `isAdult:false` → `AgeRating=Everyone` (a non-adult mature title mislabelled) | `src/providers/anilist.ts:105-109` |
| Low | review-status `hasKey` hard-coded false for optional-key providers (GCD) | `src/review.ts:255` vs `routes.ts:44` |

## 3. UI/UX — ui-ux-reviewer — `docs/reviews/2026-10-17/ui-ux.md`

| Sev | Finding | Where |
|---|---|---|
| **High** | A failed `/api/me` renders a **blank page** (no sign-in, no error, no retry) — a top-level `await refreshMe()` rejects the module | `web/main.js:1697`, `public/index.html:28,45` |
| Med | Notifications tab paints only a collapsed `<details>` until clicked a second time | `public/index.html:52,206`, `web/main.js:107` |
| Med | Failed requests render as **empty states** ("You haven't uploaded anything yet") or are ignored | `web/main.js:305-311,1068-1070,1604-1606` |
| Med | A 500 from `/api/me` is shown as an ordinary sign-in page | `web/main.js:55-60,1697` |
| Med | Activity prints raw internal action names; 9 of ≈25 actions unlabelled/unfilterable | `web/main.js:1280-1297`, `public/index.html:128-146` |
| Med | Provider API-key fields have **no accessible name** | `web/main.js:1243` |
| Med | Find-metadata dialog declares `aria-modal` but leaves the page focusable/scrollable behind it | `web/main.js:574-602` |
| Med | A metadata source that fails is silently dropped when another answers | `web/main.js:663-693` |
| Low×14 | tablist↔panel wiring, per-card dialog duplication, duplicate `<datalist>`, `prompt()`/`confirm()` reject/withdraw, preview overlay not a dialog, <24px targets, phone tab-strip cut off, request form not a `<form>`, poll drops focus, group/radio polish, expired-session copy, hash names a hidden tab, provider-on-but-keyless invisible, collapsed `<details>` hide the fix flow | (see file) |

## 4. Ops / deployment — ops-reviewer

| Sev | Finding | Where |
|---|---|---|
| **Crit** | Test runner mutates **live** data; only guard is `TEST_*` being set (they are, on live) | `tests/run.sh:22,39,44,95,105`, live `.env:54-59`, `docs/development.md:64` |
| **High** | A live Kavita account with a default password (`test-uploader`/`ChangeMe123!`) is reachable through the public portal (Critical if still current) | live `.env:55`, `docs/security.md:92`, `tests/README.md:18` |
| **High** | Test stack published on `0.0.0.0` (public) with `NOTIFY_ALLOW_PRIVATE`/`PROVIDERS_ALLOW_PRIVATE=true` — SSRF guards off, on the same host as live | `.env.test.example:21,61,70`, `compose.yaml:43-45` |
| **High** | No CPU/memory/pids limits while the portal decompresses untrusted archives; no host swap → a single upload can OOM-slay co-tenants | `compose.yaml:13-150`, `Dockerfile:24-38` |
| **High** | Kavita / local-build rollback undocumented and unsafe (forward-migrated DB; `kavita-companion:local` has no versioned handle) | `docs/operations.md:44-56,87-88`, `compose.yaml:68-69`, `db.ts:139-172` |
| Med | Backups manual-only, on the same disk, and the archive contains `.env` (all secrets) | `docs/operations.md:19-42`, `scripts/backup.sh:22-24` |
| Med | Kavita/Caddy have no healthcheck; `depends_on` has no readiness condition | `compose.yaml:29,35,50,71` |
| Med | Cert renewal unmonitored; the test stack keeps serving a stale cert after live renews (hardcoded ACME path) | `Caddyfile:22-28`, `Caddyfile.test:22,28`, `.env.test.example:37` |
| Med | All secrets are plain container env vars — readable by anyone in the `docker` group (root-equivalent) | `compose.yaml:76-77,93,102,107,126` |
| Med | `COMPANION_IMAGE` + a `build:` block: `docker compose up -d` silently substitutes a local build for the pinned release | `compose.yaml:67-69`, `docs/operations.md:10` |
| Med | Live and test portals share a hostname → `__Host-kc_session` cookies collide across ports | `src/auth.ts:11`, `.env.test.example:15` |
| Med | `.env` handling corrupts values with `awk`/shell-significant characters (`awk -v`, unquoted source) | `setup.sh:44-49,96`, `scripts/backup.sh:9` |
| Low×6 | digest/version drift, recursive `chown`, unused plaintext HTTP port, Kavita missing container hardening, 50 MB log ring, hand-maintained network constants | (see transcript) |

## 5. Security — repo / CI / supply chain — supply-chain-reviewer

| Sev | Finding | Where |
|---|---|---|
| **High** | Third-party Actions pinned to mutable tags, not SHAs (the Image workflow holds `packages: write`) | `.github/workflows/image.yml:31,33,37,45,55,87,102,108,115`, `ci.yml:17,18` |
| **High** | Image **pushed to GHCR before the Trivy gate** — `latest`/`X.Y` are public when the failing scan blocks CI | `image.yml:54-74` before `:86-95,114-122` |
| **High** | Deploy binds a mutable tag with no digest and no signature; provenance/SBOM published but never verified | live `.env` (`COMPANION_IMAGE=…:0.6.9`), `docs/operations.md:74,81` |
| Med | No CodeQL/SAST on the TypeScript source | `.github/workflows/` (absent) |
| Med | `ci.yml` sets no `permissions:` (token scope = repo default) | `ci.yml` |
| Med | `main` has no branch protection / rulesets | (repo settings; `gh` unavailable) |
| Med | Dependabot has no `pip` entry for the new `mobi` pin | `.github/dependabot.yml`, `Dockerfile:33` |
| Med | Unsigned annotated tags/commits; no GitHub Releases | `git tag`/`GET /releases` |
| Med | No `SECURITY.md` (GitHub security policy) | repo root |
| Low×4 | non-reproducible build (unpinned base/`apk`/`pip --require-hashes`), host details in `.env.test.example`, `ignore-unfixed: true`, `persist-credentials` | (see transcript) |

**Verified good:** **no secrets in the tree or history** (manual scan of every blob reachable from `refs/*`), no `.env` ever committed, live `.env` is `600`+ignored; SBOM + SLSA provenance present on the 0.6.9 image; app deps exactly pinned; no `pull_request_target`/`workflow_run`; PRs never push. *Could not verify:* branch protection, default token scope, Dependabot-alert enablement (no `gh`/token).

## 6. Compliance / licences / provider ToS — compliance-reviewer

| Sev | Finding | Where |
|---|---|---|
| **High** | The **public image ships GPL object code without the GPL text or `NOTICE.md`** (build context excludes repo-root LICENSE/NOTICE) | `Dockerfile:21-39`, `.github/workflows/image.yml:57` |
| **High** | CC BY-SA 4.0 attribution does **not travel into the files** we write (no credit/`dc:source` in ComicInfo/OPF) — contradicts our own `docs/compliance.md:46-51` | `src/metadata.ts:73-109,149+`, `src/review.ts:582,593` |
| **High** | `mobi`/KindleUnpack **source pointer is wrong** (`NOTICE.md` → kevinhendricks; actual PyPI → `iscc/mobi`); transitive `loguru`/`standard-imghdr` unattributed | `Dockerfile:33`, `NOTICE.md:32` |
| Med | `COMPANION_CONTACT_EMAIL` documented but **not implemented** (Open Library UA lacks the required email) | `src/providers/http.ts:16` vs `docs/compliance.md:133` |
| Med | CC BY-SA credit lacks a link to the *material* and any "modified" indication | `src/providers/attribution.ts:11-16` |
| Med | AniList cache: **code default is 30 days**, not the 3 days the docs/compose imply | `src/config.ts:81,129-131` vs `compose.yaml:122` |
| Med | 7-Zip is LGPL — source offer is only a URL (and NOTICE isn't in the image) | `Dockerfile:3-9,26-27` |
| Med | Kavita logo/favicon attribution not shipped + endorsement/trademark implication (styled to "look like Kavita") | `NOTICE.md:11,16`, `public/assets/img/` |
| Low×5 | AniList credit links docs home; credit sign-in-gated; `mobi` is GPL **only**; MangaDex group-credit re-check trigger; TTLs in env not code | (see transcript) |

*Engineering reading, not legal advice.* ComicVine / Google Books verified absent; provider keys never ship; attribution surfaces render (card "Applied from … (CC BY-SA 4.0)" + About → Metadata sources) and all licence links return 200.

## 7. Code architecture / maintainability — code-architect

| Sev | Finding | Where |
|---|---|---|
| **High** | `provider_links` is a **dead subsystem** the docs describe as working (skip re-search, cross-ID ranking) | `src/providers/links.ts:28-44`, `src/review.ts:277-388`, `docs/architecture.md:59,161-162,213` |
| **High** | Kavita `LibraryType` encoded as literals in ≥4 places with different subsets; guard vs media mapping disagree (Light-novel); already shipped two bugs | `src/review.ts:211-215`, `src/uploads.ts:169`, `web/main.js:445,549` |
| Med | `review.ts` is a 1,115-line god module (approval + fix + match/apply + routes) | `src/review.ts` |
| Med | Two divergent metadata validators with duplicated limits (throw vs drop) | `src/review.ts:460-476` vs `src/providers/merge.ts:14-27` |
| Med | The `<Volume>` rule lives in 3 unlinked sites; one shipped as a no-op | `src/review.ts:382,582`, `web/main.js:549` |
| Med | Hand-rolled `reviewDrafts` store: a field is enumerated in ~6 lists; prune assumes every draft is `pending` (fix-mode drafts are discarded on refresh) | `web/main.js:469-473,497-509,837,879,1072-1074` |
| Med | Kindle conversion isn't restart-safe (see qa F7) and its refusal paths are untested | `src/uploads.ts:306-347` |
| Low×7 | inline `db.prepare` drift, duplicated `requireReviewer`/`sha256Of`/SSRF check/`normalizeSeries`, stale throttler docs, no column-migration path for new tables, two `hasKey` definitions, test-tier coupling, `inspect.ts` importing `mobi.ts` | (see transcript) |

## 8. Test quality / gaps — test-quality-reviewer

| Sev | Finding | Where |
|---|---|---|
| **Crit** | SSRF guards never exercised — the test stack disables them, so the refusal branch is dead code | `tests/test_notifications.py:76-77`, `.env.test.example:61,70`, `src/notify.ts:69-84`, `src/providers/http.ts:118-135` |
| **Crit** | Archive-hardening limits have **no test** (entries/symlink/zip-bomb) | `src/archive.ts:14,54-56,74-79,87-100`, `src/review.ts:559-563` |
| **High** | The `../`-escape assertion has an **operator-precedence bug** — can PASS while an escape file exists, or raise | `tests/test_metadata.py:254-255` |
| **High** | No test proves adapters against **real** payloads — synthetic fixtures were then corrected to match the adapter, masking the three shipped bugs | `tests/fixtures/providers/README.md:2-5`, `provider_fake.py:90-150` |
| **High** | Library permission boundary untested (and appears unenforced — `libraryId` validated with the **admin** key) | `src/uploads.ts:161-168`, `src/kavita.ts:27,114,258` |
| **High** | No test runs the full **apply → approve** chain (the 0.6.5 bug class) | `tests/test_providers_match.py:104-152`, `browser/suggestion_card.py` |
| Med×10 | `check(name, True)` no-ops, `test_activity` order dependence, config-coupled constants/sleeps, `--only` skips reset, missing provider 401/404/empty/timeout cases, sniffer edge cases, log redaction untested, no unit tests for pure logic, `or`-fallbacks pass on stale artifacts, no delivery-failure path | `tests/…` |
| Low×6 | fake ignores requested id, lenient safeguard bounds, conditional PASS, `backup.ts` untested, ntfy/discord shapes untested, fast tier documented as write-free but isn't | `tests/…` |

## 9. Security — runtime (appsec) — `docs/reviews/2026-10-17/appsec.md`

| Sev | Finding | Where |
|---|---|---|
| **High** | Notification SSRF guard is **bypassable** (IPv6 literals, trailing-dot hosts, unresolvable-to-loopback DNS names) and `deliver()` **follows redirects** into private space — works even with `NOTIFY_ALLOW_PRIVATE=false` | `src/notify.ts:69-84`, `:86-117` |
| Med | Global rate limit is keyed on **any client-supplied cookie value** → fresh 600/min bucket per request; `/api/health` (unauth) then hammers Kavita with the admin key | `src/server.ts:49-58` |
| Low | Archive extraction is not time-bounded (no `execFile` timeout); safety limits are listing-based (size cap still held under a patched bomb) | `src/archive.ts:24-31,74-85` |
| Low | Session: fixed 12 h TTL, no idle timeout / rotation; survives a Kavita password change; `SESSION_TTL_HOURS` not passed by compose | `src/auth.ts:54-63`, `src/config.ts:32` |
| Low | Several routes return raw `err.message`; `/api/health` discloses backend liveness unauthenticated | `src/notify.ts:182`, `src/review.ts:882,925`, `src/providers/routes.ts:146,201` |

Plus the QA **login-CSRF** gap (`GET /login?apiKey=…`) and `GET /api/review/:id/match`, which performs
outbound provider lookups + cache/audit writes while remaining GET ⇒ CSRF-exempt (cross-site `<img>` can
induce review-card traffic; impact low, reviewer-only).

**Verified good (adversarial, with evidence):** reviewer cannot write outside a library folder
(`isInside` + `safeSegment`), cannot overwrite arbitrary files, upload filenames are display-only (no path
derivation), tus quota/size hold and PATCH cannot exceed declared size, `X-KC-User` cannot be spoofed,
no XML entity expansion / billion laughs, no CRLF header injection, and the provider client is already
`redirect: "error"` + private-host-refusing. *Residual Low:* `toLocalPath` has no containment check of its
own and the stored plan is not re-validated in `runJob` (TOCTOU if a library folder is reconfigured
between plan and execution).

---

## Verified good (don't regress)

- **No secrets in git history**; `.env` never committed; live `.env` `600`+ignored (supply-chain).
- **Auth/ownership/CSRF**: every review/admin route gated (401/403); `X-KC-User` spoofing impossible;
  cross-user access blocked; no `innerHTML` XSS surface (qa "Verified-correct").
- **Write-path safety**: traversal sanitised to one path segment; `<Volume>` stripped for comics;
  `Series` forced to the folder; `PageCount` corrected; approve/fix races → `409`/`already exists`.
- **Good UX baseline**: happy-path console/network clean on all 7 tabs × 2 viewports × 3 roles; forms
  labelled; AA contrast; phone reflow; the Find-metadata dialog is properly labelled and keyboard-closable
  (ui "Verified good").
- **CI/supply chain strengths**: SBOM+provenance on the image; app deps exactly pinned; no dangerous
  triggers; coherent GPL licensing.

## Coverage limits

No screen-reader session or 200% zoom pass; Chromium only; rate-limit UI and notification delivery not
exercised; Metron/Hardcover real schemas not re-verified (auth); live `COMPANION_IMAGE` digest not checked
against a signature. The SSRF bypasses were proven against the shipped image under production defaults (the
test stack has the guard off), not end-to-end through the test portal. Full per-area limits are in the three
raw files.

---

## Remediation plan

Owners are the review roles. Estimates are elapsed effort. **P0 items touch live-exposure or data loss and
should precede any further release.**

### P0 — do first (live exposure / data loss)
1. **Guard the test runner against the live stack** (ops): refuse when `COMPOSE_PROJECT_NAME=kavita` or
   `MEDIA_ROOT`/`DATA_ROOT` resolve to live, unless `--allow-live`; add a check in `tests/run.sh` +
   `tests/settings.py`. *(owner: ops; ~1–2 h)*
2. **Remove/rotate the live test accounts** and the default uploader password; update `docs/security.md`
   and `tests/README.md`. *(ops; ~0.5 h)*
3. **Stop publishing the test stack publicly** or keep the relaxed SSRF flags off the public interface
   (bind test ports to the gateway/localhost or gate them). *(ops; ~0.5–2 h)*
4. **Container resource limits** (`mem_limit`/`cpus`/`pids_limit`/`ulimits`) for all services. *(ops; ~0.5 h)*
5. **Fix the converted-Kindle download** — set `Content-Length` from `stat(stored_path)` and refresh
   `uploads.size` to the EPUB on conversion. *(qa/metadata; ~1 h + test)*
6. **Blank-page/`/api/me` resilience** — wrap bootstrap, always show a view, distinguish 401 vs 5xx.
   *(ui-ux; ~1 h)*
7. **Scan before push** in the image workflow; **pin Actions to SHAs**; deploy by **digest**. *(supply-chain;
   ~2–3 h)*
8. **Close the notification SSRF bypass** — reject bracketed IPv6 and strip trailing dots, resolve the host
   and check every resolved address, set `redirect:"error"` on `deliver()`, and require `canUpload` on
   `/api/notifications/test`. *(appsec; ~2–3 h + tests)*
9. **Agent-responses note:** (process, non-code) — see appendix.

### P1 — correctness / security (next pass)
9. Archive-expansion limit proportional to the upload + per-entry cap + listed-size disk pre-check; vet
   archives (traversal/symlink/entry-cap) at upload, not at Approve. *(metadata/ops; ~0.5 day + tests)*
10. Corroborate the EPUB `mimetype` fast path with a successful archive open. *(metadata; ~2 h + test)*
11. `apply` fill must treat per-file `Number`/`Title`/`Summary`/`Volume` as `current` (conflicts, not
    fills). *(metadata; ~2 h + test)*
12. Honour `refresh` in `/apply` (delete the cached record like the preview route). *(metadata; ~1 h + test)*
13. Skip (don't sleep) a long `Retry-After`, as the token bucket now does. *(metadata; ~1 h + test)*
14. Strip C0 control chars before writing ComicInfo/OPF. *(metadata; ~1 h + test)*
15. One shared `libraryTypeKind(type)`; make the Kindle guard accept Light-novel; fix the library
    file-type whitelist check at plan/approve. *(code-architect; ~2 h)*
16. Ship `LICENSE`+`NOTICE.md` in the image; correct the `mobi` source pointer + transitive deps; write a
    CC BY-SA credit into the files we create. *(compliance; ~0.5 day)*
17. Decide the dead `provider_links` subsystem: wire it or delete it and fix `docs/architecture.md`.
    *(code-architect; ~0.5–1 day, owner's call)*
18. Rollback docs for Kavita/portal (digest pinning, restore path); schedule + off-site the backups and
    stop shipping `.env` inside the backup archive. *(ops; ~0.5 day)*
19. Test-gap batch: SSRF guard test, archive-safety fixtures, sniffer negatives, resume test, full
    apply→approve chain, fix the `../` assertion bug. *(test-quality; ~1 day)*

### P2 — medium (schedule)
- UI failure states (M2/M3/M11), Notifications tab (M1), Activity labels (M4), key-field a11y (M5),
  `aria-modal` isolation (M6), dropped-source note (M7).
- Ops: healthchecks, cert-expiry monitoring, secret injection, build-vs-image guard, cookie isolation,
  `.env` quoting.
- Code: split `review.ts`; unify the two validators; single home for the `<Volume>` rule; fix the
  `reviewDrafts` prune invariant.
- AppSec: rate-limit key on a validated session (F2), extraction timeout / byte cap (F3), session
  TTL/idle/rotation (F4), generic client error messages + gate `/api/health` (F5).

### P3 — low / polish
The `Low` rows above: UI polish list, code-architect Low list, docs drift (throttler already fixed; update
`docs/metadata-providers.md`), test Low list.

---

## Appendix — agents, artifacts, provenance

- **Agents created/extended this review** (durable, in `~/.config/opencode/agents/`): `metadata-reviewer`,
  `code-architect`, `test-quality-reviewer`, `appsec-redteam`, `supply-chain-reviewer`, `ops-reviewer`,
  `ui-ux-reviewer`, `qa-reviewer`, `compliance-reviewer`.
- **Raw artifacts:** `docs/reviews/2026-10-17/ui-ux.md` (326 lines, 61 screenshots in `ui-ux-shots/`),
  `qa.md` (471 lines), `appsec.md` (361 lines). Wave-1 areas' detail is synthesised above; per-area raw text
  was returned by the reviewers and condensed here.
- **Test data left as evidence** (test stack only, safe to delete): `qa.md` §"Environment / artifacts"
  (the F2 126 MB artifact, the F1 converted book, the F3 forged EPUB). Everything else was withdrawn.
- **Process note:** the first parallel burst of six long agent reports flooded the session; we switched to
  **file-based findings + short summaries + sequential stack reviewers** mid-review. That transport is the
  recommended default for the next review.
