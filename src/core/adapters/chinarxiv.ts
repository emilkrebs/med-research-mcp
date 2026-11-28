/**
 * ChinaXiv and RussiaRxiv records via the ChinaRxiv API.
 *
 * API: GET https://chinarxiv.org/api/v1/papers (spec: https://chinarxiv.org/api/openapi.json)
 *
 * ChinaRxiv is an independent project, not ChinaXiv, the Chinese Academy of
 * Sciences preprint platform, which publishes no API. One API serves one corpus
 * from several sites; the `source` parameter selects ChinaXiv preprints
 * (`chinaxiv`) or the Soviet-era Russian papers of SovietRxiv (`russiarxiv`).
 * Without it, a search mixes the corpora, so every request sets it.
 *
 * The spec's `source` enum has a third value, `crad`, "derived from the paper ID prefix", and says
 * "'chinaxiv' includes legacy unprefixed IDs" (checked 2026-11-16, https://chinarxiv.org/api/openapi.json;
 * the description of the API there names only chinaxiv and russiarxiv). No record has it: `/stats`
 * lists only chinaxiv (26,652 papers) and russiarxiv (25,456) under `by_source`, which add up to its
 * `total_papers` of 52,108; `/papers?q=clinical&source=crad&limit=2` answers 200 with total 0; and an
 * unknown `source` is a 422 "Must be one of: chinaxiv, russiarxiv, crad". Records carry `source` in
 * search results and in `/papers/{id}` alike. So `toArticle` reads a record as ChinaXiv when `source`
 * is absent or "chinaxiv", as RussiaRxiv when it is "russiarxiv", and drops any other: such a record
 * isn't one of these adapters', so it is never labeled ChinaXiv or given a chinarxiv.org item URL,
 * and `literature_fetch` reports its id as missing.
 *
 * "Most records are machine-translated; some are originally in English"
 * (chinarxiv.org, checked 2026-10-19). `source_language` names the original's
 * language, and `abstract_source: "machine_generated"` marks an abstract the
 * project wrote itself, as it did for almost all Soviet papers (see
 * russiarxiv.ts). Both reach the record (`machineTranslated`,
 * `machineGeneratedAbstract`), and the grader turns them into warning flags.
 * The records carry no DOI.
 *
 * Rate limits: 30 requests per minute anonymously, 300 with an X-API-Email
 * header, set from MED_RESEARCH_CHINAXIV_EMAIL, falling back to NCBI_EMAIL
 * (see chinaxivHeaders below).
 *
 * Full text: `GET /papers/{id}/text` returns `{ id, title, body_md, word_count }`, the
 * translated body as Markdown (with `<!-- source-page: 001 -->` markers), for ChinaXiv and
 * RussiaRxiv ids alike (`chinaxiv-YYYYMM.NNNNN`, `ru-YYYYMM.NNNNN`; an unprefixed id is a
 * 404). A record without full text gets 200 and an empty `body_md`; an unknown id gets 404.
 * `/stats` counts text for 26,428 of 26,652 ChinaXiv records and all 25,456 RussiaRxiv
 * records (2026-11-16). `literature_fulltext` reads it through {@link ChinaRxivApiAdapter.fetchText}.
 * Checked before using it, 2026-11-16: the OpenAPI spec describes the endpoint ("Returns the
 * translated body text in Markdown format") and states only the rate limits and a CC BY 4.0
 * licence; https://chinarxiv.org/llms.txt calls the archive "free, open-access", lists
 * `/papers/PAPER_ID/text` in its quickstart and says no authentication is required; chinarxiv.org
 * has no terms page (/about, /terms, /license and /privacy answer 404). Its robots.txt, Cloudflare's
 * managed block, says `Content-Signal: search=yes,ai-train=no,use=reference` and disallows named
 * AI training crawlers (including ClaudeBot and GPTBot). This client is no crawler: it reads
 * one record for a user's request, through the documented API, and trains nothing. `use=reference`
 * ("Index, excerpt, and link back", Cloudflare's managed robots.txt documentation) states
 * a preference for what a crawler keeps and reuses, so the texts are served and not kept past
 * the process (see fulltext.ts).
 *
 * The search endpoint cuts abstracts at 500 characters ("…outcome indic..."),
 * which often drops the Results of a long abstract. Search keeps those previews
 * (one request per search) and sets `abstractTruncated` on them; an explicit fetch
 * (`fetchFull`) loads the complete record from `/papers/{id}`, whose abstract has no
 * such mark. A cut abstract is exactly 500 characters, the first 497 of the whole one
 * followed by "..."; a complete one is shorter and doesn't end that way. Checked
 * 2026-11-16 on 437 search results (every abstract of 500 characters ended in "...";
 * the complete ones had 490, 276 and 225) and by comparing six previews with their
 * `/papers/{id}` abstracts (five cut ones: preview = whole[:497] + "..."; one complete).
 *
 * A search matches only records that contain every word of the query, in any
 * order, and reads AND and OR as words: "gut microbiota", "microbiota gut" and
 * "gut OR microbiota" each match 55 ChinaXiv records, "vitamin" 87 and
 * "depression" 229, but "vitamin depression" none (2026-10-20). An empty result
 * for a query of several words says so.
 *
 * Paging: the page size baked into a `next_cursor` overrides the request's `limit` (checked 2026-10-28).
 * A cursor is base64 of the page and its size (`{"page": 2, "per_page": 2}`), not server state,
 * so a remembered one stays valid and a failed request leaves it in place (2026-10-29).
 *
 * Journal: a RussiaRxiv record names its journal by a key (`publication`, "doklady_akademii_nauk_sssr"), and that is all a
 * search result has. `/papers/{id}` adds `publication_title` ("Doklady Akademii Nauk SSSR"), which the spec describes as
 * the "Canonical journal title". `/publications` lists every key with its title (`key`, `title`, `original_title`,
 * `publisher`, `country`, `paper_count`; "journals/publications with at least one translated paper"): on 2026-11-28 it
 * held 5, whose `paper_count`s add up to 25,456, all of RussiaRxiv's records, and the ChinaXiv records have no
 * `publication`. The titles are not the keys with capitals: "Izvestiya Tomskogo Politekhnicheskogo Instituta" is keyed
 * `izvestiya_tomskogo_politekhnicheskogo`, "Differentsial'nye Uravneniya" `differentsialnye_uravneniya`. So a search that
 * returns a record with a key and no title reads `/publications` (see {@link ChinaRxivApiAdapter.publicationTitles}),
 * and the record's `journal` is the title, as `literature_fetch` returns it. Where the list can't be read or lacks the
 * key, {@link readableJournal} writes the key as words.
 */

