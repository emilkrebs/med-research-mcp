/**
 * ChinaRXiv / SovietRxiv adapter via the unified ChinaRxiv API.
 *
 * API: GET https://chinarxiv.org/api/v1/papers
 *
 * Single unified corpus covering both Chinese preprints (source=chinaxiv)
 * and Soviet-era Russian papers (source=russiarxiv). GET-based, no POST.
 * Optional X-API-Email header for higher rate limits (300/min vs 30/min):
 * set from MED_RESEARCH_CHINAXIV_EMAIL, falling back to NCBI_EMAIL
 * (see chinaxivHeaders below).
 *
 * The search endpoint cuts abstracts at 500 characters ("…outcome indic..."),
 * which often drops the Results of a long Chinese abstract. Search keeps those
 * previews (one request per search); an explicit fetch (`fetchFull`) loads the
 * complete record from `/papers/{id}`.
 */

import { defaultHttp, type AdapterHttp } from "./http.js";
import { RestAdapter } from "./base.js";
import { cleanDoi, first, strArray, toIso1 } from "./util.js";
import type { Cache } from "../cache.js";
import type { Article, SearchInput } from "../types.js";

const BASE = "https://chinarxiv.org/api/v1/papers";
const MAX_RESULTS_CAP = 50;
/** Bound on the complete-record memo, like the base class's search memo. */
const FULL_CAP = 1000;

/**
 * ChinaRxiv asks for an X-API-Email contact header; sending it raises the rate
 * limit from 30 to 300 requests per minute. MED_RESEARCH_CHINAXIV_EMAIL wins;
 * NCBI_EMAIL is a sensible fallback (both are contact emails).
 */
export function chinaxivHeaders(): Record<string, string> {
  // `||` so an empty MED_RESEARCH_CHINAXIV_EMAIL= (as in .env.example) still falls back.
  const email = process.env.MED_RESEARCH_CHINAXIV_EMAIL?.trim() || process.env.NCBI_EMAIL?.trim();
  return email ? { "X-API-Email": email } : {};
}

type Record_ = Record<string, unknown>;
type LinkMap = Record<string, string>;

export interface PaperResponse {
  data?: Record_[];
  total?: number;
  page?: number;
  limit?: number;
}

function toArticle(r: Record_): Article | null {
  const id = first(r.id) ?? first(r.paper_id);
  if (!id) return null;
  const doi = cleanDoi(first(r.doi));
  const source = (first(r.source) ?? "chinaxiv") as string;
  const language = source === "russiarxiv" ? "ru" : "zh";

  // Prefer English title/abstract when available, fall back to original
  const title = (first(r.title_en) ?? first(r.title) ?? "").replace(/\.$/, "");
  const abstract = first(r.abstract_en) ?? first(r.abstract);
  const url = first(r.url) ?? ((r._links as LinkMap)?.self) ?? `https://chinarxiv.org/papers/${id}`;

  const article: Article = {
    pmid: id,
    title,
    authors: strArray(r.authors),
    journal: first(r.journal) ?? first(r.publication) ?? "ChinaRXiv",
    pubDate: first(r.pub_date) ?? first(r.date) ?? first(r.year) ?? "",
    publicationTypes: [],
    database: source === "russiarxiv" ? "russiarxiv" : "chinaxiv",
    url,
    language,
  };
  if (abstract) article.abstract = abstract;
  if (doi) article.doi = doi;
  return article;
}

export function parsePapers(data: PaperResponse): { count: number; articles: Article[] } {
  const records = data?.data ?? [];
  const count = Number(data?.total ?? records.length);
  const articles: Article[] = [];
  for (const r of records) {
    const a = toArticle(r);
    if (a) articles.push(a);
  }
  return { count, articles };
}

export class ChinaRXivAdapter extends RestAdapter {
  readonly id = "chinaxiv";
  readonly name = "ChinaRXiv";

  constructor(http: AdapterHttp = defaultHttp({ headers: chinaxivHeaders() })) {
    super(http);
  }

  async search(input: SearchInput): Promise<{ count: number; ids: string[] }> {
    const limit = Math.min(Math.max(input.maxResults ?? 10, 1), MAX_RESULTS_CAP);
    const params = new URLSearchParams({
      q: input.query,
      limit: String(limit),
      page: "1",
    });
    if (input.language === "ru") params.set("source", "russiarxiv");

    const data = await this.http.json<PaperResponse>(`${BASE}?${params.toString()}`);
    const parsed = parsePapers(data);
    this.remember(parsed.articles);
    return { count: parsed.count, ids: parsed.articles.map((a) => a.pmid) };
  }

  /**
   * Complete records from the detail endpoint. Kept apart from the search memo and
   * under their own cache key: a later search would overwrite those with previews.
   */
  private readonly full = new Map<string, Article>();

  async fetchFull(ids: string[], cache: Cache): Promise<Article[]> {
    const out: Article[] = [];
    for (const id of ids) {
      const key = `${this.id}:full:${id}`;
      let article: Article | undefined = this.full.get(id) ?? cache.getSummary(key) ?? undefined;
      if (!article) {
        try {
          article = (await this.fetchOne(id)) ?? undefined;
        } catch {
          article = undefined;
        }
        if (article) cache.setSummary(key, article);
      }
      if (article) {
        if (!this.full.has(id)) {
          if (this.full.size >= FULL_CAP) this.full.clear();
          this.full.set(id, article);
        }
        out.push(article);
        continue;
      }
      // Detail endpoint unavailable: serve the preview search left behind, without
      // re-requesting the detail endpoint or memoizing the preview as complete, so
      // the next explicit fetch tries the detail endpoint again.
      const preview = this.cached(id, cache);
      if (preview) out.push(preview);
    }
    return out;
  }

  protected async fetchOne(id: string): Promise<Article | null> {
    // Exact lookup by id; a `q=` text search for the id can return a different paper.
    const record = await this.http.json<Record_>(`${BASE}/${encodeURIComponent(id)}`);
    const article = parsePapers({ data: [record] }).articles[0];
    return article?.pmid === id ? article : null;
  }
}
