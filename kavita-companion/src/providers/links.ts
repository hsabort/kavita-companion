// Persist a series' external id per provider (provider_links), so a repeat upload skips search and
// cross-IDs can be reconciled. Keyed by library + series name (as seen in the review) + provider;
// a library_id of 0 stands for "not yet in Kavita". Written only when a reviewer confirms a match.
import { db } from "../db.js";

export interface ProviderLink {
  libraryId: number;
  seriesName: string;
  provider: string;
  externalId: string;
}

const selectOne = db.prepare(
  "SELECT external_id FROM provider_links WHERE library_id = ? AND series_name = ? AND provider = ?",
);
const selectAll = db.prepare(
  "SELECT provider, external_id FROM provider_links WHERE library_id = ? AND series_name = ?",
);
const upsert = db.prepare(
  `INSERT INTO provider_links (library_id, series_name, provider, external_id)
   VALUES (?, ?, ?, ?)
   ON CONFLICT(library_id, series_name, provider) DO UPDATE SET external_id = excluded.external_id`,
);
const removeOne = db.prepare("DELETE FROM provider_links WHERE library_id = ? AND series_name = ? AND provider = ?");
const removeProvider = db.prepare("DELETE FROM provider_links WHERE provider = ?");

/** The stored external id for one series + provider, or null. */
export function getLink(libraryId: number, seriesName: string, provider: string): string | null {
  const row = selectOne.get(libraryId, seriesName, provider) as { external_id: string } | undefined;
  return row?.external_id ?? null;
}

/** Every stored link for a series, as { provider, externalId } (used to boost ranking). */
export function linksForSeries(libraryId: number, seriesName: string): Array<{ provider: string; externalId: string }> {
  return (selectAll.all(libraryId, seriesName) as { provider: string; external_id: string }[])
    .map((r) => ({ provider: r.provider, externalId: r.external_id }));
}

/** Remember (or update) a series -> provider link. */
export function putLink(link: ProviderLink): void {
  upsert.run(link.libraryId, link.seriesName, link.provider, link.externalId);
}

export function forgetLink(libraryId: number, seriesName: string, provider: string): void {
  removeOne.run(libraryId, seriesName, provider);
}

export function forgetProviderLinks(provider: string): number {
  return Number(removeProvider.run(provider).changes ?? 0);
}
