#!/usr/bin/env python3
"""The permissive default image's refusals (design §7.5, §7.6, §7.7).

The shared test stack runs the formats image, which carries the GPL/LGPL tools; this file is the other
half. It runs **only** against the permissive `runtime` image and proves both what that image refuses
and what it keeps:

    COMPANION_TEST_TARGET=runtime ./tests/run.sh --only test_default_image

Over the real stack it asserts:
  - a `.rar`, `.7z`, `.mobi` and `.azw3` upload each ends as a row with `status: "invalid"` whose
    `error` is exactly `capabilityMessage(...)`, is audited `upload_invalid`, and never reaches the
    pending area. An upload refusal has **no HTTP status** — it is decided after the tus response, in
    the completion step (design §7.5);
  - a `.cbr` whose bytes are really a zip is **accepted** (the refusal is content-based, so a
    mislabelled archive keeps working — the reason it is not decided by extension);
  - `.epub`, `.cbz` and `.pdf` still work (zip is read in-process);
  - the capability endpoint reports both optional tools absent;
  - an item whose *inspection itself* was refused records `Inspection.unavailable`, the review card
    passes it through, and the preview route refuses it with the actionable message (design §7.6).

`--image-only` runs the same refusal logic against the built `runtime` image in a container, with no
stack at all. That is what CI can run (see .github/workflows/ci.yml): GitHub-hosted runners have no
Kavita, and the HTTP suite above needs the test host's stack. Both modes assert the same three things —
the capability probe, the typed capability error, and the archive/Kindle (`.mobi` and `.azw3`)
refusals — so the default image's behaviour is gated in CI as well as on the host.
"""
import json
import os
import secrets
import shutil
import subprocess
import sys
import tempfile
import time
from pathlib import Path

FIXTURES = Path(__file__).resolve().parent / "fixtures"


def _check(name, ok, detail=""):
    """A local `harness.check` for `--image-only`, which must not import `settings`/`harness`."""
    print(f"{'PASS' if ok else 'FAIL'}  {name}" + (f"  ({detail})" if detail and not ok else ""), flush=True)
    return bool(ok)


# ---------------------------------------------------------------------------------------------
# --image-only: the refusal logic inside the built runtime image, with no stack (what CI runs).
# ---------------------------------------------------------------------------------------------

