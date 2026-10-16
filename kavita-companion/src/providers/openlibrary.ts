// Open Library adapter (phase 2, W7): book metadata from https://openlibrary.org (Internet Archive).
//
// Open Library is REST and keyless, but its terms require a truthful, identifying User-Agent (the
// shared client already sends one; PROVIDER_OPENLIBRARY_BASE points it at a fake in tests). Calls:
//   search: GET {base}/search.json?q=<title|isbn:…>&limit=8   -> work candidates
//   fetch:  GET {base}/isbn/{isbn}.json  (an edition)  →  GET {base}/works/{OLID}.json
//           GET {base}/books/{OLID}.json (an edition)  →  GET {base}/works/{OLID}.json
//           GET {base}/works/{OLID}/editions.json       (first edition, for publisher/ISBN/language)
//           GET {base}/authors/{OLID}.json               (author names, best-effort)
//
// Licence: Internet Archive "does not assert any new copyright" and warns existing rights may apply;
// we pass records through with attribution and declare `covers: "none"` — no cover image is ever
// fetched, proxied or written. Rate limit: 1 request/s anonymous (3/s identified), so a 1 s spacing
// (`OPENLIBRARY_MIN_INTERVAL_MS`). See docs/research/R3-books.md.
//
// Mapping: Title; Summary (`description`, an object `{ value }` or a string); Year
// (`first_publish_year` / `first_publish_date` / edition `publish_date`); Writer (`author_name`, else
// the author keys resolved via /authors); Publisher (edition `publishers`); LanguageISO (edition
// `languages`, a MARC/ISO code like `eng`→`en`); Subjects→Genre/Tags (a documented heuristic). ISBN and
// Series/Volume are read defensively but our Metadata field set (and the EPUB writer) has no ISBN slot,
// and Open Library's series data is inconsistent, so ISBN is a documented gap. See docs/architecture.md.
import { config, providerCacheTtlMsFor } from "../config.js";
import type { Metadata, MetadataField } from "../metadata.js";
import { getCachedRecord, putCachedRecord } from "./cache.js";
import { providerFetchJson, plainText, ProviderHttpError } from "./http.js";
import { isoLanguage } from "./language.js";
import { putLink } from "./links.js";
import type { Candidate, FetchedRecord, MatchQuery, Provider } from "./types.js";

export const OPENLIBRARY_ID = "openlibrary";
export const OPENLIBRARY_LABEL = "Open Library";
export const OPENLIBRARY_LICENCE = {
  name: "Internet Archive (no new rights asserted)",
  url: "https://openlibrary.org/developers/api",
};
/** Open Library: 1 request/s anonymous -> a 1 s spacing (the registry also uses it). */
export const OPENLIBRARY_MIN_INTERVAL_MS = 1000;
/** IA asserts no new rights and existing rights may apply; we never fetch or rehost cover images. */
export const OPENLIBRARY_COVERS = "none" as const;

/** ComicInfo fields Open Library can supply (series/volume are inconsistent; ISBN has no slot yet). */
const OPENLIBRARY_FIELDS: MetadataField[] = [
  "Title", "Summary", "Year", "Writer", "Publisher", "Genre", "Tags", "LanguageISO",
];

/** Only ask the search index for the fields we map, so a response stays small (politeness/cost). */
const SEARCH_FIELDS = "key,title,author_name,first_publish_year,publish_date,publisher,isbn,edition_key,language,subject";
const MAX_AUTHORS = 5;

function base(): string {
  return config.openlibraryBaseUrl.replace(/\/+$/, "");
}

/** Spacing for this call (PROVIDER_OPENLIBRARY_MIN_INTERVAL_MS; the tests set it to 0). */
function interval(): number {
  return config.openlibraryMinIntervalMs;
}

// ---------- defensive readings ----------

const str = (value: unknown): string =>
  typeof value === "string" ? value : typeof value === "number" ? String(value) : "";
const obj = (value: unknown): Record<string, unknown> =>
  value && typeof value === "object" ? (value as Record<string, unknown>) : {};
const text = (value: unknown): string => plainText(str(value));

