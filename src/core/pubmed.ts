/**
 * NCBI E-utilities client (esearch → esummary → efetch) and the searchPubMed
 * orchestrator. efetch XML is parsed with fast-xml-parser. An AbstractText is
 * mixed content (text with <i>, <sup>, <sub>, <b> inside), which the parser would
 * split into child properties and lose; it is read as raw inner XML instead and
 * turned into text by xmlToText.
 */

import { XMLParser } from "fast-xml-parser";
import { LRUCache } from "lru-cache";
import type { Cache } from "./cache.js";
import { LRUBackend } from "./cache.js";
import { errors } from "./errors.js";
import { firstPublished, pageWindow } from "./adapters/util.js";
import { requestWithRetries } from "./request.js";
import { xmlToText } from "./text.js";
import { contactEmail, envSetting, PROJECT_TOOL, USER_AGENT } from "./version.js";
import { classifyArticle, designPublicationTypes, excludedPublicationTypes, filteredPageWarning, filterWarnings, noAnimalStudiesWarning } from "./grader.js";
import { CORRECTION_TYPES } from "./types.js";
import type { Correction, CorrectionType, FetchInput, FetchOutput, GradedArticle, Article, SearchInput, SearchOutput, StudyType } from "./types.js";

const EUTILS_BASE = "https://eutils.ncbi.nlm.nih.gov/entrez/eutils";
/** esearch serves only the first 9,999 PMIDs of a PubMed search ("'retstart' cannot be larger than 9998"). */
const ESEARCH_LIMIT = 9_999;
/**
 * The bounds a dateRange with one end open is sent with. esearch applies mindate and maxdate only
 * together: `creatine` counted 73,217 with no date, with mindate=2025 alone and with maxdate=2005
 * alone, but 4,397 for 2025–3000 and 37,610 for 1000–2005 (2026-11-11).
 */
const OPEN_DATE_FROM = "1000";
const OPEN_DATE_TO = "3000";
/** PMIDs a relevance search takes per esearch request, so that its pages are cut from one list (see DEFAULT_SEARCH_TTL_MS). */
const RELEVANCE_BLOCK = 500;
/**
 * Above this esearch count, a search is served with a warning that names the count and how to narrow it (see
 * {@link broadWarning}). It never refuses: a one-word query such as `diabetes` (1,156,395 records, 2026-11-27) is
 * what a caller tries first, and esearch serves its first page like any other. Refusing is the caller's choice, with
 * {@link NcbiConfig.broadThreshold}.
 */
const BROAD_WARNING_THRESHOLD = 10_000;
/**
 * Spacing between requests, as a multiple of 1/limit. NCBI counts requests as they
 * arrive, and arrival times jitter: spaced exactly 1/3 s apart, 2 of 15 serialized
 * requests drew a 429; spaced 400 ms apart, 1 of 15 (2026-10-20). The rest is left
 * to retries (see ./request.ts).
 */
const SPACING_MARGIN = 1.2;
/**
 * How long a search's PMIDs are reused. PubMed's relevance ranking varies between
 * identical requests: five identical searches returned five different top-20 lists
 * (2026-10-20), so within this window the same search returns the same papers.
 */
const DEFAULT_SEARCH_TTL_MS = 60 * 60 * 1000;
/**
 * The fewest PMIDs taken from each of PubMed's two date orders for `sort: "date"` (see
 * {@link NcbiClient.newest}). The pool grows from it by doubling, so a walk through the pages pools
 * again only a few times.
 */
const DATE_POOL_MIN = 100;
/**
 * How many of the newest records a date pool of `pool` PMIDs per order is taken to hold: a quarter of
 * `pool`, half from 800 on. Compared with pools of 4,096 per order, pools of 200, 400, 800, 1,600 and
 * 3,200 held the right records to at least the 81st, 195th, 510th, 1,279th and 1,945th (semaglutide,
 * creatine supplementation, vitamin D supplementation, long covid, intermittent fasting; 2026-10-28).
 */
function finalDepth(pool: number): number {
  return Math.floor(pool / (pool >= 800 ? 2 : 4));
}
/** PMIDs the search lists may hold in all, so that a few long lists don't crowd out the rest. */
const SEARCHES_MAX_PMIDS = 200_000;
/** Publication dates kept for date pools: two full pools of 9,999 PMIDs, five times over. */
const PUBLISHED_MAX = 100_000;
const CAP_WARNING =
  `PubMed serves only the first ${ESEARCH_LIMIT.toLocaleString("en-US")} records of a search: narrow the query ` +
  `(more specific terms, a dateRange or a studyTypes filter) to reach the rest.`;
/** PMIDs per esummary request, so that its GET URL stays short. */
const ESUMMARY_BATCH = 200;
/** How long a date search's summaries wait for the esummary of the PMIDs it returned. */
const POOLED_SUMMARY_TTL_MS = 10 * 60 * 1000;

export interface NcbiConfig {
  /**
   * Contact email — NCBI asks for one on every request. Defaults to $NCBI_EMAIL, then, with the
   * default `tool`, to PROJECT_CONTACT_EMAIL. A blank email sends none.
   */
  email?: string;
  /** API key raises the rate limit from 3 to 10 req/s. Defaults to $NCBI_API_KEY. */
  apiKey?: string;
  /**
   * Identifies the client to NCBI. Defaults to "med-research-mcp"; software built on this client
   * should send its own, with its own `email`.
   */
  tool?: string;
  /**
   * esearch count above which QUERY_TOO_BROAD is thrown. Unset by default: a broad query is served, with a
   * warning, so this only refuses for a caller that sets it (a service that wants no search over its own limit).
   */
  broadThreshold?: number;
  /** Per-request timeout in ms. Default 15000. */
  timeoutMs?: number;
  /** How long an identical search reuses its PMIDs, in ms. Default one hour; 0 disables. */
  searchTtlMs?: number;
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/**
 * Serializes requests and spaces them to respect NCBI's rate limit. A task runs
 * once every earlier one has finished and calls `pace()` before each request it
 * sends, so a task that waits out a 429 or retries a server error holds back the
 * whole queue.
 */
class RateLimiter {
  private lastAt = 0;
  private tail: Promise<unknown> = Promise.resolve();
  private readonly gapMs: number;

