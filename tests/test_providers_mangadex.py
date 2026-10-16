#!/usr/bin/env python3
"""MangaDex provider-adapter tests (phase 2, W4).

The MangaDex adapter is registered into the W1 framework and pointed at the in-process fake
(tests/provider_fake.py) via PROVIDER_MANGADEX_BASE, so these run with no network, no real provider and
no keys. Everything goes through the portal's reviewer-only admin routes.

Covers: the registration contract (label, manga-only, covers "none", keyless), reviewer-only access,
keyless usability once enabled, search -> candidates with sensible band/score ordering, fetch ->
ComicInfo field mapping (prefer `en`, plainText + credit-preamble stripping, genre-vs-theme/form tag
split, author -> Writer / artist -> Penciller, contentRating -> AgeRating, originalLanguage ->
LanguageISO, and **no** Number/Volume from the series-level lastChapter/lastVolume), the read-through
record cache, and 429 + Retry-After / non-JSON refusal. MangaDex is the manga *primary*: the registry
orders it before AniList.

Run: python3 tests/test_providers_mangadex.py
"""
import json
from urllib.parse import parse_qs, urlparse

from harness import app, check, finish, login
from provider_fake import ProviderFake
from settings import ORIGIN, ROOT, env

MANGADEX_BASE = env.get("PROVIDER_MANGADEX_BASE", "")
MANGADEX_URL = urlparse(MANGADEX_BASE)
PORT = MANGADEX_URL.port or 20903
VERSION = json.loads((ROOT / "kavita-companion" / "package.json").read_text())["version"]

fake = ProviderFake(PORT, provider="mangadex").start()


def count_exact(path):
    return len([r for r in fake.requests() if r["path"] == path])


def last_request(prefix):
    seen = [r for r in fake.requests() if r["path"].startswith(prefix)]
    return seen[-1] if seen else {}


