/**
 * PubMed adapter — a thin wrapper over the existing NcbiClient pipeline.
 *
 * `search` delegates to `esearch` and `fetch` delegates to `fetchPubMed`,
 * which already handle esummary + efetch, caching, and abstract backfill.
 * PubMed articles are left with `database` unset — the library treats an absent
 * `database` as "pubmed".
 */

import type { Cache } from "../cache.js";
import { fetchPubMed, NcbiClient } from "../pubmed.js";
import type { Article, SearchInput } from "../types.js";
import type { DatabaseAdapter } from "./types.js";

export class PubMedAdapter implements DatabaseAdapter {
  readonly id = "pubmed";
  readonly name = "PubMed / NCBI";
  private readonly client: NcbiClient;

  /** Accepts a shared NcbiClient so its rate limiter is not duplicated. */
  constructor(client: NcbiClient = new NcbiClient()) {
    this.client = client;
  }

  async search(input: SearchInput): Promise<{ count: number; ids: string[] }> {
    const { count, pmids } = await this.client.esearch(input);
    return { count, ids: pmids };
  }

  async fetch(ids: string[], cache: Cache): Promise<Article[]> {
    if (ids.length === 0) return [];
    const { articles } = await fetchPubMed({ ids }, cache, this.client);
    return articles;
  }
}
