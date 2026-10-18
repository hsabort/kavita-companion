// Archive access for reading comic/book containers and writing a clean zip.
//
// The backend is chosen by magic bytes, not extension: a zip — which includes an EPUB, a .cbz, and
// a mislabelled .cbr/.cb7 whose bytes are really a zip — is read in-process by ./zip.ts and needs no
// external tool. rar/7z dispatch to the 7-Zip CLI in ./sevenzip.ts and need the `archive-extras`
// capability (design §7.1, §7.2).
//
// The safety checks (absolute paths, "..", links, the entry cap, the expansion cap) and the
// post-extraction tree check live here, in one place, and are used by both backends so they cannot
// drift on security (design §7.2, §11). The backends import them from this module, which in turn
// imports the backends to dispatch; every shared binding is used from inside a function, never at
// import time, so the load-time cycle is harmless.
import { createWriteStream } from "node:fs";
import { lstat, mkdir, readdir, rm } from "node:fs/promises";
import { join, relative, resolve, sep } from "node:path";
import { pipeline } from "node:stream/promises";
import yazl from "yazl";
import { extractSevenZip, listSevenZipEntries, readSevenZipEntry } from "./sevenzip.js";
import { extractZip, isZip, listZipEntries, readZipEntry } from "./zip.js";

const MAX_ENTRIES = 20_000;

export class ArchiveError extends Error {}

export interface ArchiveEntry {
  path: string;   // as stored, with "/" separators
  size: number;   // uncompressed bytes
  isDir: boolean;
}

/**
 * Validate one listed entry and shape it for the rest of the app. Shared by both backends so the
 * security checks cannot diverge: reject absolute paths (POSIX or drive-letter) and ".." components,
 * reject links, and stop at MAX_ENTRIES. `listed` is how many entries have already been accepted, so
 * the cap is enforced while listing rather than after the whole archive is in memory.
 */
export function checkedEntry(
  raw: { path: string; size: number; isDir: boolean; isLink?: boolean },
  listed: number,
): ArchiveEntry {
  const normalized = raw.path.replace(/\\/g, "/");
  if (normalized.startsWith("/") || /^[A-Za-z]:/.test(normalized) || normalized.split("/").includes("..")) {
    throw new ArchiveError(`Unsafe path in archive: ${raw.path}`);
  }
  if (raw.isLink) throw new ArchiveError(`Archive contains a link: ${raw.path}`);
  if (listed + 1 > MAX_ENTRIES) throw new ArchiveError(`Archive has more than ${MAX_ENTRIES} entries.`);
  return { path: normalized, size: raw.size, isDir: raw.isDir };
}

/** Refuse an archive whose declared contents expand past the caller's budget (zip bombs). */
export function checkExpansion(entries: ArchiveEntry[], maxTotalBytes: number): void {
  const total = entries.reduce((sum, e) => sum + e.size, 0);
  if (total > maxTotalBytes) {
    throw new ArchiveError(`Archive expands to ${(total / 1024 ** 3).toFixed(1)} GB, more than allowed for its size.`);
  }
}

/**
 * Extract everything into an empty directory, then verify every extracted item is a plain file or
 * folder inside it. `maxTotalBytes` guards against zip bombs (checked from the listing first). Both
 * backends call this, so the listing-before-extraction order and the tree check are shared too.
 */
export async function extractVerified(
  entries: ArchiveEntry[], intoDir: string, maxTotalBytes: number, extract: (intoDir: string) => Promise<void>,
): Promise<ArchiveEntry[]> {
  checkExpansion(entries, maxTotalBytes);
  await rm(intoDir, { recursive: true, force: true });
  await mkdir(intoDir, { recursive: true });
  await extract(intoDir);
  await verifyTree(intoDir);
  return entries;
}

