// Pure path rules, shared by the review queue and the conformance corpus.
//
// They live apart from review.ts on purpose: review.ts opens the database and registers HTTP routes,
// so importing it just to test a pure function drags the whole server in. Everything here depends on
// nothing but its arguments, so `tests/conformance/` can run the rule spec's cases against it
// directly. Nothing here is browser-safe (safeSegment measures UTF-8 bytes), so it is server-only.
import type { FileKind } from "./inspect.js";

/**
 * One path segment (folder or file name) that is safe on any filesystem: no separators, no control
 * or Windows-reserved characters, no leading dots, not "." or "..". Null if nothing is left.
 *
 * The length cap is **200 UTF-8 bytes**, not 200 code points: a name of 200 accented letters is 400
 * bytes and is truncated. Truncation drops whole code points from the end, so it can never split a
 * character into an invalid byte sequence.
 */
export function safeSegment(input: string): string | null {
  let s = input.normalize("NFC").replace(/[\u0000-\u001f\u007f<>:"/\\|?*]/g, " ");
  // Leading dots/spaces (hidden files, "../.." remnants) and trailing dots/spaces (invalid on Windows).
  s = s.replace(/\s+/g, " ").replace(/^[. ]+/, "").replace(/[. ]+$/, "");
  while (Buffer.byteLength(s) > 200) s = s.slice(0, -1);
  return s && s !== "." && s !== ".." ? s : null;
}

/** Split a file name into its stem and its extension (lower-cased, without the dot). */
export function splitName(filename: string): { base: string; ext: string } {
  const dot = filename.lastIndexOf(".");
  return dot <= 0 ? { base: filename, ext: "" } : { base: filename.slice(0, dot), ext: filename.slice(dot + 1).toLowerCase() };
}

/** What an approved file of this kind is saved as. Comic archives always become CBZ. */
export const targetExtension = (kind: FileKind) => (kind === "comic" ? "cbz" : kind);
