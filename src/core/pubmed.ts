/**
 * NCBI E-utilities client (esearch → esummary → efetch) and the searchPubMed
 * orchestrator. Abstracts are parsed from efetch XML with fast-xml-parser — no
 * regex XML scraping.
 */

import { XMLParser } from "fast-xml-parser";
import type { Cache } from "./cache.js";
import { LRUBackend } from "./cache.js";
import { errors } from "./errors.js";
import { keywordGrade, unclassifiedDroppedWarning } from "./grader.js";
import type { FetchInput, FetchOutput, GradedArticle, Article, SearchInput, SearchOutput, StudyType } from "./types.js";

const EUTILS_BASE = "https://eutils.ncbi.nlm.nih.gov/entrez/eutils";
const MAX_RESULTS_CAP = 50;
/** Above this esearch count, refuse and ask the caller to narrow. */
const DEFAULT_BROAD_THRESHOLD = 100_000;
/** Above this, still run but attach a warning. */
const SOFT_BROAD_THRESHOLD = 10_000;

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
}

/** Serializes requests and spaces them to respect NCBI's rate limit. */
class RateLimiter {
  private lastAt = 0;
  private tail: Promise<unknown> = Promise.resolve();
  private readonly gapMs: number;

  constructor(reqPerSec: number) {
    this.gapMs = 1000 / reqPerSec;
  }

  run<T>(fn: () => Promise<T>): Promise<T> {
    const result = this.tail.then(async () => {
      const wait = this.lastAt + this.gapMs - Date.now();
      if (wait > 0) await new Promise((r) => setTimeout(r, wait));
      this.lastAt = Date.now();
      return fn();
    });
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
  }

  private commonParams(params: URLSearchParams): URLSearchParams {
    params.set("tool", this.tool);
    if (this.email) params.set("email", this.email);
    if (this.apiKey) params.set("api_key", this.apiKey);
    return params;
  }

  private async request(path: string, params: URLSearchParams): Promise<Response> {
    const url = `${EUTILS_BASE}/${path}?${this.commonParams(params).toString()}`;
    return this.limiter.run(async () => {
      const ac = new AbortController();
      const timer = setTimeout(() => ac.abort(), this.timeoutMs);
      let res: Response;
      try {
        res = await fetch(url, { signal: ac.signal });
      } catch (err) {
        throw errors.network(err instanceof Error ? err.message : String(err));
      } finally {
        clearTimeout(timer);
      }
      if (res.status === 429) {
        const retryAfter = Number(res.headers.get("retry-after")) || 1;
        throw errors.rateLimit(retryAfter);
      }
      if (!res.ok) {
        throw errors.network(`NCBI returned HTTP ${res.status}`);
      }
      return res;
    });
  }

  /** Returns matching PMIDs (already truncated to maxResults) and the total count. */
  async esearch(input: SearchInput): Promise<{ count: number; pmids: string[] }> {
    const maxResults = Math.min(Math.max(input.maxResults ?? 10, 1), MAX_RESULTS_CAP);
    const params = new URLSearchParams({
      db: "pubmed",
      term: input.query,
      retmode: "json",
      retmax: String(maxResults),
      sort: input.sort === "date" ? "pub_date" : "relevance",
    });
    if (input.dateRange?.from || input.dateRange?.to) {
      params.set("datetype", "pdat");
      if (input.dateRange.from) params.set("mindate", input.dateRange.from.replace(/-/g, "/"));
      if (input.dateRange.to) params.set("maxdate", input.dateRange.to.replace(/-/g, "/"));
    }

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
    return article;
  }

