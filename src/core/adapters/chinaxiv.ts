/**
 * ChinaXiv adapter — Chinese Academy of Sciences preprint server.
 *
 * API: POST https://chinaxiv.org/api/search  (JSON body)
 *
 * Returns structured JSON with English titles/abstracts and Chinese full texts.
 * Articles are tagged `language: "zh"` to cue the agent. Full text is typically
 * a PDF resolved via the shared full-text pipeline.
 */

import { defaultHttp, type AdapterHttp } from "./http.js";
import { RestAdapter } from "./base.js";
import { cleanDoi, first, strArray, toIso1 } from "./util.js";
import type { Article, SearchInput } from "../types.js";

const BASE = "https://chinaxiv.org/api/search";
const MAX_RESULTS_CAP = 50;

type Record_ = Record<string, unknown>;

interface ChinaXivResponse {
  success?: boolean;
  code?: number;
  message?: string;
  data?: {
    total?: number;
    content?: Record_[];
  };
}

function toArticle(r: Record_): Article | null {
  const id = first(r.id) ?? first(r.uuid) ?? first(r.doi);
  if (!id) return null;
  const doi = cleanDoi(first(r.doi));
  // ChinaXiv uses "entitle" for English title, "title" for Chinese
  const title = first(r.entitle) ?? first(r.title) ?? first(r.title_str) ?? "";
  const language = toIso1(first(r.language)) ?? "zh";

  const article: Article = {
    pmid: id,
    title: title.replace(/\.$/, ""),
    authors: strArray(r.authors ?? r.author),
    journal: first(r.journal) ?? first(r.source) ?? first(r.publisher) ?? "ChinaXiv",
    pubDate: first(r.year) ?? first(r.date) ?? first(r.createTime) ?? "",
    publicationTypes: [],
    database: "chinaxiv",
    url: first(r.url) ?? first(r.link) ?? `https://chinaxiv.org/abs/${id}`,
    language,
  };
  const abstract = first(r.enabstract) ?? first(r.abstract) ?? first(r.summary);
  if (abstract) article.abstract = abstract;
  if (doi) article.doi = doi;
  return article;
}

/** Pure parser — exposed for testing without the network. */
export function parseChinaXiv(data: ChinaXivResponse): { count: number; articles: Article[] } {
  const content = data?.data?.content ?? [];
  const count = Number(data?.data?.total ?? content.length);
  const articles: Article[] = [];
  for (const r of content) {
    const a = toArticle(r);
    if (a) articles.push(a);
  }
  return { count, articles };
}

export class ChinaXivAdapter extends RestAdapter {
  readonly id = "chinaxiv";
  readonly name = "ChinaXiv";

  constructor(http: AdapterHttp = defaultHttp()) {
    super(http);
  }

  async search(input: SearchInput): Promise<{ count: number; ids: string[] }> {
    const size = Math.min(Math.max(input.maxResults ?? 10, 1), MAX_RESULTS_CAP);
    const data = await this.http.post<ChinaXivResponse>(BASE, { q: input.query, page: 0, size });
    const parsed = parseChinaXiv(data);
    this.remember(parsed.articles);
    return { count: parsed.count, ids: parsed.articles.map((a) => a.pmid) };
  }

  protected async fetchOne(id: string): Promise<Article | null> {
    const data = await this.http.post<ChinaXivResponse>(BASE, { q: id, page: 0, size: 1 });
    return parseChinaXiv(data).articles[0] ?? null;
  }
}
