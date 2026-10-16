// All runtime settings come from environment variables (set in compose.yaml from ../.env).
import { readFileSync } from "node:fs";

function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Missing required environment variable ${name}`);
  return value;
}

/** The package version, used in the outbound provider User-Agent. Falls back rather than crashing. */
function readVersion(): string {
  try {
    const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as { version?: string };
    return pkg.version ?? "0.0.0";
  } catch {
    return "0.0.0";
  }
}

export const config = {
  port: Number(process.env.PORT ?? 3000),
  // Kavita as seen from inside the compose network.
  kavitaUrl: process.env.KAVITA_URL ?? "http://kavita:5000",
  // Auth key of the companion-svc Kavita admin user.
  kavitaAuthKey: required("KAVITA_AUTH_KEY"),
  // The only origin browsers may send state-changing requests from (CSRF check).
  publicOrigin: required("PUBLIC_ORIGIN"),
  // Kavita's own public address, for "Back to Kavita" and "Open in Kavita" links. compose.yaml always
  // sets KAVITA_PUBLIC_URL; this fallback is only for running the portal on its own.
  kavitaPublicUrl: process.env.KAVITA_PUBLIC_URL ?? "http://localhost:5000",
  dataDir: process.env.DATA_DIR ?? "/data",
  sessionTtlHours: Number(process.env.SESSION_TTL_HOURS ?? 12),
  // How often an open session's Kavita roles are re-read. Lowered in the test environment so the
  // roles test doesn't wait two minutes twice (tests/test_roles_and_limits.py).
  roleRecheckMs: Number(process.env.ROLE_RECHECK_MS ?? 120_000),
  // Encrypts the Kavita session tokens stored with portal sessions (seal.ts). setup.sh generates it.
  sessionSecret: process.env.COMPANION_SECRET ?? "",
  // Requests are only trusted for X-Forwarded-For when they come from Caddy on the compose network.
  trustedProxy: process.env.TRUSTED_PROXY ?? "172.30.0.0/24",

  // Let notification targets point at private/LAN addresses (e.g. a self-hosted ntfy). Off by default
  // because the target is user-supplied and the portal calls it server-side (SSRF). See notify.ts.
  notifyAllowPrivate: process.env.NOTIFY_ALLOW_PRIVATE === "true",

  // ~/media on the host, read-write. Kavita mounts only its library subfolders (read-only) as /data/<lib>.
  mediaDir: process.env.MEDIA_DIR ?? "/media",
  // How Kavita's paths start; /data/comics in Kavita is <mediaDir>/comics here.
  kavitaDataPrefix: process.env.KAVITA_DATA_PREFIX ?? "/data",
  // Staging area for uploads: inside mediaDir (same mount, so approval is an instant rename) but
  // outside every library folder, so Kavita never sees it.
  incomingDir: process.env.INCOMING_DIR ?? "/media/.incoming",
  rejectedRetentionDays: Number(process.env.REJECTED_RETENTION_DAYS ?? 7),

  // Upload limits (CLAUDE.md, Phase 2).
  maxFileGb: Number(process.env.MAX_FILE_GB ?? 8),
  maxPendingGbPerUser: Number(process.env.MAX_PENDING_GB_PER_USER ?? 50),
  maxConcurrentPerUser: Number(process.env.MAX_CONCURRENT_UPLOADS_PER_USER ?? 3),
  minFreeDiskGb: Number(process.env.MIN_FREE_DISK_GB ?? 25),
  abandonedUploadHours: Number(process.env.ABANDONED_UPLOAD_HOURS ?? 24),

  // ---- External metadata providers (phase 2, W1 framework) ----
  // Version string for the outbound provider User-Agent.
  version: readVersion(),
  // Master switch: external lookups stay off until an admin turns external metadata on. Each
  // provider is additionally gated by its own enable flag (a provider_config row, or
  // PROVIDER_<ID>_ENABLED=true). Nothing is enabled by default.
  metadataExternalEnabled: process.env.METADATA_EXTERNAL_ENABLED === "true",
  // Shared outbound HTTP client (providers/http.ts): short timeout, bounded retries, response cap.
  providerHttpTimeoutMs: Number(process.env.PROVIDER_HTTP_TIMEOUT_MS ?? 8000),
  providerHttpRetries: Number(process.env.PROVIDER_HTTP_RETRIES ?? 2),
  providerHttpBackoffMs: Number(process.env.PROVIDER_HTTP_BACKOFF_MS ?? 500),
  providerHttpMaxBytes: Number(process.env.PROVIDER_HTTP_MAX_BYTES ?? 2 * 1024 * 1024),
  // Provider base URLs are operator-set (real adapters hard-code https hosts). Refuse a private/LAN
  // base unless explicitly allowed, so a misconfigured setting cannot turn the portal into an SSRF
  // tool. The test stack points the stub at the Docker gateway and sets this true.
  providersAllowPrivate: process.env.PROVIDERS_ALLOW_PRIVATE === "true",
  // The built-in stub provider, registered only for tests (test use only; never in production).
  providersStub: process.env.PROVIDERS_STUB === "true" || process.env.PROVIDER_STUB_ENABLED === "true",
  providerStubBase: process.env.PROVIDER_STUB_BASE ?? "",
  // Metadata cache TTL: default 30 days, per-provider overrides, and a millisecond knob for tests.
  providerCacheTtlDays: Number(process.env.PROVIDER_CACHE_TTL_DAYS ?? 30),
  providerCacheTtlMs: Number(process.env.PROVIDER_CACHE_TTL_MS ?? 0),
  // Metron (comics) base URL. Real adapters use a fixed HTTPS host; the test stack points this at a
  // local fake (PROVIDERS_ALLOW_PRIVATE). An empty env value falls back to the default.
  metronBaseUrl: (process.env.PROVIDER_METRON_BASE || "https://metron.cloud"),
  // Grand Comics Database (comics fallback) base URL. Same reasoning as Metron.
  gcdBaseUrl: (process.env.PROVIDER_GCD_BASE || "https://www.comics.org"),
  // GCD rate limiting: anonymous is only 30/hour (a 120 s spacing), an account key (HTTP Basic,
  // user:pass) raises it to 2,000/day. Both spacings are overridable so an operator (or the tests)
  // can tighten/loosen them without a rebuild; the defaults match the documented limits.
  gcdMinIntervalMs: Number(process.env.PROVIDER_GCD_MIN_INTERVAL_MS ?? 120_000),
  gcdMinIntervalMsAuthed: Number(process.env.PROVIDER_GCD_MIN_INTERVAL_MS_AUTHED ?? 5_000),
  // MangaDex (manga) base URL. Keyless; server-side only. The test stack points this at a local fake.
  mangadexBaseUrl: (process.env.PROVIDER_MANGADEX_BASE || "https://api.mangadex.org"),
  // MangaDex ~5 requests/s per IP -> a 250 ms spacing; overridable so the tests can set it to 0.
  mangadexMinIntervalMs: Number(process.env.PROVIDER_MANGADEX_MIN_INTERVAL_MS ?? 250),
  // AniList (manga/light novels) GraphQL base URL. Keyless. The test stack points this at a local fake.
  anilistBaseUrl: (process.env.PROVIDER_ANILIST_BASE || "https://graphql.anilist.co"),
  // AniList 90/min documented but degraded to 30/min -> a 2 s spacing; overridable for the tests.
  anilistMinIntervalMs: Number(process.env.PROVIDER_ANILIST_MIN_INTERVAL_MS ?? 2_000),
};

// ---- Per-provider settings ----------------------------------------------------------------
// A provider reads its key/enable/base/TTL from PROVIDER_<ID>_* so a `.env` can seed any provider
// (the admin UI is the normal path; `.env` wins when both are set, so an operator can pin a value).

export function providerEnvKey(id: string): string | null {
  return process.env[`PROVIDER_${id.toUpperCase()}_KEY`] || null;
}

export function providerEnvEnabled(id: string): boolean {
  return process.env[`PROVIDER_${id.toUpperCase()}_ENABLED`] === "true";
}

export function providerCacheTtlMsFor(id: string): number {
  const ms = Number(process.env[`PROVIDER_${id.toUpperCase()}_CACHE_TTL_MS`] ?? 0);
  if (ms > 0) return ms;
  if (config.providerCacheTtlMs > 0) return config.providerCacheTtlMs;
  const days = Number(process.env[`PROVIDER_${id.toUpperCase()}_CACHE_TTL_DAYS`] ?? 0);
  return (days > 0 ? days : config.providerCacheTtlDays) * 86_400_000;
}
