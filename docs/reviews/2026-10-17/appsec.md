# AppSec review — kavita-companion runtime attack surface (area 5)

**Date:** 2026-10-17 · **Reviewer:** security subagent (area 5) · **Repo:** `/srv/kavita` (read-only)
**Target:** test stack only (`kavita-test`, portal `https://kavita.example.com:20006`). Live stack never touched.
**Scope:** auth/session handling (`src/auth.ts`, `src/server.ts`), tus upload path (`src/uploads.ts`,
`src/archive.ts`), SSRF/outbound (`src/providers/http.ts`, `src/notify.ts`), review/apply/fix writes
(`src/review.ts`), CSRF/Origin, error-message leaks.
**Method:** code read of `kavita-companion/src/*` (paths below are relative to `kavita-companion/`) +
read-only probes against the test portal + scratch containers running the **deployed** image
(`ghcr.io/hsabort/kavita-companion:0.2.4` / `kavita-companion:test`) to exercise the shipped build.
**Excluded by prior pass:** the QA reviewer already reported `GET /login?apiKey=…` (login CSRF); this
report cross-references it and does not re-litigate it.

---

## Summary

| # | Severity | Title | Location |
|---|----------|-------|----------|
| F1 | **High** | Notification SSRF guard is bypassable (IPv6 / trailing-dot / DNS) and outbound delivery follows redirects into private space | `src/notify.ts:69-84`, `:86-117` |
| F2 | **Medium** | Global rate limit is keyed on any client-supplied cookie value → trivially bypassed | `src/server.ts:49-58` |
| F3 | **Low** | Archive extraction is not time-bounded (no `execFile` timeout); limits are listing-based | `src/archive.ts:24-31`, `:74-85` |
| F4 | **Low** | Session lifetime: fixed 12 h TTL, no idle timeout / rotation; survives a Kavita password change; TTL not operator-settable via compose | `src/auth.ts:54-63`, `src/config.ts:32` |
| F5 | **Low** | Several routes return raw `err.message` to the client; `/api/health` discloses backend liveness unauthenticated | `src/notify.ts:182`, `src/review.ts:882,925`, `src/providers/routes.ts:146,201` |

Verified-negative sections (with evidence) are at the end; they answer the specific questions in the
brief (write-path escape, overwrite, tus quota/PATCH bypass, filename traversal, XML entity expansion,
CRLF header injection).

---

## F1 — HIGH — Notification SSRF guard is bypassable; outbound delivery follows redirects into private space

**Where:** `src/notify.ts:69-84` (`safeTarget`), reachable from `src/notify.ts:150-171`
(`POST /api/notifications`, gated by `user.canUpload`) and triggered by `POST /api/notifications/test`
(`src/notify.ts:173-184`, any signed-in user) and automatically by every approve/reject/fix/request event
(`notifyUploader`, `src/notify.ts:136-141`). The actual request is `deliver()` at `src/notify.ts:86-117`.

**Problem.** `safeTarget` is the *only* SSRF control for user-supplied notification targets. It is a
string-prefix filter on `url.hostname` (`src/notify.ts:79-83`) and never resolves the host, so:

1. **IPv6 hosts are not matched at all.** `url.hostname` for an IPv6 literal keeps the square brackets,
   so `host === "::1"` (line 80) never matches `[::1]`; `[::ffff:127.0.0.1]`, `[fd00::1]`, `[fe80::1]`
   and bare `[::]` all pass.
2. **A trailing dot bypasses the hostname checks.** `localhost.` is not `localhost`, not `*.localhost`,
   and does not match `/^127\./` — yet it resolves to loopback.
3. **DNS names are never resolved.** `localtest.me`, `lvh.me` (both resolve to `127.0.0.1`) and any
   internal compose DNS name with no dot (e.g. `kavita`) pass the filter.
4. **Redirects are followed.** Unlike the provider client (`redirect: "error"`,
   `src/providers/http.ts:180`), `deliver()`'s `fetch` calls (`src/notify.ts:92, 99, 106`) pass no
   `redirect` option, so a *legitimately allowed* public HTTPS target that returns a `302` to
   `http://127.0.0.1/…` or `http://169.254.169.254/…` is followed. This bypass does not depend on the
   hostname filter at all and therefore still works with `NOTIFY_ALLOW_PRIVATE=false`.

The authors clearly consider this a real risk (the guard exists, `src/notify.ts:64-68`), so a bypass is a
broken control, not a missing one.

### Evidence 1a — the deployed `safeTarget` accepts private hosts (run against the shipped image, production setting)

