// Kavita's LibraryType number -> the media class the whole app speaks: manga | book | comic.
//
// This is deliberately its own module. The mapping used to be written out literally in several
// places — the review queue, the web UI, the provider lookup — and they drifted. Both the server
// (review.ts) and the browser bundle (web/main.js) import this one function. Nothing here touches
// Node built-ins, so it is safe to bundle into the page.
import type { MediaKind } from "./providers/types.js";

/**
 * Anything that is not manga or a book is a comic: comics are LibraryType 5, and an unknown code
 * falls here too. Total by construction — never returns undefined, so a caller can always branch on
 * the result without a fallback of its own.
 */
export function mediaClass(type: number): MediaKind {
  if (type === 0) return "manga";
  if (type === 2 || type === 4) return "book";
  return "comic";
}
