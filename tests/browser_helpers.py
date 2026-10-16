"""Shared helpers for the browser tests (they run inside the Playwright container, with tests/ on
PYTHONPATH). Import with `from browser_helpers import sign_in`.
"""
from settings import ORIGIN, env


def sign_in(page, key):
    """Open the portal and sign in as TEST_<key>; returns once the signed-in view is shown."""
    page.goto(ORIGIN)
    page.fill("input[name=username]", env[f"TEST_{key}_USERNAME"])
    page.fill("input[name=password]", env[f"TEST_{key}_PASSWORD"])
    page.click("#login-form button[type=submit]")
    page.wait_for_selector("#home-view:not([hidden])", timeout=15000)