```
$ cat /tmp/opencode/realsafe.mjs
const { safeTarget } = await import("/app/dist/notify.js");
const cases = ["https://localhost/","https://127.0.0.1/","https://[::1]/","https://[::ffff:127.0.0.1]/",
"https://[fd00::1]/","https://localhost./","https://localtest.me/","https://lvh.me/","https://kavita:5000/","https://evil.example/"];
for (const c of cases) console.log(String(safeTarget(c)).padEnd(34), "<=", c);

$ docker run --rm -e NOTIFY_ALLOW_PRIVATE=false -e KAVITA_AUTH_KEY=dummy \
    -e PUBLIC_ORIGIN=https://portal.example -v /tmp/opencode/realsafe.mjs:/r.mjs \
    ghcr.io/hsabort/kavita-companion:0.2.4 node /r.mjs
null                               <= https://localhost/
null                               <= https://127.0.0.1/
https://[::1]/                     <= https://[::1]/
https://[::ffff:7f00:1]/           <= https://[::ffff:127.0.0.1]/
https://[fd00::1]/                 <= https://[fd00::1]/
https://localhost./                <= https://localhost./
https://localtest.me/              <= https://localtest.me/
https://lvh.me/                    <= https://lvh.me/
https://kavita:5000/               <= https://kavita:5000/
https://evil.example/              <= https://evil.example/
```

Host resolution check for the DNS-based bypass:

```
$ getent hosts localtest.me lvh.me
127.0.0.1       localtest.me
127.0.0.1       lvh.me
```

### Evidence 1b — end-to-end: guard passes, `fetch` follows the redirect to loopback and reads internal data

A scratch container (same node runtime as the image) runs an "internal" HTTP service on `127.0.0.1:9001`
and a TLS endpoint on `127.0.0.1:9443` that `302`s to it. The script uses the **verbatim** `safeTarget`
guard with `NOTIFY_ALLOW_PRIVATE=false`, then does exactly what `deliver()` does (plain `fetch`, POST, no
`redirect` option):

```
$ docker run --rm -e NODE_TLS_REJECT_UNAUTHORIZED=0 -v /tmp/opencode/ssrf-proof:/proof \
    ghcr.io/hsabort/kavita-companion:0.2.4 node /proof/proof.mjs
safeTarget('https://localhost.:9443/hook') => https://localhost.:9443/hook (guard PASSED, not null)
fetch status: 200 | redirected to: http://127.0.0.1:9001/secret
body read from internal loopback service: INTERNAL-ONLY 169.254.169.254 credentials
```

So an uploader-supplied target (`https://<their-host>/hook`) is accepted, the server issues the request,
follows a `302` into loopback, and reads the internal response.

### Reachability / impact

- Setting the target needs only `canUpload` (`src/notify.ts:153`); *triggering a delivery* needs only a
  signed-in session, because `POST /api/notifications/test` has **no `canUpload` check**
  (`src/notify.ts:173-184`) — a user downgraded from uploader to Read Only keeps their stored prefs and
  can still fire the fetch.
- Once a target is stored, delivery also fires automatically on approve/reject/fix/request events, so no
  attacker action is needed after setup.
- Reachable internal surfaces: the compose network (`kavita:5000` = Kavita's API with the caller's/admin
  context), the Docker gateway (`172.x.0.1`), loopback services in the container, `169.254.169.254`
  (cloud metadata) and any RFC1918 service the shared host can reach. The container is on a shared
  Incus/LXC host (`.env`: `DOCKER_SUBNET=172.31.0.0/24`), which broadens the blast radius.
- Note on config: the **test** stack sets `NOTIFY_ALLOW_PRIVATE=true` (guard off); the live `.env` does
  not set it, so production relies on this guard (`src/config.ts:43`).

### Remediation (suggested)

- Reject bracketed IPv6 (`host.startsWith("[")`) and strip a trailing dot before matching; treat
  `localhost.`, `*.localhost.` and `*.internal` the same.
- Resolve the hostname and check **every** resolved address against loopback/link-local/private ranges at
  connect time (or pin the resolved IP and connect to it), rather than trusting the name.
- Add `redirect: "error"` to `deliver()`'s `fetch` calls (match `providers/http.ts:180`); or re-run
  `safeTarget` on each redirect target.
- Require `canUpload` on `POST /api/notifications/test` and re-validate `prefs.target` there.
- Long term: consider an egress allow-list, since the guard is inherently a heuristic.

---

## F2 — MEDIUM — Global rate limit keyed on any client-supplied cookie value → bypass

