#!/usr/bin/env python3
"""Confirmation in Kavita and "Fix" for approved files.

Uploads and approves its own test files, fixes them (move to another series, re-tag in place,
refused name clash), checks Kavita follows each change, then removes everything it created.

Run: python3 tests/test_fix.py
"""
import base64
import io
import json
import os
import re
import secrets
import shutil
import sys
import time
import urllib.error
import urllib.request
import zipfile

from settings import KAVITA_LOCAL as KAVITA, KAVITA_PUBLIC, MEDIA, ORIGIN, env, library_ids
from harness import app, kavita, login, request

COMICS = library_ids()["Comics"]
tag = "".join(secrets.choice("abcdefghjkmnpqrstuvwxyz") for _ in range(6))
results = []
uploaded = []


def check(name, ok, detail=""):
    results.append(bool(ok))
    print(f"{'PASS' if ok else 'FAIL'}  {name}" + (f"  ({detail})" if detail and not ok else ""), flush=True)


def b64(s):
    return base64.b64encode(str(s).encode()).decode()


def cbz():
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w", zipfile.ZIP_STORED) as z:
        z.writestr("001.jpg", b"\xff\xd8\xff\xe0" + os.urandom(50_000))
        z.writestr("002.jpg", b"\xff\xd8\xff\xe0" + os.urandom(50_000))
    return buf.getvalue()


def upload_and_approve(uploader, admin, filename, series, target):
    data = cbz()
    meta = f"filename {b64(filename)},libraryId {b64(COMICS)}"
    h = {"Origin": ORIGIN, "Cookie": uploader, "Tus-Resumable": "1.0.0"}
    status, headers, _ = request("POST", ORIGIN + "/files", None, {**h, "Upload-Length": str(len(data)), "Upload-Metadata": meta})
    location = headers["Location"]
    request("PATCH", ORIGIN + location, data, {**h, "Upload-Offset": "0", "Content-Type": "application/offset+octet-stream"})
    upload_id = location.rsplit("/", 1)[1]
    uploaded.append(upload_id)
    for _ in range(60):
        items = {i["id"]: i for i in app("GET", "/api/review", admin)[1].get("pending", [])}
        if items.get(upload_id, {}).get("defaults"):
            break
        time.sleep(1)
    status, res = app("POST", f"/api/review/{upload_id}/approve", admin,
                      {"libraryId": COMICS, "seriesName": series, "filename": target, "metadata": {"Number": "1"}})
    assert status == 202, f"approve: {status} {res}"
    wait_state(admin, upload_id, lambda i: i["status"] == "approved")
    return upload_id