  /** Fetches abstract text and publication types via efetch XML. Keyed by PMID. */
  async efetch(pmids: string[]): Promise<Map<string, { abstract?: string; publicationTypes: string[] }>> {
    const out = new Map<string, { abstract?: string; publicationTypes: string[] }>();
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
  parseEfetch(xml: string): Map<string, { abstract?: string; publicationTypes: string[] }> {
    const out = new Map<string, { abstract?: string; publicationTypes: string[] }>();
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

function extractPubTypes(ptl: unknown): string[] {
  if (!ptl || typeof ptl !== "object") return [];
  const pt = (ptl as Record<string, unknown>).PublicationType;
  return toArray(pt)
    .map((node) => {
      if (typeof node === "string" || typeof node === "number") return String(node);
      if (!node || typeof node !== "object") return "";
      return String((node as Record<string, unknown>)["#text"] ?? "");
    })
    .map((s) => s.trim())
    .filter(Boolean);
}

/**
 * Search PubMed and return keyword-graded results.
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

  // Summaries (metadata) — cache-first.
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
    for (const [pmid, article] of fetched) {
      cache.setSummary(pmid, article);
      summaries.set(pmid, article);
    }
  }

  // Abstracts + publication types — cache-first for abstracts.
  const abstracts = new Map<string, string>();
  const missingAbstracts: string[] = [];
  for (const pmid of pmids) {
    const cached = cache.getAbstract(pmid);
    if (cached != null) {
      abstracts.set(pmid, cached);
    } else {
      missingAbstracts.push(pmid);
    }
  }
  if (missingAbstracts.length > 0) {
    try {
      const fetched = await client.efetch(missingAbstracts);
      for (const [pmid, data] of fetched) {
        if (data.abstract) {
          cache.setAbstract(pmid, data.abstract);
          abstracts.set(pmid, data.abstract);
        }
        // Backfill publication types when esummary didn't provide them.
        const summary = summaries.get(pmid);
        if (summary && summary.publicationTypes.length === 0 && data.publicationTypes.length > 0) {
          summary.publicationTypes = data.publicationTypes;
          cache.setSummary(pmid, summary);
        }
      }
    } catch (err) {
      // Abstracts are best-effort: degrade to title-only grading with a warning.
      warnings.push("Some abstracts could not be fetched; those articles were graded from title only.");
    }
  }

  const minScore = input.minEvidenceScore ?? 0;
  const typeFilter = input.studyTypes ? new Set<StudyType>(input.studyTypes) : null;

  const articles: GradedArticle[] = [];
  let droppedUnclassified = 0;
  for (const pmid of pmids) {
    const summary = summaries.get(pmid);
    if (!summary) continue;
    const abstract = abstracts.get(pmid);
    const article: Article = abstract ? { ...summary, abstract } : summary;
    const graded = keywordGrade(article);
    if (graded.evidenceScore < minScore) {
      if (graded.studyType === "unknown") droppedUnclassified += 1;
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
    for (const [pmid, article] of fetched) {
      cache.setSummary(pmid, article);
      allArticles.set(pmid, article);
    }
  }

  // Check which PMIDs we couldn't get summaries for.
  for (const pmid of input.ids) {
    if (!allArticles.has(pmid)) missing.push(pmid);
  }

  // Abstracts (best-effort, cache-aware).
  const pmidsWithSummary = [...allArticles.keys()];
  const needAbstract = pmidsWithSummary.filter((pmid) => cache.getAbstract(pmid) == null);

  if (needAbstract.length > 0) {
    try {
      const fetched = await client.efetch(needAbstract);
      for (const [pmid, data] of fetched) {
        if (data.abstract) {
          cache.setAbstract(pmid, data.abstract);
          const article = allArticles.get(pmid);
          if (article) {
            article.abstract = data.abstract;
            if (article.publicationTypes.length === 0 && data.publicationTypes.length > 0) {
              article.publicationTypes = data.publicationTypes;
            }
            cache.setSummary(pmid, article);
          }
        }
        if (data.publicationTypes.length > 0) {
          const article = allArticles.get(pmid);
          if (article && article.publicationTypes.length === 0) {
            article.publicationTypes = data.publicationTypes;
            cache.setSummary(pmid, article);
          }
        }
      }
    } catch {
      warnings.push("Some abstracts could not be fetched.");
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
