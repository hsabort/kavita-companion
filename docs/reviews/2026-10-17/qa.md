# QA review — adversarial pass (kavita-companion, test stack)

**Date:** 2026-10-17 · **Reviewer:** QA agent (adversarial: edge cases, negative tests, fuzzed uploads,
failure injection, partial failure, permission boundaries)
**Target:** `/srv/kavita-test` (test worktree @ `2749325`, release 0.6.9) · portal `https://paragon.greyarea.contact:20006`
**Never used:** the live stack (`…:20004`) — verified reachable but untouched.
**Method:** read `kavita-companion/src/*.ts`, then black-box probes over the portal + tus API (Python/curl),
plus in-container `7zzs` experiments. Repo untouched; no code or tests changed.

Severity: **Critical** = data loss/security · **High** = feature broken for a user/admin · **Medium** =
correctness/abuse with real cost · **Low** = rough edge/nit. Every finding has a repro and a
"what does the test suite already do" note, so a fix can be paired with a regression test.

---

## F1 — HIGH — A converted MOBI/AZW book cannot be downloaded (wrong `Content-Length`); review card and upload list show the wrong size

**Where:** `src/uploads.ts` (`checkCompletedUpload` → `q.setPending` keeps the *uploaded* size when the
stored file becomes a converted EPUB) + `src/review.ts:966-975` (`/api/review/:id/download` sets
`Content-Length: row.size`).

A Kindle upload is converted to EPUB on completion, but `uploads.size` is never updated, so the row
declares the **MOBI's** size while `stored_path` points at the (smaller or larger) **EPUB**. The
download route then announces a Content-Length that does not match the file it streams.

### Repro (copy-pasteable)

```bash
cat > /tmp/mobi_upload.py <<'PY'
import base64, json, ssl, time, urllib.request, urllib.error
ORIGIN = "https://paragon.greyarea.contact:20006"
CTX = ssl._create_unverified_context()          # self-signed chain on the test stack
data = open("/srv/kavita-test/tests/fixtures/sample.mobi", "rb").read()   # 9122 bytes
b64 = lambda v: base64.b64encode(str(v).encode()).decode()

def req(method, url, body=None, headers=None):
    r = urllib.request.Request(url, body, headers or {}, method=method)
    try:
        with urllib.request.urlopen(r, context=CTX) as x: return x.status, dict(x.headers), x.read()
    except urllib.error.HTTPError as e: return e.code, dict(e.headers), e.read()

_, hd, _ = req("POST", ORIGIN + "/api/login",
               json.dumps({"username": "test-uploader", "password": "<TEST_UPLOADER_PASSWORD>"}).encode(),
               {"Content-Type": "application/json", "Origin": ORIGIN})
cookie = [v for k, v in hd.items() if k.lower() == "set-cookie"][0].split(";")[0]

_, hd, _ = req("POST", ORIGIN + "/files", None, {
    "Origin": ORIGIN, "Cookie": cookie, "Tus-Resumable": "1.0.0",
    "Upload-Length": str(len(data)),
    "Upload-Metadata": f"filename {b64('QA Kindle 01.mobi')},libraryId {b64(3)}",   # 3 = Books
})
loc = hd["Location"] if hd["Location"].startswith("http") else ORIGIN + hd["Location"]
req("PATCH", loc, data, {"Origin": ORIGIN, "Cookie": cookie, "Tus-Resumable": "1.0.0",
                         "Upload-Offset": "0", "Content-Type": "application/offset+octet-stream"})
uid = loc.rsplit("/", 1)[1]
_, _, body = req("GET", ORIGIN + "/api/uploads", None, {"Origin": ORIGIN, "Cookie": cookie})
for _ in range(60):                                # wait for the conversion + the hash
    row = next((u for u in json.loads(body)["uploads"] if u["id"] == uid), None)
    if row and row["status"] != "checking": break
    time.sleep(1)
    _, _, body = req("GET", ORIGIN + "/api/uploads", None, {"Origin": ORIGIN, "Cookie": cookie})
print("upload id:", uid, "| status:", row and row["status"], "| declared size:", row and row["size"])
PY
python3 /tmp/mobi_upload.py
```

If it prints `status: duplicate`, a previous run left the same MOBI pending (duplicate detection keys on
the *source* checksum); withdraw that one first (`DELETE /api/uploads/<old-id>`) and re-run. It should
print `status: pending | declared size: 9122`.

