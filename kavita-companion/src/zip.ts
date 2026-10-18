// In-process zip reader (yauzl), so the default image needs no 7-Zip to read a .zip/.cbz/.epub or a
// mislabelled .cbr/.cb7 whose bytes are really a zip. yauzl streams entry by entry, so we keep the
// list-then-extract order without loading an archive into memory.
//
// The path/link/entry-cap checks, the expansion cap and the post-extraction tree check are the
// shared ones in ./archive.ts; this file only knows how to enumerate and stream a zip.
import { createWriteStream } from "node:fs";
import { mkdir, open } from "node:fs/promises";
import { dirname, resolve, sep } from "node:path";
import { pipeline } from "node:stream/promises";
import * as yauzl from "yauzl";
import { ArchiveError, type ArchiveEntry, checkedEntry, extractVerified } from "./archive.js";

/** A zip by its magic bytes: a local file header (PK\x03\x04) or an empty archive's EOCD (PK\x05\x06). */
export async function isZip(path: string): Promise<boolean> {
  const handle = await open(path, "r");
  try {
    const head = Buffer.alloc(4);
    const { bytesRead } = await handle.read(head, 0, 4, 0);
    return bytesRead === 4 && head[0] === 0x50 && head[1] === 0x4b
      && ((head[2] === 0x03 && head[3] === 0x04) || (head[2] === 0x05 && head[3] === 0x06));
  } finally {
    await handle.close();
  }
}

/**
 * The entry's name, decoded the way yauzl would but without its own absolute/`..` rejection, so the
 * shared `checkedEntry` (and its message) is what refuses an unsafe archive.
 */
function entryName(entry: yauzl.Entry): string {
  return yauzl.getFileNameLowLevel(entry.generalPurposeBitFlag, entry.fileNameRaw, entry.extraFields, false);
}

/** The Unix mode in the external attributes, when the entry was made on Unix. */
function unixMode(entry: yauzl.Entry): number {
  return (entry.externalFileAttributes >>> 16) & 0xffff;
}

/** A directory: a trailing slash, or the Unix directory bit (S_IFDIR) in the external attributes. */
function isDirectory(entry: yauzl.Entry, name: string): boolean {
  return name.endsWith("/") || (unixMode(entry) & 0xf000) === 0o040000;
}

/** A symbolic link, by the Unix mode (S_IFLNK). Zip stores a link's target as its file data. */
function isSymlink(entry: yauzl.Entry): boolean {
  return (unixMode(entry) & 0xf000) === 0o120000;
}

function asArchiveError(err: unknown): ArchiveError {
  return err instanceof ArchiveError ? err : new ArchiveError(`Could not read zip: ${err instanceof Error ? err.message : String(err)}`);
}

async function openZip(archive: string): Promise<yauzl.ZipFile> {
  try {
    // decodeStrings:false keeps yauzl from rejecting an absolute/".." name itself, so the shared
    // check owns that decision; we decode the name ourselves (entryName).
    return await yauzl.openPromise(archive, { decodeStrings: false });
  } catch (err) {
    throw asArchiveError(err);
  }
}

/** List entries without reading any data, applying the shared safety checks. */
export async function listZipEntries(archive: string): Promise<ArchiveEntry[]> {
  const zipfile = await openZip(archive);
  const entries: ArchiveEntry[] = [];
  try {
    for await (const entry of zipfile.eachEntry()) {
      const name = entryName(entry);
      if (entry.isEncrypted()) throw new ArchiveError(`Archive is encrypted: ${name}`);
      const isDir = isDirectory(entry, name);
      // A directory name carries a trailing slash in the zip; drop it so the shape matches the
      // 7-Zip backend. Keep the raw name when stripping would leave nothing (an entry named "/").
      const clean = isDir ? name.replace(/\/+$/, "") : name;
      entries.push(checkedEntry({
        path: clean || name,
        size: entry.uncompressedSize,
        isDir,
        isLink: isSymlink(entry),
      }, entries.length));
    }
  } catch (err) {
    throw asArchiveError(err);
  }
  return entries;
}

/** Read one entry into memory, with a byte cap (small files only: ComicInfo.xml, OPF, a cover). */
export async function readZipEntry(archive: string, entryPath: string, maxBytes = 32 * 1024 * 1024): Promise<Buffer> {
  const zipfile = await openZip(archive);
  try {
    for await (const entry of zipfile.eachEntry()) {
      if (entryName(entry) !== entryPath.replace(/\\/g, "/")) continue;
      if (entry.isEncrypted()) throw new ArchiveError(`Archive is encrypted: ${entryPath}`);
      if (entry.uncompressedSize > maxBytes) throw new ArchiveError(`Entry ${entryPath} is larger than ${maxBytes} bytes.`);
      const stream = await zipfile.openReadStreamPromise(entry);
      const chunks: Buffer[] = [];
      let total = 0;
      for await (const chunk of stream) {
        total += (chunk as Buffer).length;
        if (total > maxBytes) throw new ArchiveError(`Entry ${entryPath} is larger than ${maxBytes} bytes.`);
        chunks.push(chunk as Buffer);
      }
      return Buffer.concat(chunks);
    }
  } catch (err) {
    throw asArchiveError(err);
  }
  throw new ArchiveError(`Entry not found in archive: ${entryPath}`);
}

/** Extract everything into an empty directory, then verify the tree (see extractVerified). */
export async function extractZip(archive: string, intoDir: string, maxTotalBytes: number): Promise<ArchiveEntry[]> {
  const entries = await listZipEntries(archive);
  return extractVerified(entries, intoDir, maxTotalBytes, (dir) => writeZipEntries(archive, dir));
}

async function writeZipEntries(archive: string, intoDir: string): Promise<void> {
  const root = resolve(intoDir);
  const zipfile = await openZip(archive);
  try {
    for await (const entry of zipfile.eachEntry()) {
      const name = entryName(entry);
      if (entry.isEncrypted()) throw new ArchiveError(`Archive is encrypted: ${name}`);
      // The listing already refused unsafe names; this keeps a file from ever being written outside
      // the destination even if the archive changed between listing and extraction.
      const dest = resolve(root, name);
      if (dest !== root && !dest.startsWith(root + sep)) throw new ArchiveError(`Unsafe path in archive: ${name}`);
      if (isDirectory(entry, name)) {
        await mkdir(dest, { recursive: true });
        continue;
      }
      await mkdir(dirname(dest), { recursive: true });
      await pipeline(await zipfile.openReadStreamPromise(entry), createWriteStream(dest));
    }
  } catch (err) {
    throw asArchiveError(err);
  }
}
