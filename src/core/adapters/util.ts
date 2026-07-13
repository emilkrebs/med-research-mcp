/**
 * Small pure helpers shared by the adapters. Kept dependency-free and exported
 * so parsers can be unit-tested in isolation.
 */

/** First element of an array (as a trimmed string), or the value itself, or undefined. */
export function first(value: unknown): string | undefined {
  const v = Array.isArray(value) ? value[0] : value;
  if (v == null) return undefined;
  const s = String(v).trim();
  return s.length > 0 ? s : undefined;
}

/** Coerce a value (scalar or array) into a clean string array. */
export function strArray(value: unknown): string[] {
  if (value == null) return [];
  return (Array.isArray(value) ? value : [value])
    .map((x) => (x == null ? "" : String(x).trim()))
    .filter((s) => s.length > 0);
}

/** Split a comma/semicolon-separated author string ("Smith J, Doe A") into names. */
export function splitAuthors(value: unknown): string[] {
  const s = first(value);
  if (!s) return [];
  return s
    .split(/[;,]/)
    .map((a) => a.trim())
    .filter(Boolean);
}

/**
 * Normalize a DOI to its bare form ("10.xxxx/…"), stripping `https://doi.org/`
 * and `doi:` prefixes. Case is preserved (some publisher servers are picky, and
 * doi.org itself is case-insensitive). Returns undefined for non-DOIs. Use
 * {@link doiKey} for the case-insensitive dedup key.
 */
export function cleanDoi(doi: string | undefined): string | undefined {
  if (!doi) return undefined;
  const d = doi
    .trim()
    .replace(/^https?:\/\/(dx\.)?doi\.org\//i, "")
    .replace(/^doi:\s*/i, "")
    .trim();
  return /^10\.\d{4,9}\/\S+$/.test(d) ? d : undefined;
}

/** Case-insensitive DOI key for de-duplication. Returns undefined for non-DOIs. */
export function doiKey(doi: string | undefined): string | undefined {
  return cleanDoi(doi)?.toLowerCase();
}

const ISO_639_2_TO_1: Record<string, string> = {
  eng: "en",
  spa: "es",
  por: "pt",
  rus: "ru",
  zho: "zh",
  chi: "zh",
  jpn: "ja",
  fre: "fr",
  fra: "fr",
  ger: "de",
  deu: "de",
  ita: "it",
  kor: "ko",
};

/** Map a 3-letter ISO 639-2 code to 2-letter 639-1 when possible; pass 2-letter through. */
export function toIso1(lang: string | undefined): string | undefined {
  if (!lang) return undefined;
  const l = lang.trim().toLowerCase();
  if (l.length === 2) return l;
  return ISO_639_2_TO_1[l] ?? l;
}

/** Strip HTML tags and collapse whitespace — for scraped text. */
export function stripHtml(html: string): string {
  return html
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#(\d+);/g, (_, d: string) => String.fromCharCode(Number(d)))
    .replace(/\s+/g, " ")
    .trim();
}
