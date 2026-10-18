#!/usr/bin/env python3
"""Book identification (title-first): how a book upload's Title/Series/Number are derived.

Uploads bare and oddly-named EPUBs to the Books library and reads the review-card defaults from
/api/review. The uploads stay pending (no library writes) and are withdrawn at the end.

Run: python3 tests/test_book_identification.py
"""
import io
import secrets
import sys
import time
import zipfile
from urllib.parse import parse_qs, urlparse

from harness import app, check, finish, login, upload
from provider_fake import ProviderFake
from settings import INCOMING, env, library_ids

BOOKS = library_ids()["Books"]
PENDING = INCOMING / "pending"
tag = "".join(secrets.choice("abcdefghjkmnpqrstuvwxyz") for _ in range(6))
uploaded = []
_seq = 0

admin = login("ADMIN")
uploader = login("UPLOADER")


def epub(dc_title=None, calibre_series=None, calibre_index=None):
    """A minimal but valid EPUB; each call is byte-unique so duplicate detection never trips."""
    global _seq
    _seq += 1
    meta = ""
    if dc_title is not None:
        meta += f"<dc:title>{dc_title}</dc:title>"
    meta += f'<dc:identifier id="id">urn:uuid:{tag}-{_seq}</dc:identifier><dc:language>en</dc:language>'
    calibre = ""
    if calibre_series is not None:
        calibre += f'<meta name="calibre:series" content="{calibre_series}"/>'
    if calibre_index is not None:
        calibre += f'<meta name="calibre:series_index" content="{calibre_index}"/>'
    opf = ('<?xml version="1.0"?><package xmlns="http://www.idpf.org/2007/opf" version="2.0" '
           'unique-identifier="id"><metadata xmlns:dc="http://purl.org/dc/elements/1.1/">'
           f'{meta}{calibre}</metadata><manifest/><spine/></package>').encode()
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w") as z:
        z.writestr(zipfile.ZipInfo("mimetype"), b"application/epub+zip", compress_type=zipfile.ZIP_STORED)
        z.writestr("META-INF/container.xml",
                   b'<container><rootfiles><rootfile full-path="OEBPS/content.opf"/></rootfiles></container>')
        z.writestr("OEBPS/content.opf", opf)
        z.writestr("OEBPS/ch1.xhtml", f"<html/>{tag}{_seq}".encode())
    return buf.getvalue()


def defaults_of(items, upload_id):
    return (items.get(upload_id) or {}).get("defaults") or {}


try:
    id_vermilion = upload(uploader, "Vermilion.epub", epub(), BOOKS)
    id_ashfall = upload(uploader, "Ashfall 01 - The Cinder Throne.epub", epub(), BOOKS)
    id_author = upload(uploader, "B. A. Corwin - The Cinder Throne.epub", epub(), BOOKS)
    id_crossfire = upload(uploader, "Cross-Fire.epub", epub(), BOOKS)
    id_2087 = upload(uploader, "2087.epub", epub(), BOOKS)
    id_embedded = upload(uploader, "F. R. Halloway - Vermilion.epub",
                         epub(dc_title="Vermilion", calibre_series="Vermilion", calibre_index="1"), BOOKS)
    uploaded += [id_vermilion, id_ashfall, id_author, id_crossfire, id_2087, id_embedded]

    items = {}
    for _ in range(90):
        items = {i["id"]: i for i in app("GET", "/api/review", admin)[1].get("pending", [])}
        if all(defaults_of(items, i) for i in uploaded):
            break
        time.sleep(1)

    d = defaults_of(items, id_vermilion)
    check("a bare title becomes the book Title", d.get("Title") == "Vermilion", str(d))
    check("a bare title invents no series", not d.get("Series"), str(d))

    m = defaults_of(items, id_ashfall)
    check("a series-prefixed name splits into Series/Number/Title",
          m.get("Series") == "Ashfall" and m.get("Number") == "1" and m.get("Title") == "The Cinder Throne", str(m))

    a = defaults_of(items, id_author)
    check("an author-prefixed name keeps the title clean and invents no series",
          a.get("Title") == "The Cinder Throne" and not a.get("Series"), str(a))
    check("an 'Author - Title' name supplies the author", a.get("Writer") == "B. A. Corwin", str(a))

    c = defaults_of(items, id_crossfire)
    check("a hyphen in a title is not a series separator", c.get("Title") == "Cross-Fire", str(c))

    y = defaults_of(items, id_2087)
    check("a numeric title is not treated as a number", y.get("Title") == "2087", str(y))

    e = defaults_of(items, id_embedded)
    check("embedded metadata wins over the filename guess",
          e.get("Series") == "Vermilion" and e.get("Title") == "Vermilion" and e.get("Number") == "1", str(e))

    # --- a book is renamed to its canonical name before it is put in front of a reviewer (Task 4) ---
    check("the review item shows the staged canonical name",
          defaults_of(items, id_ashfall) is not None and (items.get(id_ashfall) or {}).get("stagedName")
          == "Ashfall #1 - The Cinder Throne.epub", str((items.get(id_ashfall) or {}).get("stagedName")))
    check("the staged file on disk is renamed to match",
          (PENDING / f"{id_ashfall} Ashfall #1 - The Cinder Throne.epub").exists()
          and not (PENDING / f"{id_ashfall}.epub").exists(),
          str(sorted(p.name for p in PENDING.iterdir() if p.name.startswith(id_ashfall))))
    check("a standalone book is staged under its title",
          (PENDING / f"{id_vermilion} Vermilion.epub").exists(), str(sorted(p.name for p in PENDING.iterdir() if p.name.startswith(id_vermilion[:8]))))

    # --- the search key: a book searches by its Title, with its series as a hint (Task 2) ---
    ol_fake = ProviderFake(urlparse(env.get("PROVIDER_OPENLIBRARY_BASE", "")).port or 20906,
                           provider="openlibrary").start()
    try:
        app("POST", "/api/admin/providers", admin, {"id": "openlibrary", "enabled": True})
        ol_fake.reset()
        docs = {"numFound": 2, "docs": [
            {"key": "/works/OL1W", "title": "The Cinder Throne", "series": ["Emberlight"]},
            {"key": "/works/OL2W", "title": "The Cinder Throne", "series": ["Ashfall"]},
        ]}
        ol_fake.script("/search.json", [{"json": docs}, {"json": docs}])

        _, body = app("GET", f"/api/review/{id_ashfall}/match", admin)
        q = body.get("query") or {}
        check("a book searches by its Title, with its series as a hint",
              q.get("title") == "The Cinder Throne" and q.get("series") == "Ashfall", str(q))
        ol_candidates = [c for c in body.get("candidates", []) if c.get("provider") == "openlibrary"]
        check("the title search reaches the provider and returns its candidates",
              {c["externalId"] for c in ol_candidates} == {"OL1W", "OL2W"}, str(ol_candidates))
        calls = ol_fake.requests("/search.json")
        check("the lookup asked the provider once, with the title as the term",
              len(calls) == 1 and parse_qs(calls[0]["query"]).get("q") == ["The Cinder Throne"],
              str([(r["path"], r["query"]) for r in calls]))

        _, body = app("GET", f"/api/review/{id_author}/match", admin)
        check("an 'Author - Title' name searches the title, never the author",
              (body.get("query") or {}).get("title") == "The Cinder Throne", str(body.get("query")))
    finally:
        app("POST", "/api/admin/providers", admin, {"id": "openlibrary", "enabled": False})
        ol_fake.stop()
finally:
    for upload_id in uploaded:
        app("DELETE", f"/api/uploads/{upload_id}", uploader)

raise SystemExit(finish())
