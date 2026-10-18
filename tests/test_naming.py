#!/usr/bin/env python3
"""Media naming cleanup: the review card's defaults are cleaned before a reviewer sees them.

Uploads CBZs (with embedded ComicInfo) and EPUBs (with dc:title / calibre:series) whose names carry
scene tags, bare years, orphan brackets, a repeated series prefix or a trailing series blurb, and
reads the defaults from /api/review. Everything stays pending (no library writes) and is withdrawn.

Run: python3 tests/test_naming.py
"""
import io
import os
import secrets
import sys
import time
import zipfile

from harness import app, check, finish, login, upload
from settings import library_ids

LIBS = library_ids()
COMICS, BOOKS, MANGA = LIBS["Comics"], LIBS["Books"], LIBS["Manga"]
tag = "".join(secrets.choice("abcdefghjkmnpqrstuvwxyz") for _ in range(6))
uploaded = []
_seq = 0

admin = login("ADMIN")
uploader = login("UPLOADER")


def comicinfo(**fields):
    body = "".join(f"<{k}>{v}</{k}>" for k, v in fields.items())
    return f'<?xml version="1.0"?><ComicInfo>{body}</ComicInfo>'.encode()


def cbz(info=None):
    """A one-page CBZ, optionally with a ComicInfo.xml."""
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w", zipfile.ZIP_STORED) as z:
        z.writestr("001.jpg", b"\xff\xd8\xff\xe0" + os.urandom(2000))
        if info is not None:
            z.writestr("ComicInfo.xml", info)
    return buf.getvalue()


def epub(dc_title=None, calibre_series=None, calibre_index=None, dc_creator=None):
    """A minimal but valid EPUB; each call is byte-unique so duplicate detection never trips."""
    global _seq
    _seq += 1
    meta = ""
    if dc_title is not None:
        meta += f"<dc:title>{dc_title}</dc:title>"
    if dc_creator is not None:
        meta += f"<dc:creator>{dc_creator}</dc:creator>"
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
    # --- comic / manga: the series Kavita or the file reports is cleaned ---
    id_comic = upload(uploader, f"Whatever {tag} 001.cbz",
                      cbz(comicinfo(Series="(Halcyon (1968-1996)",
                                     Title="Halcyon 001 (2020) (Digital) (Zone-Empire)")), COMICS)
    id_manga = upload(uploader, f"Whatever {tag} 001.cbz",
                      cbz(comicinfo(Series="Ascendant (2021) (Digital) (LuCaZ)")), MANGA)
    id_trade = upload(uploader, f"Kc Trade {tag} Vol. 05 - Part 01 (2017) (Digital) (Zone-Empire).cbr",
                      cbz(), COMICS)

    # --- books: the Title loses a repeated series prefix and a trailing series blurb ---
    id_blurb = upload(uploader, f"Blurb {tag}.epub",
                      epub(dc_title="The Gate of the Silver Gods: Dungeon Delver Book 4",
                           calibre_series="Dungeon Delver", calibre_index="4"), BOOKS)
    id_prefix = upload(uploader, f"Prefix {tag}.epub",
                       epub(dc_title="Dungeon Delver: A LitRPG/Gamelit Adventure",
                            calibre_series="Dungeon Delver", calibre_index="1"), BOOKS)
    id_dirty = upload(uploader, f"Dirty {tag}.epub",
                      epub(dc_title="The Utterly Complete Guide to Everything (2005)",
                           calibre_series="(Dungeon Delver", calibre_index="2"), BOOKS)
    id_colon = upload(uploader, f"Colon {tag}.epub", epub(dc_title="Vermilion: Requiem"), BOOKS)
    id_author_series = upload(uploader, f"AuthorSeries {tag}.epub",
                              epub(dc_title="The Utterly Complete Guide to Everything",
                                   dc_creator="Dana Aldridge", calibre_series="Dana Aldridge"), BOOKS)

    uploaded += [id_comic, id_manga, id_blurb, id_prefix, id_dirty, id_colon, id_author_series, id_trade]

    items = {}
    for _ in range(90):
        items = {i["id"]: i for i in app("GET", "/api/review", admin)[1].get("pending", [])}
        if all(defaults_of(items, i) for i in uploaded):
            break
        time.sleep(1)

    c = defaults_of(items, id_comic)
    check("a comic's bracketed year range and orphan bracket are stripped from the series",
          c.get("Series") == "Halcyon", str(c))

    m = defaults_of(items, id_manga)
    check("a manga's year and scanner tag are stripped from the series",
          m.get("Series") == "Ascendant", str(m))

    t = defaults_of(items, id_trade)
    check("a Vol. trade suggests no issue number (a subtitle 'Part 01' is not one)",
          t.get("Volume") == "5" and not t.get("Number"), str(t))

    b = defaults_of(items, id_blurb)
    check("a trailing series blurb is dropped from a book title",
          b.get("Title") == "The Gate of the Silver Gods" and b.get("Series") == "Dungeon Delver", str(b))
    check("the staged name is the cleaned canonical name",
          (items.get(id_blurb) or {}).get("stagedName")
          == "Dungeon Delver #4 - The Gate of the Silver Gods.epub",
          str((items.get(id_blurb) or {}).get("stagedName")))

    p = defaults_of(items, id_prefix)
    check("a repeated series prefix is dropped from a book title",
          p.get("Title") == "A LitRPG/Gamelit Adventure", str(p))

    d = defaults_of(items, id_dirty)
    check("a book's orphan bracket and bare year are stripped",
          d.get("Series") == "Dungeon Delver"
          and d.get("Title") == "The Utterly Complete Guide to Everything", str(d))

    y = defaults_of(items, id_colon)
    check("a standalone title with a colon is left alone",
          y.get("Title") == "Vermilion: Requiem", str(y))

    s = defaults_of(items, id_author_series)
    check("an author written as the series is not treated as a series",
          not s.get("Series") and s.get("Title") == "The Utterly Complete Guide to Everything", str(s))
finally:
    for upload_id in uploaded:
        app("DELETE", f"/api/uploads/{upload_id}", uploader)

raise SystemExit(finish())
