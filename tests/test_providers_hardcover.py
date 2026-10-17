#!/usr/bin/env python3
"""Hardcover provider-adapter tests (phase 2, W6).

The Hardcover adapter is registered into the W1 framework and pointed at the in-process fake
(tests/provider_fake.py) via PROVIDER_HARDCOVER_BASE, so these run with no network, no real provider and
no real key. Everything goes through the portal's reviewer-only admin routes.

Covers: the registration contract (label, book-only, covers "none", keyed), reviewer-only access,
keyed-gating (enabling without a token leaves it unconfigured and never calls it), the GraphQL POST
body (Typesense Book search vs by-id `books(where:…)`), search -> ranked candidates with band/score,
fetch -> the book field mapping (featured series -> Series, position -> Number/Volume, plainText
summary, contributions -> Writer with roles filtered, default edition -> Publisher/LanguageISO/PageCount,
`eng` -> `en`, and nulls skipped), the read-through record cache, and 429 + Retry-After / non-JSON
refusal. Hardcover is the book *primary*: the registry orders it before Open Library.

Run: python3 tests/test_providers_hardcover.py
"""
import json
import time
from urllib.parse import urlparse

from harness import app, check, finish, login
from provider_fake import ProviderFake
from settings import ORIGIN, ROOT, env

HARDCOVER_BASE = env.get("PROVIDER_HARDCOVER_BASE", "")
HARDCOVER_URL = urlparse(HARDCOVER_BASE)
PORT = HARDCOVER_URL.port or 20905
PATH = HARDCOVER_URL.path or "/v1/graphql"
VERSION = json.loads((ROOT / "kavita-companion" / "package.json").read_text())["version"]
KEY = "hardcover-test-key-" + str(int(time.time()))

fake = ProviderFake(PORT, provider="hardcover").start()


def count_exact(path):
    return len([r for r in fake.requests() if r["path"] == path])


def request_with(fragment):
    seen = [r for r in fake.requests() if fragment in r.get("body", "")]
    return seen[-1] if seen else {}


