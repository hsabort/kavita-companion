// Grand Comics Database (GCD) adapter (phase 2, W3): the comics fallback provider.
//
// GCD is REST (Django REST Framework) at https://www.comics.org/api/ — no key required for anonymous
// use (30 requests/hour); a free account (HTTP Basic, `user:pass`) raises it to 2,000/day. Two calls:
//   search: GET {base}/api/series/name/<name>/issue/<n>/[year/<y>/]  -> issue list -> candidates
//   fetch:  GET {base}/api/issue/{id}/                                -> one full issue
//
// Licence: CC BY-SA 4.0 (commercial use allowed; attribution required). Cover *art* belongs to the
// rights holders, so `covers: "none"`: no cover is ever fetched, proxied or written into a file.
// Rate limit: anonymous 30/hour, so a conservative 120 s spacing; with an account key, a still-polite
// 5 s spacing (well inside the 2,000/day cap). See docs/research/R2-comic-databases.md.
//
// GCD's credits are free-text and often `;`-separated (e.g. "Gregory Wright (colors); Heroic Age
// (separations)"), with "None"/"?" placeholders — splitFreeText/joinNames normalise them. Every
// provider string is untrusted and runs through plainText (strip tags/entities). The issue endpoint
// has no top-level genre/keywords, so those are aggregated from `story_set[]`.
import { config, providerCacheTtlMsFor } from "../config.js";
import { AGE_RATINGS, type Metadata, type MetadataField } from "../metadata.js";
import { getCachedRecord, putCachedRecord } from "./cache.js";
import { providerFetchJson, plainText, ProviderHttpError } from "./http.js";
import { putLink } from "./links.js";
import type { Candidate, FetchedRecord, MatchQuery, Provider } from "./types.js";

export const GCD_ID = "gcd";
/** The attribution string is composed as "Comic data from {label}, {licence}", so the label carries
 *  the article to yield the required credit "Comic data from the Grand Comics Database (GCD), ...". */
export const GCD_LABEL = "the Grand Comics Database (GCD)";
export const GCD_LICENCE = {
  name: "CC BY-SA 4.0",
  url: "https://creativecommons.org/licenses/by-sa/4.0/",
};
/** Anonymous spacing for GCD's 30 requests/hour (the registry uses this conservative default). */
export const GCD_MIN_INTERVAL_MS_ANON = 120_000;
/** Spacing used when an account key is present (2,000/day) — polite for interactive lookups. */
export const GCD_MIN_INTERVAL_MS_AUTHED = 5_000;
/** The registry registers the anonymous spacing; the adapter narrows it when a key is supplied. */
export const GCD_MIN_INTERVAL_MS = GCD_MIN_INTERVAL_MS_ANON;
/** GCD cover art is the rights holder's: never fetch, proxy or rehost. */
export const GCD_COVERS = "none" as const;

/** ComicInfo fields GCD can supply (LanguageISO is not reliable on the issue endpoint). */
const GCD_FIELDS: MetadataField[] = [
  "Title", "Series", "Number", "Volume", "Summary", "Year",
  "Writer", "Penciller", "Inker", "Colorist", "CoverArtist",
  "Publisher", "Imprint", "Genre", "Tags", "AgeRating",
];

function base(): string {
  return config.gcdBaseUrl.replace(/\/+$/, "");
}

/** An optional account key is `user:pass` and maps to HTTP Basic (GCD has no bearer scheme). */
function authHeaders(key: string | null): Record<string, string> {
  if (!key) return {};
  return { Authorization: `Basic ${Buffer.from(key).toString("base64")}` };
}

/** Spacing for this call: the anonymous limit is much tighter than an authenticated one. Both are
 *  overridable via config (PROVIDER_GCD_MIN_INTERVAL_MS[_AUTHED]); the defaults match the docs. */
function intervalFor(key: string | null): number {
  return key ? config.gcdMinIntervalMsAuthed : config.gcdMinIntervalMs;
}

// ---------- defensive readings ----------

const str = (value: unknown): string =>
  typeof value === "string" ? value : typeof value === "number" ? String(value) : "";
const obj = (value: unknown): Record<string, unknown> =>
  value && typeof value === "object" ? (value as Record<string, unknown>) : {};
const text = (value: unknown): string => plainText(str(value));

/** Strip GCD's "(<year> series)" disambiguator from a series name: "Ironclad (2016 series)" -> "Ironclad". */
function stripSeriesYear(value: string): string {
  return value.replace(/\s*\(\d{4} series\)\s*$/i, "").trim();
}

/** The issue id at the tail of an api_url: ".../api/issue/256114/" -> "256114". */
function issueIdFromUrl(value: string): string {
  const match = /\/api\/issue\/(\d+)\/?/.exec(value);
  return match?.[1] ?? "";
}

