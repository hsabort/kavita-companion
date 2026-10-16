// AniList adapter (phase 2, W5): manga + light-novel metadata from https://graphql.anilist.co.
//
// AniList is a keyless GraphQL POST API. Reads need no auth (OAuth is only for private data/mutations,
// which we never do), so this adapter sends the same truthful User-Agent as every provider. One query
// shape serves both steps — by `search` for a search, by `id` for a fetch:
//   POST {base}  { query, variables: { search | id } }  -> { data: { Media: … } }
//
// Licence / terms: the strictest of the providers. AniList forbids using the API "as a backup or data
// storage service" and forbids bulk hoarding, so we only ever do one lookup per human action and keep
// the shared, capped read-through cache with a deliberately **short TTL** (see PROVIDER_ANILIST_CACHE_TTL_DAYS).
// Rate limit: 90/min documented but currently degraded to 30/min, so a 2 s spacing
// (`ANILIST_MIN_INTERVAL_MS`); 429 + Retry-After are handled by http.ts. `covers: "none"` — no image is
// ever fetched, proxied or written into a file.
//
// AniList is *series*-level: `chapters`/`volumes` are frequently null and are series-wide counts, not an
// issue number, so they are never mapped to Number/Volume. `isAdult` is the only age signal and is
// coarse; `countryOfOrigin` is the only language signal. See docs/research/R1-manga-anime.md.
import { config, providerCacheTtlMsFor } from "../config.js";
import type { Metadata, MetadataField } from "../metadata.js";
import { getCachedRecord, putCachedRecord } from "./cache.js";
import { providerFetchJson, plainText, ProviderHttpError } from "./http.js";
import { putLink } from "./links.js";
import type { Candidate, FetchedRecord, MatchQuery, Provider } from "./types.js";

export const ANILIST_ID = "anilist";
export const ANILIST_LABEL = "AniList";
export const ANILIST_LICENCE = { name: "API Terms of Use", url: "https://docs.anilist.co/" };
/** Documented 90/min but currently degraded to 30/min, so a 2 s spacing (the registry also uses it). */
export const ANILIST_MIN_INTERVAL_MS = 2000;
/** AniList terms forbid data-storage/hoarding; we never fetch any provider image. */
export const ANILIST_COVERS = "none" as const;

/** ComicInfo fields AniList can supply (series-level: no Number/Volume/Publisher/Imprint). */
const ANILIST_FIELDS: MetadataField[] = [
  "Series", "Summary", "Year", "Writer", "Penciller", "Genre", "Tags", "LanguageISO", "AgeRating",
];

/** One selection for both the search and the by-id fetch, so a fetch is a single request. */
const MEDIA_SELECTION = `
  id
  title { romaji english native }
  synonyms
  description(asHtml: false)
  startDate { year }
  genres
  tags { name rank category }
  staff { edges { role node { name { full } } } }
  isAdult
  countryOfOrigin
  chapters
  volumes
  format
`;

const SEARCH_QUERY = `query ($search: String) { Media(search: $search, type: MANGA) { ${MEDIA_SELECTION} } }`;
const ID_QUERY = `query ($id: Int) { Media(id: $id, type: MANGA) { ${MEDIA_SELECTION} } }`;

function base(): string {
  return config.anilistBaseUrl.replace(/\/+$/, "");
}

/** Spacing for this call (PROVIDER_ANILIST_MIN_INTERVAL_MS; the tests set it to 0). */
function interval(): number {
  return config.anilistMinIntervalMs;
}

// ---------- defensive readings ----------

const str = (value: unknown): string =>
  typeof value === "string" ? value : typeof value === "number" ? String(value) : "";
const obj = (value: unknown): Record<string, unknown> =>
  value && typeof value === "object" ? (value as Record<string, unknown>) : {};
const text = (value: unknown): string => plainText(str(value));

