// Kindle ebooks (MOBI/AZW/AZW3) are the one common book format Kavita can't read — its Book libraries
// take EPUB and PDF only. Rather than refuse them, we convert them to EPUB with KindleUnpack (the
// `mobi` Python package, GPL-3.0) and hand the EPUB to the normal review flow.
//
// DRM-protected books are refused, never stripped: KindleUnpack reports them and we surface a plain
// message. Conversion is best-effort — anything KindleUnpack can't unpack is refused with a reason.
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative, sep } from "node:path";
import { createZip } from "./archive.js";

/** The Kindle container formats: Kavita can't read them, KindleUnpack can. */
export const KINDLE_EXTENSIONS = new Set(["mobi", "azw", "azw3"]);

/** A refusal we can show the uploader verbatim. */
export class MobiError extends Error {}

/** The EPUB container we add: a stored `mimetype` first, and a META-INF/container.xml for the OPF. */
const CONTAINER_XML = (opf: string) =>
  `<?xml version="1.0" encoding="utf-8"?>\n` +
  `<container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container">` +
  `<rootfiles><rootfile full-path="${opf}" media-type="application/oebps-package+xml"/></rootfiles>` +
  `</container>\n`;

function run(command: string, args: string[], timeoutMs = 5 * 60_000): Promise<{ code: number; output: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ["ignore", "pipe", "pipe"] });
    let output = "";
    const timer = setTimeout(() => child.kill("SIGKILL"), timeoutMs);
    child.stdout.on("data", (chunk) => (output += chunk));
    child.stderr.on("data", (chunk) => (output += chunk));
    child.on("error", (err) => { clearTimeout(timer); reject(err); });
    child.on("close", (code) => { clearTimeout(timer); resolve({ code: code ?? 1, output }); });
  });
}

/** The KindleUnpack output we can turn into an EPUB: the KF8 (mobi8) tree, else the MOBI7 one. */
function bookRoot(work: string): string | null {
  for (const name of ["mobi8", "mobi7"]) {
    const dir = join(work, name);
    if (existsSync(dir)) return dir;
  }
  return null;
}

/** The OPF (package document) inside an unpacked tree, as an archive-relative POSIX path. */
async function findOpf(root: string, dir = root): Promise<string | null> {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      const found = await findOpf(root, full);
      if (found) return found;
    } else if (entry.name.toLowerCase().endsWith(".opf")) {
      return relative(root, full).split(sep).join("/");
    }
  }
  return null;
}

/**
 * Convert a Kindle ebook at `source` into an EPUB at `outFile`. Throws `MobiError` with an
 * uploader-facing message when the book is DRM-protected or can't be unpacked.
 */
export async function convertKindleToEpub(source: string, outFile: string): Promise<void> {
  const work = await mkdtemp(join(tmpdir(), "kc-kindle-"));
  try {
    const { code, output } = await run("mobiunpack", [source, work]);
    if (/drm|encryption/i.test(output)) {
      throw new MobiError("This book is DRM-protected, so it can't be converted to EPUB.");
    }
    if (code !== 0) throw new MobiError("This file couldn't be read as a Kindle book.");
    const root = bookRoot(work);
    if (!root) throw new MobiError("This file couldn't be converted to EPUB.");

    // EPUB needs a stored, first `mimetype` entry and a META-INF/container.xml that points at the OPF.
    await writeFile(join(root, "mimetype"), "application/epub+zip");
    const container = join(root, "META-INF", "container.xml");
    if (!existsSync(container)) {
      const opf = await findOpf(root);
      if (!opf) throw new MobiError("This file couldn't be converted to EPUB.");
      await mkdir(join(root, "META-INF"), { recursive: true });
      await writeFile(container, CONTAINER_XML(opf));
    }
    await createZip(root, outFile, { first: ["mimetype"], compressRest: true });
  } catch (err) {
    if (err instanceof MobiError) throw err;
    throw new MobiError("This file couldn't be converted to EPUB.");
  } finally {
    await rm(work, { recursive: true, force: true });
  }
}
