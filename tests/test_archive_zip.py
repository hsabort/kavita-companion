#!/usr/bin/env python3
"""The in-process zip backend and the archive dispatcher.

The default image ships no 7-Zip, so a zip — a .cbz, an EPUB, and a mislabelled .cbr/.cb7 whose
bytes are really a zip — must be read in-process. These tests build synthetic archives (never
derived from a real book) and check them two ways: through the running stack for the integration
paths, and by invoking the built `dist/zip.js` directly for the adversarial cases that are cheaper
to pin at the module boundary (a `../` path, an absolute path, a symlink, an entry flood, a zip
bomb, an encrypted archive).

The module checks need the image that `COMPANION_IMAGE` names to have been built from this checkout
(`docker compose build kavita-companion`).

Run: python3 tests/test_archive_zip.py
"""
import json
import pathlib
import secrets
import shutil
import struct
import subprocess
import sys
import tempfile
import zipfile
import zlib

from harness import app, check, finish, login, upload, wait_pending
from settings import MEDIA, env, library_ids

IMAGE = env.get("COMPANION_IMAGE", "kavita-companion:test")

# --- Synthetic archive contents ---------------------------------------------------------------
# A page image is only ever handed to the backend; the bytes never have to be a real JPEG.
def page(seed):
    return b"\xff\xd8\xff\xe0" + seed + b"\x00" * 20_000


PAGES = {"p001.jpg": page(b"a1"), "p002.jpg": page(b"a2"), "p010.jpg": page(b"a10")}


def stored_zip(path, entries):
    """Write `entries` ([name, data] or [ZipInfo, data]) with no compression."""
    with zipfile.ZipFile(path, "w", zipfile.ZIP_STORED) as z:
        for name, data in entries:
            z.writestr(name, data)


def symlink_info(name):
    """A zip entry whose Unix mode marks it as a symbolic link (Python can't write one directly)."""
    info = zipfile.ZipInfo(name)
    info.create_system = 3  # UNIX
    info.external_attr = 0o120777 << 16  # S_IFLNK | rwxrwxrwx
    return info


def encrypted_zip(name, data):
    """A minimal traditional-encryption stored zip (Python's zipfile can't write one).

    The flag is set and the file data carries the 12-byte ZipCrypto header, so the sizes stay
    self-consistent and a reader that only lists entries can still see it is encrypted.
    """
    name_b = name.encode()
    crc = zlib.crc32(data) & 0xFFFFFFFF
    local = struct.pack("<IHHHHHIIIHH", 0x04034B50, 20, 0x0001, 0, 0, 0, crc, len(data) + 12, len(data), len(name_b), 0) + name_b
    body = b"\x00" * 12 + data
    central = struct.pack("<IHHHHHHIIIHHHHHII", 0x02014B50, 20, 20, 0x0001, 0, 0, 0, crc, len(data) + 12, len(data),
                          len(name_b), 0, 0, 0, 0, 0, 0) + name_b
    eocd = struct.pack("<IHHHHIIH", 0x06054B50, 0, 0, 1, 1, len(central), len(local) + len(body), 0)
    return local + body + central + eocd


def build_archives(work):
    """Write every synthetic archive (and the originals to compare against) into `work`."""
    stored_zip(work / "mislabelled.cbr", list(PAGES.items()))
    for name, data in PAGES.items():
        (work / name).write_bytes(data)
    # Not an archive at all: only the RAR marker, so `isZip` must say no.
    (work / "notzip.bin").write_bytes(b"Rar!\x1a\x07\x00" + b"\x00" * 16)
    stored_zip(work / "escape.cbz", [("../escape.jpg", page(b"evil")), ("p1.jpg", page(b"ok"))])
    stored_zip(work / "abs.cbz", [("/abs.jpg", page(b"evil")), ("p1.jpg", page(b"ok"))])
    stored_zip(work / "symlink.cbz", [(symlink_info("link.jpg"), b"../../etc/passwd"), ("p1.jpg", page(b"ok"))])
    with zipfile.ZipFile(work / "flood.zip", "w", zipfile.ZIP_STORED) as z:
        for i in range(20_001):
            z.writestr(f"f{i:05}.jpg", b"x")
    bomb = work / "bomb.zip"
    with zipfile.ZipFile(bomb, "w", zipfile.ZIP_DEFLATED) as z:
        z.writestr("big.jpg", b"\x00" * 200_000)  # declares 200 KB from ~200 bytes of data
    (work / "encrypted.zip").write_bytes(encrypted_zip("secret.jpg", page(b"secret")))
    # A zip whose entries use "\" separators (some Windows tools write them): the listing normalises
    # them to "/", so readZipEntry must find the same path the listing reported.
    stored_zip(work / "backslash.cbz", [("dir\\p1.jpg", page(b"bs1")), ("p2.jpg", page(b"bs2"))])
    (work / "bs-p1.jpg").write_bytes(page(b"bs1"))
    # Neither zip nor rar/7z magic: the dispatcher must call this invalid, not ask for the formats image.
    (work / "garbage.bin").write_bytes(b"not an archive, not a zip, not a rar or 7z container" + b"\x00" * 32)


