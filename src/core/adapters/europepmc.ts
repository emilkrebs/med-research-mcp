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
 * the query with PUB_TYPE, as the PubMed client does with [pt], and for `unknown` and the
 * trial designs below the RCT also with NOT PUB_TYPE (see excludedPublicationTypes).
 *
 * Links (`commentCorrectionList` of `core` results; the types we map are in CORRECTION_TYPES below):
 * a preprint with a published version has "Preprint of" with the article's id (source MED), and the
 * article "Preprint in" with the preprint's (source PPR); PubMed's own pairs come through as "Update in"
 * and "Update of". They become UpdateIn and UpdateOf, as PubMed names the preprint pair (see grader.ts for
 * the counts; checked 2026-11-16): PPR1312266 has `{source: "MED", id: "42905201", type: "Preprint of", note:
 * "CrossRef Pre-print loader"}`, and 42905201 `{source: "PPR", id: "PPR1312266", type: "Preprint in"}`.
 * `SRC:PPR AND HAS_PUBLISHED_VERSION:y AND tirzepatide` finds 57 preprints and `HAS_PREPRINT:y AND
 * tirzepatide AND SRC:MED` 179 articles. The `note` names the origin: "CrossRef Pre-print loader",
 * "Link created based on a title-first author match", or "Link created based on another matching version of
 * this preprint"; most links are matches, and we keep them all. Other types (seen: "Comment in", "Comment on") are dropped.
 *
 * Europe PMC matches bare words against full text: `tirzepatide apnea` finds 1,560 records and
 * `TITLE_ABS:tirzepatide AND TITLE_ABS:apnea` 142 (2026-11-16). A query written for PubMed therefore has
 * its field tags translated, by toEuropePmcQuery: [tiab] to TITLE_ABS, [ti] TITLE, [au] AUTH, [pt] PUB_TYPE,
 * [ta] JOURNAL, [la] LANG, [dp] FIRST_PDATE, E_PDATE and P_PDATE, [pmid] EXT_ID with SRC:MED, each compared
 * with PubMed's esearch on live counts (2026-11-16; the numbers are in util.ts). TITLE_ABS lacks the author
 * keywords that PubMed's [tiab] covers: it finds 91-95% of PubMed's records and none PubMed lacks. [mh] is
 * removed with every other tag: Europe PMC has no MeSH field, KW holds MeSH headings and author keywords,
 * and PubMed explodes a heading ("Sleep Apnea Syndromes"[mh] 50,220 records, KW 17,963). Europe PMC's
 * own field syntax passes through unchanged. A date range of a search is matched as a [dp] tag is (below): PubMed's
 * publication date matches the electronic and the print date, so PMID 39680131, online 2024-12-16 and in print
 * 2025-07-01, is found by 2024[dp] and by 2025[dp]; creatine[tiab] AND 2024[dp] finds 2,046 records in PubMed,
 * 1,777 with FIRST_PDATE alone and 1,990 with the three date fields (2026-11-16).
 *
 * `core` results name the journal in `journalInfo.journal.title` and a preprint's
 * server in `bookOrReportDetails.publisher`; `journalTitle` exists only in `lite`
 * results. The date is the issue date (`journalInfo.dateOfPublication`, "2026
 * Sep", like PubMed's), else the first publication date; recently added PMC
 * records have neither `pubYear` nor an issue date. `electronicPublicationDate`
 * becomes `epubDate`. A date range is matched against FIRST_PDATE, E_PDATE and P_PDATE, by
 * publicationDateClause, the clause of a [dp] tag: a record is found if its first, electronic or
 * print publication date is in the range. Record 39680131, published online 2024-12-16 and
 * in print 2025-07-01 (issue "2025 Jul"), matches FIRST_PDATE in December 2024 and P_PDATE in
 * July 2025 (2026-10-22); a range of 2025 finds it with the three fields and not with FIRST_PDATE
 * alone (2026-11-16). Preprints have FIRST_PDATE only, so a range matches them as it did.
 * A date sort is not changed by that: it orders by FIRST_PDATE, the earlier of the two dates, as
 * the merged results are, so a search of a range with sort "date" can list a record first
 * published before the range, sorted by that earlier date, as PubMed's can. Sorted by P_PDATE,
 * `semaglutide AND SRC:MED` led with an issue of January 2027 published online in
 * August 2026, and records published online on 2026-10-20 didn't make the first page
 * (2026-10-22).
 *
 * Titles and abstracts carry HTML (`<h4>` section headings, `<sup>`, `<i>`), titles
 * of MEDLINE records sometimes escaped (`&lt;i&gt;`); both are turned into text.
 *
 * Paging: the API ignores `page`; only `cursorMark` pages, also with a sort (checked 2026-10-28).
 * A `cursorMark` is Solr's: base64 of sort values (a score and a document key), not server
 * state, so a remembered one stays valid and a failed request leaves it in place. One the API
 * can't read gets HTTP 503 "temporarily unavailable", like an outage (2026-10-29).
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
import { canonicalPmid, cleanDoi, first, isoDateBound, pageWindow, publicationDateClause, splitAuthors, strArray, toEuropePmcQuery, toIso1 } from "./util.js";
import { designPublicationTypes, excludedPublicationTypes } from "../grader.js";
import { STUDY_TYPES } from "../types.js";
import { htmlToText } from "../text.js";
import type { Article, Correction, CorrectionType, SearchInput, StudyType } from "../types.js";

const BASE = "https://www.ebi.ac.uk/europepmc/webservices/rest/search";
const CURSOR_MEMO_MAX = 500;
const CURSOR_MEMO_TTL_MS = 60 * 60 * 1000;
/** The most ids an `idlist` request returns. */
const WALK_PAGE_SIZE = 1000;

/**
 * Europe PMC matches `PUB_TYPE:"x"` as a run of words (any case, punctuation splitting words) in any type string of a
 * record. A record carries more than NLM's types: PMC records and MEDLINE records not yet indexed have the publisher's
 * JATS article type too ("systematic-review", "review-article", "product-review", ...), which the classifier, comparing
 * whole NLM strings, gives no design. An exclusion of a design tag whose words one of them holds would drop such records
 * although the filter keeps them: `unknown` loses a Cochrane review typed only `["systematic-review", "Journal Article"]`
 * (PMID 42803656), and `clinical-trial` a record typed `["Clinical Trial", "systematic-review", "Journal Article"]`
 * (PMID 32895128), which classifies as a clinical trial (2026-11-28: `PUB_TYPE:"systematic-review" AND NOT
 * PUB_TYPE:"Systematic Review"` and `PUB_TYPE:"review-article" AND NOT PUB_TYPE:"Review"` find none). These are the
 * strings of that kind: the JATS article types (https://jats.nlm.nih.gov/publishing/tag-library/1.3/attribute/article-type.html,
 * checked 2026-11-28) and the other type strings sampled from Europe PMC that hold the words of a design tag but are none,
 * among them NLM's Clinical Trial Protocol, Book Review and Scientific Integrity Review. The sample is not the whole index,
 * so a string of this kind that no record of it showed could still match: the post-filter drops the records such an
 * exclusion lets through, and says so, while one it wrongly drops is lost.
 */
const OTHER_TYPES: readonly string[] = [
  // NLM publication types that are no design (not in the classifier's design tags)
  "Clinical Trial Protocol",
  "Book Review",
  "Scientific Integrity Review",
  // JATS article types and other publisher strings
  "book-review",
  "product-review",
  "review-article",
  "systematic-review",
];

/** The words of a type string or tag name: lower case, split at anything that is not a letter or a digit. */
const typeWords = (type: string): string[] => type.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);

