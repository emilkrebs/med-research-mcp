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

/** An affiliation marker after a name: "<sup>1,2*</sup>", "^1^", "^1,2*^", "^1" with no closing caret, or "¹". */
const AFFILIATION_MARKER =
  /<sup>[^<]*<\/sup>|\s*\^\d+(?:[,;]\d+)*[*★☆△†‡§#]*\^?|\s*\^[*★☆△†‡§#]+\^?|\s*[⁰¹²³⁴⁵⁶⁷⁸⁹]+(?:[,;][⁰¹²³⁴⁵⁶⁷⁸⁹]+)*[*★☆△†‡§#]*/gi;
/** A corresponding-author symbol on the end of a name once the numbered markers are gone ("KUANG Li★") or before it ("**Yan Xi"). */
const TRAILING_SYMBOL = /\s*[*★☆△†‡§]+(?=\s*(?:[,;]|$))/gu;
const LEADING_SYMBOL = /(?<=^|[,;]\s*)[*★☆△†‡§]+\s*/gu;
/** Letters, spaces and what names carry between them; anything else (digits, ":", "@", "(", a line break) marks text that isn't a plain list of names. */
const NAME_ONLY = /^[\p{L}\p{M}'’.·\- ]+$/u;
/** Words that make a piece an organisation, whose own commas separate its parts: "Children's Hospital, Zhejiang University". */
const ORGANISATION =
  /\b(?:hospital|clinic|university|institute|institution|academy|college|school|department|laboratory|centre|center|society|association|committee|council|commission|federation|consortium|collaboration|group|team|network|section|foundation|organi[sz]ation|union|company|ministry|bureau)\b/i;
/** A lowercase name particle ("van der Berg, Jan"): the surname may be written first, with its given name after a comma. */
const NAME_PARTICLE = /(?:^|\s)(?:van|von|der|den|de|del|della|di|da|dos|du|la|le|ter|bin|ibn|al|el)(?:\s|$)/;
/** An initial: "J", "J." or "J.R."; a piece of nothing else is the given name of a "Smith, J. R.", not a name of its own. */
const INITIAL = /^(?:\p{Lu}\.)+$|^\p{Lu}$/u;

/**
 * Author names of one record, for databases that return a name list as one string.
 * ChinaRxiv does, with affiliation markers in several forms and repeated names (checked
 * 2026-11-16 over 437 search results of both corpora; 63 had a joined list of two names):
 *
 *   ["LI Ge<sup>1</sup>, ZHOU Yu<sup>2*</sup>"]   ["Lin Fang^1^, Ma Lu^2,3*^"]   ["Chen Hu ^1, Xu Zi ^1,2"]
 *   ["Zeng Ke ^1; Wang Yu ^2"]   ["Hui Li, Qing-Wei Li, and Li-Qiang Song"]   ["G. P. Kalina, N. B. Komzolova"]
 *   ["Qi Jing", "Cai Qing", "Qi Jing"]   ["Li, Nan", "Zhang, Xiaoguang"]   []
 *
 * Markers are stripped from every name, exact repeats dropped. A list of one string is
 * split into names only when that can't cut a name in two: at semicolons, which a
 * "Surname, Given" name doesn't contain, or at commas when every piece is a name of two
 * or more words that isn't initials only, carries no lowercase particle and names no
 * organisation. "Li, Nan" or "Smith, J. R." stay one name; a list that is already
 * several elements is never split. Text that isn't a list of names ("Corresponding
 * author: … E-mail: …") is kept as it is.
 */
export function cleanAuthors(value: unknown): string[] {
  const items = strArray(value).map((s) => s.replace(AFFILIATION_MARKER, "").replace(TRAILING_SYMBOL, "").replace(LEADING_SYMBOL, "").trim());
  const names = items.length === 1 ? splitNames(items[0]!) : items;
  return [...new Set(names.filter(Boolean))];
}

/** The names in a string that lists them, or the string itself when it isn't certainly a list. */
function splitNames(s: string): string[] {
  if (s.includes(";")) {
    const pieces = s.split(";").map((p) => p.trim()).filter(Boolean);
    // A piece may be "Surname, Given": the comma stays.
    return pieces.length > 1 && pieces.every((p) => NAME_ONLY.test(p.replace(/,/g, "")) && !ORGANISATION.test(p)) ? pieces : [s];
  }
  if (!s.includes(",")) return [s];
  const pieces = s.split(",").map((p) => p.trim()).filter(Boolean);
  // "A B, C D, and E F": the last piece carries the conjunction.
  if (pieces.length > 1) pieces[pieces.length - 1] = pieces.at(-1)!.replace(/^(?:and|&)\s+/i, "");
  const isName = (p: string): boolean => {
    // A middle dot joins the parts of one written name ("XIEYIRE·Hamulati").
    const words = p.split(/[\s·]+/);
    // A particle after the initials of a "G. C. de Elía" belongs to a name written given-name first.
    const particle = !INITIAL.test(words[0]!) && NAME_PARTICLE.test(p);
    return NAME_ONLY.test(p) && words.length >= 2 && !words.every((w) => INITIAL.test(w)) && !particle && !ORGANISATION.test(p);
  };
  return pieces.length > 1 && pieces.every(isName) ? pieces : [s];
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


