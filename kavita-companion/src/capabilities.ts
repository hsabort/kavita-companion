// Which optional external tools this image carries.
//
// The default image is permissive and ships neither 7-Zip (`7zzs`) nor KindleUnpack; the optional
// `-formats` image adds both (design §7.1). Zip/EPUB/cbz reading is in-process and always present.
// The probe records what is actually available at boot, so an operator can tell the two images
// apart from the health endpoint, and the typed error below names the image that would fix a
// refusal.
//
// This module is deliberately free of side effects on import (no database, no route registration):
// a pure test can import it directly.
import { execFile } from "node:child_process";
import { config } from "./config.js";

/** A capability that is not always present. `zip` is always available, so it is not in this union. */
export type Capability = "archive-extras" | "kindle";

/** What the running image can do. `zip` is in-process, so it is always `true`. */
export interface CapabilityReport {
  /** Reading zip/EPUB/cbz (and a mislabelled cbr/cb7 that is really a zip). */
  zip: true;
  /** External `7zzs`: reading rar/7z and mislabelled cbr/cb7. */
  archiveExtras: boolean;
  /** External `mobiunpack`: converting mobi/azw/azw3 to EPUB. */
  kindle: boolean;
}

/** The extensions each capability covers, named in a refusal so the uploader knows what is refused. */
const FORMATS: Record<Capability, string> = {
  "archive-extras": "`.cbr`, `.rar`, `.7z`",
  kindle: "`.mobi`, `.azw`, `.azw3`",
};

const IMAGE = "ghcr.io/hsabort/kavita-companion";

/**
 * The message shown when a format needs a capability this image lacks. It names the exact
 * `-formats` tag for a released build; a development build (`edge`, `sha-`, a locally built
 * `kavita-companion:test`) has no such tag, so it points at the generic `-formats` image instead of
 * inventing one (design §7.5).
 */
export function capabilityMessage(capability: Capability): string {
  const target = /^\d+\.\d+\.\d+$/.test(config.version)
    ? `\`${IMAGE}:${config.version}-formats\``
    : "the `-formats` image for this release";
  return `${FORMATS[capability]} files need the optional formats image, which adds 7-Zip and `
    + `KindleUnpack. Run ${target} instead (see docs/operations.md).`;
}

/** Thrown when an operation needs a capability this image does not have. */
export class CapabilityError extends Error {
  readonly capability: Capability;

  constructor(capability: Capability) {
    super(capabilityMessage(capability));
    this.name = "CapabilityError";
    this.capability = capability;
  }
}

/** Whether an unknown error is a capability refusal, so callers can surface its message verbatim. */
export function isCapabilityError(err: unknown): err is CapabilityError {
  return err instanceof CapabilityError;
}

// The last probe result. Pessimistic until the boot probe finishes, so a missing tool never reads
// as present if something asks before the probe completes.
let snapshot: CapabilityReport = { zip: true, archiveExtras: false, kindle: false };

/**
 * Is `command` runnable? A harmless invocation decides it. Only ENOENT (no such file) means the
 * tool is absent; any other failure still means the binary exists (e.g. `mobiunpack --help` exits
 * non-zero), so it counts as present.
 */
function toolAvailable(command: string, args: string[]): Promise<boolean> {
  return new Promise((resolve) => {
    execFile(command, args, { timeout: 10_000 }, (err) => {
      if (!err) return resolve(true);
      resolve((err as NodeJS.ErrnoException).code !== "ENOENT");
    });
  });
}

/** Probe the optional tools once at boot. The result is cached for `capabilities()`. */
export async function probeCapabilities(): Promise<CapabilityReport> {
  const sevenZip = process.env.SEVEN_ZIP ?? "7zzs";
  const [archiveExtras, kindle] = await Promise.all([
    toolAvailable(sevenZip, ["i"]),
    toolAvailable("mobiunpack", ["--help"]),
  ]);
  snapshot = { zip: true, archiveExtras, kindle };
  return snapshot;
}

/** The cached capability set, as exposed read-only on the health endpoint. */
export function capabilities(): CapabilityReport {
  return snapshot;
}

/** Throw a `CapabilityError` when `capability` is not present in this image. */
export function requireCapability(capability: Capability): void {
  const report = capabilities();
  const present = capability === "archive-extras" ? report.archiveExtras : report.kindle;
  if (!present) throw new CapabilityError(capability);
}