  constructor(reqPerSec: number) {
    this.gapMs = (1000 / reqPerSec) * SPACING_MARGIN;
  }

  run<T>(task: (pace: () => Promise<void>) => Promise<T>): Promise<T> {
    const pace = async (): Promise<void> => {
      const wait = this.lastAt + this.gapMs - Date.now();
      if (wait > 0) await sleep(wait);
      this.lastAt = Date.now();
    };
    const result = this.tail.then(() => task(pace));
    // Keep the queue flowing whether or not this request succeeded.
    this.tail = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }
}

interface EsummaryDoc {
  uid?: string;
  title?: string;
  fulljournalname?: string;
  source?: string;
  pubdate?: string;
  /** "2018 Sep 20", or "" when there is none. */
  epubdate?: string;
  sortpubdate?: string;
  authors?: { name?: string }[];
  articleids?: { idtype?: string; value?: string }[];
  pubtype?: string[];
  /** The record's CommentsCorrections links (see {@link ESUMMARY_REFTYPES}). */
  references?: { reftype?: string; pmid?: number | string }[];
  /** Present on NCBI's ERROR-DOC shape for uids it doesn't recognize, e.g. a nonexistent PMID. */
  error?: string;
}

/**
 * esummary's `reftype` (lower case) of the links efetch calls RefType and {@link extractCorrections} keeps, as the
 * RefType names. Checked live 2026-11-16: esummary of PMID 33247380 has `references: [{refsource: "Biol Trace Elem Res.
 * 2025 Jan;203(1):589. doi: 10.1007/s12011-024-04150-3.", reftype: "Retraction in", pmid: 38512453, note: ""}]` next to
 * its "Retracted Publication" type; that of PMID 27578231 has no such type and `reftype: "Expression of concern in"`
 * with `pmid: 42781840`. In esummary of up to 300 records each of PubMed's `hasretractionin`, `haserratumin`,
 * `hasupdatein`, `hasupdateof` and `hasexpressionofconcernin` (100 each from three places of the pub_date order), the
 * five names below came as "Retraction in", "Erratum in", "Update in", "Update of" and "Expression of concern in",
 * and `pmid` was a number, or "" for a link to a record PubMed doesn't hold (3 of 334 "Erratum in" links, 37 of 344
 * "Retraction in", 17 of 318 "Update of", none of 303 "Update in" and 205 "Expression of concern in"). The other
 * links seen ("Comment in", "Comment on", "Erratum for", "Retraction of", "Republished in" and "from", "Original
 * report in", "Summary for patients in", "Dataset described in", "Dataset use reported in") are not kept, as in efetch.
 */
const ESUMMARY_REFTYPES: Readonly<Record<string, CorrectionType>> = {
  "retraction in": "RetractionIn",
  "expression of concern in": "ExpressionOfConcernIn",
  "erratum in": "ErratumIn",
  "update in": "UpdateIn",
  "update of": "UpdateOf",
};

/** The correction links of an esummary record, in its order, as the efetch path gives them: `id` only for a link to a PMID. */
function esummaryCorrections(references: EsummaryDoc["references"]): Correction[] {
  const out: Correction[] = [];
  for (const ref of toArray(references)) {
    const type = ESUMMARY_REFTYPES[String(ref?.reftype ?? "").trim().toLowerCase()];
    if (!type) continue;
    const id = String(ref?.pmid ?? "").trim();
    out.push({ type, ...(/^\d+$/.test(id) ? { id } : {}) });
  }
  return out;
}

/** What efetch adds to an esummary record. */
interface EfetchData {
  abstract?: string;
  publicationTypes: string[];
  meshHeadings: string[];
  corrections: Correction[];
}

function toArray<T>(value: T | T[] | undefined | null): T[] {
  if (value == null) return [];
  return Array.isArray(value) ? value : [value];
}

/**
 * A search's PMIDs in order, which later pages extend. Pages up to `depth` are cut from it: for a date
 * search the first `depth` PMIDs are final; for a relevance one, `depth` is how far into PubMed's
 * order the list reaches, and `pmids` may be shorter, as it drops repeats.
 */
interface PmidList {
  count: number;
  pmids: string[];
  depth: number;
  /** Words PubMed found in no record, when there are any (see {@link UnknownTerms}). */
  unknown?: UnknownTerms;
}

/**
 * Terms esearch reports as found in no PubMed record (a quoted phrase: as no phrase), in two lists. Checked 2026-11-16 on 34
 * queries for the first and 25 for the second.
 *
 * `errorlist.phrasesnotfound` names a word as written, without quotes. None of ten real queries (BRCA1, COVID-19, 5-HT,
 * vitamin D3, hs-CRP, ...) had a false report. In a query of plain words esearch drops such a word and searches the rest
 * (`sleep apnea qzxvbnmk` found 71,644 records, as `sleep apnea` does, and its `querytranslation` leaves the word out),
 * so the word is `ignored`; in a field-tagged term (`fooxx[tiab]`), an `AND` operand, or a query of unknown words only
 * (`qzxvbnmk wrtyplkj`), the term stays in the query (`querytranslation` has it) and the search finds nothing: it is
 * `blocking`. A misspelling that some record contains is not reported (`tirzepatid obesity` found 4 records).
 *
 * `warninglist.quotedphrasesnotfound` names a quoted term with its quotes, and with its field tag when it has one
 * (`"qzxvbnmk"[tiab]`); `errorlist` is absent when only a quoted term is unknown. The list's neighbour `phrasesignored`
 * was empty in all 25 queries, and `outputmessages` held only "No items found." for a count of 0. None of ten real
 * quoted queries (`"sleep apnea"` 66,630 records, `"BRCA1"`, `"COVID-19"`, `"vitamin D3"`, `"hs-CRP"`, `"sleep apnea"[tiab]`,
 * `"Kreider R"[au]`, `"N Engl J Med"[ta] AND 2021[dp]`, `"Sleep Apnea Syndromes"[mh]`, `"intranasal corticosteroid*"[tiab]`)
 * had a warninglist or an errorlist. Two cases:
 * a quoted word or phrase that no record contains stays in the query and the search finds nothing, so it is `blocking`
 * (`"qzxvbnmk"`, `sleep apnea "qzxvbnmk"`, `"qzxvbnmk" "wrtyplkj"`, `"qzxvbnmk wrtyplkj"` and `"apnea tirzepatide sleep"[tiab]`
 * found 0 records, each with the term in its `querytranslation`; `sleep apnea NOT "qzxvbnmk"` found 71,648, the term
 * kept as a NOT operand, which a missing term doesn't harm). But a quoted phrase of words that all exist, for which PubMed
 * finds no phrase, is reported too, and esearch searches its words separately, unquoted and ANDed:
 * `"apnea tirzepatide sleep"` and `"sleep tirzepatide apnea"` found 173 records and `"obesity apnea tirzepatide"` 143,
 * each `querytranslation` being the three words with their variants, without the phrase; `"sleep qzxvbnmk"` found 373,649,
 * its translation `sleep` alone, the unknown word dropped as in a plain query. Such a phrase is `asWords`. Nothing was
 * seen of a quoted single word that the translation left out; it would count as `ignored`. A word can be in both lists
 * (`qzxvbnmk "qzxvbnmk"` has `qzxvbnmk` in one and `"qzxvbnmk"` in the other, and found 0): it is named once.
 */
interface UnknownTerms {
  ignored: string[];
  blocking: string[];
  /** Quoted phrases PubMed has no phrase for, searched as their words instead. */
  asWords: string[];
}

/** `"a"`, `"a" and "b"`, `"a", "b" and "c"`. */
function quotedList(terms: string[], joiner = "and"): string {
  const quoted = terms.map((t) => `"${t}"`);
  return quoted.length < 2 ? quoted.join("") : `${quoted.slice(0, -1).join(", ")} ${joiner} ${quoted.at(-1)}`;
}

/** The strings of a list esearch returned, which may be absent, one string or an array. */
function termList(value: unknown): string[] {
  return toArray(value as string[] | undefined).filter((t): t is string => typeof t === "string" && t.trim() !== "");
}

/** A quoted term as `quotedphrasesnotfound` gives it: without its quotes and its field tag (`"qzxvbnmk"[tiab]` is `qzxvbnmk`). */
function unquoted(term: string): string {
  return (/^"(.*)"(?:\[[^\]]*\])?$/s.exec(term.trim())?.[1] ?? term).trim();
}

