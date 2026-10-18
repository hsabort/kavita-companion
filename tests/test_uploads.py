#!/usr/bin/env python3
"""M2 acceptance tests: resumable uploads, validation, limits, ownership. Runs against the
public HTTPS URL as the TEST_* users from ../.env, then withdraws everything it uploaded.

Run: python3 tests/test_uploads.py
"""
import base64
import hashlib
import http.client
import io
import json
import os
import secrets
import shutil
import ssl
import subprocess
import sys
import tempfile
import time
import urllib.error
import urllib.request
import zipfile

from capability_message import capability_message
from harness import app, check, finish, login
from settings import COMPANION_PORT as PORT, DOMAIN as HOST, INCOMING, ORIGIN, ROOT, env, library_ids

_libs = library_ids()
COMICS, BOOKS = _libs["Comics"], _libs["Books"]

created = []  # (cookie, upload id) to withdraw at the end


def request(method, path, body=None, headers=None, cookie=None, origin=ORIGIN):
    h = dict(headers or {})
    if origin:
        h["Origin"] = origin
    if cookie:
        h["Cookie"] = cookie
    req = urllib.request.Request(ORIGIN + path, body, h, method=method)
    try:
        with urllib.request.urlopen(req, timeout=60) as r:
            return r.status, r.headers, r.read()
    except urllib.error.HTTPError as e:
        return e.code, e.headers, e.read()


def b64(s):
    return base64.b64encode(str(s).encode()).decode()


def tus_create(cookie, filename, size, library_id=COMICS, origin=ORIGIN):
    meta = f"filename {b64(filename)},name {b64(filename)}"
    if library_id is not None:
        meta += f",libraryId {b64(library_id)}"
    status, headers, body = request("POST", "/files", None, {
        "Tus-Resumable": "1.0.0", "Upload-Length": str(size), "Upload-Metadata": meta,
    }, cookie, origin)
    location = headers.get("Location")
    return status, location, body.decode(errors="replace")


def tus_patch(cookie, location, offset, data, origin=ORIGIN):
    status, headers, body = request("PATCH", location, data, {
        "Tus-Resumable": "1.0.0", "Upload-Offset": str(offset),
        "Content-Type": "application/offset+octet-stream",
    }, cookie, origin)
    return status, int(headers.get("Upload-Offset") or -1), body


def tus_head(cookie, location):
    status, headers, _ = request("HEAD", location, None, {"Tus-Resumable": "1.0.0"}, cookie)
    return status, int(headers.get("Upload-Offset") or -1)


def tus_upload(cookie, filename, data, library_id=COMICS, chunk=25 * 1024 * 1024):
    status, location, body = tus_create(cookie, filename, len(data), library_id)
    if status != 201:
        return status, None, body
    upload_id = location.rsplit("/", 1)[1]
    created.append((cookie, upload_id))
    offset = 0
    while offset < len(data):
        st, offset, body = tus_patch(cookie, location, offset, data[offset:offset + chunk])
        if st != 204:
            return st, upload_id, body
    return 204, upload_id, b""


def interrupted_patch(cookie, location, offset, data, send_bytes):
    """Send a PATCH declaring len(data) bytes but drop the connection after send_bytes."""
    conn = http.client.HTTPSConnection(HOST, PORT, context=ssl.create_default_context(), timeout=60)
    conn.putrequest("PATCH", location)
    for k, v in {"Tus-Resumable": "1.0.0", "Upload-Offset": str(offset), "Origin": ORIGIN, "Cookie": cookie,
                 "Content-Type": "application/offset+octet-stream", "Content-Length": str(len(data))}.items():
        conn.putheader(k, v)
    conn.endheaders()
    view = memoryview(data)
    for i in range(0, send_bytes, 1024 * 1024):
        conn.send(view[i:min(i + 1024 * 1024, send_bytes)])
    conn.sock.close()


def my_uploads(cookie):
    status, _, body = request("GET", "/api/uploads", cookie=cookie)
    return {u["id"]: u for u in json.loads(body)["uploads"]}


def wait_final(cookie, upload_id, timeout=120):
    deadline = time.time() + timeout
    while time.time() < deadline:
        u = my_uploads(cookie).get(upload_id)
        if u and u["status"] not in ("uploading", "checking"):
            return u
        time.sleep(1)
    return my_uploads(cookie).get(upload_id)


def make_cbz(payload_size=200_000):
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w", zipfile.ZIP_STORED) as z:
        z.writestr("001.jpg", b"\xff\xd8\xff\xe0" + os.urandom(payload_size))
    return buf.getvalue()


def make_epub():
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w") as z:
        z.writestr(zipfile.ZipInfo("mimetype"), "application/epub+zip", compress_type=zipfile.ZIP_STORED)
        z.writestr("META-INF/container.xml", "<container/>" + secrets.token_hex(16))
    return buf.getvalue()


