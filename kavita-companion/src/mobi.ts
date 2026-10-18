// Kindle ebooks (MOBI/AZW/AZW3) are the one common book format Kavita can't read — its Book libraries
// take EPUB and PDF only. Rather than refuse them, we convert them to EPUB with KindleUnpack (the
// `mobi` Python package, GPL-3.0) and hand the EPUB to the normal review flow.
//
// DRM-protected books are refused, never stripped: KindleUnpack reports them and we surface a plain
// message. Conversion is best-effort — anything KindleUnpack can't unpack is refused with a reason.
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { copyFile, mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative, sep } from "node:path";
import { createZip } from "./archive.js";
import { CapabilityError, isCapabilityError } from "./capabilities.js";

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
    child.on("error", (err) => {
      clearTimeout(timer);
      // A spawn that fails with ENOENT is a missing tool, not a broken book: KindleUnpack is the
      // optional `kindle` capability, so this raises the message naming the image that carries it
      // (design §7.1, §7.5). Any other spawn failure — and a non-zero exit, below — stays a
      // conversion failure and is reported as a MobiError by the caller.
      reject((err as NodeJS.ErrnoException).code === "ENOENT" ? new CapabilityError("kindle") : err);
    });
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

/** An EPUB KindleUnpack emitted directly (it does this for KF8 books): the best result when present. */
async function findEpub(dir: string): Promise<string | null> {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      const found = await findEpub(full);
      if (found) return found;
    } else if (entry.name.toLowerCase().endsWith(".epub")) {
      return full;
    }
  }
  return null;
}

/**
 * Convert a Kindle ebook at `source` (stored without a file name) into an EPUB at `outFile`. Throws
 * `MobiError` with an uploader-facing message when the book is DRM-protected or can't be unpacked,
 * and `CapabilityError("kindle")` when KindleUnpack is not installed (a missing tool, not a bad book).
 */
export async function convertKindleToEpub(source: string, ext: string, outFile: string): Promise<void> {
  const work = await mkdtemp(join(tmpdir(), "kc-kindle-"));
  try {
    // KindleUnpack picks the format from the file name, and uploads are stored without an extension.
    const input = join(work, `book.${ext}`);
    await copyFile(source, input);
    const outDir = join(work, "unpacked");
    const { output } = await run("mobiunpack", [input, outDir]);

    // KF8 books come out as a finished EPUB; older MOBI6 books come out as an HTML tree we assemble.
    const emitted = await findEpub(outDir);
    if (emitted) {
      await copyFile(emitted, outFile);
      return;
    }
    const root = bookRoot(outDir);
    if (!root) {
      if (/drm|encrypt/i.test(output)) {
        throw new MobiError("This book is DRM-protected, so it can't be converted to EPUB.");
      }
      throw new MobiError("This file couldn't be converted to EPUB.");
    }

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
    if (isCapabilityError(err)) throw err;
    throw new MobiError("This file couldn't be converted to EPUB.");
  } finally {
    await rm(work, { recursive: true, force: true });
  }
}
