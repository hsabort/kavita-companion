// Merge fetched provider records into our Metadata field set. The rules that matter (they decide what
// gets written into a user's file):
//   1. Never overwrite a value the file already has unless the caller asks (force[]).
//   2. Per-field precedence: the first record to provide a field wins (records arrive in precedence
//      order; `order` re-sorts them by provider id).
//   3. Provenance per field, and a conflicts[] list so the reviewer sees what a provider wanted to
//      change and can accept it explicitly.
//   4. Domain validation before a value reaches the form: reuse metadata.ts's field set and age
//      ratings, strip HTML (http.ts), drop anything that cannot be validated cleanly.
import { AGE_RATINGS, COMICINFO_FIELDS, type Metadata, type MetadataField } from "../metadata.js";
import { plainText } from "./http.js";
import type { Candidate, FetchedRecord } from "./types.js";

const FIELD_LIMITS: Partial<Record<MetadataField, number>> = { Summary: 20_000, Web: 2_000 };

/** Validate/normalise one field value the way the review form does. Null when it must be dropped. */
export function normalizeField(field: MetadataField, value: unknown): string | null {
  if (typeof value !== "string") return null;
  const text = plainText(value);
  if (!text) return null;
  if (text.length > (FIELD_LIMITS[field] ?? 500)) return null;
  if (field === "Year" && !/^\d{4}$/.test(text)) return null;
  if ((field === "Month" || field === "Day") && !/^\d{1,2}$/.test(text)) return null;
  if (field === "AgeRating" && !AGE_RATINGS.includes(text)) return null;
  if (field === "LanguageISO" && !/^[a-z]{2}(-[a-z]{2})?$/i.test(text)) return null;
  return text;
}

export interface MergeOptions {
  /** Records in precedence order (highest first), or unordered when `order` is given. */
  records: FetchedRecord[];
  /** Values already in the form/file. A non-empty current value is kept unless forced. */
  current?: Metadata;
  /** Ordered provider ids; records are sorted to match (unlisted providers keep their relative order). */
  order?: string[];
  /** Fields the caller explicitly allows overwriting. */
  force?: MetadataField[];
  /** Fields the caller has locked; they are never proposed. */
  locked?: MetadataField[];
}

export interface MergeConflict {
  field: MetadataField;
  current: string;
  proposed: string;
  source: string;
}

export interface MergeResult {
  /** Proposed values (fills and accepted overwrites only). */
  fields: Metadata;
  /** Source provider id per proposed field. */
  provenance: Partial<Record<MetadataField, string>>;
  /** Provider values that would replace a non-empty current value; the reviewer must accept them. */
  conflicts: MergeConflict[];
}

export function mergeRecords(options: MergeOptions): MergeResult {
  const orderIndex = new Map((options.order ?? []).map((id, i) => [id, i]));
  const records = options.order
    ? [...options.records].sort((a, b) =>
        (orderIndex.get(a.provider) ?? Number.MAX_SAFE_INTEGER) - (orderIndex.get(b.provider) ?? Number.MAX_SAFE_INTEGER))
    : options.records;
  const force = new Set(options.force ?? []);
  const locked = new Set(options.locked ?? []);
  const fields: Metadata = {};
  const provenance: Partial<Record<MetadataField, string>> = {};
  const conflicts: MergeConflict[] = [];
  const seen = new Set<MetadataField>();

  for (const record of records) {
    for (const field of COMICINFO_FIELDS) {
      if (seen.has(field) || locked.has(field)) continue;
      const value = normalizeField(field, record.fields[field]);
      if (value === null) continue;
      seen.add(field);
      const existing = (options.current?.[field] ?? "").trim();
      if (existing && !force.has(field)) {
        conflicts.push({ field, current: existing, proposed: value, source: record.provider });
        continue;
      }
      fields[field] = value;
      provenance[field] = record.provider;
    }
  }
  return { fields, provenance, conflicts };
}

/** A search candidate as the few Metadata fields it can stand in for (Title, Year, Number, …). */
export function candidateFields(candidate: Candidate): Metadata {
  const fields: Metadata = {};
  const set = (field: MetadataField, value: string | undefined) => {
    const clean = normalizeField(field, value);
    if (clean) fields[field] = clean;
  };
  set("Title", candidate.title);
  set("Year", candidate.year);
  set("Number", candidate.number);
  set("Volume", candidate.volume);
  set("Publisher", candidate.publisher);
  return fields;
}
