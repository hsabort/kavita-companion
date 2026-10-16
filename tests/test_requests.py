#!/usr/bin/env python3
"""Request board tests: users ask for a title, admins see and decide, and a matching approval fulfils
a request automatically. Cleans up the series it approves.

Run: python3 tests/test_requests.py
"""
import base64
import io
import json
import os
import secrets
import shutil
import sys
import time
import urllib.error
import urllib.request
import zipfile

from settings import KAVITA_LOCAL as KAVITA, MEDIA, ORIGIN, env, library_ids

COMICS = library_ids()["Comics"]
tag = secrets.token_hex(3)
series = f"Request Test {tag}"
results = []
cleanup_paths = []


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


def app(method, path, cookie=None, body=None, raw=False):
    headers = {"Origin": ORIGIN}
    if cookie:
        headers["Cookie"] = cookie
    data = json.dumps(body).encode() if body is not None else None
    if data is not None:
        headers["Content-Type"] = "application/json"
    status, _, out = request(method, ORIGIN + path, data, headers)
    if raw:
        return status, out
    try:
        return status, json.loads(out or b"{}")
    except ValueError:
        return status, {"raw": out[:200]}


def kavita(method, path, body=None):
    status, _, out = request(method, KAVITA + path, json.dumps(body).encode() if body is not None else None,
                             {"x-api-key": env["COMPANION_KAVITA_AUTH_KEY"], "Content-Type": "application/json"})
    return status, json.loads(out) if out else None


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


def small_cbz():
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w", zipfile.ZIP_STORED) as z:
        z.writestr("001.jpg", b"\xff\xd8\xff\xe0" + os.urandom(20_000))
    return buf.getvalue()


admin = login("ADMIN")
uploader = login("UPLOADER")
readonly = login("READONLY")

status, _ = app("GET", "/api/requests")
check("a signed-out request is refused (401)", status == 401, str(status))

status, _ = app("POST", "/api/requests", uploader, {"title": "   "})
check("an empty title is refused (400)", status == 400, str(status))

status, body = app("POST", "/api/requests", uploader, {"title": f"Sample {tag}", "number": "7", "libraryId": COMICS, "note": "please"})
check("a user can ask for a title", status == 200, str(status))

status, body = app("GET", "/api/requests", uploader)
check("their request appears under 'my requests'",
      status == 200 and any(r["title"] == f"Sample {tag}" and r["number"] == "7" for r in body["mine"]), str(body)[:160])
check("a non-reviewer does not see the open queue", body.get("open") == [], str(body.get("open")))

status, _ = app("POST", "/api/requests", readonly, {"title": f"Readonly {tag}"})
check("read-only accounts can also ask", status == 200, str(status))

status, open_body = app("GET", "/api/requests", admin)
open_titles = {r["title"] for r in open_body["open"]}
check("a reviewer sees both open requests", status == 200 and {f"Sample {tag}", f"Readonly {tag}"} <= open_titles, str(open_titles))

mine_id = next(r["id"] for r in open_body["open"] if r["title"] == f"Sample {tag}")
readonly_id = next(r["id"] for r in open_body["open"] if r["title"] == f"Readonly {tag}")

check("a non-reviewer cannot decline (403)", app("POST", f"/api/requests/{mine_id}/decline", uploader)[0] == 403)
check("a non-reviewer cannot fulfil (403)", app("POST", f"/api/requests/{mine_id}/fulfil", uploader)[0] == 403)

status, _ = app("POST", f"/api/requests/{readonly_id}/decline", admin)
check("a reviewer can decline a request", status == 200, str(status))
status, _ = app("POST", f"/api/requests/{readonly_id}/decline", admin)
check("declining twice is refused (409)", status == 409, str(status))

status, _ = app("POST", f"/api/requests/{mine_id}/fulfil", admin)
check("a reviewer can mark a request fulfilled", status == 200, str(status))

# --- a matching approval fulfils a request automatically ---
status, _ = app("POST", "/api/requests", uploader, {"title": series, "number": "1", "libraryId": COMICS})
check("a request for an upcoming series is created", status == 200, str(status))
upload_id = upload(uploader, f"{series} v01.cbz", small_cbz())
for _ in range(60):
    _, queue = app("GET", "/api/review", admin)
    if any(i["id"] == upload_id and i.get("defaults") for i in queue.get("pending", [])):
        break
    time.sleep(1)
status, res = app("POST", f"/api/review/{upload_id}/approve", admin,
                  {"libraryId": COMICS, "seriesName": series, "filename": f"{series} v01.cbz", "metadata": {"Number": "1"}})
check("the matching file is approved", status == 202, f"{status} {res}")
cleanup_paths.append(MEDIA / "comics" / series)
for _ in range(60):
    _, state = app("GET", f"/api/review/{upload_id}/state", admin)
    if state.get("item", {}).get("status") == "approved":
        break
    time.sleep(2)
status, body = app("GET", "/api/requests", uploader)
fulfilled = next((r for r in body["mine"] if r["title"] == series), None)
check("the matching approval fulfils the request automatically",
      fulfilled is not None and fulfilled["status"] == "fulfilled", str(fulfilled))

# --- clean up the approved series ---
for path in cleanup_paths:
    shutil.rmtree(path, ignore_errors=True)
_, all_series = kavita("POST", "/api/Series/v2?PageNumber=1&PageSize=500",
                       {"statements": [{"comparison": 0, "field": 19, "value": str(COMICS)}], "combination": 1})
for s in all_series or []:
    if s["name"] == series:
        kavita("DELETE", f"/api/Series/{s['id']}")
check("test series removed from disk", not any(p.exists() for p in cleanup_paths))

print()
print(f"{sum(results)}/{len(results)} passed")
sys.exit(0 if all(results) else 1)