import { LRUCache } from "lru-cache";
import { defaultHttp, type AdapterHttp } from "./http.js";
import { RestAdapter } from "./base.js";
import { cleanAuthors, cleanDoi, first, isoDateBound, pageWindow, withoutPubMedTags } from "./util.js";
import type { Cache } from "../cache.js";
import { errors, isMedResearchError } from "../errors.js";
import type { Article, SearchInput } from "../types.js";
import { envSetting } from "../version.js";

const BASE = "https://chinarxiv.org/api/v1/papers";
const PUBLICATIONS = "https://chinarxiv.org/api/v1/publications";
const CURSOR_MEMO_MAX = 500;
const CURSOR_MEMO_TTL_MS = 60 * 60 * 1000;
/** Bound on the complete-record memo, like the base class's search memo. */
const FULL_CAP = 1000;
/** How long the journal titles are kept: the endpoint says `cache-control: public, max-age=3600`. */
const TITLES_TTL_MS = 60 * 60 * 1000;
/** How long after a failed or empty request the titles are not asked for again. */
const TITLES_RETRY_MS = 60 * 1000;

/** What earlier requests of one query learned: the cursor of each page by index, and the total. */
interface QueryPaging {
  cursors: Map<number, string>;
  total?: number;
}

/** The greatest page index up to `pageIndex` with a memoized cursor (page 0 needs none). */
function nearestPage(cursors: Map<number, string>, pageIndex: number): { index: number; cursor?: string } {
  let best: { index: number; cursor?: string } = { index: 0 };
  for (const [index, cursor] of cursors) {
    if (index <= pageIndex && index > best.index) best = { index, cursor };
  }
  return best;
}

/** The longest abstract the search endpoint returns: a longer one is cut to 497 characters and "...". */
const SEARCH_PREVIEW_CHARS = 500;

