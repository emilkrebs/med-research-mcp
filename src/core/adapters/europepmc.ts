/**
 * Europe PMC adapter.
 *
 * API: GET https://www.ebi.ac.uk/europepmc/webservices/rest/search
 *          ?query={q}&format=json&pageSize={n}&resultType=core
 *
 * Europe PMC mirrors PubMed and adds preprints plus European grant metadata. The
 * `core` result type includes the abstract and full-text links in the search
 * response, so no second fetch is needed. Records carry a `source` (MED, PPR,
 * PMC, …) and an `id`; we key on `id` and reconstruct the article URL from both.
 */

import { defaultHttp, type AdapterHttp } from "./http.js";
import { RestAdapter } from "./base.js";
import { cleanDoi, first, splitAuthors, toIso1 } from "./util.js";
import type { Article, SearchInput } from "../types.js";

const BASE = "https://www.ebi.ac.uk/europepmc/webservices/rest/search";
const MAX_RESULTS_CAP = 50;

interface EpmcResult {
  id?: string;
  source?: string;
  pmid?: string;
  doi?: string;
  title?: string;
  authorString?: string;
  journalTitle?: string;
  pubYear?: string;
  abstractText?: string;
  language?: string;
  fullTextUrlList?: { fullTextUrl?: { url?: string }[] };
}

interface EpmcResponse {
  hitCount?: number;
  resultList?: { result?: EpmcResult[] };
}

function toArticle(r: EpmcResult): Article | null {
  const id = first(r.id) ?? first(r.pmid);
  if (!id) return null;
  const source = first(r.source) ?? "MED";
  const doi = cleanDoi(first(r.doi));
  const language = toIso1(first(r.language)) ?? "en";
  const url =
    first(r.fullTextUrlList?.fullTextUrl?.[0]?.url) ?? `https://europepmc.org/article/${source}/${id}`;

  const article: Article = {
    pmid: id,
    title: (first(r.title) ?? "").replace(/\.$/, ""),
    authors: splitAuthors(r.authorString),
    journal: first(r.journalTitle) ?? "",
    pubDate: first(r.pubYear) ?? "",
    publicationTypes: [],
    database: "europepmc",
    url,
    language,
  };
  const abstract = first(r.abstractText);
  if (abstract) article.abstract = abstract;
  if (doi) article.doi = doi;
  return article;
}

/** Pure parser — exposed for testing without the network. */
export function parseEuropePmc(data: EpmcResponse): { count: number; articles: Article[] } {
  const count = Number(data?.hitCount ?? 0);
  const results = data?.resultList?.result ?? [];
  const articles: Article[] = [];
  for (const r of results) {
    const a = toArticle(r);
    if (a) articles.push(a);
  }
  return { count, articles };
}

export class EuropePmcAdapter extends RestAdapter {
  readonly id = "europepmc";
  readonly name = "Europe PMC";

  constructor(http: AdapterHttp = defaultHttp()) {
    super(http);
  }

  private buildQuery(input: SearchInput): string {
    let query = input.query;
    const from = input.dateRange?.from;
    const to = input.dateRange?.to;
    if (from || to) {
      query += ` AND (FIRST_PDATE:[${from ?? "1900-01-01"} TO ${to ?? "3000-01-01"}])`;
    }
    return query;
  }

  async search(input: SearchInput): Promise<{ count: number; ids: string[] }> {
    const pageSize = Math.min(Math.max(input.maxResults ?? 10, 1), MAX_RESULTS_CAP);
    const params = new URLSearchParams({
      query: this.buildQuery(input),
      format: "json",
      resultType: "core",
      pageSize: String(pageSize),
    });
    if (input.sort === "date") params.set("sort", "P_PDATE_D desc");
    const data = await this.http.json<EpmcResponse>(`${BASE}?${params.toString()}`);
    const { count, articles } = parseEuropePmc(data);
    this.remember(articles);
    return { count, ids: articles.map((a) => a.pmid) };
  }

  protected async fetchOne(id: string): Promise<Article | null> {
    const params = new URLSearchParams({ query: id, format: "json", resultType: "core", pageSize: "1" });
    const data = await this.http.json<EpmcResponse>(`${BASE}?${params.toString()}`);
    return parseEuropePmc(data).articles[0] ?? null;
  }
}
