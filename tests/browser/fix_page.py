#!/usr/bin/env python3
"""Browser test: the Fix screen and the "Open in Kavita" link.

Creates its own approved file through the API (series "Browser Review <tag>", removed afterwards by
tests/run.sh), then as test-admin: finds it under Recent decisions, follows "Open in Kavita" to the
right Kavita series page, opens Fix…, changes the title and saves.
Args: <path to .env> <screenshot dir>  (tests/run.sh passes these)
"""
import base64
import io
import json
import os
import secrets
import sys
import time
import urllib.request
import zipfile

from playwright.sync_api import sync_playwright

from settings import KAVITA_PUBLIC, ORIGIN, env

shots = sys.argv[2]
series = f"Browser Review {secrets.token_hex(3)}"
failures = []


def check(name, ok, detail=""):
    print(f"{'PASS' if ok else 'FAIL'}  {name}" + (f"  ({detail})" if detail and not ok else ""), flush=True)
    if not ok:
        failures.append(name)


def call(method, path, cookie=None, body=None, headers=None, raw=None):
    h = {"Origin": ORIGIN, **(headers or {})}
    if cookie:
        h["Cookie"] = cookie
    data = raw
    if body is not None:
        h["Content-Type"] = "application/json"
        data = json.dumps(body).encode()
    with urllib.request.urlopen(urllib.request.Request(ORIGIN + path, data, h, method=method), timeout=60) as r:
        return r.status, r.headers, r.read()


def login(key):
    _, headers, _ = call("POST", "/api/login", body={"username": env[f"TEST_{key}_USERNAME"], "password": env[f"TEST_{key}_PASSWORD"]})
    return next(v for v in headers.get_all("Set-Cookie") if v.startswith("__Host-")).split(";", 1)[0]


def state(cookie, upload_id):
    return json.loads(call("GET", f"/api/review/{upload_id}/state", cookie)[2])["item"]


# --- an approved, confirmed file to work with ---
uploader, admin = login("UPLOADER"), login("ADMIN")
libs = {l["name"]: l["id"] for l in json.loads(call("GET", "/api/libraries", uploader)[2])["libraries"]}
buf = io.BytesIO()
with zipfile.ZipFile(buf, "w", zipfile.ZIP_STORED) as z:
    z.writestr("001.jpg", b"\xff\xd8\xff\xe0" + os.urandom(30_000))
data = buf.getvalue()
b64 = lambda s: base64.b64encode(str(s).encode()).decode()
_, headers, _ = call("POST", "/files", uploader, headers={"Tus-Resumable": "1.0.0", "Upload-Length": str(len(data)),
                     "Upload-Metadata": f"filename {b64(series + ' v01.cbz')},libraryId {b64(libs['Comics'])}"})
location = headers["Location"]
upload_id = location.rsplit("/", 1)[1]
call("PATCH", location, uploader, raw=data, headers={"Tus-Resumable": "1.0.0", "Upload-Offset": "0", "Content-Type": "application/offset+octet-stream"})
for _ in range(60):
    pending = {i["id"]: i for i in json.loads(call("GET", "/api/review", admin)[2])["pending"]}
    if pending.get(upload_id, {}).get("defaults"):
        break
    time.sleep(1)
call("POST", f"/api/review/{upload_id}/approve", admin, body={"libraryId": libs["Comics"], "seriesName": series, "filename": f"{series} #001", "metadata": {"Number": "1"}})
item = None
for _ in range(100):
    item = state(admin, upload_id)
    if item["kavitaStatus"] in ("confirmed", "missing"):
        break
    time.sleep(2)
check("approved test file is confirmed in Kavita", item["kavitaStatus"] == "confirmed", str(item))

with sync_playwright() as p:
    browser = p.chromium.launch()
    ctx = browser.new_context(viewport={"width": 1280, "height": 900})
    errors = []
    # Signed in to Kavita in this browser, so the link can open the series page.
    kavita = ctx.new_page()
    kavita.goto(f"{KAVITA_PUBLIC}/login")
    kavita.wait_for_selector("input[type=password]", timeout=20000)
    kavita.fill("input[type=text], input#username", env["TEST_ADMIN_USERNAME"])
    kavita.fill("input[type=password]", env["TEST_ADMIN_PASSWORD"])
    kavita.keyboard.press("Enter")
    kavita.wait_for_selector("app-side-nav-item", timeout=20000)

    page = ctx.new_page()
    page.on("console", lambda m: errors.append(m.text) if m.type == "error" else None)
    page.goto(ORIGIN)
    page.fill("#login-username", env["TEST_ADMIN_USERNAME"])
    page.fill("#login-password", env["TEST_ADMIN_PASSWORD"])
    page.click("#login-form button[type=submit]")
    page.wait_for_selector("#review-section:not([hidden])", timeout=20000)
    page.click("#review-recent-wrap summary")
    entry = page.locator("#review-recent li", has_text=f"{series} v01.cbz").first
    entry.wait_for(timeout=15000)
    link = entry.locator("a", has_text="Open in Kavita")
    check("Recent decisions shows 'In Kavita ✓' with a link", link.count() == 1 and "In Kavita" in entry.inner_text(), entry.inner_text())

    href = link.get_attribute("href")
    kavita.goto(href)
    # Kavita's series page is an Angular view that fetches its data after load; on a cold cache it can
    # take longer than a fixed sleep, so poll for the series name instead.
    opened = False
    for _ in range(30):
        if series in kavita.inner_text("body"):
            opened = True
            break
        kavita.wait_for_timeout(1000)
    check("'Open in Kavita' opens that series in Kavita", opened, href)
    kavita.screenshot(path=f"{shots}/fix-kavita-series.png")

    entry.locator("button", has_text="Fix…").click()
    card = page.locator("#fix-area .review-group")
    card.wait_for(timeout=20000)
    check("Fix opens an editor filled from the library file",
          card.locator("label.field", has_text="Series").locator("input").input_value() == series
          and card.locator("label.field", has_text="File name").locator("input").input_value() == f"{series} #001",
          card.inner_text()[:200])
    card.locator("label.field", has_text="Title").locator("input").fill("Browser Fixed")
    page.screenshot(path=f"{shots}/fix-editor.png", full_page=True)
    card.locator("button", has_text="Save changes").click()
    card.locator(".row-status", has_text="Saved").wait_for(timeout=60000)
    check("Save changes reports success", "Saved" in card.locator(".row-status").inner_text())
    check("no browser console errors", not errors, " | ".join(errors)[:300])
    browser.close()

print(f"\n{'ALL PASSED' if not failures else f'{len(failures)} FAILED'}")
sys.exit(1 if failures else 0)