/** The corpora this adapter reads, by adapter id (also the API's `source` value). */
export type ChinaRxivCorpus = "chinaxiv" | "russiarxiv";

/** Where each corpus shows its English record pages (chinarxiv.org has no pages for `ru-` ids). */
const ITEM_PAGE: Record<ChinaRxivCorpus, string> = {
  chinaxiv: "https://chinarxiv.org/items/",
  russiarxiv: "https://sovietrxiv.org/items/",
};

/** The original language when ChinaRxiv names none; the API's filter counts legacy rows as "zh" too. */
const CORPUS_LANGUAGE: Record<ChinaRxivCorpus, string> = { chinaxiv: "zh", russiarxiv: "ru" };

/**
 * ChinaRxiv asks for an X-API-Email contact header; sending it raises the rate
 * limit from 30 to 300 requests per minute. MED_RESEARCH_CHINAXIV_EMAIL wins;
 * NCBI_EMAIL is a sensible fallback (both are contact emails).
 */
export function chinaxivHeaders(): Record<string, string> {
  // An empty MED_RESEARCH_CHINAXIV_EMAIL= (as in .env.example) still falls back.
  const email = envSetting("MED_RESEARCH_CHINAXIV_EMAIL", "NCBI_EMAIL");
  return email ? { "X-API-Email": email } : {};
}

type Record_ = Record<string, unknown>;

const NO_TITLES: ReadonlyMap<string, string> = new Map();

export interface PaperResponse {
  data?: Record_[];
  total?: number;
  limit?: number;
  next_cursor?: string | null;
}

/**
 * A journal key written as words, for a key the journal list doesn't have: underscores become spaces and each word is
 * capitalised ("doklady_akademii_nauk_sssr" becomes "Doklady Akademii Nauk Sssr"). It can't know an acronym ("SSSR") or a
 * name the key shortens, which is why the list's title is used when there is one. A value that isn't a key (it has a
 * capital, a space or a character outside a-z, 0-9 and underscores) is a name already and stays as it is.
 */
export function readableJournal(key: string): string {
  if (!/^[a-z0-9]+(?:_[a-z0-9]+)*$/.test(key)) return key;
  return key
    .split("_")
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(" ");
}

/** The journal a record names: its own title, else the title the journal list gives its key, else the key as words. */
function journalOf(r: Record_, titles: ReadonlyMap<string, string>): string | undefined {
  const title = first(r.publication_title);
  if (title) return title;
  const key = first(r.publication);
  return key ? (titles.get(key) ?? readableJournal(key)) : undefined;
}

/** Whether a record names its journal by the key alone, so that the title has to be looked up. */
function lacksJournalTitle(r: Record_): boolean {
  return Boolean(first(r.publication)) && !first(r.publication_title);
}

/**
 * One ChinaRxiv record (`PaperSummary` from search, `PaperDetail` from `/papers/{id}`) as an Article,
 * or null for a record without an id or of a source other than chinaxiv and russiarxiv (see the header).
 * `complete` says the record comes from `/papers/{id}`, whose abstract is never cut.
 */
function toArticle(r: Record_, complete: boolean, titles: ReadonlyMap<string, string>): Article | null {
  const id = first(r.id);
  if (!id) return null;
  // Absent, like a legacy row, is ChinaXiv; a source of another corpus (the spec lists "crad") is not ours.
  const source = first(r.source) ?? "chinaxiv";
  if (source !== "chinaxiv" && source !== "russiarxiv") return null;
  const corpus: ChinaRxivCorpus = source;
  // zh, en, ru, de, or "mixed" (Chinese with some English); none on legacy rows.
  const sourceLanguage = first(r.source_language);

  const article: Article = {
    id,
    title: (first(r.title) ?? "").replace(/\.$/, ""),
    authors: cleanAuthors(r.authors),
    journal: journalOf(r, titles) ?? (corpus === "chinaxiv" ? "ChinaXiv" : ""),
    pubDate: first(r.date) ?? "",
    publicationTypes: [],
    database: corpus,
    url: `${ITEM_PAGE[corpus]}${encodeURIComponent(id)}`,
    language: sourceLanguage && sourceLanguage !== "mixed" ? sourceLanguage : CORPUS_LANGUAGE[corpus],
  };
  const original = first(r.source_url);
  if (original) article.originalUrl = original;
  // Conservative: anything not detected as English counts as translated, "mixed" and legacy rows included.
  if (sourceLanguage !== "en") article.machineTranslated = true;
  const abstract = first(r.abstract);
  if (abstract) {
    article.abstract = abstract;
    // Only the search endpoint cuts: a complete abstract may end in "..." and run past 500 characters.
    if (!complete && abstract.length >= SEARCH_PREVIEW_CHARS && abstract.endsWith("...")) article.abstractTruncated = true;
    if (first(r.abstract_source) === "machine_generated") article.machineGeneratedAbstract = true;
  }
  // Not in the v1 schema; kept so a DOI, should records gain one, enables de-duplication and full text.
  const doi = cleanDoi(first(r.doi));
  if (doi) article.doi = doi;
  return article;
}

