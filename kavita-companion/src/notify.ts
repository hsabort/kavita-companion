// Tell uploaders what happened to their uploads (approved / rejected / fixed / invalid / duplicate)
// through a webhook, ntfy or Discord, chosen per Kavita user. Delivery is asynchronous: events go into
// the `notifications` outbox and a worker sends them with retries, so review never waits on the
// network. Email (via Kavita's SMTP) is a later step.
import type { FastifyInstance } from "fastify";
import { currentUser } from "./auth.js";
import { config } from "./config.js";
import { db } from "./db.js";

const CHANNELS = new Set(["webhook", "ntfy", "discord"]);
export const NOTIFY_EVENTS = ["approved", "rejected", "fixed", "invalid", "duplicate", "request"] as const;
const EVENTS = new Set<string>(NOTIFY_EVENTS);
const DELIVERY_TIMEOUT_MS = 10_000;
const MAX_ATTEMPTS = 5;
const PENDING_BATCH = 20;
const KEEP_DELIVERED_MS = 30 * 86_400_000;

export interface Prefs {
  channel: string;
  target: string;
  events: string[];
}

const selectPrefs = db.prepare("SELECT channel, target, events FROM notification_prefs WHERE user_id = ?");
const upsertPrefs = db.prepare(
  `INSERT INTO notification_prefs (user_id, channel, target, events, updated_at)
   VALUES (?, ?, ?, ?, ?)
   ON CONFLICT(user_id) DO UPDATE SET channel = excluded.channel, target = excluded.target,
     events = excluded.events, updated_at = excluded.updated_at`,
);
const deletePrefs = db.prepare("DELETE FROM notification_prefs WHERE user_id = ?");
const insertNotification = db.prepare(
  `INSERT INTO notifications (user_id, event, title, body, url, channel, target, created_at)
   VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
);
const selectPending = db.prepare(
  `SELECT id, event, channel, target, title, body, url FROM notifications
   WHERE delivered_at IS NULL AND attempts < ? ORDER BY id LIMIT ?`,
);
const markDelivered = db.prepare("UPDATE notifications SET delivered_at = ?, last_error = NULL WHERE id = ?");
const markFailed = db.prepare("UPDATE notifications SET attempts = attempts + 1, last_error = ? WHERE id = ?");
const purgeDelivered = db.prepare("DELETE FROM notifications WHERE delivered_at IS NOT NULL AND delivered_at < ?");

export function getPrefs(userId: number): Prefs | null {
  const row = selectPrefs.get(userId) as { channel: string; target: string; events: string } | undefined;
  if (!row) return null;
  let events: string[] = [];
  try {
    events = JSON.parse(row.events) as string[];
  } catch {
    events = [];
  }
  return { channel: row.channel, target: row.target, events };
}

export function setPrefs(userId: number, prefs: Prefs) {
  if (prefs.channel === "off") {
    deletePrefs.run(userId);
    return;
  }
  upsertPrefs.run(userId, prefs.channel, prefs.target, JSON.stringify(prefs.events), Date.now());
}

/**
 * A URL the portal is willing to call server-side. http(s) only; unless NOTIFY_ALLOW_PRIVATE is on,
 * loopback/link-local/private addresses are refused and https is required, because the target is
 * user-supplied and the server calls it (SSRF). Returns the normalised URL, or null.
 */
export function safeTarget(raw: string): string | null {
  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    return null;
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") return null;
  if (config.notifyAllowPrivate) return url.toString();
  if (url.protocol !== "https:") return null;
  const host = url.hostname.toLowerCase();
  const isPrivate = host === "localhost" || host === "::1" || host.endsWith(".localhost")
    || /^127\./.test(host) || /^10\./.test(host) || /^192\.168\./.test(host)
    || /^169\.254\./.test(host) || /^172\.(1[6-9]|2\d|3[01])\./.test(host) || /^0\./.test(host);
  return isPrivate ? null : url.toString();
}

async function deliver(event: string, channel: string, target: string, title: string, body: string, url: string | null): Promise<void> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), DELIVERY_TIMEOUT_MS);
  try {
    let response: Awaited<ReturnType<typeof fetch>>;
    if (channel === "ntfy") {
      response = await fetch(target, {
        method: "POST",
        headers: { Title: title, ...(url ? { Click: url } : {}) },
        body,
        signal: controller.signal,
      });
    } else if (channel === "discord") {
      response = await fetch(target, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ content: url ? `${title}\n${body}\n${url}` : `${title}\n${body}` }),
        signal: controller.signal,
      });
    } else {
      response = await fetch(target, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ event, title, body, url }),
        signal: controller.signal,
      });
    }
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
  } finally {
    clearTimeout(timer);
  }
}

/** Send the queued notifications (oldest first, retrying failures). Called on enqueue and hourly. */
export async function drainNotifications(): Promise<void> {
  const rows = selectPending.all(MAX_ATTEMPTS, PENDING_BATCH) as unknown as {
    id: number; event: string; channel: string; target: string; title: string; body: string; url: string | null;
  }[];
  for (const row of rows) {
    try {
      await deliver(row.event, row.channel, row.target, row.title, row.body, row.url);
      markDelivered.run(Date.now(), row.id);
    } catch (err) {
      markFailed.run((err instanceof Error ? err.message : String(err)).slice(0, 300), row.id);
    }
  }
  purgeDelivered.run(Date.now() - KEEP_DELIVERED_MS);
}

/** Queue a notification for one user's upload event, if they asked for it. Never throws. */
export function notifyUploader(userId: number, event: string, title: string, body: string, url: string | null = null) {
  const prefs = getPrefs(userId);
  if (!prefs || !prefs.events.includes(event)) return;
  insertNotification.run(userId, event, title, body, url, prefs.channel, prefs.target, Date.now());
  void drainNotifications().catch(() => undefined);
}

export function registerNotifyRoutes(app: FastifyInstance) {
  app.get("/api/notifications", async (request) => {
    const user = currentUser(request);
    if (!user) return { channel: "off", target: "", events: [...NOTIFY_EVENTS] };
    return getPrefs(user.id) ?? { channel: "off", target: "", events: [...NOTIFY_EVENTS] };
  });

  app.post<{ Body: { channel?: string; target?: string; events?: string[] } }>("/api/notifications", async (request, reply) => {
    const user = currentUser(request);
    if (!user) return reply.code(401).send({ error: "Not signed in" });
    if (!user.canUpload) return reply.code(403).send({ error: "Read-only accounts don't upload." });
    const channel = String(request.body?.channel ?? "off");
    if (channel === "off") {
      setPrefs(user.id, { channel: "off", target: "", events: [] });
      return { channel: "off", target: "", events: [] };
    }
    if (!CHANNELS.has(channel)) return reply.code(400).send({ error: "Unknown notification channel." });
    const target = safeTarget(String(request.body?.target ?? ""));
    if (!target) {
      return reply.code(400).send({
        error: config.notifyAllowPrivate
          ? "Enter a valid http(s) address."
          : "Enter a valid https address. (Private/LAN addresses are disabled on this server.)",
      });
    }
    const events = (Array.isArray(request.body?.events) ? request.body.events : []).filter((e) => EVENTS.has(e));
    setPrefs(user.id, { channel, target, events });
    return { channel, target, events };
  });

  app.post("/api/notifications/test", async (request, reply) => {
    const user = currentUser(request);
    if (!user) return reply.code(401).send({ error: "Not signed in" });
    const prefs = getPrefs(user.id);
    if (!prefs) return reply.code(400).send({ error: "Choose a channel and save it first." });
    try {
      await deliver("test", prefs.channel, prefs.target, "Kavita Uploads", "This is a test notification from the upload portal.", null);
      return { ok: true };
    } catch (err) {
      return reply.code(502).send({ error: `The notification could not be sent: ${err instanceof Error ? err.message : String(err)}` });
    }
  });
}
