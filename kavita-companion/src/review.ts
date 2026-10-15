// Admin review queue: inspect pending uploads, correct names and metadata, approve them into a
// library (as a background job) or reject them with a reason.
//
// Approval always produces a clean file: comic archives (cbz/cbr/cb7/zip/rar/7z) are repacked as
// CBZ with a ComicInfo.xml holding the approved values; EPUBs get their OPF metadata updated; PDFs
// are only renamed. Fields the admin leaves blank keep the file's own value.
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { constants as fsConstants } from "node:fs";
import { copyFile, mkdir, readdir, readFile, rename, rm, rmdir, stat, statfs, writeFile } from "node:fs/promises";
import { dirname, extname, join, relative, resolve, sep } from "node:path";
import { pipeline } from "node:stream/promises";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { createZip, extractAll, naturalCompare, pageImages, type ArchiveEntry } from "./archive.js";
import { currentUser, type SessionUser } from "./auth.js";
import { config } from "./config.js";
import { audit, db } from "./db.js";
import { type FileKind, type Inspection, inspectFile, inspectInBackground, isInspecting, kindOf, removeCover } from "./inspect.js";
import * as kavita from "./kavita.js";
import {
  AGE_RATINGS, COMICINFO_FIELDS, type Metadata, type MetadataField,
  opfPathFromContainer, readComicInfo, writeComicInfo, writeEpubMetadata,
} from "./metadata.js";
import { getUpload, type UploadRow } from "./uploads.js";

const WORK_DIR = join(config.incomingDir, "work");
const GB = 1024 ** 3;

const q = {
  pending: db.prepare("SELECT * FROM uploads WHERE status = 'pending' ORDER BY owner_name, created_at"),
  recent: db.prepare(`SELECT * FROM uploads WHERE status IN ('approving', 'approved', 'fixing', 'rejected')
    ORDER BY COALESCE(reviewed_at, updated_at) DESC LIMIT 40`),
  searchApproved: db.prepare(`SELECT * FROM uploads WHERE status IN ('approved', 'fixing') AND final_path IS NOT NULL
    AND (filename LIKE ? ESCAPE '\\' OR final_path LIKE ? ESCAPE '\\') ORDER BY reviewed_at DESC LIMIT 50`),
  byStatus: db.prepare("SELECT * FROM uploads WHERE status = ?"),
  claim: db.prepare("UPDATE uploads SET status = ?, updated_at = ? WHERE id = ? AND status = ?"),
  queueApproval: db.prepare(`UPDATE uploads SET approval_plan = ?, review_error = NULL, reviewed_by = ?, updated_at = ?
    WHERE id = ?`),
  approved: db.prepare(`UPDATE uploads SET status = 'approved', final_path = ?, final_sha256 = ?, stored_path = NULL,
    error = NULL, review_error = NULL, library_id = ?, library_name = ?, reviewed_by = ?, reviewed_at = ?, updated_at = ?,
    kavita_status = 'waiting', kavita_series_id = NULL, kavita_note = NULL, kavita_since = ?, kavita_rescanned = 0
    WHERE id = ?`),
  fixed: db.prepare(`UPDATE uploads SET status = 'approved', final_path = ?, final_sha256 = ?, review_error = NULL,
    library_id = ?, library_name = ?, updated_at = ?,
    kavita_status = 'waiting', kavita_series_id = NULL, kavita_note = NULL, kavita_since = ?, kavita_rescanned = 0
    WHERE id = ?`),
  fixFailed: db.prepare("UPDATE uploads SET status = 'approved', review_error = ?, updated_at = ? WHERE id = ?"),
  // Approved files whose presence in Kavita isn't confirmed yet (including ones approved before this check existed).
  toConfirm: db.prepare(`SELECT * FROM uploads WHERE status = 'approved' AND final_path IS NOT NULL
    AND (kavita_status IS NULL OR kavita_status = 'waiting') ORDER BY reviewed_at DESC LIMIT 50`),
  confirmed: db.prepare(`UPDATE uploads SET kavita_status = 'confirmed', kavita_series_id = ?, kavita_note = NULL WHERE id = ?`),
  stillWaiting: db.prepare(`UPDATE uploads SET kavita_status = 'waiting', kavita_since = ?, kavita_rescanned = ? WHERE id = ?`),
  missing: db.prepare(`UPDATE uploads SET kavita_status = 'missing', kavita_note = ? WHERE id = ?`),
  recheck: db.prepare(`UPDATE uploads SET kavita_status = 'waiting', kavita_note = NULL, kavita_since = ?, kavita_rescanned = 0
    WHERE id = ? AND status = 'approved'`),
  approvalFailed: db.prepare("UPDATE uploads SET status = 'pending', review_error = ?, updated_at = ? WHERE id = ?"),
  rejected: db.prepare(`UPDATE uploads SET status = 'rejected', error = ?, reviewed_by = ?, reviewed_at = ?,
    updated_at = ? WHERE id = ?`),
  restored: db.prepare(`UPDATE uploads SET status = 'pending', error = NULL, reviewed_by = NULL, reviewed_at = NULL,
    updated_at = ? WHERE id = ? AND status = 'rejected' AND stored_path IS NOT NULL`),
  expiredRejections: db.prepare(`SELECT id, stored_path, cover_path FROM uploads
    WHERE status = 'rejected' AND stored_path IS NOT NULL AND reviewed_at < ?`),
  forgetFile: db.prepare("UPDATE uploads SET stored_path = NULL, cover_path = NULL, updated_at = ? WHERE id = ?"),
};

