#!/usr/bin/env python3
"""Drives the review screen in headless Chromium (Playwright) as test-admin: upload a .cbz through
Uppy, check the review card and its destination preview (desktop and phone), approve it, and check
the confirmation. Fails on any browser console error.

The approved file lands in MEDIA_ROOT/comics/Browser Review <tag>/; tests/run.sh removes it
(from disk and from Kavita) afterwards.
Args: <path to .env> <screenshot dir>  (tests/run.sh passes these)
"""
import io
import os
import secrets
import sys
import struct
import zipfile
import zlib

from playwright.sync_api import sync_playwright

from settings import ORIGIN, env

shots = sys.argv[2]


def png(width, height, rgb):
    """A small, valid solid-colour PNG (so the browser can actually display the cover)."""
    def chunk(kind, data):
        return struct.pack(">I", len(data)) + kind + data + struct.pack(">I", zlib.crc32(kind + data))
    raw = b"".join(b"\x00" + rgb * width for _ in range(height))
    return (b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", struct.pack(">IIBBBBB", width, height, 8, 2, 0, 0, 0))
            + chunk(b"IDAT", zlib.compress(raw)) + chunk(b"IEND", b""))

series = f"Browser Review {secrets.token_hex(3)}"
filename = f"{series} v01.cbz"
path = f"/tmp/{filename}"
buf = io.BytesIO()
with zipfile.ZipFile(buf, "w", zipfile.ZIP_STORED) as z:
    z.writestr("001.png", png(64, 96, secrets.token_bytes(3)))
    z.writestr("002.png", png(64, 96, secrets.token_bytes(3)))
open(path, "wb").write(buf.getvalue())
print(f"SERIES={series}")

failures = []


def check(name, ok, detail=""):
    print(f"{'PASS' if ok else 'FAIL'}  {name}" + (f"  ({detail})" if detail and not ok else ""))
    if not ok:
        failures.append(name)


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


with sync_playwright() as p:
    browser = p.chromium.launch()
    desktop_ctx, page, desktop_errors = signed_in_page(browser, {"width": 1280, "height": 900})
    check("[desktop] admin sees the review section", page.is_visible("#review-section"))

    page.click("#tab-upload")
    page.wait_for_selector(".uppy-Dashboard", timeout=15000)
    page.select_option("#library", label="Comics")
    page.set_input_files(".uppy-Dashboard-input", path)
    page.click(".uppy-StatusBar-actionBtn--upload")
    page.wait_for_selector(f"#uploads li:has-text('{filename}'):has-text('Waiting for review')", timeout=60000)
    page.click("#tab-review")
    page.click("#review-refresh")
    # The file is read in the background first; the card replaces its placeholder when ready.
    card = page.locator(".review-row", has_text=filename)
    card.wait_for(timeout=30000)
    group = page.locator(".review-group", has=card)
    group.locator(".series-note").filter(has_text="series").wait_for(timeout=15000)  # filled in once Kavita answers
    check("[desktop] card shows the cover", card.locator(".cover-tile img").count() == 1)
    check("[desktop] new series is labelled as such", "New series" in group.locator(".series-note").inner_text())
    check("[desktop] warns there's no metadata inside the file", "No metadata inside" in card.locator(".warnings").inner_text())
    destination = card.locator(".destination")
    check("[desktop] destination preview uses the series folder and .cbz",
          destination.inner_text().startswith(f"Will be saved as Comics / {series} / ") and destination.inner_text().endswith(".cbz"),
          destination.inner_text())
    # Editing a field updates the generated file name.
    card.locator("label.field", has_text="Number").locator("input").fill("7")
    check("[desktop] file name follows the fields", "#007.cbz" in destination.inner_text(), destination.inner_text())

    # Page preview: open, step to the last page, close.
    card.locator("button", has_text="Preview").click()
    page.wait_for_selector("#page-preview:not([hidden])", timeout=10000)
    page.wait_for_selector("#preview-img[src]", timeout=10000)
    check("[desktop] the page preview opens", page.is_visible("#page-preview"))
    page.click("#preview-next")
    check("[desktop] the preview counts the pages", "2 / 2" in page.inner_text("#preview-count"), page.inner_text("#preview-count"))
    page.click("#preview-close")
    check("[desktop] the preview closes", page.is_hidden("#page-preview"))

    phone_ctx, phone, phone_errors = signed_in_page(browser, {"width": 390, "height": 844}, phone=True)
    phone.locator(".review-row", has_text=filename).wait_for(timeout=30000)
    phone.locator(".review-row", has_text=filename).scroll_into_view_if_needed()
    phone.screenshot(path=f"{shots}/m3-phone.png", full_page=True)
    width = phone.evaluate("document.documentElement.scrollWidth")
    check("[phone] review card fits without horizontal scrolling", width <= 390, f"scrollWidth={width}")
    check("[phone] no browser console errors", not phone_errors, " | ".join(phone_errors)[:300])
    phone_ctx.close()

    page.screenshot(path=f"{shots}/m3-desktop-before.png", full_page=True)
    # An async refresh can re-render the card while the phone context is being set up, resetting the
    # Number field; re-apply it and confirm the destination before approving.
    card.locator("label.field", has_text="Number").locator("input").fill("7")
    card.locator(".destination", has_text="#007.cbz").wait_for(timeout=10000)
    card.locator("button", has_text="Approve").click()
    card.locator(".row-status", has_text="Approved").wait_for(timeout=60000)
    status_text = card.locator(".row-status").inner_text()
    check("[desktop] approval confirmed with destination",
          f"/data/comics/{series}/" in status_text and "#007.cbz" in status_text, status_text)
    page.click("#review-recent-wrap summary")
    check("[desktop] decision listed under recent decisions",
          page.locator("#review-recent li", has_text=filename).filter(has_text="Approved by").count() == 1)
    page.click("#tab-upload")
    page.wait_for_selector(f"#uploads li:has-text('{filename}'):has-text('In the library')", timeout=15000)
    check("[desktop] My uploads shows it as in the library", True)
    page.screenshot(path=f"{shots}/m3-desktop-after.png", full_page=True)
    check("[desktop] no browser console errors", not desktop_errors, " | ".join(desktop_errors)[:300])
    desktop_ctx.close()
    browser.close()

print(f"\n{'ALL PASSED' if not failures else f'{len(failures)} FAILED'}")
sys.exit(1 if failures else 0)
