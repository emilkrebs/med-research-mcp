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

/** A PubMed field tag: "[tiab]", "[Title/Abstract]", "[mh:noexp]", "[tiab:~3]", "[ tiab ]"; group 1 is its name and modifier. */
const PUBMED_TAG = String.raw`\[\s*([A-Za-z][A-Za-z /:-]{0,40}?(?::~\d{1,3})?)\s*\]`;

/**
 * The query without PubMed field tags ("cognition[tiab]" → "cognition"), for databases
 * that would search a tag as a word: Europe PMC finds 16 records for
 * `creatine AND cognition[tiab]` and 7,179 for `creatine AND cognition` (2026-10-20).
 * Bracketed text with digits, such as the radiotracer "[18F]FDG", is kept.
 */
export function withoutPubMedTags(query: string): string {
  return query
    .replace(new RegExp(PUBMED_TAG, "g"), "")
    .replace(/\s{2,}/g, " ")
    .trim();
}

/** What Europe PMC searches for a PubMed tag (long forms and aliases as PubMed's esearch accepts them, 2026-11-16). */
const TAG_NAMES: Record<string, "tiab" | "ti" | "au" | "pt" | "ta" | "la" | "dp" | "pmid"> = {
  tiab: "tiab",
  "title/abstract": "tiab",
  ti: "ti",
  title: "ti",
  au: "au",
  author: "au",
  auth: "au",
  pt: "pt",
  "publication type": "pt",
  ptyp: "pt",
  ta: "ta",
  journal: "ta",
  jour: "ta",
  "journal name": "ta",
  la: "la",
  language: "la",
  lang: "la",
  dp: "dp",
  pdat: "dp",
  "publication date": "dp",
  "date - publication": "dp",
  pmid: "pmid",
  uid: "pmid",
};

/**
 * Publication types PUB_TYPE counts as PubMed's [pt] does. Left out: types PubMed explodes
 * into narrower ones that Europe PMC keeps apart, such as Clinical Trial (4,148 records with
 * creatine in title or abstract in PubMed, 2,370 in Europe PMC) and Controlled Clinical Trial (3,234, 369).
 */
const PUBLICATION_TYPES = new Map(
  [
    "Randomized Controlled Trial",
    "Meta-Analysis",
    "Systematic Review",
    "Review",
    "Case Reports",
    "Observational Study",
    "Comparative Study",
    "Multicenter Study",
    "Practice Guideline",
    "Guideline",
    "Letter",
    "Editorial",
    "Comment",
    "Journal Article",
    "Retracted Publication",
  ].map((t) => [t.toLowerCase(), t]),
);

/**
 * Languages LANG counts as PubMed's [la] does, by name and by the 3-letter code PubMed takes too. Europe PMC
 * keeps one language per record, so a record in English and Spanish is not found by LANG:spa: of the PubMed
 * records for creatine[tiab] AND spa[la] it tags 225 of 253, and 41 of 81 for por. Those languages are left out.
 */
const LANGUAGES = new Map([
  ["english", "eng"],
  ["eng", "eng"],
  ["german", "ger"],
  ["ger", "ger"],
  ["french", "fre"],
  ["fre", "fre"],
  ["chinese", "chi"],
  ["chi", "chi"],
  ["japanese", "jpn"],
  ["jpn", "jpn"],
  ["russian", "rus"],
  ["rus", "rus"],
  ["italian", "ita"],
  ["ita", "ita"],
]);

type QueryToken =
  | { kind: "space" | "open" | "close" | "word"; text: string }
  | { kind: "quoted"; text: string }
  | { kind: "tag"; text: string; name: string };

