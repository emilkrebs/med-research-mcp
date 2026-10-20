/**
 * NCBI E-utilities client (esearch → esummary → efetch) and the searchPubMed
 * orchestrator. Abstracts are parsed from efetch XML with fast-xml-parser — no
 * regex XML scraping.
 */

import { XMLParser } from "fast-xml-parser";
import { LRUCache } from "lru-cache";
import type { Cache } from "./cache.js";
import { LRUBackend } from "./cache.js";
import { errors } from "./errors.js";
import { USER_AGENT } from "./version.js";
import { classifyArticle, designPublicationTypes, unclassifiedDroppedWarning } from "./grader.js";
import { CORRECTION_TYPES } from "./types.js";
import type { Correction, CorrectionType, FetchInput, FetchOutput, GradedArticle, Article, SearchInput, SearchOutput, StudyType } from "./types.js";

const EUTILS_BASE = "https://eutils.ncbi.nlm.nih.gov/entrez/eutils";
const MAX_RESULTS_CAP = 50;
/** Above this esearch count, refuse and ask the caller to narrow. */
const DEFAULT_BROAD_THRESHOLD = 100_000;
/** Above this, still run but attach a warning. */
const SOFT_BROAD_THRESHOLD = 10_000;
/**
 * Spacing between requests, as a multiple of 1/limit. NCBI counts requests as they
 * arrive, and arrival times jitter: spaced exactly 1/3 s apart, 2 of 15 serialized
 * requests drew a 429; spaced 400 ms apart, 1 of 15 (2026-10-20). The rest is left
 * to retries.
 */
const SPACING_MARGIN = 1.2;
/** 429s retried, after NCBI's Retry-After, before RATE_LIMIT reaches the caller. */
const RATE_LIMIT_RETRIES = 2;
/** The longest Retry-After waited out (NCBI sends 2 s); a longer one goes to the caller. */
const MAX_RETRY_WAIT_S = 5;
/**
 * How long a search's PMIDs are reused. PubMed's relevance ranking varies between
 * identical requests: five identical searches returned five different top-20 lists
 * (2026-10-20), so within this window the same search returns the same papers.
 */
const DEFAULT_SEARCH_TTL_MS = 60 * 60 * 1000;

export interface NcbiConfig {
  /** Contact email — NCBI asks for one on every request. Defaults to $NCBI_EMAIL. */
  email?: string;
  /** API key raises the rate limit from 3 to 10 req/s. Defaults to $NCBI_API_KEY. */
  apiKey?: string;
  /** Identifies the client to NCBI. */
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
 * sends, so a task that waits out a 429 holds back the whole queue.
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

export class NcbiClient {
  private readonly email: string | undefined;
  private readonly apiKey: string | undefined;
  private readonly tool: string;
  private readonly broadThreshold: number;
  private readonly timeoutMs: number;
  private readonly limiter: RateLimiter;
  private readonly parser: XMLParser;
  private readonly searches: LRUCache<string, { count: number; pmids: string[] }> | null;

  constructor(config: NcbiConfig = {}) {
    this.email = config.email ?? process.env.NCBI_EMAIL;
    this.apiKey = config.apiKey ?? process.env.NCBI_API_KEY;
    this.tool = config.tool ?? "med-research-mcp";
    this.broadThreshold = config.broadThreshold ?? DEFAULT_BROAD_THRESHOLD;
    this.timeoutMs = config.timeoutMs ?? 15_000;
    this.limiter = new RateLimiter(this.apiKey ? 10 : 3);
    this.parser = new XMLParser({
      ignoreAttributes: false,
      attributeNamePrefix: "@_",
      textNodeName: "#text",
      trimValues: true,
    });
    const searchTtl = config.searchTtlMs ?? DEFAULT_SEARCH_TTL_MS;
    this.searches = searchTtl > 0 ? new LRUCache({ max: 200, ttl: searchTtl }) : null;
  }

  private commonParams(params: URLSearchParams): URLSearchParams {
    params.set("tool", this.tool);
    if (this.email) params.set("email", this.email);
    if (this.apiKey) params.set("api_key", this.apiKey);
    return params;
  }

  private async request(path: string, params: URLSearchParams): Promise<Response> {
    const url = `${EUTILS_BASE}/${path}?${this.commonParams(params).toString()}`;
    return this.limiter.run(async (pace) => {
      for (let attempt = 0; ; attempt += 1) {
        await pace();
        const ac = new AbortController();
        const timer = setTimeout(() => ac.abort(), this.timeoutMs);
        let res: Response;
        try {
          res = await fetch(url, { signal: ac.signal, headers: { "User-Agent": USER_AGENT } });
        } catch (err) {
          throw errors.network(err instanceof Error ? err.message : String(err));
        } finally {
          clearTimeout(timer);
        }
        if (res.status === 429) {
          const retryAfter = Number(res.headers.get("retry-after")) || 1;
          await res.body?.cancel();
          if (attempt >= RATE_LIMIT_RETRIES || retryAfter > MAX_RETRY_WAIT_S) throw errors.rateLimit(retryAfter);
          await sleep(retryAfter * 1000);
          continue;
        }
        if (!res.ok) {
          throw errors.network(`NCBI returned HTTP ${res.status}`);
        }
        return res;
      }
    });
  }

