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
 * The search endpoint cuts abstracts at 500 characters ("…outcome indic..."),
 * which often drops the Results of a long abstract. Search keeps those previews
 * (one request per search); an explicit fetch (`fetchFull`) loads the complete
 * record from `/papers/{id}`.
 */

import { defaultHttp, type AdapterHttp } from "./http.js";
import { RestAdapter } from "./base.js";
import { cleanDoi, first, strArray } from "./util.js";
import type { Cache } from "../cache.js";
import type { Article, SearchInput } from "../types.js";

const BASE = "https://chinarxiv.org/api/v1/papers";
const MAX_RESULTS_CAP = 50;
/** Bound on the complete-record memo, like the base class's search memo. */
const FULL_CAP = 1000;

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
  // `||` so an empty MED_RESEARCH_CHINAXIV_EMAIL= (as in .env.example) still falls back.
  const email = process.env.MED_RESEARCH_CHINAXIV_EMAIL?.trim() || process.env.NCBI_EMAIL?.trim();
  return email ? { "X-API-Email": email } : {};
}

type Record_ = Record<string, unknown>;

export interface PaperResponse {
  data?: Record_[];
  total?: number;
  limit?: number;
  next_cursor?: string | null;
}

/** One ChinaRxiv record (`PaperSummary` from search, `PaperDetail` from `/papers/{id}`) as an Article. */
function toArticle(r: Record_): Article | null {
  const id = first(r.id);
  if (!id) return null;
  const corpus: ChinaRxivCorpus = first(r.source) === "russiarxiv" ? "russiarxiv" : "chinaxiv";
  // zh, en, ru, de, or "mixed" (Chinese with some English); none on legacy rows.
  const sourceLanguage = first(r.source_language);

  const article: Article = {
    pmid: id,
    title: (first(r.title) ?? "").replace(/\.$/, ""),
    authors: strArray(r.authors),
    journal: first(r.publication_title) ?? first(r.publication) ?? (corpus === "chinaxiv" ? "ChinaXiv" : ""),
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
    if (first(r.abstract_source) === "machine_generated") article.machineGeneratedAbstract = true;
  }
  // Not in the v1 schema; kept so a DOI, should records gain one, enables de-duplication and full text.
  const doi = cleanDoi(first(r.doi));
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

/** One corpus of the ChinaRxiv API. Subclasses pick the corpus; everything else is shared. */
export abstract class ChinaRxivApiAdapter extends RestAdapter {
  protected abstract readonly corpus: ChinaRxivCorpus;

  constructor(http: AdapterHttp = defaultHttp({ headers: chinaxivHeaders(), source: "ChinaRxiv" })) {
    super(http);
  }

  /** The API `source` to search; the chinaxiv adapter reads `language: "ru"` as RussiaRxiv. */
  protected sourceFor(_input: SearchInput): ChinaRxivCorpus {
    return this.corpus;
  }

  async search(input: SearchInput): Promise<{ count: number; ids: string[] }> {
    const limit = Math.min(Math.max(input.maxResults ?? 10, 1), MAX_RESULTS_CAP);
    const params = new URLSearchParams({ q: input.query, limit: String(limit), source: this.sourceFor(input) });
    if (input.dateRange?.from) params.set("from_date", input.dateRange.from);
    if (input.dateRange?.to) params.set("to_date", input.dateRange.to);

    const data = await this.http.json<PaperResponse>(`${BASE}?${params.toString()}`);
    const parsed = parsePapers(data);
    this.remember(parsed.articles);
    return { count: parsed.count, ids: parsed.articles.map((a) => a.pmid) };
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

  protected async fetchOne(id: string): Promise<Article | null> {
    // Exact lookup by id; a `q=` text search for the id can return a different paper.
    const record = await this.http.json<Record_>(`${BASE}/${encodeURIComponent(id)}`);
    const article = parsePapers({ data: [record] }).articles[0];
    return article?.pmid === id ? article : null;
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
