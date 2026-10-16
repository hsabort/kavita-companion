#!/usr/bin/env python3
"""AniList provider-adapter tests (phase 2, W5).

The AniList adapter is registered into the W1 framework and pointed at the in-process fake
(tests/provider_fake.py) via PROVIDER_ANILIST_BASE, so these run with no network, no real provider and
no keys. Everything goes through the portal's reviewer-only admin routes.

Covers: the registration contract (label, manga-only, covers "none", keyless), reviewer-only access,
keyless usability once enabled, the GraphQL POST body (search vs by-id), search -> a candidate with a
sensible band/score, fetch -> ComicInfo field mapping (english||romaji title, plainText summary,
startDate.year, staff roles -> Writer/Penciller with cross-role de-duplication, genres, tags, countryOfOrigin
-> LanguageISO, isAdult -> AgeRating in two coarse buckets, and **no** Number/Volume from chapters/volumes),
the read-through record cache, and 429 + Retry-After / non-JSON refusal. AniList is the manga *fallback*:
the registry orders it after MangaDex.

Run: python3 tests/test_providers_anilist.py
"""
import json
from urllib.parse import urlparse

from harness import app, check, finish, login
from provider_fake import ProviderFake
from settings import ORIGIN, ROOT, env

ANILIST_BASE = env.get("PROVIDER_ANILIST_BASE", "")
ANILIST_URL = urlparse(ANILIST_BASE)
PORT = ANILIST_URL.port or 20904
VERSION = json.loads((ROOT / "kavita-companion" / "package.json").read_text())["version"]

fake = ProviderFake(PORT, provider="anilist").start()


def count_exact(path):
    return len([r for r in fake.requests() if r["path"] == path])


def last_request():
    seen = fake.requests()
    return seen[-1] if seen else {}