async function verifyTree(root: string) {
  const rootResolved = resolve(root);
  const walk = async (dir: string): Promise<void> => {
    for (const name of await readdir(dir)) {
      const full = join(dir, name);
      const info = await lstat(full);
      if (!resolve(full).startsWith(rootResolved + sep)) throw new ArchiveError("Extracted file outside work folder.");
      if (info.isSymbolicLink()) throw new ArchiveError(`Archive contained a link: ${relative(root, full)}`);
      if (info.isDirectory()) await walk(full);
      else if (!info.isFile()) throw new ArchiveError(`Archive contained a special file: ${relative(root, full)}`);
    }
  };
  await walk(root);
}

/**
 * Refuse an operation that needs 7-Zip when this image does not carry it (design §7.1). The
 * capability module reads the runtime config, so it is imported lazily: the conformance runner
 * imports this module for `naturalCompare` with no environment set, and must not trip config.
 */
async function requireArchiveExtras(): Promise<void> {
  const { requireCapability } = await import("./capabilities.js");
  requireCapability("archive-extras");
}

/** List entries without extracting: a zip in-process, anything else through 7-Zip. */
export async function listEntries(archive: string): Promise<ArchiveEntry[]> {
  if (await isZip(archive)) return listZipEntries(archive);
  await requireArchiveExtras();
  return listSevenZipEntries(archive);
}

/** Read one entry into memory (small files only: ComicInfo.xml, OPF, a cover image). */
export async function readEntry(archive: string, entryPath: string, maxBytes = 32 * 1024 * 1024): Promise<Buffer> {
  if (await isZip(archive)) return readZipEntry(archive, entryPath, maxBytes);
  await requireArchiveExtras();
  return readSevenZipEntry(archive, entryPath, maxBytes);
}

/** Extract everything into an empty directory and verify the tree (see extractVerified). */
export async function extractAll(archive: string, intoDir: string, maxTotalBytes: number): Promise<ArchiveEntry[]> {
  if (await isZip(archive)) return extractZip(archive, intoDir, maxTotalBytes);
  await requireArchiveExtras();
  return extractSevenZip(archive, intoDir, maxTotalBytes);
}

async function filesUnder(root: string, dir = root): Promise<string[]> {
  const out: string[] = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...(await filesUnder(root, full)));
    else out.push(relative(root, full).split(sep).join("/"));
  }
  return out;
}

/**
 * Create a zip from the contents of `sourceDir`, written with yazl (7-Zip reorders entries when
 * adding to a zip). Entries go in natural order, except `first` (e.g. EPUB's "mimetype"), which
 * is written first and uncompressed as that format requires. By default everything is stored
 * uncompressed: comic pages are already-compressed images, so this is fast and lossless.
 */
export async function createZip(sourceDir: string, outFile: string, options: { first?: string[]; compressRest?: boolean } = {}) {
  await rm(outFile, { force: true });
  const first = options.first ?? [];
  const rest = (await filesUnder(sourceDir)).filter((n) => !first.includes(n)).sort(naturalCompare);
  const zip = new yazl.ZipFile();
  for (const name of first) zip.addFile(join(sourceDir, name), name, { compress: false });
  for (const name of rest) zip.addFile(join(sourceDir, name), name, { compress: !!options.compressRest });
  zip.end();
  await pipeline(zip.outputStream, createWriteStream(outFile));
}

/** Natural sort, matching how Kavita orders pages ("page 2" before "page 10"). */
export const naturalCompare = (a: string, b: string) => a.localeCompare(b, undefined, { numeric: true, sensitivity: "base" });

const IMAGE = /\.(jpe?g|png|gif|webp|avif|bmp|jxl)$/i;
/** Page images in reading order, ignoring macOS resource forks and hidden files. */
export function pageImages(entries: ArchiveEntry[]): ArchiveEntry[] {
  return entries
    .filter((e) => !e.isDir && IMAGE.test(e.path) && !e.path.split("/").some((p) => p.startsWith(".") || p === "__MACOSX"))
    .sort((a, b) => naturalCompare(a.path, b.path));
}
