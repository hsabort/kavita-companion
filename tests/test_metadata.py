#!/usr/bin/env python3
"""M5 acceptance tests: inspection (covers, embedded metadata, warnings), metadata editing written
into the file, CB7 -> CBZ repacking, EPUB metadata, PDF rename, and safety refusals.

Creates .cb7 test archives with the 7-Zip inside the kavita-companion image (needs Docker).
Cleans up everything it creates, including library files and Kavita series.

Run: python3 tests/test_metadata.py
"""
import base64
import io
import json
import os
import pathlib
import re
import secrets
import shutil
import subprocess
import sys
import tempfile
import time
import urllib.error
import urllib.request
import zipfile

from settings import KAVITA_LOCAL as KAVITA, MEDIA, ORIGIN, env, library_ids
from harness import app, kavita, login, request

_libs = library_ids()
COMICS, BOOKS = _libs["Comics"], _libs["Books"]


results = []
# Letters only: a tag like "3601ab" could be read by Kavita's parser as an issue number.
tag = "".join(secrets.choice("abcdefghjkmnpqrstuvwxyz") for _ in range(6))
cleanup_dirs = []
uploaded = []


def check(name, ok, detail=""):
    results.append(bool(ok))
    print(f"{'PASS' if ok else 'FAIL'}  {name}" + (f"  ({detail})" if detail and not ok else ""), flush=True)


def b64(s):
    return base64.b64encode(str(s).encode()).decode()


def upload(cookie, filename, data, library_id):
    meta = f"filename {b64(filename)},libraryId {b64(library_id)}"
    h = {"Origin": ORIGIN, "Cookie": cookie, "Tus-Resumable": "1.0.0"}
    status, headers, body = request("POST", ORIGIN + "/files", None, {**h, "Upload-Length": str(len(data)), "Upload-Metadata": meta})
    assert status == 201, f"create {filename}: {status} {body}"
    location = headers["Location"]
    status, _, body = request("PATCH", ORIGIN + location, data, {**h, "Upload-Offset": "0", "Content-Type": "application/offset+octet-stream"})
    assert status == 204, f"patch {filename}: {status} {body}"
    upload_id = location.rsplit("/", 1)[1]
    uploaded.append(upload_id)
    return upload_id


def review_items(cookie, ids, timeout=90):
    """Wait until each upload is pending and inspected, then return them by id."""
    items = {}
    for _ in range(timeout):
        items = {i["id"]: i for i in app("GET", "/api/review", cookie)[1].get("pending", [])}
        if all(items.get(i, {}).get("defaults") for i in ids):
            return items
        time.sleep(1)
    return items


def wait_result(cookie, upload_id, timeout=180):
    for _ in range(timeout):
        _, queue = app("GET", "/api/review", cookie)
        recent = {i["id"]: i for i in queue.get("recent", [])}
        pending = {i["id"]: i for i in queue.get("pending", [])}
        if recent.get(upload_id, {}).get("status") == "approved":
            return "approved", recent[upload_id]
        if upload_id in pending and pending[upload_id].get("reviewError"):
            return "failed", pending[upload_id]
        time.sleep(1)
    return "timeout", None


def jpeg(seed):
    return b"\xff\xd8\xff\xe0" + seed.encode() + os.urandom(20_000)


def make_cb7(files):
    """Build a .cb7 with 7-Zip inside the companion image."""
    with tempfile.TemporaryDirectory() as tmp:
        src = pathlib.Path(tmp, "src")
        src.mkdir()
        for name, data in files.items():
            (src / name).write_bytes(data)
        os.chmod(tmp, 0o777)
        subprocess.run(["docker", "run", "--rm", "--user", "1001:1001", "-v", f"{tmp}:/w", "-w", "/w/src",
                        "--entrypoint", "7zzs", "kavita-companion:local", "a", "-t7z", "-bd", "/w/out.cb7", "."],
                       check=True, capture_output=True)
        return pathlib.Path(tmp, "out.cb7").read_bytes()


def comicinfo(**fields):
    body = "".join(f"<{k}>{v}</{k}>" for k, v in fields.items())
    return f'<?xml version="1.0"?><ComicInfo>{body}</ComicInfo>'.encode()


