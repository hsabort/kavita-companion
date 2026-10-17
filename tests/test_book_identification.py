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
from settings import env, library_ids

BOOKS = library_ids()["Books"]
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
    id_dune = upload(uploader, "Dune.epub", epub(), BOOKS)
    id_mistborn = upload(uploader, "Mistborn 01 - The Final Empire.epub", epub(), BOOKS)
    id_author = upload(uploader, "Brandon Sanderson - The Final Empire.epub", epub(), BOOKS)
    id_catch = upload(uploader, "Catch-22.epub", epub(), BOOKS)
    id_1984 = upload(uploader, "1984.epub", epub(), BOOKS)
    id_embedded = upload(uploader, "Frank Herbert - Dune.epub",
                         epub(dc_title="Dune", calibre_series="Dune", calibre_index="1"), BOOKS)
    uploaded += [id_dune, id_mistborn, id_author, id_catch, id_1984, id_embedded]

    items = {}
    for _ in range(90):
        items = {i["id"]: i for i in app("GET", "/api/review", admin)[1].get("pending", [])}
        if all(defaults_of(items, i) for i in uploaded):
            break
        time.sleep(1)

    d = defaults_of(items, id_dune)
    check("a bare title becomes the book Title", d.get("Title") == "Dune", str(d))
    check("a bare title invents no series", not d.get("Series"), str(d))

    m = defaults_of(items, id_mistborn)
    check("a series-prefixed name splits into Series/Number/Title",
          m.get("Series") == "Mistborn" and m.get("Number") == "1" and m.get("Title") == "The Final Empire", str(m))

    a = defaults_of(items, id_author)
    check("an author-prefixed name keeps the title clean and invents no series",
          a.get("Title") == "The Final Empire" and not a.get("Series"), str(a))

    c = defaults_of(items, id_catch)
    check("a hyphen in a title is not a series separator", c.get("Title") == "Catch-22", str(c))

    y = defaults_of(items, id_1984)
    check("a numeric title is not treated as a number", y.get("Title") == "1984", str(y))

    e = defaults_of(items, id_embedded)
    check("embedded metadata wins over the filename guess",
          e.get("Series") == "Dune" and e.get("Title") == "Dune" and e.get("Number") == "1", str(e))

    # --- the search key: a book searches by its Title, with its series as a hint (Task 2) ---
    ol_fake = ProviderFake(urlparse(env.get("PROVIDER_OPENLIBRARY_BASE", "")).port or 20906,
                           provider="openlibrary").start()
    try:
        app("POST", "/api/admin/providers", admin, {"id": "openlibrary", "enabled": True})
        ol_fake.reset()
        docs = {"numFound": 2, "docs": [
            {"key": "/works/OL1W", "title": "The Final Empire", "series": ["Elantris"]},
            {"key": "/works/OL2W", "title": "The Final Empire", "series": ["Mistborn"]},
        ]}
        ol_fake.script("/search.json", [{"json": docs}, {"json": docs}])

        _, body = app("GET", f"/api/review/{id_mistborn}/match", admin)
        q = body.get("query") or {}
        check("a book searches by its Title, with its series as a hint",
              q.get("title") == "The Final Empire" and q.get("series") == "Mistborn", str(q))
        ol_candidates = [c for c in body.get("candidates", []) if c.get("provider") == "openlibrary"]
        check("the matching series wins a title tie",
              [c["externalId"] for c in ol_candidates] == ["OL2W", "OL1W"], str(ol_candidates))
        calls = ol_fake.requests("/search.json")
        check("the lookup asked the provider once, with the title as the term",
              len(calls) == 1 and parse_qs(calls[0]["query"]).get("q") == ["The Final Empire"],
              str([(r["path"], r["query"]) for r in calls]))

        _, body = app("GET", f"/api/review/{id_author}/match", admin)
        check("an 'Author - Title' name searches the title, never the author",
              (body.get("query") or {}).get("title") == "The Final Empire", str(body.get("query")))
    finally:
        app("POST", "/api/admin/providers", admin, {"id": "openlibrary", "enabled": False})
        ol_fake.stop()
finally:
    for upload_id in uploaded:
        app("DELETE", f"/api/uploads/{upload_id}", uploader)

raise SystemExit(finish())
