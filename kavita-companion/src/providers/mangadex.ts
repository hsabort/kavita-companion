// MangaDex adapter (phase 2, W4): manga metadata from https://api.mangadex.org.
//
// MangaDex is REST, keyless and server-side only (its API has no third-party CORS, so a browser must
// never call it; every request goes through the portal). Two calls:
//   search: GET {base}/manga?title=<t>&limit=<n>&order[relevance]=desc            -> ranked candidates
//   fetch:  GET {base}/manga/{id}?includes[]=author&includes[]=artist&includes[]=cover_art  -> one manga
//
// Licence / Acceptable Usage Policy: **credit "MangaDex" is required**, the data must not be used for
// ads or a paid service, and images must never be hotlinked. We therefore declare the credit as the
// licence name and `covers: "none"` — no cover is ever fetched, proxied or written into a file. Rate
// limit: ~5 requests/s per IP, so a 250 ms spacing (`MANGADEX_MIN_INTERVAL_MS`).
//
// MangaDex is *series*-level: `lastChapter`/`lastVolume` are optional series-wide counts, often empty,
// and are **not** an issue number, so they are never mapped to Number/Volume. Every provider string is
// untrusted and runs through plainText (strip tags/entities); the response shape is read defensively
// because MangaDex fields are localized maps and their API is versioned. See docs/research/R1-manga-anime.md.
import { config, providerCacheTtlMsFor } from "../config.js";
import { AGE_RATINGS, type Metadata, type MetadataField } from "../metadata.js";
import { getCachedRecord, putCachedRecord } from "./cache.js";
import { providerFetchJson, plainText, ProviderHttpError } from "./http.js";
import { putLink } from "./links.js";
import type { Candidate, FetchedRecord, MatchQuery, Provider } from "./types.js";

export const MANGADEX_ID = "mangadex";
export const MANGADEX_LABEL = "MangaDex";
export const MANGADEX_LICENCE = {
  name: "Acceptable Usage Policy (credit required)",
  url: "https://api.mangadex.org/docs/",
};
/** ~5 requests/s per IP, so a 250 ms spacing (the registry also uses it). */
export const MANGADEX_MIN_INTERVAL_MS = 250;
/** MangaDex forbids hotlinking and we never fetch provider images at all. */
export const MANGADEX_COVERS = "none" as const;

/** ComicInfo fields MangaDex can supply (it is series-level: no Number/Volume/Publisher/Imprint). */
const MANGADEX_FIELDS: MetadataField[] = [
  "Series", "Summary", "Year", "Writer", "Penciller", "Genre", "Tags", "LanguageISO", "AgeRating",
];

function base(): string {
  return config.mangadexBaseUrl.replace(/\/+$/, "");
}

/** Spacing for this call (PROVIDER_MANGADEX_MIN_INTERVAL_MS; the tests set it to 0). */
function interval(): number {
  return config.mangadexMinIntervalMs;
}

// ---------- defensive readings ----------

const str = (value: unknown): string =>
  typeof value === "string" ? value : typeof value === "number" ? String(value) : "";
const obj = (value: unknown): Record<string, unknown> =>
  value && typeof value === "object" ? (value as Record<string, unknown>) : {};
const text = (value: unknown): string => plainText(str(value));

/** The raw (un-stripped) `en` string of a MangaDex localized field, so line structure survives. */
function localizedRaw(value: unknown): string {
  if (typeof value === "string") return value;
  const map = obj(value);
  if (typeof map.en === "string") return map.en;
  for (const candidate of Object.values(map)) {
    if (typeof candidate === "string") return candidate;
  }
  return "";
}

/** A MangaDex localized field is a `{ en, ja, … }` map (or a bare string); prefer `en`. */
function localized(value: unknown): string {
  return text(localizedRaw(value));
}

/**
 * A MangaDex description often opens with a credit/scanlation preamble ("Credit to …") and closes with
 * a "Support the author …" line. It arrives as an HTML-ish localized string; strip tags/entities, drop
 * those credit/support lines and keep the actual synopsis.
 */
