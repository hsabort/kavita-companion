// Safe wrappers around the 7-Zip CLI (7zzs) for reading zip/rar/7z and writing zip.
// Always called with an argument array (no shell). Archives are vetted from their listing
// before anything is extracted: no absolute paths, no "..", no links, sane sizes.
import { execFile } from "node:child_process";
import { createWriteStream } from "node:fs";
import { lstat, mkdir, readdir, rm } from "node:fs/promises";
import { join, relative, resolve, sep } from "node:path";
import { pipeline } from "node:stream/promises";
import { promisify } from "node:util";
import yazl from "yazl";

const run = promisify(execFile);
const SEVEN_ZIP = process.env.SEVEN_ZIP ?? "7zzs";
const MAX_ENTRIES = 20_000;

export class ArchiveError extends Error {}

export interface ArchiveEntry {
  path: string;   // as stored, with "/" separators
  size: number;   // uncompressed bytes
  isDir: boolean;
}

async function sevenZip(args: string[], options: { cwd?: string; maxBuffer?: number; encoding?: "buffer" } = {}) {
  try {
    return await run(SEVEN_ZIP, args, { maxBuffer: options.maxBuffer ?? 64 * 1024 * 1024, cwd: options.cwd, encoding: options.encoding as never });
  } catch (err) {
    const e = err as { stderr?: Buffer | string; message: string };
    throw new ArchiveError(`7-Zip failed: ${String(e.stderr ?? e.message).trim().split("\n").slice(-2).join(" ")}`);
  }
}

/**
 * List entries (-slt: one "Key = value" block per entry). Throws if the archive contains links,
 * absolute paths or ".." components, or more than MAX_ENTRIES entries.
 */
export async function listEntries(archive: string): Promise<ArchiveEntry[]> {
  const { stdout } = await sevenZip(["l", "-slt", "-ba", "-sccUTF-8", "--", archive]);
  const entries: ArchiveEntry[] = [];
  for (const block of String(stdout).split(/\r?\n\r?\n/)) {
    const fields = new Map<string, string>();
    for (const line of block.split(/\r?\n/)) {
      const at = line.indexOf(" = ");
      if (at > 0) fields.set(line.slice(0, at), line.slice(at + 3));
    }
    const path = fields.get("Path");
    if (!path) continue;
    const attributes = fields.get("Attributes") ?? "";
    const normalized = path.replace(/\\/g, "/");
    if (normalized.startsWith("/") || /^[A-Za-z]:/.test(normalized) || normalized.split("/").includes("..")) {
      throw new ArchiveError(`Unsafe path in archive: ${path}`);
    }
    // Unix mode string in Attributes (e.g. "A lrwxrwxrwx") or an explicit link field marks a link.
    if (/\sl[rwx-]{9}/.test(attributes) || fields.get("Symbolic Link") || fields.get("Hard Link")) {
      throw new ArchiveError(`Archive contains a link: ${path}`);
    }
    entries.push({ path: normalized, size: Number(fields.get("Size") ?? 0), isDir: fields.get("Folder") === "+" || attributes.startsWith("D") });
    if (entries.length > MAX_ENTRIES) throw new ArchiveError(`Archive has more than ${MAX_ENTRIES} entries.`);
  }
  return entries;
}

/** Read one entry into memory (small files only: ComicInfo.xml, OPF, a cover image). */
export async function readEntry(archive: string, entryPath: string, maxBytes = 32 * 1024 * 1024): Promise<Buffer> {
  // -spd: treat the name literally, not as a wildcard pattern.
  const { stdout } = await sevenZip(["e", "-so", "-spd", "--", archive, entryPath], { encoding: "buffer", maxBuffer: maxBytes });
  return stdout as unknown as Buffer;
}

/**
 * Extract everything into an empty directory, then verify every extracted item is a plain file or
 * folder inside it. `maxTotalBytes` guards against zip bombs (checked from the listing first).
 */
export async function extractAll(archive: string, intoDir: string, maxTotalBytes: number): Promise<ArchiveEntry[]> {
  const entries = await listEntries(archive);
  const total = entries.reduce((sum, e) => sum + e.size, 0);
  if (total > maxTotalBytes) {
    throw new ArchiveError(`Archive expands to ${(total / 1024 ** 3).toFixed(1)} GB, more than allowed for its size.`);
  }
  await rm(intoDir, { recursive: true, force: true });
  await mkdir(intoDir, { recursive: true });
  await sevenZip(["x", "-y", "-sccUTF-8", `-o${intoDir}`, "--", archive]);
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
