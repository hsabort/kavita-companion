#!/usr/bin/env python3
"""Browser test: the Notifications panel is shown to uploaders (and can be turned off and saved) and is
hidden from read-only accounts.

Run with tests/run.sh --browser (inside the Playwright Docker image).
Args: <path to .env> <screenshot dir>  (tests/run.sh passes these)
"""
import sys

from playwright.sync_api import sync_playwright

from browser_helpers import sign_in
from settings import ORIGIN, env

shots = sys.argv[2]
failures = []


def check(name, ok, detail=""):
    print(f"{'PASS' if ok else 'FAIL'}  {name}" + (f"  ({detail})" if detail and not ok else ""), flush=True)
    if not ok:
        failures.append(name)


with sync_playwright() as p:
    browser = p.chromium.launch()
    context = browser.new_context(viewport={"width": 1280, "height": 900})
    page = context.new_page()
    errors = []
    page.on("console", lambda m: errors.append(m.text) if m.type == "error" else None)
    page.on("pageerror", lambda e: errors.append(str(e)))

    sign_in(page, "UPLOADER")
    page.click("#tab-notifications")
    page.wait_for_selector("#notify-wrap:not([hidden])", timeout=15000)
    check("Notifications panel is shown to an uploader", page.is_visible("#notify-wrap"))

    page.click("#notify-wrap summary")
    page.select_option("#notify-channel", "off")
    page.click("#notify-save")
    page.wait_for_selector("#notify-status:not(:empty)", timeout=10000)
    check("saving the panel reports success", "Saved" in page.inner_text("#notify-status"), page.inner_text("#notify-status"))
    page.screenshot(path=f"{shots}/notifications-desktop.png", full_page=True)

    check("no browser console errors", not errors, " | ".join(errors)[:300])
    context.close()

    context = browser.new_context(viewport={"width": 1280, "height": 900})
    page = context.new_page()
    sign_in(page, "READONLY")
    check("Notifications panel is hidden from a read-only account", page.is_hidden("#notify-wrap"))
    context.close()

    browser.close()

print(f"\n{'ALL PASSED' if not failures else f'{len(failures)} FAILED'}")
sys.exit(1 if failures else 0)