/** A `{ key }`, an array of them, or a bare "/works/OL…" string -> its identifier. */
function refKey(value: unknown): string {
  if (Array.isArray(value)) return refKey(value[0]);
  const o = obj(value);
  if (typeof o.key === "string") return o.key;
  return typeof value === "string" ? value : "";
}

/** An Open Library work id ("OL123W") from a key, path or bare id; "" when there is none. */
function workIdOf(value: unknown): string {
  const match = /(OL\d+W)/i.exec(refKey(value));
  return match?.[1]?.toUpperCase() ?? "";
}

/** An Open Library author id ("OL123A") from a key or bare id. */
function authorIdOf(value: unknown): string {
  const match = /(OL\d+A)/i.exec(refKey(value));
  return match?.[1]?.toUpperCase() ?? "";
}

const isWorkId = (value: string): boolean => /^OL\d+W$/i.test(value.trim());
const isBookId = (value: string): boolean => /^OL\d+M$/i.test(value.trim());
/** ISBN-10 (last char may be X) or ISBN-13, ignoring hyphens/spaces. */
function isIsbn(value: string): boolean {
  const digits = value.replace(/[^0-9Xx]/g, "");
  return /^\d{9}[\dXx]$/.test(digits) || /^\d{13}$/.test(digits);
}
const isbnDigits = (value: string): string => value.replace(/[^0-9Xx]/g, "");

/** A four-digit year from a number or a date string ("September 3, 2018" -> "2018"). */
function yearOf(value: unknown): string | undefined {
  const match = /(\d{4})/.exec(str(value));
  return match ? match[1] : undefined;
}

/** A work/edition `description`, which may be a string or an object `{ type, value }`. */
function descriptionOf(value: unknown): string {
  if (typeof value === "string") return plainText(value);
  const o = obj(value);
  return plainText(str(o.value) || str(o.text));
}

/** The first publisher from an edition's `publishers` list (or a bare string). */
function publisherOf(value: unknown): string {
  if (typeof value === "string") return plainText(value);
  return Array.isArray(value) && value.length ? plainText(str(value[0])) : "";
}

/** The first language from `languages` (`[{ key: "/languages/eng" }]`) normalised to ISO-639-1. */
function languageOf(value: unknown): string | undefined {
  const list = Array.isArray(value) ? value : value ? [value] : [];
  const first = list[0];
  if (first === undefined) return undefined;
  return isoLanguage(refKey(first) || str(first));
}

/**
 * Subjects -> Genre/Tags. A documented heuristic: subjects that look like genres (short, no
 * parenthetical qualifiers, no catalogue codes) become Genre; the rest become Tags. Both are
 * de-duplicated and capped (Open Library subjects are noisy and can number in the hundreds).
 */
function splitSubjects(value: unknown): { genre: string; tags: string } {
  if (!Array.isArray(value)) return { genre: "", tags: "" };
  const seen = new Set<string>();
  const clean: string[] = [];
  for (const item of value) {
    const subject = plainText(str(item));
    const key = subject.toLowerCase();
    if (!subject || seen.has(key)) continue;
    seen.add(key);
    clean.push(subject);
  }
  const genre = clean.filter((s) => s.length <= 40 && !/[(),]/.test(s) && !/\d/.test(s)).slice(0, 8);
  const genreSet = new Set(genre.map((s) => s.toLowerCase()));
  const tags = clean.filter((s) => !genreSet.has(s.toLowerCase())).slice(0, 20);
  return { genre: genre.join(", "), tags: tags.join(", ") };
}

/** Author names embedded in a work/edition (`author_name`), if any. */
function embeddedAuthorNames(...sources: Array<Record<string, unknown>>): string[] {
  const out: string[] = [];
  for (const source of sources) {
    const value = source.author_name;
    const list = Array.isArray(value) ? value : value ? [value] : [];
    for (const item of list) {
      const name = text(item);
      if (name) out.push(name);
    }
  }
  return out;
}