  /**
   * Returns matching PMIDs (already truncated to maxResults) and the total count. A
   * studyTypes or minDesignTier filter narrows the query to the publication types it
   * can keep (see designPublicationTypes), so the count is of candidates for it.
   * An identical search within `searchTtlMs` returns the same PMIDs.
   */
  async esearch(input: SearchInput): Promise<{ count: number; pmids: string[] }> {
    const maxResults = Math.min(Math.max(input.maxResults ?? 10, 1), MAX_RESULTS_CAP);
    const types = designPublicationTypes(input.studyTypes, input.minDesignTier);
    if (types?.length === 0) return { count: 0, pmids: [] };
    const term = types ? `(${input.query}) AND (${types.map((t) => `"${t}"[pt]`).join(" OR ")})` : input.query;
    const params = new URLSearchParams({
      db: "pubmed",
      term,
      retmode: "json",
      retmax: String(maxResults),
      sort: input.sort === "date" ? "pub_date" : "relevance",
    });
    if (input.dateRange?.from || input.dateRange?.to) {
      params.set("datetype", "pdat");
      if (input.dateRange.from) params.set("mindate", input.dateRange.from.replace(/-/g, "/"));
      if (input.dateRange.to) params.set("maxdate", input.dateRange.to.replace(/-/g, "/"));
    }

    const key = params.toString();
    const cached = this.searches?.get(key);
    if (cached) return { count: cached.count, pmids: [...cached.pmids] };
    const result = await this.runEsearch(params);
    this.searches?.set(key, result);
    return { count: result.count, pmids: [...result.pmids] };
  }

  private async runEsearch(params: URLSearchParams): Promise<{ count: number; pmids: string[] }> {
    const res = await this.request("esearch.fcgi", params);
    let data: { esearchresult?: { count?: string; idlist?: string[]; ERROR?: string }; ERROR?: string };
    try {
      data = (await res.json()) as typeof data;
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
    if (pmids.length === 0) return out;

    const params = new URLSearchParams({
      db: "pubmed",
      id: pmids.join(","),
      retmode: "json",
    });
    const res = await this.request("esummary.fcgi", params);
    let data: { result?: Record<string, EsummaryDoc | string[]> };
    try {
      data = (await res.json()) as typeof data;
    } catch (err) {
      throw errors.parseFailure(err instanceof Error ? err.message : "invalid JSON from esummary");
    }

    const result = data.result;
    if (!result) return out;
    for (const pmid of pmids) {
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
    const res = await this.request("efetch.fcgi", params);
    const xml = await res.text();
    return this.parseEfetch(xml);
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
      out.set(pmid, {
        ...(extractAbstract(articleNode.Abstract) !== undefined
          ? { abstract: extractAbstract(articleNode.Abstract) }
          : {}),
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

function extractAbstract(abstractNode: unknown): string | undefined {
  if (!abstractNode || typeof abstractNode !== "object") return undefined;
  const at = (abstractNode as Record<string, unknown>).AbstractText;
  if (at == null) return undefined;
  const parts = toArray(at)
    .map((node) => {
      if (typeof node === "string" || typeof node === "number") return String(node);
      if (!node || typeof node !== "object") return "";
      const rec = node as Record<string, unknown>;
      const label = rec["@_Label"];
      const text = rec["#text"] ?? "";
      return label ? `${String(label)}: ${String(text)}` : String(text);
    })
    .map((s) => s.trim())
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
  const warnings: string[] = [];
  const { count, pmids } = await client.esearch(input);

  if (pmids.length === 0) {
    return {
      articles: [],
      total: count,
      query: input.query,
      warnings: [count === 0 ? "No articles matched this query. Try broader terms or fewer field tags." : "No results returned."],
    };
  }
  if (count > SOFT_BROAD_THRESHOLD) {
    warnings.push(
      `Query matched ${count.toLocaleString()} articles; showing the top ${pmids.length}. Add field tags like [tiab] or [mesh] for more precise results.`,
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
  let droppedUnclassified = 0;
  for (const pmid of pmids) {
    const summary = summaries.get(pmid);
    if (!summary) continue;
    const abstract = abstracts.get(pmid);
    const article: Article = abstract ? { ...summary, abstract } : summary;
    const graded = classifyArticle(article);
    if ((graded.designTier ?? 0) < minTier) {
      if (graded.designTier == null) droppedUnclassified += 1;
      continue;
    }
    if (typeFilter && !typeFilter.has(graded.studyType)) continue;
    articles.push(graded);
  }
  if (droppedUnclassified > 0) warnings.push(unclassifiedDroppedWarning(droppedUnclassified));

  return {
    articles,
    total: count,
    query: input.query,
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
