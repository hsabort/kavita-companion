#!/usr/bin/env python3
"""Grand Comics Database (GCD) provider-adapter tests (phase 2, W3).

The GCD adapter is registered into the W1 framework and pointed at the in-process fake
(tests/provider_fake.py) via PROVIDER_GCD_BASE, so these run with no network, no real provider and no
keys. Everything goes through the portal's reviewer-only admin routes.

Covers: the registration contract (label, comic fields, covers "none", keyless), reviewer-only access,
keyless usability once enabled, search -> candidates with sensible band/score ordering (alternate-cover
variants dropped), fetch -> ComicInfo field mapping (free-text `;`-separated credits split into
Writer/Penciller/Inker/Colorist/CoverArtist, "None"/"?" placeholders dropped, plainText HTML stripping,
Year from key_date, Publisher/Imprint from indicia/brand, Genre/Tags aggregated from story_set), the
read-through record cache, an optional `user:pass` key going out as HTTP Basic, and 429 + Retry-After
/ non-JSON refusal. GCD is the comics *fallback*: the registry orders it after Metron.

Run: python3 tests/test_providers_gcd.py
"""
import json
from urllib.parse import urlparse

from harness import app, check, finish, login
from provider_fake import ProviderFake
from settings import ORIGIN, ROOT, env

GCD_BASE = env.get("PROVIDER_GCD_BASE", "")
GCD_URL = urlparse(GCD_BASE)
PORT = GCD_URL.port or 20902
VERSION = json.loads((ROOT / "kavita-companion" / "package.json").read_text())["version"]

fake = ProviderFake(PORT, provider="gcd").start()


def count_exact(path):
    return len([r for r in fake.requests() if r["path"] == path])


def last_request(prefix):
    seen = [r for r in fake.requests() if r["path"].startswith(prefix)]
    return seen[-1] if seen else {}


