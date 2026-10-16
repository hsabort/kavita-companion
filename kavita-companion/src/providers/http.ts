// Shared outbound HTTP client for external metadata providers (phase 2, W1). Every provider request
// goes through here so the obligations are implemented once:
//   - a truthful, identifying User-Agent (MangaDex/Open Library require one);
//   - a short per-provider timeout;
//   - bounded retries with exponential backoff + jitter on network errors, 5xx and 429;
//   - Retry-After honoured on 429/503 (a cooldown the next call waits out);
//   - a simple per-provider token bucket (rate limit);
//   - a response size cap;
//   - defensive JSON parsing, and a hook to strip HTML from provider text.
//
// Provider base URLs are operator-set constants, not user input, but a private/LAN base is refused
// unless PROVIDERS_ALLOW_PRIVATE is set (the test stack points the stub at the Docker gateway), so a
// misconfiguration cannot silently turn the portal into an SSRF tool. Same reasoning as notify.ts.
import { config } from "../config.js";

export const USER_AGENT = `kavita-companion/${config.version} (+${config.publicOrigin})`;

export type ProviderErrorCode = "timeout" | "network" | "http" | "size" | "json" | "cooldown" | "url";

export class ProviderHttpError extends Error {
  constructor(public code: ProviderErrorCode, message: string, public status?: number, public retryAfterMs?: number) {
    super(message);
    this.name = "ProviderHttpError";
  }
}

export interface ProviderFetchOptions {
  /** Provider id, for the token bucket, cooldown and log/audit context. */
  provider: string;
  url: string;
  method?: string;
  headers?: Record<string, string>;
  body?: string;
  signal?: AbortSignal;
  /** Bearer token; set as Authorization when the caller has no explicit Authorization header. */
  key?: string | null;
  timeoutMs?: number;
  maxBytes?: number;
  retries?: number;
  /** Minimum spacing between two calls to this provider (token bucket, capacity 1). */
  minIntervalMs?: number;
  /** Custom User-Agent; defaults to the shared truthful one. */
  userAgent?: string;
  accept?: string;
}

export interface ProviderResponse {
  status: number;
  headers: Headers;
  text: string;
  url: string;
}

const sleep = (ms: number, signal?: AbortSignal) =>
  new Promise<void>((resolve, reject) => {
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener("abort", () => { clearTimeout(timer); reject(signal.reason); }, { once: true });
  });

// ---------- Per-provider rate limiting and cooldown ----------

const lastCall = new Map<string, number>();
const cooldownUntil = new Map<string, number>();

/** Wait for the provider's token bucket (one token per `minIntervalMs`) and any 429 cooldown. */
async function throttle(provider: string, minIntervalMs: number, signal?: AbortSignal): Promise<void> {
  const until = cooldownUntil.get(provider) ?? 0;
  const last = lastCall.get(provider) ?? 0;
  const now = Date.now();
  const wait = Math.max(until - now, minIntervalMs > 0 ? last + minIntervalMs - now : 0);
  if (wait > 0) await sleep(wait, signal);
  lastCall.set(provider, Date.now());
}

/** When a provider is cooling down after a 429/503, and for how much longer. */
export function providerCooldownMs(provider: string): number {
  return Math.max(0, (cooldownUntil.get(provider) ?? 0) - Date.now());
}

/** Parse Retry-After (seconds or HTTP-date). Null when absent/unparseable. */
export function parseRetryAfter(value: string | null): number | null {
  if (!value) return null;
  const seconds = Number(value.trim());
  if (Number.isFinite(seconds)) return Math.max(0, seconds * 1000);
  const date = Date.parse(value);
  return Number.isFinite(date) ? Math.max(0, date - Date.now()) : null;
}

// ---------- URL guard ----------

const isPrivateHost = (host: string): boolean =>
  host === "localhost" || host === "::1" || host.endsWith(".localhost")
  || /^127\./.test(host) || /^10\./.test(host) || /^192\.168\./.test(host)
  || /^169\.254\./.test(host) || /^172\.(1[6-9]|2\d|3[01])\./.test(host) || /^0\./.test(host);

/** Normalise a provider base URL and refuse private/LAN or non-http(s) hosts unless allowed. */
export function assertAllowedProviderUrl(raw: string): URL {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new ProviderHttpError("url", `Invalid provider URL`);
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    throw new ProviderHttpError("url", `Provider URL must be http(s)`);
  }
  if (!config.providersAllowPrivate) {
    if (url.protocol !== "https:") throw new ProviderHttpError("url", "Provider URL must be https");
    if (isPrivateHost(url.hostname.toLowerCase())) {
      throw new ProviderHttpError("url", "Provider URL is a private address (set PROVIDERS_ALLOW_PRIVATE to allow)");
    }
  }
  return url;
}

// ---------- Response reading ----------