/**
 * The terms esearch reported as found in no record (`notFound`, from `errorlist.phrasesnotfound`; `quotedNotFound`, from
 * `warninglist.quotedphrasesnotfound`), sorted by `querytranslation` into ignored, blocking and searched as words, each
 * term named once; undefined when there are none.
 */
function unknownTerms(notFound: unknown, quotedNotFound: unknown, translation: string | undefined): UnknownTerms | undefined {
  const terms = termList(notFound);
  const quoted = termList(quotedNotFound).map(unquoted).filter(Boolean);
  // Without the translation we can't tell whether the term was left out, so we say nothing.
  if ((terms.length === 0 && quoted.length === 0) || !translation) return undefined;
  const kept = translation.toLowerCase();
  const unknown: UnknownTerms = { ignored: [], blocking: [], asWords: [] };
  // A term in both lists is named once, as the first list has it.
  const named = new Set<string>();
  const isNew = (term: string): boolean => {
    const key = term.toLowerCase();
    if (named.has(key)) return false;
    named.add(key);
    return true;
  };
  for (const term of terms) if (isNew(term)) (kept.includes(term.toLowerCase()) ? unknown.blocking : unknown.ignored).push(term);
  for (const term of quoted) {
    if (!isNew(term)) continue;
    // A quoted term that stays in the query keeps its quotes in the translation; a phrase searched as words is gone from it.
    if (kept.includes(`"${term.toLowerCase()}"`)) unknown.blocking.push(term);
    else (/\s/.test(term) ? unknown.asWords : unknown.ignored).push(term);
  }
  return unknown;
}

/**
 * What the unknown terms mean for a search, in a sentence: a word PubMed left out, always (the records come from the
 * rest of the query); a phrase it searched as words, always (the records need not hold the words together); a term it
 * kept, only when the search found nothing (otherwise it was a NOT or OR operand, which a missing term doesn't harm).
 */
function unknownWarning(unknown: UnknownTerms | undefined, count: number): string | undefined {
  if (!unknown) return undefined;
  const { ignored, blocking, asWords } = unknown;
  const sentences: string[] = [];
  if (ignored.length > 0) {
    const them = ignored.length > 1 ? "them" : "it";
    sentences.push(`PubMed ignored ${quotedList(ignored)}: no record contains ${them}, so it searched without ${them}.`);
  }
  if (asWords.length > 0) {
    sentences.push(`PubMed has no phrase ${quotedList(asWords, "or")}, so it searched the words separately: a record need not hold them together.`);
  }
  if (blocking.length > 0 && count === 0) sentences.push(`No PubMed record contains ${quotedList(blocking, "or")}.`);
  return sentences.length > 0 ? sentences.join(" ") : undefined;
}

/**
 * `unknown` without the phrases the server added to the query itself (the publication types of a design filter, those it
 * asks for and those it leaves out, `"Human Challenge Trials"[pt]` among them), which the caller never typed and can't
 * act on. A search sends them in an OR, where esearch drops one it has no phrase for and says so in `quotedphrasesnotfound`:
 * the count was the same with and without `"Human Challenge Trials"[pt]` in the clause (11 for `tirzepatide apnea`
 * with minDesignTier 2, 2026-11-27), and `(creatine cognition) NOT ("Human Challenge Trials"[pt:noexp] OR "Case Reports"[pt:noexp])`
 * found the 1,420 records that `NOT "Case Reports"[pt:noexp]` alone does (2026-11-27). Undefined when nothing else is left.
 */
function withoutPhrases(unknown: UnknownTerms | undefined, phrases: readonly string[]): UnknownTerms | undefined {
  if (!unknown || phrases.length === 0) return unknown;
  const own = new Set(phrases.map((p) => p.toLowerCase()));
  const callers = (terms: string[]): string[] => terms.filter((t) => !own.has(t.toLowerCase()));
  const rest: UnknownTerms = { ignored: callers(unknown.ignored), blocking: callers(unknown.blocking), asWords: callers(unknown.asWords) };
  return rest.ignored.length + rest.blocking.length + rest.asWords.length > 0 ? rest : undefined;
}

