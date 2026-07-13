/**
 * Base class for the REST/HTML adapters (everything except PubMed, which reuses
 * the existing NcbiClient pipeline).
 *
 * These databases return full metadata straight from their search endpoint, so
 * an adapter's `search` parses complete `NcbiArticle`s and stashes them in a
 * small per-instance memo. Because the registry holds one long-lived adapter
 * instance per database, the subsequent `fetch(ids)` in the dispatch layer is a
 * memo hit — no second network round-trip. `fetch` also writes through to the
 * shared {@link Cache} under a database-scoped key ("{id}:{articleId}"), and
 * falls back to a best-effort single-record fetch when neither memo nor cache
 * has the id (e.g. a standalone `literature_fetch` in a cold process).
 */

import type { Cache } from "../cache.js";
import type { Article, SearchInput } from "../types.js";
import { defaultHttp, type AdapterHttp } from "./http.js";
import type { DatabaseAdapter } from "./types.js";

/** Bound on the per-instance memo so a long-running process can't grow it without limit. */
const MEMO_CAP = 1000;

export abstract class RestAdapter implements DatabaseAdapter {
  abstract readonly id: string;
  abstract readonly name: string;

  /** id → article, populated by `search` and read by `fetch` within a process. */
  private readonly memo = new Map<string, Article>();

  constructor(protected readonly http: AdapterHttp = defaultHttp()) {}

  abstract search(input: SearchInput): Promise<{ count: number; ids: string[] }>;

  /**
   * Fetch a single record by id when it's in neither the memo nor the cache.
   * Best-effort: return null when the database can't be queried by id alone.
   */
  protected abstract fetchOne(id: string): Promise<Article | null>;

  /** Database-scoped cache key. */
  protected cacheKey(id: string): string {
    return `${this.id}:${id}`;
  }

  /** Record parsed articles for later `fetch` calls in the same process. */
  protected remember(articles: Article[]): void {
    if (this.memo.size + articles.length > MEMO_CAP) this.memo.clear();
    for (const article of articles) this.memo.set(article.pmid, article);
  }

  async fetch(ids: string[], cache: Cache): Promise<Article[]> {
    const out: Article[] = [];
    for (const id of ids) {
      let article: Article | undefined =
        this.memo.get(id) ?? cache.getSummary(this.cacheKey(id)) ?? undefined;
      if (!article) {
        try {
          article = (await this.fetchOne(id)) ?? undefined;
        } catch {
          article = undefined;
        }
      }
      if (article) {
        cache.setSummary(this.cacheKey(id), article);
        out.push(article);
      }
    }
    return out;
  }
}