/** Whether Europe PMC's phrase search for the name `name` finds the type string `type`: its words are a run of the string's. */
function phraseFinds(name: string, type: string): boolean {
  const hay = typeWords(type);
  const needle = typeWords(name);
  return hay.some((_, i) => needle.every((word, j) => hay[i + j] === word));
}

/** The publication types Europe PMC is asked to leave out for a filter: {@link excludedPublicationTypes}, less those it can't phrase. */
export function excludedOnEuropePmc(studyTypes?: readonly StudyType[], minDesignTier?: number): string[] {
  const everyDesign = designPublicationTypes(STUDY_TYPES.filter((t) => t !== "unknown")) ?? [];
  let names = excludedPublicationTypes(studyTypes, minDesignTier).filter((name) => !OTHER_TYPES.some((type) => phraseFinds(name, type)));
  // A phrase also finds the longer design names that hold it ("Meta-Analysis" finds "Network Meta-Analysis"): when one of
  // those is not excluded, the phrase can't be either, as it would take the records of a design the filter keeps.
  for (let before = -1; before !== names.length; ) {
    before = names.length;
    names = names.filter((name) => everyDesign.every((other) => other === name || !phraseFinds(name, other) || names.includes(other)));
  }
  return names;
}

/**
 * The tag a filter asks for. "Clinical Trial" is asked for less the protocols, which are most of what it finds on a topic
 * with few trials: 7 of the 10 records of `tirzepatide apnea` for clinical-trial were protocols (2026-11-27). That loses no
 * record the filter keeps: no protocol carries the tag itself (PubMed: none of the 24,577 `"Clinical Trial Protocol"[pt:noexp]`
 * records has `"Clinical Trial"[pt:noexp]`, and all 24,574 protocols of Europe PMC are MEDLINE records), and the other trial
 * types are asked for by clauses of their own.
 */
function includeType(type: string): string {
  return type === "Clinical Trial" ? `(PUB_TYPE:"Clinical Trial" AND NOT PUB_TYPE:"Clinical Trial Protocol")` : `PUB_TYPE:"${type}"`;
}

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
  /** `type` is a link type ("Retraction in", "Preprint of", …); `source` and `id` name the record linked. */
  commentCorrectionList?: { commentCorrection?: { id?: string; source?: string; type?: string; note?: string }[] };
}

/**
 * Europe PMC link types (lower case) → PubMed CommentsCorrections RefType names. "Preprint of" and
 * "Preprint in" are Europe PMC's names for what PubMed calls UpdateIn (the preprint, linking its published
 * article) and UpdateOf (the article, linking its preprint); see the header.
 */
