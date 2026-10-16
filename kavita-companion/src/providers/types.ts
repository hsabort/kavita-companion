import type { Metadata, MetadataField } from "../metadata.js";
export type MediaKind = "comic" | "manga" | "book";
export interface Licence { name: string; url: string }          // e.g. { name: "CC BY-SA 4.0", url: "https://creativecommons.org/licenses/by-sa/4.0/" }
export interface ProviderCapabilities { media: MediaKind[]; fields: MetadataField[] }
export interface MatchQuery { title: string; number?: string; volume?: string; year?: string; isbn?: string; libraryType?: number }
export interface Candidate { provider: string; externalId: string; title: string; year?: string; publisher?: string; number?: string; volume?: string; score: number; band: "exact" | "near" | "loose" }
export interface FetchedRecord { provider: string; externalId: string; fields: Metadata; licence: Licence; media: MediaKind }
export interface Provider {
  id: string; label: string; licence: Licence; capabilities: ProviderCapabilities;
  covers: "proxy" | "none";
  search(key: string | null, query: MatchQuery, signal?: AbortSignal): Promise<Candidate[]>;
  fetch(key: string | null, externalId: string, signal?: AbortSignal): Promise<FetchedRecord>;
}
