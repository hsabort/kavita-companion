// Best-effort book identity from a file name, plus the defaults a book review card starts from.
//
// Books are searched by their Title, not their series, so a clean Title matters more than a Series.
// Kavita's own file-name parser is shaped for manga/comics ("Series 001") and mangles book names
// (it reads "Catch-22" as series "Catch", keeps an author prefix, and drops a "#1"), so book
// defaults are built here from the file name plus the file's embedded metadata instead.
import type { Metadata } from "./metadata.js";

export interface NameGuess {
  title?: string;
  series?: string;
  number?: string;
  author?: string;
}

/** The file name without its extension, trimmed. */
const baseOf = (filename: string): string => {
  const dot = filename.lastIndexOf(".");
  return (dot > 0 ? filename.slice(0, dot) : filename).trim();
};

/** A leading zero pad goes, a decimal stays: "01" -> "1", "1.5" -> "1.5". */
const normaliseNumber = (value: string): string => {
  const n = Number(value);
  return Number.isFinite(n) ? String(n) : value;
};

/** Strip a trailing "(series #n)" / "[series #n]" marker, keeping its number. */
function stripSeriesMarker(name: string): { name: string; number?: string } {
  const match = /\s*[(\[]([^)\]]*#\s*(\d{1,4}(?:\.\d+)?))\s*[)\]]\s*$/.exec(name);
  if (!match) return { name };
  return { name: name.slice(0, match.index).trim(), number: normaliseNumber(match[2]!) };
}

/**
 * Guess the title / series / number / author from a book file name.
 *
 * The separator is a spaced dash " - ", so a hyphen inside a word ("Catch-22") never splits and a
 * numeric title ("1984") stays a title. Recognises `Series 01 - Title`, `Series #1`, `01 - Title`
 * and `Author - Title`. Best-effort only: the reviewer can edit everything it returns.
 */
export function guessFromFilename(filename: string): NameGuess {
  const marker = stripSeriesMarker(baseOf(filename));
  const base = marker.name;
  if (!base) return { number: marker.number };

  let m = /^(.+?)\s+(\d{1,4}(?:\.\d+)?)\s+-\s+(.+)$/.exec(base);
  if (m) return { series: m[1]!.trim(), number: normaliseNumber(m[2]!), title: m[3]!.trim() };

  m = /^(.+?)\s+#\s*(\d{1,4}(?:\.\d+)?)$/.exec(base);
  if (m) return { series: m[1]!.trim(), number: normaliseNumber(m[2]!) };

  m = /^(\d{1,4}(?:\.\d+)?)\s+-\s+(.+)$/.exec(base);
  if (m) return { number: normaliseNumber(m[1]!), title: m[2]!.trim() };

  m = /^([^\d]+?)\s+-\s+(.+)$/.exec(base);
  if (m) {
    const inner = guessFromFilename(m[2]!.trim());
    return {
      author: m[1]!.trim(),
      title: inner.title ?? (inner.series ? undefined : m[2]!.trim()),
      series: inner.series,
      number: inner.number ?? marker.number,
    };
  }

  return { title: base, number: marker.number };
}

/**
 * The review-card defaults for a book: embedded metadata wins, the file-name guess fills the gaps.
 * `Title` is always non-empty (the search key); `Series`/`Number` stay absent for a standalone book
 * rather than being invented from the file name.
 */
export function bookMediaDefaults(embedded: Metadata, filename: string): Metadata {
  const guess = guessFromFilename(filename);
  const out: Metadata = { ...embedded };
  if (!out.Title?.trim()) out.Title = guess.title?.trim() || baseOf(filename) || "Unsorted";
  if (!out.Series?.trim()) {
    if (guess.series?.trim()) out.Series = guess.series.trim();
    else delete out.Series;
  }
  if (!out.Number?.trim()) {
    if (guess.number?.trim()) out.Number = guess.number.trim();
    else delete out.Number;
  }
  return out;
}

/** The canonical library name for a book: the folder it goes in and the file name without extension. */
export interface CanonicalBookName { series: string; filename: string }

/**
 * The one canonical naming rule for books, so the review card and approval cannot disagree:
 * a series book is `"<Series> #<n> - <Title>"` in a folder named for the series; a standalone is
 * `"<Title>"` in a folder named for the author (else the title). Returned unsanitised — callers run
 * each part through `safeSegment` before touching the filesystem.
 */
export function canonicalBookName(meta: Metadata): CanonicalBookName {
  const title = (meta.Title ?? "").trim();
  const series = (meta.Series ?? "").trim();
  const number = (meta.Number ?? "").trim();
  const author = (meta.Writer ?? "").trim();
  if (series) {
    const suffix = number ? ` #${number}` : "";
    return { series, filename: title ? `${series}${suffix} - ${title}` : `${series}${suffix}` };
  }
  return { series: author || title || "Unsorted", filename: title || "Untitled" };
}
