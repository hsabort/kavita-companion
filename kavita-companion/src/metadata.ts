// Embedded metadata: ComicInfo.xml (comic archives) and the OPF package document (EPUB).
// Edits only touch the fields given; everything else in the file (unknown elements, page lists,
// attributes, namespaces) is preserved. Both formats are exposed with the same field names
// (ComicInfo's) so the review screen can treat them alike.
import { XMLBuilder, XMLParser } from "fast-xml-parser";

/** Editable fields, in the order the ComicInfo v2 schema lists them. */
export const COMICINFO_FIELDS = [
  "Title", "Series", "Number", "Count", "Volume", "Summary", "Year", "Month", "Day",
  "Writer", "Penciller", "Inker", "Colorist", "Letterer", "CoverArtist", "Editor",
  "Publisher", "Imprint", "Genre", "Tags", "Web", "PageCount", "LanguageISO", "AgeRating",
] as const;
export type MetadataField = (typeof COMICINFO_FIELDS)[number];
export type Metadata = Partial<Record<MetadataField, string>>;

/** ComicInfo AgeRating values Kavita understands. */
export const AGE_RATINGS = [
  "Unknown", "Rating Pending", "Early Childhood", "Everyone", "G", "Everyone 10+", "PG", "Kids to Adults",
  "Teen", "MA15+", "Mature 17+", "M", "R18+", "Adults Only 18+", "X18+",
];

const MAX_XML_BYTES = 2 * 1024 * 1024;
type Node = Record<string, unknown> & { ":@"?: Record<string, string> };

const parser = new XMLParser({
  preserveOrder: true,
  ignoreAttributes: false,
  attributeNamePrefix: "@_",
  parseTagValue: false, // keep "026" as "026", not 26
  processEntities: true,
});
const builder = new XMLBuilder({
  preserveOrder: true,
  ignoreAttributes: false,
  attributeNamePrefix: "@_",
  format: true,
  indentBy: "  ",
  suppressEmptyNode: true,
});

function parse(xml: string): Node[] {
  if (Buffer.byteLength(xml) > MAX_XML_BYTES) throw new Error("Metadata file is too large.");
  return parser.parse(xml) as Node[];
}

const tagOf = (node: Node) => Object.keys(node).find((k) => k !== ":@") ?? "";
const childrenOf = (node: Node) => (node[tagOf(node)] as Node[]) ?? [];
const textOf = (node: Node) =>
  childrenOf(node).map((c) => (typeof c["#text"] === "string" || typeof c["#text"] === "number" ? String(c["#text"]) : "")).join("").trim();
const element = (tag: string, text: string, attrs?: Record<string, string>): Node => {
  const node: Node = { [tag]: [{ "#text": text }] };
  if (attrs) node[":@"] = attrs;
  return node;
};

// ---------- ComicInfo.xml ----------

export function readComicInfo(xml: string): Metadata {
  const root = parse(xml).find((n) => tagOf(n) === "ComicInfo");
  const out: Metadata = {};
  for (const child of root ? childrenOf(root) : []) {
    const tag = tagOf(child) as MetadataField;
    if ((COMICINFO_FIELDS as readonly string[]).includes(tag)) {
      const value = textOf(child);
      if (value) out[tag] = value;
    }
  }
  return out;
}

/** Apply non-empty `updates` to an existing ComicInfo.xml (or a new one), keeping everything else.
 *  Fields named in `drop` are removed even when the file already carries them. */
export function writeComicInfo(existingXml: string | null, updates: Metadata, drop: readonly string[] = []): string {
  const doc: Node[] = existingXml ? parse(existingXml) : [];
  let root = doc.find((n) => tagOf(n) === "ComicInfo");
  if (!root) {
    root = {
      ComicInfo: [],
      ":@": { "@_xmlns:xsd": "http://www.w3.org/2001/XMLSchema", "@_xmlns:xsi": "http://www.w3.org/2001/XMLSchema-instance" },
    };
    doc.push(root);
  }
  const kids = childrenOf(root);
  const order = (tag: string) => (COMICINFO_FIELDS as readonly string[]).indexOf(tag);
  for (const field of COMICINFO_FIELDS) {
    if (drop.includes(field)) {
      const i = kids.findIndex((k) => tagOf(k) === field);
      if (i !== -1) kids.splice(i, 1);
      continue;
    }
    const value = updates[field]?.trim();
    if (!value) continue;
    const existing = kids.find((k) => tagOf(k) === field);
    if (existing) {
      existing[field] = [{ "#text": value }];
      continue;
    }
    // Insert after the last known field that comes earlier in the schema.
    let at = 0;
    kids.forEach((k, i) => {
      const o = order(tagOf(k));
      if (o !== -1 && o < order(field)) at = i + 1;
    });
    kids.splice(at, 0, element(field, value));
  }
  root[tagOf(root)] = kids;
  const body = builder.build(doc.filter((n) => tagOf(n) !== "?xml")) as string;
  return `<?xml version="1.0" encoding="utf-8"?>\n${body.trim()}\n`;
}

// ---------- EPUB (OPF) ----------

