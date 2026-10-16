import { fileURLToPath } from "node:url";
import fastifyCookie from "@fastify/cookie";
import fastifyRateLimit from "@fastify/rate-limit";
import fastifyStatic from "@fastify/static";
import Fastify from "fastify";
import { createHash } from "node:crypto";
import {
  createSession, currentUser, endSession, permissions, purgeExpiredSessions, recheckSessionRoles, SESSION_COOKIE, sessionThemeId,
} from "./auth.js";
import { registerActivityRoutes } from "./activity.js";
import { backupDatabase } from "./backup.js";
import { registerLibraryRoutes } from "./library.js";
import { drainNotifications, registerNotifyRoutes } from "./notify.js";
import { purgeExpiredCache } from "./providers/cache.js";
import "./providers/index.js"; // register the real provider adapters (Metron) with the registry
import { registerProviderRoutes } from "./providers/routes.js";
import { registerRequestRoutes } from "./requests.js";
import { ensureSidebarLink, registerSidebarRoutes } from "./sidebar.js";
import { portalTheme, userThemeId } from "./themes.js";
import { config } from "./config.js";
import { audit } from "./db.js";
import * as kavita from "./kavita.js";
import { confirmInKavita, purgeOldRejections, registerReviewRoutes } from "./review.js";
import { purgeAbandonedUploads, registerUploadRoutes } from "./uploads.js";

const app = Fastify({
  logger: {
    level: "info",
    // Kavita's sidebar link carries the user's auth key in the URL; never write it to logs.
    serializers: {
      req: (req) => ({
        method: req.method,
        url: req.url.replace(/([?&]apiKey=)[^&]*/gi, "$1[redacted]"),
        host: req.host,
        remoteAddress: req.ip,
      }),
    },
  },
  trustProxy: config.trustedProxy,
  bodyLimit: 64 * 1024, // JSON API only; uploads get their own route and limits in M2
});

await app.register(fastifyCookie);
// General limit for every route: 600 requests a minute per signed-in session, or per visitor IP when
// signed out. (Real client IPs arrive via the PROXY protocol on the Incus port forward; see
// caddy/Caddyfile.) The login route has its own stricter limits. preHandler (not the default
// onRequest) so the parsed body is available to the login keyGenerator.
await app.register(fastifyRateLimit, {
  global: true,
  max: 600,
  timeWindow: "1 minute",
  hook: "preHandler",
  keyGenerator: (request) => {
    const token = request.cookies[SESSION_COOKIE];
    return token ? "s:" + createHash("sha256").update(token).digest("hex") : "ip:" + request.ip;
  },
});
await app.register(fastifyStatic, {
  root: fileURLToPath(new URL("../public", import.meta.url)),
});

app.addHook("onSend", async (_request, reply) => {
  // img-src blob: is for Uppy's local file previews.
  reply.header("Content-Security-Policy",
    "default-src 'self'; img-src 'self' blob: data:; frame-ancestors 'none'; base-uri 'none'; form-action 'self'");
  reply.header("X-Content-Type-Options", "nosniff");
  reply.header("Referrer-Policy", "same-origin");
  reply.header("Strict-Transport-Security", "max-age=31536000");
});

// CSRF: the session cookie is SameSite=Strict, and every state-changing request must also come
// from our own origin. Browsers always send Origin on cross-site POSTs, so a missing or foreign
// Origin is refused.
app.addHook("onRequest", async (request, reply) => {
  if (request.method === "GET" || request.method === "HEAD" || request.method === "OPTIONS") return;
  if (request.headers.origin !== config.publicOrigin) {
    return reply.code(403).send({ error: "Cross-origin request refused" });
  }
});

// Keep each session's roles in step with Kavita (disabled / Read Only / Admin removed).
app.addHook("onRequest", async (request) => {
  await recheckSessionRoles(request);
});

app.get("/api/health", async (_request, reply) => {
  try {
    await kavita.libraries();
    return { ok: true, kavita: "reachable" };
  } catch (err) {
    app.log.warn({ err }, "Kavita health check failed");
    return reply.code(503).send({ ok: false, kavita: "unreachable" });
  }
});

// Failed sign-ins over the last 15 minutes: per client IP (any username) and per (IP, username).
// Only failures count, so people who sign in successfully, often or from a shared network, are
// never locked out; a successful sign-in clears that account's failures from that IP.
const MAX_FAILED_LOGINS_PER_IP = 30;
const MAX_FAILED_LOGINS_PER_ACCOUNT = 10;
const FAILED_LOGIN_WINDOW_MS = 15 * 60_000;
const failedLogins = new Map<string, number[]>();
function recentFailures(key: string): number {
  const recent = (failedLogins.get(key) ?? []).filter((t) => Date.now() - t < FAILED_LOGIN_WINDOW_MS);
  if (recent.length) failedLogins.set(key, recent);
  else failedLogins.delete(key);
  return recent.length;
}
const accountKey = (ip: string, username: string) => `${ip}|${username.toLowerCase()}`;
function failedLoginsFromIp(ip: string): number {
  return recentFailures(ip);
}
function recordFailedLogin(ip: string, username?: string) {
  for (const key of username ? [ip, accountKey(ip, username)] : [ip]) {
    failedLogins.set(key, [...(failedLogins.get(key) ?? []), Date.now()]);
  }
}

