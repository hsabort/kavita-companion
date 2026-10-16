// The provider registry: the single source of truth for which adapters exist and which are usable.
//
// A provider is *usable* when external metadata is on, its enable flag is set, and (for a keyed
// provider) it has a key. Keys are resolved `.env` first (PROVIDER_<ID>_KEY), then the sealed value
// in provider_config. Enable state is a provider_config row when one exists, otherwise the
// PROVIDER_<ID>_ENABLED environment value. Nothing is enabled by default.
//
// Keyedness/TTL/rate limit live here as registration metadata rather than on the Provider interface,
// which the orchestrator owns and which stays verbatim in types.ts.
import { config, providerEnvEnabled, providerEnvKey } from "../config.js";
import { db } from "../db.js";
import { unseal } from "../seal.js";
import { createStubProvider, stubProbe } from "./stub.js";
import type { MediaKind, Provider } from "./types.js";

export interface ProviderRegistration {
  provider: Provider;
  /** Keyed providers are usable only once an admin key (or .env key) is present. */
  keyed: boolean;
  /** Minimum spacing between calls to this provider (the token bucket, capacity 1). 0 = unlimited. */
  minIntervalMs: number;
  /** Cheap validity probe for the admin test route. */
  probe?: (provider: Provider, key: string | null) => Promise<{ ok: boolean; detail?: string }>;
}

const registry = new Map<string, ProviderRegistration>();

export function register(reg: ProviderRegistration): void {
  registry.set(reg.provider.id, reg);
}

export function get(id: string): ProviderRegistration | undefined {
  return registry.get(id);
}

export function all(): ProviderRegistration[] {
  return [...registry.values()];
}

// ---------- provider_config ----------

interface ConfigRow { provider: string; key_sealed: string | null; enabled: number; updated_at: number }

const selectConfig = db.prepare("SELECT provider, key_sealed, enabled, updated_at FROM provider_config WHERE provider = ?");
const upsertEnabled = db.prepare(
  `INSERT INTO provider_config (provider, key_sealed, enabled, updated_at) VALUES (?, NULL, ?, ?)
   ON CONFLICT(provider) DO UPDATE SET enabled = excluded.enabled, updated_at = excluded.updated_at`,
);
const upsertKey = db.prepare(
  `INSERT INTO provider_config (provider, key_sealed, enabled, updated_at) VALUES (?, ?, 0, ?)
   ON CONFLICT(provider) DO UPDATE SET key_sealed = excluded.key_sealed, updated_at = excluded.updated_at`,
);

export function configRow(id: string): ConfigRow | undefined {
  return selectConfig.get(id) as ConfigRow | undefined;
}

export function setEnabled(id: string, enabled: boolean): void {
  upsertEnabled.run(id, enabled ? 1 : 0, Date.now());
}

/** Store (sealed) or clear a provider key. */
export function setKeySealed(id: string, sealed: string | null): void {
  upsertKey.run(id, sealed, Date.now());
}

// ---------- Resolution ----------

/** The key to use for a provider: `.env` override wins, then the sealed DB value. */
export function keyFor(id: string): string | null {
  return providerEnvKey(id) ?? unseal(configRow(id)?.key_sealed ?? null);
}

export function hasKey(id: string): boolean {
  return keyFor(id) !== null;
}

/** Per-provider enable flag (ignores the master switch); env seeds it until an admin row exists. */
export function isEnabled(reg: ProviderRegistration): boolean {
  const row = configRow(reg.provider.id);
  return row ? row.enabled === 1 : providerEnvEnabled(reg.provider.id);
}

/** Keyed providers need a key; keyless ones are always configured. */
export function isConfigured(reg: ProviderRegistration): boolean {
  return !reg.keyed || hasKey(reg.provider.id);
}

/**
 * Providers usable for a media class right now: external metadata on, enabled, configured, and
 * able to serve that media. Ordered as registered.
 */
export function enabledFor(media: MediaKind): ProviderRegistration[] {
  if (!config.metadataExternalEnabled) return [];
  return all().filter((reg) => reg.provider.capabilities.media.includes(media) && isEnabled(reg) && isConfigured(reg));
}

/** Register the built-in test stub when its flag is set. Called once, at module load. */
export function registerBuiltins(): void {
  if (config.providersStub) {
    register({ provider: createStubProvider(), keyed: true, minIntervalMs: 0, probe: stubProbe });
  }
}

registerBuiltins();