class ReviewError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}

function requireReviewer(request: FastifyRequest, reply: FastifyReply): SessionUser | null {
  const user = currentUser(request);
  if (!user) {
    reply.code(401).send({ error: "Not signed in" });
    return null;
  }
  if (!user.isReviewer) {
    reply.code(403).send({ error: "Only Kavita admins can review uploads." });
    return null;
  }
  return user;
}

// ---------- Names and paths ----------

/**
 * One path segment (folder or file name) that is safe on any filesystem: no separators, no
 * control or Windows-reserved characters, no leading dots, not "." or "..". Null if nothing is left.
 */
export function safeSegment(input: string): string | null {
  let s = input.normalize("NFC").replace(/[\u0000-\u001f\u007f<>:"/\\|?*]/g, " ");
  // Leading dots/spaces (hidden files, "../.." remnants) and trailing dots/spaces (invalid on Windows).
  s = s.replace(/\s+/g, " ").replace(/^[. ]+/, "").replace(/[. ]+$/, "");
  while (Buffer.byteLength(s) > 200) s = s.slice(0, -1);
  return s && s !== "." && s !== ".." ? s : null;
}

function splitName(filename: string): { base: string; ext: string } {
  const dot = filename.lastIndexOf(".");
  return dot <= 0 ? { base: filename, ext: "" } : { base: filename.slice(0, dot), ext: filename.slice(dot + 1).toLowerCase() };
}

/** What an approved file of this kind is saved as. Comic archives always become CBZ. */
const targetExtension = (kind: FileKind) => (kind === "comic" ? "cbz" : kind);

/** Kavita path (/data/comics/Saga) -> companion path (/media/comics/Saga). Null if outside /data. */
function toLocalPath(kavitaPath: string): string | null {
  const prefix = config.kavitaDataPrefix.replace(/\/$/, "") + "/";
  if (!kavitaPath.startsWith(prefix)) return null;
  return resolve(config.mediaDir, kavitaPath.slice(prefix.length));
}

function toKavitaPath(localPath: string): string {
  return config.kavitaDataPrefix.replace(/\/$/, "") + "/" + relative(config.mediaDir, localPath).split(sep).join("/");
}

const isInside = (child: string, parent: string) => child.startsWith(parent.endsWith(sep) ? parent : parent + sep);
const exists = (path: string) => stat(path).then(() => true, () => false);

// ---------- What the review screen shows ----------

const normalizeSeries = (s: string) =>
  s.toLowerCase().replace(/\(\d{4}\)/g, "").replace(/^the\s+/, "").replace(/[^a-z0-9]+/g, "");

/** A number Kavita's parser actually found (it uses large negative values for "none"). */
const parsedNumber = (n: number | undefined) => (n !== undefined && n > -1000 ? String(n) : undefined);

const defaultsCache = new Map<string, { defaults: Metadata; warnings: string[] }>();

async function defaultsFor(row: UploadRow, inspection: Inspection, libraryType: number) {
  const cached = defaultsCache.get(row.id);
  if (cached) return cached;
  const parsed = await kavita.parseName(row.filename, libraryType).catch(() => null);
  const embedded = inspection.embedded;
  const fromName: Metadata = {
    Series: parsed?.seriesName || undefined,
    Number: parsedNumber(parsed?.minChapterNumber),
    Volume: parsedNumber(parsed?.minVolumeNumber),
  };
  // Embedded metadata wins (Kavita would use it anyway); the file name fills the gaps.
  const defaults: Metadata = { ...fromName, ...embedded };
  if (!defaults.Series) defaults.Series = safeSegment(splitName(row.filename).base) ?? "Unsorted";

  const warnings: string[] = [];
  if (inspection.problem) warnings.push(inspection.problem);
  if (embedded.Series && fromName.Series && normalizeSeries(embedded.Series) !== normalizeSeries(fromName.Series)) {
    warnings.push(`The metadata inside the file says series "${embedded.Series}", but the file name suggests "${fromName.Series}". Check which is right.`);
  }
  if (inspection.kind === "comic" && !inspection.hasEmbeddedMetadata) {
    warnings.push("No metadata inside the file; it will be added on approval from the values below.");
  }
  if (embedded.PageCount && inspection.pages !== null && Number(embedded.PageCount) !== inspection.pages) {
    warnings.push(`The metadata says ${embedded.PageCount} pages but the file has ${inspection.pages}; it will be corrected.`);
  }
  const result = { defaults, warnings };
  defaultsCache.set(row.id, result);
  return result;
}

async function reviewItem(row: UploadRow, libraryTypes: Map<number, number>) {
  const inspection = row.inspection ? (JSON.parse(row.inspection) as Inspection) : null;
  if (!inspection) inspectInBackground(row.id);
  const base = {
    id: row.id,
    filename: row.filename,
    size: row.size,
    uploader: row.owner_name,
    libraryId: row.library_id,
    libraryName: row.library_name,
    kind: kindOf(row.ext),
    targetExtension: targetExtension(kindOf(row.ext)),
    createdAt: row.created_at,
    reviewError: row.review_error,
    inspecting: !inspection || isInspecting(row.id),
  };
  if (!inspection) return { ...base, inspection: null, defaults: null, warnings: [] };
  const { defaults, warnings } = await defaultsFor(row, inspection, libraryTypes.get(row.library_id) ?? 0);
  return {
    ...base,
    inspection: { pages: inspection.pages, hasCover: inspection.hasCover, hasEmbeddedMetadata: inspection.hasEmbeddedMetadata },
    embedded: inspection.embedded,
    defaults,
    warnings,
  };
}

/** Kavita's page for a series (Kavita's own route: /library/<libraryId>/series/<seriesId>). */
export const kavitaSeriesUrl = (libraryId: number, seriesId: number) =>
  `${config.kavitaPublicUrl.replace(/\/$/, "")}/library/${libraryId}/series/${seriesId}`;

function decisionItem(row: UploadRow) {
  return {
    id: row.id,
    filename: row.filename,
    uploader: row.owner_name,
    status: row.status,
    note: row.error,
    reviewError: row.review_error,
    reviewedBy: row.reviewed_by,
    reviewedAt: row.reviewed_at ?? row.updated_at,
    updatedAt: row.updated_at,
    finalPath: row.final_path ? toKavitaPath(row.final_path) : null,
    canRestore: row.status === "rejected" && !!row.stored_path,
    canFix: row.status === "approved" && !!row.final_path,
    kavitaStatus: row.kavita_status,
    kavitaNote: row.kavita_note,
    kavitaUrl: row.kavita_status === "confirmed" && row.kavita_series_id ? kavitaSeriesUrl(row.library_id, row.kavita_series_id) : null,
  };
}

// ---------- Approval: validate now, do the work in the background ----------

interface ApproveInput {
  libraryId: number;
  seriesName: string;
  filename: string;
  metadata?: Partial<Record<string, string>>;
}

interface ApprovalPlan {
  libraryId: number;
  libraryName: string;
  seriesName: string;      // as shown to the admin (existing series' Kavita name, or the new one)
  newSeries: boolean;
  seriesDir: string;       // companion path
  destination: string;     // companion path of the final file
  metadata: Metadata;      // non-empty overrides only
}

const FIELD_LIMITS: Partial<Record<MetadataField, number>> = { Summary: 20_000, Web: 2_000 };

function cleanMetadata(input: ApproveInput["metadata"]): Metadata {
  const out: Metadata = {};
  for (const field of COMICINFO_FIELDS) {
    if (field === "PageCount") continue; // always taken from the file itself
    const value = input?.[field];
    if (typeof value !== "string" || !value.trim()) continue;
    const trimmed = value.trim().replace(/\u0000/g, "");
    if (trimmed.length > (FIELD_LIMITS[field] ?? 500)) throw new ReviewError(400, `${field} is too long.`);
    if (field === "Year" && !/^\d{4}$/.test(trimmed)) throw new ReviewError(400, "Year must be four digits, like 1968.");
    if ((field === "Month" || field === "Day") && !/^\d{1,2}$/.test(trimmed)) throw new ReviewError(400, `${field} must be a number.`);
    if (field === "AgeRating" && !AGE_RATINGS.includes(trimmed)) throw new ReviewError(400, "Choose an age rating from the list.");
    out[field] = trimmed;
  }
  return out;
}

type JobMode = "approve" | "fix";

/** The file a job starts from: the pending upload (approve) or the file already in the library (fix). */
function sourceOf(row: UploadRow, mode: JobMode): { path: string | null; ext: string } {
  if (mode === "approve") return { path: row.stored_path, ext: row.ext };
  return { path: row.final_path, ext: (row.final_path ? extname(row.final_path).slice(1) : row.ext).toLowerCase() };
}

async function planApproval(row: UploadRow, input: ApproveInput, mode: JobMode = "approve"): Promise<ApprovalPlan> {
  const source = sourceOf(row, mode);
  const library = (await kavita.librariesCached()).find((l) => l.id === input.libraryId);
  if (!library?.folders[0]) throw new ReviewError(400, "Choose a library.");
  const libraryRoot = toLocalPath(library.folders[0]);
  if (!libraryRoot) throw new ReviewError(500, `Library folder ${library.folders[0]} is outside ${config.kavitaDataPrefix}.`);

  const seriesName = safeSegment(input.seriesName);
  if (!seriesName) throw new ReviewError(400, "Enter a series name.");
  // The extension is decided by the file's kind, whatever was typed.
  const base = safeSegment(splitName(input.filename.trim()).base) ?? safeSegment(input.filename);
  if (!base) throw new ReviewError(400, "Enter a file name.");
  const filename = `${base}.${targetExtension(kindOf(source.ext))}`;

  // Existing series (any capitalisation): use the folder Kavita already has for it.
  const existing = (await kavita.seriesInLibrary(library.id)).find(
    (s) => s.name.localeCompare(seriesName, undefined, { sensitivity: "accent" }) === 0,
  );
  const seriesDir = (existing && toLocalPath(existing.folderPath)) || join(libraryRoot, seriesName);
  if (!isInside(seriesDir, libraryRoot)) throw new ReviewError(400, "That series folder is outside the library.");
  const destination = join(seriesDir, filename);
  if (!isInside(destination, seriesDir)) throw new ReviewError(400, "Invalid file name.");
  // A fix may write back over the file it is fixing; anything else must not be overwritten.
  if (await exists(destination) && !(mode === "fix" && destination === source.path)) {
    throw new ReviewError(409, `"${filename}" already exists in ${library.name} / ${existing?.name ?? seriesName}. Change the file name.`);
  }
  if (!source.path || !(await exists(source.path))) {
    throw new ReviewError(410, mode === "fix" ? "The file is no longer in the library folder." : "The uploaded file is no longer on the server.");
  }

  const metadata = cleanMetadata(input.metadata);
  // The series the file is filed under is also what goes inside it, so Kavita can't disagree.
  metadata.Series = existing?.name ?? seriesName;
  return {
    libraryId: library.id, libraryName: library.name, seriesName: metadata.Series, newSeries: !existing,
    seriesDir, destination, metadata,
  };
}

async function sha256Of(path: string) {
  const hash = createHash("sha256");
  await pipeline(createReadStream(path), hash);
  return hash.digest("hex");
}

async function findFiles(root: string, predicate: (name: string) => boolean, dir = root): Promise<string[]> {
  const out: string[] = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...(await findFiles(root, predicate, full)));
    else if (predicate(entry.name)) out.push(full);
  }
  return out;
}

