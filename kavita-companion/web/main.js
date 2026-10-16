import Uppy from "@uppy/core";
import Dashboard from "@uppy/dashboard";
import Tus from "@uppy/tus";
import "@uppy/core/css/style.min.css";
import "@uppy/dashboard/css/style.min.css";

const $ = (id) => document.getElementById(id);
const GB = 1024 ** 3;

async function api(path, options = {}) {
  // Only declare JSON when there is a body: Fastify rejects an empty body labelled application/json.
  const headers = options.body === undefined ? {} : { "Content-Type": "application/json" };
  const res = await fetch(path, {
    ...options,
    headers: { ...headers, ...(options.headers ?? {}) },
    credentials: "same-origin",
  });
  const body = await res.json().catch(() => ({}));
  return { status: res.status, body };
}

// ---------- Kavita theme ----------
// The server reads the user's Kavita theme and sends its colours as portal tokens (src/themes.ts).
// Values are set as CSS custom properties through the CSSOM, never as style text.

const THEME_TOKENS = ["--bg", "--text", "--primary", "--primary-hover", "--on-primary", "--navbar", "--navbar-text",
  "--input-bg", "--input-text", "--input-placeholder", "--error", "--secondary", "--muted", "--surface-solid"];
let scheme = "dark";
let appliedTheme = "";

function applyTheme(theme) {
  appliedTheme = JSON.stringify(theme ?? null);
  const root = document.documentElement;
  for (const name of THEME_TOKENS) root.style.removeProperty(name);
  for (const [name, value] of Object.entries(theme?.tokens ?? {})) {
    if (THEME_TOKENS.includes(name)) root.style.setProperty(name, value);
  }
  scheme = theme?.scheme === "light" ? "light" : "dark";
  root.style.colorScheme = scheme;
  root.dataset.scheme = scheme;
  root.dataset.theme = theme?.name ?? "Dark";
  uppy?.getPlugin("Dashboard")?.setOptions({ theme: scheme }); // live, without touching uploads in progress
}

// Follow theme changes made in Kavita: check when the tab comes back into view and every 30 seconds.
async function checkTheme() {
  if (document.visibilityState !== "visible" || $("home-view").hidden) return;
  const { status, body } = await api("/api/theme");
  if (status === 200 && JSON.stringify(body.theme ?? null) !== appliedTheme) applyTheme(body.theme);
}
document.addEventListener("visibilitychange", checkTheme);
window.addEventListener("focus", checkTheme);
setInterval(checkTheme, 30_000);

async function refreshMe() {
  const { body } = await api("/api/me");
  applyTheme(body.theme);
  show(body.user ?? null, body.kavitaUrl);
  return body;
}

// ---------- Sign in / out ----------

let uppy = null;
let refreshTimer = null;
let me = null; // the signed-in user from /api/me (roles decide which tabs and panels show)

function notice(text, problem = false) {
  $("notice").textContent = text ?? "";
  $("notice").hidden = !text;
  $("notice").classList.toggle("is-problem", problem);
}

function show(user, kavitaUrl) {
  $("login-view").hidden = !!user;
  $("home-view").hidden = !user;
  $("nav-end").hidden = !user;
  me = user;
  if (kavitaUrl) {
    $("back-to-kavita").href = kavitaUrl;
    $("brand-link").href = kavitaUrl;
  }
  clearInterval(refreshTimer);
  if (!user) {
    uppy?.destroy();
    uppy = null;
    $("tabs").hidden = true;
    return;
  }
  $("who").textContent = user.username;
  if (!user.canUpload) notice("Your Kavita account is read-only, so uploading isn't available.");
  if (user.canUpload) startUploader();
  refreshUploads();
  refreshTimer = setInterval(refreshUploads, 10_000);
  setupTabs(user);
}

// ---------- Tabs ----------
// Each section is shown on its own tab; which tabs exist depends on the user's Kavita roles.

const TABS = [
  { id: "upload", tab: "tab-upload", panels: ["upload-section", "my-uploads-section"], canSee: (user) => user.canUpload, onShow: () => {} },
  { id: "review", tab: "tab-review", panels: ["review-section"], canSee: (user) => user.isReviewer, onShow: () => refreshReview() },
  { id: "library", tab: "tab-library", panels: ["library-section"], canSee: (user) => user.isReviewer, onShow: () => refreshLibrary() },
  { id: "requests", tab: "tab-requests", panels: ["requests-section"], canSee: () => true, onShow: () => { refreshRequests(); fillRequestLibraries(); } },
  { id: "activity", tab: "tab-activity", panels: ["activity-section"], canSee: (user) => user.isReviewer, onShow: () => refreshActivity(true) },
  { id: "notifications", tab: "tab-notifications", panels: ["notify-wrap"], canSee: (user) => user.canUpload, onShow: () => loadNotifications() },
  { id: "about", tab: "tab-about", panels: ["about-section"], canSee: () => true, onShow: () => loadAbout() },
];
let activeTab = null;

function selectTab(id) {
  const chosen = TABS.find((tab) => tab.id === id);
  if (!chosen || $(chosen.tab).hidden) return;
  activeTab = id;
  for (const tab of TABS) {
    const selected = tab === chosen;
    $(tab.tab).setAttribute("aria-selected", selected ? "true" : "false");
    $(tab.tab).classList.toggle("is-active", selected);
    for (const panel of tab.panels) $(panel).hidden = !selected;
  }
  if (location.hash !== `#${id}`) history.replaceState(null, "", `#${id}`);
  chosen.onShow();
}

function setupTabs(user) {
  const available = TABS.filter((tab) => tab.canSee(user));
  for (const tab of TABS) $(tab.tab).hidden = !available.includes(tab);
  $("tabs").hidden = available.length <= 1; // nothing to switch between
  const wanted = location.hash.slice(1);
  const start = available.find((tab) => tab.id === wanted)
    || available.find((tab) => tab.id === (user.isReviewer ? "review" : "upload"))
    || available[0];
  if (start) selectTab(start.id);
}

for (const tab of TABS) $(tab.tab).addEventListener("click", () => selectTab(tab.id));
$("tabs").addEventListener("keydown", (event) => {
  if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
  const visible = TABS.filter((tab) => !$(tab.tab).hidden);
  const step = event.key === "ArrowRight" ? 1 : -1;
  const next = visible[visible.findIndex((tab) => tab.id === activeTab) + step];
  if (next) {
    selectTab(next.id);
    $(next.tab).focus();
    event.preventDefault();
  }
});
window.addEventListener("hashchange", () => {
  const id = location.hash.slice(1);
  if (TABS.some((tab) => tab.id === id)) selectTab(id);
});

$("login-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  const form = new FormData(event.target);
  $("login-error").textContent = "";
  const button = event.target.querySelector("button");
  button.disabled = true;
  const { status, body } = await api("/api/login", {
    method: "POST",
    body: JSON.stringify({ username: form.get("username"), password: form.get("password") }),
  });
  button.disabled = false;
  if (status === 200) {
    event.target.reset();
    await refreshMe(); // picks up the user's Kavita theme
    if (body.sidebar === "added" || body.sidebar === "shown") {
      notice("Uploads is now in your Kavita sidebar. Next time, open it from there and you're signed in automatically.");
    } else if (body.sidebar === "repaired") {
      notice("The Uploads link in your Kavita sidebar has been repaired.");
    }
  } else if (status === 429) {
    $("login-error").textContent = "Too many attempts. Wait 15 minutes and try again.";
  } else {
    $("login-error").textContent = body.error ?? "Sign-in failed.";
  }
});

$("logout").addEventListener("click", async () => {
  await api("/api/logout", { method: "POST", body: "{}" });
  notice(null);
  await refreshMe(); // back to the server's default theme
});

// ---------- Kavita sidebar link ----------
// Creates or repairs the "Uploads" entry in the user's own Kavita sidebar (src/sidebar.ts). Signing
// in with the Kavita password already does this; the button is for a signed-in session that arrived
// through the sidebar link, or whose entry (or its key) was deleted in Kavita afterwards.

const SIDEBAR_RESULT = {
  added: "Added — Uploads ↗ is now in your Kavita sidebar. Refresh the Kavita page if you don't see it.",
  repaired: "Reconnected — the Uploads link in your Kavita sidebar works again.",
  renamed: "Updated — the Kavita sidebar entry is now labelled Uploads ↗.",
  shown: "Back — Uploads is in your Kavita sidebar again.",
  present: "Nothing to do — Uploads is already in your Kavita sidebar.",
};

async function connectSidebar() {
  const button = $("sidebar-connect-btn");
  const status = $("sidebar-connect-status");
  button.disabled = true;
  status.className = "muted";
  status.textContent = "Talking to Kavita…";
  const { status: code, body } = await api("/api/sidebar/connect", { method: "POST", body: "{}" });
  button.disabled = false;
  if (code !== 200) {
    status.className = "muted error";
    status.textContent = body.error ?? "Kavita couldn't be reached. Try again shortly.";
    return;
  }
  status.textContent = SIDEBAR_RESULT[body.result] ?? "Done.";
  button.textContent = "Reconnect it";
}

$("sidebar-connect-btn").addEventListener("click", connectSidebar);

// ---------- Uploading ----------

