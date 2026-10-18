// Follow the user's Kavita theme. Kavita themes are CSS files that override Kavita's own CSS custom
// properties inside `:root .bg-<name> { ... }`; anything a theme doesn't set falls back to the
// built-in Dark theme (which has no file). We read only those custom properties, keep the ones the
// portal maps onto its design tokens, and accept only plain colour values (no url(), no other CSS),
// so even an uploaded custom theme can't inject styles or load anything into the portal.
import * as kavita from "./kavita.js";

/** Kavita variable -> portal token (public/style.css documents the same pairs). */
const MAP: Record<string, string> = {
  "--bs-body-bg": "--bg",
  "--body-text-color": "--text",
  "--primary-color": "--primary",
  "--primary-color-darker-shade": "--primary-hover",
  "--btn-primary-text-color": "--on-primary",
  "--navbar-bg-color": "--navbar",
  "--navbar-text-color": "--navbar-text",
  "--input-bg-color": "--input-bg",
  "--input-text-color": "--input-text",
  "--input-placeholder-color": "--input-placeholder",
  "--error-color": "--error",
  "--btn-secondary-bg-color": "--secondary",
  "--text-muted-color": "--muted",
  "--card-bg-color": "--surface-solid",
};

export interface PortalTheme {
  id: number | null;
  name: string;
  scheme: "light" | "dark";
  tokens: Record<string, string>; // portal token -> value; empty for Dark (the CSS defaults)
}

const DARK_THEME: PortalTheme = { id: null, name: "Dark", scheme: "dark", tokens: {} };

// A colour value: hex, a named colour, or rgb()/rgba()/hsl()/hsla() with plain numeric arguments.
const SAFE_VALUE = /^(#[0-9a-f]{3,8}|[a-z]{3,30}|(rgba?|hsla?)\([\d\s.,%/+-]{1,80}\))$/i;

/** Custom properties declared in a theme's top-level `:root .bg-x` / `.bg-x` / `:root` rule(s). */
export function themeVariables(css: string): Record<string, string> {
  const vars: Record<string, string> = {};
  const withoutComments = css.replace(/\/\*[\s\S]*?\*\//g, "");
  for (const block of withoutComments.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    // Statements before a rule (e.g. @import ...;) end up in the captured text; keep only the selector.
    const selector = block[1]!.split(";").pop()!.trim();
    if (!/^(:root|(:root\s+)?\.bg-[\w-]+)$/.test(selector)) continue;
    for (const decl of block[2]!.matchAll(/(--[\w-]+)\s*:\s*([^;]+);?/g)) {
      vars[decl[1]!] = decl[2]!.trim().replace(/\s*!important$/i, "");
    }
  }
  return vars;
}

function resolve(name: string, vars: Record<string, string>, depth = 0): string | null {
  // Only the theme's own variables resolve. A reference to a variable the theme does not define is
  // dropped, so the portal's stylesheet default applies (public/style.css `:root`).
  const raw = vars[name];
  if (raw === undefined || depth > 5) return null;
  const ref = /^var\(\s*(--[\w-]+)\s*(?:,\s*([^)]+))?\)$/.exec(raw);
  if (ref) return resolve(ref[1]!, vars, depth + 1) ?? (ref[2] && SAFE_VALUE.test(ref[2].trim()) ? ref[2].trim() : null);
  return SAFE_VALUE.test(raw) ? raw : null;
}

/** Turn a Kavita theme's CSS into portal tokens. Only variables the theme actually sets are applied. */
export function tokensFromCss(css: string): { tokens: Record<string, string>; scheme: "light" | "dark" } {
  const vars = themeVariables(css);
  const tokens: Record<string, string> = {};
  for (const [kavitaVar, token] of Object.entries(MAP)) {
    if (!(kavitaVar in vars)) continue;
    const value = resolve(kavitaVar, vars);
    if (value) tokens[token] = value;
  }
  const scheme = (vars["--color-scheme"] ?? "").trim().toLowerCase() === "light" ? "light" : "dark";
  return { tokens, scheme };
}

// ---------- Kavita lookups (admin key), cached ----------

interface SiteTheme { id: number; name: string; isDefault: boolean; provider: number; selector: string }

// Kavita switches themes with a body class named after the theme ("bg-<name>"). For a few names that
// class is also a Bootstrap background utility (with !important), which then decides the page colour
// instead of the theme's --bs-body-bg: Dark renders #212529, Light #f8f9fa.
const BOOTSTRAP_BG: Record<string, string> = { "bg-dark": "#212529", "bg-light": "#f8f9fa", "bg-white": "#fff" };
const CACHE_MS = 10 * 60_000;
let themeList: { at: number; value: SiteTheme[] } | null = null;
const themeCache = new Map<number, { at: number; value: PortalTheme }>();

async function themes(fresh = false): Promise<SiteTheme[]> {
  if (!fresh && themeList && Date.now() - themeList.at < CACHE_MS) return themeList.value;
  const value = (await kavita.adminGet("/api/Theme")) as SiteTheme[];
  themeList = { at: Date.now(), value };
  return value;
}

/** The portal theme for a Kavita theme id (null = the server's default theme). Never throws. */
export async function portalTheme(themeId: number | null): Promise<PortalTheme> {
  try {
    let list = await themes();
    // A theme installed since the list was cached: look again before falling back to the default.
    if (themeId !== null && !list.some((t) => t.id === themeId)) list = await themes(true);
    const theme = list.find((t) => t.id === themeId) ?? list.find((t) => t.isDefault);
    if (!theme) return DARK_THEME;
    const cached = themeCache.get(theme.id);
    if (cached && Date.now() - cached.at < CACHE_MS) return cached.value;
    let value: PortalTheme = { ...DARK_THEME, id: theme.id, name: theme.name };
    // System themes other than files (Kavita's built-in Dark) have no content: Dark defaults apply.
    const css = await kavita.adminGetText(`/api/Theme/download-content?themeId=${theme.id}`).catch(() => null);
    if (css) value = { id: theme.id, name: theme.name, ...tokensFromCss(css) };
    const utilityBg = BOOTSTRAP_BG[theme.selector];
    if (utilityBg && theme.selector !== "bg-dark") value = { ...value, tokens: { ...value.tokens, "--bg": utilityBg } };
    themeCache.set(theme.id, { at: Date.now(), value });
    return value;
  } catch {
    return DARK_THEME;
  }
}

/** The theme a user has chosen in Kavita, read with their own session token at sign-in. */
export async function userThemeId(token: string): Promise<number | null> {
  try {
    const res = await kavita.asUser(token, "GET", "/api/Users/get-preferences");
    if (!res.ok) return null;
    const prefs = (await res.json()) as { theme?: { id?: number } | null };
    return prefs.theme?.id ?? null;
  } catch {
    return null;
  }
}