/**
 * Build the final file at `outFile` from `source`, applying the metadata. With `keepSource` (fixes)
 * the source is never moved or changed, so a failure leaves the library file as it was.
 */
async function buildFinalFile(
  src: { path: string; ext: string }, plan: ApprovalPlan, work: string, outFile: string, keepSource: boolean,
) {
  const kind = kindOf(src.ext);
  const source = src.path;
  const size = (await stat(source)).size;
  if (kind === "pdf") {
    if (keepSource) await copyFile(source, outFile, fsConstants.COPYFILE_FICLONE);
    else await rename(source, outFile);
    return;
  }
  // Leave room for the extracted copy and the new file (same filesystem as the library).
  const s = await statfs(config.incomingDir);
  if (s.bavail * s.bsize < size * 2.2 + config.minFreeDiskGb * GB) {
    throw new ReviewError(507, "Not enough free disk space to repack this file.");
  }
  // Pages are already compressed, so an archive shouldn't expand much; refuse obvious zip bombs.
  const maxExpanded = Math.max(size * 3, size + GB);
  const entries: ArchiveEntry[] = await extractAll(source, work, maxExpanded);

  if (kind === "comic") {
    // Start from the root-most ComicInfo.xml, drop every copy, write one clean one at the root.
    const infoFiles = (await findFiles(work, (n) => n.toLowerCase() === "comicinfo.xml"))
      .sort((a, b) => a.split(sep).length - b.split(sep).length);
    const existingXml = infoFiles[0] ? await readFile(infoFiles[0], "utf8") : null;
    for (const f of infoFiles) await rm(f);
    let base: string | null = existingXml;
    try {
      if (existingXml) readComicInfo(existingXml);
    } catch {
      base = null; // unreadable: replace rather than fail
    }
    const pages = pageImages(entries).length;
    if (!pages) throw new ReviewError(422, "No page images were found in this archive.");
    await writeFile(join(work, "ComicInfo.xml"), writeComicInfo(base, { ...plan.metadata, PageCount: String(pages) }));
    await createZip(work, outFile);
    return;
  }

  // EPUB: update the package document, then repack with "mimetype" first and uncompressed.
  const containerPath = join(work, "META-INF", "container.xml");
  const opfRel = (await exists(containerPath)) ? opfPathFromContainer(await readFile(containerPath, "utf8")) : null;
  if (opfRel) {
    const opfFile = resolve(work, opfRel);
    if (!isInside(opfFile, work)) throw new ReviewError(422, "This EPUB's package path is invalid.");
    await writeFile(opfFile, writeEpubMetadata(await readFile(opfFile, "utf8"), plan.metadata));
  } else if (Object.keys(plan.metadata).some((k) => k !== "Series")) {
    throw new ReviewError(422, "This EPUB has no readable package document, so its metadata can't be changed.");
  }
  await createZip(work, outFile, { first: (await exists(join(work, "mimetype"))) ? ["mimetype"] : [], compressRest: true });
}