/** What a search matching `count` records says about it: the count, what PubMed serves of it, and how to narrow. */
function broadWarning(count: number): string {
  return (
    `PubMed matched ${count.toLocaleString("en-US")} records, so the query is broad: it serves only the first ` +
    `${ESEARCH_LIMIT.toLocaleString("en-US")} of them, and the rest can't be reached. Narrow it with [tiab] or [mesh] field tags, ` +
    `more specific terms or AND clauses, a dateRange or a studyTypes filter.`
  );
}

/**
 * esearch's errors about the term it was sent, not about NCBI (checked live 2026-11-27): "Empty Term in the request" for a
 * term with nothing to search (`()`, `((`, `)(`), and "begin 1, end 0, length 1", which reads as a string-index error, for a
 * lone `"`. Both arrive wrapped in "Search Backend failed: … Status: 500 … Search is temporarily unavailable. Please try
 * again later. Details: …", which says nothing of the cause: an outage can read the same. So only the cause that follows is
 * told apart, and any other error stays the outage it reads as. The second is matched by its wording alone: no other term
 * gave it.
 */
const TERM_ERROR = /\bempty term\b|\bbegin \d+, end \d+, length \d+\b/i;

export class NcbiClient {
  private readonly email: string | undefined;
  private readonly apiKey: string | undefined;
  /** The `tool` name sent to NCBI; fetchFulltext gives it to its default UnpaywallClient. */
  readonly tool: string;
  private readonly broadThreshold: number | undefined;
  private readonly timeoutMs: number;
  private readonly limiter: RateLimiter;
  private readonly parser: XMLParser;
  private readonly searches: LRUCache<string, PmidList> | null;
  /** The list extensions under way, by search: a call that finds one waits for it instead of extending the same list. */
  private readonly growing = new Map<string, Promise<PmidList>>();
  /** Summaries of the PMIDs a date search returned, fetched to rank them, served once by esummary. */
  private readonly pooled = new LRUCache<string, Article>({ max: 500, ttl: POOLED_SUMMARY_TTL_MS });
  /**
   * {@link firstPublished} of the PMIDs date searches have summarized, kept as they arrive: a deep date
   * page that runs out of time leaves them for the next call, which summarizes only the rest.
   */
  private readonly published: LRUCache<string, number> | null;

  constructor(config: NcbiConfig = {}) {
    this.tool = config.tool ?? PROJECT_TOOL;
    // Only the default tool falls back to the developer contact: NCBI registers tool and email as a pair.
    this.email = contactEmail(config.email, ["NCBI_EMAIL"], this.tool);
    this.apiKey = config.apiKey ?? envSetting("NCBI_API_KEY");
    this.broadThreshold = config.broadThreshold;
    this.timeoutMs = config.timeoutMs ?? 15_000;
    this.limiter = new RateLimiter(this.apiKey ? 10 : 3);
    this.parser = new XMLParser({
      ignoreAttributes: false,
      attributeNamePrefix: "@_",
      textNodeName: "#text",
      trimValues: true,
      // Raw inner XML, entities undecoded: see extractAbstract.
      stopNodes: ["*.AbstractText"],
    });
    const searchTtl = config.searchTtlMs ?? DEFAULT_SEARCH_TTL_MS;
    this.searches =
      searchTtl > 0
        ? new LRUCache({ maxSize: SEARCHES_MAX_PMIDS, sizeCalculation: (list: PmidList) => Math.max(1, list.pmids.length), ttl: searchTtl })
        : null;
    this.published = searchTtl > 0 ? new LRUCache({ max: PUBLISHED_MAX, ttl: searchTtl }) : null;
  }

  private commonParams(params: URLSearchParams): URLSearchParams {
    params.set("tool", this.tool);
    if (this.email) params.set("email", this.email);
    if (this.apiKey) params.set("api_key", this.apiKey);
    return params;
  }

  /** The body of a successful response. */
  private async request(path: string, params: URLSearchParams): Promise<string> {
    const url = `${EUTILS_BASE}/${path}?${this.commonParams(params).toString()}`;
    return this.limiter.run((pace) =>
      requestWithRetries(url, { timeoutMs: this.timeoutMs, source: "PubMed", headers: { "User-Agent": USER_AGENT }, beforeAttempt: pace }),
    );
  }

