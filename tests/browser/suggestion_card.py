#!/usr/bin/env python3
"""Drives the review card's external-metadata flow in headless Chromium (Playwright) as test-admin:
upload a comic with no year, try Find metadata while the provider is off (the disabled state), enable
Metron and set a key and Test it on the About tab, then Find metadata again, pick the candidate, apply
the fields and check the filled values, per-field source chips and the attribution line.

The Metron adapter is pointed at the in-process fake (tests/provider_fake.py). tests/run.sh starts that
fake on the host for the browser tier, because the portal (another container) reaches it through the
Docker gateway. The upload is withdrawn at the end (no library writes) and Metron is left off.

Args: <path to .env> <screenshot dir>  (tests/run.sh passes these)
"""
import io
import os
import secrets
import struct
import sys
import time
import zipfile
import zlib

from playwright.sync_api import sync_playwright

from settings import ORIGIN, env

shots = sys.argv[2]
series = f"Fixture Saga"
tag = secrets.token_hex(3)
filename = f"{series} #001 {tag}.cbz"

failures = []


def check(name, ok, detail=""):
    print(f"{'PASS' if ok else 'FAIL'}  {name}" + (f"  ({detail})" if detail and not ok else ""))
    if not ok:
        failures.append(name)


def png(width, height, rgb):
    def chunk(kind, data):
        return struct.pack(">I", len(data)) + kind + data + struct.pack(">I", zlib.crc32(kind + data))
    raw = b"".join(b"\x00" + rgb * width for _ in range(height))
    return (b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", struct.pack(">IIBBBBB", width, height, 8, 2, 0, 0, 0))
            + chunk(b"IDAT", zlib.compress(raw)) + chunk(b"IEND", b""))


def comicinfo_cbz():
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w", zipfile.ZIP_STORED) as archive:
        archive.writestr("001.png", png(64, 96, secrets.token_bytes(3)))
        archive.writestr("002.png", png(64, 96, secrets.token_bytes(3)))
        # Series + Number only: Year and the credits are left blank so a fill has something to do.
        archive.writestr("ComicInfo.xml", "<ComicInfo><Series>Fixture Saga</Series><Number>1</Number></ComicInfo>")
    return buf.getvalue()


def post_api(page, path, payload):
    return page.evaluate(
        "([path, payload]) => fetch(path, {method: 'POST', headers: {'Content-Type': 'application/json'}, "
        "body: JSON.stringify(payload)}).then(r => r.json())",
        [path, payload])


def signed_in_page(browser, viewport, phone=False):
    context = browser.new_context(viewport=viewport, is_mobile=phone)
    page = context.new_page()
    errors = []
    page.on("console", lambda m: errors.append(m.text) if m.type == "error" else None)
    page.on("pageerror", lambda e: errors.append(str(e)))
    page.goto(ORIGIN)
    page.fill("input[name=username]", env["TEST_ADMIN_USERNAME"])
    page.fill("input[name=password]", env["TEST_ADMIN_PASSWORD"])
    page.click("#login-form button[type=submit]")
    page.wait_for_selector("#review-section:not([hidden])", timeout=15000)
    return context, page, errors


def upload(page, path):
    page.click("#tab-upload")
    page.wait_for_selector(".uppy-Dashboard", timeout=15000)
    page.select_option("#library", label="Comics")
    page.set_input_files(".uppy-Dashboard-input", path)
    page.click(".uppy-StatusBar-actionBtn--upload")
    page.wait_for_selector(f"#uploads li:has-text('{filename}'):has-text('Waiting for review')", timeout=60000)


def open_card(page):
    page.click("#tab-review")
    page.click("#review-refresh")
    card = page.locator(".review-row", has_text=filename)
    card.wait_for(timeout=30000)
    return card, page.locator(".review-group", has=card)