# --- The module probe -------------------------------------------------------------------------
# Runs inside the built image, where /app/dist and /app/node_modules are, and prints one JSON
# object of check results. It imports the built modules directly, so it exercises the real backend.
PROBE = r"""
import { pathToFileURL } from "node:url";
import { existsSync, readFileSync, statSync } from "node:fs";

const results = [];
const check = (name, ok, detail = "") => results.push({ name, ok: !!ok, detail: String(detail) });
async function attempt(fn) {
  try { return { value: await fn() }; }
  catch (err) {
    return { error: err, message: String(err && err.message), archiveError: err instanceof archive.ArchiveError };
  }
}

let zip, archive;
try {
  zip = await import(pathToFileURL("/app/dist/zip.js").href);
  archive = await import(pathToFileURL("/app/dist/archive.js").href);
} catch (err) {
  check("the in-process zip backend loads (dist/zip.js)", false, err && err.message);
  console.log(JSON.stringify({ results }));
  process.exit(0);
}
check("the in-process zip backend loads (dist/zip.js)", true);

const W = "/w";

check("isZip recognises a zip by its magic bytes", (await zip.isZip(W + "/mislabelled.cbr")) === true);
check("isZip says no to a rar", (await zip.isZip(W + "/notzip.bin")) === false);

const listed = await attempt(() => zip.listZipEntries(W + "/mislabelled.cbr"));
if (listed.error) {
  check("listZipEntries lists the pages in stored order", false, listed.message);
} else {
  const paths = listed.value.map((e) => e.path);
  check("listZipEntries lists the pages in stored order",
        JSON.stringify(paths) === JSON.stringify(["p001.jpg", "p002.jpg", "p010.jpg"]), JSON.stringify(paths));
  check("listZipEntries returns {path,size,isDir}",
        listed.value.every((e) => typeof e.path === "string" && typeof e.size === "number" && e.isDir === false),
        JSON.stringify(listed.value));
  check("listZipEntries reports the uncompressed size",
        listed.value[0] && listed.value[0].size === statSync(W + "/p001.jpg").size,
        String(listed.value[0] && listed.value[0].size));
}

const dispatched = await attempt(() => archive.listEntries(W + "/mislabelled.cbr"));
check("the dispatcher reads a mislabelled .cbr whose bytes are a zip",
      !dispatched.error && dispatched.value.length === 3,
      dispatched.error ? dispatched.message : JSON.stringify((dispatched.value || []).map((e) => e.path)));
if (!dispatched.error) {
  const ordered = archive.pageImages(dispatched.value).map((e) => e.path);
  check("the backend's entries sort into reading order (page 2 before page 10)",
        JSON.stringify(ordered) === JSON.stringify(["p001.jpg", "p002.jpg", "p010.jpg"]), JSON.stringify(ordered));
}

const esc = await attempt(() => zip.listZipEntries(W + "/escape.cbz"));
check("listZipEntries refuses a '../' path as 'Unsafe path'",
      esc.archiveError === true && /Unsafe path/.test(esc.message || ""), JSON.stringify(esc));
const abs = await attempt(() => zip.listZipEntries(W + "/abs.cbz"));
check("listZipEntries refuses an absolute path as 'Unsafe path'",
      abs.archiveError === true && /Unsafe path/.test(abs.message || ""), JSON.stringify(abs));
const link = await attempt(() => zip.listZipEntries(W + "/symlink.cbz"));
check("listZipEntries refuses a symlink entry",
      link.archiveError === true && /link/i.test(link.message || ""), JSON.stringify(link));
const flood = await attempt(() => zip.listZipEntries(W + "/flood.zip"));
check("listZipEntries enforces the 20000-entry cap",
      flood.archiveError === true && /20000/.test(flood.message || ""), JSON.stringify(flood));
const enc = await attempt(() => zip.listZipEntries(W + "/encrypted.zip"));
check("listZipEntries refuses an encrypted zip with a clear message",
      enc.archiveError === true && /encrypt/i.test(enc.message || ""), JSON.stringify(enc));

const bomb = await attempt(() => zip.extractZip(W + "/bomb.zip", W + "/out-bomb", 1000));
check("extractZip refuses a declared expansion over the cap",
      bomb.archiveError === true && /expands to/.test(bomb.message || ""), JSON.stringify(bomb));
check("extractZip writes nothing when the cap is exceeded", !existsSync(W + "/out-bomb"));

const ok = await attempt(() => zip.extractZip(W + "/mislabelled.cbr", W + "/out-ok", 10_000_000));
check("extractZip extracts every page byte-identical",
      !ok.error && ok.value.length === 3 && readFileSync(W + "/out-ok/p001.jpg").equals(readFileSync(W + "/p001.jpg")),
      ok.error ? ok.message : String(ok.value && ok.value.length));

const escX = await attempt(() => zip.extractZip(W + "/escape.cbz", W + "/out-escape", 10_000_000));
check("extractZip refuses an unsafe archive", escX.archiveError === true, JSON.stringify(escX));
check("extractZip writes nothing outside the destination",
      !existsSync(W + "/out-escape") && !existsSync(W + "/escape.jpg") && !existsSync("/escape.jpg"));

const read = await attempt(() => zip.readZipEntry(W + "/mislabelled.cbr", "p001.jpg"));
check("readZipEntry reads one entry's bytes",
      !read.error && read.value.equals(readFileSync(W + "/p001.jpg")),
      read.error ? read.message : String(read.value && read.value.length));
const capped = await attempt(() => zip.readZipEntry(W + "/mislabelled.cbr", "p001.jpg", 10));
check("readZipEntry enforces its byte cap",
      capped.archiveError === true && /larger/i.test(capped.message || ""), JSON.stringify(capped));

const bs = await attempt(() => zip.listZipEntries(W + "/backslash.cbz"));
check("listZipEntries normalises a backslash-separated name to '/'",
      !bs.error && bs.value.map((e) => e.path).includes("dir/p1.jpg"),
      bs.error ? bs.message : JSON.stringify((bs.value || []).map((e) => e.path)));
const bsRead = await attempt(() => zip.readZipEntry(W + "/backslash.cbz", "dir/p1.jpg"));
check("readZipEntry finds an entry whose name used backslash separators",
      !bsRead.error && bsRead.value.equals(readFileSync(W + "/bs-p1.jpg")),
      bsRead.error ? bsRead.message : String(bsRead.value && bsRead.value.length));

const junk = await attempt(() => archive.listEntries(W + "/garbage.bin"));
check("the dispatcher calls a non-archive 'not a valid archive', not a capability refusal",
      junk.archiveError === true && /not a valid archive/.test(junk.message || ""), JSON.stringify(junk));

console.log(JSON.stringify({ results }));
"""