try:
    if not ANILIST_BASE:
        check("PROVIDER_ANILIST_BASE is configured", False, "missing from .env")
        raise SystemExit(finish())
    if ANILIST_URL.hostname != env.get("DOCKER_GATEWAY"):
        check("anilist base points at the Docker gateway", False, ANILIST_BASE)

    admin = login("ADMIN")
    uploader = login("UPLOADER")

    # --- access control: the admin routes are reviewer-only ---
    check("provider admin list is reviewer-only for uploaders (403)",
          app("GET", "/api/admin/providers", uploader)[0] == 403)
    check("the anilist test route is reviewer-only for uploaders (403)",
          app("POST", "/api/admin/providers/anilist/test", uploader)[0] == 403)

    # --- registration contract ---
    app("POST", "/api/admin/providers", admin, {"id": "anilist", "enabled": False, "key": ""})
    status, body = app("GET", "/api/admin/providers", admin)
    al = next((p for p in body.get("providers", []) if p["id"] == "anilist"), None)
    check("the anilist provider is registered", status == 200 and al is not None, str(body))
    check("anilist is labelled AniList and manga-only",
          al and al["label"] == "AniList" and al["media"] == ["manga"], str(al))
    check("anilist carries the AniList licence",
          al and al["licence"]["name"] == "AniList" and al["licence"]["url"] == "https://docs.anilist.co/", str(al))
    check("anilist never fetches covers (covers = none)", al and al["covers"] == "none", str(al))
    check("anilist is keyless and off by default",
          al and al["keyed"] is False and al["enabled"] is False, str(al))
    fields = set(al.get("fields", [])) if al else set()
    check("anilist's field set covers what it maps",
          {"Series", "Summary", "Year", "Writer", "Penciller", "Genre", "Tags", "LanguageISO",
           "AgeRating"} <= fields, str(sorted(fields)))
    check("anilist does not claim Number/Volume (chapters/volumes are series-level)",
          "Number" not in fields and "Volume" not in fields, str(sorted(fields)))

    # --- keyless: enabling is enough to use it ---
    app("POST", "/api/admin/providers", admin, {"id": "anilist", "enabled": True})
    _, body = app("GET", "/api/admin/providers", admin)
    al = next(p for p in body["providers"] if p["id"] == "anilist")
    check("anilist is usable once enabled (no key needed)", al["enabled"] is True and al["configured"] is True, str(al))

    # --- fetch -> full field mapping (staff roles, dedupe, isAdult) ---
    fake.reset()
    status, body = app("POST", "/api/admin/providers/anilist/preview", admin, {"externalId": "9001", "refresh": True})
    check("anilist fetch succeeds", status == 200 and body.get("ok") is True and body.get("cached") is False, str(body))
    f = body.get("record", {}).get("fields", {})
    check("Series prefers the english title; Year from startDate.year",
          f.get("Series") == "Fixture Manga" and f.get("Year") == "2018", str(f))
    check("Summary maps from description(asHtml:false) with plainText",
          f.get("Summary") == "A synthetic summary & more.", str(f.get("Summary")))
    check("Writer maps from staff roles matching story/writer (deduped)",
          f.get("Writer") == "A. Story, C. Both, O. Origin", str(f.get("Writer")))
    check("Penciller maps from staff roles matching art/illustration/pencil (deduped, cross-role)",
          f.get("Penciller") == "P. Artist, C. Both, I. Illustration", str(f.get("Penciller")))
    check("Genre maps from genres", f.get("Genre") == "Action, Adventure", str(f.get("Genre")))
    check("Tags maps from the ranked tags (names, deduped)", f.get("Tags") == "Music, School Life", str(f.get("Tags")))
    check("LanguageISO maps from countryOfOrigin (JP -> ja)", f.get("LanguageISO") == "ja", str(f.get("LanguageISO")))
    check("AgeRating maps isAdult=true to Mature 17+", f.get("AgeRating") == "Mature 17+", str(f.get("AgeRating")))
    check("chapters/volumes are not mapped as Number/Volume", "Number" not in f and "Volume" not in f, str(f))
    check("the fetch is a single GraphQL POST to /", count_exact("/") == 1, str(fake.requests()))
    request = last_request()
    check("the by-id fetch POSTs a GraphQL id query",
          request.get("method") == "POST" and '"id":9001' in request.get("body", "")
          and "Media(" in request.get("body", ""), request.get("body", ""))
    check("anilist sends the truthful User-Agent and JSON content-type",
          request.get("headers", {}).get("User-Agent", "").startswith(f"kavita-companion/{VERSION} (+{ORIGIN})")
          and request.get("headers", {}).get("Content-Type") == "application/json", str(request.get("headers")))
    check("the record is tagged as manga", body.get("record", {}).get("media") == "manga", str(body.get("record")))

    # --- isAdult=false maps to the other coarse bucket ---
    fake.reset()
    status, body = app("POST", "/api/admin/providers/anilist/preview", admin, {"externalId": "9002", "refresh": True})
    f = body.get("record", {}).get("fields", {})
    check("a non-adult media maps isAdult=false to Everyone",
          status == 200 and f.get("AgeRating") == "Everyone" and f.get("Series") == "Fixturesoft Manga", str(f))
    check("countryOfOrigin KR maps to LanguageISO ko", f.get("LanguageISO") == "ko", str(f))

    # --- record cache ---
    status, body = app("POST", "/api/admin/providers/anilist/preview", admin, {"externalId": "9001"})
    check("a second fetch within the TTL is served from cache",
          body.get("ok") is True and body.get("cached") is True and count_exact("/") == 1, str(body))

    # --- search -> one candidate (exact when the year agrees) ---
    fake.reset()
    status, body = app("POST", "/api/admin/providers/anilist/preview", admin,
                       {"query": {"title": "Fixture Manga", "year": "2018"}})
    candidates = body.get("candidates", [])
    check("search returns the single Media candidate",
          status == 200 and len(candidates) == 1 and candidates[0]["externalId"] == "9001", str(candidates))
    check("a name + year match is banded exact and scored 1",
          candidates and candidates[0]["band"] == "exact" and candidates[0]["score"] == 1
          and candidates[0].get("title") == "Fixture Manga" and candidates[0].get("year") == "2018", str(candidates))
    check("the search POSTs a GraphQL search query",
          last_request().get("method") == "POST" and '"search":"Fixture Manga"' in last_request().get("body", ""), last_request().get("body", ""))

    # --- search -> near when the year differs ---
    fake.reset()
    _, body = app("POST", "/api/admin/providers/anilist/preview", admin,
                  {"query": {"title": "Fixture Manga", "year": "2019"}})
    candidates = body.get("candidates", [])
    check("a name match with a different year is banded near",
          candidates and candidates[0]["band"] == "near", str(candidates))

    # --- 429 with Retry-After is retried, then succeeds (a fresh id: the adapter's cache is not bypassed) ---
    fake.reset()
    fake.script("/", [{"status": 429, "retry_after": 1}, {"fixture": "record", "provider": "anilist"}])
    status, body = app("POST", "/api/admin/providers/anilist/preview", admin, {"externalId": "8999", "refresh": True})
    check("a 429 is retried after Retry-After and the fetch succeeds",
          status == 200 and body.get("ok") is True, str(body))
    check("the 429 caused exactly one retry", count_exact("/") == 2, str(count_exact("/")))

    # --- an HTML (non-JSON) body is refused, never parsed (another fresh id) ---
    fake.reset()
    fake.script("/", [{"body": "<html><body>not json</body></html>", "content_type": "text/html"}])
    status, body = app("POST", "/api/admin/providers/anilist/preview", admin, {"externalId": "8998", "refresh": True})
    check("an HTML body is refused as non-JSON",
          status == 200 and body.get("ok") is False and "HTML" in str(body.get("error", "")), str(body))

    # --- leave anilist off again ---
    app("POST", "/api/admin/providers", admin, {"id": "anilist", "enabled": False})
    _, body = app("GET", "/api/admin/providers", admin)
    al = next(p for p in body["providers"] if p["id"] == "anilist")
    check("anilist is off again at the end", al["enabled"] is False, str(al))
finally:
    fake.stop()

raise SystemExit(finish())
