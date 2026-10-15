// Encryption at rest for the Kavita session tokens kept with portal sessions (themes.ts uses them to
// follow the user's Kavita theme). AES-256-GCM; the key comes from COMPANION_SECRET (created by
// setup.sh), or, if that is unset, is derived from the portal's Kavita key.
import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";
import { config } from "./config.js";

const key = createHash("sha256").update(`kavita-companion:${config.sessionSecret || config.kavitaAuthKey}`).digest();

export function seal(text: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const data = Buffer.concat([cipher.update(text, "utf8"), cipher.final()]);
  return [iv, cipher.getAuthTag(), data].map((b) => b.toString("base64url")).join(".");
}

/** Null if the value was sealed with another key or has been tampered with. */
export function unseal(sealed: string | null): string | null {
  if (!sealed) return null;
  try {
    const [iv, tag, data] = sealed.split(".").map((p) => Buffer.from(p, "base64url"));
    const decipher = createDecipheriv("aes-256-gcm", key, iv!);
    decipher.setAuthTag(tag!);
    return Buffer.concat([decipher.update(data!), decipher.final()]).toString("utf8");
  } catch {
    return null;
  }
}