/** A four-digit year from a GCD date string ("November 2000", "février 2000", "2000-11-00"). */
function yearFromDate(value: unknown): string | undefined {
  const match = /(\d{4})/.exec(text(value));
  return match ? match[1] : undefined;
}

/** The issue number inside a free-text descriptor: "12 [Direct Sales]" / "12 - Title" -> "12". */
function numberFromDescriptor(value: unknown): string {
  return text(value).replace(/\s*[\[-].*$/, "").trim();
}

/**
 * Split GCD's free-text credits on ';', drop placeholders ("None", "?", "-") and trailing role
 * qualifiers ("Gregory Wright (colors)" -> "Gregory Wright").
 */
function splitFreeText(value: unknown): string[] {
  return text(value)
    .split(";")
    .map((part) => part.replace(/\s*\([^)]*\)\s*$/, "").trim())
    .filter((part) => part && !/^(none|\?|-)+$/i.test(part));
}

/** The distinct names across several free-text credit fields, in first-seen order. */
function joinNames(values: unknown[]): string {
  const seen = new Set<string>();
  const names: string[] = [];
  for (const value of values) {
    for (const name of splitFreeText(value)) {
      const key = name.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      names.push(name);
    }
  }
  return names.join(", ");
}

/** Map GCD's free-text `rating` onto an AgeRating value Kavita understands (never invent one). */
function ageRatingOf(value: unknown): string | undefined {
  const raw = text(value);
  if (!raw) return undefined;
  if ((AGE_RATINGS as readonly string[]).includes(raw)) return raw;
  const lower = raw.toLowerCase();
  if (/mature|adult|explicit|18|^m$/.test(lower)) return "Mature 17+";
  if (/teen|^t$|t\+/.test(lower)) return "Teen";
  if (/everyone ?10|e10/.test(lower)) return "Everyone 10+";
  if (/kid|child|all[- ]?ages|everyone|approved|^g$/.test(lower)) return "Everyone";
  return undefined;
}

/** Case/punctuation-insensitive key for matching a series name. */
function normalizeTitle(value: string): string {
  return plainText(value).toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}

