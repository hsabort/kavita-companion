// Thin client for the Kavita REST API. Endpoint shapes are documented in ../../CLAUDE.md
// ("Kavita API facts"), verified against the live v0.9.1.4 server.
import { config } from "./config.js";

export interface KavitaUser {
  id: number;
  username: string;
  roles: string[];
}

export type LoginResult =
  | { ok: true; user: KavitaUser; token: string; tokens: { token: string; refreshToken: string } }
  | { ok: false; reason: "invalid" | "disabled" | "unavailable" };

export interface KavitaLibrary {
  id: number;
  name: string;
  type: number;
  folders: string[];
}

const TIMEOUT_MS = 10_000;

async function kavitaFetch(path: string, init: RequestInit = {}, withKey = true): Promise<Response> {
  const headers = new Headers(init.headers);
  headers.set("Content-Type", "application/json");
  if (withKey) headers.set("x-api-key", config.kavitaAuthKey);
  return fetch(config.kavitaUrl + path, { ...init, headers, signal: AbortSignal.timeout(TIMEOUT_MS) });
}

/** Check a username/password with Kavita. The Kavita token is discarded; we only need identity and roles. */
export async function login(username: string, password: string): Promise<LoginResult> {
  let res: Response;
  try {
    res = await kavitaFetch(
      "/api/Account/login",
      { method: "POST", body: JSON.stringify({ username, password }) },
      false,
    );
  } catch {
    return { ok: false, reason: "unavailable" };
  }
  if (res.ok) {
    const body = (await res.json()) as { id: number; username: string; roles: string[] | null; token: string; refreshToken: string };
    // The session is used to add the sidebar link (sidebar.ts) and, stored encrypted with the portal
    // session, to follow the user's theme (auth.ts sessionThemeId).
    return {
      ok: true, user: { id: body.id, username: body.username, roles: body.roles ?? [] }, token: body.token,
      tokens: { token: body.token, refreshToken: body.refreshToken },
    };
  }
  if (res.status === 401) {
    const text = await res.text();
    return { ok: false, reason: /disabled/i.test(text) ? "disabled" : "invalid" };
  }
  return { ok: false, reason: "unavailable" };
}

/**
 * Sign in with a user's own auth key (what Kavita's sidebar link carries). Kavita checks the key
 * and returns the user, as for a password login.
 */
export async function loginWithAuthKey(apiKey: string): Promise<LoginResult> {
  let res: Response;
  try {
    res = await kavitaFetch(
      `/api/Plugin/authenticate?apiKey=${encodeURIComponent(apiKey)}&pluginName=kavita-companion`,
      { method: "POST" },
      false,
    );
  } catch {
    return { ok: false, reason: "unavailable" };
  }
  if (res.ok) {
    // This endpoint returns the right username but no roles and id 0 (Kavita v0.9.1.4), so take
    // the real id and roles from the admin user list.
    const body = (await res.json()) as { username: string; token: string; refreshToken: string };
    let match: KavitaUser | undefined;
    try {
      match = (await users()).find((u) => u.username.localeCompare(body.username, undefined, { sensitivity: "accent" }) === 0);
    } catch {
      return { ok: false, reason: "unavailable" };
    }
    if (!match) return { ok: false, reason: "invalid" };
    return { ok: true, user: match, token: body.token, tokens: { token: body.token, refreshToken: body.refreshToken } };
  }
  if (res.status === 401 || res.status === 400 || res.status === 404) return { ok: false, reason: "invalid" };
  return { ok: false, reason: "unavailable" };
}

/** GET with the portal's admin key, parsed as JSON. */
export async function adminGet(path: string): Promise<unknown> {
  const res = await kavitaFetch(path);
  if (!res.ok) throw new Error(`Kavita ${path}: HTTP ${res.status}`);
  return res.json();
}

/** GET with the portal's admin key, as text (e.g. a theme's CSS). */
export async function adminGetText(path: string): Promise<string> {
  const res = await kavitaFetch(path);
  if (!res.ok) throw new Error(`Kavita ${path}: HTTP ${res.status}`);
  return res.text();
}

/** Call Kavita as a specific user (their session token from a login). */
export async function asUser(token: string, method: string, path: string, body?: unknown): Promise<Response> {
  return kavitaFetch(path, {
    method,
    body: body === undefined ? undefined : JSON.stringify(body),
    headers: { Authorization: `Bearer ${token}` },
  }, false);
}

export async function libraries(): Promise<KavitaLibrary[]> {
  const res = await kavitaFetch("/api/Library/libraries");
  if (!res.ok) throw new Error(`Kavita libraries: HTTP ${res.status}`);
  return (await res.json()) as KavitaLibrary[];
}

