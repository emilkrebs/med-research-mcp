/**
 * ChinaXiv adapter — the Chinese Academy of Sciences preprint server.
 *
 * API: GET http://chinaxiv.org/api/search?q={q}&page=1&size={n}
 *
 * ChinaXiv is open-access by definition (a preprint server) and a growing
 * biomedical repository. Papers carry English titles/abstracts with Chinese
 * full text, so articles are tagged `language: "zh"` to cue the agent. Full
 * text is typically a PDF resolved via the shared full-text pipeline. The exact
 * JSON envelope isn't publicly documented, so the parser accepts the common
 * `total`/`count` + `data`/`records`/`results` variants and is defensive about
 * field names.
 */

import { defaultHttp, type AdapterHttp } from "./http.js";
import { RestAdapter } from "./base.js";
import { cleanDoi, first, strArray, toIso1 } from "./util.js";
import type { Article, SearchInput } from "../types.js";

const BASE = "http://chinaxiv.org/api/search";
const MAX_RESULTS_CAP = 50;

type Record_ = Record<string, unknown>;

interface ChinaXivResponse {
  total?: number;
  count?: number;
  data?: Record_[];
  records?: Record_[];
  results?: Record_[];
}

function toArticle(r: Record_): Article | null {
  const id = first(r.id) ?? first(r.identifier) ?? first(r.doi);
  if (!id) return null;
  const doi = cleanDoi(first(r.doi));
  const language = toIso1(first(r.language)) ?? "zh";
  const url = first(r.url) ?? first(r.link) ?? `http://chinaxiv.org/abs/${id}`;

  const article: Article = {
    pmid: id,
    title: (first(r.title) ?? "").replace(/\.$/, ""),
    authors: strArray(r.authors ?? r.author ?? r.creators),
    journal: first(r.journal) ?? first(r.source) ?? "ChinaXiv",
    pubDate: first(r.year) ?? first(r.date) ?? first(r.publishTime) ?? "",
    publicationTypes: [],
    database: "chinaxiv",
    url,
    language,
  };
  const abstract = first(r.abstract) ?? first(r.summary);
  if (abstract) article.abstract = abstract;
  if (doi) article.doi = doi;
  return article;
}

/** Pure parser — exposed for testing without the network. */
export function parseChinaXiv(data: ChinaXivResponse): { count: number; articles: Article[] } {
  const records = data?.data ?? data?.records ?? data?.results ?? [];
  const count = Number(data?.total ?? data?.count ?? records.length);
  const articles: Article[] = [];
  for (const r of records) {
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
    const params = new URLSearchParams({ q: input.query, page: "1", size: String(size) });
    const data = await this.http.json<ChinaXivResponse>(`${BASE}?${params.toString()}`);
    const parsed = parseChinaXiv(data);
    this.remember(parsed.articles);
    return { count: parsed.count, ids: parsed.articles.map((a) => a.pmid) };
  }

  protected async fetchOne(id: string): Promise<Article | null> {
    const params = new URLSearchParams({ q: id, page: "1", size: "1" });
    const data = await this.http.json<ChinaXivResponse>(`${BASE}?${params.toString()}`);
    return parseChinaXiv(data).articles[0] ?? null;
  }
}
