#!/usr/bin/env python3
"""The Kavita sidebar entry is named "Uploads ↗" — Kavita ties the label and its hover tooltip to one
string and adds no icon, so the arrow is how the entry marks itself as opening in a new tab. A portal
password sign-in creates/repairs the entry.

Run: python3 tests/test_sidebar_label.py
"""
import json
import sys
import urllib.error
import urllib.request

from settings import KAVITA_LOCAL as KAVITA, ORIGIN, env

results = []


def check(name, ok, detail=""):
    results.append(bool(ok))
    print(f"{'PASS' if ok else 'FAIL'}  {name}" + (f"  ({detail})" if detail and not ok else ""))


def request(method, url, body=None, headers=None):
    req = urllib.request.Request(url, body, headers or {}, method=method)
    try:
        with urllib.request.urlopen(req, timeout=30) as r:
            return r.status, r.read()
    except urllib.error.HTTPError as e:
        return e.code, e.read()


# A portal password sign-in runs the sidebar-link code (create it, repair its key, set its name).
status, _ = request("POST", ORIGIN + "/api/login",
                    json.dumps({"username": env["TEST_UPLOADER_USERNAME"], "password": env["TEST_UPLOADER_PASSWORD"]}).encode(),
                    {"Content-Type": "application/json", "Origin": ORIGIN})
check("portal sign-in succeeds", status == 200, str(status))

# Ask Kavita for this user's own sidebar (their own token).
status, out = request("POST", KAVITA + "/api/Account/login",
                      json.dumps({"username": env["TEST_UPLOADER_USERNAME"], "password": env["TEST_UPLOADER_PASSWORD"]}).encode(),
                      {"Content-Type": "application/json"})
token = json.loads(out)["token"]
status, out = request("GET", KAVITA + "/api/Stream/sidenav?visibleOnly=false", None, {"Authorization": "Bearer " + token})
external = [s for s in json.loads(out) if s.get("streamType") == 6]
check("the sidebar has the Uploads entry", len(external) >= 1, str(len(external)))
check("the entry is named 'Uploads ↗' so its tooltip marks the new tab",
      bool(external) and external[0].get("name") == "Uploads ↗",
      str(external[0].get("name") if external else None))

print()
print(f"{sum(results)}/{len(results)} passed")
sys.exit(0 if all(results) else 1)