/** Path of the OPF package document, from META-INF/container.xml. */
export function opfPathFromContainer(containerXml: string): string | null {
  const match = /<rootfile\b[^>]*\bfull-path\s*=\s*"([^"]+)"/i.exec(containerXml);
  return match?.[1] ?? null;
}

function opfMetadataNode(doc: Node[]): Node | null {
  const pkg = doc.find((n) => /(^|:)package$/.test(tagOf(n)));
  return (pkg && childrenOf(pkg).find((n) => /(^|:)metadata$/.test(tagOf(n)))) ?? null;
}

const isDc = (node: Node, name: string) => tagOf(node) === `dc:${name}`;
const isCalibre = (node: Node, name: string) =>
  /(^|:)meta$/.test(tagOf(node)) && node[":@"]?.["@_name"] === `calibre:${name}`;

export function readEpubMetadata(opfXml: string): Metadata {
  const meta = opfMetadataNode(parse(opfXml));
  if (!meta) return {};
  const kids = childrenOf(meta);
  const dc = (name: string) => kids.filter((k) => isDc(k, name)).map(textOf).filter(Boolean);
  const calibre = (name: string) => kids.find((k) => isCalibre(k, name))?.[":@"]?.["@_content"];
  const out: Metadata = {
    Title: dc("title")[0],
    Writer: dc("creator").join(", ") || undefined,
    Publisher: dc("publisher")[0],
    Summary: dc("description")[0],
    LanguageISO: dc("language")[0],
    Genre: dc("subject").join(", ") || undefined,
    Year: dc("date")[0]?.slice(0, 4),
    Series: calibre("series"),
    Number: calibre("series_index"),
  };
  return Object.fromEntries(Object.entries(out).filter(([, v]) => v)) as Metadata;
}

/** Apply non-empty `updates` to an OPF document. Series uses calibre:series, which Kavita reads. */
export function writeEpubMetadata(opfXml: string, updates: Metadata): string {
  const doc = parse(opfXml);
  const meta = opfMetadataNode(doc);
  if (!meta) throw new Error("This EPUB has no metadata section to update.");
  let kids = childrenOf(meta);
  const set = (value: string | undefined, apply: () => void) => {
    if (value?.trim()) apply();
  };
  const setDc = (name: string, value: string) => {
    const existing = kids.find((k) => isDc(k, name));
    if (existing) existing[`dc:${name}`] = [{ "#text": value }];
    else kids.push(element(`dc:${name}`, value));
  };
  const setList = (name: string, csv: string) => {
    // Replace all existing entries, at the position of the first one (or at the end if none).
    const first = kids.findIndex((k) => isDc(k, name));
    kids = kids.filter((k) => !isDc(k, name));
    const items = csv.split(/[,;]/).map((s) => s.trim()).filter(Boolean).map((v) => element(`dc:${name}`, v));
    kids.splice(first === -1 ? kids.length : first, 0, ...items);
  };
  const setCalibre = (name: string, value: string) => {
    const existing = kids.find((k) => isCalibre(k, name));
    if (existing) existing[":@"] = { ...existing[":@"], "@_content": value };
    else kids.push({ meta: [], ":@": { "@_name": `calibre:${name}`, "@_content": value } });
  };
  set(updates.Title, () => setDc("title", updates.Title!.trim()));
  set(updates.Writer, () => setList("creator", updates.Writer!));
  set(updates.Publisher, () => setDc("publisher", updates.Publisher!.trim()));
  set(updates.Summary, () => setDc("description", updates.Summary!.trim()));
  set(updates.LanguageISO, () => setDc("language", updates.LanguageISO!.trim()));
  set(updates.Genre, () => setList("subject", updates.Genre!));
  set(updates.Year, () => {
    const current = kids.find((k) => isDc(k, "date"));
    // Keep a fuller existing date if its year already matches.
    if (!current || textOf(current).slice(0, 4) !== updates.Year!.trim()) setDc("date", updates.Year!.trim());
  });
  set(updates.Series, () => setCalibre("series", updates.Series!.trim()));
  set(updates.Number, () => setCalibre("series_index", updates.Number!.trim()));
  meta[tagOf(meta)] = kids;
  const body = builder.build(doc.filter((n) => tagOf(n) !== "?xml")) as string;
  return `<?xml version="1.0" encoding="utf-8"?>\n${body.trim()}\n`;
}

/**
 * Kavita's EPUB reader (VersOne) is stricter than ours, and calibre/mobiunpack output trips it twice:
 * a `<guide>` whose `<reference>` items have no `href` ("Incorrect EPUB guide: item href is missing")
 * and a bare `&` in the NCX/OPF XML ("TOC file is not a valid XML file"). Both make the file invisible
 * to Kavita, so an approved EPUB is normalised before it is repacked.
 */
export function escapeBareAmpersands(xml: string): string {
  return xml.replace(/&(?!(?:amp|lt|gt|quot|apos|#\d+|#x[0-9a-fA-F]+);)/g, "&amp;");
}

/** Drop the OPF `<guide>`: Kavita ignores it, and a half-written one makes the whole package unreadable. */
export function sanitizeEpubOpf(opfXml: string): string {
  return escapeBareAmpersands(opfXml).replace(/<guide(?:\s[^>]*)?>[\s\S]*?<\/guide>/g, "<guide/>");
}