def make_epub_noncanonical():
    """A valid EPUB that isn't laid out the canonical way (container first, mimetype deflated).
    Kavita reads it, so the sniffer must not call it a plain zip and discard it."""
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w", zipfile.ZIP_DEFLATED) as z:
        z.writestr("META-INF/container.xml", "<container/>" + secrets.token_hex(16))
        z.writestr("mimetype", "application/epub+zip")
        z.writestr("OEBPS/content.opf", "<package/>")
    return buf.getvalue()


# Runs inside the built image, with `mobiunpack` hidden from PATH so the spawn fails with ENOENT even
# though the formats image carries the tool. That pins the error type independently of which image is
# running: a missing tool is a CapabilityError, never a MobiError.
MOBI_PROBE = r"""
import { pathToFileURL } from "node:url";
process.env.KAVITA_AUTH_KEY = "probe";
process.env.PUBLIC_ORIGIN = "https://probe";
const results = [];
const check = (name, ok, detail = "") => results.push({ name, ok: !!ok, detail: String(detail) });
let mobi, caps;
try {
  mobi = await import(pathToFileURL("/app/dist/mobi.js").href);
  caps = await import(pathToFileURL("/app/dist/capabilities.js").href);
} catch (err) {
  check("dist/mobi.js loads", false, err && err.message);
  console.log(JSON.stringify({ results }));
  process.exit(0);
}
check("dist/mobi.js loads", true);
try {
  await mobi.convertKindleToEpub("/w/sample.mobi", "mobi", "/w/out.epub");
  check("convertKindleToEpub raises CapabilityError('kindle') when mobiunpack is absent", false, "it resolved");
} catch (err) {
  check("convertKindleToEpub raises CapabilityError('kindle') when mobiunpack is absent",
        err instanceof caps.CapabilityError && err.capability === "kindle",
        `${err && err.name}: ${err && err.message}`);
}
console.log(JSON.stringify({ results }));
"""


uploader = login("UPLOADER")
readonly = login("READONLY")
admin = login("ADMIN")
tag = secrets.token_hex(3)

# Which optional tools this image carries (design §7.1). The shared test stack runs the formats
# image, so both are present and the uploads below succeed; on the permissive default image the same
# uploads are refused with the actionable message. The assertions are gated on this report so this
# file is correct on either image (Task 8's tests/test_default_image.py owns the full default-image
# suite). See the report for how the refusal assertions run without the shared stack.
_, _health = app("GET", "/api/health")
caps = (_health or {}).get("capabilities") or {}


def capability_outcome(label, filename, data, library_id, capability, stored_ext):
    """Upload a format this image may not support and assert the outcome for this image.

    With the capability present the upload reaches the pending area; without it the file must be
    refused with the actionable message (design §7.5), never queued, and audited as `upload_invalid`.
    """
    st, uid, body = tus_upload(uploader, filename, data, library_id=library_id)
    check(f"{label} upload starts", st == 204, f"{st} {body}")
    u = wait_final(uploader, uid)
    if caps.get(capability):
        check(f"a {label} file is accepted on an image with the {capability} capability",
              u and u["status"] == "pending", str(u))
        return
    # The message is asserted verbatim (not just "-formats"): the refusal must be capabilityMessage()
    # for the capability in question, so a wording change is caught (Task 8 tightening Task 3).
    wanted = capability_message("archive-extras" if capability == "archiveExtras" else "kindle")
    check(f"a {label} file is refused with the actionable capability message",
          u and u["status"] == "invalid" and u.get("error") == wanted, str(u))
    check(f"the refused {label} file never reaches the pending area",
          not (INCOMING / "pending" / f"{uid}.{stored_ext}").exists(), str(uid))
    _, activity = app("GET", "/api/admin/activity?action=upload_invalid&limit=200", admin)
    audited = {e["detail"]["id"] for e in activity.get("entries", [])
               if isinstance(e.get("detail"), dict) and "id" in e["detail"]}
    check(f"the {label} refusal is audited as upload_invalid", uid in audited, str(uid))


