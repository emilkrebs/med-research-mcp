/**
 * PubMed adapter — a thin wrapper over the existing NcbiClient pipeline.
 *
 * `search` delegates to `esearch` and `fetch` delegates to `fetchPubMed`,
 * which already handle esummary + efetch, caching, and abstract backfill.
 * PubMed articles are left with `database` unset — the library treats an absent
 * `database` as "pubmed".
 */

import type { Cache } from "../cache.js";
import { ESEARCH_LIMIT, fetchPubMed, NcbiClient } from "../pubmed.js";
import type { Article, SearchInput } from "../types.js";
import type { DatabaseAdapter } from "./types.js";
import { pageWindow } from "./util.js";

export class PubMedAdapter implements DatabaseAdapter {
  readonly id = "pubmed";
  readonly name = "PubMed / NCBI";
  private readonly client: NcbiClient;

  /** Accepts a shared NcbiClient so its rate limiter is not duplicated. */
  constructor(client: NcbiClient = new NcbiClient()) {
    this.client = client;
  }

  async search(input: SearchInput): Promise<{ count: number; ids: string[]; warning?: string; more: boolean }> {
    const { count, pmids, warning } = await this.client.esearch(input);
    const { offset, size } = pageWindow(input);
    const end = offset + size;
    return { count, ids: pmids, ...(warning ? { warning } : {}), more: count > end && end < ESEARCH_LIMIT };
  }

  async fetch(ids: string[], cache: Cache, warn?: (warning: string) => void): Promise<Article[]> {
    if (ids.length === 0) return [];
    const { articles, warnings } = await fetchPubMed({ ids }, cache, this.client);
    for (const warning of warnings ?? []) warn?.(warning);
    return articles;
  }
}