IMAGE_PROBE = r"""
import { pathToFileURL } from "node:url";

const results = [];
const check = (name, ok, detail = "") => results.push({ name, ok: !!ok, detail: String(detail) });
async function attempt(fn) {
  try { return { value: await fn() }; }
  catch (err) { return { error: err, message: String(err && err.message) }; }
}

let caps, archive, zip, mobi;
try {
  caps = await import(pathToFileURL("/app/dist/capabilities.js").href);
  archive = await import(pathToFileURL("/app/dist/archive.js").href);
  zip = await import(pathToFileURL("/app/dist/zip.js").href);
  mobi = await import(pathToFileURL("/app/dist/mobi.js").href);
} catch (err) {
  check("the built modules load (dist/capabilities.js and friends)", false, err && err.message);
  console.log(JSON.stringify({ results, messages: {} }));
  process.exit(0);
}
check("the built modules load (dist/capabilities.js and friends)", true);

const W = "/w";
const report = await caps.probeCapabilities();
check("the permissive image reports no 7-Zip (archiveExtras)", report.archiveExtras === false, JSON.stringify(report));
check("the permissive image reports no KindleUnpack (kindle)", report.kindle === false, JSON.stringify(report));
check("zip stays present (read in-process)", report.zip === true, JSON.stringify(report));

const messages = {
  "archive-extras": caps.capabilityMessage("archive-extras"),
  kindle: caps.capabilityMessage("kindle"),
};

const ar = await attempt(() => caps.requireCapability("archive-extras"));
check("requireCapability('archive-extras') throws CapabilityError",
      ar.error instanceof caps.CapabilityError && ar.error.capability === "archive-extras",
      ar.error ? `${ar.error.name}: ${ar.message}` : "it resolved");
const kd = await attempt(() => caps.requireCapability("kindle"));
check("requireCapability('kindle') throws CapabilityError",
      kd.error instanceof caps.CapabilityError && kd.error.capability === "kindle",
      kd.error ? `${kd.error.name}: ${kd.message}` : "it resolved");

const rar = await attempt(() => archive.listEntries(W + "/sample.rar"));
check("the archive dispatcher refuses a rar with CapabilityError('archive-extras')",
      rar.error instanceof caps.CapabilityError && rar.error.capability === "archive-extras",
      rar.error ? `${rar.error.name}: ${rar.message}` : "it resolved");
const seven = await attempt(() => archive.listEntries(W + "/sample.7z"));
check("the archive dispatcher refuses a 7z with CapabilityError('archive-extras')",
      seven.error instanceof caps.CapabilityError && seven.error.capability === "archive-extras",
      seven.error ? `${seven.error.name}: ${seven.message}` : "it resolved");

const mislabelled = await attempt(() => archive.listEntries(W + "/sample-mislabelled.cbr"));
check("a .cbr whose bytes are really a zip is read in-process (mislabelled archives still work)",
      !mislabelled.error && mislabelled.value.length >= 1,
      mislabelled.error ? mislabelled.message : JSON.stringify((mislabelled.value || []).length));
const cbz = await attempt(() => zip.listZipEntries(W + "/sample.cbz"));
check("the in-process zip backend reads a .cbz",
      !cbz.error && cbz.value.length >= 1,
      cbz.error ? cbz.message : JSON.stringify((cbz.value || []).length));
const epub = await attempt(() => archive.listEntries(W + "/sample.epub"));
check("an EPUB is read in-process (it is a zip)",
      !epub.error && epub.value.length >= 1,
      epub.error ? epub.message : JSON.stringify((epub.value || []).length));

const conv = await attempt(() => mobi.convertKindleToEpub(W + "/sample.mobi", "mobi", W + "/out.epub"));
check("Kindle conversion refuses a .mobi with CapabilityError('kindle')",
      conv.error instanceof caps.CapabilityError && conv.error.capability === "kindle",
      conv.error ? `${conv.error.name}: ${conv.message}` : "it resolved");
const kf8 = await attempt(() => mobi.convertKindleToEpub(W + "/sample.azw3", "azw3", W + "/out.azw3.epub"));
check("Kindle conversion refuses a .azw3 with CapabilityError('kindle')",
      kf8.error instanceof caps.CapabilityError && kf8.error.capability === "kindle",
      kf8.error ? `${kf8.error.name}: ${kf8.message}` : "it resolved");

console.log(JSON.stringify({ results, messages }));
"""


def image_only() -> int:
    """Run IMAGE_PROBE inside the built runtime image; return the process exit code."""
    from capability_message import capability_message

    image = os.environ.get("COMPANION_IMAGE", "kavita-companion:test")
    needed = ("sample.rar", "sample.7z", "sample.cbz", "sample.epub", "sample-mislabelled.cbr",
              "sample.mobi", "sample.azw3")
    work = Path(tempfile.mkdtemp(prefix="default-image-"))
    proc = None
    try:
        for name in needed:
            shutil.copy(FIXTURES / name, work / name)
        (work / "probe.mjs").write_text(IMAGE_PROBE)
        proc = subprocess.run(
            ["docker", "run", "--rm", "--user", "1001:1001",
             "-e", "KAVITA_AUTH_KEY=probe", "-e", "PUBLIC_ORIGIN=https://probe",
             "-v", f"{work}:/w", image, "node", "/w/probe.mjs"],
            capture_output=True, text=True)
        payload = json.loads(proc.stdout.strip().splitlines()[-1])
    except (ValueError, IndexError, KeyError):
        print("FAIL  the image probe did not return results", flush=True)
        print(((proc.stdout if proc else "") + (proc.stderr if proc else "")).strip()[-800:], flush=True)
        return 1
    finally:
        shutil.rmtree(work, ignore_errors=True)

    results = [_check(r["name"], r["ok"], r.get("detail", "")) for r in payload["results"]]
    for capability, actual in payload["messages"].items():
        results.append(_check(f"capabilityMessage('{capability}') matches the pinned wording",
                              actual == capability_message(capability), actual))
    print()
    print(f"{sum(results)}/{len(results)} passed")
    return 0 if all(results) else 1


