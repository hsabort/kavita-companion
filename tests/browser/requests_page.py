#!/usr/bin/env python3
"""Browser test: a user asks for a title from the Requests panel, and a reviewer sees it in the open
queue and can decline it (which cleans it up).

Run with tests/run.sh --browser (inside the Playwright Docker image).
Args: <path to .env> <screenshot dir>  (tests/run.sh passes these)
"""
import secrets
import sys

from playwright.sync_api import sync_playwright

from settings import ORIGIN, env

shots = sys.argv[2]
tag = secrets.token_hex(3)
title = f"Browser Request {tag}"
failures = []


def check(name, ok, detail=""):
    print(f"{'PASS' if ok else 'FAIL'}  {name}" + (f"  ({detail})" if detail and not ok else ""), flush=True)
    if not ok:
        failures.append(name)


def sign_in(page, key):
    page.goto(ORIGIN)
    page.fill("input[name=username]", env[f"TEST_{key}_USERNAME"])
    page.fill("input[name=password]", env[f"TEST_{key}_PASSWORD"])
    page.click("#login-form button[type=submit]")
    page.wait_for_selector("#home-view:not([hidden])", timeout=15000)


with sync_playwright() as p:
    browser = p.chromium.launch()
    context = browser.new_context(viewport={"width": 1280, "height": 900})
    page = context.new_page()
    errors = []
    page.on("console", lambda m: errors.append(m.text) if m.type == "error" else None)
    page.on("pageerror", lambda e: errors.append(str(e)))

    sign_in(page, "UPLOADER")
    page.wait_for_selector("#requests-section:not([hidden])", timeout=15000)
    check("Requests section is shown", page.is_visible("#requests-section"))
    page.fill("#request-title", title)
    page.fill("#request-number", "1")
    page.click("#request-add")
    page.wait_for_selector("#request-status:not(:empty)", timeout=10000)
    page.wait_for_selector(f"#requests-mine li:has-text('{title}')", timeout=10000)
    check("the request appears under My requests", page.locator(f"#requests-mine li:has-text('{title}')").count() == 1)
    page.screenshot(path=f"{shots}/requests-desktop.png", full_page=True)
    check("no browser console errors", not errors, " | ".join(errors)[:300])
    context.close()

    context = browser.new_context(viewport={"width": 1280, "height": 900})
    page = context.new_page()
    sign_in(page, "ADMIN")
    page.wait_for_selector(f"#requests-open li:has-text('{title}')", timeout=15000)
    check("a reviewer sees the request in the open queue", True)
    entry = page.locator(f"#requests-open li:has-text('{title}')").first
    entry.locator("button", has_text="Decline").click()
    page.wait_for_selector(f"#requests-open li:has-text('{title}')", state="detached", timeout=10000)
    check("declining removes it from the open queue", True)
    context.close()
    browser.close()

print(f"\n{'ALL PASSED' if not failures else f'{len(failures)} FAILED'}")
sys.exit(1 if failures else 0)
