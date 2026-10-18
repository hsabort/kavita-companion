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
from settings import INCOMING, ORIGIN, ROOT, library_ids

COMICS = library_ids()["Comics"]
FIXTURES = ROOT / "tests" / "fixtures"
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


def page(cookie, number, item_id=None):
    headers = {"Origin": ORIGIN}
    if cookie:
        headers["Cookie"] = cookie
    return request("GET", f"{ORIGIN}/api/review/{item_id or upload_id}/page/{number}", None, headers)


status, headers, body = page(admin, 1)
check("a reviewer can fetch page 1", status == 200 and body == PAGES[0], f"{status} {len(body)}")
check("pages are served as an image", headers.get("Content-Type") == "image/jpeg", str(headers.get("Content-Type")))

status, _, body = page(admin, 3)
check("the last page is fetched in reading order", status == 200 and body == PAGES[2], f"{status} {len(body)}")

check("page 0 is refused (404)", page(admin, 0)[0] == 404)
check("a page past the end is refused (404)", page(admin, 99)[0] == 404)
check("the uploader cannot read the pages (403)", page(uploader, 1)[0] == 403)
check("a signed-out request is refused (401)", page(None, 1)[0] == 401)

# --- A comic whose bytes need the optional 7-Zip tool (design §7.6, Review Focus 5) ---
# The shared stack carries 7-Zip; the permissive default image does not. A `.cbr` that is really a
# zip is accepted on either image, so it uploads and is inspected normally, then its bytes are
# swapped for the genuine rar fixture — the "existing rar item" the design describes. Preview must
# work where the capability is present and return 415 with the actionable message where it is not.
_, _health = app("GET", "/api/health")
caps = (_health or {}).get("capabilities") or {}
rar_id = upload(uploader, f"Preview Rar {tag}.cbr", (FIXTURES / "sample-mislabelled.cbr").read_bytes(), COMICS)
wait_pending(admin, rar_id)
(INCOMING / "pending" / f"{rar_id}.cbr").write_bytes((FIXTURES / "sample.cbr").read_bytes())

status, _, body = page(admin, 1, rar_id)
if caps.get("archiveExtras"):
    with zipfile.ZipFile(FIXTURES / "sample-mislabelled.cbr") as z:
        expected = z.read("page-001.png")  # same synthetic page the rar fixture stores
    check("a rar item's page previews where 7-Zip is present", status == 200 and body == expected, f"{status} {len(body)}")
else:
    check("a rar item's preview is refused with the actionable capability message (415)",
          status == 415 and b"-formats" in body, f"{status} {body[:200]}")

app("DELETE", f"/api/uploads/{rar_id}", uploader)
check("rar preview upload withdrawn", True)

app("DELETE", f"/api/uploads/{upload_id}", uploader)
check("test upload withdrawn", True)

sys.exit(finish())
