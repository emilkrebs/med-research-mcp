/**
 * SciELO adapter (Latin America, Spain, Portugal, South Africa).
 *
 * API: GET https://search.scielo.org/?q={q}&lang=en&count={n}&from={offset}&output=site&format=json
 *
 * SciELO's search is Solr-backed, so results arrive as `{ response: { numFound,
 * docs } }`. Every article is open access, so a resolved DOI flows straight
 * through the existing Unpaywall→proxy→direct full-text pipeline. SciELO's Solr
 * fields are multilingual and language-suffixed (`ti_es`, `ab_pt`, …); the
 * parser prefers the plain field then falls back to any language variant, which
 * is the part most likely to need tuning against live field names.
 */

import { defaultHttp, type AdapterHttp } from "./http.js";
import { RestAdapter } from "./base.js";
import { cleanDoi, first, strArray, toIso1 } from "./util.js";
import type { NcbiArticle, SearchInput } from "../types.js";

const BASE = "https://search.scielo.org/";
const MAX_RESULTS_CAP = 50;

type SolrDoc = Record<string, unknown>;

interface ScieloResponse {
  response?: { numFound?: number; docs?: SolrDoc[] };
}

/** Prefer the plain field, else any language-suffixed variant ("ti" → "ti_es"). */
function fieldByPrefix(doc: SolrDoc, prefix: string): unknown {
  if (doc[prefix] != null) return doc[prefix];
  for (const key of Object.keys(doc)) {
    if (key === prefix || key.startsWith(`${prefix}_`)) return doc[key];
  }
  return undefined;
}

function toArticle(doc: SolrDoc): NcbiArticle | null {
  const id = first(doc.id);
  if (!id) return null;
  const doi = cleanDoi(first(doc.doi));
  const language = toIso1(first(fieldByPrefix(doc, "la"))) ?? "es";
  const url = first(fieldByPrefix(doc, "ur")) ?? `https://search.scielo.org/?q=${encodeURIComponent(id)}`;

  const article: NcbiArticle = {
    pmid: id,
    title: (first(fieldByPrefix(doc, "ti")) ?? "").replace(/\.$/, ""),
    authors: strArray(fieldByPrefix(doc, "au")),
    journal: first(fieldByPrefix(doc, "journal_title")) ?? first(doc.ta) ?? "",
    pubDate: first(doc.publication_year) ?? first(doc.da) ?? "",
    publicationTypes: [],
    database: "scielo",
    url,
    language,
  };
  const abstract = first(fieldByPrefix(doc, "ab"));
  if (abstract) article.abstract = abstract;
  if (doi) article.doi = doi;
  return article;
}

/** Pure parser — exposed for testing without the network. */
export function parseScielo(data: ScieloResponse): { count: number; articles: NcbiArticle[] } {
  const count = Number(data?.response?.numFound ?? 0);
  const docs = data?.response?.docs ?? [];
  const articles: NcbiArticle[] = [];
  for (const doc of docs) {
    const a = toArticle(doc);
    if (a) articles.push(a);
  }
  return { count, articles };
}

export class SciELOAdapter extends RestAdapter {
  readonly id = "scielo";
  readonly name = "SciELO";

  constructor(http: AdapterHttp = defaultHttp()) {
    super(http);
  }

  async search(input: SearchInput): Promise<{ count: number; ids: string[] }> {
    const count = Math.min(Math.max(input.maxResults ?? 10, 1), MAX_RESULTS_CAP);
    const params = new URLSearchParams({
      q: input.query,
      lang: input.language ?? "en",
      count: String(count),
      from: "0",
      output: "site",
      format: "json",
    });
    const data = await this.http.json<ScieloResponse>(`${BASE}?${params.toString()}`);
    const parsed = parseScielo(data);
    this.remember(parsed.articles);
    return { count: parsed.count, ids: parsed.articles.map((a) => a.pmid) };
  }

  protected async fetchOne(id: string): Promise<NcbiArticle | null> {
    const params = new URLSearchParams({
      q: `id:${id}`,
      count: "1",
      from: "0",
      output: "site",
      format: "json",
    });
    const data = await this.http.json<ScieloResponse>(`${BASE}?${params.toString()}`);
    return parseScielo(data).articles[0] ?? null;
  }
}
