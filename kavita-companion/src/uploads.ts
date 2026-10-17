// Resumable uploads (tus protocol) into the staging area, plus the checks that run once a file
// is complete. Nothing here touches Kavita's library folders; that happens on approval (M3).
//
// Layout under config.incomingDir:
//   partial/<id>, partial/<id>.json   tus FileStore: uploads in progress
//   pending/<id>.<ext>                complete, checked files waiting for review
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { mkdir, open, rename, rm, stat, statfs } from "node:fs/promises";
import { join } from "node:path";
import { pipeline } from "node:stream/promises";
import { FileStore } from "@tus/file-store";
import { EVENTS, Server } from "@tus/server";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { listEntries } from "./archive.js";
import { currentUser } from "./auth.js";
import { config } from "./config.js";
import { audit, db } from "./db.js";
import { inspectInBackground, removeCover } from "./inspect.js";
import * as kavita from "./kavita.js";
import { KINDLE_EXTENSIONS, MobiError, convertKindleToEpub } from "./mobi.js";
import { notifyUploader } from "./notify.js";

const GB = 1024 ** 3;
const PARTIAL_DIR = join(config.incomingDir, "partial");
const PENDING_DIR = join(config.incomingDir, "pending");
const TUS_PATH = "/files";

// Set by our route handler (overwriting anything the client sent) so tus hooks know who is uploading.
const USER_HEADER = "x-kc-user";

export type DetectedType = "zip" | "rar" | "7z" | "epub" | "pdf" | "mobi";

/** Accepted extensions and the file contents each one may actually contain. */
export const ACCEPTED: Record<string, DetectedType[]> = {
  // Comic archives are often mislabelled (a .cbr that is really a zip); Kavita reads any of them.
  cbz: ["zip", "rar", "7z"],
  cbr: ["zip", "rar", "7z"],
  cb7: ["zip", "rar", "7z"],
  zip: ["zip", "rar", "7z"],
  rar: ["zip", "rar", "7z"],
  "7z": ["zip", "rar", "7z"],
  epub: ["epub"],
  pdf: ["pdf"],
  // Kindle formats — Books libraries only (see onUploadCreate); converted to EPUB on completion.
  mobi: ["mobi"],
  azw: ["mobi"],
  azw3: ["mobi"],
};
export const ACCEPTED_EXTENSIONS = Object.keys(ACCEPTED);

export interface UploadRow {
  id: string;
  owner_id: number;
  owner_name: string;
  filename: string;
  ext: string;
  size: number;
  library_id: number;
  library_name: string;
  status: string;
  detected_type: string | null;
  sha256: string | null;
  stored_path: string | null;
  error: string | null;
  created_at: number;
  updated_at: number;
  final_path: string | null;
  reviewed_by: string | null;
  reviewed_at: number | null;
  inspection: string | null;
  cover_path: string | null;
  approval_plan: string | null;
  review_error: string | null;
  final_sha256: string | null;
  kavita_status: "waiting" | "confirmed" | "missing" | null;
  kavita_series_id: number | null;
  kavita_note: string | null;
  kavita_since: number | null;
  kavita_rescanned: number | null;
}

const q = {
  get: db.prepare("SELECT * FROM uploads WHERE id = ?"),
  insert: db.prepare(`INSERT INTO uploads
    (id, owner_id, owner_name, filename, ext, size, library_id, library_name, status, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'uploading', ?, ?)`),
  touch: db.prepare("UPDATE uploads SET updated_at = ? WHERE id = ?"),
  setStatus: db.prepare("UPDATE uploads SET status = ?, error = ?, updated_at = ? WHERE id = ?"),
  setPending: db.prepare(`UPDATE uploads SET status = 'pending', ext = ?, detected_type = ?, sha256 = ?, stored_path = ?,
    error = NULL, updated_at = ? WHERE id = ?`),
  activeCount: db.prepare("SELECT COUNT(*) AS n FROM uploads WHERE owner_id = ? AND status = 'uploading'"),
  queuedBytes: db.prepare(`SELECT COALESCE(SUM(size), 0) AS total FROM uploads
    WHERE owner_id = ? AND status IN ('uploading', 'checking', 'pending')`),
  inFlightBytes: db.prepare("SELECT COALESCE(SUM(size), 0) AS total FROM uploads WHERE status = 'uploading'"),
  // Matches on the uploaded file's checksum or, for approved ones, the checksum after repacking.
  duplicateCandidates: db.prepare(`SELECT filename, owner_name, status, created_at, final_path FROM uploads
    WHERE (sha256 = ? OR final_sha256 = ?) AND id != ? AND status IN ('pending', 'approving', 'approved')
    ORDER BY created_at`),
  byStatus: db.prepare("SELECT * FROM uploads WHERE status = ?"),
  abandoned: db.prepare("SELECT id FROM uploads WHERE status = 'uploading' AND updated_at < ?"),
  // Uploads the user ended themselves (or that expired) drop off their list after a day.
  mine: db.prepare(`SELECT id, filename, size, library_id, library_name, status, error, created_at, updated_at,
      kavita_status, kavita_series_id
    FROM uploads WHERE owner_id = ?
      AND NOT (status IN ('cancelled', 'withdrawn', 'expired') AND updated_at < ?)
    ORDER BY created_at DESC LIMIT 100`),
};