const CORRECTION_TYPES: Record<string, CorrectionType> = {
  "retraction in": "RetractionIn",
  "expression of concern in": "ExpressionOfConcernIn",
  "erratum in": "ErratumIn",
  "update in": "UpdateIn",
  "preprint of": "UpdateIn",
  "update of": "UpdateOf",
  "preprint in": "UpdateOf",
};

function toCorrections(list: EpmcResult["commentCorrectionList"]): Correction[] {
  const out: Correction[] = [];
  for (const c of [list?.commentCorrection ?? []].flat()) {
    const type = CORRECTION_TYPES[(first(c?.type) ?? "").toLowerCase()];
    if (!type) continue;
    const id = first(c?.id);
    const link: Correction = { type, ...(id ? { id: toEpmcId(first(c?.source) ?? "MED", id) } : {}) };
    // Europe PMC types that map to one RefType may name one link twice.
    if (!out.some((o) => o.type === link.type && o.id === link.id)) out.push(link);
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
    id,
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

  private buildQuery(input: SearchInput, types: string[] | null, excluded: string[]): string {
    // A PubMed field tag would be searched as a word: translated into the field that holds the same, or removed.
    const query = toEuropePmcQuery(input.query);
    const clauses: string[] = [];
    if (types) clauses.push(`(${types.map(includeType).join(" OR ")})`);
    const from = isoDateBound(input.dateRange?.from, "from");
    const to = isoDateBound(input.dateRange?.to, "to");
    // The date clause comes in parentheses from its helper (it is an OR of three fields), so it is not wrapped again.
    if (from || to) clauses.push(publicationDateClause(from ?? "1900-01-01", to ?? "3000-01-01"));
    if (excluded.length > 0) clauses.push(`NOT (${excluded.map((t) => `PUB_TYPE:"${t}"`).join(" OR ")})`);
    // Each clause and the query are in parentheses, so that a clause filters the whole query and not just the last operand of an OR in it.
    return clauses.length > 0 ? [`(${query})`, ...clauses].join(" AND ") : query;
  }

  private readonly paging = new LRUCache<string, QueryPaging>({ max: CURSOR_MEMO_MAX, ttl: CURSOR_MEMO_TTL_MS });

  async search(input: SearchInput): Promise<{ count: number; ids: string[] }> {
    const types = designPublicationTypes(input.studyTypes, input.minDesignTier);
    if (types?.length === 0) return { count: 0, ids: [] };
    const { offset, size } = pageWindow(input);
    const excluded = excludedOnEuropePmc(input.studyTypes, input.minDesignTier);
    const base = new URLSearchParams({ query: this.buildQuery(input, types, excluded), format: "json" });
    if (input.sort === "date") base.set("sort", "FIRST_PDATE_D desc");
    const key = base.toString();
    let paging = this.paging.get(key);
    if (!paging) this.paging.set(key, (paging = { cursors: new Map() }));
    const known = paging;

    if (offset > 0 && known.count !== undefined && offset >= known.count) return { count: known.count, ids: [] };
    let { position, cursor } = nearestCursor(known.cursors, offset);
    const get = async (resultType: string, pageSize: number): Promise<EpmcResponse> => {
      const params = new URLSearchParams(base);
      params.set("resultType", resultType);
      params.set("pageSize", String(pageSize));
      params.set("cursorMark", cursor);
      const data = await this.http.json<EpmcResponse>(`${BASE}?${params.toString()}`);
      if (data?.hitCount != null) known.count = Number(data.hitCount);
      return data;
    };
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
    return { count, ids: articles.map((a) => a.id) };
  }

  /**
   * A PMID as the bare number its MEDLINE records are keyed on, any other id in capitals: Europe PMC looks ids up
   * ignoring case ("pmc6181682", "ppr270079", "cba:644599", "ind609546324" each find their record; 2026-11-28)
   * and writes its own in capitals (none of the up to 100 ids sampled per source from PAT, AGR, CTX, ETH, CBA, PMC
   * and PPR had a lower-case letter). So two spellings of an id are one, and a PMCID or `SRC:id` has the form returned.
   */
  normalizeId(id: string): string {
    const pmid = canonicalPmid(id);
    return /^\d+$/.test(pmid) ? pmid : pmid.toUpperCase();
  }

  protected async fetchOne(id: string): Promise<Article | null> {
    // A bare-id query is a full-text search for that number and returns unrelated
    // papers, so look the record up by EXT_ID + SRC and only accept an exact match.
    const params = new URLSearchParams({ query: exactIdQuery(id), format: "json", resultType: "core", pageSize: "1" });
    const data = await this.http.json<EpmcResponse>(`${BASE}?${params.toString()}`);
    const article = parseEuropePmc(data).articles[0];
    if (!article) return null;
    // A PMCID query returns the record under its PubMed id; anything else must match.
    return article.id.toUpperCase() === id.toUpperCase() || /^PMC\d+$/i.test(id) ? article : null;
  }
}