  /**
   * Returns the PMIDs of the page asked for (`page`, `maxResults`), the total count, and whether
   * a later page can hold records. A studyTypes or minDesignTier filter narrows the query to the
   * publication types it can keep and away from those that give another design (see designPublicationTypes and
   * excludedPublicationTypes), so the count is of candidates for it.
   * With `sort: "date"`, the PMIDs are those first published last, newest first (see
   * {@link newest}). An identical search within `searchTtlMs` returns the same PMIDs, and
   * its later pages are cut from the same list. A search matching more than PubMed's first 9,999
   * records gets a warning from the page that reaches the 9,999th on, and no PMIDs past it. One matching
   * more than {@link BROAD_WARNING_THRESHOLD} gets, on the pages before that, a warning that names its
   * count (see {@link broadWarning}); it is never refused, unless the client has a `broadThreshold`. A word
   * that no record contains gets one on every page (see {@link UnknownTerms}), as esearch leaves such a
   * word out of a plain query without saying so in the records it returns; a phrase of the design filter that
   * esearch has no phrase for, one it asks for or one it leaves out, is not reported, as the caller didn't type it (see
   * {@link withoutPhrases}).
   */
  async esearch(input: SearchInput): Promise<{ count: number; pmids: string[]; more: boolean; warning?: string }> {
    const { offset, size } = pageWindow(input);
    const types = designPublicationTypes(input.studyTypes, input.minDesignTier);
    if (types?.length === 0) return { count: 0, pmids: [], more: false };
    // [pt] includes the narrower types ("Clinical Trial"[pt] finds every RCT), so a type is excluded as a [pt:noexp] tag, which finds
    // just the records that carry it, as the classifier reads them. A tag that no record has is dropped from the NOT without harm.
    const excluded = excludedPublicationTypes(input.studyTypes, input.minDesignTier);
    const term =
      types || excluded.length > 0
        ? `(${input.query})` +
          (types ? ` AND (${types.map((t) => `"${t}"[pt]`).join(" OR ")})` : "") +
          (excluded.length > 0 ? ` NOT (${excluded.map((t) => `"${t}"[pt:noexp]`).join(" OR ")})` : "")
        : input.query;
    const params = new URLSearchParams({ db: "pubmed", term, retmode: "json" });
    if (input.dateRange?.from || input.dateRange?.to) {
      params.set("datetype", "pdat");
      // esearch ignores a mindate or maxdate sent alone, so an open end gets a bound every record is within.
      params.set("mindate", (input.dateRange.from || OPEN_DATE_FROM).replace(/-/g, "/"));
      params.set("maxdate", (input.dateRange.to || OPEN_DATE_TO).replace(/-/g, "/"));
    }
    const byDate = input.sort === "date";
    if (!byDate) params.set("sort", "relevance");

    const key = `${params.toString()}${byDate ? "&order=first-published" : ""}`;
    if (offset >= ESEARCH_LIMIT) {
      const count = this.searches?.get(key)?.count ?? (await this.runEsearch(new URLSearchParams([...params, ["retmax", "0"]]))).count;
      // A search smaller than the limit isn't capped: the page is simply past its end.
      return { count, pmids: [], more: false, ...(count > ESEARCH_LIMIT ? { warning: CAP_WARNING } : {}) };
    }
    const end = Math.min(offset + size, ESEARCH_LIMIT);
    const list = await this.searchList(key, end, (known) => (byDate ? this.newest(params, end, offset, known) : this.relevant(params, end, known)));
    // The page that reaches the 9,999th says the same, and how to narrow, in its own warning.
    const capped = offset + size >= ESEARCH_LIMIT && list.count > ESEARCH_LIMIT;
    // A phrase of the filter's clauses, the types it asks for and the ones it leaves out, counts as the caller's when the query holds it too.
    const own = [...(types ?? []), ...excluded].filter((t) => !input.query.toLowerCase().includes(t.toLowerCase()));
    const warnings = [
      ...(capped ? [CAP_WARNING] : list.count > BROAD_WARNING_THRESHOLD ? [broadWarning(list.count)] : []),
      ...[unknownWarning(withoutPhrases(list.unknown, own), list.count)].filter((w) => w !== undefined),
    ];
    return {
      count: list.count,
      pmids: list.pmids.slice(offset, end),
      more: list.count > end && end < ESEARCH_LIMIT,
      ...(warnings.length > 0 ? { warning: warnings.join(" ") } : {}),
    };
  }

  /**
   * The search's list, extended by `grow` while it doesn't reach `end`. One extension runs at a time
   * per search: a concurrent call waits for it, then extends only if the list is still short.
   */
  private async searchList(key: string, end: number, grow: (known?: PmidList) => Promise<PmidList>): Promise<PmidList> {
    const searches = this.searches;
    if (!searches) return grow();
    for (;;) {
      const known = searches.get(key);
      if (known && known.depth >= Math.min(end, known.count)) return known;
      const running = this.growing.get(key);
      if (!running) {
        const growth = grow(known)
          .then((list) => {
            searches.set(key, list);
            return list;
          })
          .finally(() => this.growing.delete(key));
        this.growing.set(key, growth);
        return growth;
      }
      await running.catch(() => undefined);
    }
  }

  /**
   * Relevance order up to `end`, rounded up to a whole block, extending `known`. PubMed's relevance
   * order differs between identical requests, so pages cut from separate requests would repeat and
   * skip records; a block extending a list keeps each PMID where it first appeared.
   */
  private async relevant(params: URLSearchParams, end: number, known?: PmidList): Promise<PmidList> {
    const from = known?.depth ?? 0;
    const to = Math.min(ESEARCH_LIMIT, Math.ceil(end / RELEVANCE_BLOCK) * RELEVANCE_BLOCK);
    const block = new URLSearchParams(params);
    if (from > 0) block.set("retstart", String(from));
    block.set("retmax", String(to - from));
    const { count, pmids, unknown } = await this.runEsearch(block);
    const have = known?.pmids ?? [];
    const seen = new Set(have);
    const found = known?.unknown ?? unknown;
    return {
      count,
      pmids: [...have, ...pmids.filter((pmid) => !seen.has(pmid))],
      depth: Math.min(count, to),
      ...(found ? { unknown: found } : {}),
    };
  }

  /**
   * PMIDs first published last ({@link firstPublished}), newest first. No esearch order is that one.
   * `sort=pub_date` orders by issue date: for "semaglutide" it led with issues of December 2026
   * published online in August to October, and records published online on 2026-10-20 weren't in its
   * first 12 (2026-10-22). Without a sort, esearch orders by date added to PubMed ("The default sort
   * order varies by database (for PubMed, it is most+recent)", NLM Data Guide,
   * https://dataguide.nlm.nih.gov/eutilities/utilities.html, checked 2026-10-22), which misses
   * records added long before their issue. So PMIDs of each order are pooled, enough for {@link finalDepth}
   * to reach `end` (100 at least), and sorted by first publication from esummary's dates. Checked against every record with a
   * publication date since 2026-10-01, the first 100 of each order held all 10 newest records for each
   * of five queries (semaglutide, creatine supplementation, vitamin D supplementation, intermittent
   * fasting, long covid), and the first 200 all 50 newest for the two queries with 50 in that range;
   * the first 10 of pub_date alone held 1 to 3 of the 10 newest (2026-10-22).
   */
  private async newest(params: URLSearchParams, end: number, offset: number, known?: PmidList): Promise<PmidList> {
    if (known && offset >= known.count) return known;
    let pool = DATE_POOL_MIN;
    while (finalDepth(pool) < end) pool *= 2;
    pool = Math.min(ESEARCH_LIMIT, pool);
    const byIssue = new URLSearchParams(params);
    byIssue.set("retmax", String(pool));
    byIssue.set("sort", "pub_date");
    const byAdded = new URLSearchParams(params);
    byAdded.set("retmax", String(pool));
    const [issued, added] = await Promise.all([this.runEsearch(byIssue), this.runEsearch(byAdded)]);
    // A page past the end needs no ranking: summarizing the pool would only spend the call's time.
    if (offset >= issued.count) return known ?? { count: issued.count, pmids: [], depth: 0 };
    const candidates = [...new Set([...issued.pmids, ...added.pmids])];
    const published = new Map<string, number>();
    const summaries = new Map<string, Article>();
    const unknown: string[] = [];
    for (const pmid of candidates) {
      const date = this.published?.get(pmid);
      if (date === undefined) unknown.push(pmid);
      else published.set(pmid, date);
    }
    for (let i = 0; i < unknown.length; i += ESUMMARY_BATCH) {
      for (const [pmid, article] of await this.esummary(unknown.slice(i, i + ESUMMARY_BATCH))) {
        const date = firstPublished(article);
        summaries.set(pmid, article);
        published.set(pmid, date);
        this.published?.set(pmid, date);
      }
    }
    // Stable: equal dates keep the issue order, then the date-added one.
    candidates.sort((a, b) => (published.get(b) ?? -1) - (published.get(a) ?? -1));
    // The PMIDs already final stay where earlier pages saw them, so a larger pool can't repeat one on a later page.
    const kept = known ? known.pmids.slice(0, known.depth) : [];
    const keptSet = new Set(kept);
    const pmids = [...kept, ...candidates.filter((pmid) => !keptSet.has(pmid))];
    for (const pmid of pmids.slice(offset, end)) {
      const summary = summaries.get(pmid);
      if (summary) this.pooled.set(pmid, summary);
    }
    // Every record was pooled, or as many as esearch serves: the whole order is as good as it gets.
    // Otherwise a larger pool could still bring in newer records than all but the first finalDepth of this one.
    const whole = issued.count <= pool || pool === ESEARCH_LIMIT;
    const depth = whole ? pmids.length : Math.max(kept.length, finalDepth(pool));
    const notFound = known?.unknown ?? issued.unknown;
    return { count: issued.count, pmids, depth, ...(notFound ? { unknown: notFound } : {}) };
  }