export const getUpload = (id: string) => q.get.get(id) as UploadRow | undefined;

/** Error shape @tus/server turns into an HTTP response. Body is shown to the uploader. */
function refuse(status_code: number, message: string) {
  return { status_code, body: message };
}

function uploaderFrom(req: Request): { id: number; username: string } {
  const raw = req.headers.get(USER_HEADER);
  if (!raw) throw refuse(401, "Not signed in");
  return JSON.parse(decodeURIComponent(raw)) as { id: number; username: string };
}

function extensionOf(filename: string): string {
  const dot = filename.lastIndexOf(".");
  return dot === -1 ? "" : filename.slice(dot + 1).toLowerCase();
}

const gb = (bytes: number) => `${(bytes / GB).toFixed(1)} GB`;

async function freeDiskBytes(): Promise<number> {
  const s = await statfs(config.incomingDir);
  return s.bavail * s.bsize;
}

const datastore = new FileStore({ directory: PARTIAL_DIR });

export const tus = new Server({
  path: TUS_PATH,
  datastore,
  relativeLocation: true,
  maxSize: config.maxFileGb * GB,
  disableTerminationForFinishedUploads: true,

  // Runs before the upload exists. Everything that can be decided up front is decided here, so a
  // refused upload never transfers a byte.
  async onUploadCreate(req, upload) {
    const user = uploaderFrom(req);
    const filename = (upload.metadata?.filename ?? upload.metadata?.name ?? "").trim();
    const size = upload.size;

    if (upload.sizeIsDeferred || size === undefined) throw refuse(400, "The file size must be known when the upload starts.");
    if (!filename) throw refuse(400, "The upload has no file name.");
    if (filename.length > 255) throw refuse(400, "The file name is too long (255 characters max).");
    const ext = extensionOf(filename);
    if (!ACCEPTED[ext]) {
      throw refuse(415, `.${ext || "?"} files are not accepted. Accepted: ${ACCEPTED_EXTENSIONS.map((e) => "." + e).join(" ")}`);
    }
    if (size === 0) throw refuse(400, "The file is empty.");
    if (size > config.maxFileGb * GB) throw refuse(413, `The file is ${gb(size)}; the limit is ${config.maxFileGb} GB per file.`);

    const libraryId = Number(upload.metadata?.libraryId);
    let library: kavita.KavitaLibrary | undefined;
    try {
      library = (await kavita.librariesCached()).find((l) => l.id === libraryId);
    } catch {
      throw refuse(503, "Kavita is not reachable right now. Try again shortly.");
    }
    if (!library) throw refuse(400, "Choose a library for this upload.");
    if (KINDLE_EXTENSIONS.has(ext) && library.type !== 2) {
      throw refuse(415, ".mobi/.azw/.azw3 books are only accepted in a Books library.");
    }
    const free = await freeDiskBytes();

    // From here to the insert there is no await, so concurrent requests can't both pass the checks.
    const active = (q.activeCount.get(user.id) as { n: number }).n;
    if (active >= config.maxConcurrentPerUser) {
      throw refuse(429, `You already have ${active} uploads in progress. Wait for one to finish (limit ${config.maxConcurrentPerUser}).`);
    }
    const queued = (q.queuedBytes.get(user.id) as { total: number }).total;
    if (queued + size > config.maxPendingGbPerUser * GB) {
      throw refuse(413, `You have ${gb(queued)} waiting for review; this file would exceed your ${config.maxPendingGbPerUser} GB limit. ` +
        "Wait for an admin to review your uploads.");
    }
    const inFlight = (q.inFlightBytes.get() as { total: number }).total;
    if (free - inFlight - size < config.minFreeDiskGb * GB) {
      throw refuse(507, "The server is low on disk space, so uploads are paused. Please tell an admin.");
    }

    const now = Date.now();
    q.insert.run(upload.id, user.id, user.username, filename, ext, size, library.id, library.name, now, now);
    audit("upload_started", user.username, null, { id: upload.id, filename, size, library: library.name });
    return {};
  },

  async onIncomingRequest(_req, uploadId) {
    if (uploadId) q.touch.run(Date.now(), uploadId);
  },

  async onUploadFinish(_req, upload) {
    q.setStatus.run("checking", null, Date.now(), upload.id);
    // Hashing a multi-GB file takes a while; don't hold the client's last request open for it.
    void checkCompletedUpload(upload.id);
    return {};
  },
});