async function readCapped(res: Response, provider: string, maxBytes: number): Promise<string> {
  const body = res.body;
  if (!body) return await res.text();
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (!value) continue;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel().catch(() => undefined);
      throw new ProviderHttpError("size", `${provider}: response exceeds ${maxBytes} bytes`, res.status);
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks.map((c) => Buffer.from(c))).toString("utf8");
}

/** One provider request, with retries/backoff, Retry-After, rate limiting and a size cap. */
export async function providerFetch(opts: ProviderFetchOptions): Promise<ProviderResponse> {
  const url = assertAllowedProviderUrl(opts.url).toString();
  const retries = opts.retries ?? config.providerHttpRetries;
  const timeoutMs = opts.timeoutMs ?? config.providerHttpTimeoutMs;
  const maxBytes = opts.maxBytes ?? config.providerHttpMaxBytes;
  const backoffBase = config.providerHttpBackoffMs;
  const headers: Record<string, string> = {
    "User-Agent": opts.userAgent ?? USER_AGENT,
    ...(opts.accept ? { Accept: opts.accept } : {}),
    ...(opts.headers ?? {}),
  };
  if (opts.key && !headers.Authorization && !headers.authorization) headers.Authorization = `Bearer ${opts.key}`;

  for (let attempt = 0; ; attempt++) {
    await throttle(opts.provider, opts.minIntervalMs ?? 0, opts.signal);
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(new ProviderHttpError("timeout", `${opts.provider}: request timed out`)), timeoutMs);
    const signal = opts.signal ? AbortSignal.any([opts.signal, controller.signal]) : controller.signal;
    let res: Response;
    try {
      res = await fetch(url, { method: opts.method ?? "GET", headers, body: opts.body, signal, redirect: "error" });
    } catch (err) {
      clearTimeout(timeout);
      const timedOut = controller.signal.aborted
        || (err instanceof Error && (err.name === "TimeoutError" || err.name === "AbortError" && controller.signal.aborted));
      if (opts.signal?.aborted) throw err;
      if (attempt < retries && (timedOut || !(err instanceof ProviderHttpError))) {
        await sleep(backoff(backoffBase, attempt), opts.signal);
        continue;
      }
      if (err instanceof ProviderHttpError) throw err;
      throw new ProviderHttpError(timedOut ? "timeout" : "network", `${opts.provider}: ${err instanceof Error ? err.message : String(err)}`);
    }

    const retryAfterMs = parseRetryAfter(res.headers.get("retry-after"));
    const retryable = res.status === 429 || res.status === 503 || res.status >= 500;
    if (retryable) {
      await res.body?.cancel().catch(() => undefined);
      clearTimeout(timeout);
      if (retryAfterMs && retryAfterMs > 0) cooldownUntil.set(opts.provider, Date.now() + retryAfterMs);
      if (attempt < retries) {
        await sleep(retryAfterMs ?? backoff(backoffBase, attempt), opts.signal);
        continue;
      }
      throw new ProviderHttpError("http", `${opts.provider}: HTTP ${res.status}`, res.status, retryAfterMs ?? undefined);
    }

    let text: string;
    try {
      text = await readCapped(res, opts.provider, maxBytes);
    } finally {
      clearTimeout(timeout);
    }
    return { status: res.status, headers: res.headers, text, url };
  }
}

function backoff(base: number, attempt: number): number {
  const capped = Math.min(base * 2 ** attempt, 8000);
  return capped + Math.floor(Math.random() * Math.min(capped, 250)); // jitter
}

/** Fetch JSON, rejecting HTML bodies and invalid JSON with a typed error. */
export async function providerFetchJson<T = unknown>(opts: ProviderFetchOptions): Promise<T> {
  const res = await providerFetch({ accept: "application/json", ...opts });
  const trimmed = res.text.trimStart();
  if (trimmed.startsWith("<")) throw new ProviderHttpError("json", `${opts.provider}: expected JSON, got HTML`, res.status);
  try {
    return JSON.parse(res.text) as T;
  } catch {
    throw new ProviderHttpError("json", `${opts.provider}: invalid JSON`, res.status);
  }
}

// ---------- Text hygiene ----------

const ENTITIES: Record<string, string> = {
  "&amp;": "&", "&lt;": "<", "&gt;": ">", "&quot;": '"', "&#39;": "'", "&apos;": "'", "&nbsp;": " ",
};

/** Provider text is untrusted: strip tags, decode a few entities and collapse whitespace. */
export function plainText(value: unknown): string {
  if (typeof value !== "string") return "";
  return value
    .replace(/<[^>]*>/g, " ")
    .replace(/&#(\d+);/g, (_m, n: string) => String.fromCodePoint(Number(n)))
    .replace(/&[a-zA-Z#0-9]+;/g, (m) => ENTITIES[m] ?? " ")
    .replace(/\s+/g, " ")
    .trim();
}