/** A list of plain strings joined for the Genre/Tags CSV fields, de-duplicated in first-seen order. */
function joinStrings(value: unknown): string {
  if (!Array.isArray(value)) return "";
  const seen = new Set<string>();
  const out: string[] = [];
  for (const item of value) {
    const name = text(item);
    if (!name || seen.has(name.toLowerCase())) continue;
    seen.add(name.toLowerCase());
    out.push(name);
  }
  return out.join(", ");
}

/** Title: AniList's English title when present, else the romaji, else the native. */
function seriesTitle(title: unknown): string {
  const map = obj(title);
  return text(map.english) || text(map.romaji) || text(map.native);
}

/** A four-digit year from `startDate.year`, or undefined when AniList has no date. */
function yearOf(value: unknown): string | undefined {
  const year = text(value);
  return /^\d{4}$/.test(year) ? year : undefined;
}

/**
 * Map AniList's coarse `isAdult` boolean onto a Kavita AgeRating value. The boolean carries only two
 * buckets, so we never invent granularity beyond them: adult -> Mature 17+, otherwise Everyone.
 */
function ageRatingOf(isAdult: unknown): string | undefined {
  if (isAdult === true) return "Mature 17+";
  if (isAdult === false) return "Everyone";
  return undefined;
}

/** `countryOfOrigin` ("JP", "KR", …) mapped to an ISO 639-1 language code; unknown -> undefined. */
const COUNTRY_LANGUAGE: Record<string, string> = { JP: "ja", KR: "ko", CN: "zh", TW: "zh-tw", HK: "zh-hk" };
function languageOf(value: unknown): string | undefined {
  return COUNTRY_LANGUAGE[text(value).toUpperCase()];
}

/**
 * Staff edges whose role matches `pattern`, de-duplicated (a person with "Story & Art" appears once in
 * the writer bucket and once in the artist bucket, never twice in the same one), in first-seen order.
 */
function staffNames(staff: unknown, pattern: RegExp): string {
  const edges = Array.isArray(obj(staff).edges) ? (obj(staff).edges as unknown[]) : [];
  const seen = new Set<string>();
  const names: string[] = [];
  for (const edge of edges) {
    const entry = obj(edge);
    if (!pattern.test(text(entry.role))) continue;
    // AniList's Staff.name is an object ({ full, native, ... }); accept a plain string too.
    const rawName = obj(entry.node).name;
    const name = typeof rawName === "string" ? text(rawName) : text(obj(rawName).full);
    if (!name || seen.has(name.toLowerCase())) continue;
    seen.add(name.toLowerCase());
    names.push(name);
  }
  return names.join(", ");
}

/** AniList's ranked tags are `{ name, rank, category }`; keep the names, de-duplicated. */
function tagNames(tags: unknown): string {
  if (!Array.isArray(tags)) return "";
  return joinStrings(tags.map((tag) => text(obj(tag).name)));
}

function mapMedia(media: Record<string, unknown>): Metadata {
  const fields: Metadata = {
    Series: seriesTitle(media.title),
    Summary: text(media.description),
    Year: yearOf(obj(media.startDate).year),
    Writer: staffNames(media.staff, /story|writer/i),
    Penciller: staffNames(media.staff, /art|illustration|pencil/i),
    Genre: joinStrings(media.genres),
    Tags: tagNames(media.tags),
    LanguageISO: languageOf(media.countryOfOrigin),
    AgeRating: ageRatingOf(media.isAdult),
  };
  // Drop empty values so the merge step never sees a blank proposal.
  return Object.fromEntries(Object.entries(fields).filter(([, value]) => value)) as Metadata;
}

/** Case/punctuation-insensitive key for matching a series name. */
function normalizeTitle(value: string): string {
  return plainText(value).toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}

