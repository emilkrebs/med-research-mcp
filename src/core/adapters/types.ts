/**
 * The contract every database adapter implements.
 *
 * An adapter is a thin translator between one scientific database's API and the
 * library's shared `NcbiArticle` shape. `search` returns database-specific ids
 * plus a total; `fetch` turns ids into full metadata. The dispatch layer
 * (`literature.ts`) grades, merges, and de-duplicates whatever the adapters
 * return — so an adapter never grades or knows about other databases.
 */

import type { Cache } from "../cache.js";
import type { Article, SearchInput } from "../types.js";

/**
 * Why a database found nothing, when its own query rules likely explain it. Databases that report the same
 * reason in one search share a single warning (see `searchLiterature`), so that a reader is not told twice.
 * `every-word`: the database returns only records containing every word of the query, and reads AND and OR as words.
 */
export type EmptyReason = "every-word";

/** What {@link DatabaseAdapter.search} returns. */
export interface AdapterSearchResult {
  count: number;
  ids: string[];
  /** Set when the database's own query rules likely explain an empty result. */
  warning?: string;
  /** The cause behind `warning`, for databases to be grouped by; absent for a warning that is the database's alone. */
  emptyReason?: EmptyReason;
  /** False when no later page can be served although `count` goes on; absent, `count` decides. */
  more?: boolean;
}

export interface DatabaseAdapter {
  /** Unique identifier — "pubmed", "europepmc", "chinaxiv", "russiarxiv". */
  id: string;
  /** Human-readable name for logs and tool descriptions. */
  name: string;
  /**
   * False when the database's records never carry NLM publication types, so every
   * one is `unknown` and a design filter (studyTypes, minDesignTier) keeps none of
   * them. Absent means they can carry them.
   */
  designMetadata?: boolean;
  /**
   * The ISO 639-1 codes of a search's `language` that this database acts on, because its records are split by language
   * (ChinaXiv's "ru" selects the Russian collection; every RussiaRxiv record is Russian). Any other code is not applied
   * here, and the search says so in a warning. Absent: the database ignores `language`.
   */
  languages?: readonly string[];
  /**
   * Execute a search and return the ids of the page asked for (`page`, `maxResults`) + total count,
   * and a warning when the database's own query rules likely explain an empty result. `more` is
   * false when no later page can be served although `count` goes on; absent, `count` decides.
   */
  search(input: SearchInput): Promise<AdapterSearchResult>;
  /**
   * Fetch full metadata ({@link Article}[]) for one or more ids. Order is not
   * guaranteed; ids with no result are simply absent from the returned array.
   * The cache is scoped per-database (see {@link RestAdapter}). `warn` receives a
   * warning for records returned incomplete, such as PubMed records without their
   * abstract and MeSH headings when efetch failed.
   */
  fetch(ids: string[], cache: Cache, warn?: (warning: string) => void): Promise<Article[]>;
  /**
   * The id in the form this database keys its records on, for the ids a caller typed by hand ("PMID:9500320" and
   * "00012345" for "9500320"). `fetchLiterature` applies it, so `fetch` only ever gets canonical ids, and so that two
   * spellings of one id fetch (and come back) once. It compares ids exactly, so folding case is the adapter's job,
   * and only where its database ignores case: Europe PMC does ("ppr12345", "pmc6181682"), ChinaRxiv doesn't.
   * Absent, an id is already canonical.
   */
  normalizeId?(id: string): string;
  /**
   * Complete records for an explicit fetch (`literature_fetch`), for databases
   * whose search endpoint only returns previews (e.g. ChinaXiv cuts abstracts at
   * 500 characters). `search` keeps using `fetch` and its cheap previews; when
   * absent, `fetch` already returns complete records.
   */
  fetchFull?(ids: string[], cache: Cache): Promise<Article[]>;
}
