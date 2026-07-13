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

export interface DatabaseAdapter {
  /** Unique identifier — "pubmed", "scielo", "cyberleninka", "europepmc", "chinaxiv", "jstage". */
  id: string;
  /** Human-readable name for logs and tool descriptions. */
  name: string;
  /** Execute a search and return matching ids + total count. */
  search(input: SearchInput): Promise<{ count: number; ids: string[] }>;
  /**
   * Fetch full metadata ({@link Article}[]) for one or more ids. Order is not
   * guaranteed; ids with no result are simply absent from the returned array.
   * The cache is scoped per-database (see {@link RestAdapter}).
   */
  fetch(ids: string[], cache: Cache): Promise<Article[]>;
}
