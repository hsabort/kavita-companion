// Metron adapter (phase 2, W2): comics metadata from https://metron.cloud.
//
// Metron is REST (DRF). All endpoints need auth: a free per-install bearer token, resolved by the
// registry from PROVIDER_METRON_KEY or the sealed provider_config row (never shipped). Two calls:
//   search: GET {base}/api/issue/?series_name=&number=&series_year_began=  -> ranked candidates
//   fetch:  GET {base}/api/issue/{id}/                                     -> one full issue
//
// Licence: CC BY-SA 4.0 (commercial use and embedding explicitly allowed; attribution required).
// Cover images are fair-use only and excluded from the licence, so `covers: "none"` and no cover is
// ever fetched, proxied or written into a file. Rate limit: 20 requests/minute (burst) plus a
// sustained daily cap; we register a conservative 3 s spacing and let http.ts honour Retry-After.
//
// Every provider string is untrusted and runs through plainText (strip tags/entities). The response
// shape is read defensively (nullable/nested fields) because Metron's list and detail serialisers
// differ slightly and the API is versioned. See docs/research/R2-comic-databases.md.
import { config, providerCacheTtlMsFor } from "../config.js";
import { AGE_RATINGS, type Metadata, type MetadataField } from "../metadata.js";
import { getCachedRecord, putCachedRecord } from "./cache.js";
import { providerFetchJson, plainText, ProviderHttpError } from "./http.js";
import { putLink } from "./links.js";
import type { Candidate, FetchedRecord, MatchQuery, Provider } from "./types.js";

export const METRON_ID = "metron";
export const METRON_LABEL = "Metron";
export const METRON_LICENCE = {
  name: "CC BY-SA 4.0",
  url: "https://creativecommons.org/licenses/by-sa/4.0/",
};
/** Conservative spacing for Metron's burst limit of 20 requests/minute (the registry also uses it). */
export const METRON_MIN_INTERVAL_MS = 3000;
/** Metron's fair-use cover images are excluded from the licence: never fetch, proxy or rehost them. */
export const METRON_COVERS = "none" as const;

/** ComicInfo fields Metron can supply (see docs/research/R2-comic-databases.md). */
const METRON_FIELDS: MetadataField[] = [
  "Title", "Series", "Number", "Volume", "Summary", "Year",
  "Writer", "Penciller", "Inker", "Colorist", "CoverArtist",
  "Publisher", "Imprint", "Genre", "Tags", "LanguageISO", "AgeRating",
];

function base(): string {
  return config.metronBaseUrl.replace(/\/+$/, "");
}

// ---------- defensive readings ----------

const str = (value: unknown): string =>
  typeof value === "string" ? value : typeof value === "number" ? String(value) : "";
const obj = (value: unknown): Record<string, unknown> =>
  value && typeof value === "object" ? (value as Record<string, unknown>) : {};
const text = (value: unknown): string => plainText(str(value));
const nameOf = (value: unknown): string => text(obj(value).name);
/** A related resource as a nested { name } object or a bare name string (a URL is not a name). */
const nameOrString = (value: unknown): string => {
  if (typeof value === "string") return /^https?:/i.test(value.trim()) ? "" : text(value);
  return nameOf(value);
};

/** Metron exposes language as an ISO code string, or as a nested { id, code, name } object. */
function languageOf(value: unknown): string {
  if (typeof value === "string") return plainText(value);
  const o = obj(value);
  return text(o.code) || text(o.iso_code) || text(o.name);
}

/** A list of resources ({name}) or plain strings, joined for the Tags/Genre CSV fields. */
function nameList(value: unknown): string {
  if (!Array.isArray(value)) return "";
  return value
    .map((item) => (typeof item === "string" ? text(item) : nameOf(item)))
    .filter(Boolean)
    .join(", ");
}

/** Map Metron's issue `rating` (text or { name }) onto an AgeRating value Kavita understands. */
function ageRatingOf(value: unknown): string | undefined {
  const raw = text(typeof value === "string" ? value : obj(value).name);
  if (!raw) return undefined;
  if ((AGE_RATINGS as readonly string[]).includes(raw)) return raw;
  const lower = raw.toLowerCase();
  if (/mature|adult|explicit|18|^m$/.test(lower)) return "Mature 17+";
  if (/teen|^t$|t\+/.test(lower)) return "Teen";
  if (/everyone ?10|e10/.test(lower)) return "Everyone 10+";
  if (/kid|child|all[- ]?ages|everyone|^g$/.test(lower)) return "Everyone";
  return undefined;
}

