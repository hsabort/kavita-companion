// Pure text hygiene, kept free of config/database imports so the rule modules that only need string
// handling (`providers/merge.ts`, the conformance corpus) can be loaded on their own. `providers/http.ts`
// re-exports `plainText` so its callers are unaffected.

const ENTITIES: Record<string, string> = {
  "&amp;": "&", "&lt;": "<", "&gt;": ">", "&quot;": '"', "&#39;": "'", "&apos;": "'", "&nbsp;": " ",
};

/** Provider text is untrusted: strip tags, decode a few entities and collapse whitespace. */
export function plainText(value: unknown): string {
  if (typeof value !== "string") return "";
  return value
    .replace(/<[^>]*>/g, " ")
    .replace(/&#(\d+);/g, (_m, n: string) => String.fromCodePoint(Number(n)))
    .replace(/&[a-zA-Z#0-9]+;/g, (m) => ENTITIES[m] ?? " ")
    .replace(/\s+/g, " ")
    .trim();
}
