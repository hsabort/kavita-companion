// Reads a pending upload once (page count, cover image, embedded metadata) and caches the result
// in uploads.inspection, so the review screen can show what's inside a file without reopening it.
import { mkdir, rm, writeFile } from "node:fs/promises";
import { extname, join } from "node:path";
import { listEntries, pageImages, readEntry } from "./archive.js";
import { isCapabilityError, type Capability } from "./capabilities.js";
import { config } from "./config.js";
import { db } from "./db.js";
import { KINDLE_EXTENSIONS } from "./mobi.js";
import { type Metadata, opfPathFromContainer, readComicInfo, readEpubMetadata } from "./metadata.js";

export const COVERS_DIR = join(config.incomingDir, "covers");
export const COMIC_ARCHIVE_EXTENSIONS = ["cbz", "cbr", "cb7", "zip", "rar", "7z"];

export type FileKind = "comic" | "epub" | "pdf";

export interface Inspection {
  kind: FileKind;
  pages: number | null;          // page images (comics)
  hasCover: boolean;
  embedded: Metadata;            // from ComicInfo.xml or the EPUB's OPF
  hasEmbeddedMetadata: boolean;
  pageNames?: string[];          // ordered page image paths inside the archive (comics), for preview
  problem?: string;              // the file couldn't be read properly
  // The format needs an optional tool this image does not carry (design §7.6). `null` when the file
  // is readable here; a `Capability` when reading it was refused for a missing tool. The review UI
  // uses it to disable an action that could only fail, and the preview route returns 415 with the
  // actionable message rather than a generic 404.
  unavailable: Capability | null;
}

export function kindOf(ext: string): FileKind {
  // Kindle formats are converted to EPUB on upload, so downstream they are EPUBs.
  if (ext === "epub" || KINDLE_EXTENSIONS.has(ext)) return "epub";
  if (ext === "pdf") return "pdf";
  return "comic";
}

const IMAGE_MIME: Record<string, string> = {
  jpg: "image/jpeg", jpeg: "image/jpeg", png: "image/png", gif: "image/gif",
  webp: "image/webp", avif: "image/avif", bmp: "image/bmp", jxl: "image/jxl",
};

/** Content type for a page image, by extension. */
export function imageMime(path: string): string {
  return IMAGE_MIME[path.split(".").pop()?.toLowerCase() ?? ""] ?? "application/octet-stream";
}

const q = {
  save: db.prepare("UPDATE uploads SET inspection = ?, cover_path = ? WHERE id = ?"),
  get: db.prepare("SELECT id, ext, stored_path, inspection FROM uploads WHERE id = ?"),
};

const running = new Set<string>();

async function saveCover(id: string, archive: string, entryPath: string): Promise<string | null> {
  try {
    const image = await readEntry(archive, entryPath, 25 * 1024 * 1024);
    if (!image.length) return null;
    await mkdir(COVERS_DIR, { recursive: true });
    const path = join(COVERS_DIR, `${id}${extname(entryPath).toLowerCase() || ".jpg"}`);
    await writeFile(path, image);
    return path;
  } catch {
    return null; // a missing cover is not worth failing the review over
  }
}

export async function inspectFile(id: string, path: string, ext: string): Promise<{ inspection: Inspection; coverPath: string | null }> {
  const kind = kindOf(ext);
  if (kind === "pdf") {
    return { inspection: { kind, pages: null, hasCover: false, embedded: {}, hasEmbeddedMetadata: false, unavailable: null }, coverPath: null };
  }
  const entries = await listEntries(path);
  if (kind === "comic") {
    const pages = pageImages(entries);
    // Prefer a ComicInfo.xml at the archive root; fall back to one in a subfolder.
    const infoEntry = entries
      .filter((e) => !e.isDir && e.path.split("/").pop()!.toLowerCase() === "comicinfo.xml")
      .sort((a, b) => a.path.split("/").length - b.path.split("/").length)[0];
    let embedded: Metadata = {};
    let problem: string | undefined;
    if (infoEntry) {
      try {
        embedded = readComicInfo((await readEntry(path, infoEntry.path, 2 * 1024 * 1024)).toString("utf8"));
      } catch {
        problem = "The ComicInfo.xml inside this file couldn't be read; it will be replaced on approval.";
      }
    }
    if (!pages.length) problem = "No page images were found in this archive.";
    const coverPath = pages[0] ? await saveCover(id, path, pages[0].path) : null;
    return {
      inspection: {
        kind, pages: pages.length, hasCover: !!coverPath, embedded, hasEmbeddedMetadata: !!infoEntry,
        pageNames: pages.map((page) => page.path), problem, unavailable: null,
      },
      coverPath,
    };
  }
  // EPUB
  const container = entries.find((e) => e.path.toLowerCase() === "meta-inf/container.xml");
  const opfPath = container ? opfPathFromContainer((await readEntry(path, container.path, 1024 * 1024)).toString("utf8")) : null;
  let embedded: Metadata = {};
  let problem: string | undefined;
  if (!opfPath || !entries.some((e) => e.path === opfPath)) {
    problem = "This EPUB has no readable package document, so its metadata can't be edited.";
  } else {
    embedded = readEpubMetadata((await readEntry(path, opfPath, 2 * 1024 * 1024)).toString("utf8"));
  }
  const images = pageImages(entries);
  const coverEntry = images.find((e) => /cover/i.test(e.path)) ?? images[0];
  const coverPath = coverEntry ? await saveCover(id, path, coverEntry.path) : null;
  return {
    inspection: { kind, pages: null, hasCover: !!coverPath, embedded, hasEmbeddedMetadata: Object.keys(embedded).length > 0, problem, unavailable: null },
    coverPath,
  };
}

/** Inspect an upload in the background (no-op if already done or running). */
export function inspectInBackground(id: string) {
  if (running.has(id)) return;
  const row = q.get.get(id) as { id: string; ext: string; stored_path: string | null; inspection: string | null } | undefined;
  if (!row?.stored_path || row.inspection) return;
  running.add(id);
  void inspectFile(id, row.stored_path, row.ext)
    .catch((err: Error): { inspection: Inspection; coverPath: null } => {
      // A format that needs a tool this image lacks is not "couldn't be opened": record the
      // capability and its actionable message, so the review UI and the preview route can surface
      // them verbatim (design §7.6) rather than a generic failure.
      const capability = isCapabilityError(err);
      return {
        inspection: {
          kind: kindOf(row.ext), pages: null, hasCover: false, embedded: {}, hasEmbeddedMetadata: false,
          unavailable: capability ? err.capability : null,
          problem: capability ? err.message : `The file couldn't be opened: ${err.message}`,
        },
        coverPath: null,
      };
    })
    .then(({ inspection, coverPath }) => q.save.run(JSON.stringify(inspection), coverPath, id))
    .finally(() => running.delete(id));
}

export const isInspecting = (id: string) => running.has(id);

export async function removeCover(coverPath: string | null) {
  if (coverPath) await rm(coverPath, { force: true });
}
