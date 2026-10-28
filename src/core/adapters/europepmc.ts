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
 * preprints are tagged "Preprint". A studyTypes or minDesignTier filter narrows
 * the query with PUB_TYPE, as the PubMed client does with [pt].
 *
 * `core` results name the journal in `journalInfo.journal.title` and a preprint's
 * server in `bookOrReportDetails.publisher`; `journalTitle` exists only in `lite`
 * results. The date is the issue date (`journalInfo.dateOfPublication`, "2026
 * Sep", like PubMed's), else the first publication date; recently added PMC
 * records have neither `pubYear` nor an issue date. `electronicPublicationDate`
 * becomes `epubDate`. A date range is matched against FIRST_PDATE, the earlier of
 * the two: record 39680131, published online 2024-12-16 and in print 2025-07-01,
 * matches FIRST_PDATE in December 2024 and P_PDATE in July 2025 (2026-10-22). A
 * date sort orders by FIRST_PDATE too, as the merged results are: sorted by P_PDATE,
 * `semaglutide AND SRC:MED` led with an issue of January 2027 published online in
 * August 2026, and records published online on 2026-10-20 didn't make the first page
 * (2026-10-22).
 *
 * Titles and abstracts carry HTML (`<h4>` section headings, `<sup>`, `<i>`), titles
 * of MEDLINE records sometimes escaped (`&lt;i&gt;`); both are turned into text.
 *
 * Paging: the API ignores `page`; only `cursorMark` pages, also with a sort (checked 2026-10-28).
 *
 * Ids are only unique within a source: non-PubMed sources such as CBA (Chinese
 * Biological Abstracts) reuse plain numbers that collide with PMIDs, so those
 * records are keyed `SRC:id` ("CBA:521529"). PubMed records keep the bare PMID;
 * PPR/PMC ids are already prefixed, and other non-numeric ids (AGR "IND…",
 * NBK…, patents) are unique across sources, so they stay as-is.
 */

import { LRUCache } from "lru-cache";
import { defaultHttp, type AdapterHttp } from "./http.js";
import { RestAdapter } from "./base.js";
import { cleanDoi, first, isoDateBound, pageWindow, splitAuthors, strArray, toIso1, withoutPubMedTags } from "./util.js";
import { designPublicationTypes } from "../grader.js";
import { htmlToText } from "../text.js";
import type { Article, Correction, CorrectionType, SearchInput } from "../types.js";

const BASE = "https://www.ebi.ac.uk/europepmc/webservices/rest/search";
const CURSOR_MEMO_MAX = 500;
const CURSOR_MEMO_TTL_MS = 60 * 60 * 1000;
/** The most ids an `idlist` request returns. */
const WALK_PAGE_SIZE = 1000;

/** What earlier requests of one query learned: the `cursorMark` at each position, and the hit count. */
interface QueryPaging {
  cursors: Map<number, string>;
  count?: number;
}

/** The cursor at the greatest memoized position up to `offset` (position 0 is `*`). */
function nearestCursor(cursors: Map<number, string>, offset: number): { position: number; cursor: string } {
  let best = { position: 0, cursor: "*" };
  for (const [position, cursor] of cursors) {
    if (position <= offset && position > best.position) best = { position, cursor };
  }
  return best;
}

interface EpmcResult {
  id?: string;
  source?: string;
  pmid?: string;
  pmcid?: string;
  doi?: string;
  title?: string;
  authorString?: string;
  /** `lite` results only. */
  journalTitle?: string;
  journalInfo?: { journal?: { title?: string }; dateOfPublication?: string };
  /** Preprints: the server, e.g. "medRxiv". */
  bookOrReportDetails?: { publisher?: string };
  pubYear?: string;
  firstPublicationDate?: string;
  electronicPublicationDate?: string;
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
  nextCursorMark?: string;
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
    title: htmlToText(first(r.title) ?? "").replace(/\.$/, ""),
    authors: splitAuthors(r.authorString),
    journal:
      first(r.journalTitle) ?? first(r.journalInfo?.journal?.title) ?? first(r.bookOrReportDetails?.publisher) ?? "",
    pubDate: first(r.journalInfo?.dateOfPublication) ?? first(r.firstPublicationDate) ?? first(r.pubYear) ?? "",
    publicationTypes: strArray(r.pubTypeList?.pubType),
    database: "europepmc",
    url,
    language,
  };
  const abstract = htmlToText(first(r.abstractText) ?? "");
  if (abstract) article.abstract = abstract;
  const epubDate = first(r.electronicPublicationDate);
  if (epubDate) article.epubDate = epubDate;
  if (doi) article.doi = doi;
  const pmcid = first(r.pmcid);
  if (pmcid && /^PMC\d+$/i.test(pmcid)) article.pmcid = pmcid.toUpperCase();
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

  private buildQuery(input: SearchInput, types: string[] | null): string {
    // PubMed field tags mean nothing here and would be searched as words.
    let query = withoutPubMedTags(input.query);
    if (types) query = `(${query}) AND (${types.map((t) => `PUB_TYPE:"${t}"`).join(" OR ")})`;
    const from = isoDateBound(input.dateRange?.from, "from");
    const to = isoDateBound(input.dateRange?.to, "to");
    if (from || to) {
      query += ` AND (FIRST_PDATE:[${from ?? "1900-01-01"} TO ${to ?? "3000-01-01"}])`;
    }
    return query;
  }

  private readonly paging = new LRUCache<string, QueryPaging>({ max: CURSOR_MEMO_MAX, ttl: CURSOR_MEMO_TTL_MS });

  async search(input: SearchInput): Promise<{ count: number; ids: string[] }> {
    const types = designPublicationTypes(input.studyTypes, input.minDesignTier);
    if (types?.length === 0) return { count: 0, ids: [] };
    const { offset, size } = pageWindow(input);
    const base = new URLSearchParams({ query: this.buildQuery(input, types), format: "json" });
    if (input.sort === "date") base.set("sort", "FIRST_PDATE_D desc");
    const key = base.toString();
    let paging = this.paging.get(key);
    if (!paging) this.paging.set(key, (paging = { cursors: new Map() }));
    const known = paging;

    for (let retry = true; ; retry = false) {
      if (offset > 0 && known.count !== undefined && offset >= known.count) return { count: known.count, ids: [] };
      let { position, cursor } = nearestCursor(known.cursors, offset);
      // Only a cursor from an earlier request can have gone stale.
      let stale = position > 0 ? position : undefined;
      const get = async (resultType: string, pageSize: number): Promise<EpmcResponse> => {
        const params = new URLSearchParams(base);
        params.set("resultType", resultType);
        params.set("pageSize", String(pageSize));
        params.set("cursorMark", cursor);
        const data = await this.http.json<EpmcResponse>(`${BASE}?${params.toString()}`);
        stale = undefined;
        if (data?.hitCount != null) known.count = Number(data.hitCount);
        return data;
      };
      try {
        while (position < offset) {
          const step = Math.min(WALK_PAGE_SIZE, offset - position);
          const data = await get("idlist", step);
          const got = data?.resultList?.result?.length ?? 0;
          const next = data?.nextCursorMark;
          if (got < step || !next || next === cursor || offset >= (known.count ?? Infinity)) {
            return { count: known.count ?? 0, ids: [] };
          }
          position += got;
          cursor = next;
          known.cursors.set(position, cursor);
        }
        const data = await get("core", size);
        const { count, articles } = parseEuropePmc(data);
        this.remember(articles);
        const next = data?.nextCursorMark;
        if (next && next !== cursor) known.cursors.set(offset + (data?.resultList?.result?.length ?? 0), next);
        return { count, ids: articles.map((a) => a.pmid) };
      } catch (error) {
        if (stale === undefined || !retry) throw error;
        known.cursors.delete(stale);
      }
    }
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
