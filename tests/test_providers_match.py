#!/usr/bin/env python3
"""Review-card external-metadata tests (phase 2, W8): GET/POST /api/review/:id/match and
POST /api/review/:id/apply.

Exercises the reviewer flow through the portal's real HTTP surface, with the Metron adapter pointed at
the in-process fake (tests/provider_fake.py). No network, no real provider, no real keys. The upload
stays pending (no library writes) and is withdrawn at the end.

Covers: access control (reviewer-only, 401/403, CSRF), the attribution/About surface, /match using
the upload's parsed defaults, and /apply's merge rules — fill blanks, never overwrite silently
(conflicts returned), an explicit overwrite mode, the field allow-list, and the cache-first fetch.

Run: python3 tests/test_providers_match.py
"""
import io
import os
import time
import zipfile
from urllib.parse import urlparse

from harness import app, check, finish, login, request, upload, wait_pending
from provider_fake import ProviderFake
from settings import ORIGIN, env, library_ids

METRON_BASE = env.get("PROVIDER_METRON_BASE", "")
PORT = urlparse(METRON_BASE).port or 20901
KEY = "match-test-key-" + str(int(time.time()))
COMICS = library_ids()["Comics"]

fake = ProviderFake(PORT).start()


def count_exact(path):
    """Requests whose path matches exactly (fake.count() matches by prefix)."""
    return len([r for r in fake.requests() if r["path"] == path])


def comicinfo_cbz():
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w", zipfile.ZIP_STORED) as archive:
        archive.writestr("001.jpg", b"\xff\xd8\xff\xe0" + os.urandom(8_000))
        archive.writestr("ComicInfo.xml",
                         "<ComicInfo><Series>Fixture Saga</Series><Number>1</Number></ComicInfo>")
    return buf.getvalue()


