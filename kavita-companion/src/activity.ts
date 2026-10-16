// Admin activity and insights, for the reviewers' Activity panel: recent audit-log entries (with
// filters and paging) and a few counts. Read-only — nothing here changes state.
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { currentUser } from "./auth.js";
import { db } from "./db.js";

const MAX_PAGE = 200;
const DAY_MS = 86_400_000;

function requireReviewer(request: FastifyRequest, reply: FastifyReply) {
  const user = currentUser(request);
  if (!user) {
    reply.code(401).send({ error: "Not signed in" });
    return null;
  }
  if (!user.isReviewer) {
    reply.code(403).send({ error: "Only Kavita admins can see activity." });
    return null;
  }
  return user;
}

interface Entry {
  id: number;
  at: number;
  username: string | null;
  action: string;
  detail: string | null;
  ip: string | null;
}

/** The detail column holds JSON written by audit(); show it as an object when it parses. */
function parseDetail(raw: string | null): unknown {
  if (!raw) return null;
  try {
    return JSON.parse(raw);
  } catch {
    return raw;
  }
}

export function registerActivityRoutes(app: FastifyInstance) {
  // Recent audit-log entries, newest first. Filters: exact action, username substring, and keyset
  // paging with `before` (the id of the last entry already shown).
  app.get<{ Querystring: { action?: string; username?: string; before?: string; limit?: string } }>(
    "/api/admin/activity",
    async (request, reply) => {
      if (!requireReviewer(request, reply)) return;
      const limit = Math.min(Math.max(Number(request.query.limit) || 50, 1), MAX_PAGE);
      const where: string[] = [];
      const args: (string | number)[] = [];
      if (request.query.action) {
        where.push("action = ?");
        args.push(request.query.action);
      }
      if (request.query.username) {
        where.push("username LIKE ?");
        args.push(`%${request.query.username}%`);
      }
      const before = Number(request.query.before);
      if (Number.isFinite(before) && before > 0) {
        where.push("id < ?");
        args.push(before);
      }
      const rows = db.prepare(
        `SELECT id, at, username, action, detail, ip FROM audit_log
         ${where.length ? `WHERE ${where.join(" AND ")}` : ""}
         ORDER BY id DESC LIMIT ?`,
      ).all(...args, limit) as unknown as Entry[];
      return {
        entries: rows.map((row) => ({ ...row, detail: parseDetail(row.detail) })),
        nextBefore: rows.length === limit ? rows[rows.length - 1]!.id : null,
      };
    },
  );

  // A few counts for the panel's summary cards. All-time status counts come from `uploads`; the
  // last-7-days figures come from the audit log (they count events, not rows).
  app.get("/api/admin/insights", async (request, reply) => {
    if (!requireReviewer(request, reply)) return;
    const now = Date.now();

    const pending = db.prepare(
      "SELECT COUNT(*) AS count, COALESCE(SUM(size), 0) AS bytes FROM uploads WHERE status IN ('pending', 'approving')",
    ).get() as { count: number; bytes: number };

    const byStatus = db.prepare(
      "SELECT status, COUNT(*) AS count FROM uploads GROUP BY status ORDER BY count DESC",
    ).all() as unknown as { status: string; count: number }[];

    const weekNames = { upload_completed: "uploaded", upload_approved: "approved", upload_rejected: "rejected", upload_fixed: "fixed" } as const;
    const last7Days = { uploaded: 0, approved: 0, rejected: 0, fixed: 0 };
    for (const row of db.prepare(
      `SELECT action, COUNT(*) AS count FROM audit_log WHERE at > ?
         AND action IN ('upload_completed', 'upload_approved', 'upload_rejected', 'upload_fixed') GROUP BY action`,
    ).all(now - 7 * DAY_MS) as unknown as { action: keyof typeof weekNames; count: number }[]) {
      last7Days[weekNames[row.action]] = row.count;
    }

    const topUploaders = db.prepare(
      `SELECT owner_name AS username, COUNT(*) AS count, COALESCE(SUM(size), 0) AS bytes FROM uploads
         WHERE created_at > ? GROUP BY owner_name ORDER BY count DESC LIMIT 5`,
    ).all(now - 30 * DAY_MS) as unknown as { username: string; count: number; bytes: number }[];

    return { pending, byStatus, last7Days, topUploaders };
  });
}