def zip_bytes(files, first=None):
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w") as z:
        for name in ([first] if first else []):
            z.writestr(zipfile.ZipInfo(name), files[name], compress_type=zipfile.ZIP_STORED)
        for name, data in files.items():
            if name != first:
                z.writestr(name, data)
    return buf.getvalue()


def read_comicinfo(path):
    with zipfile.ZipFile(path) as z:
        xml = z.read("ComicInfo.xml").decode()
    return {m.group(1): m.group(2) for m in re.finditer(r"<(\w+)>([^<]*)</\1>", xml)}


admin = login("ADMIN")
uploader = login("UPLOADER")
series_a = f"Kc5 Series {tag}"
series_book = f"Kc5 Books {tag}"
cleanup_dirs += [MEDIA / "comics" / series_a, MEDIA / "books" / series_book, MEDIA / "comics" / f"Kc5 Pdf {tag}"]

# --- Files ---
pages_a = {"p001.jpg": jpeg("a1"), "p002.jpg": jpeg("a2"), "p010.jpg": jpeg("a10")}
cb7 = make_cb7({**pages_a, "ComicInfo.xml": comicinfo(Series="Wrong-Name", Number="5", Summary="keep me", Publisher="Pub House", PageCount="9")})
plain_cbz = zip_bytes({"01.jpg": jpeg("b1"), "02.jpg": jpeg("b2")})
opf = (f'<?xml version="1.0"?><package xmlns="http://www.idpf.org/2007/opf" version="2.0" unique-identifier="id">'
       f'<metadata xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:title>Old Title</dc:title><dc:creator>Old Author</dc:creator>'
       f'<dc:identifier id="id">urn:uuid:{tag}</dc:identifier><dc:language>en</dc:language></metadata>'
       f'<manifest/><spine/></package>').encode()
epub = zip_bytes({"mimetype": b"application/epub+zip",
                  "META-INF/container.xml": b'<container><rootfiles><rootfile full-path="OEBPS/content.opf"/></rootfiles></container>',
                  "OEBPS/content.opf": opf, "OEBPS/ch1.xhtml": b"<html/>" + tag.encode()}, first="mimetype")
pdf = b"%PDF-1.4\n%" + os.urandom(2000) + b"\n%%EOF\n"
no_pages = make_cb7({"readme.txt": b"no images here " + tag.encode()})
escape_zip = zip_bytes({"../escape.jpg": jpeg("evil"), "p1.jpg": jpeg("ok")})

id_a = upload(uploader, f"Kc5 Test {tag} 05.cb7", cb7, COMICS)
id_plain = upload(uploader, f"Kc5 Plain {tag} 012.cbz", plain_cbz, COMICS)
id_epub = upload(uploader, f"Kc5 Book {tag}.epub", epub, BOOKS)
id_pdf = upload(uploader, f"Kc5 Pdf {tag} 001.pdf", pdf, COMICS)
id_nopages = upload(uploader, f"Kc5 Empty {tag}.cb7", no_pages, COMICS)
id_escape = upload(uploader, f"Kc5 Escape {tag}.cbz", escape_zip, COMICS)

items = review_items(admin, [id_a, id_plain, id_epub, id_pdf, id_nopages, id_escape])
a, plain = items.get(id_a, {}), items.get(id_plain, {})

# --- Inspection ---
check("CB7: page count read from the archive", a.get("inspection", {}).get("pages") == 3, str(a.get("inspection")))
check("CB7: embedded metadata read", a.get("embedded", {}).get("Publisher") == "Pub House" and a.get("embedded", {}).get("Number") == "5", str(a.get("embedded")))
check("embedded series is the default (Kavita would use it)", a.get("defaults", {}).get("Series") == "Wrong-Name", str(a.get("defaults")))
check("warning: embedded series disagrees with the file name", any("says series" in w for w in a.get("warnings", [])), str(a.get("warnings")))
check("warning: embedded page count is wrong", any("pages" in w for w in a.get("warnings", [])), str(a.get("warnings")))
status, cover = app("GET", f"/api/review/{id_a}/cover", admin, raw=True)
check("cover is the first page in reading order", status == 200 and cover == pages_a["p001.jpg"], str(status))
check("uploader cannot fetch covers (403)", app("GET", f"/api/review/{id_a}/cover", uploader, raw=True)[0] == 403)
check("CBZ without metadata: warning that it will be added",
      any("No metadata inside" in w for w in plain.get("warnings", [])), str(plain.get("warnings")))
