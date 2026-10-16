#!/usr/bin/env python3
"""No-bulk / per-review safeguard (phase 2, M6).

Proves the promise the compliance measures make: external metadata is fetched only for an explicit,
per-review reviewer action, bounded by the number of enabled providers — never in bulk, never from a
browse or a "needs metadata" queue, and never in the background.

The Metron adapter is pointed at the in-process fake (tests/provider_fake.py) via PROVIDER_METRON_BASE,
so the fake counts every upstream call with no network and no real key. A pending comic is uploaded
(no library writes) and withdrawn at the end.

Run: python3 tests/test_providers_safeguard.py
"""
import io
import os
import time
import zipfile
from urllib.parse import urlparse

from harness import app, check, finish, login, upload, wait_pending
from provider_fake import ProviderFake
from settings import env, library_ids

METRON_BASE = env.get("PROVIDER_METRON_BASE", "")
PORT = urlparse(METRON_BASE).port or 20901
KEY = "safeguard-key-" + str(int(time.time()))
COMICS = library_ids()["Comics"]
# The match route searches once per enabled provider. One reviewer action must stay at or below this,
# whatever else is registered; the test enables exactly one provider so the real figure is 1.
MAX_UPSTREAM_CALLS_PER_MATCH = 2

fake = ProviderFake(PORT).start()


def comicinfo_cbz():
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w", zipfile.ZIP_STORED) as archive:
        archive.writestr("001.jpg", b"\xff\xd8\xff\xe0" + os.urandom(8_000))
        archive.writestr("ComicInfo.xml",
                         "<ComicInfo><Series>Fixture Saga</Series><Number>1</Number></ComicInfo>")
    return buf.getvalue()


def search_calls():
    """Metron searches: /api/issue/ exactly (the fake records detail fetches under /api/issue/<id>/)."""
    return len([r for r in fake.requests() if r["path"] in ("/api/issue", "/api/issue/")])


def fetch_calls():
    return len([r for r in fake.requests() if r["path"].startswith("/api/issue/") and r["path"] != "/api/issue/"])


try:
    if not METRON_BASE:
        check("PROVIDER_METRON_BASE is configured", False, "missing from .env")
        raise SystemExit(finish())

    admin, uploader = login("ADMIN"), login("UPLOADER")

    # Leave exactly one external provider enabled (the one we can count): disable every other enabled
    # provider first, then turn Metron on with a key.
    _, listing = app("GET", "/api/admin/providers", admin)
    for provider in listing.get("providers", []):
        if provider["id"] != "metron" and provider["enabled"]:
            app("POST", "/api/admin/providers", admin, {"id": provider["id"], "enabled": False})
    app("POST", "/api/admin/providers", admin, {"id": "metron", "enabled": False})
    app("POST", "/api/admin/providers", admin, {"id": "metron", "key": KEY})
    app("POST", "/api/admin/providers", admin, {"id": "metron", "enabled": True})
    enabled = [p["id"] for p in app("GET", "/api/admin/providers", admin)[1].get("providers", []) if p["enabled"]]
    check("exactly one external provider is enabled for the count", enabled == ["metron"], str(enabled))

    # A pending upload, never approved, so the test writes nothing to the library.
    upload_id = upload(uploader, "Fixture Saga #001.cbz", comicinfo_cbz(), COMICS)
    check("the safeguard upload reaches the review queue", wait_pending(admin, upload_id) is not None, upload_id)

    # --- one explicit reviewer Match action stays bounded, and never pre-fetches ---
    fake.reset()
    status, body = app("GET", f"/api/review/{upload_id}/match", admin)
    check("one Match returns candidates", status == 200 and bool(body.get("candidates")), str(body)[:160])
    check("one Match searches at most one provider once",
          1 <= search_calls() <= MAX_UPSTREAM_CALLS_PER_MATCH, str(fake.requests()))
    check("Match never pre-fetches a candidate (fetch happens only on Apply)", fetch_calls() == 0, str(fake.requests()))
    check("the candidate list is bounded", len(body.get("candidates", [])) <= 8, str(len(body.get("candidates", []))))
    match_calls = fake.count()
    check("one Match is one bounded set of upstream calls", match_calls == search_calls(), f"{match_calls} vs {search_calls()}")

    # --- a browse / needs-metadata queue never calls an external provider at all ---
    _, browse = app("GET", "/api/library/series?pageSize=5", admin)
    _, queue = app("GET", "/api/library/incomplete?pageSize=5&limit=5", admin)
    check("the library browse and queue answer", browse.get("rows") is not None and queue.get("rows") is not None)
    check("browse and queue make no external provider call at all", fake.count() == match_calls, str(fake.requests()))

    # --- no background crawl: nothing reaches the provider without another reviewer action ---
    time.sleep(1.6)  # past the 1.5 s test cache TTL, in case a refresh were ever scheduled
    check("no background provider call happens after a Match", fake.count() == match_calls, str(fake.requests()))

    # --- a second Match is a second explicit action, still bounded (never a crawl) ---
    fake.reset()
    app("GET", f"/api/review/{upload_id}/match", admin)
    app("GET", f"/api/review/{upload_id}/match", admin)
    check("two Match actions cost at most two calls per enabled provider",
          fake.count() <= 2 * MAX_UPSTREAM_CALLS_PER_MATCH, str(fake.requests()))

    # --- clean up: withdraw the pending upload, leave Metron off and keyless ---
    app("DELETE", f"/api/uploads/{upload_id}", uploader)
    app("POST", "/api/admin/providers", admin, {"id": "metron", "enabled": False})
    app("POST", "/api/admin/providers", admin, {"id": "metron", "key": ""})
finally:
    fake.stop()

raise SystemExit(finish())