/** Year: the series' year_began, else the cover_date year. */
function yearOf(series: Record<string, unknown>, issue: MetronIssue): string | undefined {
  const began = str(series.year_began);
  if (/^\d{4}$/.test(began)) return began;
  const match = /(\d{4})/.exec(text(issue.cover_date));
  return match ? match[1] : undefined;
}

// Credits -> our five comic creator roles. Metron gives `credits: [{ creator, roles: [{ name }] }]`
// (or a bare `[{ creator, role }]`); role names are matched case-insensitively.
const ROLE_PATTERNS: Array<[RegExp, MetadataField]> = [
  [/writer/i, "Writer"],
  // Metron's cover role is "Cover"; match it before the artist pattern so a "Cover Artist" (if it
  // ever appears) becomes CoverArtist, while the interior "Artist" role becomes Penciller.
  [/cover/i, "CoverArtist"],
  [/pencill?er|artist/i, "Penciller"],
  [/inker/i, "Inker"],
  [/colou?rist/i, "Colorist"],
];

function creditRoles(credits: unknown): Metadata {
  const buckets: Partial<Record<MetadataField, string[]>> = {};
  if (!Array.isArray(credits)) return {};
  for (const entry of credits) {
    const credit = obj(entry);
    // Metron sends `creator` as a bare name string; nameOrString also accepts a nested { name }.
    const creator = nameOrString(credit.creator);
    if (!creator) continue;
    // Metron's `role` is an array of { id, name }; accept a single object too.
    const roles = Array.isArray(credit.roles) ? credit.roles
      : Array.isArray(credit.role) ? credit.role
      : credit.role ? [credit.role] : [];
    for (const role of roles) {
      const roleName = typeof role === "string" ? role : nameOf(role);
      for (const [pattern, field] of ROLE_PATTERNS) {
        if (!pattern.test(roleName)) continue;
        const bucket = (buckets[field] ??= []);
        if (!bucket.includes(creator)) bucket.push(creator);
        break;
      }
    }
  }
  const fields: Metadata = {};
  for (const [field, names] of Object.entries(buckets)) fields[field as MetadataField] = names.join(", ");
  return fields;
}

// ---------- search / fetch ----------

interface MetronIssue {
  id?: number | string;
  number?: unknown;
  title?: unknown;
  desc?: unknown;
  rating?: unknown;
  cover_date?: unknown;
  store_date?: unknown;
  series?: unknown;
  series_name?: unknown;
  series_year_began?: unknown;
  publisher?: unknown;
  imprint?: unknown;
  credits?: unknown;
  genres?: unknown;
  arcs?: unknown;
  characters?: unknown;
  teams?: unknown;
  language?: unknown;
}

interface MetronList {
  count?: number;
  next?: string | null;
  previous?: string | null;
  results?: MetronIssue[];
}

/** Case/punctuation-insensitive key for matching a series name. */
function normalizeTitle(value: string): string {
  return plainText(value).toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}

