/**
 * Small pure helpers shared by the adapters. Kept dependency-free and exported
 * so parsers can be unit-tested in isolation.
 */

export const MAX_RESULTS_CAP = 50;

/** The most records of one search reachable by paging, per database (PubMed itself serves 9,999). */
export const MAX_PAGED_RECORDS = 10_000;

/** The records a search asks each database for: `size` of them, from position `offset` (0-based). */
export function pageWindow(input: { maxResults?: number; page?: number }): { offset: number; size: number } {
  const size = Math.floor(Math.min(Math.max(input.maxResults ?? 10, 1), MAX_RESULTS_CAP));
  return { offset: (Math.max(input.page ?? 1, 1) - 1) * size, size };
}

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

/**
 * The query without PubMed field tags ("cognition[tiab]" → "cognition"), for databases
 * that would search a tag as a word: Europe PMC finds 16 records for
 * `creatine AND cognition[tiab]` and 7,179 for `creatine AND cognition` (2026-10-20).
 * Bracketed text with digits, such as the radiotracer "[18F]FDG", is kept.
 */
export function withoutPubMedTags(query: string): string {
  return query
    .replace(/\[[A-Za-z][A-Za-z /:-]{0,40}\]/g, "")
    .replace(/\s{2,}/g, " ")
    .trim();
}

/**
 * A date bound as YYYY-MM-DD, for APIs that accept nothing else (ChinaRxiv answers 422):
 * "2020" → 2020-01-01 as a lower bound or 2020-12-31 as an upper one, "2020-05" →
 * 2020-05-01 or 2020-05-31. Undefined for anything that isn't a date.
 */
export function isoDateBound(value: string | undefined, bound: "from" | "to"): string | undefined {
  const m = /^(\d{4})(?:[-/](\d{1,2})(?:[-/](\d{1,2}))?)?$/.exec(value?.trim() ?? "");
  if (!m) return undefined;
  const year = Number(m[1]);
  const month = m[2] ? Number(m[2]) : bound === "from" ? 1 : 12;
  if (month < 1 || month > 12) return undefined;
  const lastDay = new Date(Date.UTC(year, month, 0)).getUTCDate();
  const day = m[3] ? Number(m[3]) : bound === "from" ? 1 : lastDay;
  if (day < 1 || day > lastDay) return undefined;
  return `${m[1]}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

const MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];

/**
 * A publication date as a number that sorts chronologically (YYYYMMDD, 0 for a missing month
 * or day), from the forms the databases report: "2019 Nov-Dec" (the first month counts),
 * "2021 Mar 15", "2021 Spring" (year only), "2024-12-16". Undefined without a year.
 */
export function dateKey(date: string | undefined): number | undefined {
  const m = /^\s*(\d{4})(?:[-/ ]+(\d{1,2}|[a-z]{3})[a-z]*\.?(?:[-/ ]+(\d{1,2})\b)?)?/i.exec(date ?? "");
  if (!m) return undefined;
  const month = !m[2] ? 0 : /^\d+$/.test(m[2]) ? Number(m[2]) : MONTHS.indexOf(m[2].toLowerCase()) + 1;
  if (month < 1 || month > 12) return Number(m[1]) * 10_000;
  const day = m[3] && Number(m[3]) <= 31 ? Number(m[3]) : 0;
  return Number(m[1]) * 10_000 + month * 100 + day;
}

/**
 * When a record was first published, as a {@link dateKey}; -1 without a date. That is the earlier
 * of its issue and electronic publication dates, as PubMed's website sorts by publication date
 * ("Citations with more than one publication date, such as electronic and print, are sorted by their
 * earliest publication date", PubMed Help, checked 2026-10-22) and both PubMed's and Europe PMC's date
 * filters match, unless
 * one date only narrows the other: PMID 42422741, issue "2026" and online "2026 Jun 24", was first
 * published on June 24, as NCBI's own sort date for it says, not at the start of 2026 (2026-10-22).
 */
export function firstPublished(article: { pubDate?: string; epubDate?: string }): number {
  const issue = dateKey(article.pubDate);
  const online = dateKey(article.epubDate);
  if (issue === undefined || online === undefined) return issue ?? online ?? -1;
  if (narrows(online, issue)) return online;
  if (narrows(issue, online)) return issue;
  return Math.min(issue, online);
}

/** Whether a date key falls within the year or month another leaves open: 20260624 within 20260000 or 20260600. */
function narrows(precise: number, vague: number): boolean {
  const span = vague % 10_000 === 0 ? 10_000 : vague % 100 === 0 ? 100 : 0;
  return precise > vague && precise < vague + span;
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


