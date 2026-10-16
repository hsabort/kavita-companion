// The reviewer-only Library view (phase 2, M5): browse/search the Kavita library and a
// "needs metadata" queue that lists series missing key metadata, so a reviewer can find thin
// metadata and jump into the existing review/fix flow. Read-only against Kavita: nothing here
// writes a file, a series or Kavita's metadata.
//
// Cost: every row needs Kavita's own `GET /api/Series/metadata?seriesId=` to know which fields a
// series has (a series' summary/writers/genres/releaseYear live there, not on SeriesDto). To keep a
// browse or queue request cheap we inspect at most MAX_METADATA_LOOKUPS series per request (the
// page size is capped at the same number) and cache each series' signal for SIGNAL_TTL_MS, so
// paging back and forth does not re-call Kavita.
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { currentUser } from "./auth.js";
import { db } from "./db.js";
import * as kavita from "./kavita.js";
import { kavitaSeriesUrl, normalizeSeries } from "./review.js";

const DEFAULT_PAGE_SIZE = 24;
const MAX_PAGE_SIZE = 50;
/** Hard cap on `GET /api/Series/metadata` calls (and rows inspected) per browse/queue request. */
const MAX_METADATA_LOOKUPS = 50;
/** How many metadata lookups run at once, so a 50-series page is not 50 sequential round trips. */
const METADATA_CONCURRENCY = 6;
/** A series' signal changes rarely; cache it briefly so paging and the two sub-views share calls. */
const SIGNAL_TTL_MS = 60_000;

function requireReviewer(request: FastifyRequest, reply: FastifyReply) {
  const user = currentUser(request);
  if (!user) {
    reply.code(401).send({ error: "Not signed in" });
    return null;
  }
  if (!user.isReviewer) {
    reply.code(403).send({ error: "Only Kavita admins can browse the library." });
    return null;
  }
  return user;
}

// ---------- Metadata signal (which key fields a series has) ----------

interface Signal {
  hasSummary: boolean;
  hasWriter: boolean;
  hasGenre: boolean;
  hasYear: boolean;
  releaseYear: number;
  publicationStatus: number;
}

const hasItems = (value: unknown): boolean => Array.isArray(value) && value.length > 0;

/** The lightweight "which fields does this series have" signal, from Kavita's SeriesMetadataDto. */
export function signalFromMetadata(meta: Record<string, unknown>): Signal {
  const year = Number(meta.releaseYear);
  const status = Number(meta.publicationStatus);
  return {
    hasSummary: typeof meta.summary === "string" && meta.summary.trim().length > 0,
    hasWriter: hasItems(meta.writers),
    hasGenre: hasItems(meta.genres),
    hasYear: Number.isFinite(year) && year > 0,
    releaseYear: Number.isFinite(year) && year > 0 ? year : 0,
    publicationStatus: Number.isFinite(status) ? status : 0,
  };
}

/** The key fields a series is missing, in a stable order the UI can rely on. */
export function missingFields(signal: Signal): string[] {
  const missing: string[] = [];
  if (!signal.hasSummary) missing.push("summary");
  if (!signal.hasWriter) missing.push("writer");
  if (!signal.hasGenre) missing.push("genre");
  if (!signal.hasYear) missing.push("year");
  return missing;
}

const signalCache = new Map<number, { at: number; signal: Signal }>();

/** A series' signal, cached for SIGNAL_TTL_MS. `refresh` bypasses the cache. Throws if Kavita does not answer. */
async function signalFor(seriesId: number, refresh = false): Promise<Signal> {
  const hit = signalCache.get(seriesId);
  if (!refresh && hit && Date.now() - hit.at < SIGNAL_TTL_MS) return hit.signal;
  const signal = signalFromMetadata(await kavita.seriesMetadata(seriesId));
  signalCache.set(seriesId, { at: Date.now(), signal });
  return signal;
}

/** Run `fn` over `items` with at most `limit` in flight, preserving order. */
async function mapLimited<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const out = new Array<R>(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    for (let i = next++; i < items.length; i = next++) out[i] = await fn(items[i]!);
  });
  await Promise.all(workers);
  return out;
}

// ---------- Linking a row into the existing review/fix flow ----------