const CREDIT_PREAMBLE = /^(credit|credits|support|join|read (this|it|the)|please|scan(lation)?|translation|note)\b/i;
function summaryOf(value: unknown): string | undefined {
  const raw = localizedRaw(value);
  if (!raw) return undefined;
  const lines = raw
    .split(/\r?\n+/)
    .map((line) => plainText(line))
    .filter((line) => line && !CREDIT_PREAMBLE.test(line));
  const summary = lines.join(" ").trim();
  return summary || undefined;
}

/** Map MangaDex's `contentRating` onto a Kavita AgeRating value (never invent one). */
function ageRatingOf(value: unknown): string | undefined {
  const raw = text(value).toLowerCase();
  if (!raw) return undefined;
  if ((AGE_RATINGS as readonly string[]).includes(value as string)) return value as string;
  if (raw === "safe") return "Everyone";
  if (raw === "suggestive") return "Teen";
  if (raw === "erotica") return "Mature 17+";
  if (raw === "pornographic") return "Adults Only 18+";
  return undefined;
}

/** `originalLanguage` is usually a bare code ("ja", "ko", "zh-hk"); keep it only if it looks like one. */
function languageOf(value: unknown): string | undefined {
  const code = text(value);
  return /^[a-z]{2}(-[a-z]{2})?$/i.test(code) ? code.toLowerCase() : undefined;
}

// ---------- search / fetch ----------

interface MangaDexEntity {
  id?: unknown;
  attributes?: unknown;
  relationships?: unknown;
}

interface MangaDexList {
  result?: unknown;
  response?: unknown;
  data?: MangaDexEntity[];
}

interface MangaDexEntityResponse {
  result?: unknown;
  response?: unknown;
  data?: MangaDexEntity;
}

const TITLE = (entity: MangaDexEntity): string => localized(obj(entity.attributes).title);
const YEAR = (entity: MangaDexEntity): string => str(obj(entity.attributes).year);

/** Case/punctuation-insensitive key for matching a series name. */
function normalizeTitle(value: string): string {
  return plainText(value).toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}

/**
 * MangaDex is series-level: it never carries an issue number, so a caller's chapter number is not a
 * discriminating signal. Banding therefore uses the series title and year only.
 */
function toCandidate(entity: MangaDexEntity, query: MatchQuery): Candidate {
  const title = TITLE(entity);
  const year = YEAR(entity);
  const nameEq = !!title && normalizeTitle(title) === normalizeTitle(query.title);
  const nameNear = !nameEq && !!title && !!query.title
    && (normalizeTitle(title).includes(normalizeTitle(query.title))
      || normalizeTitle(query.title).includes(normalizeTitle(title)));
  const yearEq = !!query.year && year === query.year;

  const band: Candidate["band"] = nameEq && yearEq ? "exact" : nameEq ? "near" : nameNear ? "near" : "loose";
  const score = Math.min(1, (nameEq ? 0.6 : nameNear ? 0.3 : 0) + (yearEq ? 0.4 : 0));

  return {
    provider: MANGADEX_ID, externalId: str(entity.id), title,
    year: year || undefined, score, band,
  };
}

/** Relationship resources MangaDex returns for a manga (`author`, `artist`, `cover_art`, …). */
function relationshipNames(relationships: unknown, type: string): string {
  if (!Array.isArray(relationships)) return "";
  const seen = new Set<string>();
  const names: string[] = [];
  for (const entry of relationships) {
    const relationship = obj(entry);
    if (text(relationship.type) !== type) continue;
    const name = text(obj(relationship.attributes).name);
    if (!name || seen.has(name.toLowerCase())) continue;
    seen.add(name.toLowerCase());
    names.push(name);
  }
  return names.join(", ");
}

/** Tags split by their group: `group === "genre"` -> Genre, every other group -> Tags. */
function tagsByGroup(attributes: Record<string, unknown>): { genre: string; tags: string } {
  const genre: string[] = [];
  const tags: string[] = [];
  const seen = new Set<string>();
  if (!Array.isArray(attributes.tags)) return { genre: "", tags: "" };
  for (const entry of attributes.tags) {
    const tag = obj(obj(entry).attributes);
    const name = localized(tag.name);
    if (!name || seen.has(name.toLowerCase())) continue;
    seen.add(name.toLowerCase());
    if (text(tag.group) === "genre") genre.push(name);
    else tags.push(name);
  }
  return { genre: genre.join(", "), tags: tags.join(", ") };
}