**Where:** `src/server.ts:49-58`:

```ts
keyGenerator: (request) => {
  const token = request.cookies[SESSION_COOKIE];
  return token ? "s:" + createHash("sha256").update(token).digest("hex") : "ip:" + request.ip;
},
```

**Problem.** The bucket key is the SHA-256 of *whatever* `__Host-kc_session` value the client sends,
**including a value that is not a real session**. An unauthenticated attacker therefore gets a fresh
600-req/min bucket simply by sending a different cookie on each request — removing the general ceiling
entirely. (The stricter per-IP login lockout in `src/server.ts:100-118` is separate and still applies to
sign-in, so this is not a login-brute-force bypass.)

**Impact.** `/api/health` (`src/server.ts:87-95`) is unauthenticated and calls Kavita
(`kavita.libraries()`, uncached) on every request, so a single attacker host can drive the portal to
hammer Kavita with the companion's admin key — amplification/DoS, and loss of the general rate-limiting
control on all unauthenticated routes.

### Evidence

```
$ P=https://kavita.example.com:20006
$ echo "--- same cookie x5 (counts down normally) ---"
  for i in 1 2 3 4 5; do curl -sk "$P/api/health" -H "Cookie: __Host-kc_session=$TOK" ...; done
x-ratelimit-remaining: 599
x-ratelimit-remaining: 598
x-ratelimit-remaining: 597
x-ratelimit-remaining: 596
x-ratelimit-remaining: 595
$ echo "--- a unique cookie per request: every request gets a fresh bucket ---"
x-ratelimit-remaining: 599     (cookie A)
x-ratelimit-remaining: 599     (cookie B)
x-ratelimit-remaining: 599     (cookie C)
$ echo "--- no cookie (shared per-IP bucket) ---"
x-ratelimit-remaining: 596
x-ratelimit-remaining: 595
x-ratelimit-remaining: 594
```

### Remediation

Key on a *validated* session only (`currentUser(request)` → user id), and fall back to `request.ip` for
unknown/invalid cookies; e.g. `const u = currentUser(request); return u ? "u:"+u.id : "ip:"+request.ip;`.

---

## F3 — LOW — Archive extraction is not time-bounded; safety limits are listing-based

**Where:** `src/archive.ts:24-31` (`sevenZip` → `execFile` with `maxBuffer` but **no `timeout`**),
`src/archive.ts:74-85` (`extractAll` computes the total from the 7-Zip listing *before* extracting),
`src/archive.ts:87-100` (`verifyTree` runs *after* `x` completes).

**Problem.** `extractAll` is invoked on approve/fix (`src/review.ts:563`) with
`maxTotalBytes = max(size*3, size+1GB)`. The cap is derived from the archive-declared uncompressed sizes;
nothing bounds bytes actually written or wall-clock during `7zzs x`. A pathological archive could spin
7-Zip (no timeout) and stall the single approval worker (`enqueueApproval`, `src/review.ts:671-681`).

**I tried to break the size cap and could not** — a zip whose declared uncompressed size is patched down
to 100 B is *truncated* by 7-Zip to the declared size, so the listing-based limit holds:

```
$ python3 /tmp/opencode/zb/mk.py        # 60 MB of zeros, then patch declared uncompressed size to 100
patched -> file size on disk: 61271
$ docker run --rm -v /tmp/opencode/zb:/z --entrypoint sh ghcr.io/hsabort/kavita-companion:0.2.4 -c '
    7zzs l -slt -ba -- /z/bomb.zip | grep -E "^(Path|Size)"
    rm -rf /z/out; 7zzs x -y -o/z/out -- /z/bomb.zip; echo "exit=$?"; du -sh /z/out'
Path = page1.jpg
Size = 100
exit=2
4.0K    /z/out          # only 100 B written, not 60 MB
```

So this is a **hardening gap (timeout / streaming byte cap)**, not a demonstrated bomb. It is only
triggered by an admin approving a hostile file (`listEntries` under `x` is the only automatic path, and
it is bounded by `MAX_ENTRIES=20000` and a 64 MB `maxBuffer`).

### Remediation
Add `timeout` to the `execFile` options for `x` (and `l`), and cap bytes written during extraction (e.g.
`du`/`statfs` sampling or extracting with a bounded `--`, or a per-entry size re-check).

---

## F4 — LOW — Session lifetime / token handling hardening

**Where:** `src/auth.ts:49-64` (`createSession`), `:54` (`ttlMs`), `:57-63` (cookie),
`src/config.ts:32` (`sessionTtlHours ?? 12`), `src/auth.ts:103-122` (`recheckSessionRoles`).

