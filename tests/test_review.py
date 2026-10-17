#!/usr/bin/env python3
"""M3 acceptance tests: admin review queue. Uploads test files as test-uploader, reviews them as
test-admin, checks the files land in the right library folder and show up in Kavita, then
removes everything it created (including the library files) and rescans.

Run: python3 tests/test_review.py
"""
import base64
import hashlib
import io
import json
import os
import pathlib
import secrets
import shutil
import sys
import time
import urllib.error
import urllib.request
import zipfile

from settings import KAVITA_LOCAL as KAVITA, MEDIA, ORIGIN, env, library_ids
from harness import app, kavita, login, request

PENDING = MEDIA / ".incoming" / "pending"
_libs = library_ids()
COMICS, BOOKS = _libs["Comics"], _libs["Books"]


results = []
tag = secrets.token_hex(3)
cleanup_paths = []


def check(name, ok, detail=""):
    results.append(bool(ok))
    print(f"{'PASS' if ok else 'FAIL'}  {name}" + (f"  ({detail})" if detail and not ok else ""))


def b64(s):
    return base64.b64encode(str(s).encode()).decode()


def upload(cookie, filename, data, library_id):
    meta = f"filename {b64(filename)},libraryId {b64(library_id)}"
    h = {"Origin": ORIGIN, "Cookie": cookie, "Tus-Resumable": "1.0.0"}
    status, headers, body = request("POST", ORIGIN + "/files", None, {**h, "Upload-Length": str(len(data)), "Upload-Metadata": meta})
    assert status == 201, f"create {filename}: {status} {body}"
    location = headers["Location"]
    status, _, body = request("PATCH", ORIGIN + location, data, {
        **h, "Upload-Offset": "0", "Content-Type": "application/offset+octet-stream"})
    assert status == 204, f"patch {filename}: {status} {body}"
    upload_id = location.rsplit("/", 1)[1]
    for _ in range(60):
        status, mine = app("GET", "/api/uploads", cookie)
        u = next((x for x in mine["uploads"] if x["id"] == upload_id), None)
        if u and u["status"] == "pending":
            return upload_id
        time.sleep(1)
    raise AssertionError(f"{filename} never became pending: {u}")


def wait_approved(cookie, upload_id, timeout=120):
    """Approval runs in the background (M5); wait until it's approved or back to pending."""
    for _ in range(timeout):
        status, queue = app("GET", "/api/review", cookie)
        recent = {i["id"]: i for i in queue.get("recent", [])}
        pending = {i["id"]: i for i in queue.get("pending", [])}
        if recent.get(upload_id, {}).get("status") == "approved":
            return "approved", recent[upload_id]
        if upload_id in pending:
            return "pending", pending[upload_id]
        time.sleep(1)
    return "timeout", None


def wait_ready(cookie, ids, timeout=60):
    """Wait until the server has read (inspected) each pending upload."""
    for _ in range(timeout):
        items = {i["id"]: i for i in app("GET", "/api/review", cookie)[1].get("pending", [])}
        if all(items.get(i, {}).get("defaults") for i in ids):
            return items
        time.sleep(1)
    return items


def cbz():
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w", zipfile.ZIP_STORED) as z:
        z.writestr("001.jpg", b"\xff\xd8\xff\xe0" + os.urandom(100_000))
    return buf.getvalue()


def epub():
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w") as z:
        z.writestr(zipfile.ZipInfo("mimetype"), "application/epub+zip", compress_type=zipfile.ZIP_STORED)
        z.writestr("META-INF/container.xml",
                   '<container><rootfiles><rootfile full-path="OEBPS/content.opf"/></rootfiles></container>')
        z.writestr("OEBPS/content.opf",
                   '<?xml version="1.0"?><package xmlns="http://www.idpf.org/2007/opf" version="2.0" '
                   'unique-identifier="id"><metadata xmlns:dc="http://purl.org/dc/elements/1.1/">'
                   f'<dc:identifier id="id">urn:uuid:{secrets.token_hex(8)}</dc:identifier>'
                   '<dc:language>en</dc:language></metadata><manifest/><spine/></package>')
        z.writestr("OEBPS/ch1.xhtml", f"<html/>{secrets.token_hex(8)}".encode())
    return buf.getvalue()