try:
    if not MANGADEX_BASE:
        check("PROVIDER_MANGADEX_BASE is configured", False, "missing from .env")
        raise SystemExit(finish())
    if MANGADEX_URL.hostname != env.get("DOCKER_GATEWAY"):
        check("mangadex base points at the Docker gateway", False, MANGADEX_BASE)

    admin = login("ADMIN")
    uploader = login("UPLOADER")

    # --- access control: the admin routes are reviewer-only ---
    check("provider admin list is reviewer-only for uploaders (403)",
          app("GET", "/api/admin/providers", uploader)[0] == 403)
    check("the mangadex test route is reviewer-only for uploaders (403)",
          app("POST", "/api/admin/providers/mangadex/test", uploader)[0] == 403)

    # --- registration contract ---
    app("POST", "/api/admin/providers", admin, {"id": "mangadex", "enabled": False, "key": ""})
    status, body = app("GET", "/api/admin/providers", admin)
    md = next((p for p in body.get("providers", []) if p["id"] == "mangadex"), None)
    check("the mangadex provider is registered", status == 200 and md is not None, str(body))
    check("mangadex is labelled MangaDex and manga-only",
          md and md["label"] == "MangaDex" and md["media"] == ["manga"], str(md))
    check("mangadex carries the MangaDex credit licence",
          md and md["licence"]["name"] == "Acceptable Usage Policy (credit required)"
          and md["licence"]["url"] == "https://api.mangadex.org/docs/", str(md))
    check("mangadex never hotlinks covers (covers = none)", md and md["covers"] == "none", str(md))
    check("mangadex is keyless and off by default",
          md and md["keyed"] is False and md["enabled"] is False, str(md))
    fields = set(md.get("fields", [])) if md else set()
    check("mangadex's field set covers what it maps",
          {"Series", "Summary", "Year", "Writer", "Penciller", "Genre", "Tags", "LanguageISO",
           "AgeRating"} <= fields, str(sorted(fields)))
    check("mangadex does not claim Number/Volume (it is series-level)",
          "Number" not in fields and "Volume" not in fields, str(sorted(fields)))

    # --- keyless: enabling is enough to use it ---
    app("POST", "/api/admin/providers", admin, {"id": "mangadex", "enabled": True})
    _, body = app("GET", "/api/admin/providers", admin)
    md = next(p for p in body["providers"] if p["id"] == "mangadex")
    check("mangadex is usable once enabled (no key needed)", md["enabled"] is True and md["configured"] is True, str(md))

    # --- fetch -> full field mapping (localized maps, tag split, roles, credit preamble) ---
    fake.reset()
    status, body = app("POST", "/api/admin/providers/mangadex/preview", admin, {"externalId": "m-9001", "refresh": True})
    check("mangadex fetch succeeds", status == 200 and body.get("ok") is True and body.get("cached") is False, str(body))
    f = body.get("record", {}).get("fields", {})
    check("Series/Year map from the localized title + year",
          f.get("Series") == "Fixture Manga" and f.get("Year") == "2018", str(f))
    check("Summary prefers en, strips HTML and the credit/support preamble",
          f.get("Summary") == "A synthetic summary & more.", str(f.get("Summary")))
    check("Writer maps from the author relationships (in order)",
          f.get("Writer") == "A. Author, B. Co-Author", str(f.get("Writer")))
    check("Penciller maps from the artist relationship", f.get("Penciller") == "P. Artist", str(f.get("Penciller")))
    check("Genre takes the tags whose group is 'genre'", f.get("Genre") == "Action, Adventure", str(f.get("Genre")))
    check("Tags takes the other tag groups (theme/format)", f.get("Tags") == "Music, Oneshot", str(f.get("Tags")))
    check("LanguageISO maps from originalLanguage", f.get("LanguageISO") == "ja", str(f.get("LanguageISO")))
    check("AgeRating maps from contentRating (suggestive -> Teen)", f.get("AgeRating") == "Teen", str(f.get("AgeRating")))
    check("lastChapter/lastVolume are not mapped as Number/Volume",
          "Number" not in f and "Volume" not in f, str(f))
    check("the detail fetch went to /manga/m-9001 once", count_exact("/manga/m-9001") == 1, str(fake.requests()))
    headers = last_request("/manga/m-9001").get("headers", {})
    check("mangadex sends the truthful User-Agent",
          headers.get("User-Agent", "").startswith(f"kavita-companion/{VERSION} (+{ORIGIN})"), str(headers))

    # --- record cache ---
    status, body = app("POST", "/api/admin/providers/mangadex/preview", admin, {"externalId": "m-9001"})
    check("a second fetch within the TTL is served from cache",
          body.get("ok") is True and body.get("cached") is True and count_exact("/manga/m-9001") == 1, str(body))

    # --- search -> candidates (exact ranked first, alternate near, different series loose) ---
    fake.reset()
    status, body = app("POST", "/api/admin/providers/mangadex/preview", admin,
                       {"query": {"title": "Fixture Manga", "year": "2018"}})
    candidates = body.get("candidates", [])
    check("search returns candidates", status == 200 and len(candidates) == 3, str(body))
    check("a name + year match is banded exact and ranked first",
          candidates and candidates[0]["externalId"] == "m-9001" and candidates[0]["band"] == "exact"
          and candidates[0]["score"] == 1, str(candidates))
    check("candidates are ordered by score (best first)",
          [c["externalId"] for c in candidates] == ["m-9001", "m-9002", "m-9099"], str(candidates))
    check("a same-name different-year candidate is near, a different series is loose",
          candidates[1]["band"] == "near" and candidates[2]["band"] == "loose"
          and candidates[2]["externalId"] == "m-9099", str(candidates))
    check("the candidate shows series/year and no issue number",
          candidates[0].get("title") == "Fixture Manga" and candidates[0].get("year") == "2018"
          and "number" not in candidates[0], str(candidates[0]))
    query = parse_qs(last_request("/manga").get("query", ""))
    check("search calls /manga with title and relevance ordering",
          query.get("title") == ["Fixture Manga"] and query.get("order[relevance]") == ["desc"], str(query))

    # --- 429 with Retry-After is retried, then succeeds (a fresh id) ---
    fake.reset()
    fake.script("/manga/m-8999", [{"status": 429, "retry_after": 1}, {"fixture": "record", "provider": "mangadex"}])
    status, body = app("POST", "/api/admin/providers/mangadex/preview", admin, {"externalId": "m-8999", "refresh": True})
    check("a 429 is retried after Retry-After and the fetch succeeds",
          status == 200 and body.get("ok") is True, str(body))
    check("the 429 caused exactly one retry", count_exact("/manga/m-8999") == 2, str(count_exact("/manga/m-8999")))

    # --- an HTML (non-JSON) body is refused, never parsed (another fresh id) ---
    fake.reset()
    fake.script("/manga/m-8998", [{"body": "<html><body>not json</body></html>", "content_type": "text/html"}])
    status, body = app("POST", "/api/admin/providers/mangadex/preview", admin, {"externalId": "m-8998", "refresh": True})
    check("an HTML body is refused as non-JSON",
          status == 200 and body.get("ok") is False and "HTML" in str(body.get("error", "")), str(body))

    # --- leave mangadex off again ---
    app("POST", "/api/admin/providers", admin, {"id": "mangadex", "enabled": False})
    _, body = app("GET", "/api/admin/providers", admin)
    md = next(p for p in body["providers"] if p["id"] == "mangadex")
    check("mangadex is off again at the end", md["enabled"] is False, str(md))
finally:
    fake.stop()

raise SystemExit(finish())
