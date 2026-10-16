#!/usr/bin/env python3
"""Provider-adapter framework tests (phase 2, W1).

Exercises the framework through the portal's real HTTP surface, with the built-in stub provider
pointed at the in-process fake (tests/provider_fake.py). No network, no real provider, no keys.

Covers: registry enable/disable + keyed-gating, the shared HTTP client (retry on 429/500, truthful
User-Agent, response size cap), sealed key round-trip + redaction (API and at-rest), cache get/put +
TTL, and merge precedence / no-overwrite / validation.

Run: python3 tests/test_providers_framework.py
"""
import json
import pathlib
import sqlite3
import time
from urllib.parse import urlparse

from harness import app, check, finish, login, request
from provider_fake import ProviderFake
from settings import COMPANION_DB, ORIGIN, ROOT, env

STUB_BASE = env.get("PROVIDER_STUB_BASE", "")
STUB_URL = urlparse(STUB_BASE)
PORT = STUB_URL.port or 20900
VERSION = json.loads((ROOT / "kavita-companion" / "package.json").read_text())["version"]
KEY = "test-key-" + str(int(time.time()))

fake = ProviderFake(PORT).start()


def json_has_key(payload, needle):
    """True if the plaintext key appears anywhere in a JSON-serialisable response."""
    return needle in json.dumps(payload)


def at_rest_contains(needle):
    """True if the plaintext key appears in the on-disk database (main file or WAL)."""
    for suffix in ("", "-wal", "-shm"):
        path = pathlib.Path(str(COMPANION_DB) + suffix)
        if path.exists() and needle.encode() in path.read_bytes():
            return True
    return False


