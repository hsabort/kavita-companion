#!/usr/bin/env python3
"""Browser test: the reviewer-only Library tab (phase 2, M5). The tab renders for an admin, its two
sub-views toggle, the library filter and search controls drive the API, and there are no console
errors. Hidden from everyone else.

Run with tests/run.sh --browser (inside the Playwright Docker image).
Args: <path to .env> <screenshot dir>  (tests/run.sh passes these)
"""
import sys

from playwright.sync_api import sync_playwright

from browser_helpers import sign_in

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
    page.click("#tab-library")
    page.wait_for_selector("#library-section:not([hidden])", timeout=15000)
    check("the Library tab is shown to an admin", page.is_visible("#library-section"))
    check("the Library tab button is visible", page.is_visible("#tab-library"))

    # The two sub-views toggle in place.
    page.click("#library-view-incomplete")
    page.wait_for_selector("#library-incomplete:not([hidden])", timeout=15000)
    check("Needs metadata sub-view toggles on", page.is_visible("#library-incomplete") and page.is_hidden("#library-browse"))
    page.click("#library-view-browse")
    page.wait_for_selector("#library-browse:not([hidden])", timeout=15000)
    check("Browse sub-view toggles back", page.is_visible("#library-browse") and page.is_hidden("#library-incomplete"))

    # The library filter is filled from the real libraries.
    page.wait_for_function("document.querySelectorAll('#library-filter option').length >= 2", timeout=15000)
    check("the library filter lists the libraries", page.locator("#library-filter option").count() >= 2,
          str(page.locator("#library-filter option").count()))

    # A search with no match ends in the empty state (the request completed and the UI responded).
    page.fill("#library-search", "zzz-no-such-series-xyz")
    page.click("#library-search-go")
    page.wait_for_selector("#library-empty:not([hidden])", timeout=15000)
    check("a search with no match shows the empty state", page.is_visible("#library-empty"))

    # Clearing it and filtering by a library reloads without error.
    page.fill("#library-search", "")
    page.click("#library-search-go")
    page.wait_for_function("document.getElementById('library-status').textContent.trim().length > 0", timeout=15000)
    page.select_option("#library-filter", index=1)
    page.wait_for_timeout(1500)
    check("changing the library filter does not error", page.is_visible("#library-section"))
    page.screenshot(path=f"{shots}/library-desktop.png", full_page=True)

    check("no browser console errors", not errors, " | ".join(errors)[:300])
    context.close()

    # Phones: the tab still renders.
    context = browser.new_context(viewport={"width": 390, "height": 844})
    page = context.new_page()
    sign_in(page, "ADMIN")
    page.click("#tab-library")
    page.wait_for_selector("#library-section:not([hidden])", timeout=15000)
    check("the Library tab renders on a phone", page.is_visible("#library-section"))
    page.screenshot(path=f"{shots}/library-phone.png", full_page=True)
    context.close()

    # Non-reviewers never see it.
    context = browser.new_context(viewport={"width": 1280, "height": 900})
    page = context.new_page()
    sign_in(page, "UPLOADER")
    check("the Library tab is hidden from a non-admin", page.is_hidden("#tab-library"))
    check("the Library section is hidden from a non-admin", page.is_hidden("#library-section"))
    context.close()

    browser.close()

print(f"\n{'ALL PASSED' if not failures else f'{len(failures)} FAILED'}")
sys.exit(1 if failures else 0)
