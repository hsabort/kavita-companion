import { createHash, randomBytes } from "node:crypto";
import type { FastifyReply, FastifyRequest } from "fastify";
import { config } from "./config.js";
import { audit, db } from "./db.js";
import { seal, unseal } from "./seal.js";
import * as kavita from "./kavita.js";
import type { KavitaUser } from "./kavita.js";

// __Host- prefix: browser only accepts it over HTTPS, with Path=/ and no Domain, so it can't be
// set or overridden by another site or subdomain.
export const SESSION_COOKIE = "__Host-kc_session";

export interface SessionUser {
  id: number;
  username: string;
  themeId: number | null;
  canUpload: boolean;
  isReviewer: boolean;
}

/** Upload rule (CLAUDE.md, Phase 2): any Kavita user who can log in and isn't Read Only. Admins review. */
export function permissions(roles: string[]) {
  return {
    canUpload: roles.includes("Login") && !roles.includes("Read Only"),
    isReviewer: roles.includes("Admin"),
  };
}

const hash = (token: string) => createHash("sha256").update(token).digest("hex");

const insertSession = db.prepare(
  `INSERT INTO sessions (token_hash, user_id, username, roles, created_at, expires_at, ip, roles_checked_at, theme_id,
     kavita_token, kavita_refresh, theme_checked_at)
   VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
);
const selectForRecheck = db.prepare(
  "SELECT user_id, roles_checked_at FROM sessions WHERE token_hash = ? AND expires_at > ?",
);
const updateRoles = db.prepare("UPDATE sessions SET roles = ?, roles_checked_at = ? WHERE user_id = ?");
const deleteUserSessions = db.prepare("DELETE FROM sessions WHERE user_id = ?");
const selectSession = db.prepare(
  "SELECT user_id, username, roles, theme_id FROM sessions WHERE token_hash = ? AND expires_at > ?",
);
const deleteSession = db.prepare("DELETE FROM sessions WHERE token_hash = ?");
const deleteExpired = db.prepare("DELETE FROM sessions WHERE expires_at <= ?");

export interface KavitaTokens { token: string; refreshToken: string }

export function createSession(
  reply: FastifyReply, user: KavitaUser, ip: string, themeId: number | null = null, kavitaTokens: KavitaTokens | null = null,
) {
  const token = randomBytes(32).toString("base64url");
  const now = Date.now();
  const ttlMs = config.sessionTtlHours * 3_600_000;
  insertSession.run(hash(token), user.id, user.username, JSON.stringify(user.roles), now, now + ttlMs, ip, now, themeId,
    kavitaTokens ? seal(kavitaTokens.token) : null, kavitaTokens ? seal(kavitaTokens.refreshToken) : null, now);
  reply.setCookie(SESSION_COOKIE, token, {
    path: "/",
    httpOnly: true,
    secure: true,
    sameSite: "strict",
    maxAge: ttlMs / 1000,
  });
}

export function currentUser(request: FastifyRequest): SessionUser | null {
  const token = request.cookies[SESSION_COOKIE];
  if (!token) return null;
  const row = selectSession.get(hash(token), Date.now()) as
    | { user_id: number; username: string; roles: string; theme_id: number | null }
    | undefined;
  if (!row) return null;
  return { id: row.user_id, username: row.username, themeId: row.theme_id, ...permissions(JSON.parse(row.roles) as string[]) };
}

export function endSession(request: FastifyRequest, reply: FastifyReply) {
  const token = request.cookies[SESSION_COOKIE];
  if (token) deleteSession.run(hash(token));
  reply.clearCookie(SESSION_COOKIE, { path: "/", secure: true, httpOnly: true, sameSite: "strict" });
}

// ---------- Keeping roles current ----------
// Roles are copied from Kavita at login. So that disabling someone, making them Read Only or
// removing Admin in Kavita takes effect promptly, a session's roles are re-read from Kavita when
// they're older than ROLE_RECHECK_MS. One Kavita call serves every session (USERS_CACHE_MS).

const ROLE_RECHECK_MS = 2 * 60_000;
const USERS_CACHE_MS = 30_000;
let usersCache: { at: number; byId: Map<number, KavitaUser> } | null = null;

async function kavitaUsersById(): Promise<Map<number, KavitaUser>> {
  if (usersCache && Date.now() - usersCache.at < USERS_CACHE_MS) return usersCache.byId;
  const list = await kavita.users();
  usersCache = { at: Date.now(), byId: new Map(list.map((u) => [u.id, u])) };
  return usersCache.byId;
}

/**
 * Run before any handler that reads the session. Signs the user out everywhere if their Kavita
 * account is gone or can no longer log in; otherwise refreshes their roles. If Kavita can't be
 * reached, the current roles stand and the check is retried on the next request.
 */
export async function recheckSessionRoles(request: FastifyRequest): Promise<void> {
  const token = request.cookies[SESSION_COOKIE];
  if (!token) return;
  const row = selectForRecheck.get(hash(token), Date.now()) as { user_id: number; roles_checked_at: number } | undefined;
  if (!row || Date.now() - row.roles_checked_at < ROLE_RECHECK_MS) return;
  let byId: Map<number, KavitaUser>;
  try {
    byId = await kavitaUsersById();
  } catch (err) {
    request.log.warn({ err }, "role re-check skipped: Kavita unreachable");
    return;
  }
  const user = byId.get(row.user_id);
  if (!user || !user.roles.includes("Login")) {
    deleteUserSessions.run(row.user_id);
    audit("session_revoked", user?.username ?? null, request.ip, { userId: row.user_id, reason: user ? "login role removed" : "user deleted" });
    return;
  }
  updateRoles.run(JSON.stringify(user.roles), Date.now(), row.user_id);
}

// ---------- Following the user's Kavita theme while signed in ----------

const THEME_RECHECK_MS = 5_000;
const selectThemeState = db.prepare(
  "SELECT theme_id, kavita_token, kavita_refresh, theme_checked_at FROM sessions WHERE token_hash = ? AND expires_at > ?",
);
const updateTheme = db.prepare("UPDATE sessions SET theme_id = ?, theme_checked_at = ? WHERE token_hash = ?");
const updateTokens = db.prepare("UPDATE sessions SET kavita_token = ?, kavita_refresh = ? WHERE token_hash = ?");

async function preferencesTheme(token: string): Promise<{ status: number; themeId: number | null }> {
  const res = await kavita.asUser(token, "GET", "/api/Users/get-preferences");
  if (!res.ok) return { status: res.status, themeId: null };
  const prefs = (await res.json()) as { theme?: { id?: number } | null };
  return { status: 200, themeId: prefs.theme?.id ?? null };
}

/**
 * The session's Kavita theme id, re-read from Kavita (with the user's own Kavita session) at most every
 * few seconds, so a theme change in Kavita reaches an open portal tab. Falls back to the last known theme.
 */
export async function sessionThemeId(request: FastifyRequest): Promise<number | null> {
  const cookie = request.cookies[SESSION_COOKIE];
  if (!cookie) return null;
  const tokenHash = hash(cookie);
  const row = selectThemeState.get(tokenHash, Date.now()) as
    | { theme_id: number | null; kavita_token: string | null; kavita_refresh: string | null; theme_checked_at: number | null }
    | undefined;
  if (!row) return null;
  const token = unseal(row.kavita_token);
  if (!token || Date.now() - (row.theme_checked_at ?? 0) < THEME_RECHECK_MS) return row.theme_id;
  try {
    let result = await preferencesTheme(token);
    if (result.status === 401) {
      // Kavita session expired: renew it once with the refresh token.
      const res = await kavita.asUser(token, "POST", "/api/Account/refresh-token", { token, refreshToken: unseal(row.kavita_refresh) });
      if (res.ok) {
        const renewed = (await res.json()) as { token: string; refreshToken: string };
        updateTokens.run(seal(renewed.token), seal(renewed.refreshToken), tokenHash);
        result = await preferencesTheme(renewed.token);
      }
    }
    if (result.status !== 200) return row.theme_id;
    updateTheme.run(result.themeId, Date.now(), tokenHash);
    return result.themeId;
  } catch {
    return row.theme_id;
  }
}

export function purgeExpiredSessions() {
  deleteExpired.run(Date.now());
}