  private async runEsearch(params: URLSearchParams): Promise<{ count: number; pmids: string[]; unknown?: UnknownTerms }> {
    const body = await this.request("esearch.fcgi", params);
    let data: {
      esearchresult?: {
        count?: string;
        idlist?: string[];
        querytranslation?: string;
        errorlist?: { phrasesnotfound?: unknown };
        warninglist?: { quotedphrasesnotfound?: unknown };
        ERROR?: string;
      };
      ERROR?: string;
    };
    try {
      data = JSON.parse(body) as typeof data;
    } catch (err) {
      throw errors.parseFailure(err instanceof Error ? err.message : "invalid JSON from esearch");
    }
    const errorMessage = data.esearchresult?.ERROR ?? data.ERROR;
    if (errorMessage) {
      if (TERM_ERROR.test(errorMessage)) {
        // The same query fails every time, and PubMed's "temporarily unavailable" is not the cause: say what to change.
        throw errors.invalidInput(
          `PubMed couldn't read the query (it said "${errorMessage.split("Details:").at(-1)?.trim() || errorMessage}"). This is not an outage, ` +
            `and retrying won't help. Send words or a quoted phrase, e.g. "sleep apnea" AND tirzepatide, and check that every ` +
            `quote and parenthesis encloses one.`,
        );
      }
      throw errors.parseFailure(`esearch error: ${errorMessage}`);
    }

    const count = Number(data.esearchresult?.count ?? 0);
    if (this.broadThreshold !== undefined && count > this.broadThreshold) {
      throw errors.queryTooBroad(count);
    }
    const { errorlist, warninglist, querytranslation } = data.esearchresult ?? {};
    const unknown = unknownTerms(errorlist?.phrasesnotfound, warninglist?.quotedphrasesnotfound, querytranslation);
    return { count, pmids: toArray(data.esearchresult?.idlist), ...(unknown ? { unknown } : {}) };
  }

  /** Fetches article metadata (no abstract). Preserves nothing about order. */
  async esummary(pmids: string[]): Promise<Map<string, Article>> {
    const out = new Map<string, Article>();
    // A date search has just fetched the summaries of the PMIDs it returned.
    const missing = pmids.filter((pmid) => {
      const pooled = this.pooled.get(pmid);
      if (!pooled) return true;
      this.pooled.delete(pmid);
      out.set(pmid, pooled);
      return false;
    });
    if (missing.length === 0) return out;

    const params = new URLSearchParams({
      db: "pubmed",
      id: missing.join(","),
      retmode: "json",
    });
    const body = await this.request("esummary.fcgi", params);
    let data: { result?: Record<string, EsummaryDoc | string[]> };
    try {
      data = JSON.parse(body) as typeof data;
    } catch (err) {
      throw errors.parseFailure(err instanceof Error ? err.message : "invalid JSON from esummary");
    }

    const result = data.result;
    if (!result) return out;
    for (const pmid of missing) {
      const doc = result[pmid];
      // NCBI returns an ERROR-DOC object (uid + error, no title) for uids it doesn't
      // recognize — e.g. a nonexistent PMID — rather than omitting the key entirely.
      // Skip it so the pmid stays absent from the returned Map and is reported missing.
      if (!doc || Array.isArray(doc) || doc.error) continue;
      out.set(pmid, this.docToArticle(pmid, doc));
    }
    return out;
  }

  private docToArticle(pmid: string, doc: EsummaryDoc): Article {
    const doi = doc.articleids?.find((a) => a.idtype === "doi")?.value;
    const pmcid = doc.articleids?.find((a) => a.idtype === "pmc")?.value;
    const article: Article = {
      id: pmid,
      title: (doc.title ?? "").replace(/\.$/, ""),
      authors: toArray(doc.authors)
        .map((a) => a.name ?? "")
        .filter(Boolean),
      journal: doc.fulljournalname ?? doc.source ?? "",
      pubDate: doc.pubdate ?? "",
      publicationTypes: toArray(doc.pubtype),
    };
    if (doc.epubdate?.trim()) article.epubDate = doc.epubdate.trim();
    if (doi) article.doi = doi;
    if (pmcid && /^PMC\d+$/i.test(pmcid)) article.pmcid = pmcid.toUpperCase();
    // The links, so that a record known only from esummary shows an expression of concern, and the notice's id, as one from
    // efetch does. efetch's replace them (applyEfetch), and are the ones cached.
    const corrections = esummaryCorrections(doc.references);
    if (corrections.length > 0) article.corrections = corrections;
    return article;
  }

