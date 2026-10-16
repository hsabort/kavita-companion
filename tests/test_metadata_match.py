#!/usr/bin/env python3
"""Metadata auto-fill tests: when an upload's series already exists in Kavita, the review screen can
fetch that series' metadata to prefill. Cleans up the series it approves.

Run: python3 tests/test_metadata_match.py
"""
import io
import os
import secrets
import shutil
import sys
import zipfile

from harness import app, check, finish, kavita, login, upload, wait_approved, wait_pending
from settings import MEDIA, library_ids

COMICS = library_ids()["Comics"]
tag = secrets.token_hex(3)
series = f"Match Test {tag}"
cleanup_paths = []


def comicinfo_cbz():
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w", zipfile.ZIP_STORED) as archive:
        archive.writestr("001.jpg", b"\xff\xd8\xff\xe0" + os.urandom(15_000))
        archive.writestr("ComicInfo.xml",
                         f"<ComicInfo><Series>{series}</Series><Number>1</Number><Writer>Jane Doe</Writer>"
                         f"<Publisher>Acme Press</Publisher><Year>2020</Year><Genre>Action</Genre></ComicInfo>")
    return buf.getvalue()


def plain_cbz():
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w", zipfile.ZIP_STORED) as archive:
        archive.writestr("001.jpg", b"\xff\xd8\xff\xe0" + os.urandom(15_000))
    return buf.getvalue()


def series_id(name):
    _, listing = kavita("POST", "/api/Series/v2?PageNumber=1&PageSize=500",
                        {"statements": [{"comparison": 0, "field": 19, "value": str(COMICS)}], "combination": 1})
    return next((s["id"] for s in (listing or []) if s["name"] == name), None)


admin, uploader = login("ADMIN"), login("UPLOADER")

# --- create the series, then give it metadata Kavita knows ---
first = upload(uploader, f"{series} v01.cbz", comicinfo_cbz(), COMICS)
wait_pending(admin, first)
status, res = app("POST", f"/api/review/{first}/approve", admin,
                  {"libraryId": COMICS, "seriesName": series, "filename": f"{series} v01.cbz", "metadata": {"Number": "1"}})
check("the first file is approved into the series", status == 202, f"{status} {res}")
cleanup_paths.append(MEDIA / "comics" / series)
wait_approved(admin, first)

sid = None
for _ in range(60):
    sid = series_id(series)
    if sid:
        break
    import time
    time.sleep(3)
check("Kavita lists the new series", sid is not None, str(sid))

kavita("POST", "/api/Series/metadata", {
    "seriesId": sid, "summary": "A test summary.", "releaseYear": 2020, "language": "en",
    "writers": [{"id": 0, "name": "Jane Doe"}], "publishers": [{"id": 0, "name": "Acme Press"}],
    "genres": [{"id": 0, "title": "Action"}], "tags": [{"id": 0, "title": "TestTag"}],
})

# --- a second file in the same series, with no metadata of its own ---
second = upload(uploader, f"{series} v02.cbz", plain_cbz(), COMICS)
wait_pending(admin, second)

status, body = app("GET", f"/api/review/{second}/suggest", admin)
check("a matching Kavita series is suggested", status == 200 and body.get("found") is True, f"{status} {str(body)[:160]}")
fields = body.get("fields", {})
check("the series' publisher is suggested", fields.get("Publisher", "").startswith("Acme"), str(fields.get("Publisher")))
check("the series' writer is suggested", "Jane Doe" in fields.get("Writer", ""), str(fields.get("Writer")))
check("the series' year is suggested", fields.get("Year") == "2020", str(fields.get("Year")))
check("the series' genre is suggested", "Action" in fields.get("Genre", ""), str(fields.get("Genre")))
check("the series name is echoed back", body.get("seriesName") == series, str(body.get("seriesName")))

check("the uploader cannot fetch suggestions (403)", app("GET", f"/api/review/{second}/suggest", uploader)[0] == 403)

# --- clean up ---
app("DELETE", f"/api/uploads/{second}", uploader)
for path in cleanup_paths:
    shutil.rmtree(path, ignore_errors=True)
if sid:
    kavita("DELETE", f"/api/Series/{sid}")
check("test series removed from disk", not any(p.exists() for p in cleanup_paths))

sys.exit(finish())