try:
    if not GCD_BASE:
        check("PROVIDER_GCD_BASE is configured", False, "missing from .env")
        raise SystemExit(finish())
    if GCD_URL.hostname != env.get("DOCKER_GATEWAY"):
        check("gcd base points at the Docker gateway", False, GCD_BASE)

    admin = login("ADMIN")
    uploader = login("UPLOADER")

    # --- access control: the admin routes are reviewer-only ---
    check("provider admin list is reviewer-only for uploaders (403)",
          app("GET", "/api/admin/providers", uploader)[0] == 403)
    check("the gcd test route is reviewer-only for uploaders (403)",
          app("POST", "/api/admin/providers/gcd/test", uploader)[0] == 403)

    # --- registration contract ---
    app("POST", "/api/admin/providers", admin, {"id": "gcd", "enabled": False, "key": ""})
    status, body = app("GET", "/api/admin/providers", admin)
    gcd = next((p for p in body.get("providers", []) if p["id"] == "gcd"), None)
    check("the gcd provider is registered", status == 200 and gcd is not None, str(body))
    check("gcd is labelled 'the Grand Comics Database (GCD)' and comics-only",
          gcd and gcd["label"] == "the Grand Comics Database (GCD)" and gcd["media"] == ["comic"], str(gcd))
    check("gcd carries the CC BY-SA 4.0 licence",
          gcd and gcd["licence"]["name"] == "CC BY-SA 4.0"
          and gcd["licence"]["url"] == "https://creativecommons.org/licenses/by-sa/4.0/", str(gcd))
    check("gcd never rehosts covers (covers = none)", gcd and gcd["covers"] == "none", str(gcd))
    check("gcd is keyless and off by default", gcd and gcd["keyed"] is False and gcd["enabled"] is False, str(gcd))
    fields = set(gcd.get("fields", [])) if gcd else set()
    check("gcd's field set covers the roles it maps",
          {"Series", "Number", "Volume", "Title", "Summary", "Year", "Writer", "Penciller", "Inker",
           "Colorist", "CoverArtist", "Publisher", "Imprint", "Genre", "Tags", "AgeRating"} <= fields, str(sorted(fields)))

    # --- keyless: enabling is enough to use it ---
    app("POST", "/api/admin/providers", admin, {"id": "gcd", "enabled": True})
    _, body = app("GET", "/api/admin/providers", admin)
    gcd = next(p for p in body["providers"] if p["id"] == "gcd")
    check("gcd is usable once enabled (no key needed)", gcd["enabled"] is True and gcd["configured"] is True, str(gcd))

    # --- fetch -> full field mapping (free-text credits, placeholders, HTML) ---
    fake.reset()
    status, body = app("POST", "/api/admin/providers/gcd/preview", admin, {"externalId": "8001", "refresh": True})
    check("gcd fetch succeeds", status == 200 and body.get("ok") is True and body.get("cached") is False, str(body))
    f = body.get("record", {}).get("fields", {})
    check("Series strips the '(2012 series)' disambiguator; Number/Year map",
          f.get("Series") == "Fixture Saga" and f.get("Number") == "1" and f.get("Year") == "2012", str(f))
    check("Title maps from the first interior story with HTML stripped", f.get("Title") == "Chapter One", str(f.get("Title")))
    check("Summary joins the story synopses with HTML stripped",
          f.get("Summary") == "A synthetic summary & more. A backup tale.", str(f.get("Summary")))
    check("Publisher/Imprint map from indicia_publisher/brand_emblem",
          f.get("Publisher") == "Fixture Press" and f.get("Imprint") == "Fixture Imprint", str(f))
    check("Writer splits ';'-separated free text and keeps the backup writer",
          f.get("Writer") == "A. Writer, B. Co-Writer, D. Backup", str(f.get("Writer")))
    check("Penciller/Inker drop the '?'/'None' placeholders",
          f.get("Penciller") == "P. Artist" and f.get("Inker") == "I. Inker", str(f))
    check("Colorist splits roles and drops the '(separations)' qualifier",
          f.get("Colorist") == "C. Colourist, Heroic Age", str(f.get("Colorist")))
    check("CoverArtist comes from the cover story", f.get("CoverArtist") == "V. Cover, C. Colourist", str(f.get("CoverArtist")))
    check("Genre joins the story genres", f.get("Genre") == "superhero, adventure, mystery", str(f.get("Genre")))
    check("Tags join the issue + story keywords", f.get("Tags") == "heroes, time travel", str(f.get("Tags")))
    check("AgeRating maps from the issue rating", f.get("AgeRating") == "Teen", str(f.get("AgeRating")))
    check("the detail fetch went to /api/issue/8001/ once", count_exact("/api/issue/8001/") == 1, str(fake.requests()))
    headers = last_request("/api/issue/8001/").get("headers", {})
    check("gcd sends the truthful User-Agent",
          headers.get("User-Agent", "").startswith(f"kavita-companion/{VERSION} (+{ORIGIN})"), str(headers))

    # --- record cache ---
    status, body = app("POST", "/api/admin/providers/gcd/preview", admin, {"externalId": "8001"})
    check("a second fetch within the TTL is served from cache",
          body.get("ok") is True and body.get("cached") is True and count_exact("/api/issue/8001/") == 1, str(body))

    # --- optional `user:pass` key goes out as HTTP Basic ---
    app("POST", "/api/admin/providers", admin, {"id": "gcd", "key": "reader:secret"})
    _, body = app("POST", "/api/admin/providers/gcd/preview", admin,
                  {"externalId": "8002", "refresh": True})
    headers = last_request("/api/issue/8002/").get("headers", {})
    check("a user:pass key is sent as HTTP Basic",
          headers.get("Authorization", "").startswith("Basic "), str(headers))
    app("POST", "/api/admin/providers", admin, {"id": "gcd", "key": ""})

    # --- search -> candidates (variants dropped, exact ranked first) ---
    fake.reset()
    status, body = app("POST", "/api/admin/providers/gcd/preview", admin,
                       {"query": {"title": "Fixture Saga", "number": "1", "year": "2012"}})
    candidates = body.get("candidates", [])
    check("search returns candidates (the alternate-cover variant is dropped)",
          status == 200 and [c["externalId"] for c in candidates] == ["8001", "8002", "8099"], str(candidates))
    check("a name + number + year match is banded exact and ranked first",
          candidates and candidates[0]["band"] == "exact" and candidates[0]["score"] == 1, str(candidates))
    check("a different series is banded loose and ranked last",
          candidates[-1]["band"] == "loose" and candidates[-1]["externalId"] == "8099", str(candidates[-1]))
    check("the candidate shows series/year/number",
          candidates[0].get("title") == "Fixture Saga" and candidates[0].get("year") == "2012"
          and candidates[0].get("number") == "1", str(candidates[0]))
    path = last_request("/api/series/name/").get("path", "")
    check("search calls the series/name/issue path with the number and year",
          path.startswith("/api/series/name/") and "/issue/1/" in path and "/year/2012/" in path, path)

    # --- search -> near band (name + number, no year) ---
    fake.reset()
    _, body = app("POST", "/api/admin/providers/gcd/preview", admin, {"query": {"title": "Fixture Saga", "number": "2"}})
    candidates = body.get("candidates", [])
    check("a name + number match (no year) is banded near and ranked first",
          candidates and candidates[0]["externalId"] == "8002" and candidates[0]["band"] == "near", str(candidates))

    # --- 429 with Retry-After is retried, then succeeds (a fresh id: the adapter's cache is not bypassed) ---
    fake.reset()
    fake.script("/api/issue/8999/", [{"status": 429, "retry_after": 1}, {"fixture": "record", "provider": "gcd"}])
    status, body = app("POST", "/api/admin/providers/gcd/preview", admin, {"externalId": "8999", "refresh": True})
    check("a 429 is retried after Retry-After and the fetch succeeds",
          status == 200 and body.get("ok") is True, str(body))
    check("the 429 caused exactly one retry", count_exact("/api/issue/8999/") == 2, str(count_exact("/api/issue/8999/")))

    # --- an HTML (non-JSON) body is refused, never parsed (another fresh id) ---
    fake.reset()
    fake.script("/api/issue/8998/", [{"body": "<html><body>not json</body></html>", "content_type": "text/html"}])
    status, body = app("POST", "/api/admin/providers/gcd/preview", admin, {"externalId": "8998", "refresh": True})
    check("an HTML body is refused as non-JSON",
          status == 200 and body.get("ok") is False and "HTML" in str(body.get("error", "")), str(body))

    # --- leave gcd off again ---
    app("POST", "/api/admin/providers", admin, {"id": "gcd", "enabled": False})
    _, body = app("GET", "/api/admin/providers", admin)
    gcd = next(p for p in body["providers"] if p["id"] == "gcd")
    check("gcd is off again at the end", gcd["enabled"] is False, str(gcd))
finally:
    fake.stop()

raise SystemExit(finish())
