#!/usr/bin/env python3
"""Open Library provider-adapter tests (phase 2, W7).

The Open Library adapter is registered into the W1 framework and pointed at the in-process fake
(tests/provider_fake.py) via PROVIDER_OPENLIBRARY_BASE, so these run with no network, no real provider
and no keys. Everything goes through the portal's reviewer-only admin routes.

Covers: the registration contract (label, book-only, covers "none", keyless), reviewer-only access,
keyless usability once enabled, the REST calls (`/search.json`, `/isbn/{isbn}.json`, `/books/{olid}.json`,
`/works/{id}.json`, `/works/{id}/editions.json`, `/authors/{id}.json`), search -> ranked candidates with
band/score, fetch -> the book field mapping (title, description object -> plainText summary, year,
author_name -> Writer, edition publishers -> Publisher, MARC `eng` -> `en`, subjects -> Genre/Tags),
fetch by ISBN and by work id, the read-through record cache, and 429 + Retry-After / non-JSON refusal.
Open Library is the book *fallback*: the registry orders it after Hardcover.

Run: python3 tests/test_providers_openlibrary.py
"""
import json
from urllib.parse import parse_qs, urlparse

from harness import app, check, finish, login
from provider_fake import ProviderFake
from settings import ORIGIN, ROOT, env

OPENLIBRARY_BASE = env.get("PROVIDER_OPENLIBRARY_BASE", "")
OPENLIBRARY_URL = urlparse(OPENLIBRARY_BASE)
PORT = OPENLIBRARY_URL.port or 20906
VERSION = json.loads((ROOT / "kavita-companion" / "package.json").read_text())["version"]

fake = ProviderFake(PORT, provider="openlibrary").start()


def count_exact(path):
    return len([r for r in fake.requests() if r["path"] == path])


def last_at(prefix):
    seen = fake.requests(prefix)
    return seen[-1] if seen else {}


