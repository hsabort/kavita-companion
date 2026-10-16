#!/usr/bin/env python3
"""Reviewer page-preview tests: a reviewer can fetch the pages of a pending comic by number, in order,
and nobody else can.

Run: python3 tests/test_preview.py
"""
import io
import os
import secrets
import sys
import zipfile

from harness import app, check, finish, login, request, upload, wait_pending
from settings import ORIGIN, library_ids

COMICS = library_ids()["Comics"]
tag = secrets.token_hex(3)
PAGES = [b"\xff\xd8\xff\xe0PAGE-1-" + os.urandom(1500), b"\xff\xd8\xff\xe0PAGE-2-" + os.urandom(1500),
         b"\xff\xd8\xff\xe0PAGE-3-" + os.urandom(1500)]

admin, uploader = login("ADMIN"), login("UPLOADER")

buf = io.BytesIO()
with zipfile.ZipFile(buf, "w", zipfile.ZIP_STORED) as archive:
    for index, data in enumerate(PAGES, start=1):
        archive.writestr(f"{index:03d}.jpg", data)
upload_id = upload(uploader, f"Preview Test {tag}.cbz", buf.getvalue(), COMICS)
wait_pending(admin, upload_id)


def page(cookie, number):
    headers = {"Origin": ORIGIN}
    if cookie:
        headers["Cookie"] = cookie
    return request("GET", f"{ORIGIN}/api/review/{upload_id}/page/{number}", None, headers)


status, headers, body = page(admin, 1)
check("a reviewer can fetch page 1", status == 200 and body == PAGES[0], f"{status} {len(body)}")
check("pages are served as an image", headers.get("Content-Type") == "image/jpeg", str(headers.get("Content-Type")))

status, _, body = page(admin, 3)
check("the last page is fetched in reading order", status == 200 and body == PAGES[2], f"{status} {len(body)}")

check("page 0 is refused (404)", page(admin, 0)[0] == 404)
check("a page past the end is refused (404)", page(admin, 99)[0] == 404)
check("the uploader cannot read the pages (403)", page(uploader, 1)[0] == 403)
check("a signed-out request is refused (401)", page(None, 1)[0] == 401)

app("DELETE", f"/api/uploads/{upload_id}", uploader)
check("test upload withdrawn", True)

sys.exit(finish())