interface PortalMatch {
  pendingUploadId?: string;
  approvedUploadId?: string;
}

/** The series name to match a pending upload by: the file's embedded series, else its file name. */
function pendingSeriesName(row: { filename: string; inspection: string | null }): string {
  try {
    const embedded = row.inspection ? (JSON.parse(row.inspection) as { embedded?: { Series?: string } }).embedded : undefined;
    if (embedded?.Series?.trim()) return embedded.Series;
  } catch {
    /* unreadable inspection: fall back to the file name */
  }
  return row.filename.replace(/\.[^.]+$/, "");
}

/**
 * Which series the portal has a file for, so the Library rows can jump into the review card
 * (a pending upload) or "find an approved file to fix" (an approved upload). Keyed by
 * libraryId + normalised series name; a small, bounded in-memory join over the uploads table.
 */
function portalMatches(): Map<string, PortalMatch> {
  const key = (libraryId: number, name: string) => `${libraryId}|${normalizeSeries(name)}`;
  const matches = new Map<string, PortalMatch>();
  for (const row of db.prepare("SELECT id, library_id, filename, inspection FROM uploads WHERE status = 'pending'")
    .all() as unknown as { id: string; library_id: number; filename: string; inspection: string | null }[]) {
    const name = pendingSeriesName(row);
    if (!name) continue;
    const k = key(row.library_id, name);
    matches.set(k, { ...(matches.get(k) ?? {}), pendingUploadId: row.id });
  }
  // Newest first, and bounded: the match is only a convenience link, never a source of truth.
  for (const row of db.prepare(`SELECT id, library_id, final_path FROM uploads
      WHERE status = 'approved' AND final_path IS NOT NULL ORDER BY reviewed_at DESC LIMIT 1000`)
    .all() as unknown as { id: string; library_id: number; final_path: string }[]) {
    const name = row.final_path.split("/").slice(-2, -1)[0] ?? "";
    if (!name) continue;
    const k = key(row.library_id, name);
    matches.set(k, { ...(matches.get(k) ?? {}), approvedUploadId: row.id });
  }
  return matches;
}

interface RowSource {
  seriesId: number;
  name: string;
  libraryId: number;
  libraryName: string;
  releaseYear?: number;
}

interface LibraryRow {
  seriesId: number;
  name: string;
  libraryId: number;
  libraryName: string;
  releaseYear: number;
  publicationStatus: number;
  hasSummary: boolean;
  hasWriter: boolean;
  hasGenre: boolean;
  hasYear: boolean;
  missing: string[] | null;
  metadataError: boolean;
  kavitaUrl: string;
  review: PortalMatch;
}

async function buildRow(source: RowSource, matches: Map<string, PortalMatch>, refresh = false): Promise<LibraryRow> {
  let signal: Signal | null = null;
  let metadataError = false;
  try {
    signal = await signalFor(source.seriesId, refresh);
  } catch {
    metadataError = true; // one series Kavita cannot describe never fails the whole page
  }
  const releaseYear = signal?.releaseYear || source.releaseYear || 0;
  const review = matches.get(`${source.libraryId}|${normalizeSeries(source.name)}`) ?? {};
  return {
    seriesId: source.seriesId,
    name: source.name,
    libraryId: source.libraryId,
    libraryName: source.libraryName,
    releaseYear,
    publicationStatus: signal?.publicationStatus ?? 0,
    hasSummary: signal?.hasSummary ?? false,
    hasWriter: signal?.hasWriter ?? false,
    hasGenre: signal?.hasGenre ?? false,
    hasYear: signal?.hasYear ?? false,
    // null (not []) when Kavita could not be read, so the UI can say "unknown" instead of "clean".
    missing: signal ? missingFields(signal) : null,
    metadataError,
    kavitaUrl: kavitaSeriesUrl(source.libraryId, source.seriesId),
    review,
  };
}

function pageParams(query: { page?: string; pageSize?: string }) {
  const page = Math.max(1, Math.floor(Number(query.page)) || 1);
  const pageSize = Math.min(Math.max(Math.floor(Number(query.pageSize)) || DEFAULT_PAGE_SIZE, 1), MAX_PAGE_SIZE);
  return { page, pageSize };
}

