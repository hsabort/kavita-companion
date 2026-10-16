#!/usr/bin/env python3
"""POST /api/sidebar/connect recreates the user's "Uploads ↗" entry in their Kavita sidebar on
demand, from an already-signed-in portal session: it uses the Kavita session the portal keeps for
that user, so no password is needed. (A password sign-in already does this at login; this endpoint is
the self-serve way back when the entry, or the auth key behind it, was deleted in Kavita.)

Run: python3 tests/test_sidebar_connect.py
"""
import sys

from harness import app, check, finish, kavita, login
from settings import ORIGIN, env

# Signed out: no portal session, so nothing can be done as anyone.
status, _ = app("POST", "/api/sidebar/connect")
check("signed-out connect is refused", status == 401, str(status))

# Read Only accounts can't get Kavita keys (and can't upload): refused.
readonly = login("readonly")
status, _ = app("POST", "/api/sidebar/connect", cookie=readonly)
check("Read Only accounts are refused", status == 403, str(status))

# A signed-in uploader: the portal holds their own Kavita session, so it can act as them.
uploader = login("uploader")
_, user = kavita("POST", "/api/Account/login",
                 {"username": env["TEST_UPLOADER_USERNAME"], "password": env["TEST_UPLOADER_PASSWORD"]})

# Give the endpoint something to do: remove the existing entry first, as the user.
_, sources = kavita("GET", "/api/Stream/external-sources", token=user["token"])
removed = 0
for source in sources or []:
    if source.get("host") == ORIGIN + "/":
        kavita("DELETE", f"/api/Stream/delete-external-source?externalSourceId={source['id']}", token=user["token"])
        removed += 1
check("the test uploader had the sidebar entry to remove", removed >= 1, str(removed))

status, body = app("POST", "/api/sidebar/connect", cookie=uploader)
check("the connect endpoint succeeds", status == 200, f"{status} {body}")
check("it reports what it did", body.get("result") in {"added", "repaired", "shown", "renamed", "present"},
      str(body.get("result")))

# Afterwards the user's own Kavita sidebar has the external entry named "Uploads ↗".
_, streams = kavita("GET", "/api/Stream/sidenav?visibleOnly=false", token=user["token"])
external = [s for s in (streams or []) if s.get("streamType") == 6]
check("the sidebar has the Uploads entry again", len(external) >= 1, str(len(external)))
check("the entry is named 'Uploads ↗' so its tooltip marks the new tab",
      any(s.get("name") == "Uploads ↗" for s in external),
      str([s.get("name") for s in external]))

sys.exit(finish())