try:
    if not HARDCOVER_BASE:
        check("PROVIDER_HARDCOVER_BASE is configured", False, "missing from .env")
        raise SystemExit(finish())
    if HARDCOVER_URL.hostname != env.get("DOCKER_GATEWAY"):
        check("hardcover base points at the Docker gateway", False, HARDCOVER_BASE)

    admin = login("ADMIN")
    uploader = login("UPLOADER")
    # Start from a known state: off and keyless (turning off purges the record cache).
    app("POST", "/api/admin/providers", admin, {"id": "hardcover", "enabled": False, "key": ""})

    # --- access control: the admin routes are reviewer-only ---
    check("provider admin list is reviewer-only for uploaders (403)",
          app("GET", "/api/admin/providers", uploader)[0] == 403)
    check("the hardcover test route is reviewer-only for uploaders (403)",
          app("POST", "/api/admin/providers/hardcover/test", uploader)[0] == 403)

    # --- registration contract ---
    status, body = app("GET", "/api/admin/providers", admin)
    hc = next((p for p in body.get("providers", []) if p["id"] == "hardcover"), None)
    check("the hardcover provider is registered", status == 200 and hc is not None, str(body))
    check("hardcover is labelled Hardcover and book-only",
          hc and hc["label"] == "Hardcover" and hc["media"] == ["book"], str(hc))
    check("hardcover carries the Hardcover licence link",
          hc and hc["licence"]["name"] == "API Terms"
          and hc["licence"]["url"] == "https://hardcover.app/pages/policies", str(hc))
    check("hardcover never fetches covers (covers = none)", hc and hc["covers"] == "none", str(hc))
    check("hardcover is keyed and off by default",
          hc and hc["keyed"] is True and hc["enabled"] is False, str(hc))
    fields = set(hc.get("fields", [])) if hc else set()
    check("hardcover's field set covers what it maps",
          {"Title", "Series", "Number", "Volume", "Summary", "Year", "Writer", "Publisher",
           "LanguageISO", "PageCount"} <= fields, str(sorted(fields)))
    check("hardcover does not claim Genre/Tags (its book row has no clean genre list)",
          "Genre" not in fields and "Tags" not in fields, str(sorted(fields)))

    # --- keyed: enabling without a token leaves it unconfigured and never calls it ---
    app("POST", "/api/admin/providers", admin, {"id": "hardcover", "enabled": True})
    _, body = app("GET", "/api/admin/providers", admin)
    hc = next(p for p in body["providers"] if p["id"] == "hardcover")
    check("hardcover enabled without a key stays unconfigured",
          hc["enabled"] is True and hc["configured"] is False and hc["hasKey"] is False, str(hc))
    fake.reset()
    status, body = app("POST", "/api/admin/providers/hardcover/preview", admin, {"query": {"title": "Fixture Book"}})
    check("a keyless hardcover is not called (no-key)",
          status == 200 and body.get("ok") is False and body.get("reason") == "no-key", str(body))
    check("no request reached the fake while keyless", fake.count() == 0, str(fake.requests()))

    # --- with a key it becomes usable ---
    app("POST", "/api/admin/providers", admin, {"id": "hardcover", "key": KEY})
    _, body = app("GET", "/api/admin/providers", admin)
    hc = next(p for p in body["providers"] if p["id"] == "hardcover")
    check("hardcover is usable once a key is set", hc["configured"] is True and hc["hasKey"] is True, str(hc))

    # --- fetch -> full field mapping (featured series, contributions filtered, default edition) ---
    fake.reset()
    status, body = app("POST", "/api/admin/providers/hardcover/preview", admin, {"externalId": "9001", "refresh": True})
    check("hardcover fetch succeeds", status == 200 and body.get("ok") is True and body.get("cached") is False, str(body))
    f = body.get("record", {}).get("fields", {})
    check("Title maps straight through", f.get("Title") == "Fixture Book", str(f))
    check("the *featured* series is chosen (not the first relation)",
          f.get("Series") == "Fixture Series", str(f))
    check("the series position maps to both Number and Volume", f.get("Number") == "2" and f.get("Volume") == "2", str(f))
    check("Summary strips HTML and entities", f.get("Summary") == "A synthetic summary & more.", str(f.get("Summary")))
    check("Year maps from release_year", f.get("Year") == "2018", str(f))
    check("Writer keeps only the author roles, de-duplicated and in order",
          f.get("Writer") == "A. Author, B. Co-Author", str(f.get("Writer")))
    check("Publisher maps from the default ebook edition",
          f.get("Publisher") == "Fixture Press", str(f.get("Publisher")))
    check("LanguageISO maps the edition language code (eng -> en)", f.get("LanguageISO") == "en", str(f.get("LanguageISO")))
    check("PageCount maps from the book's page count", f.get("PageCount") == "320", str(f.get("PageCount")))
    check("the record is tagged as a book", body.get("record", {}).get("media") == "book", str(body.get("record")))
    fetch = request_with('"id":9001')
    check("the fetch is a POST to the GraphQL endpoint with a by-id books query",
          fetch.get("method") == "POST" and fetch.get("path") == PATH
          and "books(" in fetch.get("body", ""), str(fetch)[:200])
    check("hardcover sends a Bearer token and the truthful User-Agent",
          fetch.get("headers", {}).get("Authorization", "").startswith("Bearer ")
          and fetch.get("headers", {}).get("User-Agent", "").startswith(f"kavita-companion/{VERSION} (+{ORIGIN})"),
          str(fetch.get("headers")))
    check("the by-id fetch went out once", count_exact(PATH) == 1, str(fake.requests()))

    # --- a sparse record never invents values (nulls skipped) ---
    fake.reset()
    status, body = app("POST", "/api/admin/providers/hardcover/preview", admin, {"externalId": "9002", "refresh": True})
    f = body.get("record", {}).get("fields", {})
    check("a sparse record maps only what it has",
          status == 200 and f.get("Title") == "Fixture Book" and f.get("Year") == "2020"
          and not ({"Series", "Number", "Volume", "Summary", "Writer", "Publisher", "LanguageISO", "PageCount"} & set(f)),
          str(f))

    # --- record cache: a second fetch of 9001 within the TTL is one call ---
    fake.reset()
    status, body = app("POST", "/api/admin/providers/hardcover/preview", admin, {"externalId": "9001"})
    check("a second fetch within the TTL is served from cache",
          body.get("ok") is True and body.get("cached") is True and count_exact(PATH) == 0, str(body))

    # --- search -> ranked candidates (exact first, near, then loose) ---
    fake.reset()
    status, body = app("POST", "/api/admin/providers/hardcover/preview", admin,
                       {"query": {"title": "Fixture Book", "year": "2018"}})
    candidates = body.get("candidates", [])
    check("search returns candidates", status == 200 and len(candidates) == 3, str(body)[:200])
    check("a title + year match is banded exact and ranked first",
          candidates and candidates[0]["externalId"] == "9001" and candidates[0]["band"] == "exact"
          and candidates[0]["score"] == 1, str(candidates))
    check("candidates are ordered by score (best first)",
          [c["externalId"] for c in candidates] == ["9001", "9002", "9099"], str(candidates))
    check("a same-title different-year candidate is near, a different title is loose",
          candidates[1]["band"] == "near" and candidates[2]["band"] == "loose"
          and candidates[2]["externalId"] == "9099", str(candidates))
    check("the candidate shows its series position as volume",
          candidates[0].get("volume") == "2" and candidates[0].get("year") == "2018", str(candidates[0]))
    search = request_with("query_type")
    check("the search POSTs a Typesense Book query",
          search.get("method") == "POST" and "query_type" in search.get("body", "")
          and "Book" in search.get("body", ""), str(search)[:200])

    # --- the series hint breaks a tie between equally-scored title matches (the title is the key) ---
    fake.reset()
    tied = {"data": {"search": {"results": [
        {"id": 9101, "title": "The Final Empire", "featured_series": {"name": "Elantris"}, "release_year": None},
        {"id": 9102, "title": "The Final Empire", "featured_series": {"name": "Mistborn"}, "release_year": None},
    ]}}}
    fake.script(PATH, [{"json": tied}, {"fixture": "record", "provider": "hardcover"},
                       {"json": tied}, {"fixture": "record", "provider": "hardcover"}])
    status, body = app("POST", "/api/admin/providers/hardcover/preview", admin,
                       {"query": {"title": "The Final Empire", "series": "Mistborn"}})
    check("the series hint promotes the matching series on a title tie",
          [c["externalId"] for c in body.get("candidates", [])] == ["9102", "9101"], str(body.get("candidates")))
    status, body = app("POST", "/api/admin/providers/hardcover/preview", admin,
                       {"query": {"title": "The Final Empire"}})
    check("without a series hint the provider order is kept (it never overrides the title)",
          [c["externalId"] for c in body.get("candidates", [])] == ["9101", "9102"], str(body.get("candidates")))

    # --- 429 with Retry-After is retried, then succeeds (a fresh id bypasses the cache) ---
    fake.reset()
    fake.script(PATH, [{"status": 429, "retry_after": 1}, {"fixture": "record", "provider": "hardcover"}])
    status, body = app("POST", "/api/admin/providers/hardcover/preview", admin, {"externalId": "8999", "refresh": True})
    check("a 429 is retried after Retry-After and the fetch succeeds",
          status == 200 and body.get("ok") is True, str(body))
    check("the 429 caused exactly one retry", count_exact(PATH) == 2, str(count_exact(PATH)))

    # --- an HTML (non-JSON) body is refused, never parsed ---
    fake.reset()
    fake.script(PATH, [{"body": "<html><body>not json</body></html>", "content_type": "text/html"}])
    status, body = app("POST", "/api/admin/providers/hardcover/preview", admin, {"externalId": "8998", "refresh": True})
    check("an HTML body is refused as non-JSON",
          status == 200 and body.get("ok") is False and "HTML" in str(body.get("error", "")), str(body))

    # --- leave hardcover off and keyless again ---
    app("POST", "/api/admin/providers", admin, {"id": "hardcover", "enabled": False, "key": ""})
    _, body = app("GET", "/api/admin/providers", admin)
    hc = next(p for p in body["providers"] if p["id"] == "hardcover")
    check("cleanup left hardcover off and keyless",
          hc["enabled"] is False and hc["hasKey"] is False, str(hc))
finally:
    fake.stop()

raise SystemExit(finish())