Notes (all Low):
- Fixed 12 h absolute TTL, no idle timeout and no rotation; the cookie `maxAge` mirrors the DB
  `expires_at` (`src/auth.ts:57-63`), so the server-side check is consistent. Token entropy is good
  (32 random bytes → `token_hash` SHA-256).
- A portal session outlives a **Kavita password change**: `recheckSessionRoles` only revokes on the
  Kavita *Login* role disappearing or the user being deleted (`src/auth.ts:115-120`); it does not notice
  a credential rotation. The stored Kavita refresh token (`kavita_refresh`) is long-lived.
- `SESSION_TTL_HOURS` is supported by `config.ts` but **not passed by `compose.yaml`**
  (`grep -n SESSION_TTL_HOURS compose.yaml` → no match), so operators cannot tune it via `.env` even
  though the code implies they can. Cosmetic + policy gap.
- `POST /api/login` does not call `endSession` first (`src/server.ts:155`), unlike `GET /login`
  (`src/server.ts:185`), leaving the previous session row alive until it expires (not exploitable without
  the old token; worth tidying).

**Remediation:** wire `SESSION_TTL_HOURS` into compose; consider an idle timeout and revoking portal
sessions on Kavita credential change; call `endSession` on password sign-in.

---

## F5 — LOW — Error-message information leaks

**Where / what is returned verbatim to the client:**
- `src/notify.ts:182` — `POST /api/notifications/test` returns `err.message` of the failed fetch (any
  signed-in user).
- `src/review.ts:882` and `:925` — `GET /api/review/:id/match` / `POST /apply` 500s return `err.message`
  (reviewer).
- `src/providers/routes.ts:146` and `:201` — provider test/preview return `err.message` (reviewer).
- `src/server.ts:87-95` — `/api/health` is unauthenticated and discloses backend reachability.

**Assessment (Low).** Probes show Fastify's default errors carry no internals, and undici's failed-fetch
message is the generic `"fetch failed"`, so the practical leak is small; the risk is that a future fs/
provider error string (e.g. an `ENOENT … '/media/…'` or an internal URL) is surfaced to a
reviewer/owner. `/api/health` reveals backend liveness to anonymous callers.

### Evidence — probes

```
$ curl -sk -X POST "$P/api/login" -H "Origin: $O" -H 'content-type: application/json' -d '{bad'
{"statusCode":400,"code":"FST_ERR_CTP_INVALID_JSON_BODY","error":"Bad Request","message":"Body is not valid JSON but content-type is set to 'application/json'"}
$ curl -sk -X POST "$P/api/login" -H "Origin: $O" -H 'content-type: application/json' -d '{"username":"a"}'
{"statusCode":400,"code":"FST_ERR_VALIDATION","error":"Bad Request","message":"body must have required property 'password'"}
$ curl -sk "$P/api/health"
{"ok":true,"kavita":"reachable"}
```

**Remediation:** return generic messages to clients and log the detail; gate `/api/health` (or return a
constant body) if liveness disclosure matters.

---

## CSRF / Origin — control works; one known gap cross-referenced

`src/server.ts:75-80` refuses every non-`GET`/`HEAD`/`OPTIONS` request whose `Origin` is not
`config.publicOrigin` (missing Origin included). Verified on the test stack, including the tus routes:

```
$ curl -sk -X POST "$P/api/login" -H 'content-type: application/json' -d '{"username":"x","password":"y"}'
{"error":"Cross-origin request refused"}          HTTP 403
$ curl -sk -X POST "$P/api/login" -H 'Origin: https://evil.example' -d '{"username":"x","password":"y"}'
{"error":"Cross-origin request refused"}          HTTP 403
$ curl -sk -X POST "$P/files" -H 'Tus-Resumable: 1.0.0'
{"error":"Cross-origin request refused"}          HTTP 403
```

Gaps (no re-report of the QA finding):
- **`GET /login?apiKey=…` is state-changing but `GET` ⇒ exempt** (`src/server.ts:174-190`) — login CSRF,
  already filed by QA.
- **`GET /api/review/:id/match`** (`src/review.ts:885`) performs outbound provider lookups and writes the
  metadata cache + an audit row, yet is a `GET`, so it is CSRF-exempt. Impact is low (reviewer-only; the
  response is not readable cross-site), but a cross-site `<img>` can induce the review card's provider
  traffic.

---

## Verified negatives (checked, no finding)

These directly answer the questions in the brief; each has a code path or a test.