async function removeIfEmpty(dir: string) {
  try {
    if ((await readdir(dir)).length === 0) await rmdir(dir);
  } catch { /* not empty or already gone */ }
}

/** One background job: approve a pending upload, or fix a file already in the library. */
async function runJob(id: string) {
  const row = getUpload(id);
  if (!row || !row.approval_plan || (row.status !== "approving" && row.status !== "fixing")) return;
  const mode: JobMode = row.status === "fixing" ? "fix" : "approve";
  const plan = JSON.parse(row.approval_plan) as ApprovalPlan & { actor?: string; previousLibraryId?: number };
  const source = sourceOf(row, mode);
  const work = join(WORK_DIR, id);
  const temporary = join(plan.seriesDir, `.kc-${id}.part`);
  try {
    if (!source.path) throw new ReviewError(410, "The source file is missing.");
    if (await exists(plan.destination) && !(mode === "fix" && plan.destination === source.path)) {
      throw new ReviewError(409, `"${plan.destination.split(sep).pop()}" already exists in that series.`);
    }
    // Written under a temporary name Kavita ignores, then renamed, so a scan never sees half a file.
    await mkdir(plan.seriesDir, { recursive: true });
    await buildFinalFile({ path: source.path, ext: source.ext }, plan, work, temporary, mode === "fix");
    const finalSha = await sha256Of(temporary);
    await rename(temporary, plan.destination); // replaces the old file when a fix keeps the same name
    const now = Date.now();
    if (mode === "approve") {
      await rm(source.path, { force: true });
      await removeCover(row.cover_path);
      q.approved.run(plan.destination, finalSha, plan.libraryId, plan.libraryName, row.reviewed_by, now, now, now, id);
      audit("upload_approved", row.reviewed_by, null, {
        id, filename: row.filename, destination: toKavitaPath(plan.destination), metadata: plan.metadata,
      });
    } else {
      const oldDir = dirname(source.path);
      if (plan.destination !== source.path) {
        await rm(source.path, { force: true });
        await removeIfEmpty(oldDir);
      }
      q.fixed.run(plan.destination, finalSha, plan.libraryId, plan.libraryName, now, now, id);
      audit("upload_fixed", plan.actor ?? null, null, {
        id, from: toKavitaPath(source.path), to: toKavitaPath(plan.destination), metadata: plan.metadata,
      });
      // Let Kavita drop the old location: re-scan its folder, or the whole library if the folder is gone.
      if (oldDir !== plan.seriesDir) {
        if (await exists(oldDir)) await kavita.scanFolder(toKavitaPath(oldDir)).catch(() => undefined);
        else await kavita.scanLibrary(plan.previousLibraryId ?? plan.libraryId).catch(() => undefined);
      }
    }
    defaultsCache.delete(id);
    await kavita.scanFolder(toKavitaPath(plan.seriesDir)).catch(() => undefined); // nightly scan + folder watching are backups
  } catch (err) {
    const message = err instanceof ReviewError || err instanceof Error ? err.message : "Unknown error";
    console.error(`${mode === "fix" ? "Fix" : "Approval"} of ${id} failed`, err);
    if (mode === "approve") {
      q.approvalFailed.run(`Approval failed: ${message} The upload is still waiting for review.`, Date.now(), id);
      audit("upload_approval_failed", row.reviewed_by, null, { id, error: message });
    } else {
      q.fixFailed.run(`Fix failed: ${message} The file in the library was not changed.`, Date.now(), id);
      audit("upload_fix_failed", plan.actor ?? null, null, { id, error: message });
    }
    await rm(temporary, { force: true });
  } finally {
    await rm(work, { recursive: true, force: true });
  }
}