Then, as **admin** (`curl -c admin.jar … /api/login` with the admin test account):

```bash
curl -sk -b admin.jar -D - -o out.epub --max-time 15 \
  "https://paragon.greyarea.contact:20006/api/review/<upload-id>/download"
# -> hangs, exit 28, out.epub not created (no bytes at all through Caddy/H2)
```

Same endpoint over HTTP/1.1 inside the companion container (no Caddy buffering):

```bash
docker exec kavita-test-kavita-companion-1 sh -c \
  "wget -S -T 8 --header 'Cookie: <admin __Host-kc_session cookie>' \
   -O /tmp/dl.epub 'http://127.0.0.1:3000/api/review/<upload-id>/download'"
```

### Observed

* Upload id `fab7d35f06dfefd2c3748e1f609bd6bb` (`QA Repro Kindle 01.mobi`):
  * `uploads.size` (and `GET /api/uploads` → `"size": 9122`) = the **MOBI**;
  * the stored file `/srv/media-test/.incoming/pending/fab7d35f….epub` is **1922 bytes** and is a valid EPUB;
  * download response: `HTTP/1.1 200 OK` + `content-length: 9122`, then
    `wget: connection closed prematurely`, 1922 bytes written, `wget exit=1`;
  * through Caddy/HTTP2 (what the browser does): **0 bytes received**, curl `exit 28` (timeout), while
    the server logs `"statusCode":200 … "request completed"` in ~1 ms;
  * Python `urllib` → `http.client.IncompleteRead(1922 bytes read, 7200 more expected)`.
* Control, same route with a normal pending `.cbz` (`ceeccb41…`, declared = actual = 4825): downloads
  fine, 4825 bytes.
* Second symptom: the review card (`web/main.js:885` renders `<a href="/api/review/<id>/download">Download</a>`)
  and the upload list both display **9122 B** for a 1922 B book, and the reviewer can never open the file
  they are being asked to approve.
* `row.size` is also what `Content-Disposition`/UI copy surfaces, so every consumer of `size` is wrong
  for converted books (only `/api/review/:id/download` turns it into a hard failure).

### Expected

The stored file's real size (`stat(stored_path)`) is what `Content-Length` must announce — or `size`
must be refreshed to the EPUB's size when `checkCompletedUpload` sets the row pending (which also fixes
the displayed size). The download then returns a complete, valid EPUB.

### Why the suite missed it

`tests/test_uploads.py:227-233` only asserts a converted book reaches `pending` with `kind == "epub"`,
and `tests/test_review.py:122` only downloads a **CBZ** (where declared == actual). **No test downloads
a converted Kindle book.** Proposed regression test: after the MOBI/AZW3 upload passes, `GET
/api/review/:id/download` as admin and assert `len(body) == int(Content-Length)` and that the body opens
as a zip whose first entry is `mimetype`.

---

## F2 — MEDIUM — Zip-bomb amplification: the approval guard permits ~1 GB of expansion for *any* upload; a 122 KB CBZ became a 126 MB file in the library (1028×)

**Where:** `src/review.ts:556-563`

```js
const s = await statfs(config.incomingDir);
if (s.bavail * s.bsize < size * 2.2 + config.minFreeDiskGb * GB) throw 507;   // uses the COMPRESSED size
const maxExpanded = Math.max(size * 3, size + GB);                            // floor of +1 GB
const entries = await extractAll(source, work, maxExpanded);
```

The `size + GB` floor means a tiny archive may expand to just under 1 GB, and the pre-flight disk check
uses the *compressed* size, so it cannot see that expansion. `extractAll` then writes the expanded tree
into the work dir, and `createZip` writes the repacked copy **uncompressed** into the library
(`createZip` default `compressRest: false`) — so each approval costs ≈2× the expansion plus the library
copy.

### Repro

```bash
python3 - <<'PY'
import zipfile
z=zipfile.ZipFile("/tmp/bomb.cbz","w",zipfile.ZIP_DEFLATED,compresslevel=9)
zi=zipfile.ZipInfo("001.png"); zi.compress_type=zipfile.ZIP_DEFLATED
z.writestr(zi, b"\x89PNG\r\n\x1a\n" + b"\0"*(120*1024*1024))   # 120 MB of zeros
z.close()
PY
# upload /tmp/bomb.cbz as a Comics-library .cbz (any uploader), then approve it with
#   POST /api/review/<id>/approve {"libraryId":2,"seriesName":"QA Bomb","filename":"QA Bomb 001"}
```

