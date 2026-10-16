// Puts an "Uploads" entry in the user's Kavita sidebar. Kavita's sidebar supports "external
// source" entries, which open `<host>login?apiKey=<key>` in a new tab; GET /login below accepts
// that and signs the user in. The entry belongs to the user, so it can only be created with their
// own Kavita session: at password sign-in, or on demand from the portal's "Reconnect" control, which
// uses the Kavita session the portal keeps (encrypted) with the portal session.
import type { FastifyInstance } from "fastify";
import { currentUser, sessionKavitaToken } from "./auth.js";
import { config } from "./config.js";
import { audit } from "./db.js";
import { asUser } from "./kavita.js";

// Shown in Kavita's sidebar. Kavita stores the entry's name when it is created and uses it for both
// the label and its hover tooltip, and adds no icon of its own, so the "opens in a new tab" cue has to
// be in the text (docs/roadmap.md §8).
const DISPLAY_NAME = "Uploads ↗";
const KEY_NAME = "Kavita Companion";
const host = () => config.publicOrigin.replace(/\/?$/, "/");

interface ExternalSource { id: number; name: string; host: string; apiKey: string }
interface SideNavStream { id: number; name: string | null; externalSourceId: number | null; streamType: number; visible: boolean }

async function json<T>(res: Response, what: string): Promise<T> {
  if (!res.ok) throw new Error(`${what}: HTTP ${res.status}`);
  return (await res.json()) as T;
}

/** A fresh, never-expiring auth key for this user, used only by the sidebar link. */
async function newKey(token: string): Promise<string> {
  const create = (name: string) =>
    asUser(token, "POST", "/api/Account/create-auth-key", { keyLength: 32, name, expiresUtc: null });
  // Kavita requires the key name to be unique per account; fall back to a suffix if it is taken.
  let res = await create(KEY_NAME);
  if (!res.ok) res = await create(`${KEY_NAME} ${Math.random().toString(36).slice(2, 8)}`);
  const key = await json<{ key: string }>(res, "create auth key");
  return key.key;
}

/** Is this key still accepted by Kavita? (The user may have deleted or rotated it.) */
async function keyWorks(apiKey: string): Promise<boolean> {
  const res = await fetch(`${config.kavitaUrl}/api/Plugin/version?apiKey=${encodeURIComponent(apiKey)}`, {
    signal: AbortSignal.timeout(10_000),
  });
  return res.ok;
}

/**
 * Make sure the user has a working "Uploads" sidebar entry. Returns what was done:
 * "added", "repaired" (key replaced), "shown" (entry existed but was hidden) or "present".
 */
export async function ensureSidebarLink(token: string): Promise<"added" | "repaired" | "shown" | "renamed" | "present"> {
  const sources = await json<ExternalSource[]>(await asUser(token, "GET", "/api/Stream/external-sources"), "list external sources");
  let source = sources.find((s) => s.host === host());
  let result: "added" | "repaired" | "shown" | "renamed" | "present" = "present";

  if (!source) {
    source = await json<ExternalSource>(
      await asUser(token, "POST", "/api/Stream/create-external-source", { id: 0, name: DISPLAY_NAME, host: host(), apiKey: await newKey(token) }),
      "create external source",
    );
    result = "added";
  } else if (source.name !== DISPLAY_NAME) {
    // Kavita keeps the name an entry was created with and will not rename it, so recreate the source
    // with the same auth key to pick up "Uploads ↗" (this migrates the older "Uploads" entries too).
    const removed = await asUser(token, "DELETE", `/api/Stream/delete-external-source?externalSourceId=${source.id}`);
    if (!removed.ok) throw new Error(`remove old external source: HTTP ${removed.status}`);
    source = await json<ExternalSource>(
      await asUser(token, "POST", "/api/Stream/create-external-source", { id: 0, name: DISPLAY_NAME, host: host(), apiKey: source.apiKey }),
      "recreate external source",
    );
    result = "renamed";
  }

  if (!(await keyWorks(source.apiKey))) {
    source = await json<ExternalSource>(
      await asUser(token, "POST", "/api/Stream/update-external-source", { ...source, apiKey: await newKey(token) }),
      "update external source",
    );
    if (result === "present") result = "repaired";
  }

  const streams = await json<SideNavStream[]>(await asUser(token, "GET", "/api/Stream/sidenav?visibleOnly=false"), "list sidebar");
  const stream = streams.find((s) => s.streamType === 6 && s.externalSourceId === source!.id);
  if (!stream) {
    await json(await asUser(token, "POST", `/api/Stream/add-sidenav-stream-from-external-source?externalSourceId=${source.id}`), "add sidebar entry");
    if (result === "present") result = "shown";
  }
  return result;
}

export function registerSidebarRoutes(app: FastifyInstance) {
  // (Re)connect the user's own Kavita sidebar entry on demand. It is normally created at password
  // sign-in, but that only happens then: someone who always arrives through Kavita, or who deleted
  // the entry's key in Kavita, would otherwise be stuck. This uses the Kavita session the portal
  // keeps for them, so it works without their password.
  app.post("/api/sidebar/connect", async (request, reply) => {
    const user = currentUser(request);
    if (!user) return reply.code(401).send({ error: "Not signed in" });
    // Kavita won't create auth keys for Read Only accounts; they can't upload anyway.
    if (!user.canUpload) return reply.code(403).send({ error: "Read-only accounts don't upload." });
    const token = await sessionKavitaToken(request);
    if (!token) {
      return reply.code(409).send({
        error: "The portal has no Kavita session stored for this sign-in. Sign out and sign in with your Kavita password, then try again.",
      });
    }
    try {
      const result = await ensureSidebarLink(token);
      if (result !== "present") audit("sidebar_link", user.username, request.ip, { result, via: "portal" });
      return { result };
    } catch (err) {
      request.log.warn({ err }, "could not add the Kavita sidebar link");
      return reply.code(502).send({ error: "Kavita couldn't reconnect the sidebar link right now. Try again shortly." });
    }
  });
}