// One approval at a time: repacking is disk- and CPU-heavy.
const queue: string[] = [];
let working = false;
function enqueueApproval(id: string) {
  if (!queue.includes(id)) queue.push(id);
  if (working) return;
  working = true;
  void (async () => {
    while (queue.length) await runJob(queue.shift()!);
    working = false;
  })();
}

/** After a restart, resume approvals that were queued or interrupted. */
export function resumeApprovals() {
  for (const row of q.byStatus.all("approving") as unknown as UploadRow[]) {
    if (row.approval_plan) enqueueApproval(row.id);
    else q.approvalFailed.run("Approval was interrupted. Please approve again.", Date.now(), row.id);
  }
  for (const row of q.byStatus.all("fixing") as unknown as UploadRow[]) {
    if (row.approval_plan) enqueueApproval(row.id);
    else q.fixFailed.run("The fix was interrupted. Please try again.", Date.now(), row.id);
  }
}

// ---------- Is it in Kavita? ----------
// After an approval or fix, check that Kavita lists the exact file (scans are queued and take about a
// minute). If not after 3 minutes, ask for another scan; after 15 minutes, flag it with a note.

const RESCAN_AFTER_MS = 3 * 60_000;
const GIVE_UP_AFTER_MS = 15 * 60_000;

export async function confirmInKavita() {
  const rows = q.toConfirm.all() as unknown as UploadRow[];
  if (!rows.length) return;
  const seriesByLibrary = new Map<number, kavita.KavitaSeries[]>();
  for (const row of rows) {
    const kavitaFile = toKavitaPath(row.final_path!);
    const folder = kavitaFile.slice(0, kavitaFile.lastIndexOf("/"));
    if (!(await exists(row.final_path!))) {
      q.missing.run("The file is no longer in the library folder.", row.id);
      continue;
    }
    if (!seriesByLibrary.has(row.library_id)) {
      seriesByLibrary.set(row.library_id, await kavita.seriesInLibrary(row.library_id).catch(() => []));
    }
    let foundIn: number | null = null;
    for (const series of seriesByLibrary.get(row.library_id)!.filter((s) => s.folderPath === folder)) {
      if ((await kavita.seriesFiles(series.id).catch((): string[] => [])).includes(kavitaFile)) {
        foundIn = series.id;
        break;
      }
    }
    if (foundIn !== null) {
      q.confirmed.run(foundIn, row.id);
      continue;
    }
    const now = Date.now();
    const since = row.kavita_since ?? row.reviewed_at ?? now;
    if (!row.kavita_rescanned && (row.kavita_status === null || now - since > RESCAN_AFTER_MS)) {
      // Not seen yet (or approved before this check existed): ask Kavita to look again, restart the clock.
      await kavita.scanFolder(folder).catch(() => undefined);
      q.stillWaiting.run(now, 1, row.id);
    } else if (now - since > GIVE_UP_AFTER_MS) {
      q.missing.run("Kavita hasn't listed this file after 15 minutes. Run a scan of the library in Kavita, then choose Check again.", row.id);
    } else if (row.kavita_status === null) {
      q.stillWaiting.run(since, row.kavita_rescanned ?? 0, row.id);
    }
  }
}

