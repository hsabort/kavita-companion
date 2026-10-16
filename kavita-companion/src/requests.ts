// Series/issues users ask for. Admins fulfil or decline; a matching approval fulfils automatically
// (fulfilRequests is called from the approval job in review.ts).
import type { FastifyInstance } from "fastify";
import { currentUser } from "./auth.js";
import { db } from "./db.js";
import * as kavita from "./kavita.js";
import { notifyUploader } from "./notify.js";

const MAX_TITLE = 200;
const MAX_NUMBER = 40;
const MAX_NOTE = 500;

interface RequestRow {
  id: number;
  user_id: number;
  username: string;
  title: string;
  number: string | null;
  library_id: number | null;
  library_name: string | null;
  note: string | null;
  status: string;
  created_at: number;
  decided_by: string | null;
  decided_at: number | null;
  fulfilled_upload_id: string | null;
}

const selectMine = db.prepare("SELECT * FROM requests WHERE user_id = ? ORDER BY id DESC LIMIT 100");
const selectOpen = db.prepare("SELECT * FROM requests WHERE status = 'open' ORDER BY created_at LIMIT 200");
const selectOpenAll = db.prepare("SELECT * FROM requests WHERE status = 'open'");
const insertRequest = db.prepare(
  `INSERT INTO requests (user_id, username, title, number, library_id, library_name, note, status, created_at)
   VALUES (?, ?, ?, ?, ?, ?, ?, 'open', ?)`,
);
const getRequest = db.prepare("SELECT * FROM requests WHERE id = ?");
const setStatus = db.prepare(
  "UPDATE requests SET status = ?, decided_by = ?, decided_at = ?, fulfilled_upload_id = ? WHERE id = ? AND status = 'open'",
);

const item = (row: RequestRow) => ({
  id: row.id,
  username: row.username,
  title: row.title,
  number: row.number,
  libraryId: row.library_id,
  libraryName: row.library_name,
  note: row.note,
  status: row.status,
  createdAt: row.created_at,
  decidedBy: row.decided_by,
  decidedAt: row.decided_at,
});

const normalise = (value: string) =>
  value.normalize("NFKD").replace(/[\u0300-\u036f]/g, "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();

function numberMatches(a: string | null | undefined, b: string | null | undefined): boolean {
  const clean = (value: unknown) => (value == null ? "" : String(value).trim().replace(/^#/, "").replace(/^0+(?=\d)/, ""));
  const left = clean(a);
  const right = clean(b);
  return left === "" || right === "" || left === right;
}

function announce(row: RequestRow) {
  notifyUploader(row.user_id, "request", `Available: ${row.title}${row.number ? ` #${row.number}` : ""}`,
    "A title you asked for has been added to the library.");
}

/** Fulfil open requests matching an approved file's series and number. Returns how many matched. */
export function fulfilRequests(libraryId: number, seriesName: string | null | undefined, number: string | null | undefined, uploadId?: string): number {
  if (!seriesName) return 0;
  const wanted = normalise(seriesName);
  let count = 0;
  for (const row of selectOpenAll.all() as unknown as RequestRow[]) {
    if (row.library_id != null && row.library_id !== libraryId) continue;
    if (normalise(row.title) !== wanted || !numberMatches(row.number, number)) continue;
    if (setStatus.run("fulfilled", null, Date.now(), uploadId ?? null, row.id).changes === 1) {
      count += 1;
      announce(row);
    }
  }
  return count;
}

export function registerRequestRoutes(app: FastifyInstance) {
  app.get("/api/requests", async (request, reply) => {
    const user = currentUser(request);
    if (!user) return reply.code(401).send({ error: "Not signed in" });
    return {
      mine: (selectMine.all(user.id) as unknown as RequestRow[]).map(item),
      open: user.isReviewer ? (selectOpen.all() as unknown as RequestRow[]).map(item) : [],
      canReview: user.isReviewer,
    };
  });

  app.post<{ Body: { title?: string; number?: string; libraryId?: number; note?: string } }>("/api/requests", async (request, reply) => {
    const user = currentUser(request);
    if (!user) return reply.code(401).send({ error: "Not signed in" });
    const title = String(request.body?.title ?? "").trim();
    if (!title) return reply.code(400).send({ error: "Enter the title you're looking for." });
    if (title.length > MAX_TITLE) return reply.code(400).send({ error: `Please keep the title under ${MAX_TITLE} characters.` });
    const number = String(request.body?.number ?? "").trim().slice(0, MAX_NUMBER) || null;
    const note = String(request.body?.note ?? "").trim().slice(0, MAX_NOTE) || null;
    let libraryId: number | null = null;
    let libraryName: string | null = null;
    if (request.body?.libraryId) {
      const match = (await kavita.librariesCached()).find((library) => library.id === Number(request.body?.libraryId));
      if (match) {
        libraryId = match.id;
        libraryName = match.name;
      }
    }
    insertRequest.run(user.id, user.username, title, number, libraryId, libraryName, note, Date.now());
    return { ok: true };
  });

  app.post<{ Params: { id: string } }>("/api/requests/:id/fulfil", async (request, reply) => {
    const user = currentUser(request);
    if (!user) return reply.code(401).send({ error: "Not signed in" });
    if (!user.isReviewer) return reply.code(403).send({ error: "Only Kavita admins can do that." });
    const row = getRequest.get(Number(request.params.id)) as RequestRow | undefined;
    if (!row) return reply.code(404).send({ error: "Request not found" });
    if (setStatus.run("fulfilled", user.username, Date.now(), null, row.id).changes !== 1) {
      return reply.code(409).send({ error: `This request is already ${row.status}.` });
    }
    announce(row);
    return { ok: true };
  });

  app.post<{ Params: { id: string } }>("/api/requests/:id/decline", async (request, reply) => {
    const user = currentUser(request);
    if (!user) return reply.code(401).send({ error: "Not signed in" });
    if (!user.isReviewer) return reply.code(403).send({ error: "Only Kavita admins can do that." });
    const row = getRequest.get(Number(request.params.id)) as RequestRow | undefined;
    if (!row) return reply.code(404).send({ error: "Request not found" });
    if (setStatus.run("declined", user.username, Date.now(), null, row.id).changes !== 1) {
      return reply.code(409).send({ error: `This request is already ${row.status}.` });
    }
    return { ok: true };
  });
}