/**
 * @param options `complete`: the records come from `/papers/{id}`, not from a search, so none has a cut abstract.
 * `publicationTitles`: journal key to title (the `/publications` list), for a record that names its journal by the key alone.
 */
export function parsePapers(
  data: PaperResponse,
  options: { complete?: boolean; publicationTitles?: ReadonlyMap<string, string> } = {},
): { count: number; articles: Article[] } {
  const records = data?.data ?? [];
  const count = Number(data?.total ?? records.length);
  const articles: Article[] = [];
  for (const r of records) {
    const a = toArticle(r, options.complete ?? false, options.publicationTitles ?? NO_TITLES);
    if (a) articles.push(a);
  }
  return { count, articles };
}

/** One corpus of the ChinaRxiv API. Subclasses pick the corpus; everything else is shared. */
export abstract class ChinaRxivApiAdapter extends RestAdapter {
  protected abstract readonly corpus: ChinaRxivCorpus;
  /** Records carry no publication types: every one is `unknown`. */
  readonly designMetadata = false;

  constructor(http: AdapterHttp = defaultHttp({ headers: chinaxivHeaders(), source: "ChinaRxiv" })) {
    super(http);
  }

  /** The API `source` to search; the chinaxiv adapter reads `language: "ru"` as RussiaRxiv. */
  protected sourceFor(_input: SearchInput): ChinaRxivCorpus {
    return this.corpus;
  }

  /** Per query and page size: a cursor encodes its page size, so those never share cursors. */
  private readonly paging = new LRUCache<string, QueryPaging>({ max: CURSOR_MEMO_MAX, ttl: CURSOR_MEMO_TTL_MS });

  async search(input: SearchInput): Promise<{ count: number; ids: string[]; warning?: string }> {
    const { offset, size } = pageWindow(input);
    const pageIndex = offset / size;
    // PubMed field tags mean nothing here and would be searched as words.
    const q = withoutPubMedTags(input.query);
    const params = new URLSearchParams({ q, limit: String(size), source: this.sourceFor(input) });
    const from = isoDateBound(input.dateRange?.from, "from");
    const to = isoDateBound(input.dateRange?.to, "to");
    if (from) params.set("from_date", from);
    if (to) params.set("to_date", to);
    const key = params.toString();
    let paging = this.paging.get(key);
    if (!paging) this.paging.set(key, (paging = { cursors: new Map() }));
    const known = paging;

    const result = (count: number, ids: string[]) =>
      count === 0 && /\S\s+\S/.test(q)
        ? {
            count,
            ids,
            warning:
              `${this.name} matched nothing: it returns only records containing every word of the query and treats ` +
              `AND/OR as words. Try one or two key words.`,
            // Both corpora say this at once in a search of both: searchLiterature merges the two warnings.
            emptyReason: "every-word" as const,
          }
        : { count, ids };
    if (pageIndex > 0 && known.total !== undefined && offset >= known.total) return result(known.total, []);
    let { index, cursor } = nearestPage(known.cursors, pageIndex);
    const get = async (): Promise<PaperResponse> => {
      const withCursor = new URLSearchParams(params);
      if (cursor) withCursor.set("cursor", cursor);
      const data = await this.http.json<PaperResponse>(`${BASE}?${withCursor.toString()}`);
      if (data?.total != null) known.total = Number(data.total);
      return data;
    };
    while (index < pageIndex) {
      const walked = await get();
      if (!walked?.next_cursor || offset >= (known.total ?? Infinity)) return result(parsePapers(walked).count, []);
      cursor = walked.next_cursor;
      index += 1;
      known.cursors.set(index, cursor);
    }
    const data = await get();
    const parsed = parsePapers(data, { publicationTitles: await this.titlesFor(data?.data ?? []) });
    this.remember(parsed.articles);
    if (data?.next_cursor) known.cursors.set(pageIndex + 1, data.next_cursor);
    return result(parsed.count, parsed.articles.map((a) => a.id));
  }