# ---------------------------------------------------------------------------------------------
# The HTTP suite against the running stack (what the test host runs).
# ---------------------------------------------------------------------------------------------

def stack_suite() -> int:
    from capability_message import capability_message
    from harness import app, check, finish, login, upload, wait_pending
    from settings import COMPANION_DB, INCOMING, library_ids

    import sqlite3

    comics, books = library_ids()["Comics"], library_ids()["Books"]
    uploader, admin = login("UPLOADER"), login("ADMIN")
    tag = "".join(secrets.choice("abcdefghjkmnpqrstuvwxyz") for _ in range(6))
    created = []

    def my_uploads(cookie):
        _, body = app("GET", "/api/uploads", cookie)
        return {u["id"]: u for u in body.get("uploads", [])}

    def wait_final(cookie, uid, timeout=120):
        deadline = time.time() + timeout
        while time.time() < deadline:
            u = my_uploads(cookie).get(uid)
            if u and u["status"] not in ("uploading", "checking"):
                return u
            time.sleep(1)
        return my_uploads(cookie).get(uid)

    def send(cookie, filename, data, library_id):
        uid = upload(cookie, filename, data, library_id)
        created.append(uid)
        return uid

    def make_zip(pages=3):
        """A small synthetic zip with unique bytes, so two uploads are never duplicates."""
        import io
        import zipfile
        buf = io.BytesIO()
        with zipfile.ZipFile(buf, "w", zipfile.ZIP_STORED) as archive:
            for index in range(1, pages + 1):
                archive.writestr(f"{index:03d}.jpg", b"\xff\xd8\xff\xe0" + os.urandom(2000))
        return buf.getvalue()

    # --- This file is meaningless on the formats image: refuse to run there rather than "passing" ---
    _, health = app("GET", "/api/health")
    caps = (health or {}).get("capabilities") or {}
    if caps.get("archiveExtras") or caps.get("kindle"):
        print(f"FAIL  this suite runs only against the permissive `runtime` image; the stack reports {caps}")
        print("      run it with: COMPANION_TEST_TARGET=runtime ./tests/run.sh --only test_default_image")
        return 1
    check("the capability endpoint reports 7-Zip absent (archiveExtras)", caps.get("archiveExtras") is False, str(caps))
    check("the capability endpoint reports KindleUnpack absent (kindle)", caps.get("kindle") is False, str(caps))
    check("zip stays present (read in-process)", caps.get("zip") is True, str(caps))

    # --- Refusals: no HTTP status; the row is invalid, the message is capabilityMessage(), the file
    #     never enters the pending area, and the refusal is audited (design §7.5). ---
    refused = []
    for label, filename, fixture, library, capability, ext in (
        ("RAR", f"Default Image Rar {tag}.rar", "sample.rar", comics, "archive-extras", "rar"),
        ("7z", f"Default Image Seven {tag}.7z", "sample.7z", comics, "archive-extras", "7z"),
        ("MOBI", f"Default Image Kindle {tag}.mobi", "sample.mobi", books, "kindle", "mobi"),
        ("AZW3", f"Default Image KF8 {tag}.azw3", "sample.azw3", books, "kindle", "azw3"),
    ):
        uid = send(uploader, filename, (FIXTURES / fixture).read_bytes(), library)
        u = wait_final(uploader, uid)
        check(f"a {label} upload ends as a row with status invalid",
              u and u["status"] == "invalid", str(u))
        check(f"the {label} refusal error is exactly capabilityMessage('{capability}')",
              u and u.get("error") == capability_message(capability), str(u))
        check(f"the refused {label} file never reaches the pending area",
              not (INCOMING / "pending" / f"{uid}.{ext}").exists(), uid)
        refused.append(uid)

    _, activity = app("GET", "/api/admin/activity?action=upload_invalid&limit=200", admin)
    audited = {e["detail"]["id"] for e in activity.get("entries", [])
               if isinstance(e.get("detail"), dict) and "id" in e["detail"]}
    for uid in refused:
        check(f"the refusal of {uid[:8]} is audited as upload_invalid", uid in audited, uid)

    # --- Mislabelled archive: a .cbr whose bytes are really a zip is accepted (content-based, §7.5) ---
    uid = send(uploader, f"Default Image Mislabelled {tag}.cbr",
               (FIXTURES / "sample-mislabelled.cbr").read_bytes(), comics)
    item = wait_pending(admin, uid)
    check("a .cbr whose bytes are really a zip is accepted, not refused by extension",
          item and item.get("inspection", {}).get("unavailable") is None, str(item))

    # --- Permissive formats still work: epub, cbz and pdf (zip is read in-process) ---
    for label, filename, data, library in (
        ("epub", f"Default Image Book {tag}.epub", (FIXTURES / "sample.epub").read_bytes(), books),
        ("cbz", f"Default Image Comic {tag}.cbz", make_zip(), comics),
        ("pdf", f"Default Image Pdf {tag}.pdf", (FIXTURES / "sample.pdf").read_bytes(), books),
    ):
        uid = send(uploader, filename, data, library)
        item = wait_pending(admin, uid)
        check(f"a .{label} upload still reaches the pending area", bool(item), str(item))

    # --- An item whose inspection itself was refused (design §7.6, Review Focus 5) ---
    # A rar/7z comic cannot be uploaded on this image (the completion check refuses it), so make the
    # pending file's bytes need the absent tool *after* a normal, accepted upload: upload a .cb7 whose
    # bytes are really a zip, wait for its inspection, swap in the genuine (synthetic) 7z fixture, and
    # clear the cached inspection so the server re-inspects the new bytes. The re-inspection is then
    # refused, which is the only way to reach Inspection.unavailable.
    seven_id = send(uploader, f"Default Image Unavailable {tag}.cb7", make_zip(), comics)
    if wait_pending(admin, seven_id):
        (INCOMING / "pending" / f"{seven_id}.cb7").write_bytes((FIXTURES / "sample.7z").read_bytes())
        con = sqlite3.connect(str(COMPANION_DB))
        con.execute("UPDATE uploads SET inspection = NULL, cover_path = NULL WHERE id = ?", (seven_id,))
        con.commit()
        con.close()

        def wait_unavailable(timeout=90):
            deadline, item = time.time() + timeout, None
            while time.time() < deadline:
                _, review = app("GET", "/api/review", admin)
                item = next((i for i in review.get("pending", []) if i["id"] == seven_id), None)
                if item and (item.get("inspection") or {}).get("unavailable"):
                    return item
                time.sleep(1)
            return item

        item = wait_unavailable()
        check("a refused inspection records Inspection.unavailable = archive-extras",
              item and (item.get("inspection") or {}).get("unavailable") == "archive-extras", str(item))
        status, body = app("GET", f"/api/review/{seven_id}/page/1", admin)
        check("the preview route's stored-unavailable branch refuses with the actionable message (415)",
              status == 415 and (body or {}).get("error") == capability_message("archive-extras"),
              f"{status} {body}")
    else:
        check("the unavailable-inspection fixture uploads", False, seven_id)

    # --- Clean up: withdraw everything this run left pending ---
    for uid in created:
        app("DELETE", f"/api/uploads/{uid}", uploader)
    leftover = [uid for uid in created if my_uploads(uploader).get(uid, {}).get("status") == "pending"]
    check("test uploads cleaned up", not leftover, str(leftover))

    return finish()


def main() -> int:
    if "--image-only" in sys.argv[1:]:
        return image_only()
    return stack_suite()


if __name__ == "__main__":
    sys.exit(main())