function toCandidate(media: Record<string, unknown>, query: MatchQuery): Candidate {
  const title = seriesTitle(media.title);
  const year = yearOf(obj(media.startDate).year) ?? "";
  const nameEq = !!title && normalizeTitle(title) === normalizeTitle(query.title);
  const nameNear = !nameEq && !!title && !!query.title
    && (normalizeTitle(title).includes(normalizeTitle(query.title))
      || normalizeTitle(query.title).includes(normalizeTitle(title)));
  const yearEq = !!query.year && year === query.year;

  const band: Candidate["band"] = nameEq && yearEq ? "exact" : nameEq ? "near" : nameNear ? "near" : "loose";
  const score = Math.min(1, (nameEq ? 0.6 : nameNear ? 0.3 : 0) + (yearEq ? 0.4 : 0));

  return {
    provider: ANILIST_ID, externalId: str(media.id), title,
    year: year || undefined, score, band,
  };
}

// ---------- GraphQL ----------

interface GraphQlResponse<T> {
  data?: T;
  errors?: Array<{ message?: unknown }>;
}

/** One GraphQL POST: a JSON body, error-in-200 handling, and the shared retry/rate-limit policy. */
async function graphql<T>(key: string | null, query: string, variables: Record<string, unknown>, signal?: AbortSignal): Promise<T> {
  const body = await providerFetchJson<GraphQlResponse<T>>({
    provider: ANILIST_ID, url: `${base()}/`, method: "POST", key, signal, accept: "application/json",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ query, variables }),
    minIntervalMs: interval(),
  });
  if (Array.isArray(body.errors) && body.errors.length) {
    throw new ProviderHttpError("http", `anilist: ${text(body.errors[0]?.message) || "GraphQL error"}`, 200);
  }
  if (!body.data) throw new ProviderHttpError("json", "anilist: response had no data");
  return body.data;
}

export function createAnilistProvider(): Provider {
  return {
    id: ANILIST_ID,
    label: ANILIST_LABEL,
    licence: ANILIST_LICENCE,
    capabilities: { media: ["manga"], fields: [...ANILIST_FIELDS] },
    covers: ANILIST_COVERS,

    async search(key: string | null, query: MatchQuery, signal?: AbortSignal): Promise<Candidate[]> {
      const data = await graphql<{ Media?: Record<string, unknown> | null }>(key, SEARCH_QUERY, { search: query.title }, signal);
      const media = data.Media;
      if (!media) return [];
      const candidate = toCandidate(media, query);
      return candidate.externalId && candidate.title ? [candidate] : [];
    },

    async fetch(key: string | null, externalId: string, signal?: AbortSignal): Promise<FetchedRecord> {
      // Read-through the shared record cache (short TTL), so a repeat fetch is one call.
      const cached = getCachedRecord(ANILIST_ID, externalId);
      if (cached) return cached;
      const id = Number(externalId);
      if (!Number.isInteger(id) || id <= 0) {
        throw new ProviderHttpError("json", `anilist: invalid media id ${externalId}`);
      }
      const data = await graphql<{ Media?: Record<string, unknown> | null }>(key, ID_QUERY, { id }, signal);
      const media = data.Media;
      if (!media) throw new ProviderHttpError("json", `anilist: no media for id ${externalId}`);
      const record: FetchedRecord = {
        provider: ANILIST_ID, externalId, media: "manga",
        fields: mapMedia(media), licence: ANILIST_LICENCE,
      };
      putCachedRecord(record, providerCacheTtlMsFor(ANILIST_ID));
      return record;
    },
  };
}

/** Cheap validity probe: one minimal search through the shared client. */
export async function anilistProbe(_provider: Provider, key: string | null): Promise<{ ok: boolean; detail?: string }> {
  const data = await graphql<{ Media?: Record<string, unknown> | null }>(key, SEARCH_QUERY, { search: "a" });
  if (!data.Media) throw new ProviderHttpError("json", "anilist: probe response had no media");
  return { ok: true, detail: "anilist reachable" };
}

/**
 * Persist a reviewed series -> AniList media link. `fetch()` has no library/series context, so the
 * review flow calls this when a reviewer confirms a candidate (libraryId 0 = "not yet in Kavita").
 */
export function linkAnilistSeries(libraryId: number | null, seriesName: string, externalId: string): void {
  putLink({ libraryId: libraryId ?? 0, seriesName, provider: ANILIST_ID, externalId });
}
