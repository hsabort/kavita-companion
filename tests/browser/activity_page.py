#!/usr/bin/env python3
"""Browser test: the admin Activity panel renders for a reviewer (cards + entries, no console errors)
and is hidden from everyone else.

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

    sign_in(page, "ADMIN")
    page.click("#tab-activity")
    page.wait_for_selector("#activity-section:not([hidden])", timeout=15000)
    page.wait_for_selector("#activity-list li", timeout=15000)
    page.wait_for_selector("#activity-insights .insight", timeout=15000)
    check("Activity panel is shown to an admin", page.is_visible("#activity-section"))
    check("summary cards render", page.locator("#activity-insights .insight").count() >= 4,
          str(page.locator("#activity-insights .insight").count()))
    check("at least one activity entry is listed", page.locator("#activity-list li").count() >= 1)
    page.screenshot(path=f"{shots}/activity-desktop.png", full_page=True)

    page.select_option("#activity-action", "login_failed")
    # Wait for the filtered list to settle (refreshActivity re-renders after the change).
    try:
        page.wait_for_selector("#activity-list li:has-text('failed to sign in')", timeout=10000)
    except Exception:
        pass
    text = page.inner_text("#activity-list").lower()
    check("filtering by action narrows the list", "approved an upload" not in text and "finished an upload" not in text)

    check("no browser console errors", not errors, " | ".join(errors)[:300])
    context.close()

    context = browser.new_context(viewport={"width": 390, "height": 844})
    page = context.new_page()
    sign_in(page, "UPLOADER")
    check("Activity panel is hidden from a non-admin", page.is_hidden("#activity-section"))
    context.close()

    browser.close()

print(f"\n{'ALL PASSED' if not failures else f'{len(failures)} FAILED'}")
sys.exit(1 if failures else 0)