def mobi_module_check():
    """`convertKindleToEpub` must raise CapabilityError, not MobiError, when the tool is absent."""
    work = tempfile.mkdtemp(prefix="mobi-probe-")
    try:
        shutil.copy(ROOT / "tests" / "fixtures" / "sample.mobi", os.path.join(work, "sample.mobi"))
        with open(os.path.join(work, "probe.mjs"), "w") as fh:
            fh.write(MOBI_PROBE)
        proc = subprocess.run(
            ["docker", "run", "--rm", "--user", "1001:1001",
             "-e", "PATH=/usr/local/bin:/usr/bin:/bin",  # hides /opt/kindleunpack/bin, keeps node
             "-v", f"{work}:/w", env.get("COMPANION_IMAGE", "kavita-companion:test"),
             "node", "/w/probe.mjs"],
            capture_output=True, text=True)
        try:
            payload = json.loads(proc.stdout.strip().splitlines()[-1])
            for r in payload["results"]:
                check(r["name"], r["ok"], r.get("detail", ""))
        except (ValueError, IndexError, KeyError):
            check("convertKindleToEpub raises CapabilityError('kindle') when mobiunpack is absent",
                  False, (proc.stdout + proc.stderr).strip()[-600:])
    finally:
        shutil.rmtree(work, ignore_errors=True)


# --- Refusals before any data is sent ---
st, _, body = tus_create(None, "x.cbz", 100)
check("upload without signing in refused (401)", st == 401, f"{st} {body}")
st, _, body = tus_create(readonly, "x.cbz", 100)
check("read-only user cannot start an upload (403)", st == 403, f"{st} {body}")
st, _, body = tus_create(uploader, "x.cbz", 100, origin=None)
check("upload request without Origin refused (403)", st == 403, f"{st} {body}")
st, _, body = tus_create(uploader, "setup.exe", 100)
check(".exe refused with a readable message (415)", st == 415 and "not accepted" in body, f"{st} {body}")
st, _, body = tus_create(uploader, "x.cbz", 100, library_id=None)
check("upload without a library refused (400)", st == 400 and "library" in body.lower(), f"{st} {body}")
st, _, body = tus_create(uploader, "huge.cbz", 9 * 1024**3)
check("9 GB file refused (413, limit 8 GB)", st == 413, f"{st} {body}")

# --- Small valid comic: full path to pending ---
cbz = make_cbz()
st, cbz_id, body = tus_upload(uploader, f"Test Series {tag} v01.cbz", cbz)
check("small .cbz uploads", st == 204, f"{st} {body}")
u = wait_final(uploader, cbz_id)
check("valid .cbz ends up waiting for review", u and u["status"] == "pending", str(u))
pending_file = INCOMING / "pending" / f"{cbz_id}.cbz"
check("file is in the pending area with identical contents",
      pending_file.exists() and hashlib.sha256(pending_file.read_bytes()).digest() == hashlib.sha256(cbz).digest())
check("partial upload files cleaned up", not (INCOMING / "partial" / cbz_id).exists()
      and not (INCOMING / "partial" / f"{cbz_id}.json").exists())

# --- Ownership ---
_, location_other = None, f"/files/{cbz_id}"
st, _ = tus_head(admin, location_other)
check("another user cannot see someone else's upload (404)", st == 404, str(st))

# --- Interrupted connection, then resume (60 MB file, 25 MB chunks) ---
big = make_cbz(60 * 1024 * 1024)
st, location, body = tus_create(uploader, f"Big Series {tag} v01.cbz", len(big))
big_id = location.rsplit("/", 1)[1] if location else None
created.append((uploader, big_id))
st1, off1, _ = tus_patch(uploader, location, 0, big[:25 * 1024 * 1024])
check("first 25 MB chunk accepted", st1 == 204 and off1 == 25 * 1024 * 1024, f"{st1} {off1}")
interrupted_patch(uploader, location, off1, big[off1:off1 + 25 * 1024 * 1024], 10 * 1024 * 1024)
time.sleep(2)
st, off2 = tus_head(uploader, location)
check("after a dropped connection the server reports how much it kept",
      st == 200 and off1 <= off2 <= off1 + 10 * 1024 * 1024, f"{st} offset={off2}")
offset = off2
while offset < len(big):
    st, offset, _ = tus_patch(uploader, location, offset, big[offset:offset + 25 * 1024 * 1024])
    if st != 204:
        break
check("upload resumes from that offset and completes", st == 204 and offset == len(big), f"{st} {offset}")
u = wait_final(uploader, big_id)
stored = INCOMING / "pending" / f"{big_id}.cbz"
check("resumed file is byte-for-byte identical",
      u and u["status"] == "pending" and stored.exists()
      and hashlib.sha256(stored.read_bytes()).hexdigest() == hashlib.sha256(big).hexdigest(), str(u))

# --- Content checks ---
st, fake_id, _ = tus_upload(uploader, f"Fake {tag}.cbz", os.urandom(50_000))
u = wait_final(uploader, fake_id)
check("random bytes named .cbz are rejected as invalid", u and u["status"] == "invalid" and u["error"], str(u))
check("invalid file is deleted", not any((INCOMING / d / fake_id).exists() for d in ("partial", "pending")))

st, dup_id, _ = tus_upload(uploader, f"Copy of Test Series {tag}.cbz", cbz)
u = wait_final(uploader, dup_id)
check("identical file uploaded again is flagged as duplicate", u and u["status"] == "duplicate", str(u))