uploader, admin, readonly = login("UPLOADER"), login("ADMIN"), login("READONLY")

# --- Who may review ---
check("uploader cannot open the review queue (403)", app("GET", "/api/review", uploader)[0] == 403)
check("read-only user cannot open the review queue (403)", app("GET", "/api/review", readonly)[0] == 403)

series = f"Kc Test Series {tag}"
comic_data, conflict_data, mislabelled_data, book_data = cbz(), cbz(), cbz(), epub()
comic_id = upload(uploader, f"{series} v01.cbz", comic_data, COMICS)
conflict_id = upload(uploader, f"{series} v01 (alt).cbz", conflict_data, COMICS)
mislabelled_id = upload(uploader, f"Mislabelled {tag} v02.cbr", mislabelled_data, COMICS)
book_id = upload(uploader, f"Kavita Test Book - Extra {tag}.epub", book_data, BOOKS)

items = wait_ready(admin, [comic_id, conflict_id, mislabelled_id, book_id])
check("admin sees all four uploads in the queue", {comic_id, conflict_id, mislabelled_id, book_id} <= set(items), str(list(items)))
check("series suggested by Kavita's parser",
      items.get(comic_id, {}).get("defaults", {}).get("Series") == series, str(items.get(comic_id, {}).get("defaults")))
check("comic archives (even a zip named .cbr) are saved as .cbz",
      items.get(mislabelled_id, {}).get("targetExtension") == "cbz", str(items.get(mislabelled_id)))

status, data = app("GET", f"/api/review/{comic_id}/download", admin, raw=True)
check("admin can download the file to check it", status == 200 and data == comic_data, str(status))
check("uploader cannot use the download link (403)", app("GET", f"/api/review/{comic_id}/download", uploader, raw=True)[0] == 403)

# --- Approve into a new series; path tricks in the names are neutralised ---
status, res = app("POST", f"/api/review/{comic_id}/approve", admin,
                  {"libraryId": COMICS, "seriesName": f"../../{series}", "filename": f"../../{series} v01.cbz"})
final = MEDIA / "comics" / series / f"{series} v01.cbz"
cleanup_paths.append(MEDIA / "comics" / series)
check("approve is accepted (queued) as a new series", status == 202 and res.get("newSeries") is True, f"{status} {res}")
state, _ = wait_approved(admin, comic_id)
check("background approval completes", state == "approved", state)
check("'../' in series and file names cannot escape the library",
      res.get("destination") == f"/data/comics/{series}/{series} v01.cbz", str(res.get("destination")))
with zipfile.ZipFile(final) as z:
    same_page = z.read("001.jpg") == zipfile.ZipFile(io.BytesIO(comic_data)).read("001.jpg")
    has_info = "ComicInfo.xml" in z.namelist()
check("file is in the library with the same page plus ComicInfo.xml, and gone from staging",
      same_page and has_info and not (PENDING / f"{comic_id}.cbz").exists())
status, _ = app("POST", f"/api/review/{comic_id}/approve", admin, {"libraryId": COMICS, "seriesName": series, "filename": "x.cbz"})
check("approving twice is refused (409)", status == 409, str(status))
mine = {u["id"]: u for u in app("GET", "/api/uploads", uploader)[1]["uploads"]}
check("uploader sees it as approved", mine[comic_id]["status"] == "approved", str(mine[comic_id]))
check("approved file no longer has a Withdraw option", app("DELETE", f"/api/uploads/{comic_id}", uploader)[0] == 409)

# --- Name clash and wrong extension are refused without losing the upload ---
status, res = app("POST", f"/api/review/{conflict_id}/approve", admin,
                  {"libraryId": COMICS, "seriesName": series, "filename": f"{series} v01.cbz"})
check("same file name in the same series refused (409)", status == 409 and "already exists" in res.get("error", ""), f"{status} {res}")
check("refused approval leaves the upload waiting", items and app("GET", "/api/review", admin)[1]["pending"]
      and any(i["id"] == conflict_id for i in app("GET", "/api/review", admin)[1]["pending"]))