/** All Kavita users with their current roles (admin key). */
export async function users(): Promise<KavitaUser[]> {
  const res = await kavitaFetch("/api/Users");
  if (!res.ok) throw new Error(`Kavita users: HTTP ${res.status}`);
  const list = (await res.json()) as { id: number; username: string; roles: string[] | null }[];
  return list.map((u) => ({ id: u.id, username: u.username, roles: u.roles ?? [] }));
}

export interface KavitaSeries {
  id: number;
  name: string;
  folderPath: string;
}

/** Every series in a library (paged through 500 at a time). */
export async function seriesInLibrary(libraryId: number): Promise<KavitaSeries[]> {
  const filter = { statements: [{ comparison: 0, field: 19, value: String(libraryId) }], combination: 1 };
  const all: KavitaSeries[] = [];
  for (let page = 1; ; page++) {
    const res = await kavitaFetch(`/api/Series/v2?PageNumber=${page}&PageSize=500`, {
      method: "POST",
      body: JSON.stringify(filter),
    });
    if (!res.ok) throw new Error(`Kavita series: HTTP ${res.status}`);
    const batch = (await res.json()) as KavitaSeries[];
    all.push(...batch.map((s) => ({ id: s.id, name: s.name, folderPath: s.folderPath })));
    if (batch.length < 500) return all;
  }
}

/** Issue/chapter and volume numbers already in a series (Kavita's "none" markers left out). */
export async function seriesContents(seriesId: number): Promise<{ numbers: string[]; volumes: string[] }> {
  const res = await kavitaFetch(`/api/Series/volumes?seriesId=${seriesId}`);
  if (!res.ok) throw new Error(`Kavita volumes: HTTP ${res.status}`);
  const vols = (await res.json()) as { minNumber: number; name: string; chapters: { minNumber: number; range: string }[] }[];
  const numbers = new Set<string>();
  const volumes = new Set<string>();
  for (const v of vols) {
    if (v.minNumber > -1000) volumes.add(String(v.minNumber));
    for (const c of v.chapters) if (c.minNumber > -1000) numbers.add(String(c.minNumber));
  }
  return { numbers: [...numbers], volumes: [...volumes] };
}

/** Paths (Kavita's, e.g. /data/comics/Saga/Saga #001.cbz) of every file in a series. */
export async function seriesFiles(seriesId: number): Promise<string[]> {
  const res = await kavitaFetch(`/api/Series/volumes?seriesId=${seriesId}`);
  if (!res.ok) throw new Error(`Kavita volumes: HTTP ${res.status}`);
  const vols = (await res.json()) as { chapters: { files: { filePath: string }[] | null }[] }[];
  return vols.flatMap((v) => v.chapters.flatMap((c) => (c.files ?? []).map((f) => f.filePath)));
}

/** A series' metadata (summary, credits, genre, ...), for the review screen's suggestions. */
export async function seriesMetadata(seriesId: number): Promise<Record<string, unknown>> {
  return (await adminGet(`/api/Series/metadata?seriesId=${seriesId}`)) as Record<string, unknown>;
}

/** Queue a scan of a whole library (picks up removed folders, unlike scan-folder). */
export async function scanLibrary(libraryId: number): Promise<void> {
  const res = await kavitaFetch(`/api/Library/scan?libraryId=${libraryId}&force=false`, { method: "POST" });
  if (!res.ok) throw new Error(`Kavita library scan: HTTP ${res.status}`);
}

export interface ParsedName {
  seriesName: string;
  minVolumeNumber: number;
  minChapterNumber: number;
}

/** Kavita's own file-name parser, so suggestions match how Kavita will read the file. */
export async function parseName(filename: string, libraryType: number): Promise<ParsedName | null> {
  const res = await kavitaFetch(
    `/api/Plugin/parse?name=${encodeURIComponent(filename)}&libraryType=${libraryType}`,
  );
  if (!res.ok) return null;
  return (await res.json()) as ParsedName;
}

/** Ask Kavita to scan one folder (a Kavita path, e.g. /data/comics/Saga). Queued; takes ~1 minute. */
export async function scanFolder(kavitaFolderPath: string): Promise<void> {
  const res = await kavitaFetch("/api/Library/scan-folder", {
    method: "POST",
    body: JSON.stringify({ apiKey: config.kavitaAuthKey, folderPath: kavitaFolderPath, abortOnNoSeriesMatch: false }),
  });
  if (!res.ok) throw new Error(`Kavita scan-folder: HTTP ${res.status}`);
}

// Libraries change rarely; avoid a Kavita round trip on every upload.
let libraryCache: { at: number; value: KavitaLibrary[] } | null = null;
const LIBRARY_CACHE_MS = 5 * 60_000;

export async function librariesCached(): Promise<KavitaLibrary[]> {
  if (libraryCache && Date.now() - libraryCache.at < LIBRARY_CACHE_MS) return libraryCache.value;
  const value = await libraries();
  libraryCache = { at: Date.now(), value };
  return value;
}
