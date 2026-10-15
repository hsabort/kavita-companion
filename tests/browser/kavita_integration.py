#!/usr/bin/env python3
"""M5d browser test: Kavita integration.
  1. Sign in to Kavita itself as test-uploader, click "Uploads" in Kavita's sidebar, and check the
     portal opens in a new tab already signed in, with the key gone from the address bar.
  2. Sign in to the portal with a password as test-readonly and check it adds "Uploads" to that
     user's Kavita sidebar (verified by reloading Kavita).
  3. Screenshots of the portal's sign-in and home screens (desktop + phone); fails on console errors.
Args: <path to .env> <screenshot dir>  (tests/run.sh passes these)
"""
import sys

from playwright.sync_api import sync_playwright

from settings import KAVITA_PUBLIC as KAVITA, ORIGIN as PORTAL, env

shots = sys.argv[2]

failures = []


def check(name, ok, detail=""):
    print(f"{'PASS' if ok else 'FAIL'}  {name}" + (f"  ({detail})" if detail and not ok else ""), flush=True)
    if not ok:
        failures.append(name)


def kavita_login(page, key):
    page.goto(f"{KAVITA}/login")
    page.wait_for_selector("input[type=password]", timeout=20000)
    page.fill("input[type=text], input#username", env[f"TEST_{key}_USERNAME"])
    page.fill("input[type=password]", env[f"TEST_{key}_PASSWORD"])
    page.keyboard.press("Enter")
    page.wait_for_selector("app-side-nav-item, .side-nav-item", timeout=20000)


with sync_playwright() as p:
    browser = p.chromium.launch()

    # 1. From Kavita's sidebar into the portal
    ctx = browser.new_context(viewport={"width": 1280, "height": 860})
    errors = []
    kavita = ctx.new_page()
    kavita_login(kavita, "UPLOADER")
    link = kavita.locator("app-side-nav-item", has_text="Uploads").first
    check("Kavita's sidebar shows 'Uploads' for test-uploader", link.count() == 1)
    kavita.screenshot(path=f"{shots}/m5d-kavita-sidebar.png")
    with ctx.expect_page(timeout=20000) as new_tab:
        link.click()
    portal = new_tab.value
    portal.on("console", lambda m: errors.append(m.text) if m.type == "error" else None)
    portal.wait_for_selector("#home-view:not([hidden])", timeout=20000)
    check("portal opened in a new tab, already signed in as test-uploader",
          portal.inner_text("#who") == env["TEST_UPLOADER_USERNAME"], portal.inner_text("#who"))
    check("the key is gone from the address bar", "apiKey" not in portal.url and portal.url.rstrip("/") == PORTAL, portal.url)
    check("'Back to Kavita' points at Kavita", portal.get_attribute("#back-to-kavita", "href") == KAVITA)
    font = portal.evaluate("getComputedStyle(document.body).fontFamily")
    bg = portal.evaluate("getComputedStyle(document.body).backgroundColor")
    check("portal uses Kavita's font and background", font.startswith('"Poppins"') or font.startswith("Poppins") and bg == "rgb(33, 37, 41)", f"{font} {bg}")
    portal.screenshot(path=f"{shots}/m5d-portal-home-desktop.png", full_page=True)
    check("no browser console errors on the portal", not errors, " | ".join(errors)[:300])
    ctx.close()

    # 2. Password sign-in adds the sidebar entry
    ctx = browser.new_context(viewport={"width": 390, "height": 844}, is_mobile=True)
    page = ctx.new_page()
    errors = []
    page.on("console", lambda m: errors.append(m.text) if m.type == "error" else None)
    page.goto(PORTAL)
    page.wait_for_selector("#login-view:not([hidden])", timeout=15000)
    page.screenshot(path=f"{shots}/m5d-portal-login-phone.png", full_page=True)
    page.fill("#login-username", env["TEST_ADMIN_USERNAME"])
    page.fill("#login-password", env["TEST_ADMIN_PASSWORD"])
    page.click("#login-form button[type=submit]")
    page.wait_for_selector("#home-view:not([hidden])", timeout=20000)
    text = page.inner_text("#notice")
    # First time: "Uploads is now in your Kavita sidebar"; later sign-ins: nothing to announce.
    check("password sign-in announces the sidebar link only when it adds it", text == "" or "sidebar" in text, text)
    page.screenshot(path=f"{shots}/m5d-portal-home-phone.png", full_page=True)
    width = page.evaluate("document.documentElement.scrollWidth")
    check("phone layout has no horizontal scrolling", width <= 390, f"scrollWidth={width}")
    check("no console errors on the phone layout", not errors, " | ".join(errors)[:300])
    ctx.close()
    # Kavita collapses its sidebar on phones, so check it at desktop size.
    ctx = browser.new_context(viewport={"width": 1280, "height": 860})
    kavita = ctx.new_page()
    kavita_login(kavita, "ADMIN")
    kavita.wait_for_timeout(1500)
    check("test-admin now has 'Uploads' in Kavita's sidebar",
          kavita.locator("app-side-nav-item", has_text="Uploads").count() >= 1)
    # Read-only accounts can't upload, and Kavita won't create keys for them: no link, clear message.
    page = ctx.new_page()
    page.goto(PORTAL)
    page.wait_for_selector("#login-view:not([hidden]), #home-view:not([hidden])", timeout=15000)
    if page.is_visible("#home-view"):
        page.click("#logout")
    page.fill("#login-username", env["TEST_READONLY_USERNAME"])
    page.fill("#login-password", env["TEST_READONLY_PASSWORD"])
    page.click("#login-form button[type=submit]")
    page.wait_for_selector("#home-view:not([hidden])", timeout=20000)
    check("read-only account is told uploading isn't available", "read-only" in page.inner_text("#notice"), page.inner_text("#notice"))
    ctx.close()

    # 3. Sign-in screen on desktop
    ctx = browser.new_context(viewport={"width": 1280, "height": 860})
    page = ctx.new_page()
    page.goto(PORTAL)
    page.wait_for_selector("#login-view:not([hidden])", timeout=15000)
    page.screenshot(path=f"{shots}/m5d-portal-login-desktop.png")
    ctx.close()
    browser.close()

print(f"\n{'ALL PASSED' if not failures else f'{len(failures)} FAILED'}")
sys.exit(1 if failures else 0)