async function startUploader() {
  const [{ body: libs }, { body: mine }] = await Promise.all([api("/api/libraries"), api("/api/uploads")]);
  const limits = mine.limits;

  const select = $("library");
  select.replaceChildren(new Option("Choose a library…", ""));
  for (const lib of libs.libraries ?? []) select.add(new Option(lib.name, String(lib.id)));

  uppy?.destroy();
  uppy = new Uppy({
    autoProceed: false,
    restrictions: {
      maxFileSize: limits.maxFileGb * GB,
      allowedFileTypes: limits.acceptedExtensions.map((e) => "." + e),
    },
    onBeforeUpload: () => {
      if (!select.value) {
        uppy.info("Choose a library first.", "error", 4000);
        select.focus();
        return false;
      }
      return true;
    },
  })
    .use(Dashboard, {
      target: "#uploader",
      inline: true,
      width: "100%",
      height: 380,
      theme: scheme,
      proudlyDisplayPoweredByUppy: false,
      fileManagerSelectionType: "both",
      note: `${limits.acceptedExtensions.map((e) => "." + e).join(" ")}, up to ${limits.maxFileGb} GB per file`,
    })
    .use(Tus, {
      endpoint: "/files",
      // Small enough that one chunk finishes quickly on a phone connection; a dropped
      // connection only re-sends the current chunk.
      chunkSize: 25 * 1024 * 1024,
      limit: limits.maxConcurrentPerUser,
      retryDelays: [0, 1000, 3000, 5000, 10000, 20000, 30000, 60000],
      allowedMetaFields: ["name", "type", "libraryId"],
      removeFingerprintOnSuccess: true,
    });

  select.addEventListener("change", () => uppy.setMeta({ libraryId: select.value }));

  // Show the server's own explanation (quota, file type, ...) instead of the raw protocol error.
  uppy.on("upload-error", (file, error) => {
    const body = error?.originalResponse?.getBody?.();
    if (body) uppy.info(`${file.name}: ${body}`, "error", 8000);
  });
  uppy.on("upload-success", () => setTimeout(refreshUploads, 1500));
  uppy.on("complete", refreshUploads);
}

// ---------- My uploads ----------

const STATUS_TEXT = {
  uploading: "Uploading",
  checking: "Checking file…",
  pending: "Waiting for review",
  approving: "Being reviewed",
  rejecting: "Being reviewed",
  approved: "In the library",
  rejected: "Rejected",
  invalid: "Not accepted",
  duplicate: "Duplicate",
  cancelled: "Cancelled",
  expired: "Expired",
  withdrawn: "Withdrawn",
};

const formatDate = (ms) =>
  new Date(ms).toLocaleString(undefined, { day: "numeric", month: "short", hour: "numeric", minute: "2-digit" });

function formatSize(bytes) {
  if (bytes >= GB) return `${(bytes / GB).toFixed(1)} GB`;
  if (bytes >= 1024 ** 2) return `${Math.round(bytes / 1024 ** 2)} MB`;
  return `${Math.max(1, Math.round(bytes / 1024))} KB`;
}

const RECENT_UPLOADS = 15;
let showAllUploads = false;

async function refreshUploads() {
  const { status, body } = await api("/api/uploads");
  if (status === 401) return show(null);
  const list = $("uploads");
  const all = body.uploads ?? [];
  const uploads = showAllUploads ? all : all.slice(0, RECENT_UPLOADS);
  $("uploads-empty").hidden = all.length > 0;
  list.replaceChildren(
    ...uploads.map((u) => {
      const li = document.createElement("li");
      li.className = `upload status-${u.status}`;
      const name = document.createElement("div");
      name.className = "upload-name";
      name.textContent = u.filename;
      const meta = document.createElement("div");
      meta.className = "upload-meta";
      const state = document.createElement("span");
      state.className = "status";
      state.textContent = STATUS_TEXT[u.status] ?? u.status;
      meta.append(state, ` in ${u.library_name}, ${formatSize(u.size)}, uploaded ${formatDate(u.created_at)}`);
      li.append(name, meta);
      if (u.kavita_url) {
        const open = document.createElement("a");
        open.href = u.kavita_url;
        open.textContent = "Open in Kavita";
        open.className = "kavita-link";
        meta.append(" ", open);
      }
      if (u.error) {
        const err = document.createElement("div");
        err.className = "upload-error";
        err.textContent = u.error;
        li.append(err);
      }
      if (u.status === "pending") {
        const withdraw = document.createElement("button");
        withdraw.type = "button";
        withdraw.className = "btn btn-outline small";
        withdraw.textContent = "Withdraw";
        withdraw.addEventListener("click", async () => {
          if (!confirm(`Withdraw "${u.filename}"? The file will be deleted.`)) return;
          await api(`/api/uploads/${encodeURIComponent(u.id)}`, { method: "DELETE" });
          refreshUploads();
        });
        li.append(withdraw);
      }
      return li;
    }),
  );
  if (all.length > uploads.length) {
    const more = document.createElement("button");
    more.type = "button";
    more.className = "btn btn-outline small show-older";
    more.textContent = `Show ${all.length - uploads.length} older upload${all.length - uploads.length === 1 ? "" : "s"}`;
    more.addEventListener("click", () => { showAllUploads = true; refreshUploads(); });
    list.append(more);
  }
}

// ---------- Review (admins) ----------
// Pending uploads are shown in groups (same uploader, library and series), so a batch like
// "Iron Man #1-6" is reviewed once: shared fields at the top, per-file rows below.

const el = (tag, props = {}, ...children) => {
  const { dataset, ...rest } = props;
  const node = Object.assign(document.createElement(tag), rest);
  if (dataset) Object.assign(node.dataset, dataset); // dataset itself is read-only
  node.append(...children.filter((c) => c !== null && c !== undefined));
  return node;
};
const field = (label, input, hint) => el("label", { className: "field" }, label, input, hint ? el("small", { className: "muted", textContent: hint }) : null);

let review = null; // last /api/review response
const seriesLists = new Map(); // libraryId -> Promise<string[]>
const contentsCache = new Map(); // `${libraryId}|${name}` -> Promise<{exists, numbers, volumes, name}>

function seriesFor(libraryId) {
  if (!seriesLists.has(libraryId)) {
    seriesLists.set(libraryId, api(`/api/review/series?libraryId=${libraryId}`).then(({ body }) => body.series ?? []));
  }
  return seriesLists.get(libraryId);
}

function contentsFor(libraryId, name) {
  const key = `${libraryId}|${name.toLowerCase()}`;
  if (!contentsCache.has(key)) {
    contentsCache.set(key, api(`/api/review/series-contents?libraryId=${libraryId}&name=${encodeURIComponent(name)}`).then(({ body }) => body));
  }
  return contentsCache.get(key);
}

function forgetLibrary(libraryId) {
  seriesLists.delete(libraryId);
  for (const key of contentsCache.keys()) if (key.startsWith(`${libraryId}|`)) contentsCache.delete(key);
  document.getElementById(`series-list-${libraryId}`)?.remove();
}

async function ensureDatalist(libraryId) {
  const id = `series-list-${libraryId}`;
  if (!$(id)) {
    const list = el("datalist", { id });
    for (const name of await seriesFor(libraryId)) list.append(el("option", { value: name }));
    document.body.append(list);
  }
  return id;
}

const normalizeSeries = (s) => s.toLowerCase().replace(/\(\d{4}\)/g, "").replace(/^the\s+/, "").replace(/[^a-z0-9]+/g, "");
const sameName = (a, b) => a.localeCompare(b, undefined, { sensitivity: "accent" }) === 0;

function editDistance(a, b) {
  const d = Array.from({ length: a.length + 1 }, (_, i) => [i, ...Array(b.length).fill(0)]);
  for (let j = 1; j <= b.length; j++) d[0][j] = j;
  for (let i = 1; i <= a.length; i++)
    for (let j = 1; j <= b.length; j++)
      d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
  return d[a.length][b.length];
}

/** Existing series that look like typos/variants of `name` (but aren't the same series). */
function nearMisses(name, existing) {
  const n = normalizeSeries(name);
  if (!n || existing.some((e) => sameName(e, name))) return [];
  return existing.filter((e) => {
    const m = normalizeSeries(e);
    return m === n || (n.length >= 6 && editDistance(m, n) <= 2) || (m.length >= 4 && (m.startsWith(n) || n.startsWith(m)));
  }).slice(0, 3);
}

const pad = (value, width) => {
  const m = /^(\d+)(\.\d+)?$/.exec(value ?? "");
  return m ? m[1].padStart(width, "0") + (m[2] ?? "") : value;
};

/** Suggested file name (without extension), following Kavita's naming guide per library type. */
function templateName(libraryType, f) {
  const series = f.Series?.trim() || "";
  const num = f.Number?.trim();
  const vol = f.Volume?.trim();
  const title = f.Title?.trim();
  if (libraryType === 2 || libraryType === 4) { // Book / Light novel
    if (series && title) return `${series}${num ? ` ${pad(num, 2)}` : ""} - ${title}`;
    return title || series;
  }
  if (libraryType === 0) { // Manga
    return `${series}${vol ? ` v${pad(vol, 2)}` : ""}${num ? ` c${pad(num, 3)}` : ""}`;
  }
  return `${series}${vol ? ` v${vol}` : ""}${num ? ` #${pad(num, 3)}` : ""}`; // Comics
}

