#!/usr/bin/env python3
"""M1 acceptance tests for the upload companion, run against the real public HTTPS address.

Uses the TEST_* accounts from ../.env. Failed-login and rate-limit checks use made-up
usernames so no real Kavita account gets locked out.

Run: python3 tests/test_auth.py
"""
import json
import pathlib
import secrets
import sys
import urllib.error
import urllib.request

from settings import ORIGIN, env


results = []


def check(name, ok, detail=""):
    results.append(ok)
    print(f"{'PASS' if ok else 'FAIL'}  {name}" + (f"  ({detail})" if detail and not ok else ""))


def call(method, path, body=None, cookie=None, origin=ORIGIN):
    headers = {"Content-Type": "application/json"}
    if origin:
        headers["Origin"] = origin
    if cookie:
        headers["Cookie"] = cookie
    data = json.dumps(body).encode() if body is not None else None
    req = urllib.request.Request(ORIGIN + path, data, headers, method=method)
    try:
        with urllib.request.urlopen(req, timeout=20) as r:
            return r.status, r.headers, parse(r.read())
    except urllib.error.HTTPError as e:
        return e.code, e.headers, parse(e.read())


def parse(raw):
    try:
        return json.loads(raw or b"{}")
    except ValueError:
        return {"raw": raw.decode(errors="replace")[:200]}


def login(user_key):
    return call("POST", "/api/login", {
        "username": env[f"TEST_{user_key}_USERNAME"],
        "password": env[f"TEST_{user_key}_PASSWORD"],
    })


def session_cookie(headers):
    for value in headers.get_all("Set-Cookie") or []:
        if value.startswith("__Host-kc_session="):
            return value
    return None


# 1. Health and security headers
status, headers, body = call("GET", "/api/health")
check("health endpoint reports Kavita reachable", status == 200 and body.get("kavita") == "reachable", f"{status} {body}")
check("security headers present",
      "default-src 'self'" in (headers.get("Content-Security-Policy") or "")
      and headers.get("X-Content-Type-Options") == "nosniff"
      and "max-age" in (headers.get("Strict-Transport-Security") or ""))
status, _, _ = call("GET", "/")
check("login page served", status == 200)

# 2. Wrong credentials (non-existent user, so no real account is affected)
status, _, body = call("POST", "/api/login", {"username": "no-such-user-" + secrets.token_hex(4), "password": "wrong"})
check("wrong credentials rejected with 401", status == 401, f"{status} {body}")

# 3. Uploader
status, headers, body = login("UPLOADER")
raw_cookie = session_cookie(headers)
check("test-uploader logs in", status == 200, f"{status} {body}")
check("test-uploader can upload, is not a reviewer",
      body.get("user", {}).get("canUpload") is True and body.get("user", {}).get("isReviewer") is False, str(body))
check("session cookie is HttpOnly, Secure, SameSite=Strict",
      bool(raw_cookie) and all(f in raw_cookie.lower() for f in ("httponly", "secure", "samesite=strict")), str(raw_cookie))
cookie = raw_cookie.split(";", 1)[0] if raw_cookie else None
status, _, body = call("GET", "/api/me", cookie=cookie)
check("/api/me returns the signed-in user", status == 200 and body.get("user", {}).get("username") == env["TEST_UPLOADER_USERNAME"], f"{status} {body}")

# 4. CSRF: state-changing request without our Origin is refused
status, _, _ = call("POST", "/api/logout", {}, cookie=cookie, origin=None)
check("POST without Origin refused (403)", status == 403)
status, _, _ = call("POST", "/api/logout", {}, cookie=cookie, origin="https://evil.example")
check("POST from a foreign Origin refused (403)", status == 403)
status, _, _ = call("GET", "/api/me", cookie=cookie)
check("session still valid after refused CSRF attempts", status == 200)

# 5. Logout ends the session
status, _, _ = call("POST", "/api/logout", {}, cookie=cookie)
check("logout succeeds", status == 200)
status, _, body = call("GET", "/api/me", cookie=cookie)
check("old session cookie no longer signed in after logout", status == 200 and body.get("user") is None, f"{status} {body}")
status, _, _ = call("GET", "/api/uploads", cookie=cookie)
check("old session cookie rejected by protected endpoints (401)", status == 401)

# 6. Read-only and admin accounts
status, _, body = login("READONLY")
check("test-readonly logs in but cannot upload",
      status == 200 and body.get("user", {}).get("canUpload") is False, f"{status} {body}")
status, _, body = login("ADMIN")
check("test-admin logs in as reviewer",
      status == 200 and body.get("user", {}).get("isReviewer") is True and body.get("user", {}).get("canUpload") is True,
      f"{status} {body}")

# 7. Rate limit: 10 attempts per 15 min per (IP, username); the 11th is refused.
probe = "rl-probe-" + secrets.token_hex(4)
codes = [call("POST", "/api/login", {"username": probe, "password": "wrong"})[0] for _ in range(11)]
check("11th failed login for one username is rate-limited (429)", codes[:10] == [401] * 10 and codes[10] == 429, str(codes))
status, _, _ = login("UPLOADER")
check("rate limit on one username does not block other users", status == 200, str(status))

print(f"\n{sum(results)}/{len(results)} passed")
sys.exit(0 if all(results) else 1)