### Observed

* uploaded **122,431 bytes** → approved in 2.2 s → library file
  `/srv/media-test/comics/QA Bomb 2026-10-17/QA Bomb 001.cbz` = **125,829,620 bytes** (ratio **1028×**),
  entries `001.png` (125,829,128 B) + `ComicInfo.xml`.
* `extractAll` wrote the same ~120 MB a second time into the work dir (peak ≈ 240 MB from a 122 KB upload).
* The uploader needs no reviewer rights and stays inside its own quotas (pending cap is 50 GB/user);
  the reviewer's single click is what materialises the disk cost, and repeat clicks are unlimited.

### Expected

A guard proportional to the upload (e.g. `min(size * 10, 200 MB)` per archive, plus a per-entry cap and
a total cap), and the pre-flight disk check based on the **listed** expansion (`extractAll` already
computes it in `listEntries`) rather than the compressed size. Reviewer-visible: "this archive expands
to N× its size — refuses by policy".

### Not exploitable to escape the sandbox (verified)

I tried the classic "declare a small size, decompress huge" forgery (central directory says 1000 bytes,
deflate stream expands to 50 MB): `7zzs l -slt` reports the **local** header's size (52,428,808) and
`7zzs x` extracted **0 bytes** — 7-Zip is honest here, so the listing-based guard cannot be defeated by
lying metadata. The exposure is purely the size of the allowed ratio.

### Suite gap

No test asserts an expansion limit, a per-entry cap, or even that a large-expanding archive is refused
(`grep -l bomb tests/*.py` → nothing).

---

## F3 — MEDIUM — The EPUB sniffer accepts a 94-byte non-archive with a forged header as a valid book, and it reaches the review queue as `pending`

**Where:** `src/uploads.ts:229-237` (`detectType` fast path) reading bytes 30..58 only.

`detectType` declares "epub" purely from the first local-file-header *name* at offset 30 and the
`mimetype` payload at offset 38 — it never checks that the file is a readable archive first. I can
therefore hand the pipeline a file that is not a zip at all.

### Repro

```bash
python3 - <<'PY'
forged = b"PK\x03\x04" + b"\x00"*26 + b"mimetype" + b"application/epub+zip" + b"\x00"*20 + b"NOT A ZIP AT ALL"
open("/tmp/forged.epub","wb").write(forged)          # 94 bytes
PY
# upload /tmp/forged.epub to the Books library (same tus steps as F1)
```

### Observed

* upload completes and the row goes to **`pending`** (not `invalid`) — i.e. the pipeline believes it has
  a valid EPUB:
  `GET /api/review` → `{"filename":"forged.epub","size":94,"kind":"epub","targetExtension":"epub",
  "warnings":["The file couldn't be opened: 7-Zip failed: ERRORS: Is not archive"], "defaults":{"Series":"forged"}}`
* It stays in the queue until a human rejects it; approving it fails later with a 7-Zip error and the item
  is put back to `pending` (`approvalFailed`), so it can only ever be cleared by hand.
* Compare: a plain zip named `.epub` is correctly discarded as "a zip file … doesn't match .epub" — the
  *header* fast path is the only way through.

### Expected

The `mimetype` fast path should be corroborated (e.g. require `hasEpubContainer()`/a successful archive
open) before the file is accepted as an EPUB; otherwise the upload is discarded as `invalid` with the
existing "doesn't match" message. At minimum, reject a file whose declared content cannot be listed.

### Suite gap