tus.on(EVENTS.POST_TERMINATE, (_req, _res, id) => {
  const row = getUpload(id);
  q.setStatus.run("cancelled", null, Date.now(), id);
  if (row) audit("upload_cancelled", row.owner_name, null, { id, filename: row.filename });
});

/** True when the archive carries an EPUB's required META-INF/container.xml (see detectType). */
async function hasEpubContainer(path: string): Promise<boolean> {
  try {
    const entries = await listEntries(path);
    return entries.some((e) => !e.isDir && e.path.toLowerCase() === "meta-inf/container.xml");
  } catch {
    return false; // not a readable archive
  }
}

async function detectType(path: string): Promise<DetectedType | null> {
  const handle = await open(path, "r");
  try {
    const head = Buffer.alloc(1024);
    const { bytesRead } = await handle.read(head, 0, head.length, 0);
    const b = head.subarray(0, bytesRead);
    if (b.subarray(0, 4).equals(Buffer.from("PK\x03\x04", "binary"))) {
      // EPUB is a zip whose first entry is an uncompressed "mimetype" file saying application/epub+zip
      // (the spec's canonical layout). Many real EPUBs don't follow it exactly — an extra field on the
      // mimetype entry, a deflated member, or a different first entry — and Kavita reads those fine, so
      // fall back to the archive's required container instead of wrongly calling them plain zips.
      const firstName = b.subarray(30, 38).toString("latin1");
      const mimetype = b.subarray(38, 58).toString("latin1");
      if (firstName === "mimetype" && mimetype === "application/epub+zip") return "epub";
      return (await hasEpubContainer(path)) ? "epub" : "zip";
    }
    if (b.subarray(0, 6).equals(Buffer.from("Rar!\x1a\x07", "binary"))) return "rar";
    if (b.subarray(0, 6).equals(Buffer.from([0x37, 0x7a, 0xbc, 0xaf, 0x27, 0x1c]))) return "7z";
    if (b.subarray(0, 1024).includes("%PDF-")) return "pdf";
    // Kindle ebook: a PalmDB with type "BOOK" and creator "MOBI"/"TPZ" (KF8 keeps the same container).
    if (b.subarray(60, 64).equals(Buffer.from("BOOK", "binary"))
        && ["MOBI", "TPZ"].includes(b.subarray(64, 68).toString("latin1"))) return "mobi";
    return null;
  } finally {
    await handle.close();
  }
}

async function sha256Of(path: string): Promise<string> {
  const hash = createHash("sha256");
  await pipeline(createReadStream(path), hash);
  return hash.digest("hex");
}

async function discardPartial(id: string) {
  await rm(join(PARTIAL_DIR, id), { force: true });
  await rm(join(PARTIAL_DIR, `${id}.json`), { force: true });
}

