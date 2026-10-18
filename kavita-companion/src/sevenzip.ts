// The 7-Zip CLI backend (7zzs) for reading rar/7z (and any zip the dispatcher did not handle
// in-process). It needs the optional `archive-extras` capability: a missing binary surfaces as the
// actionable CapabilityError from ./capabilities.ts, never a generic failure.
//
// The safety checks and the post-extraction tree check are the shared ones in ./archive.ts; this
// file only knows how to drive the CLI. Always called with an argument array (no shell).
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { ArchiveError, type ArchiveEntry, checkedEntry, extractVerified } from "./archive.js";

const run = promisify(execFile);
// `||`, not `??`, so a blank SEVEN_ZIP falls back to the PATH default rather than spawning "".
const SEVEN_ZIP = process.env.SEVEN_ZIP || "7zzs";

async function sevenZip(args: string[], options: { cwd?: string; maxBuffer?: number; encoding?: "buffer" } = {}) {
  try {
    return await run(SEVEN_ZIP, args, { maxBuffer: options.maxBuffer ?? 64 * 1024 * 1024, cwd: options.cwd, encoding: options.encoding as never });
  } catch (err) {
    const e = err as NodeJS.ErrnoException & { stderr?: Buffer | string; message: string };
    if (e.code === "ENOENT") {
      // The tool vanished after the boot probe; still refuse with the actionable message.
      const { CapabilityError } = await import("./capabilities.js");
      throw new CapabilityError("archive-extras");
    }
    throw new ArchiveError(`7-Zip failed: ${String(e.stderr ?? e.message).trim().split("\n").slice(-2).join(" ")}`);
  }
}

/**
 * List entries (-slt: one "Key = value" block per entry). Throws if the archive contains links,
 * absolute paths or ".." components, or more than MAX_ENTRIES entries (the shared check).
 */
export async function listSevenZipEntries(archive: string): Promise<ArchiveEntry[]> {
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
    // Unix mode string in Attributes (e.g. "A lrwxrwxrwx") or an explicit link field marks a link.
    const isLink = /\sl[rwx-]{9}/.test(attributes) || !!fields.get("Symbolic Link") || !!fields.get("Hard Link");
    entries.push(checkedEntry({
      path,
      size: Number(fields.get("Size") ?? 0),
      isDir: fields.get("Folder") === "+" || attributes.startsWith("D"),
      isLink,
    }, entries.length));
  }
  return entries;
}

/** Read one entry into memory (small files only: ComicInfo.xml, OPF, a cover image). */
export async function readSevenZipEntry(archive: string, entryPath: string, maxBytes = 32 * 1024 * 1024): Promise<Buffer> {
  // -spd: treat the name literally, not as a wildcard pattern.
  const { stdout } = await sevenZip(["e", "-so", "-spd", "--", archive, entryPath], { encoding: "buffer", maxBuffer: maxBytes });
  return stdout as unknown as Buffer;
}

/** Extract everything into an empty directory, then verify the tree (see extractVerified). */
export async function extractSevenZip(archive: string, intoDir: string, maxTotalBytes: number): Promise<ArchiveEntry[]> {
  const entries = await listSevenZipEntries(archive);
  return extractVerified(entries, intoDir, maxTotalBytes, async (dir) => {
    await sevenZip(["x", "-y", "-sccUTF-8", `-o${dir}`, "--", archive]);
  });
}
