#!/usr/bin/env python3
"""Theme sync: the portal follows each user's Kavita theme (built-in Dark or any installed theme).

Temporarily installs Dracula and Light from Kavita's theme catalogue (if they aren't installed) and
changes test-uploader's theme preference; restores both at the end, so Kavita's theme list and the
account end up as they were.

Run: python3 tests/test_themes.py
"""
import http.cookiejar
import json
import sys
import time
import urllib.error
import urllib.request

from settings import KAVITA_LOCAL as KAVITA, ORIGIN, env

results = []


def check(name, ok, detail=""):
    results.append(bool(ok))
    print(f"{'PASS' if ok else 'FAIL'}  {name}" + (f"  ({detail})" if detail and not ok else ""), flush=True)


def kavita(method, path, body=None, token=None):
    headers = {"Content-Type": "application/json"}
    if token:
        headers["Authorization"] = f"Bearer {token}"
    else:
        headers["x-api-key"] = env["COMPANION_KAVITA_AUTH_KEY"]
    req = urllib.request.Request(KAVITA + path, json.dumps(body).encode() if body is not None else None, headers, method=method)
    try:
        with urllib.request.urlopen(req, timeout=60) as r:
            raw = r.read()
            return r.status, (json.loads(raw) if raw[:1] in (b"{", b"[") else raw.decode())
    except urllib.error.HTTPError as e:
        return e.code, e.read().decode()[:200]


def portal_session():
    """A browser-like client with its own cookie jar."""
    jar = http.cookiejar.CookieJar()
    opener = urllib.request.build_opener(urllib.request.HTTPCookieProcessor(jar))
    def call(method, path, body=None):
        headers = {"Origin": ORIGIN}
        data = None
        if body is not None:
            headers["Content-Type"] = "application/json"
            data = json.dumps(body).encode()
        with opener.open(urllib.request.Request(ORIGIN + path, data, headers, method=method), timeout=60) as r:
            return r.status, r.geturl(), json.loads(r.read() or b"{}") if "json" in r.headers.get("Content-Type", "") else None
    return call


def portal_theme_after_password_login():
    call = portal_session()
    call("POST", "/api/login", {"username": env["TEST_UPLOADER_USERNAME"], "password": env["TEST_UPLOADER_PASSWORD"]})
    return call("GET", "/api/me")[2]["theme"]


# --- user token and current preferences ---
status, user = kavita("POST", "/api/Account/login", {"username": env["TEST_UPLOADER_USERNAME"], "password": env["TEST_UPLOADER_PASSWORD"]})
token = user["token"]
_, prefs = kavita("GET", "/api/Users/get-preferences", token=token)
original_theme = prefs["theme"]


def set_theme(theme):
    status, body = kavita("POST", "/api/Users/update-preferences", {**prefs, "theme": theme}, token=token)
    assert status == 200, f"update-preferences: {status} {body}"


# --- signed-out visitors get the server's default theme ---
_, _, me = portal_session()("GET", "/api/me")
check("signed out: server default theme (Dark) with no overrides",
      me["theme"]["name"] == "Dark" and me["theme"]["tokens"] == {} and me["theme"]["scheme"] == "dark", str(me["theme"]))

# --- install catalogue themes for the test ---
_, installed = kavita("GET", "/api/Theme")
_, catalogue = kavita("GET", "/api/Theme/browse")
added = []
for name in ("Dracula", "Light"):
    if not any(t["name"] == name for t in installed):
        entry = next(t for t in catalogue if t["name"] == name)
        status, body = kavita("POST", "/api/Theme/download-theme", entry)
        assert status == 200, f"install {name}: {status} {body}"
        added.append(name)
_, installed = kavita("GET", "/api/Theme")
themes = {t["name"]: t for t in installed}
check("Dracula and Light installed in Kavita", "Dracula" in themes and "Light" in themes, str(list(themes)))

try:
    # --- password sign-in picks up the user's theme ---
    set_theme(themes["Dracula"])
    theme = portal_theme_after_password_login()
    check("Dracula user: portal uses Dracula's colours",
          theme["name"] == "Dracula" and theme["tokens"].get("--bg", "").lower() == "#282a36"
          and theme["tokens"].get("--primary", "").lower() == "#50fa7b" and theme["scheme"] == "dark", str(theme))

    set_theme(themes["Light"])
    theme = portal_theme_after_password_login()
    check("Light user: portal switches to a light scheme with Light's colours",
          # Kavita renders Light at #f8f9fa: its "bg-light" body class is also a Bootstrap utility.
          theme["name"] == "Light" and theme["scheme"] == "light" and theme["tokens"].get("--bg") == "#f8f9fa"
          and theme["tokens"].get("--text") == "black", str(theme))

    # --- opening Uploads from Kavita's sidebar picks up a changed theme ---
    set_theme(themes["Dracula"])
    _, sources = kavita("GET", "/api/Stream/external-sources", token=token)
    link = next((s for s in sources if s["host"].rstrip("/") == ORIGIN), None)
    if link:
        call = portal_session()
        status, final_url, _ = call("GET", f"/login?apiKey={link['apiKey']}")
        _, _, me = call("GET", "/api/me")
        check("sidebar link sign-in: portal follows the theme chosen since the last visit",
              me["user"] and me["theme"]["name"] == "Dracula", str(me))
    else:
        check("sidebar link sign-in (test-uploader has no Uploads link yet)", True)

    # --- live: an open portal session follows theme changes made in Kavita, without signing in again ---
    live = portal_session()
    live("POST", "/api/login", {"username": env["TEST_UPLOADER_USERNAME"], "password": env["TEST_UPLOADER_PASSWORD"]})
    for name in ("Light", "Dracula"):
        set_theme(themes[name])
        seen = None
        for _ in range(10):
            time.sleep(1.5)
            seen = live("GET", "/api/theme")[2]["theme"]["name"]
            if seen == name:
                break
        check(f"open session follows a change to {name} in Kavita (no new sign-in)", seen == name, str(seen))

    import sqlite3
    from settings import COMPANION_DB
    con = sqlite3.connect(f"file:{COMPANION_DB}?mode=ro", uri=True)
    stored = [r[0] for r in con.execute("SELECT kavita_token FROM sessions WHERE username = ? AND kavita_token IS NOT NULL",
                                        (env["TEST_UPLOADER_USERNAME"],))]
    check("the stored Kavita session is encrypted (not a readable token)",
          stored and not any(t.startswith("eyJ") for t in stored), f"{len(stored)} stored")

    # --- back to Kavita's built-in Dark ---
    set_theme(themes["Dark"])
    theme = portal_theme_after_password_login()
    check("Dark user: portal uses its built-in Dark defaults", theme["name"] == "Dark" and theme["tokens"] == {}, str(theme))
finally:
    set_theme(original_theme)
    for name in added:
        kavita("DELETE", f"/api/Theme?themeId={themes[name]['id']}")
    _, after = kavita("GET", "/api/Theme")
    check("Kavita's theme list and test-uploader's theme restored",
          sorted(t["name"] for t in after) == sorted(t["name"] for t in installed if t["name"] not in added)
          and kavita("GET", "/api/Users/get-preferences", token=token)[1]["theme"]["id"] == original_theme["id"], str([t["name"] for t in after]))

print(f"\n{sum(results)}/{len(results)} passed")
sys.exit(0 if all(results) else 1)