/** Issue numbers: drop a leading '#', leading zeros and whitespace. */
function normalizeNumber(value: string | undefined): string {
  return (value ?? "").replace(/^#/, "").trim().replace(/^0+(?=\d)/, "");
}

// ---------- search ----------

interface GcdIssueListRow {
  api_url?: unknown;
  series_name?: unknown;
  descriptor?: unknown;
  number?: unknown;
  publication_date?: unknown;
  variant_of?: unknown;
  series?: unknown;
}

interface GcdList {
  count?: number;
  next?: string | null;
  previous?: string | null;
  results?: GcdIssueListRow[];
}

function toCandidate(row: GcdIssueListRow, query: MatchQuery): Candidate {
  const seriesName = stripSeriesYear(text(row.series_name));
  const number = str(row.number) || numberFromDescriptor(row.descriptor);
  const year = yearFromDate(row.publication_date) ?? "";

  const nameEq = !!seriesName && normalizeTitle(seriesName) === normalizeTitle(query.title);
  const nameNear = !nameEq && !!seriesName && !!query.title
    && (normalizeTitle(seriesName).includes(normalizeTitle(query.title))
      || normalizeTitle(query.title).includes(normalizeTitle(seriesName)));
  const numberEq = query.number !== undefined && normalizeNumber(number) === normalizeNumber(query.number) && normalizeNumber(query.number) !== "";
  const yearEq = !!query.year && year === query.year;

  const band: Candidate["band"] = nameEq && numberEq && yearEq ? "exact" : nameEq && numberEq ? "near" : "loose";
  const score = Math.min(1, (nameEq ? 0.5 : nameNear ? 0.3 : 0) + (numberEq ? 0.3 : 0) + (yearEq ? 0.2 : 0));

  return {
    provider: GCD_ID, externalId: issueIdFromUrl(text(row.api_url)), title: seriesName,
    year: year || undefined, number: number || undefined, score, band,
  };
}

// ---------- fetch ----------

interface GcdIssue {
  api_url?: unknown;
  series_name?: unknown;
  descriptor?: unknown;
  number?: unknown;
  volume?: unknown;
  title?: unknown;
  key_date?: unknown;
  publication_date?: unknown;
  indicia_publisher?: unknown;
  brand_emblem?: unknown;
  rating?: unknown;
  keywords?: unknown;
  story_set?: unknown;
}

function mapIssue(issue: GcdIssue): Metadata {
  const stories = Array.isArray(issue.story_set) ? issue.story_set.map(obj) : [];
  const isCover = (story: Record<string, unknown>) => text(story.type).toLowerCase() === "cover";
  const interiors = stories.filter((story) => !isCover(story));
  const covers = stories.filter(isCover);

  const privateTitle = interiors.map((s) => text(s.title)).find(Boolean);
  const anyTitle = stories.map((s) => text(s.title)).find(Boolean);
  const synopses: string[] = [];
  for (const story of interiors) {
    const synopsis = text(story.synopsis);
    if (synopsis && !synopses.includes(synopsis)) synopses.push(synopsis);
  }

  const fields: Metadata = {
    Series: stripSeriesYear(text(issue.series_name)),
    Number: str(issue.number) || numberFromDescriptor(issue.descriptor),
    Volume: text(issue.volume),
    Title: privateTitle || text(issue.title) || anyTitle || "",
    Summary: synopses.join(" "),
    Year: yearFromDate(issue.key_date) ?? yearFromDate(issue.publication_date),
    Writer: joinNames(interiors.map((s) => s.script)),
    Penciller: joinNames(interiors.map((s) => s.pencils)),
    Inker: joinNames(interiors.map((s) => s.inks)),
    Colorist: joinNames(interiors.map((s) => s.colors)),
    CoverArtist: joinNames(covers.flatMap((s) => [s.pencils, s.inks, s.colors])),
    Publisher: text(issue.indicia_publisher),
    Imprint: text(issue.brand_emblem),
    Genre: joinNames(interiors.map((s) => s.genre)),
    Tags: joinNames([issue.keywords, ...interiors.map((s) => s.keywords)]),
    AgeRating: ageRatingOf(issue.rating),
  };
  // Drop empty values so the merge step never sees a blank proposal.
  return Object.fromEntries(Object.entries(fields).filter(([, value]) => value)) as Metadata;
}

export function createGcdProvider(): Provider {
  return {
    id: GCD_ID,
    label: GCD_LABEL,
    licence: GCD_LICENCE,
    capabilities: { media: ["comic"], fields: [...GCD_FIELDS] },
    covers: GCD_COVERS,

    async search(key: string | null, query: MatchQuery, signal?: AbortSignal): Promise<Candidate[]> {
      const number = (query.number ?? "").replace(/^#/, "").trim();
      // GCD's issue search is keyed on an issue number; without one we cannot return fetchable issues.
      if (!number) return [];
      const name = encodeURIComponent(query.title.trim());
      let path = `${base()}/api/series/name/${name}/issue/${encodeURIComponent(number)}/`;
      if (query.year) path += `year/${encodeURIComponent(query.year)}/`;
      const data = await providerFetchJson<GcdList>({
        provider: GCD_ID, url: path, signal, accept: "application/json",
        headers: authHeaders(key), minIntervalMs: intervalFor(key),
      });
      return (data.results ?? [])
        .filter((row) => !text(row.variant_of)) // skip alternate-cover variants (duplicate issues)
        .map((row) => toCandidate(row ?? {}, query))
        .filter((candidate) => candidate.externalId && candidate.title)
        .sort((a, b) => b.score - a.score);
    },

    async fetch(key: string | null, externalId: string, signal?: AbortSignal): Promise<FetchedRecord> {
      // Read-through the shared record cache (TTL from config), so a repeat fetch is one call.
      const cached = getCachedRecord(GCD_ID, externalId);
      if (cached) return cached;
      const data = await providerFetchJson<GcdIssue>({
        provider: GCD_ID, url: `${base()}/api/issue/${encodeURIComponent(externalId)}/`,
        signal, accept: "application/json", headers: authHeaders(key),
        minIntervalMs: intervalFor(key),
      });
      const record: FetchedRecord = {
        provider: GCD_ID, externalId, media: "comic",
        fields: mapIssue(data), licence: GCD_LICENCE,
      };
      putCachedRecord(record, providerCacheTtlMsFor(GCD_ID));
      return record;
    },
  };
}

/** Cheap validity probe for the admin test route: the API root (one small JSON document). */
export async function gcdProbe(_provider: Provider, key: string | null): Promise<{ ok: boolean; detail?: string }> {
  const data = await providerFetchJson<{ series?: unknown }>({
    provider: GCD_ID, url: `${base()}/api/`, accept: "application/json",
    headers: authHeaders(key), minIntervalMs: intervalFor(key),
  });
  if (!str(data.series)) throw new ProviderHttpError("json", "gcd: probe response had no series endpoint");
  return { ok: true, detail: "gcd reachable" };
}

/**
 * Persist a reviewed series -> GCD issue link. `fetch()` has no library/series context, so the review
 * flow calls this when a reviewer confirms a candidate (libraryId 0 = "not yet in Kavita").
 */
export function linkGcdSeries(libraryId: number | null, seriesName: string, externalId: string): void {
  putLink({ libraryId: libraryId ?? 0, seriesName, provider: GCD_ID, externalId });
}
