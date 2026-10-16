#!/usr/bin/env python3
"""Request board tests: users ask for a title, admins see and decide, and a matching approval fulfils
a request automatically. Cleans up the series it approves.

Run: python3 tests/test_requests.py
"""
import io
import os
import secrets
import shutil
import sys
import zipfile

from harness import app, check, finish, kavita, login, upload, wait_pending, wait_approved
from settings import MEDIA, library_ids

COMICS = library_ids()["Comics"]
tag = secrets.token_hex(3)
series = f"Request Test {tag}"
cleanup_paths = []


def small_cbz():
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w", zipfile.ZIP_STORED) as archive:
        archive.writestr("001.jpg", b"\xff\xd8\xff\xe0" + os.urandom(20_000))
    return buf.getvalue()


admin, uploader, readonly = login("ADMIN"), login("UPLOADER"), login("READONLY")

check("a signed-out request is refused (401)", app("GET", "/api/requests")[0] == 401)
check("an empty title is refused (400)", app("POST", "/api/requests", uploader, {"title": "   "})[0] == 400)

status, _ = app("POST", "/api/requests", uploader, {"title": f"Sample {tag}", "number": "7", "libraryId": COMICS, "note": "please"})
check("a user can ask for a title", status == 200, str(status))

status, body = app("GET", "/api/requests", uploader)
check("their request appears under 'my requests'",
      status == 200 and any(r["title"] == f"Sample {tag}" and r["number"] == "7" for r in body["mine"]), str(body)[:160])
check("a non-reviewer does not see the open queue", body.get("open") == [], str(body.get("open")))

check("read-only accounts can also ask", app("POST", "/api/requests", readonly, {"title": f"Readonly {tag}"})[0] == 200)

status, open_body = app("GET", "/api/requests", admin)
open_titles = {r["title"] for r in open_body["open"]}
check("a reviewer sees both open requests", status == 200 and {f"Sample {tag}", f"Readonly {tag}"} <= open_titles, str(open_titles))

mine_id = next(r["id"] for r in open_body["open"] if r["title"] == f"Sample {tag}")
readonly_id = next(r["id"] for r in open_body["open"] if r["title"] == f"Readonly {tag}")

check("a non-reviewer cannot decline (403)", app("POST", f"/api/requests/{mine_id}/decline", uploader)[0] == 403)
check("a non-reviewer cannot fulfil (403)", app("POST", f"/api/requests/{mine_id}/fulfil", uploader)[0] == 403)

check("a reviewer can decline a request", app("POST", f"/api/requests/{readonly_id}/decline", admin)[0] == 200)
check("declining twice is refused (409)", app("POST", f"/api/requests/{readonly_id}/decline", admin)[0] == 409)
check("a reviewer can mark a request fulfilled", app("POST", f"/api/requests/{mine_id}/fulfil", admin)[0] == 200)

# --- a matching approval fulfils a request automatically ---
check("a request for an upcoming series is created", app("POST", "/api/requests", uploader, {"title": series, "number": "1", "libraryId": COMICS})[0] == 200)
upload_id = upload(uploader, f"{series} v01.cbz", small_cbz(), COMICS)
wait_pending(admin, upload_id)
status, res = app("POST", f"/api/review/{upload_id}/approve", admin,
                  {"libraryId": COMICS, "seriesName": series, "filename": f"{series} v01.cbz", "metadata": {"Number": "1"}})
check("the matching file is approved", status == 202, f"{status} {res}")
cleanup_paths.append(MEDIA / "comics" / series)
wait_approved(admin, upload_id)

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

sys.exit(finish())