/** Content check, duplicate check, then move into the pending area. */
async function checkCompletedUpload(id: string) {
  const row = getUpload(id);
  if (!row) return;
  const partial = join(PARTIAL_DIR, id);
  try {
    const detected = await detectType(partial);
    if (!detected || !ACCEPTED[row.ext]?.includes(detected)) {
      await discardPartial(id);
      const what = detected ? `a ${detected} file` : "not a recognised comic, book or archive file";
      const message = `This file is ${what}, which doesn't match .${row.ext}. It was discarded.`;
      q.setStatus.run("invalid", message, Date.now(), id);
      audit("upload_invalid", row.owner_name, null, { id, filename: row.filename, detected });
      notifyUploader(row.owner_id, "invalid", `Couldn't accept: ${row.filename}`, message);
      return;
    }

    const sha256 = await sha256Of(partial);
    // An approved file only counts while it's still in the library (it may have been deleted since).
    const candidates = q.duplicateCandidates.all(sha256, sha256, id) as {
      filename: string; owner_name: string; status: string; created_at: number; final_path: string | null;
    }[];
    let dup: (typeof candidates)[number] | undefined;
    for (const c of candidates) {
      if (c.status !== "approved" || (c.final_path && (await stat(c.final_path).then(() => true, () => false)))) {
        dup = c;
        break;
      }
    }
    if (dup) {
      await discardPartial(id);
      const when = new Date(dup.created_at).toISOString().slice(0, 10);
      const state = dup.status === "approved" ? "already in the library" : "already waiting for review";
      const message = `This exact file is ${state} (uploaded as "${dup.filename}" on ${when}). It was discarded.`;
      q.setStatus.run("duplicate", message, Date.now(), id);
      audit("upload_duplicate", row.owner_name, null, { id, filename: row.filename, sha256 });
      notifyUploader(row.owner_id, "duplicate", `Duplicate: ${row.filename}`, message);
      return;
    }

    await mkdir(PENDING_DIR, { recursive: true });
    let ext = row.ext;
    let effective = detected;
    let storedPath = join(PENDING_DIR, `${id}.${row.ext}`);
    if (detected === "mobi") {
      // Convert to EPUB now so review, approval and Kavita all see a normal book.
      storedPath = join(PENDING_DIR, `${id}.epub`);
      try {
        await convertKindleToEpub(partial, row.ext, storedPath);
      } catch (err) {
        await discardPartial(id);
        const message = err instanceof MobiError ? err.message : "This file couldn't be converted to EPUB.";
        q.setStatus.run("invalid", message, Date.now(), id);
        audit("upload_invalid", row.owner_name, null, { id, filename: row.filename, detected });
        notifyUploader(row.owner_id, "invalid", `Couldn't accept: ${row.filename}`, message);
        return;
      }
      ext = "epub";
      effective = "epub";
      await rm(partial, { force: true });
    } else {
      await rename(partial, storedPath);
    }
    await rm(join(PARTIAL_DIR, `${id}.json`), { force: true });
    q.setPending.run(ext, effective, sha256, storedPath, Date.now(), id);
    audit("upload_completed", row.owner_name, null, { id, filename: row.filename, size: row.size, sha256 });
    if (detected === "mobi") audit("upload_converted", row.owner_name, null, { id, filename: row.filename, from: detected, to: "epub" });
    inspectInBackground(id);
  } catch (err) {
    console.error(`Checking upload ${id} failed`, err);
    q.setStatus.run("invalid", "The server could not process this file. Please try again.", Date.now(), id);
  }
}

/** After a restart, finish checks that were interrupted. */
async function resumeInterruptedChecks() {
  for (const row of q.byStatus.all("checking") as unknown as UploadRow[]) {
    // Prefer the recorded path: a book is renamed to its canonical name after inspection, so the
    // original "pending/<id>.<ext>" may no longer exist.
    let pendingPath: string | undefined;
    for (const candidate of [row.stored_path, join(PENDING_DIR, `${row.id}.${row.ext}`)]) {
      if (candidate && await stat(candidate).then(() => true, () => false)) { pendingPath = candidate; break; }
    }
    if (pendingPath && row.sha256) {
      q.setPending.run(row.ext, row.detected_type, row.sha256, pendingPath, Date.now(), row.id);
    } else {
      await checkCompletedUpload(row.id);
    }
  }
}

/** Remove uploads nobody has touched for config.abandonedUploadHours. */
export async function purgeAbandonedUploads() {
  const cutoff = Date.now() - config.abandonedUploadHours * 3_600_000;
  for (const { id } of q.abandoned.all(cutoff) as { id: string }[]) {
    await datastore.remove(id).catch(() => discardPartial(id));
    q.setStatus.run("expired", `No data arrived for ${config.abandonedUploadHours} hours, so the partial upload was removed.`, Date.now(), id);
  }
}