/** Author keys from a work (`authors: [{ author: { key } }]`) or an edition (`authors: [{ key }]`). */
function authorKeysOf(work: Record<string, unknown> | null, edition: Record<string, unknown> | null): string[] {
  const keys: string[] = [];
  const push = (value: unknown) => {
    for (const item of Array.isArray(value) ? value : []) {
      const id = authorIdOf(obj(item).author ?? item);
      if (id && !keys.includes(id)) keys.push(id);
    }
  };
  if (work) push(work.authors);
  if (edition) push(edition.authors);
  return keys;
}

// ---------- HTTP ----------

async function getJson<T>(url: string, signal?: AbortSignal): Promise<T> {
  return providerFetchJson<T>({
    provider: OPENLIBRARY_ID, url, signal, accept: "application/json", minIntervalMs: interval(),
  });
}

// ---------- search ----------

interface OpenLibrarySearch {
  numFound?: number;
  docs?: Array<Record<string, unknown>>;
}

/** Case/punctuation-insensitive key for matching a title. */
function normalizeTitle(value: string): string {
  return plainText(value).toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}

function toCandidate(document: Record<string, unknown>, query: MatchQuery): Candidate {
  const title = text(document.title);
  const year = yearOf(document.first_publish_year) ?? yearOf(document.publish_date);
  const nameEq = !!title && normalizeTitle(title) === normalizeTitle(query.title);
  const nameNear = !nameEq && !!title && !!query.title
    && (normalizeTitle(title).includes(normalizeTitle(query.title))
      || normalizeTitle(query.title).includes(normalizeTitle(title)));
  const yearEq = !!query.year && !!year && year === query.year;

  const band: Candidate["band"] = nameEq && yearEq ? "exact" : nameEq ? "near" : nameNear ? "near" : "loose";
  const score = Math.min(1, (nameEq ? 0.6 : nameNear ? 0.3 : 0) + (yearEq ? 0.4 : 0));

  return {
    provider: OPENLIBRARY_ID, externalId: workIdOf(document.key), title,
    year, publisher: publisherOf(document.publisher) || undefined, score, band,
  };
}

// ---------- fetch ----------

interface OpenLibraryEditions { entries?: Array<Record<string, unknown>> }

/** The first edition of a work (best-effort: it is enrichment for publisher/ISBN/language). */
async function firstEdition(workId: string, signal?: AbortSignal): Promise<Record<string, unknown> | null> {
  try {
    const data = await getJson<OpenLibraryEditions>(`${base()}/works/${workId}/editions.json?limit=1`, signal);
    return data.entries?.[0] ?? null;
  } catch {
    return null; // a missing edition is not fatal — the work still yields title/summary/subjects
  }
}

/** Author names: embedded `author_name`, else the author keys resolved via /authors (best-effort). */
async function authorNames(
  work: Record<string, unknown> | null, edition: Record<string, unknown> | null, signal?: AbortSignal,
): Promise<string> {
  const embedded = embeddedAuthorNames(...[work, edition].filter(Boolean) as Array<Record<string, unknown>>);
  if (embedded.length) return [...new Set(embedded)].join(", ");
  const names: string[] = [];
  for (const id of authorKeysOf(work, edition).slice(0, MAX_AUTHORS)) {
    try {
      const author = await getJson<Record<string, unknown>>(`${base()}/authors/${id}.json`, signal);
      const name = text(author.name);
      if (name && !names.includes(name)) names.push(name);
    } catch {
      // A missing author record is not fatal; skip it rather than fail the whole lookup.
    }
  }
  return names.join(", ");
}

function mapRecord(work: Record<string, unknown> | null, edition: Record<string, unknown> | null, writer: string): Metadata {
  const subjects = splitSubjects(work?.subjects);
  const fields: Metadata = {
    Title: text(work?.title) || text(edition?.title),
    Summary: descriptionOf(work?.description) || descriptionOf(edition?.description),
    Year: yearOf(work?.first_publish_year) ?? yearOf(work?.first_publish_date)
      ?? yearOf(edition?.publish_year) ?? yearOf(edition?.publish_date),
    Writer: writer,
    Publisher: publisherOf(edition?.publishers),
    LanguageISO: languageOf(edition?.languages),
    Genre: subjects.genre,
    Tags: subjects.tags,
  };
  // Drop empty values so the merge step never sees a blank proposal.
  return Object.fromEntries(Object.entries(fields).filter(([, value]) => value)) as Metadata;
}

