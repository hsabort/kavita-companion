// Hardcover adapter (phase 2, W6): book metadata from https://api.hardcover.app/v1/graphql.
//
// Hardcover is a keyed GraphQL API (Hasura). It needs a free per-install personal access token, sent as
// `Authorization: Bearer <token>`; the token is resolved by the registry from PROVIDER_HARDCOVER_KEY or
// the sealed provider_config row (never shipped). Two calls:
//   search: POST {base}  search(query:, query_type: "Book", per_page:) { results }   -> candidates (Typesense)
//   fetch:  POST {base}  books(where: {id: {_eq: <id>}}, limit: 1) { … }              -> one book
//
// Licence / terms: Hardcover forbids using its data for LLM training and forbids commercial/public
// products using user-owned data; the public catalogue may be shown with attribution. We declare the
// credit as the licence name and `covers: "none"` — no cover image is ever fetched, proxied or written.
// Rate limit: free 5,000/day, 60/min, burst 10 (and *each top-level field counts as a request*), so a
// 1 s spacing (`HARDCOVER_MIN_INTERVAL_MS`) and one folded query per fetch; 429 + Retry-After are
// handled by http.ts. See docs/research/R3-books.md.
//
// Mapping notes: the search document is a Typesense "Book" hit (title, author_names, featured_series,
// featured_series_position, release_year). The by-id fetch reads the `books` row plus its `book_series`
// (featured series + position), `contributions` (author names/roles) and `default_ebook_edition`
// (publisher, language, ISBN, pages). ISBN is read for completeness but our Metadata field set (and the
// EPUB writer) has no ISBN slot yet, so it is deliberately not mapped (documented gap). Every provider
// string is untrusted and runs through plainText. See docs/architecture.md.
import { config, providerCacheTtlMsFor } from "../config.js";
import type { Metadata, MetadataField } from "../metadata.js";
import { getCachedRecord, putCachedRecord } from "./cache.js";
import { providerFetchJson, plainText, ProviderHttpError } from "./http.js";
import { isoLanguage } from "./language.js";
import { putLink } from "./links.js";
import type { Candidate, FetchedRecord, MatchQuery, Provider } from "./types.js";

export const HARDCOVER_ID = "hardcover";
export const HARDCOVER_LABEL = "Hardcover";
export const HARDCOVER_LICENCE = { name: "API Terms", url: "https://hardcover.app/pages/policies" };
/** Hardcover free tier: 60 requests/minute -> a 1 s spacing (the registry also uses it). */
export const HARDCOVER_MIN_INTERVAL_MS = 1000;
/** Hardcover image use needs a DMCA policy; the simplest compliant default is to never fetch covers. */
export const HARDCOVER_COVERS = "none" as const;

/** ComicInfo field names Hardcover can supply (no Genre/Tags: the books row has no clean genre list). */
const HARDCOVER_FIELDS: MetadataField[] = [
  "Title", "Series", "Number", "Volume", "Summary", "Year", "Writer", "Publisher", "LanguageISO",
  "PageCount",
];

function base(): string {
  return config.hardcoverBaseUrl.replace(/\/+$/, "");
}

/** Spacing for this call (PROVIDER_HARDCOVER_MIN_INTERVAL_MS; the tests set it to 0). */
function interval(): number {
  return config.hardcoverMinIntervalMs;
}

// ---------- defensive readings ----------

const str = (value: unknown): string =>
  typeof value === "string" ? value : typeof value === "number" ? String(value) : "";
const obj = (value: unknown): Record<string, unknown> =>
  value && typeof value === "object" ? (value as Record<string, unknown>) : {};
const text = (value: unknown): string => plainText(str(value));

/** A four-digit year from a number or a date string ("2018-03-01" -> "2018"). */
function yearOf(value: unknown): string | undefined {
  const match = /(\d{4})/.exec(str(value));
  return match ? match[1] : undefined;
}

// ---------- GraphQL ----------

interface GraphQlResponse<T> {
  data?: T;
  errors?: Array<{ message?: unknown }>;
}

/** One GraphQL POST with error-in-200 handling and the shared retry/rate-limit policy. */
async function graphql<T>(key: string | null, query: string, variables: Record<string, unknown>, signal?: AbortSignal): Promise<T> {
  const body = await providerFetchJson<GraphQlResponse<T>>({
    provider: HARDCOVER_ID, url: base(), method: "POST", key, signal, accept: "application/json",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ query, variables }),
    minIntervalMs: interval(),
  });
  if (Array.isArray(body.errors) && body.errors.length) {
    throw new ProviderHttpError("http", `hardcover: ${text(body.errors[0]?.message) || "GraphQL error"}`, 200);
  }
  if (!body.data) throw new ProviderHttpError("json", "hardcover: response had no data");
  return body.data;
}

