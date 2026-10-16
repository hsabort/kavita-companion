#!/usr/bin/env python3
"""Notification tests: a user points their uploads at a webhook and the portal delivers events to it.

Runs a small HTTP receiver on the host; the portal (in the test stack, where NOTIFY_ALLOW_PRIVATE=true)
reaches it through the Docker gateway. Events are read-only for the library: this uses the test send,
a discarded (invalid) file and a rejected file, none of which write to Kavita.

Run: python3 tests/test_notifications.py
"""
import base64
import http.server
import io
import json
import os
import secrets
import sys
import threading
import time
import urllib.error
import urllib.request
import zipfile

from settings import ORIGIN, env, library_ids

GATEWAY = env.get("DOCKER_GATEWAY", "172.31.0.1")
PORT = 21080
EVENTS = ["approved", "rejected", "fixed", "invalid", "duplicate", "request"]

received = []
results = []
tag = secrets.token_hex(3)
COMICS = library_ids()["Comics"]


class Receiver(http.server.BaseHTTPRequestHandler):
    def do_POST(self):
        length = int(self.headers.get("Content-Length", 0))
        body = self.rfile.read(length).decode(errors="replace")
        received.append(body)
        self.send_response(200)
        self.end_headers()
        self.wfile.write(b"ok")

    def log_message(self, *args):
        pass


def check(name, ok, detail=""):
    results.append(bool(ok))
    print(f"{'PASS' if ok else 'FAIL'}  {name}" + (f"  ({detail})" if detail and not ok else ""))


def request(method, url, body=None, headers=None):
    req = urllib.request.Request(url, body, headers or {}, method=method)
    try:
        with urllib.request.urlopen(req, timeout=60) as r:
            return r.status, r.headers, r.read()
    except urllib.error.HTTPError as e:
        return e.code, e.headers, e.read()


def app(method, path, cookie=None, body=None):
    headers = {"Origin": ORIGIN}
    if cookie:
        headers["Cookie"] = cookie
    data = json.dumps(body).encode() if body is not None else None
    if data is not None:
        headers["Content-Type"] = "application/json"
    status, _, out = request(method, ORIGIN + path, data, headers)
    try:
        return status, json.loads(out or b"{}")
    except ValueError:
        return status, {"raw": out[:200]}


def login(key):
    status, headers, _ = request("POST", ORIGIN + "/api/login",
                                 json.dumps({"username": env[f"TEST_{key}_USERNAME"], "password": env[f"TEST_{key}_PASSWORD"]}).encode(),
                                 {"Content-Type": "application/json", "Origin": ORIGIN})
    assert status == 200, f"login {key}: {status}"
    return next(v for v in headers.get_all("Set-Cookie") if v.startswith("__Host-")).split(";", 1)[0]


def upload(cookie, filename, data):
    b64 = lambda s: base64.b64encode(str(s).encode()).decode()
    status, headers, out = request(
        "POST", ORIGIN + "/files", None,
        {"Origin": ORIGIN, "Cookie": cookie, "Tus-Resumable": "1.0.0", "Upload-Length": str(len(data)),
         "Upload-Metadata": f"filename {b64(filename)},libraryId {b64(COMICS)}"})
    assert status in (200, 201), f"tus create {status} {out[:120]}"
    location = headers["Location"]
    url = location if location.startswith("http") else ORIGIN + location
    upload_id = location.rsplit("/", 1)[1]
    status, _, out = request("PATCH", url, data,
                             {"Origin": ORIGIN, "Cookie": cookie, "Tus-Resumable": "1.0.0",
                              "Upload-Offset": "0", "Content-Type": "application/offset+octet-stream"})
    assert status in (200, 204), f"tus patch {status} {out[:120]}"
    return upload_id


def small_cbz():
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w", zipfile.ZIP_STORED) as z:
        z.writestr("001.jpg", b"\xff\xd8\xff\xe0" + os.urandom(20_000))
    return buf.getvalue()


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


server = http.server.HTTPServer(("0.0.0.0", PORT), Receiver)
threading.Thread(target=server.serve_forever, daemon=True).start()
target = f"http://{GATEWAY}:{PORT}/hook"

admin = login("ADMIN")
uploader = login("UPLOADER")
readonly = login("READONLY")

# --- preferences ---
status, body = app("GET", "/api/notifications", uploader)
check("a new user starts with notifications off",
      status == 200 and body.get("channel") == "off" and set(body.get("events", [])) == set(EVENTS), str(body))

status, _ = app("POST", "/api/notifications", readonly, {"channel": "webhook", "target": target, "events": ["rejected"]})
check("read-only accounts cannot set notifications (403)", status == 403, str(status))

status, _ = app("POST", "/api/notifications", uploader, {"channel": "webhook", "target": "ftp://example.com/x", "events": ["rejected"]})
check("a non-http(s) target is refused (400)", status == 400, str(status))

status, body = app("POST", "/api/notifications", uploader, {"channel": "webhook", "target": target, "events": ["invalid", "rejected"]})
check("saving a webhook is accepted", status == 200 and body.get("target") == target, str(body))

status, body = app("GET", "/api/notifications", uploader)
check("preferences are saved (channel, target, events)",
      status == 200 and body.get("channel") == "webhook" and body.get("target") == target
      and set(body.get("events", [])) == {"invalid", "rejected"}, str(body))

status, _ = app("POST", "/api/notifications/test", uploader)
check("the test notification is accepted", status == 200, str(status))
check("the test notification reaches the webhook", delivered("test"), str(received[-1:]))

# --- an invalid file is discarded and notifies ---
received.clear()
upload(uploader, f"Notify Invalid {tag}.cbz", os.urandom(4096))
check("an invalid file notifies the uploader (invalid)", delivered("invalid"), str(received[:1]))

# --- a rejected file notifies ---
received.clear()
upload_id = upload(uploader, f"Notify Reject {tag} v01.cbz", small_cbz())
for _ in range(60):
    _, queue = app("GET", "/api/review", admin)
    if any(item["id"] == upload_id and item.get("defaults") for item in queue.get("pending", [])):
        break
    time.sleep(1)
status, _ = app("POST", f"/api/review/{upload_id}/reject", admin, {"reason": "Notification test"})
check("the file can be rejected", status == 200, str(status))
check("a rejection notifies the uploader (rejected)", delivered("rejected"), str(received[:1]))

# --- an event the user didn't ask for is not sent ---
app("POST", "/api/notifications", uploader, {"channel": "webhook", "target": target, "events": ["approved"]})
received.clear()
upload(uploader, f"Notify Quiet {tag}.cbz", os.urandom(4096))
time.sleep(4)
check("an event the user did not select is not delivered", not delivered("invalid", within=1), str(received[:1]))

server.shutdown()
print()
print(f"{sum(results)}/{len(results)} passed")
sys.exit(0 if all(results) else 1)