check("file name parser fills the number when there's no metadata", plain.get("defaults", {}).get("Number") == "12", str(plain.get("defaults")))
check("archive with a '../' path is flagged", "Unsafe path" in " ".join(items.get(id_escape, {}).get("warnings", [])), str(items.get(id_escape)))
check("archive without images is flagged", any("No page images" in w for w in items.get(id_nopages, {}).get("warnings", [])), str(items.get(id_nopages)))

# --- Validation ---
bad_year = app("POST", f"/api/review/{id_a}/approve", admin, {"libraryId": COMICS, "seriesName": series_a, "filename": "x", "metadata": {"Year": "19x"}})
check("bad year refused (400)", bad_year[0] == 400, str(bad_year))
bad_age = app("POST", f"/api/review/{id_a}/approve", admin, {"libraryId": COMICS, "seriesName": series_a, "filename": "x", "metadata": {"AgeRating": "Bogus"}})
check("unknown age rating refused (400)", bad_age[0] == 400, str(bad_age))

# --- Approve CB7 with corrected metadata -> CBZ with a clean ComicInfo.xml ---
status, res = app("POST", f"/api/review/{id_a}/approve", admin, {
    "libraryId": COMICS, "seriesName": series_a, "filename": f"{series_a} #005.cb7",
    "metadata": {"Number": "5", "Year": "2001", "Writer": "Jane Writer", "AgeRating": "Teen", "Title": "The Fifth"}})
check("approval queued (202) and saved as .cbz whatever was typed", status == 202 and res.get("destination", "").endswith("#005.cbz"), f"{status} {res}")
state, _ = wait_result(admin, id_a)
final_a = MEDIA / "comics" / series_a / f"{series_a} #005.cbz"
check("background repack finished", state == "approved" and final_a.exists(), state)
if final_a.exists():
    with zipfile.ZipFile(final_a) as z:
        names = z.namelist()
        same_pages = all(z.read(n) == pages_a[n] for n in pages_a)
    info = read_comicinfo(final_a)
    check("CB7 became a CBZ with every page identical", same_pages and sorted(n for n in names if n.endswith(".jpg")) == sorted(pages_a), str(names))
    check("ComicInfo: approved series, number and edits written",
          info.get("Series") == series_a and info.get("Number") == "5" and info.get("Year") == "2001"
          and info.get("Writer") == "Jane Writer" and info.get("AgeRating") == "Teen" and info.get("Title") == "The Fifth", str(info))
    check("ComicInfo: untouched fields kept, page count corrected",
          info.get("Summary") == "keep me" and info.get("Publisher") == "Pub House" and info.get("PageCount") == "3", str(info))
    check("exactly one ComicInfo.xml in the archive", names.count("ComicInfo.xml") == 1, str(names))

# --- Kavita files it under the approved series (metadata and folder agree) ---
found = None
for _ in range(60):
    _, all_series = kavita("POST", "/api/Series/v2?PageNumber=1&PageSize=500",
                           {"statements": [{"comparison": 0, "field": 19, "value": str(COMICS)}], "combination": 1})
    found = next((s for s in all_series or [] if s["name"] == series_a), None)
    if found:
        break
    time.sleep(3)
check("Kavita shows the series under the approved name", found is not None)
wrong = [s["name"] for s in (all_series or []) if s["name"] == "Wrong-Name"]
check("the file's old series name did not leak into Kavita", not wrong, str(wrong))
status, contents = app("GET", f"/api/review/series-contents?libraryId={COMICS}&name={urllib.parse.quote(series_a.lower())}", admin)
check("series contents report #5 is already there (case-insensitive lookup)",
      contents.get("exists") and "5" in contents.get("numbers", []), str(contents))

# --- CBZ without metadata into the now-existing series ---
status, res = app("POST", f"/api/review/{id_plain}/approve", admin, {
    "libraryId": COMICS, "seriesName": series_a.upper(), "filename": f"{series_a} #012", "metadata": {"Number": "12"}})