1. **Reviewer cannot write outside a library folder.**
   `planApproval` requires the chosen library from Kavita (`src/review.ts:488-489`), maps its folder to a
   local root (`:490`), builds `seriesDir` from the existing series' folder or a `safeSegment`ed name
   (`:493-504`), then enforces `isInside(seriesDir, libraryRoot)` (`:505`) and
   `isInside(destination, seriesDir)` (`:507`). `isInside` appends the separator (`src/review.ts:126`), so
   prefix-siblings (`/media/comics-evil`) do not pass. Series/file names are sanitised of `/ \ .. : * ?`
   etc. by `safeSegment` (`src/review.ts:99-105`). The EPUB OPF target is likewise contained
   (`src/review.ts:591-592`, `isInside(opfFile, work)`).
   *Residual (Low):* `toLocalPath` (`src/review.ts:116-120`) has no containment check of its own and
   relies on callers' `isInside`; the stored plan is not re-validated in `runJob`
   (`src/review.ts:611-624`) — a TOCTOU if a library folder is reconfigured between plan and execution.
   Suggest making `toLocalPath` return `null` when the resolve escapes `mediaDir`.
2. **Reviewer cannot overwrite arbitrary files.** Existence of the destination is refused unless it is the
   very file being fixed (`src/review.ts:509-511`, re-checked in `runJob` `:617-618`).
3. **Filename traversal in uploads.** The upload `filename` is display-only (`src/db.ts:34`); on disk the
   file is `pending/<tus-id>.<ext>` with `ext` from the fixed allow-list (`src/uploads.ts:155-157`,
   `:305`). No path derivation from the client name.
4. **tus quota / size limits hold, and PATCH cannot exceed the declared size.** `onUploadCreate` enforces
   known size, `maxFileGb`, library type, per-user concurrent/pending quotas and free disk
   (`src/uploads.ts:146-192`); `maxSize` is set (`:141`). The `@tus/server@2.4.5` `PatchHandler` calls
   `calculateMaxBodySize`, which caps a PATCH at `upload.size` (verified in
   `/app/node_modules/@tus/server/dist/handlers/BaseHandler.js:180-207`).
5. **Client cannot spoof the tus uploader identity.** The handler strips any client-sent `x-kc-user` from
   `rawHeaders` and re-adds it from the session (`src/uploads.ts:377-385`), and checks ownership for
   `/files/:id` (`:371-374`).
6. **No XML entity-expansion (billion laughs) in ComicInfo/OPF parsing.** `fast-xml-parser@5.11.2` with
   `processEntities: true` (`src/metadata.ts:25-31`) leaves DOCTYPE-defined entities unexpanded:
   ```
   $ docker exec -i kavita-test-kavita-companion-1 node --input-type=module < /tmp/opencode/xmlbomb.mjs
   input bytes: 555
   expanded Series length: 4 | ms: 17 | heap delta MB: 0.2     # "&a8;" left literal
   ```
7. **No CRLF header injection via the ntfy `Title` header.** `deliver()` puts user-controlled text in the
   `Title` header (`src/notify.ts:94`), but undici rejects invalid header values:
   ```
   $ docker exec -i kavita-test-kavita-companion-1 node --input-type=module < /tmp/opencode/hdr.mjs
   Threw: TypeError - Headers.append: "ok
   X-Injected: 1" is an invalid header value.
   ```
8. **Outbound provider client is not redirect- or private-host-permissive.** `providerFetch` sets
   `redirect: "error"` (`src/providers/http.ts:180`) and `assertAllowedProviderUrl` refuses private/
   non-https bases unless `PROVIDERS_ALLOW_PRIVATE` (`:117-135`); provider base URLs are operator-set, not
   user input, so the same hostname-heuristic weakness as F1 is far less exposed here.

---

## Coverage & limitations

- No live-stack traffic; all portal probes were read-only `GET`/unauthenticated `POST`s against the test
  portal. The SSRF/archive proofs used scratch containers and the deployed image, so no test-stack state
  (uploads, prefs, DB) was modified.
- The SSRF guard is **disabled on the test stack** (`NOTIFY_ALLOW_PRIVATE=true`), so the bypasses were
  proven against the real `dist/notify.js` under the production default (`NOTIFY_ALLOW_PRIVATE=false`)
  rather than by an end-to-end call through the test portal (which would have required writing test-account
  notification prefs).
- Not covered here: UI/XSS surface of `web/`, container/host hardening (cap-drops, read-only rootfs —
  area 5 config review), provider ToS/attribution (area 3), and the QA test-gap matrix (area 2).
