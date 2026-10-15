// First-run setup of Kavita for this stack, run by ../setup.sh inside the kavita-companion image:
//   docker compose run --rm --no-deps -e KAVITA_ADMIN_USERNAME -e KAVITA_ADMIN_PASSWORD \
//     kavita-companion node dist/setup-kavita.js <command>
// Commands:
//   status          -> {"healthy":bool,"adminExists":bool}
//   init            -> registers the admin if none exists, creates the Manga/Comics/Books libraries
//                      that are missing, creates an auth key for the portal; prints {"authKey":...}
//   check-key       -> {"valid":bool,"admin":bool} for the key in env KAVITA_CHECK_KEY
// Output: one JSON line on stdout; progress messages on stderr. Standalone: does not read the
// portal's config (which requires the key this script creates).

const KAVITA = process.env.KAVITA_URL ?? "http://kavita:5000";
const say = (msg: string) => process.stderr.write(`${msg}\n`);

async function call(method: string, path: string, body?: unknown, token?: string): Promise<{ status: number; data: unknown }> {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (token) headers.Authorization = `Bearer ${token}`;
  const res = await fetch(KAVITA + path, {
    method, headers, body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(30_000),
  });
  const text = await res.text();
  let data: unknown = text;
  try { data = text ? JSON.parse(text) : null; } catch { /* plain-text error */ }
  return { status: res.status, data };
}

async function waitForKavita(seconds = 180): Promise<boolean> {
  for (let i = 0; i < seconds; i += 3) {
    try {
      if ((await call("GET", "/api/Health")).status === 200) return true;
    } catch { /* not up yet */ }
    await new Promise((r) => setTimeout(r, 3000));
  }
  return false;
}

// The three libraries this stack expects, matching the media layout (manga/, comics/, books/).
// Types, file types and metadata providers match the libraries of the original install
// (Manga: manga, all file types; Comics: ComicVine-style comics, archives; Books: EPUB + PDF).
// Kavita rejects a library without a valid provider for its type, so the preferred provider is
// checked against GET /api/Library/metadata-providers and falls back to the first one offered.
const LIBRARIES = [
  { name: "Manga", type: 0, folder: "/data/manga", fileGroupTypes: [1, 2, 3, 4], provider: 3 },
  { name: "Comics", type: 5, folder: "/data/comics", fileGroupTypes: [1], provider: 4 },
  { name: "Books", type: 2, folder: "/data/books", fileGroupTypes: [2, 3], provider: 3 },
];

function fail(message: string): never {
  process.stdout.write(JSON.stringify({ error: message }) + "\n");
  process.exit(1);
}

async function init() {
  const username = process.env.KAVITA_ADMIN_USERNAME ?? "";
  const password = process.env.KAVITA_ADMIN_PASSWORD ?? "";
  const email = process.env.KAVITA_ADMIN_EMAIL ?? "";
  if (!username || !password) fail("KAVITA_ADMIN_USERNAME and KAVITA_ADMIN_PASSWORD are required.");
  if (!(await waitForKavita())) fail("Kavita did not become healthy.");

  const exists = (await call("GET", "/api/Admin/exists")).data === true;
  if (!exists) {
    say(`Creating Kavita admin "${username}"...`);
    const reg = await call("POST", "/api/Account/register", { username, password, email: email || undefined });
    if (reg.status !== 200) fail(`Registering the admin failed (HTTP ${reg.status}): ${JSON.stringify(reg.data)}`);
  }
  const login = await call("POST", "/api/Account/login", { username, password });
  if (login.status !== 200) fail(`Signing in as "${username}" failed (HTTP ${login.status}). Check the username and password.`);
  const user = login.data as { token: string; roles: string[] };
  if (!user.roles?.includes("Admin")) fail(`"${username}" is not a Kavita admin.`);
  const token = user.token;

  const existing = (await call("GET", "/api/Library/libraries", undefined, token)).data as { name: string; folders: string[] }[];
  const created: string[] = [];
  for (const lib of LIBRARIES) {
    if (existing.some((e) => e.folders.includes(lib.folder) || e.name.toLowerCase() === lib.name.toLowerCase())) continue;
    say(`Creating library ${lib.name} (${lib.folder})...`);
    const offered = (await call("GET", `/api/Library/metadata-providers?libraryType=${lib.type}`, undefined, token)).data as number[];
    const metadataProvider = Array.isArray(offered) && offered.length
      ? (offered.includes(lib.provider) ? lib.provider : offered[0]) : lib.provider;
    const res = await call("POST", "/api/Library/create", {
      id: 0, name: lib.name, type: lib.type, folders: [lib.folder],
      folderWatching: true, includeInDashboard: true, includeInSearch: true,
      manageCollections: false, manageReadingLists: false, allowScrobbling: true,
      allowMetadataMatching: true, enableMetadata: true, removePrefixForSortName: false,
      inheritWebLinksFromFirstChapter: false, fileGroupTypes: lib.fileGroupTypes, excludePatterns: [],
      metadataProvider, defaultLanguage: "",
    }, token);
    if (res.status !== 200) fail(`Creating library ${lib.name} failed (HTTP ${res.status}): ${JSON.stringify(res.data)}`);
    created.push(lib.name);
  }

  say("Creating the portal's auth key...");
  const key = await call("POST", "/api/Account/create-auth-key",
    { keyLength: 32, name: "kavita-companion service", expiresUtc: null }, token);
  if (key.status !== 200) fail(`Creating the auth key failed (HTTP ${key.status}).`);
  process.stdout.write(JSON.stringify({ adminCreated: !exists, librariesCreated: created, authKey: (key.data as { key: string }).key }) + "\n");
}

async function checkKey(apiKey: string) {
  if (!(await waitForKavita(60))) fail("Kavita did not become healthy.");
  const res = await fetch(`${KAVITA}/api/Users`, { headers: { "x-api-key": apiKey }, signal: AbortSignal.timeout(30_000) });
  const valid = res.status !== 401;
  process.stdout.write(JSON.stringify({ valid, admin: res.ok }) + "\n");
}

const [command] = process.argv.slice(2);
if (command === "status") {
  const healthy = await waitForKavita();
  const adminExists = healthy ? (await call("GET", "/api/Admin/exists")).data === true : false;
  process.stdout.write(JSON.stringify({ healthy, adminExists }) + "\n");
} else if (command === "init") {
  await init();
} else if (command === "check-key" && process.env.KAVITA_CHECK_KEY) {
  await checkKey(process.env.KAVITA_CHECK_KEY);
} else {
  fail("Usage: setup-kavita.js status | init | check-key (key in KAVITA_CHECK_KEY)");
}