  /** Fetches abstract text, publication types, MeSH headings and correction links via efetch XML. Keyed by PMID. */
  async efetch(pmids: string[]): Promise<Map<string, EfetchData>> {
    const out = new Map<string, EfetchData>();
    if (pmids.length === 0) return out;

    const params = new URLSearchParams({
      db: "pubmed",
      id: pmids.join(","),
      retmode: "xml",
      rettype: "abstract",
    });
    return this.parseEfetch(await this.request("efetch.fcgi", params));
  }

  /** Exposed for testing: parse an efetch XML string. */
  parseEfetch(xml: string): Map<string, EfetchData> {
    const out = new Map<string, EfetchData>();
    let parsed: Record<string, unknown>;
    try {
      parsed = this.parser.parse(xml) as Record<string, unknown>;
    } catch (err) {
      throw errors.parseFailure(err instanceof Error ? err.message : "invalid XML from efetch");
    }

    const set = parsed.PubmedArticleSet as { PubmedArticle?: unknown } | undefined;
    const articles = toArray(set?.PubmedArticle) as Record<string, any>[];
    for (const article of articles) {
      const citation = article?.MedlineCitation;
      if (!citation) continue;
      const pmid = extractPmid(citation.PMID);
      if (!pmid) continue;
      const articleNode = citation.Article ?? {};
      const abstract = extractAbstract(articleNode.Abstract);
      out.set(pmid, {
        ...(abstract !== undefined ? { abstract } : {}),
        publicationTypes: extractPubTypes(articleNode.PublicationTypeList),
        meshHeadings: extractMesh(citation.MeshHeadingList),
        corrections: extractCorrections(citation.CommentsCorrectionsList),
      });
    }
    return out;
  }
}

function extractPmid(node: unknown): string | undefined {
  if (node == null) return undefined;
  if (typeof node === "string" || typeof node === "number") return String(node);
  const text = (node as Record<string, unknown>)["#text"];
  return text != null ? String(text) : undefined;
}

/** Sections as "LABEL: text" lines. Each AbstractText arrives as its raw inner XML (a stop node). */
function extractAbstract(abstractNode: unknown): string | undefined {
  if (!abstractNode || typeof abstractNode !== "object") return undefined;
  const at = (abstractNode as Record<string, unknown>).AbstractText;
  if (at == null) return undefined;
  const parts = toArray(at)
    .map((node) => {
      if (typeof node === "string" || typeof node === "number") return xmlToText(String(node));
      if (!node || typeof node !== "object") return "";
      const rec = node as Record<string, unknown>;
      const label = rec["@_Label"];
      const text = xmlToText(String(rec["#text"] ?? ""));
      return label && text ? `${String(label)}: ${text}` : text;
    })
    .filter(Boolean);
  const joined = parts.join("\n").trim();
  return joined || undefined;
}

/** Text of an element that may carry attributes (`{ "#text": …, "@_UI": … }`) or be a bare value. */
function nodeText(node: unknown): string {
  if (typeof node === "string" || typeof node === "number") return String(node).trim();
  if (!node || typeof node !== "object") return "";
  return String((node as Record<string, unknown>)["#text"] ?? "").trim();
}

function extractPubTypes(ptl: unknown): string[] {
  if (!ptl || typeof ptl !== "object") return [];
  return toArray((ptl as Record<string, unknown>).PublicationType).map(nodeText).filter(Boolean);
}

/** Descriptor names from a MeshHeadingList (qualifiers dropped). */
function extractMesh(mhl: unknown): string[] {
  if (!mhl || typeof mhl !== "object") return [];
  return toArray((mhl as Record<string, unknown>).MeshHeading)
    .map((h) => (h && typeof h === "object" ? nodeText((h as Record<string, unknown>).DescriptorName) : ""))
    .filter(Boolean);
}

const CORRECTION_SET: ReadonlySet<string> = new Set(CORRECTION_TYPES);

/**
 * Retraction, expression-of-concern, erratum and update links from a
 * CommentsCorrectionsList (RefType names per NLM's MEDLINE/PubMed XML element
 * descriptions). UpdateIn and UpdateOf include a preprint's link to its journal article and
 * the article's link back (see grader.ts). Comment and citation links are dropped.
 */
function extractCorrections(ccl: unknown): Correction[] {
  if (!ccl || typeof ccl !== "object") return [];
  const out: Correction[] = [];
  for (const node of toArray((ccl as Record<string, unknown>).CommentsCorrections)) {
    if (!node || typeof node !== "object") continue;
    const rec = node as Record<string, unknown>;
    const type = String(rec["@_RefType"] ?? "");
    if (!CORRECTION_SET.has(type)) continue;
    const id = extractPmid(rec.PMID);
    out.push({ type: type as CorrectionType, ...(id ? { id } : {}) });
  }
  return out;
}

/**
 * Copy efetch's publication types, MeSH and correction links onto a summary.
 * efetch is the only source of MeSH, and its publication types and correction links are
 * at least as fresh as a cached summary's or esummary's (see {@link ESUMMARY_REFTYPES}), so
 * they replace older ones (a later RetractionIn must not be hidden behind an earlier ErratumIn).
 */
function applyEfetch(article: Article, data: EfetchData): void {
  if (data.publicationTypes.length > 0) article.publicationTypes = data.publicationTypes;
  if (data.meshHeadings.length > 0) article.meshHeadings = data.meshHeadings;
  else delete article.meshHeadings;
  if (data.corrections.length > 0) article.corrections = data.corrections;
  else delete article.corrections;
}

/**
 * Search PubMed and return results classified from their NLM metadata. Unlike `searchLiterature`'s, the
 * result names no `databases` and echoes no `filters`: it is always PubMed's.
 *
 * @param cache reused across calls to avoid re-fetching summaries/abstracts.
 * @param client injectable NCBI client; defaults to one configured from env.
 */
