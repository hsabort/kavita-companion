#!/usr/bin/env python3
"""Metron provider-adapter tests (phase 2, W2).

The Metron adapter is registered into the W1 framework and pointed at the in-process fake
(tests/provider_fake.py) via PROVIDER_METRON_BASE, so these run with no network, no real provider and
no real keys. Everything goes through the portal's reviewer-only admin routes.

Covers: the registration contract (licence, comic fields, covers "none", keyed), keyed-gating, search
-> candidates with sensible band/score ordering, fetch -> full ComicInfo field mapping (including the
credits -> Writer/Penciller/Inker/Colorist/CoverArtist split and plainText HTML stripping), the
read-through record cache (a second fetch is served from cache), and 429 + Retry-After / 500 retry and
an HTML (non-JSON) body being refused.

Run: python3 tests/test_providers_metron.py
"""
import json
import time
from urllib.parse import parse_qs, urlparse

from harness import app, check, finish, login
from provider_fake import ProviderFake
from settings import ORIGIN, ROOT, env

METRON_BASE = env.get("PROVIDER_METRON_BASE", "")
METRON_URL = urlparse(METRON_BASE)
PORT = METRON_URL.port or 20901
VERSION = json.loads((ROOT / "kavita-companion" / "package.json").read_text())["version"]
KEY = "test-metron-key-" + str(int(time.time()))

fake = ProviderFake(PORT).start()


def count_exact(path):
    """Requests whose path matches exactly (fake.count() matches by prefix, which would also count
    the issue-detail path under /api/issue/)."""
    return len([r for r in fake.requests() if r["path"] == path])


def last_request(path):
    seen = [r for r in fake.requests() if r["path"] == path]
    return seen[-1] if seen else {}


