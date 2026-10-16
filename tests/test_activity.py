#!/usr/bin/env python3
"""Admin activity tests: the reviewers' Activity panel reads recent audit-log entries and a few
counts, and is closed to everyone else.

Run: python3 tests/test_activity.py
"""
import json
import secrets
import sys
import urllib.error
import urllib.request

from settings import ORIGIN, env

results = []


def check(name, ok, detail=""):
    results.append(ok)
    print(f"{'PASS' if ok else 'FAIL'}  {name}" + (f"  ({detail})" if detail and not ok else ""))


def call(method, path, body=None, cookie=None):
    headers = {"Content-Type": "application/json", "Origin": ORIGIN}
    if cookie:
        headers["Cookie"] = cookie
    data = json.dumps(body).encode() if body is not None else None
    request = urllib.request.Request(ORIGIN + path, data, headers, method=method)
    try:
        with urllib.request.urlopen(request, timeout=30) as response:
            return response.status, response.headers, json.loads(response.read() or b"{}")
    except urllib.error.HTTPError as error:
        try:
            parsed = json.loads(error.read() or b"{}")
        except ValueError:
            parsed = {}
        return error.code, error.headers, parsed


def login(key):
    _, headers, _ = call("POST", "/api/login",
                         {"username": env[f"TEST_{key}_USERNAME"], "password": env[f"TEST_{key}_PASSWORD"]})
    for value in headers.get_all("Set-Cookie") or []:
        if value.startswith("__Host-kc_session="):
            return value.split(";", 1)[0]
    raise SystemExit(f"no session cookie for {key}")


admin = login("ADMIN")
uploader = login("UPLOADER")
readonly = login("READONLY")

# --- permissions ---
status, _, _ = call("GET", "/api/admin/activity", cookie=uploader)
check("uploader cannot read activity (403)", status == 403, str(status))
status, _, _ = call("GET", "/api/admin/activity", cookie=readonly)
check("read-only user cannot read activity (403)", status == 403, str(status))
status, _, _ = call("GET", "/api/admin/activity")
check("a signed-out request is refused (401)", status == 401, str(status))
status, _, _ = call("GET", "/api/admin/insights", cookie=uploader)
check("uploader cannot read insights (403)", status == 403, str(status))

# --- reading the log ---
status, _, body = call("GET", "/api/admin/activity", cookie=admin)
entries = body.get("entries", [])
check("admin sees activity", status == 200 and isinstance(entries, list) and len(entries) > 0, f"{status} {str(body)[:120]}")
check("entries have the expected shape", all({"id", "at", "username", "action"} <= set(e) for e in entries), str(entries[:1]))
check("activity is newest first", all(entries[i]["id"] > entries[i + 1]["id"] for i in range(len(entries) - 1)), str(entries[:3]))

# A uniquely named failed sign-in, then find it by filtering.
tag = secrets.token_hex(4)
status, _, _ = call("POST", "/api/login", {"username": f"definitely-not-a-user-{tag}", "password": "x"})
check("a failed sign-in is refused (401)", status == 401, str(status))

status, _, body = call("GET", "/api/admin/activity?action=login_failed&limit=5", cookie=admin)
check("filter by action returns only that action",
      status == 200 and body["entries"] and all(e["action"] == "login_failed" for e in body["entries"]),
      str(body)[:160])

status, _, body = call("GET", f"/api/admin/activity?username={env['TEST_UPLOADER_USERNAME']}&limit=50", cookie=admin)
check("filter by username returns only that user",
      status == 200 and all((e["username"] or "") == env["TEST_UPLOADER_USERNAME"] for e in body["entries"]),
      str(body)[:160])

status, _, body = call("GET", f"/api/admin/activity?action=login&username={env['TEST_ADMIN_USERNAME']}&limit=10", cookie=admin)
check("the admin's own sign-in is in the log",
      status == 200 and any(e["username"] == env["TEST_ADMIN_USERNAME"] for e in body["entries"]), str(body)[:160])

# --- paging ---
_, _, page1 = call("GET", "/api/admin/activity?limit=2", cookie=admin)
_, _, page2 = call("GET", f"/api/admin/activity?limit=2&before={page1['nextBefore']}", cookie=admin)
check("paging returns older entries with no overlap",
      bool(page1["entries"]) and bool(page2["entries"]) and page1["entries"][-1]["id"] > page2["entries"][0]["id"],
      f"{page1.get('nextBefore')} {page2.get('nextBefore')}")

# --- insights ---
status, _, insights = call("GET", "/api/admin/insights", cookie=admin)
check("insights has the expected shape",
      status == 200 and {"pending", "byStatus", "last7Days", "topUploaders"} <= set(insights)
      and {"count", "bytes"} <= set(insights["pending"])
      and {"uploaded", "approved", "rejected", "fixed"} <= set(insights["last7Days"]),
      f"{status} {str(insights)[:160]}")
check("insights counts uploads in the last 7 days",
      insights["last7Days"]["uploaded"] > 0, str(insights["last7Days"]))

print()
print(f"{sum(results)}/{len(results)} passed")
sys.exit(0 if all(results) else 1)
