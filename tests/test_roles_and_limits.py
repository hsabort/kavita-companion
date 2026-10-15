#!/usr/bin/env python3
"""M4 acceptance tests: role changes in Kavita reach existing sessions, and the general rate limit.

Temporarily changes test-uploader's roles in Kavita (adds Read Only, then removes Login) and
always restores the original roles at the end. Takes ~5 minutes (roles are re-read every 2 min).

Run: python3 tests/test_roles_and_limits.py
"""
import json
import pathlib
import sys
import time
import urllib.error
import urllib.request

from settings import COMPANION_DB, KAVITA_LOCAL as KAVITA, ORIGIN, env

results = []

# This test changes test-uploader's roles, which would interrupt anyone actually using the portal
# (including a person testing with the test accounts). Refuse if there's recent real activity.
if "--force" not in sys.argv:
    import sqlite3
    db_path = COMPANION_DB
    con = sqlite3.connect(f"file:{db_path}?mode=ro", uri=True)
    now_ms = time.time() * 1000
    people = con.execute("""SELECT DISTINCT username FROM audit_log WHERE action = 'login' AND at > ?
        AND username NOT LIKE 'test-%'""", (now_ms - 3_600_000,)).fetchall()
    real_uploads = con.execute("""SELECT filename FROM uploads WHERE created_at > ?
        AND owner_name NOT LIKE 'test-%'
        AND filename NOT LIKE '%Test%'
        AND filename NOT LIKE 'Slow %' AND filename NOT LIKE 'Fake %' AND filename NOT LIKE 'Big Series %'
        AND filename NOT LIKE 'Mislabelled %' AND filename NOT LIKE 'Kc %' AND filename NOT LIKE 'Not A Book %'
        AND filename NOT LIKE 'Browser %' AND filename NOT LIKE 'Kavita Test Book%'""", (now_ms - 1_800_000,)).fetchall()
    if people or real_uploads:
        sys.exit(f"Refusing to run: recent real activity (logins: {[p[0] for p in people]}, "
                 f"uploads: {[u[0] for u in real_uploads][:5]}). Changing test-uploader's roles would interrupt it. "
                 "Re-run with --force when nobody is using the portal.")


def check(name, ok, detail=""):
    results.append(bool(ok))
    print(f"{'PASS' if ok else 'FAIL'}  {name}" + (f"  ({detail})" if detail and not ok else ""), flush=True)


def request(method, url, body=None, headers=None):
    req = urllib.request.Request(url, body, headers or {}, method=method)
    try:
        with urllib.request.urlopen(req, timeout=30) as r:
            return r.status, r.headers, r.read()
    except urllib.error.HTTPError as e:
        return e.code, e.headers, e.read()


def kavita(method, path, body=None):
    status, _, out = request(method, KAVITA + path, json.dumps(body).encode() if body is not None else None,
                             {"x-api-key": env["COMPANION_KAVITA_AUTH_KEY"], "Content-Type": "application/json"})
    assert 200 <= status < 300, f"Kavita {method} {path}: {status} {out[:200]}"
    return json.loads(out) if out else None


def set_roles(user, roles):
    kavita("POST", "/api/Account/update", {
        "userId": user["id"], "username": user["username"], "roles": roles,
        "libraries": [lib["id"] for lib in user.get("libraries") or []],
        "ageRestriction": user.get("ageRestriction") or {"ageRating": -1, "includeUnknowns": True},
        "email": user.get("email"), "identityProvider": user.get("identityProvider", 0),
    })


def me(cookie):
    status, _, out = request("GET", ORIGIN + "/api/me", None, {"Cookie": cookie})
    return status, json.loads(out or b"{}").get("user")


def wait_for(cookie, predicate, timeout=200):
    deadline = time.time() + timeout
    while time.time() < deadline:
        status, user = me(cookie)
        if predicate(user):
            return True, round(timeout - (deadline - time.time()))
        time.sleep(5)
    return False, timeout


body = json.dumps({"username": env["TEST_UPLOADER_USERNAME"], "password": env["TEST_UPLOADER_PASSWORD"]}).encode()
status, headers, _ = request("POST", ORIGIN + "/api/login", body, {"Content-Type": "application/json", "Origin": ORIGIN})
cookie = next(v for v in headers.get_all("Set-Cookie") if v.startswith("__Host-")).split(";", 1)[0]
check("test-uploader signed in and can upload", me(cookie)[1] and me(cookie)[1]["canUpload"] is True)

user = next(u for u in kavita("GET", "/api/Users") if u["username"] == env["TEST_UPLOADER_USERNAME"])
original_roles = [r for r in user["roles"] if r != "Pleb"]
try:
    set_roles(user, original_roles + ["Read Only"])
    ok, secs = wait_for(cookie, lambda u: u is not None and u["canUpload"] is False)
    check(f"made Read Only in Kavita -> upload access removed from the live session ({secs}s)", ok)
    meta = "filename eC5jYno=,libraryId Mg=="  # x.cbz, library 2
    status, _, _ = request("POST", ORIGIN + "/files", None, {"Origin": ORIGIN, "Cookie": cookie, "Tus-Resumable": "1.0.0",
                                                            "Upload-Length": "100", "Upload-Metadata": meta})
    check("and a new upload is refused (403)", status == 403, str(status))

    set_roles(user, [r for r in original_roles if r != "Login"] + ["Read Only"])
    ok, secs = wait_for(cookie, lambda u: u is None)
    check(f"Login role removed in Kavita -> session ended ({secs}s)", ok)
    status, _, _ = request("GET", ORIGIN + "/api/uploads", None, {"Cookie": cookie})
    check("old session cookie now refused (401)", status == 401, str(status))
finally:
    set_roles(user, original_roles)
    restored = next(u for u in kavita("GET", "/api/Users") if u["id"] == user["id"])
    check("test-uploader's original roles restored",
          sorted(r for r in restored["roles"] if r != "Pleb") == sorted(original_roles), str(restored["roles"]))

# General rate limit: 600 requests a minute per signed-in session.
status, headers, _ = request("POST", ORIGIN + "/api/login", body, {"Content-Type": "application/json", "Origin": ORIGIN})
cookie = next(v for v in headers.get_all("Set-Cookie") if v.startswith("__Host-")).split(";", 1)[0]
codes = [me(cookie)[0] for _ in range(601)]
check("601st request in a minute from one session is rate-limited (429)",
      codes[:600].count(200) == 600 and codes[600] == 429, f"{codes.count(200)} ok, last={codes[-1]}")

print(f"\n{sum(results)}/{len(results)} passed")
sys.exit(0 if all(results) else 1)
