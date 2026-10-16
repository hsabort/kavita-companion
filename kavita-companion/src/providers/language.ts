// Language normalisation shared by the book adapters (Hardcover, Open Library).
//
// Providers give a language in different shapes: a 3-letter MARC/ISO-639-2/3 code ("eng", "/languages/eng"),
// a 2-letter ISO-639-1 code ("en"), or an English name ("English"). We normalise everything to the
// 2-letter ISO-639-1 value our Metadata field (LanguageISO) and the EPUB OPF `dc:language` expect.
// An unknown value is dropped (never guessed) — see merge.ts's LanguageISO validation.

/** MARC / ISO-639-2 / ISO-639-3 -> ISO-639-1, for the codes we are likely to meet in book records. */
const CODE_TO_ISO: Record<string, string> = {
  eng: "en", enm: "en", fre: "fr", fra: "fr", frm: "fr", ger: "de", deu: "de", gmh: "de",
  spa: "es", ita: "it", por: "pt", rus: "ru", jpn: "ja", chi: "zh", zho: "zh", kor: "ko",
  ara: "ar", heb: "he", yid: "yi", dut: "nl", nld: "nl", pol: "pl", swe: "sv", nor: "no",
  dan: "da", fin: "fi", cze: "cs", ces: "cs", slo: "sk", slk: "sk", gre: "el", ell: "el",
  hun: "hu", tur: "tr", ukr: "uk", vie: "vi", rum: "ro", ron: "ro", tha: "th", hin: "hi",
  ben: "bn", tam: "ta", tel: "te", mar: "mr", urd: "ur", ind: "id", may: "ms", msa: "ms",
  per: "fa", fas: "fa", slv: "sl", hrv: "hr", srp: "sr", bul: "bg", cat: "ca", glg: "gl",
  baq: "eu", eus: "eu", ice: "is", isl: "is", wel: "cy", cym: "cy", iri: "ga", gle: "ga",
  gae: "gd", mac: "mk", mkd: "mk", alb: "sq", sqi: "sq", arm: "hy", hye: "hy", geo: "ka",
  kat: "ka", lat: "la", lit: "lt", lav: "lv", est: "et", aze: "az", kaz: "kk", mal: "ml",
  kan: "kn", guj: "gu", pan: "pa", sin: "si", nep: "ne", tgl: "tl", fil: "tl", swa: "sw",
  afr: "af", und: "",
};

/** English language names -> ISO-639-1 (Hardcover sometimes stores a name rather than a code). */
const NAME_TO_ISO: Record<string, string> = {
  english: "en", french: "fr", german: "de", spanish: "es", italian: "it", portuguese: "pt",
  russian: "ru", japanese: "ja", chinese: "zh", korean: "ko", arabic: "ar", hebrew: "he",
  dutch: "nl", polish: "pl", swedish: "sv", norwegian: "no", danish: "da", finnish: "fi",
  czech: "cs", greek: "el", hungarian: "hu", turkish: "tr", ukrainian: "uk", vietnamese: "vi",
  romanian: "ro", thai: "th", hindi: "hi", indonesian: "id", persian: "fa", latin: "la",
};

/**
 * Normalise a provider language value to ISO-639-1, or undefined when it cannot be mapped cleanly.
 * Accepts a bare code ("eng", "en"), a path/slug ("/languages/eng"), or an English name ("English").
 */
export function isoLanguage(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const raw = value.trim().toLowerCase();
  if (!raw) return undefined;
  if (/^[a-z]{2}(-[a-z]{2})?$/.test(raw)) return raw;               // already ISO-639-1
  const code = raw.split(/[\/\s]+/).pop() ?? raw;                  // "/languages/eng" -> "eng"
  const mapped = CODE_TO_ISO[code] ?? NAME_TO_ISO[raw];
  return mapped || undefined;
}