// ---------- Fixing files already in the library ----------

const fixCovers = new Map<string, string>(); // upload id -> cover extracted from the library file

/** Review-style item for an approved file, with defaults read from the file as it is now. */
async function fixItem(row: UploadRow) {
  const source = sourceOf(row, "fix");
  if (!source.path || !(await exists(source.path))) throw new ReviewError(410, "The file is no longer in the library folder.");
  const { inspection, coverPath } = await inspectFile(`fix-${row.id}`, source.path, source.ext).catch((err: Error) => ({
    inspection: { kind: kindOf(source.ext), pages: null, hasCover: false, embedded: {}, hasEmbeddedMetadata: false,
      problem: `The file couldn't be opened: ${err.message}` } as Inspection,
    coverPath: null as string | null,
  }));
  if (coverPath) fixCovers.set(row.id, coverPath);
  const libraries = await kavita.librariesCached();
  const parsed = await kavita.parseName(row.filename, libraries.find((l) => l.id === row.library_id)?.type ?? 0).catch(() => null);
  // The series it is filed under now (the folder name) is the best default; the file's metadata fills the rest.
  const currentSeries = basenameOf(dirname(source.path));
  const defaults: Metadata = {
    Number: parsedNumber(parsed?.minChapterNumber), Volume: parsedNumber(parsed?.minVolumeNumber),
    ...inspection.embedded, Series: inspection.embedded.Series ?? currentSeries,
  };
  const warnings: string[] = [];
  if (inspection.problem) warnings.push(inspection.problem);
  if (inspection.embedded.Series && normalizeSeries(inspection.embedded.Series) !== normalizeSeries(currentSeries)) {
    warnings.push(`The metadata inside the file says series "${inspection.embedded.Series}", but it is filed under "${currentSeries}".`);
  }
  if (kindOf(source.ext) === "comic" && source.ext !== "cbz") {
    warnings.push(`Saving will repack this .${source.ext} as .cbz with a clean ComicInfo.xml (pages unchanged).`);
  }
  return {
    id: row.id,
    mode: "fix",
    filename: basenameOf(source.path),
    currentFilename: basenameOf(source.path).replace(/\.[^.]+$/, ""),
    currentPath: toKavitaPath(source.path),
    size: (await stat(source.path)).size,
    uploader: row.owner_name,
    libraryId: row.library_id,
    libraryName: row.library_name,
    kind: kindOf(source.ext),
    targetExtension: targetExtension(kindOf(source.ext)),
    createdAt: row.created_at,
    reviewError: row.review_error,
    inspecting: false,
    inspection: { pages: inspection.pages, hasCover: !!coverPath, hasEmbeddedMetadata: inspection.hasEmbeddedMetadata },
    embedded: inspection.embedded,
    defaults,
    warnings,
  };
}

const basenameOf = (path: string) => path.split(sep).pop() ?? path;

// ---------- Cleanup ----------