# --- A book is saved under its canonical name ('<Series> #<n> - <Title>.epub'), not what was typed ---
status, res = app("POST", f"/api/review/{book_id}/approve", admin,
                  {"libraryId": BOOKS, "seriesName": "Kavita Test Book", "filename": "Typed Name.cbz",
                   "metadata": {"Title": f"Extra {tag}", "Number": "1", "Writer": "A. Writer"}})
book_dir = MEDIA / "books" / "Kavita Test Book"
book_final = book_dir / f"Kavita Test Book #1 - Extra {tag}.epub"
cleanup_paths.append(book_dir)
check("a book is saved as '<Series> #<n> - <Title>.epub', whatever was typed",
      status == 202 and res.get("destination", "").endswith(f"Kavita Test Book #1 - Extra {tag}.epub"), f"{status} {res}")
if status == 202:
    wait_approved(admin, book_id)
    check("the canonical book file is in the library", book_final.exists(), str(res))

# --- A standalone book needs no invented series: it lands in the author's folder ---
author = f"Test Author {tag}"
standalone_id = upload(uploader, "Dune.epub", epub(), BOOKS)
wait_ready(admin, [standalone_id])
status, res = app("POST", f"/api/review/{standalone_id}/approve", admin,
                  {"libraryId": BOOKS, "seriesName": "", "filename": "Dune",
                   "metadata": {"Title": "Dune", "Writer": author}})
standalone_dir = MEDIA / "books" / author
standalone_final = standalone_dir / "Dune.epub"
cleanup_paths.append(standalone_dir)
check("a standalone book is approved with no typed series, into the author's folder",
      status == 202 and res.get("destination", "").endswith(f"{author}/Dune.epub"), f"{status} {res}")
if status == 202:
    wait_approved(admin, standalone_id)
    check("the standalone book file is in the library", standalone_final.exists(), str(res))
    if standalone_final.exists():
        with zipfile.ZipFile(standalone_final) as z:
            opf_name = next(n for n in z.namelist() if n.lower().endswith(".opf"))
            opf = z.read(opf_name).decode()
        check("a standalone book carries no calibre:series, so a re-upload stays standalone",
              "calibre:series" not in opf, opf[:300])

# --- A tagged series and file name are cleaned before they land in the library ---
dirty_series = f"Kc Dirty {tag}"
dirty_id = upload(uploader, f"{dirty_series} 001 (2020) (Digital) (Zone-Empire).cbr", cbz(), COMICS)
wait_ready(admin, [dirty_id])
status, res = app("POST", f"/api/review/{dirty_id}/approve", admin,
                  {"libraryId": COMICS, "seriesName": f"({dirty_series} (1968-1996)",
                   "filename": f"{dirty_series} 001 (2020) (Digital) (Zone-Empire).cbr"})
dirty_dir = MEDIA / "comics" / dirty_series
dirty_final = dirty_dir / f"{dirty_series} 001.cbz"
cleanup_paths.append(dirty_dir)
check("a tagged series and file name are cleaned before they land",
      status == 202 and res.get("destination") == f"/data/comics/{dirty_series}/{dirty_series} 001.cbz", f"{status} {res}")
if status == 202:
    wait_approved(admin, dirty_id)
    check("the cleaned comic file is in the library", dirty_final.exists(), str(res))

# --- A volume the series already names is not repeated in the file name ---
vol_series = f"Kc Vol {tag} v1"
vol_id = upload(uploader, f"{vol_series} 01.cbr", cbz(), COMICS)
wait_ready(admin, [vol_id])
status, res = app("POST", f"/api/review/{vol_id}/approve", admin,
                  {"libraryId": COMICS, "seriesName": vol_series, "filename": f"{vol_series} v01 #001",
                   "metadata": {"Number": "1", "Volume": "1"}})
vol_dir = MEDIA / "comics" / vol_series
vol_final = vol_dir / f"{vol_series} #001.cbz"
cleanup_paths.append(vol_dir)
check("a volume already in the series name is not repeated in the file name",
      status == 202 and res.get("destination") == f"/data/comics/{vol_series}/{vol_series} #001.cbz", f"{status} {res}")
if status == 202:
    wait_approved(admin, vol_id)
    check("the de-duplicated comic file is in the library", vol_final.exists(), str(res))