// One selection for both steps; a fetch folds related fields into a single query (each top-level field
// counts against Hardcover's budget, so keep it tight).
const SEARCH_QUERY = `
  query SearchBooks($query: String!, $perPage: Int!) {
    search(query: $query, query_type: "Book", per_page: $perPage, page: 1) { results }
  }
`;

const BOOK_QUERY = `
  query BookById($id: Int!) {
    books(where: { id: { _eq: $id } }, limit: 1) {
      id
      title
      subtitle
      description
      release_date
      release_year
      pages
      book_series { position featured series { name } }
      contributions { contribution author { name } }
      default_ebook_edition {
        isbn_13
        isbn_10
        pages
        publisher { name }
        language { language }
      }
    }
  }
`;

interface HardcoverSearch {
  search?: { results?: unknown };
}
interface HardcoverBooks {
  books?: Array<Record<string, unknown>>;
}

/**
 * Hardcover's Typesense `results` may arrive as an array of hit documents, an array of `{ document }`
 * envelopes, or an object with a `hits`/`documents` array. Normalise all three defensively.
 */
function searchDocuments(results: unknown): Array<Record<string, unknown>> {
  const fromHits = (hits: unknown[]): Array<Record<string, unknown>> =>
    hits.map((hit) => obj(obj(hit).document ?? hit));
  if (Array.isArray(results)) return fromHits(results);
  const o = obj(results);
  if (Array.isArray(o.hits)) return fromHits(o.hits);
  if (Array.isArray(o.documents)) return fromHits(o.documents);
  return [];
}

/** Case/punctuation-insensitive key for matching a title. */
function normalizeTitle(value: string): string {
  return plainText(value).toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}

/**
 * Does a candidate's series name match the query's series hint? The series is only ever a hint for a
 * book search (the title is the key), so this breaks a tie between equally-scored title matches and
 * never changes a candidate's band/score on its own.
 */
function matchesSeries(name: string, query: MatchQuery): boolean {
  const want = normalizeTitle(query.series ?? "");
  const have = normalizeTitle(name);
  if (!want || !have) return false;
  return have === want || have.includes(want) || want.includes(have);
}

/** The featured `book_series` entry (or the first with a position), giving the series name + position. */
function featuredSeries(value: unknown): { name: string; position: string } {
  const entries = (Array.isArray(value) ? value : value ? [value] : []).map(obj);
  const chosen = entries.find((entry) => entry.featured === true && obj(entry.series).name)
    ?? entries.find((entry) => obj(entry.series).name && entry.position !== null && entry.position !== undefined)
    ?? entries.find((entry) => obj(entry.series).name);
  if (!chosen) return { name: "", position: "" };
  return { name: text(obj(chosen.series).name), position: str(chosen.position) };
}

/** Author names from `contributions[]`, preferring the Author/Writer roles; de-duplicated. */
function authorNames(value: unknown): string {
  if (!Array.isArray(value)) return "";
  const primary: string[] = [];
  const other: string[] = [];
  const seen = new Set<string>();
  for (const entry of value) {
    const contribution = obj(entry);
    const name = text(obj(contribution.author).name);
    if (!name || seen.has(name.toLowerCase())) continue;
    seen.add(name.toLowerCase());
    const role = text(contribution.contribution);
    if (!role || /author|writer/i.test(role)) primary.push(name);
    else other.push(name);
  }
  return (primary.length ? primary : other).join(", ");
}

/** The first publisher name from an edition's `publisher { name }`. */
const publisherName = (edition: Record<string, unknown>): string => text(obj(edition.publisher).name);

/** Edition language (`language { language }`, a code or a name) normalised to ISO-639-1. */
const editionLanguage = (edition: Record<string, unknown>): string | undefined =>
  isoLanguage(str(obj(edition.language).language) || edition.language);