try:
    path = f"/tmp/{filename}"
    open(path, "wb").write(comicinfo_cbz())
    print(f"UPLOAD={filename}")

    with sync_playwright() as p:
        browser = p.chromium.launch()
        context, page, errors = signed_in_page(browser, {"width": 1280, "height": 900})

        # Deterministic start: make sure Metron is off and keyless (and its cache is purged).
        post_api(page, "/api/admin/providers", {"id": "metron", "enabled": False})
        post_api(page, "/api/admin/providers", {"id": "metron", "key": ""})

        upload(page, path)
        card, group = open_card(page)

        # --- the action is hidden while no provider covers this library's kind of file ---
        check("[desktop] no Find metadata action while the source is off",
              group.locator("button", has_text="Find metadata").count() == 0)

        # --- About -> Metadata sources + the reviewer provider panel ---
        page.click("#tab-about")
        page.wait_for_selector("#metadata-sources .source-row", timeout=15000)
        check("[desktop] Metadata sources credits Metron (CC BY-SA 4.0)",
              "Comic data from Metron, CC BY-SA 4.0" in page.inner_text("#metadata-sources"))
        check("[desktop] the metadata sources licence links out",
              page.locator("#metadata-sources a[href='https://creativecommons.org/licenses/by-sa/4.0/']").count() >= 1)

        provider = page.locator(".provider-row", has_text="Metron")
        provider.locator("button", has_text="Turn on").click()
        provider.locator("button", has_text="Turn off").wait_for(timeout=15000)
        provider.locator("input[type=password]").fill("browser-test-key")
        provider.locator("button", has_text="Save key").click()
        provider.locator(".chip", has_text="Has key").wait_for(timeout=15000)
        provider.locator("button", has_text="Test").click()
        provider.locator(".row-status", has_text="answered").wait_for(timeout=15000)
        check("[desktop] the provider Test button reports the provider answered", True)
        provider.screenshot(path=f"{shots}/providers-panel.png")

        # --- Find metadata returns candidates; apply fills the blanks with attribution ---
        card, group = open_card(page)
        check("[desktop] Find metadata appears once a provider is on",
              group.locator("button", has_text="Find metadata").count() == 1)
        group.locator("button", has_text="Find metadata").click()
        group.locator(".candidate").first.wait_for(timeout=20000)
        check("[desktop] candidates list their source",
              group.locator(".candidate .chip-source", has_text="Metron").count() >= 1)
        check("[desktop] the matching candidate is listed",
              "Fixture Saga" in group.locator(".candidate").first.inner_text()
              and "2012" in group.locator(".candidate").first.inner_text(),
              group.locator(".candidate").first.inner_text())
        page.screenshot(path=f"{shots}/suggestion-candidates.png", full_page=True)

        group.locator("button", has_text="Apply selected fields").click()
        group.locator(".attribution", has_text="Applied from Metron").wait_for(timeout=20000)
        attribution = group.locator(".attribution").inner_text()
        check("[desktop] the attribution line names the provider and licence",
              "Applied from Metron" in attribution and "CC BY-SA 4.0" in attribution, attribution)
        check("[desktop] a per-field source chip is shown",
              group.locator(".apply-result .chip", has_text="Year").count() >= 1)
        year_value = group.locator("label.field", has_text="Year").locator("input").input_value()
        check("[desktop] the blank Year is filled from the provider", year_value == "2012", year_value)
        writer = group.locator("label.field", has_text="Writer").locator("input")
        check("[desktop] the credits are filled from the provider", "A. Writer" in writer.input_value(), writer.input_value())
        page.screenshot(path=f"{shots}/suggestion-applied.png", full_page=True)
        check("[desktop] no browser console errors", not errors, " | ".join(errors)[:300])

        # --- responsive: the panel fits a phone without horizontal scrolling ---
        phone_context, phone, phone_errors = signed_in_page(browser, {"width": 390, "height": 844}, phone=True)
        _, phone_group = open_card(phone)
        phone_group.locator("button", has_text="Find metadata").click()
        phone_group.locator(".candidate").first.wait_for(timeout=20000)
        phone_group.locator("button", has_text="Apply selected fields").click()
        phone_group.locator(".attribution", has_text="Applied from Metron").wait_for(timeout=20000)
        phone_group.scroll_into_view_if_needed()
        phone.screenshot(path=f"{shots}/suggestion-phone.png", full_page=True)
        width = phone.evaluate("document.documentElement.scrollWidth")
        check("[phone] the suggestion panel fits without horizontal scrolling", width <= 390, f"scrollWidth={width}")
        check("[phone] no browser console errors", not phone_errors, " | ".join(phone_errors)[:300])
        phone_context.close()

        # --- clean up: withdraw the upload, leave Metron off and keyless ---
        page.click("#tab-upload")
        row = page.locator("#uploads li", has_text=filename)
        page.on("dialog", lambda dialog: dialog.accept())
        row.locator("button", has_text="Withdraw").click()
        page.wait_for_selector(f"#uploads li:has-text('{filename}'):has-text('Withdrawn')", timeout=15000)
        check("[desktop] the pending upload is withdrawn", True)
        post_api(page, "/api/admin/providers", {"id": "metron", "enabled": False})
        post_api(page, "/api/admin/providers", {"id": "metron", "key": ""})
        context.close()
        browser.close()
finally:
    try:
        os.remove(path)
    except OSError:
        pass

print(f"\n{'ALL PASSED' if not failures else f'{len(failures)} FAILED'}")
sys.exit(1 if failures else 0)
