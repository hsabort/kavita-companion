// Tidy a name before it becomes a folder or file in the library.
//
// The library is full of scene/release names: "Night Thieves 026 (2020) (Digital) (Zone-Empire).cbr",
// "Ascendant 159 (2021) (Digital) (LuCaZ).cbz", "(Dungeon Delver 01 - ...". Kavita can find
// most of them, but the names are ugly and a round-trip re-upload is the moment to fix them. This
// module is the one place that decides what a clean name is, so the review card's suggestion and the
// approval plan cannot disagree. Filesystem safety stays `safeSegment()`'s job (it runs last).

/**
 * Words that mark a bracketed group as release noise. Kept short on purpose: the "shouty group" rule
 * below catches scanner groups we have never seen (e.g. `Zone-Empire`, `LuCaZ`, `-KS-`).
 */
const RELEASE_WORDS = new Set([
  "digital", "scan", "scans", "scanned", "scanlation", "cbz", "cbr", "cb7", "zip", "rar", "7z",
  "epub", "mobi", "azw3", "repack", "repacks", "fixed", "complete", "c2c", "noads", "retail",
  "webrip", "web", "hd", "sd", "remastered", "compressed", "uncensored", "decensored", "ongoing",
  "ocr", "empire", "zone", "minutemen",
]);

/** A bare year, a year range, or a release/scanner tag — i.e. a bracketed group worth dropping. */
export function isNoiseGroup(inner: string): boolean {
  const text = inner.trim();
  if (!text) return true; // "()" / "[]"
  if (/^\d{4}\s*[-–]\s*\d{4}$/.test(text)) return true; // (1968-1996)
  if (/^\d{4}$/.test(text)) return true; // (2020)
  const words = text.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
  if (words.length && words.every((word) => RELEASE_WORDS.has(word))) return true; // (Digital) / (Digital-Empire)
  // An unknown scanner group: short, no sentence punctuation, and "shouty" — a digit, a separator,
  // an acronym run or an internal capital. A bracketed subtitle ("The Midnight Pact") never matches.
  return text.length <= 24 && !/[,.!?'’]/.test(text)
    && (/[0-9]/.test(text) || /[0-9_+\-–]/.test(text) || /[A-Z]{2,}/.test(text) || /\p{Lu}\p{Ll}*\p{Lu}/u.test(text));
}

/** Remove the bracket characters that have no partner, keeping what is inside them. */
export function dropOrphanBrackets(input: string): string {
  const pairs: Record<string, string> = { ")": "(", "]": "[" };
  const stack: number[] = [];
  const drop = new Set<number>();
  for (let i = 0; i < input.length; i++) {
    const ch = input[i]!;
    if (ch === "(" || ch === "[") stack.push(i);
    else if (ch === ")" || ch === "]") {
      const want = pairs[ch]!;
      if (stack.length && input[stack[stack.length - 1]!] === want) stack.pop();
      else drop.add(i);
    }
  }
  for (const i of stack) drop.add(i);
  return [...input].filter((_, i) => !drop.has(i)).join("");
}

/**
 * Strip release tags, bare years and orphan brackets from a name segment, then collapse whitespace
 * and trim leading/trailing separators. Safe on an already-clean name (returns it unchanged).
 */
export function cleanName(input: string): string {
  let s = (input ?? "").normalize("NFC");
  // Innermost groups first, so "(Halcyon (1968-1996)" loses "(1968-1996)" and then the orphan "(".
  s = s.replace(/[(\[]([^()\[\]]*)[)\]]/g, (whole, inner: string) => (isNoiseGroup(inner) ? " " : whole));
  s = dropOrphanBrackets(s);
  s = s.replace(/\s+/g, " ").trim();
  s = s.replace(/^[\s._\-–]+/, "").replace(/[\s._\-–]+$/, "");
  return s;
}

/**
 * A book title, with a repeated series prefix and a trailing series blurb removed:
 * "Dungeon Delver: A LitRPG/Gamelit Adventure" -> "A LitRPG/Gamelit Adventure";
 * "The Gate of the Silver Gods: Dungeon Delver Book 4" -> "The Gate of the Silver Gods".
 * A title with no series (or no match) is only `cleanName`-ed, so "Vermilion: Requiem" is left alone.
 */
export function cleanBookTitle(title: string, series = ""): string {
  const cleaned = cleanName(title);
  const name = cleanName(series);
  if (!cleaned || !name) return cleaned;
  const esc = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const out = cleaned
    .replace(new RegExp(`^${esc}\\s*[:\\-–]\\s*`, "i"), "")           // "<Series>: <title>"
    .replace(new RegExp(`\\s*[:\\-–]\\s*[^:]*\\b${esc}\\b[^:]*$`, "i"), "") // ": <… series …>"
    .replace(/\s*[:\-–]\s*(?:book|vol\.?|volume|part|#)\s*\d+\b.*$/i, "")   // ": Book 4" / ": Vol. 2"
    .trim();
  return out || cleaned;
}

/** Does this series already name a volume, e.g. "Ironclad v1" / "Halcyon Vol. 2"? Returns it, or null. */
export function volumeInSeries(series: string): number | null {
  const match = /(?:^|\s)(?:v|vol\.?|volume)\s*0*(\d+)\s*$/i.exec(cleanName(series));
  return match ? Number(match[1]) : null;
}

/**
 * Drop a volume token from a file name when the series already carries it: a reviewer who files
 * "Ironclad v1 01.cbr" under the series "Ironclad v1" would otherwise get "Ironclad v1 v01 #001.cbz".
 * Only the token right after the series prefix is removed, so a "v1" inside the series name survives.
 */
export function dedupeSeriesVolume(name: string, series: string, volume?: string): string {
  const vol = (volume ?? "").trim();
  const s = cleanName(series);
  if (!vol || !s || volumeInSeries(s) !== Number(vol)) return name;
  const esc = s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return name.replace(new RegExp(`^${esc}\\s+v0*${Number(vol)}(?=\\s|$)`, "i"), s);
}