const SHARED_MORE = ["Writer", "Penciller", "Inker", "Colorist", "CoverArtist", "Publisher", "Imprint", "Genre", "Tags", "LanguageISO"];
const LABELS = { LanguageISO: "Language (ISO code, e.g. en)", CoverArtist: "Cover artist" };
// Fields the "Find metadata" panel can place on the card (shared fields plus the single-file ones).
const APPLY_FIELDS = ["Series", "Year", "AgeRating", ...SHARED_MORE, "Number", "Volume", "Title", "Summary"];

/** The value all items share, or "" if they differ (blank = keep each file's own). */
function common(items, key) {
  const values = new Set(items.map((i) => i.defaults?.[key] ?? ""));
  return values.size === 1 ? [...values][0] : "";
}

// In-progress review edits, keyed by upload id (the single-file fields) and by the group's first
// upload id (the shared fields). Kept across re-renders — switching tabs, Refresh, a poll — so a
// reviewer's typing or applied metadata is never silently discarded; cleared when a decision is made.
const reviewDrafts = new Map();
const draftId = (kind, id) => `${kind}:${id}`;
const loadDraft = (kind, id) => reviewDrafts.get(draftId(kind, id)) ?? null;
const saveDraft = (kind, id, values) => reviewDrafts.set(draftId(kind, id), values);
const clearFileDraft = (id) => reviewDrafts.delete(draftId("file", id));