  /** The journal titles by key, and until when they are kept (a failed request keeps an empty list for a short while). */
  private titles: { map: ReadonlyMap<string, string>; until: number } | undefined;
  private titlesLoading: Promise<ReadonlyMap<string, string>> | undefined;

  /**
   * Journal key to title, from `/publications`: one request, kept for an hour (TITLES_TTL_MS) and shared by searches that
   * run together. It never throws: a request that fails (a rate limit included) leaves the list empty for a minute, and
   * the records then get the key written as words (see {@link readableJournal}).
   */
  protected publicationTitles(): Promise<ReadonlyMap<string, string>> {
    if (this.titles && this.titles.until > Date.now()) return Promise.resolve(this.titles.map);
    this.titlesLoading ??= (async () => {
      try {
        const data = await this.http.json<{ publications?: { key?: unknown; title?: unknown }[] }>(PUBLICATIONS);
        const map = new Map<string, string>();
        for (const p of data?.publications ?? []) {
          const key = first(p?.key);
          const title = first(p?.title);
          if (key && title) map.set(key, title);
        }
        this.titles = { map, until: Date.now() + (map.size > 0 ? TITLES_TTL_MS : TITLES_RETRY_MS) };
      } catch {
        this.titles = { map: NO_TITLES, until: Date.now() + TITLES_RETRY_MS };
      } finally {
        this.titlesLoading = undefined;
      }
      return this.titles.map;
    })();
    return this.titlesLoading;
  }

  /** The journal titles when one of the records names its journal by the key alone; otherwise none, and no request. */
  private async titlesFor(records: readonly Record_[]): Promise<ReadonlyMap<string, string>> {
    return records.some(lacksJournalTitle) ? this.publicationTitles() : NO_TITLES;
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

  /**
   * The translated body of a record as Markdown, from `/papers/{id}/text`: the answer for a record
   * with full text is a JSON object with `body_md`. `null` when the API has none (it answers 200 with an
   * empty `body_md` for a record that lacks full text). It answers 404 for an unknown id, which is NOT_FOUND
   * here; any other failed request (the HTTP seam throws it as NETWORK_ERROR, 5xx and dropped connections
   * after its retries, or RATE_LIMIT) passes through, since it says nothing of the id. Reads one record by
   * an id the caller checked, on this adapter's own host and headers.
   */
  async fetchText(id: string): Promise<string | null> {
    let paper: { id?: unknown; body_md?: unknown };
    try {
      paper = await this.http.json<{ id?: unknown; body_md?: unknown }>(`${BASE}/${encodeURIComponent(id)}/text`);
    } catch (err) {
      throw isMedResearchError(err) && err.httpStatus === 404 ? errors.notFound(id, "ChinaRxiv") : err;
    }
    if (paper?.id !== undefined && paper.id !== id) return null;
    const body = typeof paper?.body_md === "string" ? paper.body_md.trim() : "";
    return body || null;
  }

  protected async fetchOne(id: string): Promise<Article | null> {
    // Exact lookup by id; a `q=` text search for the id can return a different paper.
    const record = await this.http.json<Record_>(`${BASE}/${encodeURIComponent(id)}`);
    const article = parsePapers({ data: [record] }, { complete: true, publicationTitles: await this.titlesFor([record]) }).articles[0];
    return article?.id === id ? article : null;
  }
}

/** ChinaXiv preprints. */
export class ChinaRXivAdapter extends ChinaRxivApiAdapter {
  readonly id = "chinaxiv";
  readonly name = "ChinaXiv (via ChinaRxiv)";
  protected readonly corpus = "chinaxiv";

  protected override sourceFor(input: SearchInput): ChinaRxivCorpus {
    return input.language === "ru" ? "russiarxiv" : "chinaxiv";
  }
}
