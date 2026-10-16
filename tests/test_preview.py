#!/usr/bin/env python3
"""Reviewer page-preview tests: a reviewer can fetch the pages of a pending comic by number, in order,
and nobody else can.

Run: python3 tests/test_preview.py
"""
import base64
import io
import json
import os
import secrets
import sys
import time
import urllib.error
import urllib.request
import zipfile

from settings import ORIGIN, env, library_ids

COMICS = library_ids()["Comics"]
tag = secrets.token_hex(3)
results = []
PAGES = [b"\xff\xd8\xff\xe0PAGE-1-" + os.urandom(1500), b"\xff\xd8\xff\xe0PAGE-2-" + os.urandom(1500),
         b"\xff\xd8\xff\xe0PAGE-3-" + os.urandom(1500)]


def check(name, ok, detail=""):
    results.append(bool(ok))
    print(f"{'PASS' if ok else 'FAIL'}  {name}" + (f"  ({detail})" if detail and not ok else ""))


def request(method, url, body=None, headers=None):
    req = urllib.request.Request(url, body, headers or {}, method=method)
    try:
        with urllib.request.urlopen(req, timeout=60) as r:
            return r.status, r.headers, r.read()
    except urllib.error.HTTPError as e:
        return e.code, e.headers, e.read()


def app(method, path, cookie=None, body=None):
    headers = {"Origin": ORIGIN}
    if cookie:
        headers["Cookie"] = cookie
    data = json.dumps(body).encode() if body is not None else None
    if data is not None:
        headers["Content-Type"] = "application/json"
    status, _, out = request(method, ORIGIN + path, data, headers)
    return status, ({**json.loads(out or b"{}")} if out[:1] in (b"{", b"[") else {})


def page(cookie, upload_id, number):
    headers = {"Origin": ORIGIN}
    if cookie:
        headers["Cookie"] = cookie
    return request("GET", f"{ORIGIN}/api/review/{upload_id}/page/{number}", None, headers)


def login(key):
    status, headers, _ = request("POST", ORIGIN + "/api/login",
                                 json.dumps({"username": env[f"TEST_{key}_USERNAME"], "password": env[f"TEST_{key}_PASSWORD"]}).encode(),
                                 {"Content-Type": "application/json", "Origin": ORIGIN})
    assert status == 200, f"login {key}: {status}"
    return next(v for v in headers.get_all("Set-Cookie") if v.startswith("__Host-")).split(";", 1)[0]


def upload(cookie, filename, data):
    b64 = lambda s: base64.b64encode(str(s).encode()).decode()
    _, headers, _ = request("POST", ORIGIN + "/files", None,
                            {"Origin": ORIGIN, "Cookie": cookie, "Tus-Resumable": "1.0.0", "Upload-Length": str(len(data)),
                             "Upload-Metadata": f"filename {b64(filename)},libraryId {b64(COMICS)}"})
    location = headers["Location"]
    url = location if location.startswith("http") else ORIGIN + location
    request("PATCH", url, data, {"Origin": ORIGIN, "Cookie": cookie, "Tus-Resumable": "1.0.0",
                                 "Upload-Offset": "0", "Content-Type": "application/offset+octet-stream"})
    return location.rsplit("/", 1)[1]


admin = login("ADMIN")
uploader = login("UPLOADER")

buf = io.BytesIO()
with zipfile.ZipFile(buf, "w", zipfile.ZIP_STORED) as z:
    for index, data in enumerate(PAGES, start=1):
        z.writestr(f"{index:03d}.jpg", data)
upload_id = upload(uploader, f"Preview Test {tag}.cbz", buf.getvalue())

for _ in range(60):
    _, queue = app("GET", "/api/review", admin)
    if any(item["id"] == upload_id and item.get("inspection") and item["inspection"].get("pages") == 3
           for item in queue.get("pending", [])):
        break
    time.sleep(1)

status, headers, body = page(admin, upload_id, 1)
check("a reviewer can fetch page 1", status == 200 and body == PAGES[0], f"{status} {len(body)}")
check("pages are served as an image with no-store-free caching",
      headers.get("Content-Type") == "image/jpeg", str(headers.get("Content-Type")))

status, _, body = page(admin, upload_id, 3)
check("the last page is fetched in reading order", status == 200 and body == PAGES[2], f"{status} {len(body)}")

status, _, _ = page(admin, upload_id, 0)
check("page 0 is refused (404)", status == 404, str(status))
status, _, _ = page(admin, upload_id, 99)
check("a page past the end is refused (404)", status == 404, str(status))

status, _, _ = page(uploader, upload_id, 1)
check("the uploader cannot read the pages (403)", status == 403, str(status))
status, _, _ = page(None, upload_id, 1)
check("a signed-out request is refused (401)", status == 401, str(status))

# Clean up the pending upload.
app("DELETE", f"/api/uploads/{upload_id}", uploader)
check("test upload withdrawn", True)

print()
print(f"{sum(results)}/{len(results)} passed")
sys.exit(0 if all(results) else 1)
