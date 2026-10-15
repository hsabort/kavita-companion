// Daily copy of the companion database (sessions, uploads, audit log) to <dataDir>/backups,
// keeping the newest BACKUP_KEEP_DAYS. VACUUM INTO writes a consistent snapshot while the app runs.
// Uploaded files themselves are not included: pending ones live in ~/media/.incoming and approved
// ones are in the Kavita libraries.
import { mkdir, readdir, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import { config } from "./config.js";
import { db } from "./db.js";

const BACKUP_DIR = join(config.dataDir, "backups");
const KEEP = Number(process.env.BACKUP_KEEP_DAYS ?? 14);
const NAME = /^kavita-companion-(\d{4}-\d{2}-\d{2})\.db$/;

export async function backupDatabase(): Promise<string | null> {
  await mkdir(BACKUP_DIR, { recursive: true });
  const today = new Date().toISOString().slice(0, 10);
  const target = join(BACKUP_DIR, `kavita-companion-${today}.db`);
  if (await stat(target).then(() => true, () => false)) return null; // already done today

  db.exec(`VACUUM INTO '${target.replace(/'/g, "''")}'`);

  const backups = (await readdir(BACKUP_DIR)).filter((f) => NAME.test(f)).sort();
  for (const old of backups.slice(0, Math.max(0, backups.length - KEEP))) {
    await rm(join(BACKUP_DIR, old), { force: true });
  }
  return target;
}