export async function searchPubMed(
  input: SearchInput,
  cache: Cache = new LRUBackend(),
  client: NcbiClient = new NcbiClient(),
): Promise<Omit<SearchOutput, "databases">> {
  // As in searchLiterature: what the filter leaves out is said whatever PubMed returns.
  const warnings = filterWarnings(input.studyTypes, input.minDesignTier);
  if (input.page !== undefined && (!Number.isInteger(input.page) || input.page < 1)) {
    throw errors.invalidInput("page must be a whole number, 1 or more.");
  }
  const page = input.page ?? 1;
  const maxResults = pageWindow(input).size;
  if (designPublicationTypes(input.studyTypes, input.minDesignTier)?.length === 0) {
    return { articles: [], total: 0, query: input.query, page, maxResults, warnings };
  }
  const { count, pmids, more, warning } = await client.esearch(input);
  if (warning) warnings.push(warning);
  const nextPage = more ? { nextPage: page + 1 } : {};

  if (pmids.length === 0) {
    if (count === 0) warnings.push("No articles matched this query. Try broader terms or fewer field tags.");
    else if (!warning) warnings.push("No results returned.");
    return { articles: [], total: count, query: input.query, page, maxResults, ...nextPage, warnings };
  }

  // Summaries (metadata) — cache-first; expired entries come back as misses.
  const summaries = new Map<string, Article>();
  const missingSummaries = pmids.filter((pmid) => {
    const cached = cache.getSummary(pmid);
    if (cached) {
      summaries.set(pmid, cached);
      return false;
    }
    return true;
  });
  if (missingSummaries.length > 0) {
    const fetched = await client.esummary(missingSummaries);
    for (const [pmid, article] of fetched) summaries.set(pmid, article);
  }

  // efetch for missing abstracts, and for every freshly fetched summary: only
  // efetch carries MeSH, and its links and publication types are the freshest. A summary is cached
  // only once efetch has succeeded for it; caching it earlier would keep its MeSH headings from
  // being loaded for SUMMARY_TTL_MS after a failed efetch.
  const abstracts = new Map<string, string>();
  const needEfetch: string[] = [];
  for (const pmid of pmids) {
    const cached = cache.getAbstract(pmid);
    if (cached != null) abstracts.set(pmid, cached);
    if (cached == null || missingSummaries.includes(pmid)) needEfetch.push(pmid);
  }
  if (needEfetch.length > 0) {
    try {
      const fetched = await client.efetch(needEfetch);
      for (const [pmid, data] of fetched) {
        if (data.abstract) {
          cache.setAbstract(pmid, data.abstract);
          abstracts.set(pmid, data.abstract);
        }
        const summary = summaries.get(pmid);
        if (!summary) continue;
        applyEfetch(summary, data);
        cache.setSummary(pmid, summary);
      }
    } catch (err) {
      // Abstracts are best-effort: degrade with a warning.
      warnings.push("Some abstracts could not be fetched; those articles lack abstracts and MeSH headings.");
    }
  }

  const minTier = input.minDesignTier ?? 0;
  const typeFilter = input.studyTypes?.length ? new Set<StudyType>(input.studyTypes) : null;

  const articles: GradedArticle[] = [];
  let fetched = 0;
  for (const pmid of pmids) {
    const summary = summaries.get(pmid);
    if (!summary) continue;
    const abstract = abstracts.get(pmid);
    const article: Article = abstract ? { ...summary, abstract } : summary;
    const graded = classifyArticle(article);
    fetched++;
    if ((graded.designTier ?? 0) < minTier) continue;
    if (typeFilter && !typeFilter.has(graded.studyType)) continue;
    articles.push(graded);
  }
  const cut = filteredPageWarning(articles.length, fetched, more);
  if (cut) warnings.push(cut);
  const noAnimals = noAnimalStudiesWarning(input.studyTypes, input.minDesignTier, articles);
  if (noAnimals) warnings.push(noAnimals);

  return {
    articles,
    total: count,
    query: input.query,
    page,
    maxResults,
    ...nextPage,
    ...(warnings.length > 0 ? { warnings } : {}),
  };
}

/**
 * Fetch full metadata + abstracts for one or more PMIDs.
 * Pure data tool — no grading, unlike `fetchLiterature`, which classifies what its adapters fetch with this.
 * The calling agent does its own analysis on the returned NcbiArticle objects.
 */
export async function fetchPubMed(
  input: FetchInput,
  cache: Cache = new LRUBackend(),
  client: NcbiClient = new NcbiClient(),
): Promise<Omit<FetchOutput, "articles"> & { articles: Article[] }> {
  const warnings: string[] = [];
  const allArticles = new Map<string, Article>();
  const missing: string[] = [];

  // Summaries first (cache-aware).
  const needSummary = input.ids.filter((pmid) => {
    const cached = cache.getSummary(pmid);
    if (cached) {
      allArticles.set(pmid, cached);
      return false;
    }
    return true;
  });

  if (needSummary.length > 0) {
    const fetched = await client.esummary(needSummary);
    for (const [pmid, article] of fetched) allArticles.set(pmid, article);
  }

  // Check which PMIDs we couldn't get summaries for.
  for (const pmid of input.ids) {
    if (!allArticles.has(pmid)) missing.push(pmid);
  }

  // Abstracts (best-effort, cache-aware). efetch also runs for every freshly
  // fetched summary: only efetch carries MeSH, and its links and publication types are the freshest.
  // As in searchPubMed, a summary is cached only once efetch has succeeded for it.
  const pmidsWithSummary = [...allArticles.keys()];
  for (const pmid of pmidsWithSummary) {
    const article = allArticles.get(pmid)!;
    const cached = article.abstract ? null : cache.getAbstract(pmid);
    if (cached != null) article.abstract = cached;
  }
  const needEfetch = pmidsWithSummary.filter((pmid) => needSummary.includes(pmid) || cache.getAbstract(pmid) == null);

  if (needEfetch.length > 0) {
    try {
      const fetched = await client.efetch(needEfetch);
      for (const [pmid, data] of fetched) {
        if (data.abstract) cache.setAbstract(pmid, data.abstract);
        const article = allArticles.get(pmid);
        if (!article) continue;
        applyEfetch(article, data);
        if (data.abstract) article.abstract = data.abstract;
        cache.setSummary(pmid, article);
      }
    } catch {
      warnings.push("Some abstracts could not be fetched; those articles lack abstracts and MeSH headings.");
    }
  }

  // Assemble in input order.
  const articles: Article[] = [];
  for (const pmid of input.ids) {
    const article = allArticles.get(pmid);
    if (article) articles.push(article);
  }

  return {
    articles,
    missing,
    ...(warnings.length > 0 ? { warnings } : {}),
  };
}
