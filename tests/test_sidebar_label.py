#!/usr/bin/env python3
"""The Kavita sidebar entry is named "Uploads ↗" — Kavita ties the label and its hover tooltip to one
string and adds no icon, so the arrow is how the entry marks itself as opening in a new tab. A portal
password sign-in creates/repairs the entry.

Run: python3 tests/test_sidebar_label.py
"""
import sys

from harness import app, check, finish, kavita
from settings import env

# A portal password sign-in runs the sidebar-link code (create it, repair its key, set its name).
status, _ = app("POST", "/api/login",
                body={"username": env["TEST_UPLOADER_USERNAME"], "password": env["TEST_UPLOADER_PASSWORD"]})
check("portal sign-in succeeds", status == 200, str(status))

# Ask Kavita for this user's own sidebar (their own token).
_, user = kavita("POST", "/api/Account/login",
                 {"username": env["TEST_UPLOADER_USERNAME"], "password": env["TEST_UPLOADER_PASSWORD"]})
_, streams = kavita("GET", "/api/Stream/sidenav?visibleOnly=false", token=user["token"])
external = [s for s in (streams or []) if s.get("streamType") == 6]
check("the sidebar has the Uploads entry", len(external) >= 1, str(len(external)))
check("the entry is named 'Uploads ↗' so its tooltip marks the new tab",
      bool(external) and external[0].get("name") == "Uploads ↗",
      str(external[0].get("name") if external else None))

sys.exit(finish())
