// Read-through cache for provider records (metadata_cache). One row per provider + external id.
// A value is written only by an explicit, human-triggered lookup and expires after the provider's
// TTL, so the portal never becomes a bulk mirror (M4). Records are stored as our own field names,
// so a cache hit is a FetchedRecord with no per-provider code.
import { db } from "../db.js";
import type { FetchedRecord, MediaKind } from "./types.js";

interface CacheRow {
  provider: string;
  external_id: string;
  media: string;
  fields_json: string;
  licence_json: string;
  fetched_at: number;
  expires_at: number;
}

const select = db.prepare(
  "SELECT provider, external_id, media, fields_json, licence_json, fetched_at, expires_at FROM metadata_cache WHERE provider = ? AND external_id = ?",
);
const upsert = db.prepare(
  `INSERT INTO metadata_cache (provider, external_id, media, fields_json, licence_json, fetched_at, expires_at)
   VALUES (?, ?, ?, ?, ?, ?, ?)
   ON CONFLICT(provider, external_id) DO UPDATE SET media = excluded.media, fields_json = excluded.fields_json,
     licence_json = excluded.licence_json, fetched_at = excluded.fetched_at, expires_at = excluded.expires_at`,
);
const remove = db.prepare("DELETE FROM metadata_cache WHERE provider = ? AND external_id = ?");
const removeProvider = db.prepare("DELETE FROM metadata_cache WHERE provider = ?");
const removeExpired = db.prepare("DELETE FROM metadata_cache WHERE expires_at <= ?");
const countFor = db.prepare("SELECT COUNT(*) AS n FROM metadata_cache WHERE provider = ?");

/** A cached record if one is present and unexpired; expired rows are deleted on read. */
export function getCachedRecord(provider: string, externalId: string): FetchedRecord | null {
  const row = select.get(provider, externalId) as CacheRow | undefined;
  if (!row) return null;
  if (row.expires_at <= Date.now()) {
    remove.run(provider, externalId);
    return null;
  }
  return {
    provider: row.provider,
    externalId: row.external_id,
    media: row.media as MediaKind,
    fields: JSON.parse(row.fields_json),
    licence: JSON.parse(row.licence_json),
  };
}

/** Store a fetched record for `ttlMs` (the provider's cache TTL). */
export function putCachedRecord(record: FetchedRecord, ttlMs: number): void {
  const now = Date.now();
  upsert.run(record.provider, record.externalId, record.media, JSON.stringify(record.fields),
    JSON.stringify(record.licence), now, now + ttlMs);
}

/** Drop every cached record for lost trust in a provider (key cleared, provider disabled). */
export function purgeProviderCache(provider: string): number {
  return Number(removeProvider.run(provider).changes ?? 0);
}

/** Delete expired rows; called from the hourly job. */
export function purgeExpiredCache(): number {
  return Number(removeExpired.run(Date.now()).changes ?? 0);
}

/** Number of cached records for a provider (diagnostics). */
export function cacheCount(provider: string): number {
  return Number((countFor.get(provider) as { n: number } | undefined)?.n ?? 0);
}