/** Issue numbers: drop a leading '#', leading zeros and whitespace. */
function normalizeNumber(value: string | undefined): string {
  return (value ?? "").replace(/^#/, "").trim().replace(/^0+(?=\d)/, "");
}

const SERIES_NAME = (issue: MetronIssue): string => nameOrString(issue.series) || text(issue.series_name);
const SERIES_YEAR = (issue: MetronIssue): string => {
  const began = str(obj(issue.series).year_began) || str(issue.series_year_began);
  return began.slice(0, 4);
};

function toCandidate(issue: MetronIssue, query: MatchQuery): Candidate {
  const seriesName = SERIES_NAME(issue);
  const number = str(issue.number);
  const year = SERIES_YEAR(issue) || (/^\d{4}$/.test(str(issue.cover_date).slice(0, 4)) ? str(issue.cover_date).slice(0, 4) : "");
  const publisher = nameOrString(issue.publisher) || nameOrString(obj(issue.series).publisher);

  const nameEq = !!seriesName && normalizeTitle(seriesName) === normalizeTitle(query.title);
  const nameNear = !nameEq && !!seriesName && !!query.title
    && (normalizeTitle(seriesName).includes(normalizeTitle(query.title))
      || normalizeTitle(query.title).includes(normalizeTitle(seriesName)));
  const numberEq = query.number !== undefined && normalizeNumber(number) === normalizeNumber(query.number) && normalizeNumber(query.number) !== "";
  const yearEq = !!query.year && year === query.year;

  const band: Candidate["band"] = nameEq && numberEq && yearEq ? "exact" : nameEq && numberEq ? "near" : "loose";
  const score = Math.min(1, (nameEq ? 0.5 : nameNear ? 0.3 : 0) + (numberEq ? 0.3 : 0) + (yearEq ? 0.2 : 0));

  return {
    provider: METRON_ID, externalId: str(issue.id), title: seriesName,
    year: year || undefined, publisher: publisher || undefined,
    number: number || undefined, score, band,
  };
}

function mapIssue(issue: MetronIssue): Metadata {
  const series = obj(issue.series);
  const fields: Metadata = {
    Series: nameOrString(series) || text(issue.series_name),
    Number: str(issue.number),
    Volume: str(series.volume),
    Title: text(issue.title),
    Summary: text(issue.desc),
    Year: yearOf(series, issue),
    Publisher: nameOrString(issue.publisher) || nameOrString(series.publisher),
    Imprint: nameOrString(issue.imprint),
    Genre: nameList(series.genres) || nameList(issue.genres),
    Tags: [nameList(issue.arcs), nameList(issue.characters), nameList(issue.teams)].filter(Boolean).join(", "),
    LanguageISO: languageOf(series.language) || languageOf(issue.language),
    AgeRating: ageRatingOf(issue.rating),
    ...creditRoles(issue.credits),
  };
  // Drop empty values so the merge step never sees a blank proposal.
  return Object.fromEntries(Object.entries(fields).filter(([, value]) => value)) as Metadata;
}

export function createMetronProvider(): Provider {
  return {
    id: METRON_ID,
    label: METRON_LABEL,
    licence: METRON_LICENCE,
    capabilities: { media: ["comic"], fields: [...METRON_FIELDS] },
    covers: METRON_COVERS,

    async search(key: string | null, query: MatchQuery, signal?: AbortSignal): Promise<Candidate[]> {
      const url = new URL(`${base()}/api/issue/`);
      url.searchParams.set("series_name", query.title);
      if (query.number) url.searchParams.set("number", query.number.replace(/^#/, "").trim());
      if (query.year) url.searchParams.set("series_year_began", query.year);
      const data = await providerFetchJson<MetronList>({
        provider: METRON_ID, url: url.toString(), key, signal, accept: "application/json",
        minIntervalMs: METRON_MIN_INTERVAL_MS,
      });
      return (data.results ?? [])
        .map((issue) => toCandidate(issue ?? {}, query))
        .filter((candidate) => candidate.externalId && candidate.title)
        .sort((a, b) => b.score - a.score);
    },

    async fetch(key: string | null, externalId: string, signal?: AbortSignal): Promise<FetchedRecord> {
      // Read-through the shared record cache (TTL from config), so a repeat fetch is one call.
      const cached = getCachedRecord(METRON_ID, externalId);
      if (cached) return cached;
      const data = await providerFetchJson<MetronIssue>({
        provider: METRON_ID, url: `${base()}/api/issue/${encodeURIComponent(externalId)}/`,
        key, signal, accept: "application/json", minIntervalMs: METRON_MIN_INTERVAL_MS,
      });
      const record: FetchedRecord = {
        provider: METRON_ID, externalId, media: "comic",
        fields: mapIssue(data), licence: METRON_LICENCE,
      };
      putCachedRecord(record, providerCacheTtlMsFor(METRON_ID));
      return record;
    },
  };
}

/** Cheap validity probe for the admin test route: one known issue detail through the shared client. */
export async function metronProbe(_provider: Provider, key: string | null): Promise<{ ok: boolean; detail?: string }> {
  const data = await providerFetchJson<MetronIssue>({
    provider: METRON_ID, url: `${base()}/api/issue/1/`, key, accept: "application/json",
    minIntervalMs: METRON_MIN_INTERVAL_MS,
  });
  if (str(data.id) === "") throw new ProviderHttpError("json", "metron: probe response had no issue id");
  return { ok: true, detail: "metron reachable" };
}

/**
 * Persist a reviewed series -> Metron issue link. `fetch()` has no library/series context, so the
 * review flow calls this when a reviewer confirms a candidate (libraryId 0 = "not yet in Kavita").
 */
export function linkMetronSeries(libraryId: number | null, seriesName: string, externalId: string): void {
  putLink({ libraryId: libraryId ?? 0, seriesName, provider: METRON_ID, externalId });
}