def module_checks(work):
    """Run the probe in the built image; return [(name, ok, detail), ...]."""
    (work / "probe.mjs").write_text(PROBE)
    proc = subprocess.run(
        ["docker", "run", "--rm", "--user", "1001:1001", "-v", f"{work}:/w", IMAGE, "node", "/w/probe.mjs"],
        capture_output=True, text=True)
    try:
        payload = json.loads(proc.stdout.strip().splitlines()[-1])
        return [(r["name"], r["ok"], r.get("detail", "")) for r in payload["results"]]
    except (ValueError, IndexError, KeyError):
        output = (proc.stdout + proc.stderr).strip()[-600:]
        return [("the in-process zip backend loads (dist/zip.js)", False, output)]


def stack_checks(work):
    """The integration paths: a mislabelled .cbr is read, an unsafe zip is refused."""
    admin = login("ADMIN")
    uploader = login("UPLOADER")
    comics = library_ids()["Comics"]
    tag = "".join(secrets.choice("abcdefghjkmnpqrstuvwxyz") for _ in range(6))
    uploaded = []

    id_cbr = upload(uploader, f"Kc2 Mislabelled {tag}.cbr", (work / "mislabelled.cbr").read_bytes(), comics)
    id_escape = upload(uploader, f"Kc2 Escape {tag}.cbz", (work / "escape.cbz").read_bytes(), comics)
    uploaded += [id_cbr, id_escape]

    item = wait_pending(admin, id_cbr)
    inspection = (item or {}).get("inspection", {})
    check("a .cbr whose bytes are a zip is accepted and its pages are listed",
          inspection.get("pages") == 3, str(inspection))

    escape = wait_pending(admin, id_escape)
    check("a zip with a '../' path is refused by inspection",
          any("Unsafe path" in w for w in (escape or {}).get("warnings", [])), str(escape))
    check("nothing was written outside the work area",
          not (MEDIA / "comics" / "escape.jpg").exists() and not (MEDIA / "escape.jpg").exists())

    for uid in uploaded:
        app("DELETE", f"/api/uploads/{uid}", uploader)


def main():
    work = pathlib.Path(tempfile.mkdtemp(prefix="archive-zip-"))
    try:
        build_archives(work)
        for name, ok, detail in module_checks(work):
            check(name, ok, detail)
        stack_checks(work)
    finally:
        shutil.rmtree(work, ignore_errors=True)
    sys.exit(finish())


if __name__ == "__main__":
    main()
