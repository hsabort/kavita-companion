// A tiny built-in provider used only by the framework tests (registered when PROVIDERS_STUB=true).
// It talks to tests/provider_fake.py through the shared HTTP client, so the tests exercise the real
// registry, keyed-gating, HTTP client (retries/UA/size cap) and cache paths — no network, no keys.
//
// API (synthetic): GET <base>/stub/search?title=&number=  -> { results: Candidate-shaped[] }
//                   GET <base>/stub/record/<id>          -> { id, media, fields }
//                   GET <base>/stub/probe                -> { ok: true }
import { config } from "../config.js";
import { COMICINFO_FIELDS } from "../metadata.js";
import { providerFetchJson, ProviderHttpError } from "./http.js";
import type { Candidate, FetchedRecord, MatchQuery, MediaKind, Provider } from "./types.js";

export const STUB_ID = "stub";
export const STUB_LICENCE = { name: "CC0 1.0", url: "https://creativecommons.org/publicdomain/zero/1.0/" };

function base(): string {
  const url = config.providerStubBase.replace(/\/$/, "");
  if (!url) throw new ProviderHttpError("url", "PROVIDER_STUB_BASE is not set");
  return url;
}

interface StubSearchResult {
  id: string;
  title: string;
  number?: string;
  volume?: string;
  year?: string;
  publisher?: string;
  score?: number;
}

interface StubRecord {
  id: string;
  media?: MediaKind;
  fields: Record<string, string>;
}

export function createStubProvider(): Provider {
  return {
    id: STUB_ID,
    label: "Test stub provider",
    licence: STUB_LICENCE,
    capabilities: { media: ["comic", "manga", "book"], fields: [...COMICINFO_FIELDS] },
    covers: "none",
    async search(key, query: MatchQuery): Promise<Candidate[]> {
      const url = new URL(`${base()}/stub/search`);
      url.searchParams.set("title", query.title);
      if (query.number) url.searchParams.set("number", query.number);
      const data = await providerFetchJson<{ results?: StubSearchResult[] }>({
        provider: STUB_ID, url: url.toString(), key, accept: "application/json",
      });
      return (data.results ?? []).map((r) => {
        const score = typeof r.score === "number" ? r.score : 0.5;
        const band: Candidate["band"] = score >= 0.9 ? "exact" : score >= 0.5 ? "near" : "loose";
        return {
          provider: STUB_ID, externalId: r.id, title: r.title, number: r.number, volume: r.volume,
          year: r.year, publisher: r.publisher, score, band,
        };
      }).sort((a, b) => b.score - a.score);
    },
    async fetch(key, externalId: string): Promise<FetchedRecord> {
      const data = await providerFetchJson<StubRecord>({
        provider: STUB_ID, url: `${base()}/stub/record/${encodeURIComponent(externalId)}`, key, accept: "application/json",
      });
      return {
        provider: STUB_ID, externalId, media: data.media ?? "comic",
        fields: data.fields ?? {}, licence: STUB_LICENCE,
      };
    },
  };
}

/** Cheap validity probe: one request through the shared client, so retries/UA/size cap are exercised. */
export async function stubProbe(_provider: Provider, key: string | null): Promise<{ ok: boolean; detail?: string }> {
  const data = await providerFetchJson<{ ok?: boolean }>({
    provider: STUB_ID, url: `${base()}/stub/probe`, key, accept: "application/json", minIntervalMs: 0,
  });
  return { ok: data.ok === true, detail: "stub reachable" };
}
