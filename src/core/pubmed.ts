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
import { classifyArticle, designPublicationTypes, filterWarnings, noAnimalStudiesWarning } from "./grader.js";
import { CORRECTION_TYPES } from "./types.js";
import type { Correction, CorrectionType, FetchInput, FetchOutput, GradedArticle, Article, SearchInput, SearchOutput, StudyType } from "./types.js";

const EUTILS_BASE = "https://eutils.ncbi.nlm.nih.gov/entrez/eutils";
/** esearch serves only the first 9,999 PMIDs of a PubMed search ("'retstart' cannot be larger than 9998"). */
const ESEARCH_LIMIT = 9_999;
/** PMIDs a relevance search takes per esearch request, so that its pages are cut from one list (see DEFAULT_SEARCH_TTL_MS). */
const RELEVANCE_BLOCK = 500;
/** Above this esearch count, refuse and ask the caller to narrow. */
const DEFAULT_BROAD_THRESHOLD = 100_000;
/** Above this, still run but attach a warning. */
const SOFT_BROAD_THRESHOLD = 10_000;
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
 * The fewest PMIDs taken from each of PubMed's two date orders for `sort: "date"`, and the multiple
 * of the records asked for taken when that is more (see {@link NcbiClient.newest}). The pool grows
 * from the minimum by doubling, so a walk through the pages pools again only a few times.
 */
const DATE_POOL_MIN = 100;
const DATE_POOL_FACTOR = 4;
/** PMIDs the search lists may hold in all, so that a few long lists don't crowd out the rest. */
const SEARCHES_MAX_PMIDS = 200_000;
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
  /** esearch count above which QUERY_TOO_BROAD is thrown. */
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
  /** Present on NCBI's ERROR-DOC shape for uids it doesn't recognize, e.g. a nonexistent PMID. */
  error?: string;
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
  /** A date search's {@link firstPublished} of the PMIDs it has summarized. */
  published?: Map<string, number>;
}

export class NcbiClient {
  private readonly email: string | undefined;
  private readonly apiKey: string | undefined;
  /** The `tool` name sent to NCBI; fetchFulltext gives it to its default UnpaywallClient. */
  readonly tool: string;
  private readonly broadThreshold: number;
  private readonly timeoutMs: number;
  private readonly limiter: RateLimiter;
  private readonly parser: XMLParser;
  private readonly searches: LRUCache<string, PmidList> | null;
  /** The list extensions under way, by search: a call that finds one waits for it instead of extending the same list. */
  private readonly growing = new Map<string, Promise<PmidList>>();
  /** Summaries of the PMIDs a date search returned, fetched to rank them, served once by esummary. */
  private readonly pooled = new LRUCache<string, Article>({ max: 500, ttl: POOLED_SUMMARY_TTL_MS });

