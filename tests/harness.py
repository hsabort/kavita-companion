"""Shared helpers for the acceptance tests, so each file only holds its assertions and setup.

    from harness import app, check, finish, login, upload, wait_pending, wait_approved

`check()` collects pass/fail; `finish()` prints the summary and returns the process exit code.
"""
import base64
import json
import sys
import time
import urllib.error
import urllib.request

from settings import KAVITA_LOCAL, ORIGIN, env

results = []
_sessions = {}


def check(name, ok, detail=""):
    results.append(bool(ok))
    print(f"{'PASS' if ok else 'FAIL'}  {name}" + (f"  ({detail})" if detail and not ok else ""), flush=True)
    return bool(ok)


def finish():
    print()
    print(f"{sum(results)}/{len(results)} passed")
    return 0 if all(results) else 1


def request(method, url, body=None, headers=None):
    req = urllib.request.Request(url, body, headers or {}, method=method)
    try:
        with urllib.request.urlopen(req, timeout=60) as response:
            return response.status, response.headers, response.read()
    except urllib.error.HTTPError as error:
        return error.code, error.headers, error.read()


def app(method, path, cookie=None, body=None, raw=False):
    """Call the portal. Returns (status, parsed-body) or (status, bytes) when raw."""
    headers = {"Origin": ORIGIN}
    if cookie:
        headers["Cookie"] = cookie
    data = json.dumps(body).encode() if body is not None else None
    if data is not None:
        headers["Content-Type"] = "application/json"
    status, _, out = request(method, ORIGIN + path, data, headers)
    if raw:
        return status, out
    try:
        return status, json.loads(out or b"{}")
    except ValueError:
        return status, {"raw": out[:200]}


def kavita(method, path, body=None, token=None):
    """Call Kavita directly: with the portal's admin key, or a user's Bearer token."""
    headers = {"Content-Type": "application/json"}
    headers["Authorization" if token else "x-api-key"] = ("Bearer " + token) if token else env["COMPANION_KAVITA_AUTH_KEY"]
    status, _, out = request(method, KAVITA_LOCAL + path, json.dumps(body).encode() if body is not None else None, headers)
    try:
        return status, (json.loads(out) if out else None)
    except ValueError:
        return status, out


def login(role):
    """Portal session cookie for TEST_UPLOADER / TEST_READONLY / TEST_ADMIN (cached per process)."""
    role = role.upper()
    if role in _sessions:
        return _sessions[role]
    status, headers, _ = request(
        "POST", ORIGIN + "/api/login",
        json.dumps({"username": env[f"TEST_{role}_USERNAME"], "password": env[f"TEST_{role}_PASSWORD"]}).encode(),
        {"Content-Type": "application/json", "Origin": ORIGIN})
    assert status == 200, f"login {role}: HTTP {status}"
    cookie = next(v for v in headers.get_all("Set-Cookie") if v.startswith("__Host-")).split(";", 1)[0]
    _sessions[role] = cookie
    return cookie


def upload(cookie, filename, data, library_id):
    """Start and complete a tus upload; returns its upload id."""
    b64 = lambda value: base64.b64encode(str(value).encode()).decode()
    _, headers, _ = request("POST", ORIGIN + "/files", None,
                            {"Origin": ORIGIN, "Cookie": cookie, "Tus-Resumable": "1.0.0", "Upload-Length": str(len(data)),
                             "Upload-Metadata": f"filename {b64(filename)},libraryId {b64(library_id)}"})
    location = headers["Location"]
    url = location if location.startswith("http") else ORIGIN + location
    request("PATCH", url, data, {"Origin": ORIGIN, "Cookie": cookie, "Tus-Resumable": "1.0.0",
                                 "Upload-Offset": "0", "Content-Type": "application/offset+octet-stream"})
    return location.rsplit("/", 1)[1]


def wait_until(predicate, timeout=60, interval=0.5):
    """Poll `predicate` until it returns something truthy or the timeout passes; returns its value (or None)."""
    deadline = time.time() + timeout
    while time.time() < deadline:
        value = predicate()
        if value:
            return value
        time.sleep(interval)
    return None


def wait_pending(cookie, upload_id, timeout=90):
    """The review item once its inspection is ready."""
    def ready():
        _, body = app("GET", "/api/review", cookie)
        return next((item for item in body.get("pending", []) if item["id"] == upload_id and item.get("defaults")), None)
    return wait_until(ready, timeout, 1)


def wait_approved(cookie, upload_id, timeout=180):
    """The item once its background approval/fix has finished."""
    def done():
        _, body = app("GET", f"/api/review/{upload_id}/state", cookie)
        item = body.get("item")
        return item if item and item.get("status") in ("approved", "rejected") else None
    return wait_until(done, timeout, 2)


def run(script_globals=None):
    """`sys.exit(finish())` — called at the end of a test file."""
    sys.exit(finish())