function mapBook(book: Record<string, unknown>): Metadata {
  const edition = obj(book.default_ebook_edition);
  const series = featuredSeries(book.book_series);
  const fields: Metadata = {
    Title: text(book.title),
    Series: series.name,
    // A book's position in its series is both its Number and its Volume (the EPUB writer uses Number).
    Number: series.position,
    Volume: series.position,
    Summary: text(book.description),
    Year: yearOf(book.release_year) ?? yearOf(book.release_date),
    Writer: authorNames(book.contributions),
    Publisher: publisherName(edition),
    LanguageISO: editionLanguage(edition),
    PageCount: str(book.pages) || str(edition.pages),
  };
  // Drop empty values so the merge step never sees a blank proposal.
  return Object.fromEntries(Object.entries(fields).filter(([, value]) => value)) as Metadata;
}

function toCandidate(document: Record<string, unknown>, query: MatchQuery): Candidate {
  const title = text(document.title);
  const year = yearOf(document.release_year) ?? yearOf(document.release_date);
  const position = str(document.featured_series_position);
  const nameEq = !!title && normalizeTitle(title) === normalizeTitle(query.title);
  const nameNear = !nameEq && !!title && !!query.title
    && (normalizeTitle(title).includes(normalizeTitle(query.title))
      || normalizeTitle(query.title).includes(normalizeTitle(title)));
  const yearEq = !!query.year && !!year && year === query.year;

  const band: Candidate["band"] = nameEq && yearEq ? "exact" : nameEq ? "near" : nameNear ? "near" : "loose";
  const score = Math.min(1, (nameEq ? 0.6 : nameNear ? 0.3 : 0) + (yearEq ? 0.4 : 0));

  return {
    provider: HARDCOVER_ID, externalId: str(document.id), title,
    year, volume: position || undefined, score, band,
  };
}

export function createHardcoverProvider(): Provider {
  return {
    id: HARDCOVER_ID,
    label: HARDCOVER_LABEL,
    licence: HARDCOVER_LICENCE,
    capabilities: { media: ["book"], fields: [...HARDCOVER_FIELDS] },
    covers: HARDCOVER_COVERS,

    async search(key: string | null, query: MatchQuery, signal?: AbortSignal): Promise<Candidate[]> {
      const term = query.title || query.series || "";
      const data = await graphql<HardcoverSearch>(key, SEARCH_QUERY, { query: term, perPage: 8 }, signal);
      return searchDocuments(data.search?.results)
        .map((document) => ({
          candidate: toCandidate(document, query),
          // The series is a hint: it only breaks a tie between equally-scored title matches.
          seriesHint: matchesSeries(text(obj(document.featured_series).name), query),
        }))
        .filter(({ candidate }) => candidate.externalId && candidate.title)
        .sort((a, b) => b.candidate.score - a.candidate.score || Number(b.seriesHint) - Number(a.seriesHint))
        .map(({ candidate }) => candidate);
    },

    async fetch(key: string | null, externalId: string, signal?: AbortSignal): Promise<FetchedRecord> {
      // Read-through the shared record cache (TTL from config), so a repeat fetch is one call.
      const cached = getCachedRecord(HARDCOVER_ID, externalId);
      if (cached) return cached;
      const id = Number(externalId);
      if (!Number.isInteger(id) || id <= 0) {
        throw new ProviderHttpError("json", `hardcover: invalid book id ${externalId}`);
      }
      const data = await graphql<HardcoverBooks>(key, BOOK_QUERY, { id }, signal);
      const book = data.books?.[0];
      if (!book) throw new ProviderHttpError("json", `hardcover: no book for id ${externalId}`);
      const record: FetchedRecord = {
        provider: HARDCOVER_ID, externalId, media: "book",
        fields: mapBook(book), licence: HARDCOVER_LICENCE,
      };
      putCachedRecord(record, providerCacheTtlMsFor(HARDCOVER_ID));
      return record;
    },
  };
}

/** Cheap validity probe: one minimal Book search through the shared client. */
export async function hardcoverProbe(_provider: Provider, key: string | null): Promise<{ ok: boolean; detail?: string }> {
  const data = await graphql<HardcoverSearch>(key, SEARCH_QUERY, { query: "the", perPage: 1 });
  if (!data.search) throw new ProviderHttpError("json", "hardcover: probe response had no search");
  return { ok: true, detail: "hardcover reachable" };
}

/**
 * Persist a reviewed series -> Hardcover book link. `fetch()` has no library/series context, so the
 * review flow calls this when a reviewer confirms a candidate (libraryId 0 = "not yet in Kavita").
 */
export function linkHardcoverSeries(libraryId: number | null, seriesName: string, externalId: string): void {
  putLink({ libraryId: libraryId ?? 0, seriesName, provider: HARDCOVER_ID, externalId });
}