function groupCard(items) {
  const first = items[0];
  const fixing = first.mode === "fix";
  const libraries = review.libraries;
  const card = el("article", { className: fixing ? "review-group is-fix" : "review-group" });

  // Shared fields
  const library = el("select");
  for (const lib of libraries) library.add(new Option(lib.name, String(lib.id), false, lib.id === first.libraryId));
  const series = el("input", { value: first.defaults.Series ?? "", autocomplete: "off", required: true });
  const year = el("input", { value: common(items, "Year"), inputMode: "numeric", maxLength: 4, placeholder: items.length > 1 ? "keep each file's" : "" });
  const age = el("select");
  age.add(new Option(items.length > 1 ? "Keep each file's" : "Not set", ""));
  for (const r of review.ageRatings) age.add(new Option(r, r, false, r === common(items, "AgeRating")));
  const seriesNote = el("div", { className: "series-note" });
  const more = {};
  const moreBox = el("details", { className: "more" }, el("summary", { textContent: items.length > 1 ? "More (applies to all files)" : "More" }));
  for (const key of SHARED_MORE) {
    more[key] = el("input", { value: common(items, key), placeholder: items.length > 1 ? "keep each file's" : "", autocomplete: "off" });
    moreBox.append(field(LABELS[key] ?? key, more[key]));
  }

  const sharedDraft = loadDraft("shared", first.id);
  if (sharedDraft) {
    if (sharedDraft.Series !== undefined) series.value = sharedDraft.Series;
    if (sharedDraft.Year !== undefined) year.value = sharedDraft.Year;
    if (sharedDraft.AgeRating !== undefined) age.value = sharedDraft.AgeRating;
    for (const key of SHARED_MORE) if (sharedDraft[key] !== undefined) more[key].value = sharedDraft[key];
  }
  const libraryType = () => libraries.find((l) => String(l.id) === library.value)?.type ?? 0;
  const rows = items.map((item) => itemRow(item, { library, series, year, age, more, libraryType }));
  const updateAll = async () => {
    saveDraft("shared", first.id, sharedValues());
    for (const row of rows) row.update(); // immediately; refined below once Kavita's series list is in
    series.setAttribute("list", await ensureDatalist(Number(library.value)));
    const existing = await seriesFor(Number(library.value));
    const name = series.value.trim();
    const match = existing.find((e) => sameName(e, name));
    seriesNote.replaceChildren();
    if (match) {
      seriesNote.append(el("span", { className: "ok", textContent: `Adds to existing series "${match}".` }));
    } else if (name) {
      seriesNote.append(el("span", { textContent: "New series. " }));
      for (const alt of nearMisses(name, existing)) {
        const use = el("button", { type: "button", className: "link", textContent: `Use "${alt}"?` });
        use.addEventListener("click", () => { series.value = alt; updateAll(); });
        seriesNote.append(el("span", { className: "warn", textContent: "Similar existing series: " }), use, " ");
      }
    }
    const contents = match ? await contentsFor(Number(library.value), match) : null;
    for (const row of rows) row.update(contents);
  };
  for (const input of [library, series, year, age, ...Object.values(more)]) {
    input.addEventListener(input.tagName === "SELECT" ? "change" : "input", updateAll);
  }

  const approveAll = el("button", { type: "button", textContent: items.length > 1 ? `Approve all ${items.length}` : "Approve" });
  approveAll.addEventListener("click", async () => {
    approveAll.disabled = true;
    for (const row of rows) if (!row.done()) await row.approve();
    approveAll.disabled = false;
    refreshUploads();
  });

  const suggestNote = el("div", { className: "match-note" });

  // External metadata (phase 2, W8): search the enabled providers and fill the card's fields. One
  // lookup per action; the reviewer picks a candidate and applies fields (fill blanks by default,
  // an explicit overwrite is opt-in). Nothing is applied without a click. The action only appears
  // when external metadata is on and a provider covers this library's kind of file.
  const metadataFor = () => {
    const meta = review?.metadata;
    if (!meta?.enabled) return null;
    const type = libraryType();
    const media = type === 0 ? "manga" : (type === 2 || type === 4) ? "book" : "comic";
    return (meta.providers ?? []).some((provider) => provider.media.includes(media)) ? media : null;
  };
  const findButton = el("button", { type: "button", className: "btn btn-outline small", textContent: "Find metadata" });
  const findBody = el("div", { className: "match-panel", hidden: true });
  const metadataBlock = el("div", { className: "metadata-finder" }, findButton, findBody);
  const providerById = new Map();
  const labelOf = (id) => providerById.get(id)?.label ?? id;
  const sharedValues = () => {
    const values = { Series: series.value, Year: year.value, AgeRating: age.value };
    for (const [key, input] of Object.entries(more)) values[key] = input.value;
    return values;
  };
  const applyMerged = (result, candidate) => {
    const fields = result.fields ?? {};
    const provenance = result.provenance ?? {};
    const provider = providerById.get(result.provider ?? candidate.provider) ?? {};
    const source = result.provider ?? candidate.provider;
    const pairs = [];
    const put = (key, input) => {
      if (fields[key] === undefined || !input) return;
      input.value = fields[key];
      pairs.push([key, provenance[key] ?? source]);
    };
    if (fields.Series !== undefined) { series.value = fields.Series; pairs.push(["Series", provenance.Series ?? source]); }
    put("Year", year);
    if (fields.AgeRating !== undefined) { age.value = fields.AgeRating; pairs.push(["AgeRating", provenance.AgeRating ?? source]); }
    for (const key of SHARED_MORE) put(key, more[key]);
    const skipped = [];
    if (rows.length === 1) {
      const input = rows[0].inputs;
      put("Number", input.number); put("Volume", input.volume); put("Title", input.title); put("Summary", input.summary);
    } else {
      for (const key of ["Number", "Volume", "Title", "Summary"]) if (fields[key] !== undefined) skipped.push(key);
    }
    updateAll();

    const out = el("div", { className: "apply-result" });
    out.append(pairs.length
      ? el("div", { className: "chips" }, ...pairs.map(([field, from]) => el("span", { className: "chip", textContent: `${field} · ${labelOf(from)}` })))
      : el("p", { className: "muted", textContent: "Nothing to fill — your values are already set." }));
    if (skipped.length) {
      out.append(el("p", { className: "muted", textContent: `Per-file fields (${skipped.join(", ")}) weren't applied to a multi-file group.` }));
    }
    const licence = provider.licence;
    const attribution = el("div", { className: "attribution" }, `Applied from ${provider.label ?? source}`);
    if (licence?.name) attribution.append(` (${licence.name})`);
    if (licence?.url) attribution.append(" — ", el("a", { href: licence.url, target: "_blank", rel: "noopener noreferrer", textContent: licence.url.replace(/^https?:\/\//, "") }));
    out.append(attribution);
    const conflicts = result.conflicts ?? [];
    if (conflicts.length) {
      const list = el("ul", { className: "conflicts" });
      for (const conflict of conflicts) {
        list.append(el("li", { textContent: `Kept your ${conflict.field} ("${conflict.current}") — ${labelOf(conflict.source)} suggests "${conflict.proposed}".` }));
      }
      out.append(el("p", { className: "muted", textContent: "Kept your values (choose Overwrite existing values to replace them):" }), list);
    }
    return out;
  };
  const renderCandidates = (body, status) => {
    if (status !== 200) {
      findBody.replaceChildren(el("p", { className: "row-status error", textContent: body.error ?? "The lookup failed." }));
      return;
    }
    // A provider that hit its rate limit is skipped, not failed: say when it can be tried again.
    const retryIn = (ms) => {
      if (typeof ms !== "number" || ms <= 0) return "shortly";
      const seconds = Math.ceil(ms / 1000);
      return seconds < 60 ? `in ${seconds}s` : `in about ${Math.ceil(seconds / 60)} min`;
    };
    providerById.clear();
    for (const provider of body.providers ?? []) providerById.set(provider.id, provider);
    const candidates = body.candidates ?? [];
    if (!candidates.length) {
      const lines = [el("p", { className: "muted", textContent: `No candidates found for "${body.query?.title ?? "this file"}".` })];
      for (const provider of body.providers ?? []) {
        if (!provider.skipped) continue;
        const why = body.externalEnabled === false ? "external metadata is turned off"
          : provider.skipped === "no-key" ? "needs a key (an admin can add one under Metadata providers)"
            : provider.skipped === "cooldown" ? `is rate-limited right now — try again ${retryIn(provider.retryAfterMs)}`
              : provider.skipped === "media" ? "doesn't cover this kind of file"
                : provider.skipped === "error" ? `couldn't be reached${provider.error ? ` (${provider.error})` : ""}`
                  : "is turned off";
        lines.push(el("p", { className: "muted", textContent: `${provider.label} ${why}.` }));
      }
      findBody.replaceChildren(...lines);
      return;
    }
    const candidateGroup = `cand-${first.id}`;
    const modeGroup = `mode-${first.id}`;
    let chosen = candidates[0];
    const fieldsBox = el("div", { className: "field-picker" });
    const renderFields = () => {
      const provider = providerById.get(chosen.provider) ?? {};
      const available = (provider.fields ?? []).filter((field) => APPLY_FIELDS.includes(field));
      fieldsBox.replaceChildren(
        el("div", { className: "picker-label", textContent: "Fields to apply" }),
        ...available.map((field) => {
          const box = el("input", { type: "checkbox", value: field });
          box.checked = true;
          return el("label", { className: "check" }, box, field);
        }),
      );
    };
    const list = el("div", { className: "candidates" });
    candidates.forEach((candidate, index) => {
      const radio = el("input", { type: "radio", name: candidateGroup, value: String(index) });
      if (index === 0) radio.checked = true;
      radio.addEventListener("change", () => { chosen = candidate; renderFields(); });
      list.append(el("label", { className: "candidate" },
        radio,
        el("span", { className: "chip chip-source", textContent: candidate.source ?? candidate.provider }),
        el("span", { className: "cand-title", textContent: candidate.title }),
        el("span", { className: "cand-meta", textContent: [candidate.number ? `#${candidate.number}` : "", candidate.year, candidate.publisher].filter(Boolean).join(" · ") }),
        el("span", { className: `band band-${candidate.band}`, textContent: candidate.band }),
      ));
    });
    const modeFill = el("input", { type: "radio", name: modeGroup, value: "fill" });
    modeFill.checked = true;
    const modeOverwrite = el("input", { type: "radio", name: modeGroup, value: "overwrite" });
    const applyButton = el("button", { type: "button", className: "btn btn-outline-primary small", textContent: "Apply selected fields" });
    const resultBox = el("div", { className: "apply-result-box" });
    applyButton.addEventListener("click", async () => {
      const fields = [...fieldsBox.querySelectorAll("input[type=checkbox]:checked")].map((box) => box.value);
      if (!fields.length) { resultBox.replaceChildren(el("p", { className: "row-status error", textContent: "Choose at least one field." })); return; }
      applyButton.disabled = true;
      resultBox.replaceChildren(el("p", { className: "muted", textContent: "Applying…" }));
      const { status: code, body: applied } = await api(`/api/review/${encodeURIComponent(first.id)}/apply`, {
        method: "POST",
        body: JSON.stringify({
          provider: chosen.provider, externalId: chosen.externalId,
          mode: modeOverwrite.checked ? "overwrite" : "fill", fields, current: sharedValues(),
        }),
      });
      applyButton.disabled = false;
      if (code !== 200) {
        resultBox.replaceChildren(el("p", { className: "row-status error", textContent: applied.error ?? "Could not apply." }));
        return;
      }
      resultBox.replaceChildren(applyMerged(applied, chosen));
    });
    renderFields();
    findBody.replaceChildren(
      list,
      el("div", { className: "match-actions" },
        el("label", { className: "check" }, modeFill, "Fill blanks"),
        el("label", { className: "check" }, modeOverwrite, "Overwrite existing values")),
      fieldsBox,
      applyButton,
      resultBox,
    );
  };
  findButton.addEventListener("click", async () => {
    findBody.hidden = false;
    findButton.disabled = true;
    findBody.replaceChildren(el("p", { className: "muted", textContent: "Searching the metadata sources…" }));
    const params = new URLSearchParams();
    const name = series.value.trim();
    if (name) params.set("series", name);
    const yr = year.value.trim();
    if (yr) params.set("year", yr);
    if (rows.length === 1) { const n = rows[0].inputs.number.value.trim(); if (n) params.set("number", n); }
    const { status, body } = await api(`/api/review/${encodeURIComponent(first.id)}/match?${params.toString()}`);
    findButton.disabled = false;
    renderCandidates(body, status);
  });

  card.append(...[
    el("div", { className: "group-head" },
      el("h3", { textContent: fixing ? `Fix ${first.filename}` : items.length > 1 ? `${first.defaults.Series}: ${items.length} files` : first.filename }),
      el("div", {
        className: "upload-meta",
        textContent: fixing ? `Now at ${first.currentPath}. Uploaded by ${first.uploader}.` : `Uploaded by ${first.uploader} to ${first.libraryName}`,
      })),
    el("div", { className: "grid-2" }, field("Library", library), field("Series", series)),
    seriesNote,
    suggestNote,
    el("div", { className: "grid-2" }, field("Year", year), field("Age rating", age)),
    moreBox,
    metadataFor() ? metadataBlock : null,
    el("div", { className: "rows" }, ...rows.map((r) => r.node)),
    items.length > 1 ? el("div", { className: "actions group-actions" }, approveAll) : null,
  ].filter(Boolean));

  // Metadata already on the matching Kavita series, offered as a one-click fill (src/review.ts /suggest).
  api(`/api/review/${encodeURIComponent(first.id)}/suggest`).then(({ status, body }) => {
    if (status !== 200 || !body.found) return;
    const fields = body.fields ?? {};
    const applied = ["Year", ...SHARED_MORE].filter((key) => fields[key]);
    if (!applied.length) return;
    const use = el("button", { type: "button", className: "link", textContent: `use Kavita's ${applied.join(", ")}` });
    use.addEventListener("click", () => {
      if (fields.Year) year.value = fields.Year;
      for (const key of SHARED_MORE) if (fields[key] && more[key]) more[key].value = fields[key];
      updateAll();
    });
    suggestNote.append(`Kavita's "${body.seriesName}" already has metadata — `, use);
  }).catch(() => {});

  updateAll();
  return card;
}

function itemRow(item, shared) {
  const d = item.defaults;
  const number = el("input", { value: d.Number ?? "", autocomplete: "off", inputMode: "decimal" });
  const volume = el("input", { value: d.Volume ?? "", autocomplete: "off" });
  const title = el("input", { value: d.Title ?? "", autocomplete: "off" });
  const filename = el("input", { autocomplete: "off", spellcheck: false });
  const summary = el("textarea", { value: d.Summary ?? "", rows: 4 });
  const fixing = item.mode === "fix";
  // A fix keeps the current file name unless it is changed by hand.
  let filenameTouched = fixing;
  if (fixing) filename.value = item.currentFilename;
  // Restore any in-progress edits for this file (see reviewDrafts).
  const fileDraft = loadDraft("file", item.id);
  if (fileDraft) {
    number.value = fileDraft.Number ?? number.value;
    volume.value = fileDraft.Volume ?? volume.value;
    title.value = fileDraft.Title ?? title.value;
    summary.value = fileDraft.Summary ?? summary.value;
    if (fileDraft.filename !== undefined) filename.value = fileDraft.filename;
    filenameTouched = fileDraft.filenameTouched ?? filenameTouched;
  }
  filename.addEventListener("input", () => { filenameTouched = true; update(); });
  const destination = el("p", { className: "destination muted" });
  const warnings = el("ul", { className: "warnings" });
  const status = el("p", { className: "row-status", role: "status" });
  let done = false;
  let lastContents = null;

  const values = () => {
    const meta = {
      Number: number.value, Volume: volume.value, Title: title.value, Summary: summary.value,
      Year: shared.year.value, AgeRating: shared.age.value,
    };
    for (const [k, input] of Object.entries(shared.more)) meta[k] = input.value;
    return meta;
  };

  function update(contents = lastContents) {
    lastContents = contents;
    const f = { ...values(), Series: shared.series.value };
    if (!filenameTouched) filename.value = templateName(shared.libraryType(), f) || item.filename.replace(/\.[^.]+$/, "");
    const libName = shared.library.selectedOptions[0]?.text ?? "?";
    destination.replaceChildren("Will be saved as ",
      el("strong", { textContent: `${libName} / ${shared.series.value.trim() || "?"} / ${filename.value.trim() || "?"}.${item.targetExtension}` }));
    badge.textContent = number.value.trim() ? `#${number.value.trim()}` : "";
    caption.textContent = shared.series.value.trim();
    const list = [...item.warnings];
    if (item.reviewError) list.unshift(item.reviewError);
    if (contents?.exists && number.value.trim() && contents.numbers.some((n) => Number(n) === Number(number.value))) {
      list.push(`#${number.value.trim()} is already in "${contents.name}". Check this isn't a duplicate.`);
    }
    if (item.kind === "comic" && !number.value.trim()) list.push("No issue/chapter number: Kavita may treat this as a special.");
    if (shared.year.value && !/^\d{4}$/.test(shared.year.value)) list.push("Year must be four digits.");
    warnings.replaceChildren(...list.map((w) => el("li", { textContent: w })));
    saveDraft("file", item.id, { Number: number.value, Volume: volume.value, Title: title.value, Summary: summary.value, filename: filename.value, filenameTouched });
  }
  for (const input of [number, volume, title, summary]) input.addEventListener("input", () => update());

  const approve = el("button", { type: "button", textContent: fixing ? "Save changes" : "Approve" });
  const reject = el("button", { type: "button", className: "secondary", textContent: fixing ? "Cancel" : "Reject…" });
  const download = fixing ? null : el("a", { href: `/api/review/${encodeURIComponent(item.id)}/download`, textContent: "Download" });
  const previewBtn = !fixing && item.kind === "comic" && item.inspection?.pages
    ? el("button", { type: "button", className: "secondary", textContent: "Preview" })
    : null;
  if (previewBtn && item.inspection?.pages) previewBtn.addEventListener("click", () => openPreview(item.id, item.inspection.pages, 1));

  async function doApprove() {
    status.textContent = "";
    approve.disabled = reject.disabled = true;
    const { status: code, body } = await api(`/api/review/${encodeURIComponent(item.id)}/${fixing ? "fix" : "approve"}`, {
      method: "POST",
      body: JSON.stringify({
        libraryId: Number(shared.library.value),
        seriesName: shared.series.value,
        filename: filename.value,
        metadata: values(),
      }),
    });
    if (code !== 202) {
      approve.disabled = reject.disabled = false;
      status.className = "row-status error";
      status.textContent = body.error ?? (fixing ? "Saving failed." : "Approving failed.");
      return false;
    }
    done = true;
    clearFileDraft(item.id);
    node.classList.add("is-approving");
    status.className = "row-status";
    status.textContent = `${fixing ? "Saving" : "Approving"}… → ${body.destination}`;
    forgetLibrary(Number(shared.library.value));
    pollReview();
    return true;
  }
  approve.addEventListener("click", doApprove);

  reject.addEventListener("click", async () => {
    if (fixing) {
      node.closest(".review-group")?.remove();
      return;
    }
    const reason = prompt(`Why is "${item.filename}" rejected? The uploader will see this.`);
    if (!reason?.trim()) return;
    const { status: code, body } = await api(`/api/review/${encodeURIComponent(item.id)}/reject`, {
      method: "POST",
      body: JSON.stringify({ reason }),
    });
    if (code !== 200) {
      status.className = "row-status error";
      status.textContent = body.error ?? "Rejecting failed.";
      return;
    }
    done = true;
    clearFileDraft(item.id);
    node.classList.add("is-done");
    status.className = "row-status";
    status.textContent = "Rejected.";
    approve.disabled = reject.disabled = true;
    pollReview();
  });

  // Drawn like a Kavita series tile: cover art, caption, and a green badge with the issue number.
  const placeholder = () => el("div", { className: "cover-none", textContent: item.kind === "comic" ? "No cover" : item.kind.toUpperCase() });
  let art = placeholder();
  if (item.inspection?.hasCover) {
    art = el("img", { src: `/api/review/${encodeURIComponent(item.id)}/cover${fixing ? `?fix=1&t=${Date.now()}` : ""}`, alt: `Cover of ${item.filename}`, loading: "lazy" });
    art.addEventListener("error", () => art.replaceWith(placeholder())); // unreadable image
  }
  const badge = el("span", { className: "badge" });
  const caption = el("div", { className: "caption" });
  const cover = el("div", { className: "cover-tile" }, art, badge, caption);
  const facts = [formatSize(item.size), item.inspection?.pages ? `${item.inspection.pages} page${item.inspection.pages === 1 ? "" : "s"}` : null,
    item.inspection?.hasEmbeddedMetadata ? "has metadata inside" : "no metadata inside", `${fixing ? "saved" : "will be saved"} as .${item.targetExtension}`].filter(Boolean).join(", ");

  const node = el("div", { className: "review-row", dataset: { id: item.id, mode: fixing ? "fix" : "approve" } },
    cover,
    el("div", { className: "row-body" },
      el("div", { className: "upload-name", textContent: item.filename }),
      el("div", { className: "facts", textContent: facts }),
      el("div", { className: "grid-3" }, field("Number", number), field("Volume", volume), field("Title", title)),
      field("File name", filename),
      destination,
      warnings,
      el("details", { className: "more" }, el("summary", { textContent: "Summary" }), summary),
      el("div", { className: "actions" }, approve, reject, previewBtn, download),
      status,
    ),
  );
  return { node, update, approve: doApprove, done: () => done, inputs: { number, volume, title, summary } };
}

function placeholderCard(item) {
  return el("article", { className: "review-group", dataset: { inspecting: item.id } },
    el("div", { className: "upload-name", textContent: item.filename }),
    el("div", { className: "upload-meta", textContent: `from ${item.uploader} · reading the file…` }));
}

/** "In Kavita ✓ / Open in Kavita", "Checking…", or why Kavita hasn't listed it (with Check again). */
function kavitaLine(item) {
  if (item.status !== "approved") return null;
  if (item.kavitaStatus === "confirmed" && item.kavitaUrl) {
    return el("div", { className: "upload-meta kavita-ok" }, "In Kavita ✓ ", el("a", { href: item.kavitaUrl, textContent: "Open in Kavita" }));
  }
  if (item.kavitaStatus === "missing") {
    const again = el("button", { type: "button", className: "link", textContent: "Check again" });
    again.addEventListener("click", async () => {
      await api(`/api/review/${encodeURIComponent(item.id)}/recheck`, { method: "POST", body: "{}" });
      refreshReview();
    });
    return el("div", { className: "upload-error" }, `${item.kavitaNote} `, again);
  }
  return el("div", { className: "upload-meta", textContent: "Checking that Kavita shows it…" });
}

async function openFix(id) {
  const area = $("fix-area");
  area.replaceChildren(el("p", { className: "muted", textContent: "Reading the file…" }));
  area.scrollIntoView({ behavior: "smooth", block: "start" });
  const { status, body } = await api(`/api/review/${encodeURIComponent(id)}/fix`);
  if (status !== 200) {
    area.replaceChildren(el("p", { className: "error", textContent: body.error ?? "This file can't be fixed right now." }));
    return;
  }
  review = { ...review, libraries: body.libraries };
  area.replaceChildren(groupCard([body.item]));
}

function recentItem(item) {
  const label = { approving: "Approving…", approved: "Approved", fixing: "Saving changes…", rejected: "Rejected" }[item.status] ?? item.status;
  const li = el("li", { className: `upload status-${item.status}` },
    el("div", { className: "upload-name", textContent: item.filename }),
    el("div", {
      className: "upload-meta",
      textContent: `${label}${item.reviewedBy ? ` by ${item.reviewedBy}` : ""}, ${formatDate(item.reviewedAt)}. Uploaded by ${item.uploader}.`,
    }),
  );
  if (item.status === "approved" || item.status === "fixing") {
    li.append(el("div", { className: "upload-meta", textContent: item.finalPath }));
    const line = kavitaLine(item);
    if (line) li.append(line);
    if (item.reviewError) li.append(el("div", { className: "upload-error", textContent: item.reviewError }));
    if (item.canFix) {
      const fix = el("button", { type: "button", className: "btn btn-outline small", textContent: "Fix…" });
      fix.addEventListener("click", () => openFix(item.id));
      li.append(fix);
    }
  }
  if (item.status === "rejected") {
    li.append(el("div", { className: "upload-error", textContent: item.note }));
    if (item.canRestore) {
      const restore = el("button", { type: "button", className: "btn btn-outline small", textContent: "Restore to queue" });
      restore.title = `Rejected files are kept for ${review.rejectedRetentionDays} days`;
      restore.addEventListener("click", async () => {
        await api(`/api/review/${encodeURIComponent(item.id)}/restore`, { method: "POST", body: "{}" });
        refreshReview();
      });
      li.append(restore);
    }
  }
  return li;
}

function groupPending(pending) {
  const groups = new Map();
  for (const item of pending) {
    const key = item.defaults
      ? `${item.uploader}|${item.libraryId}|${normalizeSeries(item.defaults.Series ?? "")}`
      : `inspecting|${item.id}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(item);
  }
  for (const items of groups.values()) {
    items.sort((a, b) => (Number(a.defaults?.Number) || 0) - (Number(b.defaults?.Number) || 0) || a.filename.localeCompare(b.filename, undefined, { numeric: true }));
  }
  return [...groups.values()];
}

function renderRecent() {
  $("review-recent").replaceChildren(...review.recent.map(recentItem));
  $("review-recent-wrap").hidden = review.recent.length === 0;
}

const needsPolling = (items) => items.some((r) => ["approving", "fixing"].includes(r.status) || (r.status === "approved" && r.kavitaStatus === "waiting"));

async function refreshReview() {
  const { status, body } = await api("/api/review");
  if (status !== 200) return;
  review = body;
  // Forget drafts whose upload is no longer awaiting review (approved, rejected or withdrawn).
  const live = new Set(body.pending.map((p) => p.id));
  for (const key of [...reviewDrafts.keys()]) if (!live.has(key.slice(key.indexOf(":") + 1))) reviewDrafts.delete(key);
  $("review-count").textContent = body.pending.length || "";
  $("review-count").hidden = !body.pending.length;
  $("review-empty").hidden = body.pending.length > 0;
  $("review-banner").hidden = true;
  $("review-list").replaceChildren(...groupPending(body.pending).map((items) => (items[0].defaults ? groupCard(items) : placeholderCard(items[0]))));
  renderRecent();
  if (body.pending.some((p) => p.inspecting) || needsPolling(body.recent)) pollReview();
}

// While approvals run or files are being read, refresh statuses without re-rendering the cards
// (that would throw away edits in progress).
let pollTimer = null;
function pollReview() {
  if (pollTimer) return;
  pollTimer = setTimeout(async () => {
    pollTimer = null;
    const { status, body } = await api("/api/review");
    if (status !== 200) return;
    review = body;
    renderRecent();
    const pendingIds = new Set(body.pending.map((p) => p.id));
    const byId = new Map(body.recent.map((r) => [r.id, r]));
    for (const row of document.querySelectorAll(".review-row.is-approving[data-mode='fix']")) {
      const { body: state } = await api(`/api/review/${encodeURIComponent(row.dataset.id)}/state`);
      const item = state.item;
      const line = row.querySelector(".row-status");
      if (item?.status === "approved") {
        row.classList.remove("is-approving");
        if (item.reviewError) {
          line.className = "row-status error";
          line.textContent = item.reviewError;
          row.querySelectorAll("button").forEach((b) => (b.disabled = false));
        } else {
          row.classList.add("is-done");
          line.textContent = `Saved ✓ ${item.finalPath}. Kavita updates in about a minute.`;
        }
      }
    }
    for (const row of document.querySelectorAll(".review-row.is-approving[data-mode='approve']")) {
      const result = byId.get(row.dataset.id);
      const line = row.querySelector(".row-status");
      if (result?.status === "approved") {
        row.classList.replace("is-approving", "is-done");
        line.textContent = `Approved ✓ ${result.finalPath}. It appears in Kavita in about a minute.`;
      } else if (pendingIds.has(row.dataset.id)) {
        const item = body.pending.find((p) => p.id === row.dataset.id);
        row.classList.remove("is-approving");
        line.className = "row-status error";
        line.textContent = item.reviewError ?? "Approval failed.";
        row.querySelectorAll("button").forEach((b) => (b.disabled = false));
      }
    }
    // Files that finished being read replace their placeholder (nothing was being edited there).
    for (const placeholder of document.querySelectorAll("[data-inspecting]")) {
      const item = body.pending.find((p) => p.id === placeholder.dataset.inspecting);
      if (item?.defaults) placeholder.replaceWith(groupCard([item]));
    }
    const shown = new Set([...document.querySelectorAll(".review-row, [data-inspecting]")].map((n) => n.dataset.id ?? n.dataset.inspecting));
    const fresh = body.pending.filter((p) => !shown.has(p.id)).length;
    $("review-banner").hidden = fresh === 0;
    $("review-banner-text").textContent = `${fresh} new upload${fresh === 1 ? "" : "s"} waiting.`;
    $("review-count").textContent = body.pending.length || "";
  $("review-count").hidden = !body.pending.length;
    if (document.querySelector(".review-row.is-approving, [data-inspecting]") || needsPolling(body.recent)) pollReview();
    else refreshUploads();
  }, 3000);
}

$("review-refresh").addEventListener("click", () => refreshReview());

let searchTimer = null;
$("approved-search").addEventListener("input", (event) => {
  clearTimeout(searchTimer);
  const term = event.target.value.trim();
  searchTimer = setTimeout(async () => {
    if (!term) {
      $("approved-results").replaceChildren();
      return;
    }
    const { body } = await api(`/api/review/approved?q=${encodeURIComponent(term)}`);
    const items = body.items ?? [];
    $("approved-results").replaceChildren(...(items.length ? items.map(recentItem) : [el("li", { className: "muted", textContent: "No approved files match." })]));
  }, 300);
});
$("review-banner-refresh").addEventListener("click", () => refreshReview());

// ---------- About: metadata sources + provider admin (phase 2, W8) ----------
// "Metadata sources" lists every provider's required credit and licence, rendered from the adapter
// metadata (GET /api/metadata-sources) so it cannot drift. Reviewers also get a small panel to turn a
// provider on, set or clear its key and run a test; keys are write-only and never rendered back.

const SOURCE_MEDIA = { comic: "Comics", manga: "Manga", book: "Books" };

async function loadAbout() {
  await loadMetadataSources();
  $("providers-panel-wrap").hidden = !me?.isReviewer;
  if (me?.isReviewer) await loadProvidersPanel();
}

async function loadMetadataSources() {
  const wrap = $("metadata-sources");
  const { status, body } = await api("/api/metadata-sources");
  if (status !== 200) {
    wrap.replaceChildren(el("p", { className: "muted", textContent: body.error ?? "Couldn't load the metadata sources." }));
    return;
  }
  const providers = body.providers ?? [];
  if (!providers.length) {
    wrap.replaceChildren(el("p", { className: "muted", textContent: "No metadata providers are built in." }));
    return;
  }
  wrap.replaceChildren(...providers.map((provider) => {
    const state = !provider.enabled ? "Off" : provider.configured ? "On" : "On — needs a key";
    const row = el("div", { className: "source-row" },
      el("div", { className: "source-head" },
        el("strong", { textContent: provider.label }),
        el("span", { className: `chip ${provider.enabled && provider.configured ? "chip-on" : ""}`, textContent: state })),
      el("div", { className: "source-attribution", textContent: provider.attribution }));
    const meta = el("div", { className: "source-meta" },
      el("span", { textContent: (provider.media ?? []).map((media) => SOURCE_MEDIA[media] ?? media).join(", ") }));
    if (provider.licence?.url) {
      meta.append(el("a", { href: provider.licence.url, target: "_blank", rel: "noopener noreferrer", textContent: provider.licence.name || "licence" }));
    } else if (provider.licence?.name) {
      meta.append(el("span", { textContent: provider.licence.name }));
    }
    row.append(meta);
    return row;
  }));
}

async function loadProvidersPanel() {
  const panel = $("providers-panel");
  const { status, body } = await api("/api/admin/providers");
  if (status !== 200) {
    panel.replaceChildren(el("p", { className: "muted", textContent: body.error ?? "Couldn't load the providers." }));
    return;
  }
  panel.replaceChildren(...(body.providers ?? []).map(providerRow));
}

function providerRow(provider) {
  const status = el("span", { className: "muted" });
  const refresh = async (message) => {
    status.textContent = message;
    await loadProvidersPanel();
    await loadMetadataSources();
  };
  const toggle = el("button", {
    type: "button", className: "btn btn-outline small",
    textContent: provider.enabled ? "Turn off" : "Turn on",
  });
  toggle.addEventListener("click", async () => {
    toggle.disabled = true;
    const { status: code, body } = await api("/api/admin/providers", { method: "POST", body: JSON.stringify({ id: provider.id, enabled: !provider.enabled }) });
    if (code !== 200) { toggle.disabled = false; status.className = "row-status error"; status.textContent = body.error ?? "Could not change that."; return; }
    await refresh(provider.enabled ? `${provider.label} is off.` : `${provider.label} is on.`);
  });
  const test = el("button", { type: "button", className: "btn btn-outline small", textContent: "Test" });
  test.addEventListener("click", async () => {
    test.disabled = true;
    status.className = "muted";
    status.textContent = `Testing ${provider.label}…`;
    const { body } = await api(`/api/admin/providers/${encodeURIComponent(provider.id)}/test`, { method: "POST" });
    test.disabled = false;
    status.className = body.ok ? "row-status ok" : "row-status error";
    status.textContent = body.ok ? `${provider.label} answered.` : `No answer: ${body.detail ?? body.error ?? "check the key and try again"}.`;
  });

  const keyInput = el("input", { type: "password", placeholder: provider.hasKey ? "Replace key…" : "Paste key…", autocomplete: "off", spellcheck: "false" });
  const saveKey = el("button", { type: "button", className: "btn btn-outline small", textContent: "Save key" });
  saveKey.addEventListener("click", async () => {
    if (!keyInput.value.trim()) { status.className = "row-status error"; status.textContent = "Paste the key first."; return; }
    saveKey.disabled = true;
    const { status: code, body } = await api("/api/admin/providers", { method: "POST", body: JSON.stringify({ id: provider.id, key: keyInput.value.trim() }) });
    saveKey.disabled = false;
    keyInput.value = "";
    if (code !== 200) { status.className = "row-status error"; status.textContent = body.error ?? "Could not save the key."; return; }
    await refresh("Key saved.");
  });
  const clearKey = provider.hasKey ? el("button", { type: "button", className: "btn btn-outline small", textContent: "Clear key" }) : null;
  if (clearKey) clearKey.addEventListener("click", async () => {
    clearKey.disabled = true;
    await api("/api/admin/providers", { method: "POST", body: JSON.stringify({ id: provider.id, key: "" }) });
    await refresh("Key cleared.");
  });

  const row = el("div", { className: "provider-row" },
    el("div", { className: "provider-head" },
      el("strong", { textContent: provider.label }),
      el("span", { className: "muted", textContent: provider.id }),
      el("span", { className: `chip ${provider.enabled ? "chip-on" : ""}`, textContent: provider.enabled ? "On" : "Off" }),
      el("span", { className: "chip", textContent: provider.hasKey ? "Has key" : provider.keyed ? "No key" : provider.optionalKey ? "Key optional" : "No key needed" })),
    el("div", { className: "source-attribution", textContent: provider.attribution ?? "" }),
    el("div", { className: "provider-actions" }, toggle, (provider.keyed || provider.optionalKey) ? keyInput : null, (provider.keyed || provider.optionalKey) ? saveKey : null, clearKey, test),
    status);
  return row;
}

// ---------- Activity (admins) ----------
// Recent audit-log entries and a few counts, from src/activity.ts.

const ACTIVITY_PAGE = 50;
let activityBefore = null;
let activityLoading = false;

const ACTIVITY_LABEL = {
  login: "signed in",
  login_failed: "failed to sign in",
  logout: "signed out",
  upload_started: "started an upload",
  upload_completed: "finished an upload",
  upload_approved: "approved an upload",
  upload_rejected: "rejected an upload",
  upload_fixed: "fixed a file",
  upload_invalid: "discarded an invalid file",
  upload_duplicate: "found a duplicate",
  upload_withdrawn: "withdrew an upload",
  upload_cancelled: "cancelled an upload",
  upload_approval_failed: "an approval failed",
  upload_restored: "restored an upload",
  sidebar_link: "added the Kavita sidebar link",
  session_revoked: "was signed out (Kavita account changed)",
};

function activityDetail(detail) {
  if (!detail) return "";
  if (typeof detail === "string") return detail;
  return detail.filename ?? detail.reason ?? detail.via ?? "";
}

function activityRow(entry) {
  const li = el("li", { className: "upload" });
  li.append(el("div", { className: "upload-name", textContent: `${entry.username ?? "—"} ${ACTIVITY_LABEL[entry.action] ?? entry.action}` }));
  const bits = [formatDate(entry.at)];
  const detail = activityDetail(entry.detail);
  if (detail) bits.push(detail);
  if (entry.ip) bits.push(entry.ip);
  li.append(el("div", { className: "upload-meta", textContent: bits.join(" · ") }));
  return li;
}

function insightCard(label, value, sub) {
  return el("div", { className: "insight" },
    el("div", { className: "insight-value", textContent: value }),
    el("div", { className: "insight-label", textContent: label }),
    sub ? el("div", { className: "insight-sub", textContent: sub }) : null);
}

function renderInsights(insights) {
  const week = insights.last7Days ?? {};
  const top = (insights.topUploaders ?? [])[0];
  const pending = insights.pending ?? { count: 0, bytes: 0 };
  $("activity-insights").replaceChildren(
    insightCard("Waiting for review", String(pending.count), pending.bytes > 0 ? formatSize(pending.bytes) : ""),
    insightCard("Uploaded · 7 days", String(week.uploaded ?? 0)),
    insightCard("Approved · 7 days", String(week.approved ?? 0)),
    insightCard("Rejected · 7 days", String(week.rejected ?? 0)),
    insightCard("Top uploader · 30 days", top ? top.username : "—", top ? `${top.count} files` : ""),
  );
}

async function refreshActivity(reset) {
  if (activityLoading) return;
  activityLoading = true;
  try {
    if (reset) activityBefore = null;
    const params = new URLSearchParams();
    if ($("activity-action").value) params.set("action", $("activity-action").value);
    const user = $("activity-user").value.trim();
    if (user) params.set("username", user);
    params.set("limit", String(ACTIVITY_PAGE));
    if (activityBefore) params.set("before", String(activityBefore));
    const { status, body } = await api(`/api/admin/activity?${params}`);
    if (status !== 200) return;
    const entries = body.entries ?? [];
    activityBefore = body.nextBefore ?? null;
    const list = $("activity-list");
    const rows = entries.map(activityRow);
    if (reset) list.replaceChildren(...rows);
    else list.append(...rows);
    $("activity-empty").hidden = list.children.length > 0;
    $("activity-more").hidden = !activityBefore;
    if (reset) {
      const { status: code, body: insights } = await api("/api/admin/insights");
      if (code === 200) renderInsights(insights);
    }
  } finally {
    activityLoading = false;
  }
}

$("activity-refresh").addEventListener("click", () => refreshActivity(true));
$("activity-more").addEventListener("click", () => refreshActivity(false));
$("activity-action").addEventListener("change", () => refreshActivity(true));
let activityTimer = null;
$("activity-user").addEventListener("input", () => {
  clearTimeout(activityTimer);
  activityTimer = setTimeout(() => refreshActivity(true), 300);
});

// ---------- Library (reviewers, phase 2 M5) ----------
// A thin, read-only view over Kavita's own catalogue (src/library.ts): Browse (search + library
// filter) and a "Needs metadata" queue. Each row links back to Kavita and, where the portal has a
// file for the series, into the existing review / fix flow. There is deliberately no reader here.

const LIBRARY_PAGE_SIZE = 24;
const PUBLICATION_STATUS = { 0: "Ongoing", 1: "Hiatus", 2: "Completed", 3: "Cancelled", 4: "Ended" };
const libraryState = {
  view: "browse",
  browse: { q: "", libraryId: "", page: 1, rows: [], hasMore: false, loading: false },
  incomplete: { libraryId: "", page: 1, rows: [], hasMore: false, loading: false },
};

function libraryStatus(id, text, problem = false) {
  const node = $(id);
  node.textContent = text ?? "";
  node.classList.toggle("error", problem);
}

function fillLibraryFilter(select) {
  if (select.options.length > 1) return;
  api("/api/libraries").then(({ status, body }) => {
    if (status !== 200) return;
    for (const library of body.libraries ?? []) select.append(el("option", { value: String(library.id), textContent: library.name }));
  });
}

/** Jump to the Review tab and prefill its "find an approved file to fix" search with this series. */
function openReviewForSeries(name) {
  selectTab("review");
  const search = $("approved-search");
  search.closest("details")?.setAttribute("open", "");
  search.value = name;
  search.dispatchEvent(new Event("input", { bubbles: true }));
  search.scrollIntoView({ block: "center" });
}

function libraryRow(row) {
  const meta = el("td");
  if (row.metadataError) {
    meta.append(el("span", { className: "chip chip-warn", textContent: "unavailable" }));
  } else if (!row.missing || row.missing.length === 0) {
    meta.append(el("span", { className: "chip chip-on", textContent: "complete" }));
  } else {
    meta.append(...row.missing.map((field) => el("span", { className: "chip chip-warn", textContent: field })));
  }

  const actions = el("td", { className: "library-actions" });
  if (row.kavitaUrl) {
    actions.append(el("a", { href: row.kavitaUrl, target: "_blank", rel: "noopener noreferrer", textContent: "Open in Kavita" }));
  }
  if (row.review?.pendingUploadId) {
    const review = el("button", { type: "button", className: "link", textContent: "Review file" });
    review.addEventListener("click", () => { selectTab("review"); notice(`A pending file for ${row.name} is waiting for review.`); });
    actions.append(review);
  } else if (row.review?.approvedUploadId) {
    const fix = el("button", { type: "button", className: "link", textContent: "Fix in portal" });
    fix.addEventListener("click", () => openReviewForSeries(row.name));
    actions.append(fix);
  }

  return el("tr", {},
    el("td", { className: "library-name", textContent: row.name }),
    el("td", { className: "muted", textContent: row.libraryName || "—" }),
    el("td", { className: "muted", textContent: row.releaseYear ? String(row.releaseYear) : "—" }),
    el("td", { className: "muted", textContent: PUBLICATION_STATUS[row.publicationStatus] ?? "—" }),
    meta,
    actions);
}

function libraryTable(rows, incomplete) {
  const head = el("thead", {}, el("tr", {},
    el("th", { textContent: "Series" }),
    el("th", { textContent: "Library" }),
    el("th", { textContent: "Year" }),
    el("th", { textContent: "Status" }),
    el("th", { textContent: incomplete ? "Missing" : "Metadata" }),
    el("th", { textContent: "" })));
  return el("table", { className: "library-table" }, head,
    el("tbody", {}, ...rows.map((row) => libraryRow(row))));
}

async function loadLibraryBrowse(reset, refresh = false) {
  const st = libraryState.browse;
  if (st.loading) return;
  if (reset) { st.page = 1; st.rows = []; }
  st.loading = true;
  libraryStatus("library-status", "Loading…");
  const params = new URLSearchParams({ page: String(st.page), pageSize: String(LIBRARY_PAGE_SIZE) });
  if (st.q) params.set("q", st.q);
  if (st.libraryId) params.set("libraryId", st.libraryId);
  if (refresh && st.page === 1) params.set("refresh", "1");
  const { status, body } = await api(`/api/library/series?${params}`);
  st.loading = false;
  if (status !== 200) {
    libraryStatus("library-status", body.error ?? "Could not load the library.", true);
    return;
  }
  st.rows.push(...(body.rows ?? []));
  st.hasMore = !!body.hasMore;
  $("library-results").replaceChildren(...(st.rows.length ? [libraryTable(st.rows, false)] : []));
  $("library-empty").hidden = st.rows.length > 0;
  $("library-empty").textContent = st.q ? `No series match "${st.q}".` : "No series in this library yet.";
  $("library-more").hidden = !st.hasMore;
  libraryStatus("library-status", st.rows.length ? `${st.rows.length} shown` : "");
}

async function loadLibraryIncomplete(reset, refresh = false) {
  const st = libraryState.incomplete;
  if (st.loading) return;
  if (reset) { st.page = 1; st.rows = []; }
  st.loading = true;
  libraryStatus("library-inc-status", "Checking metadata…");
  const params = new URLSearchParams({ page: String(st.page), pageSize: String(LIBRARY_PAGE_SIZE), limit: String(LIBRARY_PAGE_SIZE + 1) });
  if (st.libraryId) params.set("libraryId", st.libraryId);
  if (refresh && st.page === 1) params.set("refresh", "1");
  const { status, body } = await api(`/api/library/incomplete?${params}`);
  st.loading = false;
  if (status !== 200) {
    libraryStatus("library-inc-status", body.error ?? "Could not check the library.", true);
    return;
  }
  st.rows.push(...(body.rows ?? []));
  st.hasMore = !!body.hasMore;
  $("library-inc-results").replaceChildren(...(st.rows.length ? [libraryTable(st.rows, true)] : []));
  $("library-inc-empty").hidden = st.rows.length > 0;
  $("library-inc-more").hidden = !st.hasMore;
  const scanned = body.scanned ?? 0;
  libraryStatus("library-inc-status",
    `${st.rows.length} need${st.rows.length === 1 ? "s" : ""} metadata · checked ${scanned} series${st.hasMore ? "" : " · end of library"}`);
}

function showLibraryView(view) {
  libraryState.view = view === "incomplete" ? "incomplete" : "browse";
  const browse = libraryState.view === "browse";
  $("library-browse").hidden = !browse;
  $("library-incomplete").hidden = browse;
  $("library-view-browse").classList.toggle("is-active", browse);
  $("library-view-browse").setAttribute("aria-selected", browse ? "true" : "false");
  $("library-view-incomplete").classList.toggle("is-active", !browse);
  $("library-view-incomplete").setAttribute("aria-selected", !browse ? "true" : "false");
  if (browse) loadLibraryBrowse(true);
  else loadLibraryIncomplete(true);
}

async function refreshLibrary() {
  fillLibraryFilter($("library-filter"));
  fillLibraryFilter($("library-inc-filter"));
  showLibraryView(libraryState.view);
}

let librarySearchTimer = null;
$("library-view-browse").addEventListener("click", () => showLibraryView("browse"));
$("library-view-incomplete").addEventListener("click", () => showLibraryView("incomplete"));
$("library-search-go").addEventListener("click", () => { libraryState.browse.q = $("library-search").value.trim(); loadLibraryBrowse(true, true); });
$("library-search").addEventListener("input", () => {
  clearTimeout(librarySearchTimer);
  librarySearchTimer = setTimeout(() => { libraryState.browse.q = $("library-search").value.trim(); loadLibraryBrowse(true); }, 300);
});
$("library-filter").addEventListener("change", () => { libraryState.browse.libraryId = $("library-filter").value; loadLibraryBrowse(true); });
$("library-inc-filter").addEventListener("change", () => { libraryState.incomplete.libraryId = $("library-inc-filter").value; loadLibraryIncomplete(true); });
$("library-inc-refresh").addEventListener("click", () => loadLibraryIncomplete(true, true));
$("library-more").addEventListener("click", () => { libraryState.browse.page += 1; loadLibraryBrowse(false); });
$("library-inc-more").addEventListener("click", () => { libraryState.incomplete.page += 1; loadLibraryIncomplete(false); });

// ---------- Page preview (admins) ----------
// Page through a pending comic before approving it (src/review.ts: GET /api/review/:id/page/:n).
let previewState = null; // { id, count, index }

function renderPreview() {
  if (!previewState) return;
  $("preview-img").src = `/api/review/${encodeURIComponent(previewState.id)}/page/${previewState.index}`;
  $("preview-count").textContent = `${previewState.index} / ${previewState.count}`;
  $("preview-prev").disabled = previewState.index <= 1;
  $("preview-next").disabled = previewState.index >= previewState.count;
}

function openPreview(id, count, index = 1) {
  previewState = { id, count, index: Math.min(Math.max(index, 1), count) };
  $("page-preview").hidden = false;
  renderPreview();
}

function closePreview() {
  previewState = null;
  $("page-preview").hidden = true;
  $("preview-img").removeAttribute("src");
}

$("preview-close").addEventListener("click", closePreview);
$("preview-prev").addEventListener("click", () => { if (previewState && previewState.index > 1) { previewState.index -= 1; renderPreview(); } });
$("preview-next").addEventListener("click", () => { if (previewState && previewState.index < previewState.count) { previewState.index += 1; renderPreview(); } });
document.addEventListener("keydown", (event) => {
  if (!previewState) return;
  if (event.key === "Escape") closePreview();
  else if (event.key === "ArrowLeft" && previewState.index > 1) { previewState.index -= 1; renderPreview(); }
  else if (event.key === "ArrowRight" && previewState.index < previewState.count) { previewState.index += 1; renderPreview(); }
});

// ---------- Requests ----------
// Ask for a series/issue (src/requests.ts). Everyone sees "My requests"; reviewers also see the open
// queue with Decline / Mark fulfilled.

function requestStatus(text, problem = false) {
  $("request-status").textContent = text ?? "";
  $("request-status").classList.toggle("error", problem);
}

function requestRow(item, forReviewer) {
  const li = el("li", { className: "upload" });
  li.append(el("div", { className: "upload-name", textContent: `${item.title}${item.number ? ` #${item.number}` : ""}` }));
  const bits = [];
  if (item.libraryName) bits.push(item.libraryName);
  bits.push(`by ${item.username}`);
  bits.push(item.status);
  if (item.note) bits.push(item.note);
  li.append(el("div", { className: "upload-meta", textContent: bits.join(" · ") }));
  if (forReviewer && item.status === "open") {
    const actions = el("div", { className: "actions" });
    const fulfil = el("button", { type: "button", className: "btn btn-outline-primary small", textContent: "Mark fulfilled" });
    fulfil.addEventListener("click", async () => { await api(`/api/requests/${item.id}/fulfil`, { method: "POST" }); refreshRequests(); });
    const decline = el("button", { type: "button", className: "btn btn-outline small", textContent: "Decline" });
    decline.addEventListener("click", async () => { await api(`/api/requests/${item.id}/decline`, { method: "POST" }); refreshRequests(); });
    actions.append(fulfil, decline);
    li.append(actions);
  }
  return li;
}

async function refreshRequests() {
  const { status, body } = await api("/api/requests");
  if (status !== 200) return;
  const mine = body.mine ?? [];
  $("requests-mine-empty").hidden = mine.length > 0;
  $("requests-mine").replaceChildren(...mine.map((item) => requestRow(item, false)));
  const open = body.open ?? [];
  $("requests-open-wrap").hidden = !(body.canReview && open.length);
  $("requests-open").replaceChildren(...open.map((item) => requestRow(item, true)));
}

async function addRequest() {
  const title = $("request-title").value.trim();
  if (!title) return requestStatus("Enter a title.", true);
  const libraryId = $("request-library").value ? Number($("request-library").value) : undefined;
  const { status, body } = await api("/api/requests", {
    method: "POST",
    body: JSON.stringify({ title, number: $("request-number").value.trim(), note: $("request-note").value.trim(), libraryId }),
  });
  if (status === 200) {
    $("request-title").value = "";
    $("request-number").value = "";
    $("request-note").value = "";
    requestStatus("Asked — an admin will look at it.");
    refreshRequests();
  } else {
    requestStatus(body.error || "Could not send the request.", true);
  }
}

async function fillRequestLibraries() {
  const select = $("request-library");
  if (select.options.length > 1) return;
  const { status, body } = await api("/api/libraries");
  if (status !== 200) return;
  for (const library of body.libraries ?? []) select.append(el("option", { value: String(library.id), textContent: library.name }));
}

$("request-add").addEventListener("click", addRequest);

// ---------- Notifications ----------
// Where to tell a user about their uploads (src/notify.ts). Off by default.

const NOTIFY_EVENT_IDS = {
  approved: "notify-approved",
  rejected: "notify-rejected",
  fixed: "notify-fixed",
  invalid: "notify-invalid",
  duplicate: "notify-duplicate",
  request: "notify-request",
};

function notifyStatus(text, problem = false) {
  $("notify-status").textContent = text ?? "";
  $("notify-status").classList.toggle("error", problem);
}

async function loadNotifications() {
  const { status, body } = await api("/api/notifications");
  if (status !== 200) return;
  $("notify-channel").value = body.channel || "off";
  $("notify-target").value = body.target || "";
  const events = new Set(body.events || []);
  for (const [event, id] of Object.entries(NOTIFY_EVENT_IDS)) $(id).checked = events.has(event);
}

async function saveNotifications() {
  const events = Object.entries(NOTIFY_EVENT_IDS).filter(([, id]) => $(id).checked).map(([event]) => event);
  const { status, body } = await api("/api/notifications", {
    method: "POST",
    body: JSON.stringify({ channel: $("notify-channel").value, target: $("notify-target").value.trim(), events }),
  });
  notifyStatus(status === 200 ? "Saved." : body.error || "Could not save.", status !== 200);
}

async function testNotification() {
  notifyStatus("Sending…");
  const { status, body } = await api("/api/notifications/test", { method: "POST" });
  notifyStatus(status === 200 ? "Test sent." : body.error || "Could not send.", status !== 200);
}

$("notify-save").addEventListener("click", saveNotifications);
$("notify-test").addEventListener("click", testNotification);

// Coming from Kavita's sidebar link (GET /login) when it didn't work.
const signin = new URLSearchParams(location.search).get("signin");
if (signin) {
  history.replaceState(null, "", "/");
  $("login-error").textContent = signin === "kavita-down"
    ? "Kavita isn't reachable right now, so the link from Kavita couldn't sign you in. Try again shortly."
    : "The link from Kavita couldn't sign you in. Sign in with your Kavita password; that also repairs the link.";
}

await refreshMe();
