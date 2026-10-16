import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { config } from "./config.js";

mkdirSync(config.dataDir, { recursive: true });

export const db = new DatabaseSync(join(config.dataDir, "companion.db"));

db.exec(`
  PRAGMA journal_mode = WAL;
  PRAGMA foreign_keys = ON;

  -- One row per signed-in browser. Only a SHA-256 of the cookie token is stored.
  CREATE TABLE IF NOT EXISTS sessions (
    token_hash   TEXT PRIMARY KEY,
    user_id      INTEGER NOT NULL,
    username     TEXT NOT NULL,
    roles        TEXT NOT NULL,          -- JSON array of Kavita role names at login
    created_at   INTEGER NOT NULL,       -- unix ms
    expires_at   INTEGER NOT NULL,
    ip           TEXT
  );
  CREATE INDEX IF NOT EXISTS sessions_expires ON sessions (expires_at);

  -- One row per upload, from the moment it starts.
  -- status: uploading -> checking -> pending -> approving -> approved
  --                                          -> rejected (file kept rejectedRetentionDays, can be restored)
  --         or invalid | duplicate | cancelled | expired | withdrawn
  CREATE TABLE IF NOT EXISTS uploads (
    id            TEXT PRIMARY KEY,      -- tus upload id
    owner_id      INTEGER NOT NULL,      -- Kavita user id
    owner_name    TEXT NOT NULL,
    filename      TEXT NOT NULL,         -- as sent by the browser; display only, never used as a path
    ext           TEXT NOT NULL,
    size          INTEGER NOT NULL,
    library_id    INTEGER NOT NULL,
    library_name  TEXT NOT NULL,
    status        TEXT NOT NULL,
    detected_type TEXT,                  -- zip | rar | 7z | epub | pdf, from the file's first bytes
    sha256        TEXT,
    stored_path   TEXT,                  -- set once the file is in the pending area
    error         TEXT,                  -- shown to the uploader when status is invalid/duplicate
    created_at    INTEGER NOT NULL,
    updated_at    INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS uploads_owner ON uploads (owner_id, created_at);
  CREATE INDEX IF NOT EXISTS uploads_status ON uploads (status);
  CREATE INDEX IF NOT EXISTS uploads_sha256 ON uploads (sha256);

  -- Who did what: logins, uploads, approvals, rejections.
  CREATE TABLE IF NOT EXISTS audit_log (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    at         INTEGER NOT NULL,
    username   TEXT,
    action     TEXT NOT NULL,
    detail     TEXT,
    ip         TEXT
  );

  -- Where to tell a user about their uploads (webhook / ntfy / Discord). No row = notifications off.
  CREATE TABLE IF NOT EXISTS notification_prefs (
    user_id    INTEGER PRIMARY KEY,
    channel    TEXT NOT NULL,
    target     TEXT NOT NULL,
    events     TEXT NOT NULL,          -- JSON array, e.g. ["approved","rejected"]
    updated_at INTEGER NOT NULL
  );

  -- Delivery outbox: one row per notification, sent (and retried) by a background worker.
  CREATE TABLE IF NOT EXISTS notifications (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id      INTEGER NOT NULL,
    event        TEXT NOT NULL,
    title        TEXT NOT NULL,
    body         TEXT NOT NULL,
    url          TEXT,
    channel      TEXT NOT NULL,
    target       TEXT NOT NULL,
    created_at   INTEGER NOT NULL,
    attempts     INTEGER NOT NULL DEFAULT 0,
    delivered_at INTEGER,
    last_error   TEXT
  );
  CREATE INDEX IF NOT EXISTS notifications_pending ON notifications (delivered_at, attempts);

  -- Series/issues users ask for. An admin fulfils them manually, or a matching approval does it.
  CREATE TABLE IF NOT EXISTS requests (
    id                  INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id             INTEGER NOT NULL,
    username            TEXT NOT NULL,
    title               TEXT NOT NULL,   -- the series or title wanted
    number              TEXT,            -- optional issue/volume
    library_id          INTEGER,
    library_name        TEXT,
    note                TEXT,
    status              TEXT NOT NULL,   -- open | fulfilled | declined
    created_at          INTEGER NOT NULL,
    decided_by          TEXT,
    decided_at          INTEGER,
    fulfilled_upload_id TEXT
  );
  CREATE INDEX IF NOT EXISTS requests_status ON requests (status, created_at);
`);

// Columns added after the table first shipped (M3). CREATE TABLE IF NOT EXISTS won't add them.
const uploadColumns = new Set((db.prepare("PRAGMA table_info(uploads)").all() as { name: string }[]).map((c) => c.name));
for (const [name, type] of [
  ["final_path", "TEXT"],      // where an approved file was placed (companion's path)
  ["reviewed_by", "TEXT"],
  ["reviewed_at", "INTEGER"],
  ["inspection", "TEXT"],      // JSON: page count, embedded metadata (M5)
  ["cover_path", "TEXT"],      // extracted first page, for the review screen
  ["approval_plan", "TEXT"],   // JSON: what the background approval job will do
  ["review_error", "TEXT"],    // why the last approval attempt failed (shown to admins)
  ["final_sha256", "TEXT"],    // checksum of the file as placed in the library (after repacking)
  ["kavita_status", "TEXT"],   // after approval: waiting | confirmed | missing (is it visible in Kavita?)
  ["kavita_series_id", "INTEGER"], // the Kavita series the approved file landed in
  ["kavita_note", "TEXT"],     // explanation when Kavita hasn't picked the file up
  ["kavita_since", "INTEGER"], // when the file was placed (approval or fix), for the confirmation timeouts
  ["kavita_rescanned", "INTEGER"], // 1 once a second scan was requested
] as const) {
  if (!uploadColumns.has(name)) db.exec(`ALTER TABLE uploads ADD COLUMN ${name} ${type}`);
}

const sessionColumns = new Set((db.prepare("PRAGMA table_info(sessions)").all() as { name: string }[]).map((c) => c.name));
for (const [name, type] of [
  ["kavita_token", "TEXT"],        // the user's Kavita session (sealed), to re-read their theme
  ["kavita_refresh", "TEXT"],      // its refresh token (sealed)
  ["theme_checked_at", "INTEGER"], // when the theme was last re-read from Kavita
] as const) {
  if (!sessionColumns.has(name)) db.exec(`ALTER TABLE sessions ADD COLUMN ${name} ${type}`);
}
if (!sessionColumns.has("theme_id")) {
  // The user's Kavita theme, read at sign-in (themes.ts); null = the server's default theme.
  db.exec("ALTER TABLE sessions ADD COLUMN theme_id INTEGER");
}
if (!sessionColumns.has("roles_checked_at")) {
  // When the roles were last re-read from Kavita (M4); starts at login time.
  db.exec("ALTER TABLE sessions ADD COLUMN roles_checked_at INTEGER NOT NULL DEFAULT 0");
}

const insertAudit = db.prepare(
  "INSERT INTO audit_log (at, username, action, detail, ip) VALUES (?, ?, ?, ?, ?)",
);

export function audit(action: string, username: string | null, ip: string | null, detail?: unknown) {
  insertAudit.run(Date.now(), username, action, detail === undefined ? null : JSON.stringify(detail), ip);
}