/** Delete rejected files after config.rejectedRetentionDays (the row and reason stay). */
export async function purgeOldRejections() {
  const cutoff = Date.now() - config.rejectedRetentionDays * 86_400_000;
  for (const { id, stored_path, cover_path } of q.expiredRejections.all(cutoff) as { id: string; stored_path: string; cover_path: string | null }[]) {
    await rm(stored_path, { force: true });
    await removeCover(cover_path);
    q.forgetFile.run(Date.now(), id);
  }
}

// ---------- Routes ----------

export async function registerReviewRoutes(app: FastifyInstance) {
  await mkdir(WORK_DIR, { recursive: true });
  resumeApprovals();

  app.get("/api/review", async (request, reply) => {
    if (!requireReviewer(request, reply)) return;
    const libraries = await kavita.librariesCached();
    const types = new Map(libraries.map((l) => [l.id, l.type]));
    return {
      libraries: libraries.map((l) => ({ id: l.id, name: l.name, type: l.type })),
      pending: await Promise.all((q.pending.all() as unknown as UploadRow[]).map((row) => reviewItem(row, types))),
      recent: (q.recent.all() as unknown as UploadRow[]).map(decisionItem),
      ageRatings: AGE_RATINGS,
      rejectedRetentionDays: config.rejectedRetentionDays,
    };
  });

  app.get<{ Querystring: { libraryId?: string } }>("/api/review/series", async (request, reply) => {
    if (!requireReviewer(request, reply)) return;
    const series = await kavita.seriesInLibrary(Number(request.query.libraryId));
    return { series: series.map((s) => s.name).sort(naturalCompare) };
  });

  // What an existing series already holds, so the screen can warn "you already have #3".
  app.get<{ Querystring: { libraryId?: string; name?: string } }>("/api/review/series-contents", async (request, reply) => {
    if (!requireReviewer(request, reply)) return;
    const name = request.query.name ?? "";
    const match = (await kavita.seriesInLibrary(Number(request.query.libraryId))).find(
      (s) => s.name.localeCompare(name, undefined, { sensitivity: "accent" }) === 0,
    );
    if (!match) return { exists: false };
    const contents = await kavita.seriesContents(match.id);
    return { exists: true, name: match.name, ...contents };
  });

  app.get<{ Params: { id: string }; Querystring: { fix?: string } }>("/api/review/:id/cover", async (request, reply) => {
    if (!requireReviewer(request, reply)) return;
    const row = getUpload(request.params.id);
    const coverPath = request.query.fix ? fixCovers.get(request.params.id) : row?.cover_path;
    if (!coverPath || !(await exists(coverPath))) return reply.code(404).send({ error: "No cover" });
    const ext = coverPath.split(".").pop()!.toLowerCase();
    const types: Record<string, string> = { jpg: "image/jpeg", jpeg: "image/jpeg", png: "image/png", gif: "image/gif", webp: "image/webp", avif: "image/avif" };
    reply.header("Content-Type", types[ext] ?? "application/octet-stream");
    reply.header("Cache-Control", request.query.fix ? "no-store" : "private, max-age=3600");
    return reply.send(createReadStream(coverPath));
  });

  app.get<{ Params: { id: string } }>("/api/review/:id/download", async (request, reply) => {
    if (!requireReviewer(request, reply)) return;
    const row = getUpload(request.params.id);
    if (!row?.stored_path) return reply.code(404).send({ error: "File not found" });
    const ascii = row.filename.replace(/[^\x20-\x7e]|["\\]/g, "_");
    reply.header("Content-Type", "application/octet-stream");
    reply.header("Content-Disposition", `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(row.filename)}`);
    reply.header("Content-Length", String(row.size));
    return reply.send(createReadStream(row.stored_path));
  });

  app.post<{ Params: { id: string }; Body: ApproveInput }>("/api/review/:id/approve", {
    schema: {
      body: {
        type: "object",
        required: ["libraryId", "seriesName", "filename"],
        properties: {
          libraryId: { type: "integer" },
          seriesName: { type: "string", minLength: 1, maxLength: 300 },
          filename: { type: "string", minLength: 1, maxLength: 300 },
          metadata: { type: "object", additionalProperties: { type: "string", maxLength: 20_000 } },
        },
      },
    },
  }, async (request, reply) => {
    const user = requireReviewer(request, reply);
    if (!user) return;
    const row = getUpload(request.params.id);
    if (!row) return reply.code(404).send({ error: "Upload not found" });
    if (row.status !== "pending") return reply.code(409).send({ error: `This upload is already ${row.status}.` });
    let plan: ApprovalPlan;
    try {
      plan = await planApproval(row, request.body);
    } catch (err) {
      if (err instanceof ReviewError) return reply.code(err.status).send({ error: err.message });
      throw err;
    }
    if (q.claim.run("approving", Date.now(), row.id, "pending").changes !== 1) {
      return reply.code(409).send({ error: "Someone else is already reviewing this upload." });
    }
    q.queueApproval.run(JSON.stringify(plan), user.username, Date.now(), row.id);
    enqueueApproval(row.id);
    return reply.code(202).send({
      ok: true, queued: true, destination: toKavitaPath(plan.destination), series: plan.seriesName, newSeries: plan.newSeries,
    });
  });

  // Approved files, for finding something to fix.
  app.get<{ Querystring: { q?: string } }>("/api/review/approved", async (request, reply) => {
    if (!requireReviewer(request, reply)) return;
    const term = `%${(request.query.q ?? "").trim().replace(/[\\%_]/g, (c) => "\\" + c)}%`;
    return { items: (q.searchApproved.all(term, term) as unknown as UploadRow[]).map(decisionItem) };
  });

  app.get<{ Params: { id: string } }>("/api/review/:id/fix", async (request, reply) => {
    if (!requireReviewer(request, reply)) return;
    const row = getUpload(request.params.id);
    if (!row || row.status !== "approved") return reply.code(404).send({ error: "Only approved files can be fixed." });
    try {
      return { item: await fixItem(row), libraries: (await kavita.librariesCached()).map((l) => ({ id: l.id, name: l.name, type: l.type })) };
    } catch (err) {
      if (err instanceof ReviewError) return reply.code(err.status).send({ error: err.message });
      throw err;
    }
  });

  app.post<{ Params: { id: string }; Body: ApproveInput }>("/api/review/:id/fix", {
    schema: {
      body: {
        type: "object",
        required: ["libraryId", "seriesName", "filename"],
        properties: {
          libraryId: { type: "integer" },
          seriesName: { type: "string", minLength: 1, maxLength: 300 },
          filename: { type: "string", minLength: 1, maxLength: 300 },
          metadata: { type: "object", additionalProperties: { type: "string", maxLength: 20_000 } },
        },
      },
    },
  }, async (request, reply) => {
    const user = requireReviewer(request, reply);
    if (!user) return;
    const row = getUpload(request.params.id);
    if (!row || row.status !== "approved") return reply.code(409).send({ error: "Only approved files can be fixed." });
    let plan: ApprovalPlan;
    try {
      plan = await planApproval(row, request.body, "fix");
    } catch (err) {
      if (err instanceof ReviewError) return reply.code(err.status).send({ error: err.message });
      throw err;
    }
    if (q.claim.run("fixing", Date.now(), row.id, "approved").changes !== 1) {
      return reply.code(409).send({ error: "This file is already being changed." });
    }
    // The plan carries who asked and where the file was, for the audit log and the old folder's rescan.
    db.prepare("UPDATE uploads SET approval_plan = ?, review_error = NULL WHERE id = ?")
      .run(JSON.stringify({ ...plan, actor: user.username, previousLibraryId: row.library_id }), row.id);
    enqueueApproval(row.id);
    return reply.code(202).send({ ok: true, queued: true, destination: toKavitaPath(plan.destination) });
  });

  // Current state of one decided upload (the page follows a fix or the Kavita check with it).
  app.get<{ Params: { id: string } }>("/api/review/:id/state", async (request, reply) => {
    if (!requireReviewer(request, reply)) return;
    const row = getUpload(request.params.id);
    if (!row) return reply.code(404).send({ error: "Upload not found" });
    return { item: decisionItem(row) };
  });

  app.post<{ Params: { id: string } }>("/api/review/:id/recheck", async (request, reply) => {
    if (!requireReviewer(request, reply)) return;
    if (q.recheck.run(Date.now(), request.params.id).changes !== 1) return reply.code(404).send({ error: "Not an approved file." });
    void confirmInKavita().catch(() => undefined);
    return { ok: true };
  });

  app.post<{ Params: { id: string }; Body: { reason: string } }>("/api/review/:id/reject", {
    schema: {
      body: {
        type: "object",
        required: ["reason"],
        properties: { reason: { type: "string", minLength: 1, maxLength: 500 } },
      },
    },
  }, async (request, reply) => {
    const user = requireReviewer(request, reply);
    if (!user) return;
    const row = getUpload(request.params.id);
    if (!row) return reply.code(404).send({ error: "Upload not found" });
    if (q.claim.run("rejecting", Date.now(), row.id, "pending").changes !== 1) {
      return reply.code(409).send({ error: `This upload is already ${row.status}.` });
    }
    const now = Date.now();
    q.rejected.run(request.body.reason.trim(), user.username, now, now, row.id);
    defaultsCache.delete(row.id);
    audit("upload_rejected", user.username, request.ip, { id: row.id, filename: row.filename, reason: request.body.reason });
    return { ok: true };
  });

  app.post<{ Params: { id: string } }>("/api/review/:id/restore", async (request, reply) => {
    const user = requireReviewer(request, reply);
    if (!user) return;
    if (q.restored.run(Date.now(), request.params.id).changes !== 1) {
      return reply.code(409).send({ error: "Only a rejected upload whose file is still kept can be restored." });
    }
    audit("upload_restored", user.username, request.ip, { id: request.params.id });
    return { ok: true };
  });
}