check("second issue goes into the existing series (any capitalisation)", status == 202 and res.get("newSeries") is False, f"{status} {res}")
state, _ = wait_result(admin, id_plain)
final_plain = MEDIA / "comics" / series_a / f"{series_a} #012.cbz"
info = read_comicinfo(final_plain) if final_plain.exists() else {}
check("ComicInfo.xml added to a file that had none", state == "approved" and info.get("Series") == series_a and info.get("Number") == "12", f"{state} {info}")

# --- EPUB metadata ---
status, res = app("POST", f"/api/review/{id_epub}/approve", admin, {
    "libraryId": BOOKS, "seriesName": series_book, "filename": "New Title",
    "metadata": {"Title": "New Title", "Writer": "Ann Lee, Bo Kim", "Number": "2"}})
state, _ = wait_result(admin, id_epub)
final_epub = MEDIA / "books" / series_book / f"{series_book} #2 - New Title.epub"
if final_epub.exists():
    with zipfile.ZipFile(final_epub) as z:
        first = z.infolist()[0]
        new_opf = z.read("OEBPS/content.opf").decode()
    check("EPUB: mimetype is the first entry, uncompressed", first.filename == "mimetype" and first.compress_type == zipfile.ZIP_STORED)
    check("EPUB: title, authors and series written; identifier kept",
          "<dc:title>New Title</dc:title>" in new_opf and "<dc:creator>Bo Kim</dc:creator>" in new_opf
          and f'content="{series_book}"' in new_opf and 'name="calibre:series_index"' in new_opf and f"urn:uuid:{tag}" in new_opf, new_opf[:400])
else:
    check("EPUB approved", False, state)

# --- PDF: renamed only ---
status, res = app("POST", f"/api/review/{id_pdf}/approve", admin, {
    "libraryId": COMICS, "seriesName": f"Kc5 Pdf {tag}", "filename": f"Kc5 Pdf {tag} #001"})
state, _ = wait_result(admin, id_pdf)
final_pdf = MEDIA / "comics" / f"Kc5 Pdf {tag}" / f"Kc5 Pdf {tag} #001.pdf"
check("PDF placed unchanged", state == "approved" and final_pdf.exists() and final_pdf.read_bytes() == pdf, state)

# --- Refusals happen safely, and the upload stays in the queue ---
for upload_id, name, expect in ((id_nopages, "archive without images", "No page images"), (id_escape, "archive with '../' path", "Unsafe path")):
    app("POST", f"/api/review/{upload_id}/approve", admin, {"libraryId": COMICS, "seriesName": f"Kc5 Bad {tag}", "filename": "bad"})
    state, item = wait_result(admin, upload_id)
    check(f"{name}: approval fails with a reason and stays waiting",
          state == "failed" and expect in (item or {}).get("reviewError", ""), f"{state} {(item or {}).get('reviewError')}")
check("nothing was written outside the library", not (MEDIA / "comics" / "escape.jpg").exists() and not (MEDIA / "escape.jpg").exists()
      and not (MEDIA / "comics" / f"Kc5 Bad {tag}").exists() or not any((MEDIA / "comics" / f"Kc5 Bad {tag}").iterdir()))
cleanup_dirs.append(MEDIA / "comics" / f"Kc5 Bad {tag}")

# --- Clean up ---
for uid in uploaded:
    app("DELETE", f"/api/uploads/{uid}", uploader)
for d in cleanup_dirs:
    shutil.rmtree(d, ignore_errors=True)
for lib in (COMICS, BOOKS):
    _, all_series = kavita("POST", "/api/Series/v2?PageNumber=1&PageSize=500",
                           {"statements": [{"comparison": 0, "field": 19, "value": str(lib)}], "combination": 1})
    for s in all_series or []:
        if tag in s["name"]:
            kavita("DELETE", f"/api/Series/{s['id']}")
leftover = [p.name for p in (MEDIA / ".incoming" / "pending").iterdir() if p.name.split(".", 1)[0] in uploaded]
work = list((MEDIA / ".incoming" / "work").iterdir()) if (MEDIA / ".incoming" / "work").exists() else []
check("test files and work folders cleaned up", not leftover and not work and not any(d.exists() for d in cleanup_dirs), f"{leftover} {work}")

print(f"\n{sum(results)}/{len(results)} passed")
sys.exit(0 if all(results) else 1)
