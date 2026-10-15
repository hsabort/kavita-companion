#!/usr/bin/env python3
"""Drives the real upload page in headless Chromium (Playwright): sign in, pick a library,
upload a small .cbz through Uppy, check it shows as waiting for review, then withdraw it.
Fails on any browser console error (including Content-Security-Policy violations).

Run with tests/run.sh --browser (inside the Playwright Docker image).
Args: <path to .env> <screenshot dir>  (tests/run.sh passes these)
"""
import io
import os
import secrets
import sys
import zipfile

from playwright.sync_api import sync_playwright

from settings import ORIGIN, env

shots = sys.argv[2]

tag = secrets.token_hex(3)
cbz_path = f"/tmp/Browser Test {tag} v01.cbz"
buf = io.BytesIO()
with zipfile.ZipFile(buf, "w", zipfile.ZIP_STORED) as z:
    z.writestr("001.jpg", b"\xff\xd8\xff\xe0" + os.urandom(300_000))
open(cbz_path, "wb").write(buf.getvalue())

failures = []


def check(name, ok, detail=""):
    print(f"{'PASS' if ok else 'FAIL'}  {name}" + (f"  ({detail})" if detail and not ok else ""))
    if not ok:
        failures.append(name)


with sync_playwright() as p:
    browser = p.chromium.launch()
    for label, viewport in (("desktop", {"width": 1280, "height": 900}), ("phone", {"width": 390, "height": 844})):
        context = browser.new_context(viewport=viewport, is_mobile=label == "phone")
        page = context.new_page()
        console_errors = []
        page.on("console", lambda m: console_errors.append(m.text) if m.type == "error" else None)
        page.on("pageerror", lambda e: console_errors.append(str(e)))

        page.goto(ORIGIN)
        page.fill("input[name=username]", env["TEST_UPLOADER_USERNAME"])
        page.fill("input[name=password]", env["TEST_UPLOADER_PASSWORD"])
        page.click("#login-form button[type=submit]")
        page.wait_for_selector("#home-view:not([hidden])", timeout=15000)
        check(f"[{label}] signed in", page.inner_text("#who") == env["TEST_UPLOADER_USERNAME"])
        page.wait_for_selector(".uppy-Dashboard", timeout=15000)
        check(f"[{label}] Uppy upload panel rendered", page.is_visible(".uppy-Dashboard"))

        if label == "desktop":
            page.set_input_files(".uppy-Dashboard-input", cbz_path)
            page.wait_for_selector(".uppy-StatusBar-actionBtn--upload", timeout=10000)
            # Trying to upload before choosing a library must be blocked with a message.
            page.click(".uppy-StatusBar-actionBtn--upload")
            page.wait_for_timeout(500)
            check("[desktop] upload blocked until a library is chosen",
                  "Choose a library" in page.inner_text("body"))
            page.select_option("#library", label="Comics")
            page.click(".uppy-StatusBar-actionBtn--upload")
            page.wait_for_selector(".uppy-StatusBar.is-complete", timeout=60000)
            check("[desktop] Uppy reports the upload complete", True)
            # Selector-based waits: the page's CSP (correctly) blocks Playwright's eval-based wait_for_function.
            page.wait_for_selector("#uploads li:has-text('Waiting for review')", timeout=30000)
            text = page.inner_text("#uploads")
            check("[desktop] My uploads shows it waiting for review",
                  f"Browser Test {tag} v01.cbz" in text and "Waiting for review" in text, text[:200])

        page.screenshot(path=f"{shots}/m2-{label}.png", full_page=True)
        width = page.evaluate("document.documentElement.scrollWidth")
        check(f"[{label}] no horizontal scrolling", width <= viewport["width"], f"scrollWidth={width}")

        if label == "desktop":
            page.once("dialog", lambda d: d.accept())
            page.click("#uploads li:first-child button")
            page.wait_for_selector("#uploads li:first-child:has-text('Withdrawn')", timeout=15000)
            check("[desktop] withdraw button works", True)

        check(f"[{label}] no browser console errors", not console_errors, " | ".join(console_errors)[:400])
        context.close()
    browser.close()

print(f"\n{'ALL PASSED' if not failures else f'{len(failures)} FAILED'}")
sys.exit(1 if failures else 0)
