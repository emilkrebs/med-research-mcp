/**
 * J-STAGE adapter — Japan Science and Technology Information Aggregator.
 *
 * API: GET https://www.jstage.jst.go.jp/api/records?q={q}&page=1&count={n}
 *
 * Covers Japanese medical, pharmaceutical, and life-science journals; many
 * records carry English abstracts and DOIs, so they slot cleanly into the
 * shared full-text pipeline. Records default to `language: "ja"` unless the API
 * reports otherwise. The JSON envelope is treated defensively (`total`/`count`
 * plus `records`/`data`/`results`) since J-STAGE's public API is XML-first.
 */

import { defaultHttp, type AdapterHttp } from "./http.js";
import { RestAdapter } from "./base.js";
import { cleanDoi, first, splitAuthors, strArray, toIso1 } from "./util.js";
import type { NcbiArticle, SearchInput } from "../types.js";

const BASE = "https://www.jstage.jst.go.jp/api/records";
const MAX_RESULTS_CAP = 50;

type Record_ = Record<string, unknown>;

interface JStageResponse {
  total?: number;
  count?: number;
  records?: Record_[];
  data?: Record_[];
  results?: Record_[];
}

function authors(r: Record_): string[] {
  // Accept either an array of names or a single delimited author string.
  const arr = strArray(r.authors ?? r.author ?? r.creators);
  if (arr.length > 1) return arr;
  return arr.length === 1 ? splitAuthors(arr[0]) : splitAuthors(r.authorString);
}

function toArticle(r: Record_): NcbiArticle | null {
  const doi = cleanDoi(first(r.doi));
  const id = first(r.id) ?? first(r.articleId) ?? doi;
  if (!id) return null;
  const language = toIso1(first(r.language)) ?? "ja";
  const url = first(r.url) ?? first(r.link) ?? (doi ? `https://doi.org/${doi}` : `https://www.jstage.jst.go.jp/`);

  const article: NcbiArticle = {
    pmid: id,
    title: (first(r.title) ?? "").replace(/\.$/, ""),
    authors: authors(r),
    journal: first(r.journal) ?? first(r.journalTitle) ?? first(r.source) ?? "",
    pubDate: first(r.year) ?? first(r.date) ?? first(r.pubYear) ?? "",
    publicationTypes: [],
    database: "jstage",
    url,
    language,
  };
  const abstract = first(r.abstract) ?? first(r.abstractText);
  if (abstract) article.abstract = abstract;
  if (doi) article.doi = doi;
  return article;
}

/** Pure parser — exposed for testing without the network. */
export function parseJStage(data: JStageResponse): { count: number; articles: NcbiArticle[] } {
  const records = data?.records ?? data?.data ?? data?.results ?? [];
  const count = Number(data?.total ?? data?.count ?? records.length);
  const articles: NcbiArticle[] = [];
  for (const r of records) {
    const a = toArticle(r);
    if (a) articles.push(a);
  }
  return { count, articles };
}

export class JStageAdapter extends RestAdapter {
  readonly id = "jstage";
  readonly name = "J-STAGE";

  constructor(http: AdapterHttp = defaultHttp()) {
    super(http);
  }

  async search(input: SearchInput): Promise<{ count: number; ids: string[] }> {
    const count = Math.min(Math.max(input.maxResults ?? 10, 1), MAX_RESULTS_CAP);
    const params = new URLSearchParams({ q: input.query, page: "1", count: String(count) });
    const data = await this.http.json<JStageResponse>(`${BASE}?${params.toString()}`);
    const parsed = parseJStage(data);
    this.remember(parsed.articles);
    return { count: parsed.count, ids: parsed.articles.map((a) => a.pmid) };
  }

  protected async fetchOne(id: string): Promise<NcbiArticle | null> {
    const params = new URLSearchParams({ q: id, page: "1", count: "1" });
    const data = await this.http.json<JStageResponse>(`${BASE}?${params.toString()}`);
    return parseJStage(data).articles[0] ?? null;
  }
}
