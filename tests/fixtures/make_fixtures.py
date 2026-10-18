#!/usr/bin/env python3
"""Generate the synthetic fixture set for the Lectern handover (pre-flight item 3).

Everything here is invented: the book is "Fixture Book" by "Fixture Author", the series is
"Fixture Saga", the pages are flat-colour PNGs. Nothing is derived from a real book, and nothing
comes from Kavita. Files are structurally valid so a parser can be exercised against them.
"""
import binascii
import io
import os
import shutil
import struct
import subprocess
import sys
import zipfile
import zlib

OUT = os.path.abspath(sys.argv[1] if len(sys.argv) > 1 else os.path.dirname(os.path.abspath(__file__)))
os.makedirs(OUT, exist_ok=True)
SEVEN_ZIP = os.environ.get("SEVEN_ZIP", "7zzs")

BOOK_TITLE = "Fixture Book"
BOOK_AUTHOR = "Fixture Author"
SERIES = "Fixture Saga"
FIXED_TIME = 1577836800  # 2020-01-01, so regeneration is byte-reproducible


# ---------------------------------------------------------------- PNG
def png(width, height, rgb):
    """A minimal, valid 8-bit RGB PNG of one flat colour."""
    def chunk(tag, data):
        return struct.pack(">I", len(data)) + tag + data + struct.pack(">I", binascii.crc32(tag + data) & 0xFFFFFFFF)
    raw = b"".join(b"\x00" + bytes(rgb) * width for _ in range(height))
    return (b"\x89PNG\r\n\x1a\n"
            + chunk(b"IHDR", struct.pack(">IIBBBBB", width, height, 8, 2, 0, 0, 0))
            + chunk(b"IDAT", zlib.compress(raw, 9))
            + chunk(b"IEND", b""))


PAGES = {
    "page-001.png": png(64, 96, (200, 40, 40)),
    "page-002.png": png(64, 96, (40, 160, 60)),
    "page-003.png": png(64, 96, (40, 60, 200)),
}


def _zi(name):
    """A zip entry with a pinned timestamp, so the archives are byte-reproducible."""
    return zipfile.ZipInfo(name, date_time=(1980, 1, 1, 0, 0, 0))


# ---------------------------------------------------------------- EPUB
def epub(with_metadata):
    meta = (f"<dc:title>{BOOK_TITLE}</dc:title>"
            "<dc:identifier id=\"bookid\">urn:uuid:fixture-0001</dc:identifier>"
            "<dc:language>en</dc:language>")
    extra = ""
    if with_metadata:
        meta += f"<dc:creator>{BOOK_AUTHOR}</dc:creator><dc:date>2020-01-01</dc:date>"
        extra = (f'<meta name="calibre:series" content="{SERIES}"/>'
                 f'<meta name="calibre:series_index" content="1"/>')
    opf = (
        '<?xml version="1.0" encoding="utf-8"?>\n'
        '<package xmlns="http://www.idpf.org/2007/opf" version="2.0" unique-identifier="bookid">\n'
        '  <metadata xmlns:dc="http://purl.org/dc/elements/1.1/" '
        'xmlns:opf="http://www.idpf.org/2007/opf">'
        f'{meta}{extra}</metadata>\n'
        '  <manifest>\n'
        '    <item id="ncx" href="toc.ncx" media-type="application/x-dtbncx+xml"/>\n'
        '    <item id="ch1" href="ch1.xhtml" media-type="application/xhtml+xml"/>\n'
        '  </manifest>\n'
        '  <spine toc="ncx"><itemref idref="ch1"/></spine>\n'
        '</package>\n')
    ncx = ('<?xml version="1.0" encoding="utf-8"?>\n'
           '<ncx xmlns="http://www.daisy.org/z3986/2005/ncx/" version="2005-1">'
           '<head><meta name="dtb:uid" content="urn:uuid:fixture-0001"/></head>'
           f'<docTitle><text>{BOOK_TITLE}</text></docTitle>'
           '<navMap><navPoint id="n1" playOrder="1"><navLabel><text>Chapter 1</text></navLabel>'
           '<content src="ch1.xhtml"/></navPoint></navMap></ncx>\n')
    chapter = ('<?xml version="1.0" encoding="utf-8"?>\n'
               '<html xmlns="http://www.w3.org/1999/xhtml"><head><title>Chapter 1</title></head>'
               f'<body><h1>{BOOK_TITLE}</h1><p>A synthetic fixture page. Nothing here is real.</p>'
               '</body></html>\n')
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w") as z:
        z.writestr(zipfile.ZipInfo("mimetype", date_time=(1980, 1, 1, 0, 0, 0)),
                   b"application/epub+zip", compress_type=zipfile.ZIP_STORED)
        z.writestr(_zi("META-INF/container.xml"),
                   '<?xml version="1.0" encoding="utf-8"?>\n'
                   '<container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container">'
                   '<rootfiles><rootfile full-path="OEBPS/content.opf" '
                   'media-type="application/oebps-package+xml"/></rootfiles></container>\n')
        z.writestr(_zi("OEBPS/content.opf"), opf)
        z.writestr(_zi("OEBPS/toc.ncx"), ncx)
        z.writestr(_zi("OEBPS/ch1.xhtml"), chapter)
    return buf.getvalue()


# ---------------------------------------------------------------- CBZ / ZIP
def comicinfo():
    return ('<?xml version="1.0" encoding="utf-8"?>\n'
            '<ComicInfo xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" '
            'xmlns:xsd="http://www.w3.org/2001/XMLSchema">'
            f'<Series>{SERIES}</Series><Number>1</Number><Volume>1</Volume>'
            f'<Title>{BOOK_TITLE}</Title><Writer>{BOOK_AUTHOR}</Writer>'
            '<Publisher>Fixture Press</Publisher><Year>2020</Year><Month>1</Month>'
            '<PageCount>3</PageCount><Genre>Action</Genre><LanguageISO>en</LanguageISO>'
            '<Manga>No</Manga></ComicInfo>\n')