app.post<{ Body: { username?: unknown; password?: unknown } }>(
  "/api/login",
  {
    // Failed-attempt limits are applied in the handler (see failedLogins); Kavita adds its own
    // account lockout.
    schema: {
      body: {
        type: "object",
        required: ["username", "password"],
        properties: {
          username: { type: "string", minLength: 1, maxLength: 100 },
          password: { type: "string", minLength: 1, maxLength: 256 },
        },
      },
    },
  },
  async (request, reply) => {
    const { username, password } = request.body as { username: string; password: string };
    if (failedLoginsFromIp(request.ip) >= MAX_FAILED_LOGINS_PER_IP
      || recentFailures(accountKey(request.ip, username)) >= MAX_FAILED_LOGINS_PER_ACCOUNT) {
      return reply.code(429).send({ error: "Too many failed sign-ins. Wait 15 minutes and try again." });
    }
    const result = await kavita.login(username, password);
    if (!result.ok) {
      if (result.reason !== "unavailable") recordFailedLogin(request.ip, username);
      audit("login_failed", username, request.ip, { reason: result.reason });
      if (result.reason === "unavailable") {
        return reply.code(503).send({ error: "Kavita is not reachable right now. Try again shortly." });
      }
      if (result.reason === "disabled") {
        return reply.code(403).send({ error: "This Kavita account is disabled." });
      }
      return reply.code(401).send({ error: "Incorrect username or password." });
    }
    failedLogins.delete(accountKey(request.ip, username));
    createSession(reply, result.user, request.ip, await userThemeId(result.token), result.tokens);
    audit("login", result.user.username, request.ip);
    // While we briefly hold the user's Kavita session, make sure their Kavita sidebar has the
    // "Uploads" link (it can only be added as them). Failure here never blocks signing in.
    // Kavita won't create auth keys for Read Only accounts, and they can't upload anyway.
    let sidebar: string | null = null;
    try {
      if (permissions(result.user.roles).canUpload) sidebar = await ensureSidebarLink(result.token);
      if (sidebar !== "present") audit("sidebar_link", result.user.username, request.ip, { result: sidebar });
    } catch (err) {
      request.log.warn({ err }, "could not add the Kavita sidebar link");
    }
    return { user: { username: result.user.username, ...permissions(result.user.roles) }, sidebar };
  },
);

// Kavita's sidebar "Uploads" link opens /login?apiKey=<the user's own key>. Sign them in and
// redirect straight away, so the key doesn't stay in the address bar.
// Failed attempts count toward the per-IP failed sign-in limit; successful ones never limit anyone.
app.get<{ Querystring: { apiKey?: string } }>("/login", async (request, reply) => {
  const apiKey = request.query.apiKey ?? "";
  if (!/^[A-Za-z0-9_-]{8,128}$/.test(apiKey) || failedLoginsFromIp(request.ip) >= MAX_FAILED_LOGINS_PER_IP) {
    return reply.redirect("/?signin=link-failed");
  }
  const result = await kavita.loginWithAuthKey(apiKey);
  if (!result.ok || !result.user.roles.includes("Login")) {
    if (!result.ok && result.reason !== "unavailable") recordFailedLogin(request.ip);
    audit("login_failed", result.ok ? result.user.username : null, request.ip, { via: "kavita-sidebar", reason: result.ok ? "disabled" : result.reason });
    return reply.redirect(`/?signin=${!result.ok && result.reason === "unavailable" ? "kavita-down" : "link-failed"}`);
  }
  endSession(request, reply); // replace any session from another account
  // Opening Uploads from Kavita is also when the portal picks up a changed Kavita theme.
  createSession(reply, result.user, request.ip, await userThemeId(result.token), result.tokens);
  audit("login", result.user.username, request.ip, { via: "kavita-sidebar" });
  return reply.redirect("/");
});

// The theme only (the page asks when it regains focus and every 30 s, to follow changes made in Kavita).
app.get("/api/theme", async (request) => {
  const user = currentUser(request);
  return { theme: await portalTheme(user ? await sessionThemeId(request) : null) };
});

app.post("/api/logout", async (request, reply) => {
  const user = currentUser(request);
  endSession(request, reply);
  if (user) audit("logout", user.username, request.ip);
  return { ok: true };
});

// "Am I signed in?" — answers { user: null } rather than 401, so a first visit doesn't log an error.
// Also returns the Kavita theme to use: the user's current one, or the server's default.
app.get("/api/me", async (request) => {
  const user = currentUser(request);
  const theme = await portalTheme(user ? await sessionThemeId(request) : null);
  if (!user) return { user: null, kavitaUrl: config.kavitaPublicUrl, theme };
  return {
    user: { username: user.username, canUpload: user.canUpload, isReviewer: user.isReviewer },
    kavitaUrl: config.kavitaPublicUrl,
    theme,
  };
});

await registerUploadRoutes(app);
await registerReviewRoutes(app);
await registerActivityRoutes(app);
await registerLibraryRoutes(app);
await registerNotifyRoutes(app);
await registerRequestRoutes(app);
await registerSidebarRoutes(app);
await registerProviderRoutes(app);

async function hourlyJobs() {
  purgeExpiredSessions();
  for (const [name, job] of [
    ["purge abandoned uploads", purgeAbandonedUploads],
    ["purge old rejections", purgeOldRejections],
    ["deliver notifications", drainNotifications],
    ["purge metadata cache", async () => { purgeExpiredCache(); }],
    ["database backup", backupDatabase],
  ] as const) {
    await job().catch((err: unknown) => app.log.error({ err }, `${name} failed`));
  }
}
void hourlyJobs();
// Every minute: check that recently approved/fixed files show up in Kavita.
setInterval(() => void confirmInKavita().catch((err: unknown) => app.log.error({ err }, "Kavita confirmation failed")), 60_000).unref();
setInterval(() => void hourlyJobs(), 3_600_000).unref();

await app.listen({ host: "0.0.0.0", port: config.port });
