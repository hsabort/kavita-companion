// All runtime settings come from environment variables (set in compose.yaml from ../.env).

function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Missing required environment variable ${name}`);
  return value;
}

export const config = {
  port: Number(process.env.PORT ?? 3000),
  // Kavita as seen from inside the compose network.
  kavitaUrl: process.env.KAVITA_URL ?? "http://kavita:5000",
  // Auth key of the companion-svc Kavita admin user.
  kavitaAuthKey: required("KAVITA_AUTH_KEY"),
  // The only origin browsers may send state-changing requests from (CSRF check).
  publicOrigin: required("PUBLIC_ORIGIN"),
  // Kavita's own public address, for "Back to Kavita" links.
  kavitaPublicUrl: process.env.KAVITA_PUBLIC_URL ?? "https://paragon.greyarea.contact:20005",
  dataDir: process.env.DATA_DIR ?? "/data",
  sessionTtlHours: Number(process.env.SESSION_TTL_HOURS ?? 12),
  // Encrypts the Kavita session tokens stored with portal sessions (seal.ts). setup.sh generates it.
  sessionSecret: process.env.COMPANION_SECRET ?? "",
  // Requests are only trusted for X-Forwarded-For when they come from Caddy on the compose network.
  trustedProxy: process.env.TRUSTED_PROXY ?? "172.30.0.0/24",

  // ~/media on the host, read-write. Kavita mounts only its library subfolders (read-only) as /data/<lib>.
  mediaDir: process.env.MEDIA_DIR ?? "/media",
  // How Kavita's paths start; /data/comics in Kavita is <mediaDir>/comics here.
  kavitaDataPrefix: process.env.KAVITA_DATA_PREFIX ?? "/data",
  // Staging area for uploads: inside mediaDir (same mount, so approval is an instant rename) but
  // outside every library folder, so Kavita never sees it.
  incomingDir: process.env.INCOMING_DIR ?? "/media/.incoming",
  rejectedRetentionDays: Number(process.env.REJECTED_RETENTION_DAYS ?? 7),

  // Upload limits (CLAUDE.md, Phase 2).
  maxFileGb: Number(process.env.MAX_FILE_GB ?? 8),
  maxPendingGbPerUser: Number(process.env.MAX_PENDING_GB_PER_USER ?? 50),
  maxConcurrentPerUser: Number(process.env.MAX_CONCURRENT_UPLOADS_PER_USER ?? 3),
  minFreeDiskGb: Number(process.env.MIN_FREE_DISK_GB ?? 25),
  abandonedUploadHours: Number(process.env.ABANDONED_UPLOAD_HOURS ?? 24),
};