  constructor(config: NcbiConfig = {}) {
    this.tool = config.tool ?? PROJECT_TOOL;
    // Only the default tool falls back to the developer contact: NCBI registers tool and email as a pair.
    this.email = contactEmail(config.email, ["NCBI_EMAIL"], this.tool);
    this.apiKey = config.apiKey ?? envSetting("NCBI_API_KEY");
    this.broadThreshold = config.broadThreshold ?? DEFAULT_BROAD_THRESHOLD;
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
   * publication types it can keep (see designPublicationTypes), so the count is of candidates for it.
   * With `sort: "date"`, the PMIDs are those first published last, newest first (see
   * {@link newest}). An identical search within `searchTtlMs` returns the same PMIDs, and
   * its later pages are cut from the same list. A search matching more than PubMed's first 9,999
   * records gets a warning from the page that reaches the 9,999th on, and no PMIDs past it.
   */
  async esearch(input: SearchInput): Promise<{ count: number; pmids: string[]; more: boolean; warning?: string }> {
    const { offset, size } = pageWindow(input);
    const types = designPublicationTypes(input.studyTypes, input.minDesignTier);
    if (types?.length === 0) return { count: 0, pmids: [], more: false };
    const term = types ? `(${input.query}) AND (${types.map((t) => `"${t}"[pt]`).join(" OR ")})` : input.query;
    const params = new URLSearchParams({ db: "pubmed", term, retmode: "json" });
    if (input.dateRange?.from || input.dateRange?.to) {
      params.set("datetype", "pdat");
      if (input.dateRange.from) params.set("mindate", input.dateRange.from.replace(/-/g, "/"));
      if (input.dateRange.to) params.set("maxdate", input.dateRange.to.replace(/-/g, "/"));
    }
    const byDate = input.sort === "date";
    if (!byDate) params.set("sort", "relevance");

    const key = `${params.toString()}${byDate ? "&order=first-published" : ""}`;
    if (offset >= ESEARCH_LIMIT) {
      const count = this.searches?.get(key)?.count ?? (await this.runEsearch(new URLSearchParams([...params, ["retmax", "0"]]))).count;
      return { count, pmids: [], more: false, warning: CAP_WARNING };
    }
    const end = Math.min(offset + size, ESEARCH_LIMIT);
    const list = await this.searchList(key, end, (known) => (byDate ? this.newest(params, end, offset, known) : this.relevant(params, end, known)));
    return {
      count: list.count,
      pmids: list.pmids.slice(offset, end),
      more: list.count > end && end < ESEARCH_LIMIT,
      ...(offset + size >= ESEARCH_LIMIT && list.count > ESEARCH_LIMIT ? { warning: CAP_WARNING } : {}),
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
    const { count, pmids } = await this.runEsearch(block);
    const have = known?.pmids ?? [];
    const seen = new Set(have);
    return { count, pmids: [...have, ...pmids.filter((pmid) => !seen.has(pmid))], depth: Math.min(count, to) };
  }

  /**
   * PMIDs first published last ({@link firstPublished}), newest first. No esearch order is that one.
   * `sort=pub_date` orders by issue date: for "semaglutide" it led with issues of December 2026
   * published online in August to October, and records published online on 2026-10-20 weren't in its
   * first 12 (2026-10-22). Without a sort, esearch orders by date added to PubMed ("The default sort
   * order varies by database (for PubMed, it is most+recent)", NLM Data Guide,
   * https://dataguide.nlm.nih.gov/eutilities/utilities.html, checked 2026-10-22), which misses
   * records added long before their issue. So 4 × `end` PMIDs (100 at least) of each order are pooled
   * and sorted by first publication from esummary's dates. Checked against every record with a
   * publication date since 2026-10-01, the first 100 of each order held all 10 newest records for each
   * of five queries (semaglutide, creatine supplementation, vitamin D supplementation, intermittent
   * fasting, long covid), and the first 200 all 50 newest for the two queries with 50 in that range;
   * the first 10 of pub_date alone held 1 to 3 of the 10 newest (2026-10-22).
   */
  private async newest(params: URLSearchParams, end: number, offset: number, known?: PmidList): Promise<PmidList> {
    let pool = DATE_POOL_MIN;
    while (pool < DATE_POOL_FACTOR * end) pool *= 2;
    pool = Math.min(ESEARCH_LIMIT, pool);
    const byIssue = new URLSearchParams(params);
    byIssue.set("retmax", String(pool));
    byIssue.set("sort", "pub_date");
    const byAdded = new URLSearchParams(params);
    byAdded.set("retmax", String(pool));
    const [issued, added] = await Promise.all([this.runEsearch(byIssue), this.runEsearch(byAdded)]);
    const candidates = [...new Set([...issued.pmids, ...added.pmids])];
    const published = new Map(known?.published);
    const summaries = new Map<string, Article>();
    const unknown = candidates.filter((pmid) => !published.has(pmid));
    for (let i = 0; i < unknown.length; i += ESUMMARY_BATCH) {
      for (const [pmid, article] of await this.esummary(unknown.slice(i, i + ESUMMARY_BATCH))) {
        summaries.set(pmid, article);
        published.set(pmid, firstPublished(article));
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
    // Otherwise a larger pool could still bring in newer records than all but the first quarter of this one.
    const whole = issued.count <= pool || pool === ESEARCH_LIMIT;
    const depth = whole ? pmids.length : Math.max(kept.length, Math.floor(pool / DATE_POOL_FACTOR));
    return { count: issued.count, pmids, depth, published };
  }

  private async runEsearch(params: URLSearchParams): Promise<{ count: number; pmids: string[] }> {
    const body = await this.request("esearch.fcgi", params);
    let data: { esearchresult?: { count?: string; idlist?: string[]; ERROR?: string }; ERROR?: string };
    try {
      data = JSON.parse(body) as typeof data;
    } catch (err) {
      throw errors.parseFailure(err instanceof Error ? err.message : "invalid JSON from esearch");
    }
    const errorMessage = data.esearchresult?.ERROR ?? data.ERROR;
    if (errorMessage) {
      throw errors.parseFailure(`esearch error: ${errorMessage}`);
    }

    const count = Number(data.esearchresult?.count ?? 0);
    if (count > this.broadThreshold) {
      throw errors.queryTooBroad(count);
    }
    return { count, pmids: toArray(data.esearchresult?.idlist) };
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
      pmid,
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
 * descriptions). Comment and citation links are dropped.
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
 * efetch is the only source of MeSH and correction links and is at least as
 * fresh as a cached summary, so its values replace older ones (a later
 * RetractionIn must not be hidden behind an earlier ErratumIn).
 */
function applyEfetch(article: Article, data: EfetchData): void {
  if (data.publicationTypes.length > 0) article.publicationTypes = data.publicationTypes;
  if (data.meshHeadings.length > 0) article.meshHeadings = data.meshHeadings;
  else delete article.meshHeadings;
  if (data.corrections.length > 0) article.corrections = data.corrections;
  else delete article.corrections;
}

/**
 * Search PubMed and return results classified from their NLM metadata.
 *
 * @param cache reused across calls to avoid re-fetching summaries/abstracts.
 * @param client injectable NCBI client; defaults to one configured from env.
 */
export async function searchPubMed(
  input: SearchInput,
  cache: Cache = new LRUBackend(),
  client: NcbiClient = new NcbiClient(),
): Promise<SearchOutput> {
  // As in searchLiterature: what the filter leaves out is said whatever PubMed returns.
  const warnings = filterWarnings(input.studyTypes, input.minDesignTier);
  if (input.page !== undefined && (!Number.isInteger(input.page) || input.page < 1)) {
    throw errors.invalidInput("page must be a whole number, 1 or more.");
  }
  const page = input.page ?? 1;
  if (designPublicationTypes(input.studyTypes, input.minDesignTier)?.length === 0) {
    return { articles: [], total: 0, query: input.query, page, warnings };
  }
  const { count, pmids, more, warning } = await client.esearch(input);
  if (warning) warnings.push(warning);
  const nextPage = more ? { nextPage: page + 1 } : {};

  if (pmids.length === 0) {
    if (count === 0) warnings.push("No articles matched this query. Try broader terms or fewer field tags.");
    else if (!warning) warnings.push("No results returned.");
    return { articles: [], total: count, query: input.query, page, ...nextPage, warnings };
  }
  if (count > SOFT_BROAD_THRESHOLD) {
    warnings.push(
      `Query matched ${count.toLocaleString()} articles; showing ${pmids.length} of them. Add field tags like [tiab] or [mesh] for more precise results.`,
    );
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
  // efetch carries MeSH and retraction/correction links. A summary is cached
  // only once efetch has succeeded for it; caching it earlier would hide its
  // retraction links for SUMMARY_TTL_MS after a failed efetch.
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
      warnings.push("Some abstracts could not be fetched; those articles lack abstracts, MeSH headings and retraction/correction links.");
    }
  }

  const minTier = input.minDesignTier ?? 0;
  const typeFilter = input.studyTypes?.length ? new Set<StudyType>(input.studyTypes) : null;

  const articles: GradedArticle[] = [];
  for (const pmid of pmids) {
    const summary = summaries.get(pmid);
    if (!summary) continue;
    const abstract = abstracts.get(pmid);
    const article: Article = abstract ? { ...summary, abstract } : summary;
    const graded = classifyArticle(article);
    if ((graded.designTier ?? 0) < minTier) continue;
    if (typeFilter && !typeFilter.has(graded.studyType)) continue;
    articles.push(graded);
  }
  const noAnimals = noAnimalStudiesWarning(input.studyTypes, input.minDesignTier, articles);
  if (noAnimals) warnings.push(noAnimals);

  return {
    articles,
    total: count,
    query: input.query,
    page,
    ...nextPage,
    ...(warnings.length > 0 ? { warnings } : {}),
  };
}

/**
 * Fetch full metadata + abstracts for one or more PMIDs.
 * Pure data tool — no grading. The calling agent does its own
 * analysis on the returned NcbiArticle objects.
 */
export async function fetchPubMed(
  input: FetchInput,
  cache: Cache = new LRUBackend(),
  client: NcbiClient = new NcbiClient(),
): Promise<FetchOutput> {
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
  // fetched summary: only efetch carries MeSH and retraction/correction links.
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
      warnings.push("Some abstracts could not be fetched; those articles lack abstracts, MeSH headings and retraction/correction links.");
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