export function createOpenLibraryProvider(): Provider {
  return {
    id: OPENLIBRARY_ID,
    label: OPENLIBRARY_LABEL,
    licence: OPENLIBRARY_LICENCE,
    capabilities: { media: ["book"], fields: [...OPENLIBRARY_FIELDS] },
    covers: OPENLIBRARY_COVERS,

    async search(_key: string | null, query: MatchQuery, signal?: AbortSignal): Promise<Candidate[]> {
      const url = new URL(`${base()}/search.json`);
      url.searchParams.set("q", query.isbn ? `isbn:${isbnDigits(query.isbn)}` : query.title);
      url.searchParams.set("limit", "8");
      url.searchParams.set("fields", SEARCH_FIELDS);
      const data = await getJson<OpenLibrarySearch>(url.toString(), signal);
      return (data.docs ?? [])
        .map((document) => toCandidate(document ?? {}, query))
        .filter((candidate) => candidate.externalId && candidate.title)
        .sort((a, b) => b.score - a.score);
    },

    async fetch(_key: string | null, externalId: string, signal?: AbortSignal): Promise<FetchedRecord> {
      // Read-through the shared record cache (TTL from config), so a repeat fetch is one call.
      const cached = getCachedRecord(OPENLIBRARY_ID, externalId);
      if (cached) return cached;
      const ref = externalId.trim();
      let edition: Record<string, unknown> | null = null;
      let workId = "";
      if (isWorkId(ref)) {
        workId = ref.toUpperCase();
      } else if (isIsbn(ref)) {
        edition = await getJson<Record<string, unknown>>(`${base()}/isbn/${isbnDigits(ref)}.json`, signal);
        workId = workIdOf(edition.works);
      } else if (isBookId(ref)) {
        edition = await getJson<Record<string, unknown>>(`${base()}/books/${ref.toUpperCase()}.json`, signal);
        workId = workIdOf(edition.works);
      } else {
        workId = workIdOf(ref);
      }
      const work = workId ? await getJson<Record<string, unknown>>(`${base()}/works/${workId}.json`, signal) : null;
      if (!work && !edition) throw new ProviderHttpError("json", `openlibrary: no record for id ${externalId}`);
      if (!edition && workId) edition = await firstEdition(workId, signal);
      const record: FetchedRecord = {
        provider: OPENLIBRARY_ID, externalId, media: "book",
        fields: mapRecord(work, edition, await authorNames(work, edition, signal)),
        licence: OPENLIBRARY_LICENCE,
      };
      putCachedRecord(record, providerCacheTtlMsFor(OPENLIBRARY_ID));
      return record;
    },
  };
}

/** Cheap validity probe: one minimal search through the shared client. */
export async function openlibraryProbe(_provider: Provider, _key: string | null): Promise<{ ok: boolean; detail?: string }> {
  const url = new URL(`${base()}/search.json`);
  // Open Library rejects a bare common word as a search ("Invalid query; ... not allowed: the"),
  // so the probe uses a two-word query it accepts.
  url.searchParams.set("q", "the hobbit");
  url.searchParams.set("limit", "1");
  const data = await getJson<OpenLibrarySearch>(url.toString());
  if (!Array.isArray(data.docs)) throw new ProviderHttpError("json", "openlibrary: probe response had no docs");
  return { ok: true, detail: "openlibrary reachable" };
}

/**
 * Persist a reviewed series -> Open Library work link. `fetch()` has no library/series context, so the
 * review flow calls this when a reviewer confirms a candidate (libraryId 0 = "not yet in Kavita").
 */
export function linkOpenlibrarySeries(libraryId: number | null, seriesName: string, externalId: string): void {
  putLink({ libraryId: libraryId ?? 0, seriesName, provider: OPENLIBRARY_ID, externalId });
}
