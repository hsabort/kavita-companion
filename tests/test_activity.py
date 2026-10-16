#!/usr/bin/env python3
"""Admin activity tests: the reviewers' Activity panel reads recent audit-log entries and a few
counts, and is closed to everyone else.

Run: python3 tests/test_activity.py
"""
import secrets
import sys

from harness import app, check, finish, login
from settings import env

admin, uploader, readonly = login("ADMIN"), login("UPLOADER"), login("READONLY")

# --- permissions ---
check("uploader cannot read activity (403)", app("GET", "/api/admin/activity", uploader)[0] == 403)
check("read-only user cannot read activity (403)", app("GET", "/api/admin/activity", readonly)[0] == 403)
check("a signed-out request is refused (401)", app("GET", "/api/admin/activity")[0] == 401)
check("uploader cannot read insights (403)", app("GET", "/api/admin/insights", uploader)[0] == 403)

# --- reading the log ---
status, body = app("GET", "/api/admin/activity", admin)
entries = body.get("entries", [])
check("admin sees activity", status == 200 and isinstance(entries, list) and len(entries) > 0, f"{status} {str(body)[:120]}")
check("entries have the expected shape", all({"id", "at", "username", "action"} <= set(e) for e in entries), str(entries[:1]))
check("activity is newest first", all(entries[i]["id"] > entries[i + 1]["id"] for i in range(len(entries) - 1)), str(entries[:3]))

# A uniquely named failed sign-in, then find it by filtering.
tag = secrets.token_hex(4)
check("a failed sign-in is refused (401)", app("POST", "/api/login", body={"username": f"definitely-not-a-user-{tag}", "password": "x"})[0] == 401)

status, body = app("GET", "/api/admin/activity?action=login_failed&limit=5", admin)
check("filter by action returns only that action",
      status == 200 and body["entries"] and all(e["action"] == "login_failed" for e in body["entries"]), str(body)[:160])

uploader_name = env["TEST_UPLOADER_USERNAME"]
status, body = app("GET", f"/api/admin/activity?username={uploader_name}&limit=50", admin)
check("filter by username returns only that user",
      status == 200 and all((e["username"] or "") == uploader_name for e in body["entries"]), str(body)[:160])

admin_name = env["TEST_ADMIN_USERNAME"]
status, body = app("GET", f"/api/admin/activity?action=login&username={admin_name}&limit=10", admin)
check("the admin's own sign-in is in the log",
      status == 200 and any(e["username"] == admin_name for e in body["entries"]), str(body)[:160])

# --- paging ---
_, page1 = app("GET", "/api/admin/activity?limit=2", admin)
_, page2 = app("GET", f"/api/admin/activity?limit=2&before={page1['nextBefore']}", admin)
check("paging returns older entries with no overlap",
      bool(page1["entries"]) and bool(page2["entries"]) and page1["entries"][-1]["id"] > page2["entries"][0]["id"],
      f"{page1.get('nextBefore')} {page2.get('nextBefore')}")

# --- insights ---
status, insights = app("GET", "/api/admin/insights", admin)
check("insights has the expected shape",
      status == 200 and {"pending", "byStatus", "last7Days", "topUploaders"} <= set(insights)
      and {"count", "bytes"} <= set(insights["pending"])
      and {"uploaded", "approved", "rejected", "fixed"} <= set(insights["last7Days"]),
      f"{status} {str(insights)[:160]}")
check("insights counts uploads in the last 7 days", insights["last7Days"]["uploaded"] > 0, str(insights["last7Days"]))

sys.exit(finish())
