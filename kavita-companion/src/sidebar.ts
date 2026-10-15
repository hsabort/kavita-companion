// Puts an "Uploads" entry in the user's Kavita sidebar. Kavita's sidebar supports "external
// source" entries, which open `<host>login?apiKey=<key>` in a new tab; GET /login below accepts
// that and signs the user in. The entry belongs to the user, so it can only be created with their
// own Kavita session, i.e. right after they sign in here with their password.
import { config } from "./config.js";
import { asUser } from "./kavita.js";

const SOURCE_NAME = "Uploads";
const KEY_NAME = "Kavita Companion";
const host = () => config.publicOrigin.replace(/\/?$/, "/");

interface ExternalSource { id: number; name: string; host: string; apiKey: string }
interface SideNavStream { externalSourceId: number | null; streamType: number; visible: boolean }

async function json<T>(res: Response, what: string): Promise<T> {
  if (!res.ok) throw new Error(`${what}: HTTP ${res.status}`);
  return (await res.json()) as T;
}

/** A fresh, never-expiring auth key for this user, used only by the sidebar link. */
async function newKey(token: string): Promise<string> {
  const key = await json<{ key: string }>(
    await asUser(token, "POST", "/api/Account/create-auth-key", { keyLength: 32, name: KEY_NAME, expiresUtc: null }),
    "create auth key",
  );
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
export async function ensureSidebarLink(token: string): Promise<"added" | "repaired" | "shown" | "present"> {
  const sources = await json<ExternalSource[]>(await asUser(token, "GET", "/api/Stream/external-sources"), "list external sources");
  let source = sources.find((s) => s.host === host());
  let result: "added" | "repaired" | "shown" | "present" = "present";

  if (!source) {
    source = await json<ExternalSource>(
      await asUser(token, "POST", "/api/Stream/create-external-source", { id: 0, name: SOURCE_NAME, host: host(), apiKey: await newKey(token) }),
      "create external source",
    );
    result = "added";
  } else if (!(await keyWorks(source.apiKey))) {
    source = await json<ExternalSource>(
      await asUser(token, "POST", "/api/Stream/update-external-source", { ...source, apiKey: await newKey(token) }),
      "update external source",
    );
    result = "repaired";
  }

  const streams = await json<SideNavStream[]>(await asUser(token, "GET", "/api/Stream/sidenav?visibleOnly=false"), "list sidebar");
  const stream = streams.find((s) => s.streamType === 6 && s.externalSourceId === source!.id);
  if (!stream) {
    await json(await asUser(token, "POST", `/api/Stream/add-sidenav-stream-from-external-source?externalSourceId=${source.id}`), "add sidebar entry");
    if (result === "present") result = "shown";
  }
  return result;
}