/** Splits a query into tokens that join back into it. Throws on an unterminated quote or unbalanced parentheses. */
function tokenize(query: string): QueryToken[] {
  const tokens: QueryToken[] = [];
  const tagAt = (i: number): RegExpExecArray | null => {
    const re = new RegExp(PUBMED_TAG, "y");
    re.lastIndex = i;
    return re.exec(query);
  };
  let depth = 0;
  let i = 0;
  while (i < query.length) {
    const c = query[i]!;
    if (/\s/.test(c)) {
      let end = i + 1;
      while (end < query.length && /\s/.test(query[end]!)) end++;
      tokens.push({ kind: "space", text: query.slice(i, end) });
      i = end;
    } else if (c === "(" || c === ")") {
      depth += c === "(" ? 1 : -1;
      if (depth < 0) throw new Error("unbalanced parentheses");
      tokens.push({ kind: c === "(" ? "open" : "close", text: c });
      i++;
    } else if (c === '"') {
      const end = query.indexOf('"', i + 1);
      if (end < 0) throw new Error("unterminated quote");
      tokens.push({ kind: "quoted", text: query.slice(i, end + 1) });
      i = end + 1;
    } else {
      const tag = c === "[" ? tagAt(i) : null;
      if (tag) {
        tokens.push({ kind: "tag", text: tag[0], name: tag[1]!.trim().replace(/\s+/g, " ").toLowerCase() });
        i += tag[0].length;
        continue;
      }
      let end = i + 1;
      while (end < query.length && !/[\s()"]/.test(query[end]!) && !(query[end] === "[" && tagAt(end))) end++;
      tokens.push({ kind: "word", text: query.slice(i, end) });
      i = end;
    }
  }
  if (depth !== 0) throw new Error("unbalanced parentheses");
  return tokens;
}

/** The term a tag applies to: a quoted phrase (its text between the quotes) or the unquoted words before it. */
type FoundOperand = { kind: "quoted"; start: number; text: string } | { kind: "words"; start: number; words: string[] };
/** What a tag applies to, as PubMed reads it. "ambiguous": PubMed's reading depends on more than the query text. */
type TagOperand = { kind: "none" | "ambiguous" } | FoundOperand;

/**
 * The operand of the tag at `index`. PubMed applies a tag to the term before it: a quoted phrase or one
 * word; several unquoted words before a tag are searched as a phrase only if PubMed's phrase index has
 * it ("sleep apnea[tiab]" is the phrase, "creatine cognition[tiab]" is creatine mapped to MeSH and
 * words anywhere, AND "cognition"[Title/Abstract]; esearch, 2026-11-16). A tag after a parenthesised group
 * is ignored when the group has an operator, and a word glued to a quote or a parenthesis is not a term.
 */
function operandOf(tokens: QueryToken[], index: number): TagOperand {
  let k = index - 1;
  while (k >= 0 && tokens[k]!.kind === "space") k--;
  const last = tokens[k];
  if (!last || last.kind === "open" || last.kind === "tag") return { kind: "none" };
  if (last.kind === "close") return { kind: "ambiguous" };
  const glued = (at: number): boolean => {
    const before = tokens[at - 1];
    return before !== undefined && (before.kind === "word" || before.kind === "quoted" || before.kind === "close" || before.kind === "tag");
  };
  if (last.kind === "quoted") return glued(k) ? { kind: "ambiguous" } : { kind: "quoted", start: k, text: last.text.slice(1, -1) };
  const words: string[] = [];
  let start = k;
  while (k >= 0 && tokens[k]!.kind === "word" && !/^(?:AND|OR|NOT)$/.test(tokens[k]!.text)) {
    words.unshift(tokens[k]!.text);
    start = k;
    if (glued(k)) return { kind: "ambiguous" };
    k--;
    while (k >= 0 && tokens[k]!.kind === "space") k--;
  }
  return words.length > 0 ? { kind: "words", start, words } : { kind: "none" };
}

const COMPOUND_WORD = /^[\p{L}\p{N}]+(?:-[\p{L}\p{N}]+)+$/u;
const PLAIN_WORD = /^[\p{L}\p{N}]+$/u;
/** A wildcard term PubMed accepts: at least 4 characters before the first "*". Europe PMC rejects a leading "*" (HTTP 503). */
const WILDCARD_WORD = /^[\p{L}\p{N}]{4,}[\p{L}\p{N}*]*$/u;

/** A phrase safe to quote for Europe PMC: it ignores a "*" in a phrase (`"breast feed*"` finds what `"breast feed"` does). */
function plainPhrase(text: string): string | undefined {
  const t = text.trim().replace(/\s+/g, " ");
  return /[\p{L}\p{N}]/u.test(t) && !/[*?\\]/.test(t) ? t : undefined;
}

/**
 * `FIELD:term` for a quoted phrase or a single word; undefined where PubMed's and Europe PMC's reading of it may differ.
 * With `wildcards`, a word may end in or contain "*" (diabet*[tiab]: 960,599 records in PubMed, 942,328 in Europe PMC with SRC:MED).
 */
function termIn(field: string, operand: FoundOperand, wildcards: boolean): string | undefined {
  if (operand.kind === "quoted") {
    const phrase = plainPhrase(operand.text);
    return phrase && `${field}:"${phrase}"`;
  }
  if (operand.words.length !== 1) return undefined;
  const word = operand.words[0]!;
  // Without quotes Europe PMC reads "il-6" as il AND 6 (232,653 records, against 193,835 for "il-6"; PubMed: 195,634).
  if (COMPOUND_WORD.test(word)) return `${field}:"${word}"`;
  if (word.includes("*")) return wildcards && WILDCARD_WORD.test(word) ? `${field}:${word}` : undefined;
  if (!PLAIN_WORD.test(word)) return undefined;
  return /^(?:and|or|not)$/i.test(word) ? `${field}:"${word}"` : `${field}:${word}`;
}

/** A PubMed [dp] date or range ("2020", "2019:2021", "2024/03") as Europe PMC dates; a day, or anything else, is undefined. */
function publicationDates(text: string): string | undefined {
  const m = /^([12]\d{3})(?:\/(\d{1,2}))?(?::([12]\d{3})(?:\/(\d{1,2}))?)?$/.exec(text);
  if (!m) return undefined;
  const from = isoDateBound(m[2] ? `${m[1]}/${m[2]}` : m[1], "from");
  const to = isoDateBound(m[3] ? (m[4] ? `${m[3]}/${m[4]}` : m[3]) : m[2] ? `${m[1]}/${m[2]}` : m[1], "to");
  if (!from || !to || from > to) return undefined;
  const range = `[${from} TO ${to}]`;
  return `(FIRST_PDATE:${range} OR E_PDATE:${range} OR P_PDATE:${range})`;
}

/** What Europe PMC searches for `name`[operand], or undefined where the two databases may not read it alike. */
function translateTag(name: string, operand: FoundOperand): string | undefined {
  const text = operand.kind === "quoted" ? operand.text : operand.words.join(" ");
  const single = operand.kind === "words" && operand.words.length === 1 ? operand.words[0] : undefined;
  switch (TAG_NAMES[name]) {
    case "tiab":
      return termIn("TITLE_ABS", operand, true);
    case "ti":
      return termIn("TITLE", operand, true);
    case "ta": {
      // The ISSN PubMed takes here is a field of its own in Europe PMC (JOURNAL:0028-0836 finds nothing).
      const journal = operand.kind === "quoted" ? plainPhrase(operand.text) : single;
      return journal !== undefined && /^[\p{L}\p{N}][\p{L}\p{N} .&,:'()-]*$/u.test(journal) && !/^\d{4}-\d{3}[\dxX]$/.test(journal) ? `JOURNAL:"${journal}"` : undefined;
    }
    case "au": {
      // "Kreider R" also finds "Kreider RB" in both; PubMed's quotes switch that off and Europe PMC's don't.
      if (operand.kind !== "words" || operand.words.length > 2) return undefined;
      const [surname, initials] = operand.words;
      if (!/^\p{L}[\p{L}'-]*$/u.test(surname!) || (initials !== undefined && !/^\p{L}{1,2}$/u.test(initials))) return undefined;
      return `AUTH:"${operand.words.join(" ")}"`;
    }
    case "pt": {
      const type = PUBLICATION_TYPES.get(text.trim().replace(/\s+/g, " ").toLowerCase());
      return type && `PUB_TYPE:"${type}"`;
    }
    case "la": {
      const code = operand.kind === "words" && operand.words.length > 1 ? undefined : LANGUAGES.get(text.trim().toLowerCase());
      return code && `LANG:${code}`;
    }
    case "dp":
      return single === undefined ? undefined : publicationDates(single);
    case "pmid":
      return single !== undefined && /^\d{1,10}$/.test(single) ? `(EXT_ID:${single} AND SRC:MED)` : undefined;
    default:
      return undefined;
  }
}

/**
 * A PubMed-style query as Europe PMC should read it. Europe PMC matches bare words against full text, so
 * `tirzepatide apnea` finds 1,560 records and `TITLE_ABS:tirzepatide AND TITLE_ABS:apnea` 142 (2026-11-16);
 * a PubMed tag is therefore turned into the Europe PMC field that holds the same thing, and any
 * tag without one is removed as {@link withoutPubMedTags} does. Europe PMC's own field syntax passes through.
 *
 * Checked 2026-11-16 by comparing PubMed's esearch (counts, record ids and `querytranslation`) with Europe PMC
 * restricted to SRC:MED. Field names are those of Europe PMC's fields web service and Appendix 1 of its Reference Guide
 * (version 1.51, read from dev.europepmc.org; europepmc.org's own help pages answer 403). The guide lists TITLE, ABSTRACT, AUTH,
 * JOURNAL, PUB_TYPE, LANG, KW, EXT_ID and SRC; TITLE_ABS is in the web service's list only. Pairs of counts are PubMed, then Europe PMC.
 * - [tiab] → TITLE_ABS. PubMed Help: [tiab] covers title, abstract, other abstract and author keywords; TITLE_ABS covers title and
 *   abstract. For six queries Europe PMC found 91-95% of PubMed's records and none PubMed lacked (tirzepatide[tiab] AND apnea[tiab]:
 *   144, 132; 82% for the single word cognition). Of 66 records only PubMed found, 57 have a query word only among the author
 *   keywords and 8 have them in title and abstract that Europe PMC's index does not match. Adding KW doubles the count (cognition 150,668, 305,716).
 * - [ti] → TITLE: 38, 37; 286, 281; 10, 10. The few missed are records Europe PMC's index holds without their words.
 * - [au] → AUTH:"Fauci AS" (1,076, 1,075) and AUTH:"Kreider R" (233, 232); both truncate the initials. A surname alone is looser
 *   (kreider 957, 977; fauci 1,430, 1,252, as PubMed also finds "La Fauci D"). A quoted name is left out: PubMed then
 *   does not truncate, "Kreider R" finds 36 records and Europe PMC 232.
 * - [pt] → PUB_TYPE, for the types of {@link PUBLICATION_TYPES} (creatine[tiab] AND: Randomized Controlled Trial 2,872, 2,874;
 *   Review 3,655, 3,480; Case Reports 5,394, 5,281). PubMed Help: a type includes the narrower ones in the MeSH tree.
 * - [ta] → JOURNAL, for a quoted name or one word (AND 2021[dp]: "N Engl J Med" 1,515, 1,515; "Sci Rep" 24,534, 24,534; blood 947, 948).
 *   Unquoted words may not be a journal name PubMed knows, and an ISSN is a field of its own in Europe PMC: left out.
 * - [la] → LANG for the languages of {@link LANGUAGES} (creatine[tiab] AND eng[la]: 50,347, 49,012).
 * - [dp] → FIRST_PDATE, E_PDATE or P_PDATE in the range, for a year, a month or a range of them (creatine[tiab] AND 2024[dp]
 *   2,046, 1,990; 2024/03[dp] 197, 194). PubMed Help: its date filter includes the electronic and the print date; PMID 39680131
 *   (online 2024-12-16, print 2025-07-01) is found by 2024[dp] and by 2025[dp]. FIRST_PDATE alone finds 1,777 of the 2,046 and
 *   135 of the 197. Preprints have FIRST_PDATE only. A day is left out: Europe PMC keeps an issue date to the month (13, 8).
 * - [pmid] and [uid] → EXT_ID with SRC:MED (3, 3 for three PMIDs).
 * Not translated: [mh] (and [mesh], [MeSH Terms]). Europe PMC has no MeSH field; KW holds MeSH headings and author
 * keywords, and PubMed explodes a heading: "Sleep Apnea Syndromes"[mh] finds 50,220 records and KW 17,963 (with
 * tirzepatide[tiab], 54 and 2); only a heading with no narrower ones agrees (33,086, 32,313). Preprints carry no MeSH.
 *
 * What is removed as before, its words left to match anywhere: unquoted words before a tag (PubMed Help: "will attempt to search those terms
 * as a phrase"; `sleep apnea[tiab]` is the phrase "sleep apnea"[Title/Abstract], `creatine cognition[tiab]` is creatine mapped to MeSH
 * and words anywhere, AND "cognition"[Title/Abstract]), a tag after a parenthesised group (PubMed ignores it:
 * `(tirzepatide OR semaglutide)[tiab]` has no [Title/Abstract] in its translation), a quoted phrase with "*" (Europe PMC ignores
 * the "*": 1,048 records for TITLE_ABS:"breast feed*", PubMed's 15,911), a wildcard of fewer than 4 characters, a modifier
 * ([tiab:~3], [pt:noexp]) and a tag on a term this can't read with certainty. A query that can't be parsed (an unterminated
 * quote, unbalanced parentheses) is returned without its tags.
 */
export function toEuropePmcQuery(query: string): string {
  try {
    const tokens = tokenize(query);
    const replaced = new Map<number, { to: number; text: string }>();
    tokens.forEach((token, i) => {
      if (token.kind !== "tag") return;
      const operand = operandOf(tokens, i);
      if (operand.kind !== "quoted" && operand.kind !== "words") return;
      // A word, quote or parenthesis glued to the tag ("a[tiab]b") would join the field's value or the term after it.
      const next = tokens[i + 1]?.kind;
      if (next === "word" || next === "quoted" || next === "open") return;
      const text = translateTag(token.name, operand);
      if (text !== undefined) replaced.set(operand.start, { to: i, text });
    });
    let out = "";
    for (let i = 0; i < tokens.length; i++) {
      const hit = replaced.get(i);
      if (hit) {
        out += hit.text;
        i = hit.to;
      } else if (tokens[i]!.kind !== "tag") {
        out += tokens[i]!.text;
      }
    }
    return out.replace(/\s{2,}/g, " ").trim() || query.trim();
  } catch {
    return withoutPubMedTags(query);
  }
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


