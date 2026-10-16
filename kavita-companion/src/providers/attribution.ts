// Attribution text for a provider, composed from the adapter's own metadata (label + licence) so a
// licence change reaches the review card and the About page at once and cannot silently drift
// (roadmap phase 2, decision 5 / measure M2).
//
// e.g. Metron -> "Comic data from Metron, CC BY-SA 4.0"
import type { MediaKind, Provider } from "./types.js";

const MEDIA_NOUN: Record<MediaKind, string> = { comic: "Comic", manga: "Manga", book: "Book" };

/** The required credit for a provider, e.g. "Comic data from Metron, CC BY-SA 4.0". */
export function attributionFor(provider: Provider): string {
  const media = provider.capabilities.media[0];
  const noun = media ? MEDIA_NOUN[media] : "Metadata";
  const licence = provider.licence?.name;
  return `${noun} data from ${provider.label}${licence ? `, ${licence}` : ""}`;
}
