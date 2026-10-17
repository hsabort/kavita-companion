#!/usr/bin/env python3
"""Fix on a standalone book: the folder is the author, the file is the title.

Regression guard: the Fix form used to seed Series from the *folder* (the author), so re-saving a
standalone book produced "<Author> - <Title>" (and sometimes a spurious number). It must agree with
the review card and leave the book as "<Author>/<Title>.epub".

Uploads and approves its own EPUB, checks the Fix form and a re-save, then removes everything.

Run: python3 tests/test_fix_book.py
"""
import io
import json
import secrets
import shutil
import sys
import time
import zipfile

from harness import app, check, finish, kavita, login, request, upload
from settings import KAVITA_LOCAL, MEDIA, env, library_ids

BOOKS = library_ids()["Books"]
tag = "".join(secrets.choice("abcdefghjkmnpqrstuvwxyz") for _ in range(6))
author = f"Kc7 Author {tag}"
title = f"Standalone {tag}"

admin = login("ADMIN")
uploader = login("UPLOADER")


def epub(dc_title, dc_creator=None):
    """A minimal but valid EPUB; byte-unique so duplicate detection never trips."""
    meta = f"<dc:title>{dc_title}</dc:title>"
    if dc_creator:
        meta += f"<dc:creator>{dc_creator}</dc:creator>"
    meta += f'<dc:identifier id="id">urn:uuid:{tag}</dc:identifier><dc:language>en</dc:language>'
    opf = ('<?xml version="1.0"?><package xmlns="http://www.idpf.org/2007/opf" version="2.0" '
           'unique-identifier="id"><metadata xmlns:dc="http://purl.org/dc/elements/1.1/">'
           f'{meta}</metadata><manifest/><spine/></package>').encode()
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w") as z:
        z.writestr(zipfile.ZipInfo("mimetype"), b"application/epub+zip", compress_type=zipfile.ZIP_STORED)
        z.writestr("META-INF/container.xml",
                   b'<container><rootfiles><rootfile full-path="OEBPS/content.opf"/></rootfiles></container>')
        z.writestr("OEBPS/content.opf", opf)
        z.writestr("OEBPS/ch1.xhtml", f"<html/>{tag}".encode())
    return buf.getvalue()


def wait_state(upload_id, predicate, timeout=200):
    item = None
    for _ in range(timeout // 2):
        item = app("GET", f"/api/review/{upload_id}/state", admin)[1].get("item")
        if item and predicate(item):
            return item
        time.sleep(2)
    return item


def wait_defaults(upload_id, timeout=90):
    for _ in range(timeout):
        items = {i["id"]: i for i in app("GET", "/api/review", admin)[1].get("pending", [])}
        if items.get(upload_id, {}).get("defaults"):
            return items[upload_id]["defaults"]
        time.sleep(1)
    return {}


def kavita_series_in_books(name):
    status, _, out = request("POST", KAVITA_LOCAL + "/api/Series/v2?PageNumber=1&PageSize=500",
                             json.dumps({"statements": [{"comparison": 0, "field": 19, "value": str(BOOKS)}],
                                         "combination": 1}).encode(),
                             {"x-api-key": env["COMPANION_KAVITA_AUTH_KEY"], "Content-Type": "application/json"})
    return next((s for s in json.loads(out) if s["name"] == name), None)


# --- Upload a standalone book: an embedded author, no series, a title-only file name ---
uid = upload(uploader, f"{title}.epub", epub(title, author), BOOKS)
defaults = wait_defaults(uid)
check("card: standalone book has no Series", not defaults.get("Series"), str(defaults))
check("card: Title is the file's title", defaults.get("Title") == title, str(defaults))
check("card: the embedded author is kept as Writer", defaults.get("Writer") == author, str(defaults))

status, res = app("POST", f"/api/review/{uid}/approve", admin,
                  {"libraryId": BOOKS, "seriesName": defaults.get("Series", ""), "filename": f"{title}.epub",
                   "metadata": defaults})
check("approve accepted (202)", status == 202, f"{status} {res}")
wait_state(uid, lambda i: i["status"] == "approved")
book_dir = MEDIA / "books" / author
standalone = book_dir / f"{title}.epub"
prefixed = book_dir / f"{author} - {title}.epub"
check("standalone lands as <Author>/<Title>.epub", standalone.exists() and not prefixed.exists(),
      str(sorted(p.name for p in book_dir.iterdir())) if book_dir.exists() else "no folder")

# --- The Fix form must agree (this is the regression) ---
status, fix = app("GET", f"/api/review/{uid}/fix", admin)
fi = fix.get("item", {})
check("fix form keeps it standalone (no author-as-series)",
      status == 200 and not fi.get("defaults", {}).get("Series"), str(fi.get("defaults")))
check("fix form's current name is the title", fi.get("currentFilename") == title, str(fi.get("currentFilename")))

# --- Re-saving the fix changes nothing ---
d = fi.get("defaults", {})
status, res = app("POST", f"/api/review/{uid}/fix", admin,
                  {"libraryId": BOOKS, "seriesName": d.get("Series", ""),
                   "filename": fi.get("filename", f"{title}.epub"), "metadata": d})
check("re-saving the fix is accepted (202)", status == 202, f"{status} {res}")
item = wait_state(uid, lambda i: i["status"] == "approved" and not i.get("reviewError"))
check("re-saving keeps <Author>/<Title>.epub (no author prefix)",
      standalone.exists() and not prefixed.exists() and not item.get("reviewError"),
      f"{item} {sorted(p.name for p in book_dir.iterdir()) if book_dir.exists() else 'no folder'}")

# --- Clean up ---
shutil.rmtree(book_dir, ignore_errors=True)
series = kavita_series_in_books(author)
if series:
    kavita("DELETE", f"/api/Series/{series['id']}")
check("test files cleaned up", not book_dir.exists())

finish()