try:
    if not METRON_BASE:
        check("PROVIDER_METRON_BASE is configured", False, "missing from .env")
        raise SystemExit(finish())
    if METRON_URL.hostname != env.get("DOCKER_GATEWAY"):
        check("metron base points at the Docker gateway", False, METRON_BASE)

    admin = login("ADMIN")
    uploader = login("UPLOADER")

    # --- access control: the admin routes are reviewer-only ---
    check("provider admin list is reviewer-only for uploaders (403)",
          app("GET", "/api/admin/providers", uploader)[0] == 403)
    check("the metron test route is reviewer-only for uploaders (403)",
          app("POST", "/api/admin/providers/metron/test", uploader)[0] == 403)

    # --- registration contract ---
    app("POST", "/api/admin/providers", admin, {"id": "metron", "enabled": False, "key": ""})
    status, body = app("GET", "/api/admin/providers", admin)
    metron = next((p for p in body.get("providers", []) if p["id"] == "metron"), None)
    check("the metron provider is registered", status == 200 and metron is not None, str(body))
    check("metron is labelled Metron and comics-only",
          metron and metron["label"] == "Metron" and metron["media"] == ["comic"], str(metron))
    check("metron carries the CC BY-SA 4.0 licence",
          metron and metron["licence"]["name"] == "CC BY-SA 4.0"
          and metron["licence"]["url"] == "https://creativecommons.org/licenses/by-sa/4.0/", str(metron))
    check("metron never rehosts covers (covers = none)", metron and metron["covers"] == "none", str(metron))
    check("metron is keyed and off by default",
          metron and metron["keyed"] is True and metron["enabled"] is False, str(metron))
    fields = set(metron.get("fields", [])) if metron else set()
    check("metron's field set covers the roles it maps",
          {"Series", "Number", "Volume", "Title", "Summary", "Year", "Writer", "Penciller", "Inker",
           "Colorist", "CoverArtist", "Publisher", "Imprint", "Genre", "Tags", "LanguageISO",
           "AgeRating"} <= fields, str(sorted(fields)))
    check("metron does not claim fields it cannot supply (Letterer)", "Letterer" not in fields, str(sorted(fields)))

    # --- keyed-gating: enabled without a key is not usable ---
    app("POST", "/api/admin/providers", admin, {"id": "metron", "enabled": True})
    status, body = app("POST", "/api/admin/providers/metron/preview", admin, {"query": {"title": "Fixture Saga"}})
    check("metron without a key reports no-key",
          status == 200 and body.get("ok") is False and body.get("reason") == "no-key", str(body))

    # --- key round-trip (sealed by the registry) ---
    status, body = app("POST", "/api/admin/providers", admin, {"id": "metron", "key": KEY})
    check("setting the metron key is accepted", status == 200 and body.get("ok") is True, str(body))
    _, body = app("GET", "/api/admin/providers", admin)
    metron = next(p for p in body["providers"] if p["id"] == "metron")
    check("metron is configured after a key is set", metron["configured"] is True and metron["hasKey"] is True, str(metron))
    check("the key is never echoed in the admin list", KEY not in json.dumps(body), "key leaked")

    # --- fetch -> full field mapping (fresh, so it reaches the fake) ---
    fake.reset()
    status, body = app("POST", "/api/admin/providers/metron/preview", admin, {"externalId": "7001", "refresh": True})
    check("metron fetch succeeds", status == 200 and body.get("ok") is True and body.get("cached") is False, str(body))
    f = body.get("record", {}).get("fields", {})
    check("Series/Number/Volume/Year map from the issue",
          f.get("Series") == "Fixture Saga" and f.get("Number") == "1" and f.get("Volume") == "1"
          and f.get("Year") == "2012", str(f))
    check("Summary maps from issue.desc with HTML stripped",
          f.get("Summary") == "A synthetic summary with markup & entities the client must strip.", str(f.get("Summary")))
    check("Title maps from the issue title with HTML stripped", f.get("Title") == "Chapter One", str(f.get("Title")))
    check("Publisher/Imprint map from the nested resources",
          f.get("Publisher") == "Fixture Press" and f.get("Imprint") == "Fixture Imprint", str(f))
    check("Genre joins series.genres", f.get("Genre") == "Science Fiction, Adventure", str(f.get("Genre")))
    check("Tags joins arcs + characters + teams",
          f.get("Tags") == "Fixture Arc, Fixture Hero, Fixture League", str(f.get("Tags")))
    check("LanguageISO maps from series.language", f.get("LanguageISO") == "en", str(f.get("LanguageISO")))
    check("AgeRating maps from the issue rating", f.get("AgeRating") == "Teen", str(f.get("AgeRating")))
    check("credits -> Writer (a creator with two roles is not duplicated)",
          f.get("Writer") == "A. Writer, C. Colourist", str(f.get("Writer")))
    check("credits -> Penciller/Inker/Colorist/CoverArtist",
          f.get("Penciller") == "P. Artist" and f.get("Inker") == "I. Inker"
          and f.get("Colorist") == "C. Colourist" and f.get("CoverArtist") == "V. Cover", str(f))
    check("a Letterer credit is not mapped", "Letterer" not in f, str(f))
    check("the detail fetch went to /api/issue/<id>/ once", count_exact("/api/issue/7001/") == 1, str(fake.requests()))
    headers = last_request("/api/issue/7001/").get("headers", {})
    check("metron sends the truthful User-Agent",
          headers.get("User-Agent", "").startswith(f"kavita-companion/{VERSION} (+{ORIGIN})"), str(headers))
    check("metron sends its key as a bearer token", headers.get("Authorization") == f"Bearer {KEY}", str(headers))

    # --- record cache: a second fetch is served from cache ---
    status, body = app("POST", "/api/admin/providers/metron/preview", admin, {"externalId": "7001"})
    check("a second fetch within the TTL is served from cache",
          body.get("ok") is True and body.get("cached") is True and count_exact("/api/issue/7001/") == 1, str(body))

    # --- search -> candidates (exact band, sensible ordering) ---
    fake.reset()
    status, body = app("POST", "/api/admin/providers/metron/preview", admin,
                       {"query": {"title": "Fixture Saga", "number": "1", "year": "2012"}})
    candidates = body.get("candidates", [])
    check("search returns candidates", status == 200 and len(candidates) == 3, str(body))
    check("a name + number + year match is banded exact and ranked first",
          candidates and candidates[0]["externalId"] == "7001" and candidates[0]["band"] == "exact"
          and candidates[0]["score"] == 1, str(candidates))
    check("candidates are ordered by score (best first)",
          [c["externalId"] for c in candidates] == ["7001", "7002", "7099"], str(candidates))
    check("a different series is banded loose and ranked last",
          candidates and candidates[-1]["band"] == "loose" and candidates[-1]["externalId"] == "7099", str(candidates))
    check("the candidate shows series/year/publisher/number",
          candidates[0].get("title") == "Fixture Saga" and candidates[0].get("year") == "2012"
          and candidates[0].get("publisher") == "Fixture Press" and candidates[0].get("number") == "1", str(candidates[0]))
    query = parse_qs(last_request("/api/issue/").get("query", ""))
    check("search calls /api/issue/ with series_name/number/series_year_began",
          query.get("series_name") == ["Fixture Saga"] and query.get("number") == ["1"]
          and query.get("series_year_began") == ["2012"], str(query))

    # --- search -> near band (name + number, no year) ---
    fake.reset()
    _, body = app("POST", "/api/admin/providers/metron/preview", admin, {"query": {"title": "Fixture Saga", "number": "2"}})
    candidates = body.get("candidates", [])
    check("a name + number match (no year) is banded near and ranked first",
          candidates and candidates[0]["externalId"] == "7002" and candidates[0]["band"] == "near", str(candidates))

    # --- 429 with Retry-After is retried, then succeeds ---
    fake.reset()
    fake.script("/api/issue/1/", [{"status": 429, "retry_after": 1}, {"fixture": "record", "provider": "metron"}])
    status, body = app("POST", "/api/admin/providers/metron/test", admin)
    check("a 429 is retried after Retry-After and the probe succeeds",
          status == 200 and body.get("ok") is True, str(body))
    check("the 429 caused exactly one retry", count_exact("/api/issue/1/") == 2, str(count_exact("/api/issue/1/")))

    # --- 500 is retried ---
    fake.reset()
    fake.script("/api/issue/", [{"status": 500}, {"fixture": "search", "provider": "metron"}])
    status, body = app("POST", "/api/admin/providers/metron/preview", admin, {"query": {"title": "Fixture Saga"}})
    check("a 500 is retried and the search succeeds", status == 200 and body.get("ok") is True, str(body))
    check("the 500 caused exactly one retry", count_exact("/api/issue/") == 2, str(count_exact("/api/issue/")))

    # --- an HTML (non-JSON) body is refused, never parsed ---
    fake.reset()
    fake.script("/api/issue/", [{"body": "<html><body>not json</body></html>", "content_type": "text/html"}])
    status, body = app("POST", "/api/admin/providers/metron/preview", admin, {"query": {"title": "Fixture Saga"}})
    check("an HTML body is refused as non-JSON",
          status == 200 and body.get("ok") is False and "HTML" in str(body.get("error", "")), str(body))

    # --- leave metron off again ---
    app("POST", "/api/admin/providers", admin, {"id": "metron", "enabled": False, "key": ""})
    _, body = app("GET", "/api/admin/providers", admin)
    metron = next(p for p in body["providers"] if p["id"] == "metron")
    check("disabling metron clears the key again",
          metron["enabled"] is False and metron["hasKey"] is False, str(metron))
finally:
    fake.stop()

raise SystemExit(finish())