def wait_state(cookie, upload_id, predicate, timeout=200):
    item = None
    for _ in range(timeout // 2):
        item = app("GET", f"/api/review/{upload_id}/state", cookie)[1].get("item")
        if item and predicate(item):
            return item
        time.sleep(2)
    return item


def comicinfo(path):
    with zipfile.ZipFile(path) as z:
        xml = z.read("ComicInfo.xml").decode()
    return {m.group(1): m.group(2) for m in re.finditer(r"<(\w+)>([^<]*)</\1>", xml)}


def kavita_series_in_comics(name):
    status, _, out = request("POST", KAVITA + "/api/Series/v2?PageNumber=1&PageSize=500",
                             json.dumps({"statements": [{"comparison": 0, "field": 19, "value": str(COMICS)}], "combination": 1}).encode(),
                             {"x-api-key": env["COMPANION_KAVITA_AUTH_KEY"], "Content-Type": "application/json"})
    return next((s for s in json.loads(out) if s["name"] == name), None)


uploader, admin = login("UPLOADER"), login("ADMIN")
before, after = f"Kc6 Before {tag}", f"Kc6 After {tag}"

# --- Approve, then Kavita confirms it ---
first = upload_and_approve(uploader, admin, f"Kc6 Fix {tag} 01.cbz", before, f"{before} #001")
item = wait_state(admin, first, lambda i: i["kavitaStatus"] in ("confirmed", "missing"))
series = kavita_series_in_comics(before)
check("approved file is confirmed in Kavita", item and item["kavitaStatus"] == "confirmed", str(item))
check("'Open in Kavita' points at its series page",
      series and item["kavitaUrl"] == f"{KAVITA_PUBLIC}/library/{COMICS}/series/{series['id']}", f"{item and item['kavitaUrl']} {series}")
mine = {u["id"]: u for u in app("GET", "/api/uploads", uploader)[1]["uploads"]}
check("the uploader sees the same link", mine[first].get("kavita_url") == item["kavitaUrl"], str(mine[first]))

# --- Who may fix, and finding files ---
check("uploader cannot fix (403)", app("GET", f"/api/review/{first}/fix", uploader)[0] == 403)
status, found = app("GET", f"/api/review/approved?q={urllib.parse.quote(tag)}", admin)
check("search finds the approved file", status == 200 and any(i["id"] == first for i in found["items"]), str(found)[:200])

# --- Fix: move to another series with new metadata ---
status, fix = app("GET", f"/api/review/{first}/fix", admin)
fix_item = fix.get("item", {})
check("fix form is filled from the file in the library",
      status == 200 and fix_item.get("defaults", {}).get("Series") == before and fix_item.get("currentFilename") == f"{before} #001",
      str(fix_item.get("defaults")))
old_path = MEDIA / "comics" / before / f"{before} #001.cbz"
new_path = MEDIA / "comics" / after / f"{after} #001.cbz"
status, res = app("POST", f"/api/review/{first}/fix", admin,
                  {"libraryId": COMICS, "seriesName": after, "filename": f"{after} #001", "metadata": {"Number": "1", "Title": "Fixed"}})
check("fix accepted (202)", status == 202, f"{status} {res}")
item = wait_state(admin, first, lambda i: i["status"] == "approved")
info = comicinfo(new_path) if new_path.exists() else {}
check("file moved to the new series folder with the new metadata",
      new_path.exists() and info.get("Series") == after and info.get("Title") == "Fixed" and not item.get("reviewError"), f"{info} {item}")
check("old file and its now-empty folder are gone", not old_path.exists() and not old_path.parent.exists())
item = wait_state(admin, first, lambda i: i["kavitaStatus"] in ("confirmed", "missing"))
check("Kavita confirms the file in its new series", item and item["kavitaStatus"] == "confirmed" and kavita_series_in_comics(after), str(item))
gone = False
for _ in range(60):
    if not kavita_series_in_comics(before):
        gone = True
        break
    time.sleep(3)
check("the old series disappears from Kavita", gone)

# --- Fix in place: same name, new title ---
size_before = new_path.stat().st_size
status, _ = app("POST", f"/api/review/{first}/fix", admin,
                {"libraryId": COMICS, "seriesName": after, "filename": f"{after} #001", "metadata": {"Title": "Fixed Again"}})
item = wait_state(admin, first, lambda i: i["status"] == "approved")
check("fix in place rewrites the same file", status == 202 and comicinfo(new_path).get("Title") == "Fixed Again"
      and len(list(new_path.parent.iterdir())) == 1, str(item))

# --- Name clash is refused and changes nothing ---
second = upload_and_approve(uploader, admin, f"Kc6 Fix {tag} 02.cbz", after, f"{after} #002")
second_path = MEDIA / "comics" / after / f"{after} #002.cbz"
status, res = app("POST", f"/api/review/{second}/fix", admin,
                  {"libraryId": COMICS, "seriesName": after, "filename": f"{after} #001", "metadata": {}})
check("fixing into an existing file name is refused (409)", status == 409 and second_path.exists(), f"{status} {res}")

# --- Check again ---
check("'Check again' is accepted", app("POST", f"/api/review/{first}/recheck", admin, {})[0] == 200)

# --- Clean up ---
shutil.rmtree(MEDIA / "comics" / after, ignore_errors=True)
shutil.rmtree(MEDIA / "comics" / before, ignore_errors=True)
for name in (before, after):
    s = kavita_series_in_comics(name)
    if s:
        kavita("DELETE", f"/api/Series/{s['id']}")
check("test files cleaned up", not (MEDIA / "comics" / after).exists())

print(f"\n{sum(results)}/{len(results)} passed")
sys.exit(0 if all(results) else 1)