try:
    if not METRON_BASE:
        check("PROVIDER_METRON_BASE is configured", False, "missing from .env")
        raise SystemExit(finish())

    admin, uploader = login("ADMIN"), login("UPLOADER")
    # Start from a clean provider state: turning off purges the record cache and series links.
    app("POST", "/api/admin/providers", admin, {"id": "metron", "enabled": False})
    app("POST", "/api/admin/providers", admin, {"id": "metron", "key": KEY})
    app("POST", "/api/admin/providers", admin, {"id": "metron", "enabled": True})

    # --- About -> Metadata sources (attribution surface, any signed-in user) ---
    check("metadata sources require sign-in (401)", app("GET", "/api/metadata-sources")[0] == 401)
    status, sources = app("GET", "/api/metadata-sources", uploader)
    metron_source = next((p for p in sources.get("providers", []) if p["id"] == "metron"), None)
    check("metadata sources lists Metron with its required credit",
          status == 200 and metron_source and metron_source["attribution"] == "Comic data from Metron, CC BY-SA 4.0",
          str(metron_source))
    check("metadata sources carries the licence link",
          metron_source and metron_source["licence"]["url"] == "https://creativecommons.org/licenses/by-sa/4.0/",
          str(metron_source))

    # --- a pending comic with Series/Number in its own embedded metadata ---
    upload_id = upload(uploader, "Fixture Saga #001.cbz", comicinfo_cbz(), COMICS)
    check("the upload reaches the review queue", wait_pending(admin, upload_id) is not None, upload_id)

    # --- access control ---
    check("match requires sign-in (401)", app("GET", f"/api/review/{upload_id}/match")[0] == 401)
    check("match is reviewer-only for uploaders (403)", app("GET", f"/api/review/{upload_id}/match", uploader)[0] == 403)
    check("apply is reviewer-only for uploaders (403)",
          app("POST", f"/api/review/{upload_id}/apply", uploader, {"provider": "metron", "externalId": "7001"})[0] == 403)
    csrf, _, _ = request("POST", ORIGIN + f"/api/review/{upload_id}/match", b'{}', {"Content-Type": "application/json"})
    check("match refuses a POST with no Origin (CSRF 403)", csrf == 403)

    # --- phase-1 /suggest still answers ---
    check("the phase-1 /suggest route still works", app("GET", f"/api/review/{upload_id}/suggest", admin)[0] == 200)

    # --- /match uses the upload's parsed defaults (Series "Fixture Saga", Number 1) ---
    fake.reset()
    status, body = app("GET", f"/api/review/{upload_id}/match", admin)
    candidates = body.get("candidates", [])
    check("match returns ranked candidates", status == 200 and len(candidates) == 3, str(body)[:200])
    check("match defaults to the file's series/number",
          body.get("query", {}).get("title") == "Fixture Saga" and body["query"].get("number") == "1", str(body.get("query")))
    check("match maps the comic library to comic media", body.get("media") == "comic", str(body.get("media")))
    check("the top candidate is the matching issue",
          candidates and candidates[0]["externalId"] == "7001" and candidates[0]["band"] == "near", str(candidates[:1]))
    check("a candidate carries its source and attribution",
          candidates and candidates[0]["source"] == "Metron"
          and candidates[0]["attribution"] == "Comic data from Metron, CC BY-SA 4.0", str(candidates[:1]))
    metron_status = next((p for p in body.get("providers", []) if p["id"] == "metron"), None)
    check("match reports the provider as usable",
          metron_status and metron_status["skipped"] is None and metron_status["attribution"] == "Comic data from Metron, CC BY-SA 4.0",
          str(metron_status))
    check("the search reached Metron once", count_exact("/api/issue/") == 1, str(fake.requests()))

    # --- /apply fill: blanks fill, existing values are kept and reported as conflicts ---
    fake.reset()
    apply_body = {"provider": "metron", "externalId": "7001", "mode": "fill", "refresh": True,
                  "current": {"Series": "Fixture Saga", "Publisher": "My Own Press"}}
    status, applied = app("POST", f"/api/review/{upload_id}/apply", admin, apply_body)
    fields = applied.get("fields", {})
    check("apply succeeds and reports the fetch as fresh", status == 200 and applied.get("ok") is True and applied.get("cached") is False,
          str(applied)[:200])
    check("apply fills a blank field (Year)", fields.get("Year") == "2012" and applied["provenance"].get("Year") == "metron",
          str(fields))
    check("apply fills creator roles (Writer)", fields.get("Writer") == "A. Writer, C. Colourist", str(fields.get("Writer")))
    check("apply never overwrites an existing Series",
          "Series" not in fields and any(c["field"] == "Series" and c["proposed"] == "Fixture Saga" for c in applied.get("conflicts", [])),
          str(applied.get("conflicts")))
    check("a differing existing value is a conflict, not a fill",
          "Publisher" not in fields and any(c["field"] == "Publisher" and c["current"] == "My Own Press" and c["proposed"] == "Fixture Press"
                                            for c in applied.get("conflicts", [])),
          str(applied.get("conflicts")))
    check("apply carries the attribution and licence",
          applied.get("attribution") == "Comic data from Metron, CC BY-SA 4.0"
          and applied["licence"]["url"] == "https://creativecommons.org/licenses/by-sa/4.0/", str(applied.get("attribution")))
    check("a comic's apply never offers Volume (Kavita would fork the series)",
          "Volume" not in fields, str(fields))

    # --- cache-first: a second apply for the same id does not call the provider again ---
    status, second = app("POST", f"/api/review/{upload_id}/apply", admin,
                         {"provider": "metron", "externalId": "7001", "mode": "fill"})
    check("a second apply is served from the record cache",
          second.get("ok") is True and second.get("cached") is True and count_exact("/api/issue/7001/") == 1,
          f"cached={second.get('cached')} calls={count_exact('/api/issue/7001/')}")

    # --- fill from the file's own defaults when the card sends no current values ---
    _, applied = app("POST", f"/api/review/{upload_id}/apply", admin,
                     {"provider": "metron", "externalId": "7001", "mode": "fill"})
    check("with no current values, the file's own Series is still not overwritten",
          "Series" not in applied["fields"] and any(c["field"] == "Series" for c in applied["conflicts"]),
          str(applied.get("conflicts")))

    # --- explicit overwrite mode replaces an existing value ---
    _, applied = app("POST", f"/api/review/{upload_id}/apply", admin,
                     {"provider": "metron", "externalId": "7001", "mode": "overwrite", "fields": ["Year"],
                      "current": {"Year": "1999"}})
    check("overwrite mode replaces an existing value",
          applied["fields"].get("Year") == "2012" and not applied.get("conflicts"), str(applied)[:200])

    # --- the field allow-list restricts what is proposed ---
    _, applied = app("POST", f"/api/review/{upload_id}/apply", admin,
                     {"provider": "metron", "externalId": "7001", "mode": "fill", "fields": ["Year"]})
    check("only the selected fields are proposed",
          set(applied["fields"].keys()) == {"Year"} and set(applied["provenance"].keys()) == {"Year"}, str(applied["fields"]))

    # --- a provider that fails is reported, not hidden (offline/error state) ---
    fake.reset()
    fake.script("/api/issue/", [{"status": 500}, {"status": 500}, {"status": 500}])
    status, body = app("GET", f"/api/review/{upload_id}/match", admin)
    failed = next((p for p in body.get("providers", []) if p["id"] == "metron"), None)
    check("a failing provider is reported as an error with its message",
          status == 200 and not body.get("candidates") and failed and failed["skipped"] == "error" and failed.get("error"),
          str(failed))

    # --- refusals ---
    check("an unknown provider is refused (400)",
          app("POST", f"/api/review/{upload_id}/apply", admin, {"provider": "nope", "externalId": "1"})[0] == 400)
    app("POST", "/api/admin/providers", admin, {"id": "metron", "enabled": False})
    check("a provider that is turned off is refused (409)",
          app("POST", f"/api/review/{upload_id}/apply", admin, {"provider": "metron", "externalId": "7001"})[0] == 409)

    # --- clean up: withdraw the pending upload, leave Metron off and keyless ---
    app("DELETE", f"/api/uploads/{upload_id}", uploader)
    app("POST", "/api/admin/providers", admin, {"id": "metron", "key": ""})
    _, body = app("GET", "/api/admin/providers", admin)
    metron = next(p for p in body["providers"] if p["id"] == "metron")
    check("cleanup left Metron off and keyless", metron["enabled"] is False and metron["hasKey"] is False, str(metron))
finally:
    fake.stop()

raise SystemExit(finish())
