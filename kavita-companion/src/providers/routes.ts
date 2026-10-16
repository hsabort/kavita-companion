// Admin-only provider settings (reviewer gate, same as Activity): list providers with their state,
// set or clear a key, toggle a provider, and run diagnostics. Keys are sealed (seal.ts) and are never
// returned by any route — only hasKey/configured booleans are.
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { currentUser, type SessionUser } from "../auth.js";
import { config, providerCacheTtlMsFor } from "../config.js";
import { audit } from "../db.js";
import { seal } from "../seal.js";
import { attributionFor } from "./attribution.js";
import { cacheCount, getCachedRecord, putCachedRecord, purgeProviderCache } from "./cache.js";
import { forgetProviderLinks } from "./links.js";
import { mergeRecords } from "./merge.js";
import {
  all, configRow, get, isConfigured, isEnabled, keyFor, setEnabled, setKeySealed, type ProviderRegistration,
} from "./registry.js";
import type { Metadata, MetadataField } from "../metadata.js";
import type { Candidate, FetchedRecord, MatchQuery, MediaKind } from "./types.js";

function requireReviewer(request: FastifyRequest, reply: FastifyReply): SessionUser | null {
  const user = currentUser(request);
  if (!user) {
    reply.code(401).send({ error: "Not signed in" });
    return null;
  }
  if (!user.isReviewer) {
    reply.code(403).send({ error: "Only Kavita admins can manage metadata providers." });
    return null;
  }
  return user;
}

const describe = (reg: ProviderRegistration) => ({
  id: reg.provider.id,
  label: reg.provider.label,
  licence: reg.provider.licence,
  attribution: attributionFor(reg.provider),
  media: reg.provider.capabilities.media,
  fields: reg.provider.capabilities.fields,
  covers: reg.provider.covers,
  keyed: reg.keyed,
  enabled: isEnabled(reg),
  configured: isConfigured(reg),
  hasKey: reg.keyed ? isConfigured(reg) : false,
  ttlDays: Math.round(providerCacheTtlMsFor(reg.provider.id) / 86_400_000 * 100) / 100,
  cacheCount: cacheCount(reg.provider.id),
  updatedAt: configRow(reg.provider.id)?.updated_at ?? null,
});

interface ProviderBody {
  id?: unknown;
  enabled?: unknown;
  key?: unknown;
}

const asString = (v: unknown): string => (typeof v === "string" ? v : "");

/** A synthetic record supplied directly to the merge diagnostic (test support; no network). */
function toRecord(input: unknown): FetchedRecord {
  const raw = (input ?? {}) as { provider?: unknown; externalId?: unknown; fields?: unknown; media?: unknown };
  return {
    provider: asString(raw.provider) || "synthetic",
    externalId: asString(raw.externalId) || "synthetic",
    media: (asString(raw.media) || "comic") as MediaKind,
    fields: (raw.fields ?? {}) as Metadata,
    licence: { name: "synthetic", url: "" },
  };
}