`tests/test_uploads.py` covers "plain zip named .epub is rejected" and the non-canonical-layout
acceptance, but no test feeds a fake header (the sniffer's trust boundary).

---

## F4 — LOW/MEDIUM — `maxConcurrentPerUser` is held for 24 h by uploads that transferred no bytes (self-lockout with a misleading 429)

**Where:** `src/uploads.ts:175-178` (`activeCount` counts `status='uploading'`) + `abandonedUploadHours`
(default 24 h, `src/config.ts:59`) and `purgeAbandonedUploads` (30 lines later).

`onUploadCreate` inserts the row as `uploading` **before any byte is sent**. A client that dies between
`POST /files` and the first `PATCH` (page reload, dropped connection, proxy error) leaves a row that
counts against the user's 3 concurrent slots for up to 24 hours. Nothing in the portal warns about it,
and the refusal blames a healthy queue.

### Repro

```bash
ORIGIN=https://paragon.greyarea.contact:20006
C=$(curl -sk -c /tmp/qa.jar -o /dev/null -H "Content-Type: application/json" -H "Origin: $ORIGIN" \
      -d '{"username":"test-uploader","password":"<TEST_UPLOADER_PASSWORD>"}' $ORIGIN/api/login \
      && grep -o '__Host-kc_session[^ ]*' /tmp/qa.jar | head -1 | cut -f7)
for i in 1 2 3; do   # three uploads created and never fed a byte
  curl -sk -o /dev/null -w "create $i -> %{http_code}\n" -X POST "$ORIGIN/files" \
    -H "Origin: $ORIGIN" -H "Cookie: $C" -H "Tus-Resumable: 1.0.0" -H "Upload-Length: 100000" \
    -H "Upload-Metadata: filename $(printf 'x%s.cbz' $i | base64 -w0),libraryId $(printf 2 | base64 -w0)"
done
curl -sk -X POST "$ORIGIN/files" -H "Origin: $ORIGIN" -H "Cookie: $C" -H "Tus-Resumable: 1.0.0" \
  -H "Upload-Length: 100000" \
  -H "Upload-Metadata: filename $(printf fourth.cbz | base64 -w0),libraryId $(printf 2 | base64 -w0)"
```

### Observed

* 4th create → `429 You already have 3 uploads in progress. Wait for one to finish (limit 3).`
* DB rows `ca9c6008…`, `a0aa3212…`, `7cb7ff6c…` stayed `uploading` (created 01:01, `updated_at` unchanged,
  no bytes on disk), and the uploader account could not upload anything at all until I cancelled them by
  id (I hit this myself mid-review and had to clear them to continue).
* Also true of an upload whose body is *partly* sent: `updated_at` is only touched by later requests, so
  the clock restarts on activity and a half-finished upload can hold a slot even longer.

### Expected

Rows with no received bytes (or no request for N minutes) should stop counting against concurrency (and
expire in minutes, not 24 h); the 429 should distinguish "in progress" from "abandoned" and point at the
existing `DELETE /api/uploads/:id` remedy. `purgeAbandonedUploads` already exists — a shorter, data-aware
window (or a "no bytes yet" predicate) is the fix.

---

## F5 — LOW — `GET /api/review/series?libraryId=abc` (and `series-contents` without `libraryId`) returns 500 with Kavita's internal error text

**Where:** `src/review.ts:827-843` — `Number(request.query.libraryId)` is passed straight to Kavita;
`NaN` reaches `kavita.seriesInLibrary()`.

### Repro

```bash
curl -sk -b admin.jar -H "Origin: $ORIGIN" \
  'https://paragon.greyarea.contact:20006/api/review/series?libraryId=abc'
curl -sk -b admin.jar -H "Origin: $ORIGIN" \
  'https://paragon.greyarea.contact:20006/api/review/series-contents?name=x'
```

### Observed

* `500 {"statusCode":500,"error":"Internal Server Error","message":"Kavita series: HTTP 500"}` for both
  (also for `libraryId=` missing). `libraryId=-1` / `9999` return `200 {"series":[]}`.
* The 500 body echoes Kavita's status text to the client (minor information disclosure) and the portal
  logs a 500 for what is a bad request.

### Expected

`400 {"error":"Choose a library."}`, matching `/api/review/:id/approve` (`planApproval` already returns
exactly that for an unknown library). The routes should validate `Number.isInteger(Number(...))`.

### Suite gap

No negative test passes a non-numeric/absent `libraryId` to these routes.

---

## F6 — LOW — `GET /login?apiKey=…` is a state-changing request with no CSRF/Origin check (login CSRF)

**Where:** `src/server.ts:174-190` (route) vs `src/server.ts:75-80` (the Origin hook, which returns early
for `GET`/`HEAD`/`OPTIONS`).

The sidebar-link landing page mints a session from a query-string key on a **GET**, and the CSRF hook
deliberately skips GETs, so no Origin check happens. Any user who holds their own Kavita apiKey on this
instance can make a victim's browser adopt *their* session (e.g. `<img src="https://host:20006/login?apiKey=…">`);
the victim's subsequent uploads land in the attacker's account (and the victim sees someone else's queue).

### Repro

```bash
# no Origin at all, still processed (302 -> /?signin=link-failed, i.e. the key went through the login path)
curl -sk -o /dev/null -w '%{http_code} %{redirect_url}\n' \
  'https://paragon.greyarea.contact:20006/login?apiKey=AAAAAAAAAAAAAAAA'
# control: the JSON login correctly refuses a body-changing POST with no Origin
curl -sk -o /dev/null -w '%{http_code}\n' -H 'Content-Type: application/json' \
  -d '{"username":"x","password":"y"}' https://paragon.greyarea.contact:20006/api/login
```

### Observed

`302 https://…:20006/?signin=link-failed` (request accepted and processed with no Origin/referer of ours)
vs `403 Cross-origin request refused` for `POST /api/login`.

### Expected

Require the same origin check on `/login` (or move the key exchange to a POST that the existing hook
already protects). Note the endpoint already calls `endSession` first, so a successful hit also signs the
victim *out* of their own account — the impact is "forced account switch", not just a bad session.

---

## F7 — LOW (code read, not reproduced) — Interrupted converted-book checks cannot be resumed; the converted EPUB is orphaned in `pending/`

State: `src/uploads.ts:337-347` (`resumeInterruptedChecks`) computes
`pending/<id>.<row.ext>` using the row's **original** extension. For a Kindle upload the `ext` is only
changed to `epub` by `q.setPending` (line 326) — *after* the conversion. A restart between
`rm(partial)` (line 321) and `q.setPending` therefore looks for `pending/<id>.mobi`, does not find it,
and re-runs `checkCompletedUpload` on a partial file that no longer exists → `detectType` throws ENOENT →
the catch-all at lines 330-333 marks the row `invalid` **and never deletes the already-moved
`pending/<id>.epub`**.

Two knock-on effects, both narrow but real:

1. a converted book that was fully processed is reported to the uploader as "The server could not process
   this file" (misleading) instead of being resumed;
2. `status='invalid'` with `stored_path IS NULL` is not covered by any purge — `purgeAbandonedUploads`
   only looks at `uploading`, `purgeOldRejections` only at `rejected` with a `stored_path` — so the file
   leaks in `.incoming/pending/` forever. The same catch-all leaks a file whenever anything throws
   *after* the `rename`/conversion and before `setPending` (e.g. a SQLITE_BUSY on the `setPending` write,
   a full disk during the mobi `copyFile`).

Expected: resume should look for the post-conversion name (or glob `pending/<id>.*`), and every
`invalid` transition should `rm` whatever it moved into `pending/` (or reference it in `stored_path` so
the purges can find it). Cheap belt-and-braces: a startup sweep for `pending/*` with no referencing row.

Observed (for calibration): at review time `pending/` held 59 files, **all** referenced (3 `pending` +
56 `rejected` retained under `REJECTED_RETENTION_DAYS`), so this is a latent leak, not one I could
trigger without killing the process inside a sub-second window.

---

## F8 — LOW — Unsafe archives are only vetted by the *approval* job, so they enter the review queue

**Where:** `src/uploads.ts:214-221` (`hasEpubContainer` swallows every `ArchiveError`) and
`src/inspect.ts:68` (the inspection records the problem as a *warning*), while the only hard refusal is
`extractAll` inside `buildFinalFile` (`src/review.ts:563`).

Upload validation looks at magic bytes only. An archive with a `../` member, an absolute-path member, a
symlink member or >20 000 entries is therefore accepted as `pending`, appears in the reviewer's queue as a
normal item, and only fails when an admin clicks Approve — where it is returned to `pending` and left for
the reviewer to clean up with Reject.

### Repro

```bash
python3 - <<'PY'
import zipfile
z=zipfile.ZipFile("/tmp/slip.cbz","w")
z.writestr("../../evil.txt","pwned")
z.writestr("001.png", b"\x89PNG\r\n\x1a\n" + b"1"*100)
z.close()   # likewise: "/tmp/evil.txt" member, symlink member (mode 120777), 20001 entries
PY
# upload /tmp/slip.cbz as a Comics .cbz, then approve it with
#   POST /api/review/<id>/approve {"libraryId":2,"seriesName":"QA Arch","filename":"slip"}
```

### Observed

| archive | upload result | review warning | Approve |
|---|---|---|---|
| `../../evil.txt` + a page | `pending` | `The file couldn't be opened: Unsafe path in archive: ../../evil.txt` | 202 queued → back to `pending`, `reviewError: Approval failed: Unsafe path in archive: ../../evil.txt …` |
| `/tmp/evil-abs.txt` member | `pending` | `… Unsafe path in archive: /tmp/evil-abs.txt` | same |
| symlink member (mode `120777`) | `pending` | `… Archive contains a link: link` | same |
| 20 001 entries | `pending` | `… Archive has more than 20000 entries.` | same |

Nothing escaped (no `/tmp/evil-abs.txt`, nothing created outside the library) and the library was
untouched — so this is **not** a sandbox escape. It is a queue/UX and defence-in-depth gap: junk no human
can approve sits in the admin queue, and the refusal only happens as a result of an admin action. F3's
forged EPUB behaves the same way.

### Expected

A structural check at upload/inspection time (the first `listEntries` already runs for inspection) should
move these straight to `invalid`/`rejected` with the existing message, the way an extension/content
mismatch is handled — such a file can never be useful, and the uploader deserves the reason immediately.

### Suite gap

There is no symlink / traversal / entry-cap fixture anywhere in `tests/` (`grep -rl 'symlink\|traversal\|bomb' tests/*.py` → nothing). Add one per table row above, plus an assertion that the upload is
refused *before* review.

## Verified-correct (probed, no finding) — so the fix work can trust these

| Area | Probe | Result |
|---|---|---|
| Roles | `/api/review*`, `/api/review/:id/{download,cover,reject,state}`, `/api/admin/*`, `/api/review/approved` for anon/read-only/uploader | 401 / 403 / 403 — every route is gated; no ungated admin route found (`library/activity/notify/requests/sidebar/providers` reviewed by hand too) |
| Upload auth | `POST /files` anon, read-only, and **anon with a forged `X-KC-User` header** | 401, 403, 401 — the header is set by our handler only |
| Ownership | `HEAD`/`DELETE /files/:id` on someone else's upload (read-only, admin) | 403/404 — no cross-user access |
| Header spoofing | uploader sends `X-KC-User: {"id":1,"username":"test-admin"}` | row stays `owner_id=2/test-uploader` |
| Extension/content fuzz | 15 combinations (epub-in-cbz, zip-named-epub, pdf-in-cbz, mobi-in-comics, azw3-under-.mobi, bad magic, uppercase ext, double ext, 0-byte, no name, whitespace name, `libraryId` abc/9999/-1) | all refused with the documented status (`415`/`400`/`invalid`+discard) |
| Limits | declared 0 / 8 GiB+1 / no `Upload-Length` / 4th concurrent create / 255-vs-256-char filename | 400 / 413 / 400 / 429 / 201 vs 400 — all as designed |
| Archive vetting | zip-slip (`../../evil`), absolute path (`/tmp/evil`), symlink entry, 20 001 entries — uploaded end-to-end *and* re-checked in-container with `7zzs l -slt` | `listEntries` rejects each (links via the `lrwxrwxrwx` attribute, `..` and `/` by path, the cap by count); the approval job fails safely and **nothing was extracted or written outside the work dir/library** — see F8 for the timing gap |
| Lying sizes | zip whose central directory under-declares the uncompressed size | 7-Zip reports/extracts honestly (0 B for the forged entry) — not a bypass |
| Approve/fix | approve a cbz with hostile `seriesName`/`filename` (`../../../../tmp/pwned`, `/etc/passwd`, `..`, `....`), bad `libraryId`, 300-char names, `metadata` injection (`Series` override, unknown keys, 20 001-char `Summary`) | traversal is **sanitised into one path segment** (files landed at `…/comics/tmp pwned/a.cbz`, `…/QA Trav/etc passwd.cbz` — inside the library, nothing escaped); 400s for empty/`.`/`....`; `Year`/`AgeRating`/length validated; `Series` is forced to the folder name; `<Volume>` is stripped for comics; `PageCount` corrected from the file |
| Approve/fix races | same upload approved twice; two uploads approved to one destination | `409 already approving`; second plan rejected with `already exists` (the first file survived intact) |
| Reject/restore | reject twice, restore twice, 500-char and empty reason | `409` / `409` / `200`+`400` as designed |
| Fix flow | fix an approved cbz under a new name | file moved, old path gone, `finalPath` updated, no `reviewError` |
| Duplicate detection | identical MOBI twice, identical cbz twice | `duplicate` with the original filename/date; converted books are compared by the *source* checksum, which is correct |
| Route params | `/api/review/..%2f..%2fetc/state`, `<id>%2f/state`, `/page/{0,-1,abc,999999,1e3,0x1,1.0}` | 404s; `0x1`/`1.0` resolve to page 1 (harmless lenient `Number()` parse — a nit, not a finding) |
| Provider boundary | `/api/review/:id/apply` with `externalId` = `http://169.254.169.254/…`, `../../../../etc/passwd`, unknown provider | no SSRF: the stub encodes the id (`encodeURIComponent`); disabled provider → 409; unknown → 400; `mergeRecords` only reads `COMICINFO_FIELDS`, so a `__proto__`/unknown key payload cannot pollute |
| Trusted proxy | `TRUSTED_PROXY=${DOCKER_SUBNET}` per stack | correct per-stack (test stack 172.31.0.0/24); real client IPs arrive via the PROXY protocol (`remoteAddress` was my real address) |
| XSS | `web/main.js` contains no `innerHTML`/`insertAdjacentHTML`/`document.write` | uploader-controlled filenames/reasons are not injected as HTML |

## Test-quality judgement (gaps to add)

1. **Converted Kindle books are only checked at the `pending` boundary** — add the download round-trip
   (F1) and assert `size` in `/api/uploads` and `/api/review` equals the stored file's size.
2. **No archive-safety tests at all**: symlink member, `..`/absolute member names, >20 000 entries,
   declared-vs-actual size mismatch, expansion ratio (F2). `tests/test_uploads.py` has "random bytes named
   .cbz" and nothing structural.
3. **No sniffer negative tests beyond "plain zip named .epub"** — add the forged-header EPUB (F3) and an
   EPUB whose `mimetype` entry is *deflated but with no container.xml* (should be `invalid`, since the
   fallback relies on the container).
4. **No restart/resume test** — kill and restart the companion mid-`checking` for (a) a cbz, (b) a
   converted mobi, and assert the outcome (F7). The resume path is entirely untested today.
5. **No `X-KC-User` spoofing test** and no negative test for `libraryId` on the read routes (F5).
6. **No assertion that a stale `uploading` row stops counting** against `maxConcurrentPerUser` (F4);
   `tests/test_uploads.py` cancels its 3 slow uploads, which hides exactly this behaviour.
7. `check("…4th simultaneous upload refused (429)")` is a good test, but nothing asserts the *reverse*
   (that cancelling frees the slot immediately) — worth pairing.
8. The mobi conversion is asserted by `kind == "epub"` only; also assert the converted file is a
   *readable* EPUB (entries incl. `mimetype` first) so a silently-empty conversion fails the test.

## Environment / artifacts (test stack only)

* Portal `:20006`, Kavita `:20007`, DB `/srv/kavita-test/data-test/companion/companion.db`.
* Files created by the probes in the **test** library: `/srv/media-test/comics/QA Probe 2026-10-17/`,
  `QA Bomb 2026-10-17/` (the 126 MB F2 artifact), `QA Trav/`, `QA Race 2026-10-17/`, `tmp pwned/`,
  `a b c/` — all inside `…/comics`, all sanitised names. Left in place as evidence; safe to delete.
* My probe uploads were **withdrawn again afterwards** (`DELETE /api/uploads/:id`, the documented user
  action) so the review queue is back to two items; the two I deliberately kept as evidence are the
  converted book `QA Repro Kindle 01.mobi` (`fab7d35f…`, EPUB 1922 B vs declared 9122 B — F1) and
  `forged.epub` (94 B — F3).
* F2's approved artifact (`/srv/media-test/comics/QA Bomb 2026-10-17/QA Bomb 001.cbz`, 126 MB) is the
  amplification evidence and is matched against Kavita's library index; delete the series folder to remove it.
* Three phantom `uploading` rows I created for F4 were cancelled via `DELETE /api/uploads/:id` (the
  documented user path) so the uploader account is usable again.
* No changes to the repo, tests, `.env`, compose files, container images or the live stack.