function mapManga(entity: MangaDexEntity): Metadata {
  const attributes = obj(entity.attributes);
  const { genre, tags } = tagsByGroup(attributes);
  const fields: Metadata = {
    Series: localized(attributes.title),
    Summary: summaryOf(attributes.description),
    Year: YEAR(entity),
    Writer: relationshipNames(entity.relationships, "author"),
    Penciller: relationshipNames(entity.relationships, "artist"),
    Genre: genre,
    Tags: tags,
    LanguageISO: languageOf(attributes.originalLanguage),
    AgeRating: ageRatingOf(attributes.contentRating),
  };
  // Drop empty values so the merge step never sees a blank proposal.
  return Object.fromEntries(Object.entries(fields).filter(([, value]) => value)) as Metadata;
}

export function createMangadexProvider(): Provider {
  return {
    id: MANGADEX_ID,
    label: MANGADEX_LABEL,
    licence: MANGADEX_LICENCE,
    capabilities: { media: ["manga"], fields: [...MANGADEX_FIELDS] },
    covers: MANGADEX_COVERS,

    async search(key: string | null, query: MatchQuery, signal?: AbortSignal): Promise<Candidate[]> {
      const url = new URL(`${base()}/manga`);
      url.searchParams.set("title", query.title);
      url.searchParams.set("limit", "8");
      url.searchParams.set("order[relevance]", "desc");
      const data = await providerFetchJson<MangaDexList>({
        provider: MANGADEX_ID, url: url.toString(), key, signal, accept: "application/json",
        minIntervalMs: interval(),
      });
      return (data.data ?? [])
        .map((entity) => toCandidate(entity ?? {}, query))
        .filter((candidate) => candidate.externalId && candidate.title)
        .sort((a, b) => b.score - a.score);
    },

    async fetch(key: string | null, externalId: string, signal?: AbortSignal): Promise<FetchedRecord> {
      // Read-through the shared record cache (TTL from config), so a repeat fetch is one call.
      const cached = getCachedRecord(MANGADEX_ID, externalId);
      if (cached) return cached;
      const url = new URL(`${base()}/manga/${encodeURIComponent(externalId)}`);
      url.searchParams.append("includes[]", "author");
      url.searchParams.append("includes[]", "artist");
      url.searchParams.append("includes[]", "cover_art");
      const data = await providerFetchJson<MangaDexEntityResponse>({
        provider: MANGADEX_ID, url: url.toString(), key, signal, accept: "application/json",
        minIntervalMs: interval(),
      });
      const entity = data.data;
      if (!entity) throw new ProviderHttpError("json", `mangadex: no manga for id ${externalId}`);
      const record: FetchedRecord = {
        provider: MANGADEX_ID, externalId, media: "manga",
        fields: mapManga(entity), licence: MANGADEX_LICENCE,
      };
      putCachedRecord(record, providerCacheTtlMsFor(MANGADEX_ID));
      return record;
    },
  };
}

/** Cheap validity probe: one small manga list request through the shared client. */
export async function mangadexProbe(_provider: Provider, key: string | null): Promise<{ ok: boolean; detail?: string }> {
  const url = new URL(`${base()}/manga`);
  url.searchParams.set("limit", "1");
  const data = await providerFetchJson<MangaDexList>({
    provider: MANGADEX_ID, url: url.toString(), key, accept: "application/json", minIntervalMs: interval(),
  });
  if (!Array.isArray(data.data)) throw new ProviderHttpError("json", "mangadex: probe response had no data");
  return { ok: true, detail: "mangadex reachable" };
}

/**
 * Persist a reviewed series -> MangaDex manga link. `fetch()` has no library/series context, so the
 * review flow calls this when a reviewer confirms a candidate (libraryId 0 = "not yet in Kavita").
 */
export function linkMangadexSeries(libraryId: number | null, seriesName: string, externalId: string): void {
  putLink({ libraryId: libraryId ?? 0, seriesName, provider: MANGADEX_ID, externalId });
}