# --- A book typed into an existing series uses that series' exact name for the file too ---
# NOT covered here: Kavita does not index this stack's Books library (only Comics has series), so
# `seriesInLibrary(Books)` is always empty and the "existing series" branch cannot be reached. The
# generic case-insensitive reuse is covered for Comics in test_metadata; the book-specific part (the
# file name is built from the folder's exact name) is correct by construction but untested here.

# --- Reject, restore, reject ---
status, _ = app("POST", f"/api/review/{mislabelled_id}/reject", admin, {"reason": "Wrong series, please rename."})
mine = {u["id"]: u for u in app("GET", "/api/uploads", uploader)[1]["uploads"]}
check("reject with a reason; uploader sees the reason",
      status == 200 and mine[mislabelled_id]["status"] == "rejected" and "rename" in (mine[mislabelled_id]["error"] or ""), str(mine[mislabelled_id]))
check("rejected file is kept for now (can be restored)", (PENDING / f"{mislabelled_id}.cbr").exists())
recent = {i["id"]: i for i in app("GET", "/api/review", admin)[1]["recent"]}
check("decision appears under recent decisions with restore option",
      recent.get(mislabelled_id, {}).get("canRestore") is True and recent.get(comic_id, {}).get("status") == "approved")
status, _ = app("POST", f"/api/review/{mislabelled_id}/restore", admin, {})
check("restore puts it back in the queue", status == 200 and any(
    i["id"] == mislabelled_id for i in app("GET", "/api/review", admin)[1]["pending"]))
check("uploader cannot approve or reject (403)",
      app("POST", f"/api/review/{mislabelled_id}/reject", uploader, {"reason": "x"})[0] == 403)

# --- Kavita actually shows the approved comic (scan is queued; ~1 minute) ---
found = False
for _ in range(60):
    _, all_series = kavita("POST", "/api/Series/v2?PageNumber=1&PageSize=200",
                           {"statements": [{"comparison": 0, "field": 19, "value": str(COMICS)}], "combination": 1})
    if any(s["name"] == series for s in all_series or []):
        found = True
        break
    time.sleep(3)
check("approved series appears in Kavita", found)

# --- Clean up: withdraw leftovers, remove library files, rescan ---
for uid in (conflict_id, mislabelled_id, dirty_id, vol_id):
    app("DELETE", f"/api/uploads/{uid}", uploader)
for p in cleanup_paths:
    shutil.rmtree(p) if p.is_dir() else p.unlink(missing_ok=True)
# Remove the test series from Kavita directly: scan-folder ignores folders that no longer exist, and
# a library scan refuses to remove series when the library folder is empty (Kavita assumes a
# disconnected drive). Then rescan Books so it drops the extra EPUB from the existing series.
_, comics_series = kavita("POST", "/api/Series/v2?PageNumber=1&PageSize=500",
                          {"statements": [{"comparison": 0, "field": 19, "value": str(COMICS)}], "combination": 1})
for s in comics_series or []:
    if s["name"] == series:
        kavita("DELETE", f"/api/Series/{s['id']}")
kavita("POST", "/api/Library/scan-folder", {"apiKey": env["COMPANION_KAVITA_AUTH_KEY"],
                                            "folderPath": "/data/books/Kavita Test Book", "abortOnNoSeriesMatch": False})
kavita("POST", "/api/Library/scan-folder", {"apiKey": env["COMPANION_KAVITA_AUTH_KEY"],
                                            "folderPath": f"/data/books/Test Author {tag}", "abortOnNoSeriesMatch": False})
# Only this run's files: real uploads may be waiting in the same folder. A staged book is named
# "<id> <canonical>.epub", so match on the id that precedes the first space as well as the first dot.
ours = {comic_id, conflict_id, mislabelled_id, book_id, standalone_id, dirty_id, vol_id}
left = [p.name for p in PENDING.iterdir()
        if p.name.split(" ", 1)[0].split(".", 1)[0] in ours] if PENDING.exists() else []
check("test files cleaned up", not left and not any(p.exists() for p in cleanup_paths), str(left))

print(f"\n{sum(results)}/{len(results)} passed")
sys.exit(0 if all(results) else 1)