export function registerLibraryRoutes(app: FastifyInstance) {
  // Browse/search the library. Free text goes through Kavita's own search; an empty search lists a
  // page of a library (or of every library). Each returned row carries a lightweight metadata
  // signal, computed only for this page (see the cost note at the top of this file).
  app.get<{ Querystring: { q?: string; libraryId?: string; page?: string; pageSize?: string; refresh?: string } }>(
    "/api/library/series",
    async (request, reply) => {
      if (!requireReviewer(request, reply)) return;
      const { page, pageSize } = pageParams(request.query);
      const libraryId = Number(request.query.libraryId) || undefined;
      const query = (request.query.q ?? "").trim();
      const refresh = request.query.refresh === "1" || request.query.refresh === "true";

      let sources: RowSource[];
      let hasMore: boolean;
      try {
        if (query) {
          let found = await kavita.searchSeries(query);
          if (libraryId !== undefined) found = found.filter((s) => s.libraryId === libraryId);
          const start = (page - 1) * pageSize;
          sources = found.slice(start, start + pageSize).map((s) => ({
            seriesId: s.seriesId, name: s.name, libraryId: s.libraryId, libraryName: s.libraryName, releaseYear: s.releaseYear,
          }));
          hasMore = start + sources.length < found.length;
        } else {
          const batch = await kavita.seriesPage(libraryId, page, pageSize);
          sources = batch.slice(0, MAX_METADATA_LOOKUPS).map((s) => ({
            seriesId: s.id, name: s.name, libraryId: s.libraryId, libraryName: s.libraryName,
          }));
          hasMore = batch.length === pageSize;
        }
      } catch (err) {
        request.log.warn({ err }, "library browse failed");
        return reply.code(502).send({ error: "Kavita could not be reached. Try again shortly." });
      }

      const matches = portalMatches();
      const rows = await mapLimited(sources, METADATA_CONCURRENCY, (source) => buildRow(source, matches, refresh));
      return { rows, page, pageSize, hasMore, count: rows.length, cap: MAX_METADATA_LOOKUPS, query: query || null, libraryId: libraryId ?? null };
    },
  );

  // The "needs metadata" queue: inspect a bounded page of series and return those missing key fields
  // (summary, writer, genre, year), each with the exact list of what it lacks. `limit` caps how many
  // matches come back; `page`/`pageSize` choose the window of series to scan (Kavita sorts by name).
  app.get<{ Querystring: { libraryId?: string; page?: string; pageSize?: string; limit?: string; refresh?: string } }>(
    "/api/library/incomplete",
    async (request, reply) => {
      if (!requireReviewer(request, reply)) return;
      const { page, pageSize } = pageParams(request.query);
      const limit = Math.min(Math.max(Math.floor(Number(request.query.limit)) || DEFAULT_PAGE_SIZE, 1), MAX_PAGE_SIZE);
      const libraryId = Number(request.query.libraryId) || undefined;
      const refresh = request.query.refresh === "1" || request.query.refresh === "true";

      let batch: kavita.KavitaSeriesListItem[];
      try {
        batch = await kavita.seriesPage(libraryId, page, pageSize);
      } catch (err) {
        request.log.warn({ err }, "library queue failed");
        return reply.code(502).send({ error: "Kavita could not be reached. Try again shortly." });
      }

      const matches = portalMatches();
      const window = batch.slice(0, MAX_METADATA_LOOKUPS);
      const built = await mapLimited(window, METADATA_CONCURRENCY, (s) =>
        buildRow({ seriesId: s.id, name: s.name, libraryId: s.libraryId, libraryName: s.libraryName }, matches, refresh));
      const incomplete = built.filter((row) => row.missing !== null && row.missing.length > 0);
      const rows = incomplete.slice(0, limit);
      // More to see if the series window was full, or if this page alone held more gaps than `limit`.
      const hasMore = batch.length === pageSize || incomplete.length > rows.length;
      return { rows, page, pageSize, limit, scanned: built.length, cap: MAX_METADATA_LOOKUPS, count: rows.length, hasMore, libraryId: libraryId ?? null };
    },
  );
}