st, epub_id, _ = tus_upload(uploader, f"Test Book {tag}.epub", make_epub(), library_id=BOOKS)
u = wait_final(uploader, epub_id)
check("valid .epub accepted", u and u["status"] == "pending", str(u))
st, bad_epub_id, _ = tus_upload(uploader, f"Not A Book {tag}.epub", make_cbz(), library_id=BOOKS)
u = wait_final(uploader, bad_epub_id)
check("plain zip named .epub rejected", u and u["status"] == "invalid", str(u))
st, alt_epub_id, _ = tus_upload(uploader, f"Alt Layout {tag}.epub", make_epub_noncanonical(), library_id=BOOKS)
u = wait_final(uploader, alt_epub_id)
check("a valid EPUB in a non-canonical layout is accepted, not misread as a zip",
      u and u["status"] == "pending", str(u))

# --- RAR/7z need 7-Zip (the `archive-extras` capability): accepted where it is present, refused with
# the actionable message where it is not (design §7.5). A .cbr/.cb7 whose bytes are really a zip is
# still a zip and is accepted on either image (see test_archive_zip.py). ---
capability_outcome("RAR", f"Rar Comic {tag}.rar",
                   (ROOT / "tests" / "fixtures" / "sample.rar").read_bytes(), COMICS, "archiveExtras", "rar")
capability_outcome("7z", f"Seven Comic {tag}.7z",
                   (ROOT / "tests" / "fixtures" / "sample.7z").read_bytes(), COMICS, "archiveExtras", "7z")

# --- Kindle (MOBI/AZW) books are accepted in Books and converted to EPUB for review ---
if caps.get("kindle"):
    for label, fixture, filename in (("MOBI", "sample.mobi", f"Kindle Book {tag}.mobi"),
                                     ("AZW3 (KF8)", "sample.azw3", f"Kindle KF8 {tag}.azw3")):
        st, kid, _ = tus_upload(uploader, filename, (ROOT / "tests" / "fixtures" / fixture).read_bytes(), library_id=BOOKS)
        u = wait_final(uploader, kid)
        check(f"a {label} book is accepted and converted", u and u["status"] == "pending", str(u))
        _, rev = app("GET", "/api/review", admin)
        item = next((i for i in rev.get("pending", []) if i["id"] == kid), None)
        check(f"the converted {label} book is presented as an EPUB for review",
              item and item.get("kind") == "epub", str(item)[:160])
else:
    # On the permissive default image the same upload is refused with the actionable message, never a
    # generic conversion failure (Review Focus 4).
    capability_outcome("MOBI", f"Kindle Book {tag}.mobi",
                       (ROOT / "tests" / "fixtures" / "sample.mobi").read_bytes(), BOOKS, "kindle", "mobi")
st, _, body = tus_create(uploader, f"Kindle Comic {tag}.mobi", 4096, library_id=COMICS)
check(".mobi in a Comics library is refused (415)", st == 415, f"{st} {body}")

# --- convertKindleToEpub raises CapabilityError, not MobiError, when mobiunpack is absent ---
mobi_module_check()

# --- Concurrency limit: 3 in progress, 4th refused; then cancel them ---
locs = []
for i in range(3):
    st, loc, _ = tus_create(uploader, f"Slow {tag} {i}.cbz", 1_000_000)
    locs.append(loc)
st4, _, body4 = tus_create(uploader, f"Slow {tag} 3.cbz", 1_000_000)
check("4th simultaneous upload refused (429)", all(locs) and st4 == 429, f"{st4} {body4}")
cancel = [request("DELETE", loc, None, {"Tus-Resumable": "1.0.0"}, uploader)[0] for loc in locs if loc]
mine = my_uploads(uploader)
check("cancelled uploads are recorded as cancelled",
      cancel == [204] * 3 and all(mine[l.rsplit('/', 1)[1]]["status"] == "cancelled" for l in locs), str(cancel))

# --- Withdraw ---
st, _, _ = request("DELETE", f"/api/uploads/{cbz_id}", cookie=uploader)
check("uploader can withdraw a pending upload", st == 200 and my_uploads(uploader)[cbz_id]["status"] == "withdrawn"
      and not pending_file.exists(), str(st))

# --- Clean up everything this run left pending ---
for cookie, uid in created:
    if uid and my_uploads(cookie).get(uid, {}).get("status") == "pending":
        request("DELETE", f"/api/uploads/{uid}", cookie=cookie)
leftover = [uid for _, uid in created if uid and my_uploads(uploader).get(uid, {}).get("status") == "pending"]
check("test uploads cleaned up", not leftover, str(leftover))

sys.exit(finish())