try:
    if not STUB_BASE:
        check("PROVIDER_STUB_BASE is configured", False, "missing from .env")
        raise SystemExit(finish())
    if STUB_URL.hostname != env.get("DOCKER_GATEWAY"):
        check("stub base points at the Docker gateway", False, STUB_BASE)

    admin, uploader, readonly = login("ADMIN"), login("UPLOADER"), login("READONLY")
    fake.reset()

    # --- access control ---
    check("provider admin list requires sign-in (401)", app("GET", "/api/admin/providers")[0] == 401)
    check("provider admin list is reviewer-only for uploaders (403)",
          app("GET", "/api/admin/providers", uploader)[0] == 403)
    check("provider admin list is reviewer-only for read-only (403)",
          app("GET", "/api/admin/providers", readonly)[0] == 403)
    status, _, _ = request("POST", ORIGIN + "/api/admin/providers", b'{"id":"stub","enabled":true}',
                           {"Content-Type": "application/json", "Cookie": admin})
    check("provider admin route refuses a missing Origin (CSRF 403)", status == 403)

    # --- registry: stub is registered, off and unconfigured by default ---
    app("POST", "/api/admin/providers", admin, {"id": "stub", "enabled": False, "key": ""})
    status, body = app("GET", "/api/admin/providers", admin)
    stub = next((p for p in body.get("providers", []) if p["id"] == "stub"), None)
    check("the stub provider is registered", status == 200 and stub is not None, str(body))
    check("the stub starts disabled", stub is not None and stub["enabled"] is False, str(stub))
    check("the stub is keyed and starts unconfigured",
          stub is not None and stub["keyed"] is True and stub["configured"] is False and stub["hasKey"] is False, str(stub))

    # --- keyed-gating: enabled without a key is not usable ---
    app("POST", "/api/admin/providers", admin, {"id": "stub", "enabled": True})
    _, body = app("GET", "/api/admin/providers", admin)
    stub = next(p for p in body["providers"] if p["id"] == "stub")
    check("enabling without a key leaves it unconfigured",
          stub["enabled"] is True and stub["configured"] is False, str(stub))
    status, body = app("POST", "/api/admin/providers/stub/preview", admin, {"query": {"title": "Fixture Saga"}})
    check("a keyed provider without a key reports no-key",
          status == 200 and body.get("ok") is False and body.get("reason") == "no-key", str(body))

    # --- key round-trip + redaction ---
    status, body = app("POST", "/api/admin/providers", admin, {"id": "stub", "key": KEY})
    check("setting a key is accepted", status == 200 and body.get("ok") is True, str(body))
    _, body = app("GET", "/api/admin/providers", admin)
    stub = next(p for p in body["providers"] if p["id"] == "stub")
    check("after setting a key the provider is configured", stub["hasKey"] is True and stub["configured"] is True, str(stub))
    check("the admin list never echoes the key", not json_has_key(body, KEY), "key leaked in list")
    sealed = sqlite3.connect(str(COMPANION_DB)).execute(
        "SELECT key_sealed FROM provider_config WHERE provider = 'stub'").fetchone()
    check("the key is stored sealed (not plaintext in the DB)", sealed and sealed[0] and KEY not in sealed[0],
          str(sealed))
    check("the plaintext key is absent from the database files", not at_rest_contains(KEY), "key found at rest")

    # --- HTTP client: search + record + truthful User-Agent + auth header ---
    fake.reset()
    status, body = app("POST", "/api/admin/providers/stub/preview", admin, {"query": {"title": "Fixture Saga", "number": "1"}})
    check("a configured provider search succeeds", status == 200 and body.get("ok") is True, str(body))
    check("the top candidate is the highest-scoring one",
          body.get("candidates") and body["candidates"][0]["externalId"] == "fx-saga-1", str(body.get("candidates")))
    check("the fetched record is mapped to our fields",
          body.get("record", {}).get("fields", {}).get("Writer") == "A. Writer", str(body.get("record")))
    check("the key is never echoed in the preview response", not json_has_key(body, KEY), "key leaked in preview")
    headers = fake.last_headers("/stub/search")
    check("the truthful User-Agent is sent",
          headers.get("User-Agent", "").startswith(f"kavita-companion/{VERSION} (+{ORIGIN})"), str(headers))
    check("the provider key is sent as a bearer token", headers.get("Authorization") == f"Bearer {KEY}", str(headers))

    # --- HTML is stripped from provider text (hook) ---
    check("HTML in provider text is stripped",
          "<b>" not in body.get("merged", {}).get("fields", {}).get("Summary", "") and "markup" in body["merged"]["fields"]["Summary"],
          str(body.get("merged")))

    # --- retry on 429 (honours Retry-After) ---
    fake.reset()
    fake.script("/stub/probe", [{"status": 429, "retry_after": 1}, {"json": {"ok": True}}])
    status, body = app("POST", "/api/admin/providers/stub/test", admin)
    check("a 429 is retried after Retry-After and succeeds", status == 200 and body.get("ok") is True, str(body))
    check("the 429 caused exactly one retry", fake.count("/stub/probe") == 2, str(fake.count("/stub/probe")))

    # --- retry on 500 ---
    fake.reset()
    fake.script("/stub/probe", [{"status": 500}, {"json": {"ok": True}}])
    status, body = app("POST", "/api/admin/providers/stub/test", admin)
    check("a 500 is retried and succeeds", status == 200 and body.get("ok") is True, str(body))
    check("the 500 caused exactly one retry", fake.count("/stub/probe") == 2, str(fake.count("/stub/probe")))

    # --- response size cap ---
    fake.reset()
    fake.script("/stub/probe", [{"raw_bytes": 3_000_000}])
    status, body = app("POST", "/api/admin/providers/stub/test", admin)
    check("an oversized response is refused by the size cap",
          status == 200 and body.get("ok") is False and "exceed" in str(body.get("error", "")).lower(), str(body))

    # --- cache get/put + TTL ---
    fake.reset()
    # `refresh` bypasses any record cached by earlier steps, so the first call reaches the provider.
    status, body = app("POST", "/api/admin/providers/stub/preview", admin, {"externalId": "fx-saga-1", "refresh": True})
    check("a fetch by external id succeeds", status == 200 and body.get("ok") is True and body.get("cached") is False, str(body))
    check("the first fetch hits the provider once", fake.count("/stub/record/") == 1, str(fake.count("/stub/record/")))
    status, body = app("POST", "/api/admin/providers/stub/preview", admin, {"externalId": "fx-saga-1"})
    check("a second fetch within the TTL is served from cache",
          body.get("ok") is True and body.get("cached") is True and fake.count("/stub/record/") == 1, str(body))
    time.sleep(2.0)  # PROVIDER_CACHE_TTL_MS=1500 in the test .env
    status, body = app("POST", "/api/admin/providers/stub/preview", admin, {"externalId": "fx-saga-1"})
    check("after the TTL expires the provider is called again",
          body.get("ok") is True and body.get("cached") is False and fake.count("/stub/record/") == 2, str(body))

    # --- merge precedence / no-overwrite / validation (no network) ---
    merge = {
        "records": [
            {"provider": "a", "fields": {"Series": "Series A", "Writer": "W-a"}},
            {"provider": "b", "fields": {"Writer": "W-b", "Publisher": "P-b"}},
        ],
        "current": {"Series": "Mine"},
    }
    status, body = app("POST", "/api/admin/providers/stub/preview", admin, merge)
    merged = body.get("merged", {})
    check("higher-precedence record wins per field", merged.get("fields", {}).get("Writer") == "W-a", str(merged))
    check("provenance records the winning provider", merged.get("provenance", {}).get("Writer") == "a", str(merged))
    check("a lower-precedence record fills the gaps", merged.get("fields", {}).get("Publisher") == "P-b", str(merged))
    check("a non-empty current value is never overwritten silently", "Series" not in merged.get("fields", {}), str(merged))
    check("the refused overwrite is reported as a conflict",
          any(c["field"] == "Series" and c["proposed"] == "Series A" and c["current"] == "Mine" for c in merged.get("conflicts", [])),
          str(merged.get("conflicts")))

    _, body = app("POST", "/api/admin/providers/stub/preview", admin, {**merge, "force": ["Series"]})
    check("force allows an explicit overwrite", body.get("merged", {}).get("fields", {}).get("Series") == "Series A", str(body.get("merged")))

    _, body = app("POST", "/api/admin/providers/stub/preview", admin, {**merge, "locked": ["Writer"]})
    check("a locked field is never proposed", "Writer" not in body.get("merged", {}).get("fields", {}), str(body.get("merged")))

    _, body = app("POST", "/api/admin/providers/stub/preview", admin,
                  {"records": [{"provider": "a", "fields": {"Year": "not-a-year", "Number": "01"}}]})
    check("an invalid Year is dropped, a valid value kept",
          "Year" not in body["merged"]["fields"] and body["merged"]["fields"].get("Number") == "01", str(body.get("merged")))

    # --- disable clears the provider again ---
    app("POST", "/api/admin/providers", admin, {"id": "stub", "enabled": False, "key": ""})
    _, body = app("GET", "/api/admin/providers", admin)
    stub = next(p for p in body["providers"] if p["id"] == "stub")
    check("disabling clears the key and the configured state",
          stub["enabled"] is False and stub["hasKey"] is False, str(stub))
finally:
    fake.stop()

raise SystemExit(finish())
