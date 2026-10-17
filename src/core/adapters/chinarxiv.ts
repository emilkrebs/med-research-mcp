/**
 * ChinaRXiv / SovietRxiv adapter via the unified ChinaRxiv API.
 *
 * API: GET https://chinarxiv.org/api/v1/papers
 *
 * Single unified corpus covering both Chinese preprints (source=chinaxiv)
 * and Soviet-era Russian papers (source=russiarxiv). GET-based, no POST.
 * Optional X-API-Email header for higher rate limits (300/min vs 30/min).
 */

import { defaultHttp, type AdapterHttp } from "./http.js";
import { RestAdapter } from "./base.js";
import { cleanDoi, first, strArray, toIso1 } from "./util.js";
import type { Article, SearchInput } from "../types.js";

const BASE = "https://chinarxiv.org/api/v1/papers";
const MAX_RESULTS_CAP = 50;

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

  constructor(http: AdapterHttp = defaultHttp()) {
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

  protected async fetchOne(id: string): Promise<Article | null> {
    // Exact lookup by id; a `q=` text search for the id can return a different paper.
    const record = await this.http.json<Record_>(`${BASE}/${encodeURIComponent(id)}`);
    const article = parsePapers({ data: [record] }).articles[0];
    return article?.pmid === id ? article : null;
  }
}