export function registerProviderRoutes(app: FastifyInstance) {
  // The About -> Metadata sources page: every registered provider's required credit and licence,
  // rendered from the adapters' own metadata so it cannot drift. Visible to any signed-in user; no
  // key or secret is ever included.
  app.get("/api/metadata-sources", async (request, reply) => {
    if (!currentUser(request)) return reply.code(401).send({ error: "Not signed in" });
    return {
      externalEnabled: config.metadataExternalEnabled,
      providers: all().map((reg) => ({
        id: reg.provider.id,
        label: reg.provider.label,
        media: reg.provider.capabilities.media,
        licence: reg.provider.licence,
        attribution: attributionFor(reg.provider),
        covers: reg.provider.covers,
        keyed: reg.keyed,
        enabled: isEnabled(reg),
        configured: isConfigured(reg),
      })),
    };
  });

  app.get("/api/admin/providers", async (request, reply) => {
    if (!requireReviewer(request, reply)) return;
    return { providers: all().map(describe) };
  });

  // Set/clear a key and/or toggle a provider.
  app.post<{ Body: ProviderBody }>("/api/admin/providers", async (request, reply) => {
    const user = requireReviewer(request, reply);
    if (!user) return;
    const id = asString(request.body?.id);
    const reg = id ? get(id) : undefined;
    if (!reg) return reply.code(400).send({ error: "Unknown provider." });

    const changes: string[] = [];
    if (typeof request.body?.enabled === "boolean") {
      const enabled = request.body.enabled;
      setEnabled(id, enabled);
      changes.push(enabled ? "enabled" : "disabled");
      audit(enabled ? "provider_enabled" : "provider_disabled", user.username, request.ip, { provider: id });
      if (!enabled) {
        // Lost trust: drop this provider's cached records and series links (cache policy, M3).
        purgeProviderCache(id);
        forgetProviderLinks(id);
      }
    }
    if ("key" in (request.body ?? {})) {
      const key = asString(request.body.key);
      if (key) {
        setKeySealed(id, seal(key));
        changes.push("key");
        audit("provider_key_set", user.username, request.ip, { provider: id });
      } else {
        setKeySealed(id, null);
        changes.push("key-cleared");
        purgeProviderCache(id);
        audit("provider_key_cleared", user.username, request.ip, { provider: id });
      }
    }
    if (!changes.length) return reply.code(400).send({ error: "Nothing to change (send enabled and/or key)." });
    return { ok: true, provider: describe(reg), changes };
  });

  // Cheap validity probe: one call through the shared client (stub hits /stub/probe).
  app.post<{ Params: { id: string } }>("/api/admin/providers/:id/test", async (request, reply) => {
    if (!requireReviewer(request, reply)) return;
    const reg = get(request.params.id);
    if (!reg) return { ok: false, error: "Unknown provider." };
    try {
      const key = keyFor(reg.provider.id);
      const result = reg.probe
        ? await reg.probe(reg.provider, key)
        : { ok: isConfigured(reg), detail: "No probe defined." };
      return { ok: result.ok, detail: result.detail };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  });

  // Diagnostic preview (used by the framework tests; also a dry-run for an admin). Either merge
  // synthetic records (no network), fetch one record by id (cache-aware), or search + fetch + merge.
  // Admin-triggered and bounded: at most one search and one fetch per call (no-bulk safeguard, M6).
  app.post<{
    Params: { id: string };
    Body: {
      query?: MatchQuery; externalId?: unknown; current?: Metadata; order?: string[];
      force?: MetadataField[]; locked?: MetadataField[]; refresh?: boolean;
      records?: Array<{ provider?: unknown; externalId?: unknown; fields?: unknown; media?: unknown }>;
    };
  }>("/api/admin/providers/:id/preview", async (request, reply) => {
    const user = requireReviewer(request, reply);
    if (!user) return;
    const reg = get(request.params.id);
    if (!reg) return reply.code(404).send({ error: "Unknown provider." });
    const body = request.body ?? {};
    const mergeOpts = { current: body.current, order: body.order, force: body.force, locked: body.locked };
    const id = reg.provider.id;

    if (Array.isArray(body.records)) {
      const merged = mergeRecords({ records: body.records.map(toRecord), ...mergeOpts });
      return { ok: true, provider: id, merged };
    }
    if (!isEnabled(reg)) return { ok: false, reason: "disabled" };
    if (!isConfigured(reg)) return { ok: false, reason: "no-key" };

    try {
      const key = keyFor(id);
      const query = body.query;
      if (query !== undefined && typeof query.title !== "string") {
        return reply.code(400).send({ error: "query.title is required." });
      }
      let candidates: Candidate[] | undefined;
      let externalId = asString(body.externalId);
      if (query) {
        candidates = await reg.provider.search(key, query);
        if (!externalId) externalId = candidates[0]?.externalId ?? "";
      }
      if (!externalId) return { ok: false, reason: "no-match" };
      let record = body.refresh ? null : getCachedRecord(id, externalId);
      const cached = record !== null;
      if (!record) {
        record = await reg.provider.fetch(key, externalId);
        putCachedRecord(record, providerCacheTtlMsFor(id));
      }
      const merged = mergeRecords({ records: [record], ...mergeOpts });
      audit("provider_preview", user.username, request.ip, { provider: id, externalId, cached });
      return { ok: true, provider: id, candidates, record, cached, merged };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  });
}