// Fastify streams tus bodies straight through; it must not buffer or parse them.
export async function registerUploadRoutes(app: FastifyInstance) {
  await mkdir(PARTIAL_DIR, { recursive: true });
  await mkdir(PENDING_DIR, { recursive: true });
  await resumeInterruptedChecks();

  app.addContentTypeParser("application/offset+octet-stream", (_request, _payload, done) => done(null));

  async function tusHandler(request: FastifyRequest, reply: FastifyReply) {
    const user = currentUser(request);
    if (!user) return reply.code(401).send({ error: "Not signed in" });
    if (!user.canUpload) return reply.code(403).send({ error: "Your account is read-only, so you can't upload." });
    const { id } = request.params as { id?: string };
    if (id) {
      const row = getUpload(id);
      if (!row || row.owner_id !== user.id) return reply.code(404).send({ error: "Upload not found" });
    }
    // @tus/server builds its Request from rawHeaders, so set the header there (dropping any copy
    // the client sent) as well as in the parsed headers.
    const value = encodeURIComponent(JSON.stringify({ id: user.id, username: user.username }));
    const raw = request.raw.rawHeaders;
    const kept: string[] = [];
    for (let i = 0; i < raw.length; i += 2) {
      if (raw[i]!.toLowerCase() !== USER_HEADER) kept.push(raw[i]!, raw[i + 1]!);
    }
    kept.push(USER_HEADER, value);
    request.raw.rawHeaders.splice(0, raw.length, ...kept);
    request.raw.headers[USER_HEADER] = value;
    reply.hijack();
    await tus.handle(request.raw, reply.raw);
  }
  app.route({ method: ["POST", "OPTIONS"], url: TUS_PATH, handler: tusHandler });
  app.route({ method: ["HEAD", "PATCH", "DELETE", "OPTIONS"], url: `${TUS_PATH}/:id`, handler: tusHandler });

  app.get("/api/libraries", async (request, reply) => {
    const user = currentUser(request);
    if (!user) return reply.code(401).send({ error: "Not signed in" });
    const libs = await kavita.librariesCached();
    return { libraries: libs.map((l) => ({ id: l.id, name: l.name })) };
  });

  app.get("/api/uploads", async (request, reply) => {
    const user = currentUser(request);
    if (!user) return reply.code(401).send({ error: "Not signed in" });
    // An approved file confirmed in Kavita links to its series there.
    const kavitaBase = config.kavitaPublicUrl.replace(/\/$/, "");
    const uploads = (q.mine.all(user.id, Date.now() - 86_400_000) as Record<string, unknown>[]).map(
      ({ kavita_series_id, library_id, ...u }) => ({
        ...u,
        kavita_url: u.kavita_status === "confirmed" && kavita_series_id ? `${kavitaBase}/library/${library_id}/series/${kavita_series_id}` : null,
      }),
    );
    return {
      uploads,
      limits: {
        maxFileGb: config.maxFileGb,
        maxPendingGbPerUser: config.maxPendingGbPerUser,
        maxConcurrentPerUser: config.maxConcurrentPerUser,
        acceptedExtensions: ACCEPTED_EXTENSIONS,
      },
    };
  });

  // Uploader withdraws a file that is still waiting for review (or a stuck in-progress upload).
  app.delete<{ Params: { id: string } }>("/api/uploads/:id", async (request, reply) => {
    const user = currentUser(request);
    if (!user) return reply.code(401).send({ error: "Not signed in" });
    const row = getUpload(request.params.id);
    if (!row || row.owner_id !== user.id) return reply.code(404).send({ error: "Upload not found" });
    if (row.status === "pending") {
      if (row.stored_path) await rm(row.stored_path, { force: true });
      await removeCover(row.cover_path);
      q.setStatus.run("withdrawn", null, Date.now(), row.id);
    } else if (row.status === "uploading") {
      await datastore.remove(row.id).catch(() => discardPartial(row.id));
      q.setStatus.run("cancelled", null, Date.now(), row.id);
    } else {
      return reply.code(409).send({ error: `This upload is ${row.status} and can't be withdrawn.` });
    }
    audit("upload_withdrawn", user.username, request.ip, { id: row.id, filename: row.filename });
    return { ok: true };
  });
}