try:
    if not OPENLIBRARY_BASE:
        check("PROVIDER_OPENLIBRARY_BASE is configured", False, "missing from .env")
        raise SystemExit(finish())
    if OPENLIBRARY_URL.hostname != env.get("DOCKER_GATEWAY"):
        check("openlibrary base points at the Docker gateway", False, OPENLIBRARY_BASE)

    admin = login("ADMIN")
    uploader = login("UPLOADER")
    # Start from a known state: off (turning off purges the record cache).
    app("POST", "/api/admin/providers", admin, {"id": "openlibrary", "enabled": False})

    # --- access control: the admin routes are reviewer-only ---
    check("provider admin list is reviewer-only for uploaders (403)",
          app("GET", "/api/admin/providers", uploader)[0] == 403)
    check("the openlibrary test route is reviewer-only for uploaders (403)",
          app("POST", "/api/admin/providers/openlibrary/test", uploader)[0] == 403)

    # --- registration contract ---
    status, body = app("GET", "/api/admin/providers", admin)
    ol = next((p for p in body.get("providers", []) if p["id"] == "openlibrary"), None)
    check("the openlibrary provider is registered", status == 200 and ol is not None, str(body))
    check("openlibrary is labelled Open Library and book-only",
          ol and ol["label"] == "Open Library" and ol["media"] == ["book"], str(ol))
    check("openlibrary carries the Internet Archive licence",
          ol and ol["licence"]["name"] == "Internet Archive (no new rights asserted)"
          and ol["licence"]["url"] == "https://openlibrary.org/developers/api", str(ol))
    check("openlibrary never fetches covers (covers = none)", ol and ol["covers"] == "none", str(ol))
    check("openlibrary is keyless and off by default",
          ol and ol["keyed"] is False and ol["enabled"] is False, str(ol))
    fields = set(ol.get("fields", [])) if ol else set()
    check("openlibrary's field set covers what it maps",
          {"Title", "Summary", "Year", "Writer", "Publisher", "Genre", "Tags", "LanguageISO"} <= fields,
          str(sorted(fields)))

    # --- keyless: enabling is enough to use it ---
    app("POST", "/api/admin/providers", admin, {"id": "openlibrary", "enabled": True})
    _, body = app("GET", "/api/admin/providers", admin)
    ol = next(p for p in body["providers"] if p["id"] == "openlibrary")
    check("openlibrary is usable once enabled (no key needed)",
          ol["enabled"] is True and ol["configured"] is True, str(ol))

    # --- fetch by work id -> full field mapping (work + edition + authors) ---
    fake.reset()
    status, body = app("POST", "/api/admin/providers/openlibrary/preview", admin,
                       {"externalId": "OL9001W", "refresh": True})
    check("openlibrary fetch succeeds", status == 200 and body.get("ok") is True and body.get("cached") is False, str(body))
    f = body.get("record", {}).get("fields", {})
    check("Title maps from the work", f.get("Title") == "Fixture Book", str(f))
    check("Summary unwraps the description object and strips HTML",
          f.get("Summary") == "A synthetic summary & more.", str(f.get("Summary")))
    check("Year maps from first_publish_date when there is no first_publish_year",
          f.get("Year") == "2018", str(f))
    check("Writer resolves the author records (embedded keys -> names)",
          f.get("Writer") == "A. Author, B. Co-Author", str(f.get("Writer")))
    check("Publisher maps from the first edition's publishers list",
          f.get("Publisher") == "Fixture Press", str(f.get("Publisher")))
    check("LanguageISO maps the MARC language code (eng -> en)", f.get("LanguageISO") == "en", str(f.get("LanguageISO")))
    check("Genre takes the genre-like subjects (heuristic)",
          f.get("Genre") == "Science fiction, Fantasy fiction, Fiction", str(f.get("Genre")))
    check("Tags keeps the remaining subjects (no duplication)",
          f.get("Tags") == "Vermilion (Imaginary place), 823/.912", str(f.get("Tags")))
    check("the record is tagged as a book", body.get("record", {}).get("media") == "book", str(body.get("record")))
    check("the work, its first edition and both authors were fetched",
          count_exact("/works/OL9001W.json") == 1 and count_exact("/works/OL9001W/editions.json") == 1
          and count_exact("/authors/OL9001A.json") == 1 and count_exact("/authors/OL9002A.json") == 1,
          str([r["path"] for r in fake.requests()]))
    search_url = last_at("/works/OL9001W.json")
    check("openlibrary sends the truthful User-Agent",
          search_url.get("headers", {}).get("User-Agent", "").startswith(f"kavita-companion/{VERSION} (+{ORIGIN})"),
          str(search_url.get("headers")))

    # --- fetch by ISBN -> /isbn/{isbn}.json then /works/{id}.json ---
    fake.reset()
    status, body = app("POST", "/api/admin/providers/openlibrary/preview", admin,
                       {"externalId": "9780000000001", "refresh": True})
    f = body.get("record", {}).get("fields", {})
    check("an ISBN fetch resolves the edition then the work",
          status == 200 and body.get("ok") is True and count_exact("/isbn/9780000000001.json") == 1
          and count_exact("/works/OL9001W.json") == 1, str([r["path"] for r in fake.requests()]))
    check("an ISBN fetch maps the same fields", f.get("Title") == "Fixture Book" and f.get("Publisher") == "Fixture Press"
          and f.get("LanguageISO") == "en", str(f))

    # --- record cache ---
    fake.reset()
    status, body = app("POST", "/api/admin/providers/openlibrary/preview", admin, {"externalId": "OL9001W"})
    check("a second fetch within the TTL is served from cache",
          body.get("ok") is True and body.get("cached") is True and fake.count() == 0, str(body))

    # --- search -> ranked candidates (exact first, near, then loose) ---
    fake.reset()
    status, body = app("POST", "/api/admin/providers/openlibrary/preview", admin,
                       {"query": {"title": "Fixture Book", "year": "2018"}})
    candidates = body.get("candidates", [])
    check("search returns candidates", status == 200 and len(candidates) == 3, str(body)[:200])
    check("a title + year match is banded exact and ranked first",
          candidates and candidates[0]["externalId"] == "OL9001W" and candidates[0]["band"] == "exact"
          and candidates[0]["score"] == 1, str(candidates))
    check("candidates are ordered by score (best first)",
          [c["externalId"] for c in candidates] == ["OL9001W", "OL9002W", "OL9099W"], str(candidates))
    check("a same-title different-year candidate is near, a different title is loose",
          candidates[1]["band"] == "near" and candidates[2]["band"] == "loose"
          and candidates[2]["externalId"] == "OL9099W", str(candidates))
    check("the candidate carries its work id, title and year",
          candidates[0].get("title") == "Fixture Book" and candidates[0].get("year") == "2018"
          and candidates[0].get("publisher") == "Fixture Press", str(candidates[0]))
    query = parse_qs(last_at("/search.json").get("query", ""))
    check("search calls /search.json with the title",
          query.get("q") == ["Fixture Book"] and query.get("fields"), str(query))

    # --- search by ISBN uses the isbn: query form ---
    fake.reset()
    status, body = app("POST", "/api/admin/providers/openlibrary/preview", admin,
                       {"query": {"title": "", "isbn": "978-0-00-000000-1"}})
    query = parse_qs(last_at("/search.json").get("query", ""))
    check("an ISBN search uses q=isbn:<digits>",
          status == 200 and query.get("q") == ["isbn:9780000000001"], str(query))

    # --- 429 with Retry-After is retried, then succeeds (a fresh id bypasses the cache) ---
    fake.reset()
    fake.script("/works/OL8999W.json", [{"status": 429, "retry_after": 1}, {"fixture": "work", "provider": "openlibrary"}])
    status, body = app("POST", "/api/admin/providers/openlibrary/preview", admin, {"externalId": "OL8999W", "refresh": True})
    check("a 429 is retried after Retry-After and the fetch succeeds",
          status == 200 and body.get("ok") is True, str(body))
    check("the 429 caused exactly one retry", count_exact("/works/OL8999W.json") == 2, str(count_exact("/works/OL8999W.json")))

    # --- an HTML (non-JSON) body is refused, never parsed ---
    fake.reset()
    fake.script("/works/OL8998W.json", [{"body": "<html><body>not json</body></html>", "content_type": "text/html"}])
    status, body = app("POST", "/api/admin/providers/openlibrary/preview", admin, {"externalId": "OL8998W", "refresh": True})
    check("an HTML body is refused as non-JSON",
          status == 200 and body.get("ok") is False and "HTML" in str(body.get("error", "")), str(body))

    # --- leave openlibrary off again ---
    app("POST", "/api/admin/providers", admin, {"id": "openlibrary", "enabled": False})
    _, body = app("GET", "/api/admin/providers", admin)
    ol = next(p for p in body["providers"] if p["id"] == "openlibrary")
    check("openlibrary is off again at the end", ol["enabled"] is False, str(ol))
finally:
    fake.stop()

raise SystemExit(finish())
