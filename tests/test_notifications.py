#!/usr/bin/env python3
"""Notification tests: a user points their uploads at a webhook and the portal delivers events to it.

Runs a small HTTP receiver on the host; the portal (in the test stack, where NOTIFY_ALLOW_PRIVATE=true)
reaches it through the Docker gateway. Events are read-only for the library: this uses the test send,
a discarded (invalid) file and a rejected file, none of which write to Kavita.

Run: python3 tests/test_notifications.py
"""
import http.server
import io
import json
import os
import secrets
import sys
import threading
import time
import zipfile

from harness import app, check, finish, login, upload, wait_pending
from settings import env, library_ids

GATEWAY = env.get("DOCKER_GATEWAY", "172.31.0.1")
PORT = 21080
EVENTS = ["approved", "rejected", "fixed", "invalid", "duplicate", "request"]
received = []
tag = secrets.token_hex(3)
COMICS = library_ids()["Comics"]


class Receiver(http.server.BaseHTTPRequestHandler):
    def do_POST(self):
        received.append(self.rfile.read(int(self.headers.get("Content-Length", 0))).decode(errors="replace"))
        self.send_response(200)
        self.end_headers()
        self.wfile.write(b"ok")

    def log_message(self, *args):
        pass


def delivered(event, within=20):
    deadline = time.time() + within
    while time.time() < deadline:
        for body in received:
            try:
                if json.loads(body).get("event") == event:
                    return True
            except ValueError:
                pass
        time.sleep(0.4)
    return False


def small_cbz():
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w", zipfile.ZIP_STORED) as archive:
        archive.writestr("001.jpg", b"\xff\xd8\xff\xe0" + os.urandom(20_000))
    return buf.getvalue()


server = http.server.HTTPServer(("0.0.0.0", PORT), Receiver)
threading.Thread(target=server.serve_forever, daemon=True).start()
target = f"http://{GATEWAY}:{PORT}/hook"

admin, uploader, readonly = login("ADMIN"), login("UPLOADER"), login("READONLY")

# --- preferences (prefs persist, so start from a clean slate before checking the default) ---
app("POST", "/api/notifications", uploader, {"channel": "off"})
status, body = app("GET", "/api/notifications", uploader)
check("notifications default to off",
      status == 200 and body.get("channel") == "off" and set(body.get("events", [])) == set(EVENTS), str(body))

check("read-only accounts cannot set notifications (403)",
      app("POST", "/api/notifications", readonly, {"channel": "webhook", "target": target, "events": ["rejected"]})[0] == 403)
check("a non-http(s) target is refused (400)",
      app("POST", "/api/notifications", uploader, {"channel": "webhook", "target": "ftp://example.com/x", "events": ["rejected"]})[0] == 400)

status, body = app("POST", "/api/notifications", uploader, {"channel": "webhook", "target": target, "events": ["invalid", "rejected"]})
check("saving a webhook is accepted", status == 200 and body.get("target") == target, str(body))

status, body = app("GET", "/api/notifications", uploader)
check("preferences are saved (channel, target, events)",
      status == 200 and body.get("channel") == "webhook" and body.get("target") == target
      and set(body.get("events", [])) == {"invalid", "rejected"}, str(body))

check("the test notification is accepted", app("POST", "/api/notifications/test", uploader)[0] == 200)
check("the test notification reaches the webhook", delivered("test"), str(received[-1:]))

# --- an invalid file is discarded and notifies ---
received.clear()
upload(uploader, f"Notify Invalid {tag}.cbz", os.urandom(4096), COMICS)
check("an invalid file notifies the uploader (invalid)", delivered("invalid"), str(received[:1]))

# --- a rejected file notifies ---
received.clear()
upload_id = upload(uploader, f"Notify Reject {tag} v01.cbz", small_cbz(), COMICS)
wait_pending(admin, upload_id)
check("the file can be rejected", app("POST", f"/api/review/{upload_id}/reject", admin, {"reason": "Notification test"})[0] == 200)
check("a rejection notifies the uploader (rejected)", delivered("rejected"), str(received[:1]))

# --- an event the user didn't ask for is not sent ---
app("POST", "/api/notifications", uploader, {"channel": "webhook", "target": target, "events": ["approved"]})
received.clear()
upload(uploader, f"Notify Quiet {tag}.cbz", os.urandom(4096), COMICS)
time.sleep(4)
check("an event the user did not select is not delivered", not delivered("invalid", within=1), str(received[:1]))

app("POST", "/api/notifications", uploader, {"channel": "off"})   # leave the account clean
server.shutdown()
sys.exit(finish())
