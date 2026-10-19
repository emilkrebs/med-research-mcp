/**
 * Europe PMC adapter.
 *
 * API: GET https://www.ebi.ac.uk/europepmc/webservices/rest/search
 *          ?query={q}&format=json&pageSize={n}&resultType=core
 *
 * Europe PMC mirrors PubMed and adds preprints plus European grant metadata. The
 * `core` result type includes the abstract and full-text links in the search
 * response, so no second fetch is needed. Records carry a `source` (MED, PPR,
 * PMC, CBA, …) and an `id`; we key on `id` and reconstruct the article URL from both.
 * MEDLINE records carry the same NLM PublicationType tags, MeSH headings and
 * retraction/correction links as PubMed, so they classify the same way;
 * preprints are tagged "Preprint".
 *
 * Ids are only unique within a source: non-PubMed sources such as CBA (Chinese
 * Biological Abstracts) reuse plain numbers that collide with PMIDs, so those
 * records are keyed `SRC:id` ("CBA:521529"). PubMed records keep the bare PMID;
 * PPR/PMC ids are already prefixed, and other non-numeric ids (AGR "IND…",
 * NBK…, patents) are unique across sources, so they stay as-is.
 */

import { defaultHttp, type AdapterHttp } from "./http.js";
import { RestAdapter } from "./base.js";
import { cleanDoi, first, splitAuthors, strArray, toIso1 } from "./util.js";
import type { Article, Correction, CorrectionType, SearchInput } from "../types.js";

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
  pubTypeList?: { pubType?: string | string[] };
  meshHeadingList?: { meshHeading?: { descriptorName?: string }[] };
  commentCorrectionList?: { commentCorrection?: { id?: string; source?: string; type?: string }[] };
}

/** Europe PMC link types → PubMed CommentsCorrections RefType names. */
const CORRECTION_TYPES: Record<string, CorrectionType> = {
  "retraction in": "RetractionIn",
  "expression of concern in": "ExpressionOfConcernIn",
  "erratum in": "ErratumIn",
  "update in": "UpdateIn",
};

function toCorrections(list: EpmcResult["commentCorrectionList"]): Correction[] {
  const out: Correction[] = [];
  for (const c of [list?.commentCorrection ?? []].flat()) {
    const type = CORRECTION_TYPES[(first(c?.type) ?? "").toLowerCase()];
    if (!type) continue;
    const id = first(c?.id);
    out.push({ type, ...(id ? { id: toEpmcId(first(c?.source) ?? "MED", id) } : {}) });
  }
  return out;
}

interface EpmcResponse {
  hitCount?: number;
  resultList?: { result?: EpmcResult[] };
}

/** The id we key a record on: `SRC:id` for numeric non-PubMed ids, the raw id otherwise. */
export function toEpmcId(source: string, id: string): string {
  return source !== "MED" && /^\d+$/.test(id) ? `${source}:${id}` : id;
}

/** Europe PMC query matching exactly the record behind an id produced by `toEpmcId` (any case). */
export function exactIdQuery(id: string): string {
  const prefixed = /^([A-Z]{3}):(\d+)$/i.exec(id);
  if (prefixed) return `EXT_ID:${prefixed[2]} AND SRC:${prefixed[1]!.toUpperCase()}`;
  if (/^PPR\d+$/i.test(id)) return `EXT_ID:${id.toUpperCase()} AND SRC:PPR`;
  if (/^PMC\d+$/i.test(id)) return `PMCID:${id.toUpperCase()}`;
  if (/^\d+$/.test(id)) return `EXT_ID:${id} AND SRC:MED`;
  // Non-numeric ids from other sources can't collide with a PMID, so no SRC clause.
  return `EXT_ID:"${id.replace(/"/g, "")}"`;
}

function toArticle(r: EpmcResult): Article | null {
  const rawId = first(r.id) ?? first(r.pmid);
  if (!rawId) return null;
  const source = first(r.source) ?? "MED";
  const id = toEpmcId(source, rawId);
  const doi = cleanDoi(first(r.doi));
  const language = toIso1(first(r.language)) ?? "en";
  const url =
    first(r.fullTextUrlList?.fullTextUrl?.[0]?.url) ?? `https://europepmc.org/article/${source}/${rawId}`;

  const article: Article = {
    pmid: id,
    title: (first(r.title) ?? "").replace(/\.$/, ""),
    authors: splitAuthors(r.authorString),
    journal: first(r.journalTitle) ?? "",
    pubDate: first(r.pubYear) ?? "",
    publicationTypes: strArray(r.pubTypeList?.pubType),
    database: "europepmc",
    url,
    language,
  };
  const abstract = first(r.abstractText);
  if (abstract) article.abstract = abstract;
  if (doi) article.doi = doi;
  const mesh = [r.meshHeadingList?.meshHeading ?? []].flat().map((h) => first(h?.descriptorName)).filter((m) => m != null);
  if (mesh.length > 0) article.meshHeadings = mesh;
  const corrections = toCorrections(r.commentCorrectionList);
  if (corrections.length > 0) article.corrections = corrections;
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

  constructor(http: AdapterHttp = defaultHttp({ source: "Europe PMC" })) {
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
    // A bare-id query is a full-text search for that number and returns unrelated
    // papers, so look the record up by EXT_ID + SRC and only accept an exact match.
    const params = new URLSearchParams({ query: exactIdQuery(id), format: "json", resultType: "core", pageSize: "1" });
    const data = await this.http.json<EpmcResponse>(`${BASE}?${params.toString()}`);
    const article = parseEuropePmc(data).articles[0];
    if (!article) return null;
    // A PMCID query returns the record under its PubMed id; anything else must match.
    return article.pmid.toUpperCase() === id.toUpperCase() || /^PMC\d+$/i.test(id) ? article : null;
  }
}