def zip_pages(with_comicinfo):
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w", zipfile.ZIP_STORED) as z:
        for name, data in PAGES.items():
            z.writestr(_zi(name), data)
        if with_comicinfo:
            z.writestr(_zi("ComicInfo.xml"), comicinfo())
    return buf.getvalue()


# ---------------------------------------------------------------- PDF
def pdf():
    """A minimal but structurally valid single-page PDF, with a correct xref table."""
    text = f"BT /F1 14 Tf 20 100 Td ({BOOK_TITLE}) Tj ET"
    objects = [
        b"<< /Type /Catalog /Pages 2 0 R >>",
        b"<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
        b"<< /Type /Page /Parent 2 0 R /MediaBox [0 0 200 200] /Contents 4 0 R "
        b"/Resources << /Font << /F1 5 0 R >> >> >>",
        b"<< /Length " + str(len(text)).encode() + b" >>\nstream\n" + text.encode() + b"\nendstream",
        b"<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
    ]
    out = bytearray(b"%PDF-1.4\n%\xe2\xe3\xcf\xd3\n")
    offsets = []
    for i, body in enumerate(objects, start=1):
        offsets.append(len(out))
        out += str(i).encode() + b" 0 obj\n" + body + b"\nendobj\n"
    xref_at = len(out)
    out += b"xref\n0 " + str(len(objects) + 1).encode() + b"\n"
    out += b"0000000000 65535 f \n"
    for off in offsets:
        out += ("%010d 00000 n \n" % off).encode()
    out += (b"trailer\n<< /Size " + str(len(objects) + 1).encode() + b" /Root 1 0 R >>\n"
            b"startxref\n" + str(xref_at).encode() + b"\n%%EOF\n")
    return bytes(out)


# ---------------------------------------------------------------- RAR4
def _dos_time(y=2020, mo=1, d=1, h=0, mi=0, s=0):
    return ((y - 1980) << 25) | (mo << 21) | (d << 16) | (h << 11) | (mi << 5) | (s // 2)


def rar4(files):
    """A genuine RAR 4.x archive, store method, hand-built.

    There is no RAR encoder on this host and none may be installed, so the container is written
    directly from the published RAR 4 layout. Verified by listing it with 7-Zip.
    """
    def crc16(data):
        return binascii.crc32(data) & 0xFFFF

    out = bytearray(b"Rar!\x1a\x07\x00")  # RAR4 marker block

    main = struct.pack("<BHHHI", 0x73, 0x0000, 13, 0, 0)
    out += struct.pack("<H", crc16(main)) + main

    for name, data in files.items():
        nb = name.encode()
        body = struct.pack("<BHHIIBIIBBHI", 0x74, 0x0000, 0, len(data), len(data), 3,
                           binascii.crc32(data) & 0xFFFFFFFF, _dos_time(), 20, 0x30, len(nb), 0x81A4) + nb
        body = struct.pack("<BHHIIBIIBBHI", 0x74, 0x0000, 2 + len(body), len(data), len(data), 3,
                           binascii.crc32(data) & 0xFFFFFFFF, _dos_time(), 20, 0x30, len(nb), 0x81A4) + nb
        out += struct.pack("<H", crc16(body)) + body + data

    end = struct.pack("<BHH", 0x7b, 0x4000, 7)
    out += struct.pack("<H", crc16(end)) + end
    return bytes(out)


# ---------------------------------------------------------------- build
def write(name, data):
    path = os.path.join(OUT, name)
    with open(path, "wb") as fh:
        fh.write(data)
    print(f"  {len(data):>8,}  {name}")
    return path


print("writing fixtures to", OUT)
write("sample.epub", epub(False))
write("sample-metadata.epub", epub(True))
write("sample.pdf", pdf())
write("sample.cbz", zip_pages(False))
write("sample-comicinfo.cbz", zip_pages(True))
write("sample.zip", zip_pages(False))
write("sample.rar", rar4(PAGES))
write("sample.cbr", rar4(PAGES))
# A comic archive whose extension lies about its container. Real files do this constantly and the
# rule spec calls it out, so the corpus needs the case.
write("sample-mislabelled.cbr", zip_pages(False))

# 7z-family containers, via the bundled 7-Zip CLI.
staging = os.path.join(OUT, ".pages")
os.makedirs(staging, exist_ok=True)
for name, data in PAGES.items():
    path = os.path.join(staging, name)
    with open(path, "wb") as fh:
        fh.write(data)
    os.utime(path, (FIXED_TIME, FIXED_TIME))  # so the 7z container is byte-reproducible
for name in ("sample.cb7", "sample.7z"):
    target = os.path.join(OUT, name)
    if os.path.exists(target):
        os.remove(target)
    subprocess.run([SEVEN_ZIP, "a", "-t7z", "-bso0", "-bsp0", target, *PAGES.keys()],
                   cwd=staging, check=True)
    print(f"  {os.path.getsize(target):>8,}  {name}")
shutil.rmtree(staging, ignore_errors=True)

# .azw is the older Kindle extension for the same MOBI container.
mobi = os.path.join(OUT, "sample.mobi")
if os.path.exists(mobi):
    with open(mobi, "rb") as fh:
        write("sample.azw", fh.read())
else:
    print("  (skipped sample.azw: sample.mobi is not present)")
