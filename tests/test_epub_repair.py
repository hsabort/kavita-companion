#!/usr/bin/env python3
"""Approved EPUBs must be readable by Kavita.

Kavita's EPUB reader (VersOne) is stricter than the portal's, and calibre/mobiunpack output trips it
two ways: an OPF `<guide>` whose `<reference>` items have no `href` ("Incorrect EPUB guide: item href
is missing") and a bare `&` in the NCX XML ("TOC file is not a valid XML file"). Either one leaves the
book on disk but invisible to Kavita. The approve step normalises both before repacking, so a stored
book is always readable.

Uploads a deliberately broken EPUB, approves it, checks the stored copy is sanitised and that Kavita
actually lists it, then removes everything.

Run: python3 tests/test_epub_repair.py
"""
import io
import json
import re
import secrets
import shutil
import sys
import time
import zipfile

from harness import app, check, finish, kavita, login, request, upload
from settings import KAVITA_LOCAL, MEDIA, env, library_ids

BOOKS = library_ids()["Books"]
tag = "".join(secrets.choice("abcdefghjkmnpqrstuvwxyz") for _ in range(6))
author = f"Kc Epub {tag}"
title = f"Kc Epub Repair {tag}"

admin = login("ADMIN")
uploader = login("UPLOADER")

# A bare "&" in an XML element, which VersOne refuses to parse.
BARE_AMP = re.compile(r"&(?!(?:amp|lt|gt|quot|apos|#\d+|#x[0-9a-fA-F]+);)")


def broken_epub():
    """A valid EPUB except for the two defects VersOne rejects."""
    opf = (
        '<?xml version="1.0" encoding="utf-8"?>'
        '<package xmlns="http://www.idpf.org/2007/opf" version="2.0" unique-identifier="id">'
        '<metadata xmlns:dc="http://purl.org/dc/elements/1.1/">'
        f'<dc:title>{title}</dc:title><dc:creator>{author}</dc:creator>'
        f'<dc:identifier id="id">urn:uuid:{tag}</dc:identifier><dc:language>en</dc:language>'
        "</metadata>"
        "<manifest>"
        '<item id="item0" media-type="text/html" href="book.html"/>'
        '<item id="ncx" media-type="application/x-dtbncx+xml" href="toc.ncx"/>'
        "</manifest>"
        '<spine toc="ncx"><itemref idref="item0"/></spine>'
        # The href-less guide reference is the first defect.
        '<guide><reference type="title-page" title="About this title link"/></guide>'
        "</package>"
    ).encode()
    # The bare ampersand in the navLabel is the second defect. The <head> is what calibre writes and
    # what VersOne expects, so the fixture stays realistic.
    ncx = (
        '<?xml version="1.0" encoding="utf-8"?>'
        '<ncx xmlns="http://www.daisy.org/z3986/2005/ncx/" version="2005-1">'
        f'<head><meta content="urn:uuid:{tag}" name="dtb:uid"/><meta content="1" name="dtb:depth"/>'
        '<meta content="0" name="dtb:totalPageCount"/><meta content="0" name="dtb:maxPageNumber"/></head>'
        f"<docTitle><text>{title}</text></docTitle>"
        '<navMap><navPoint id="n1"><navLabel><text>Part 1 & 2</text></navLabel>'
        '<content src="book.html"/></navPoint></navMap>'
        "</ncx>"
    ).encode()
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w") as z:
        z.writestr(zipfile.ZipInfo("mimetype"), b"application/epub+zip", compress_type=zipfile.ZIP_STORED)
        z.writestr("META-INF/container.xml",
                   b'<?xml version="1.0" encoding="utf-8"?>'
                   b'<container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container">'
                   b'<rootfiles><rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/>'
                   b"</rootfiles></container>")
        z.writestr("OEBPS/content.opf", opf)
        z.writestr("OEBPS/toc.ncx", ncx)
        z.writestr("OEBPS/book.html", f"<html><head></head><body><p>{tag}</p></body></html>".encode())
    return buf.getvalue()


def wait_state(upload_id, predicate, timeout=240):
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


# --- Upload the broken EPUB and approve it ---
uid = upload(uploader, f"{title}.epub", broken_epub(), BOOKS)
defaults = wait_defaults(uid)
check("card: Title read from the OPF", defaults.get("Title") == title, str(defaults))
status, res = app("POST", f"/api/review/{uid}/approve", admin,
                  {"libraryId": BOOKS, "seriesName": defaults.get("Series", ""),
                   "filename": f"{title}.epub", "metadata": defaults})
check("approve accepted (202)", status == 202, f"{status} {res}")
item = wait_state(uid, lambda i: i["status"] in ("approved", "rejected"))
check("approval finished", bool(item) and item["status"] == "approved", str(item and item.get("status")))

book_dir = MEDIA / "books" / author
stored = book_dir / f"{title}.epub"
check("book landed at <Author>/<Title>.epub", stored.exists(),
      str(sorted(p.name for p in book_dir.iterdir())) if book_dir.exists() else "no folder")

# --- The stored copy must be sanitised for Kavita ---
opf_stored = ncx_stored = ""
if stored.exists():
    with zipfile.ZipFile(stored) as z:
        opf_stored = z.read("OEBPS/content.opf").decode("utf-8", "replace")
        ncx_stored = z.read("OEBPS/toc.ncx").decode("utf-8", "replace")
guide = re.search(r"<guide[\s\S]*?</guide>|<guide\s*/>", opf_stored)
guide_text = guide.group(0) if guide else ""
check("stored OPF drops the href-less <guide> references", "<reference" not in guide_text, guide_text[:200])
check("stored NCX escapes the bare ampersand",
      "&amp;" in ncx_stored and BARE_AMP.search(ncx_stored) is None, ncx_stored[:200])

# --- And Kavita must actually list it (the end-to-end proof) ---
item = wait_state(uid, lambda i: i.get("kavitaStatus") == "confirmed", timeout=240)
check("Kavita lists the repaired book", bool(item) and item.get("kavitaStatus") == "confirmed",
      str(item and item.get("kavitaStatus")))

# --- Clean up ---
shutil.rmtree(book_dir, ignore_errors=True)
# A standalone book becomes a series named after its *title*, so check both names.
for name in (title, author):
    series = kavita_series_in_books(name)
    if series:
        kavita("DELETE", f"/api/Series/{series['id']}")
check("test files cleaned up", not book_dir.exists())

finish()
