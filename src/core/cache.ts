/**
 * Cache interface + backends.
 *
 * The interface is what the rest of the library depends on; backends are
 * swappable. v0.1.0 ships the in-memory LRU backend. SQLite (survives restarts,
 * used by Biohacking-IDE) is deferred to v0.2 and throws if requested.
 */

import { LRUCache } from "lru-cache";
import type { FulltextData, NcbiArticle } from "./types.js";

/** Full texts expire after 30 days — the paper is stable but resolved OA URLs rot. */
export const FULLTEXT_TTL_MS = 30 * 24 * 60 * 60 * 1000;

export interface Cache {
  getSummary(pmid: string): NcbiArticle | null;
  setSummary(pmid: string, article: NcbiArticle): void;
  getAbstract(pmid: string): string | null;
  setAbstract(pmid: string, abstract: string): void;
  /** Returns a cached full text, or null on a miss or if older than {@link FULLTEXT_TTL_MS}. */
  getFulltext(pmid: string): FulltextData | null;
  setFulltext(pmid: string, data: FulltextData): void;
}

export type CacheBackend = "memory" | "sqlite";

export interface CacheOptions {
  backend: CacheBackend;
  /** Max entries per store for the memory backend. Default 200. */
  max?: number;
  /** Filesystem path for the sqlite backend (v0.2). */
  path?: string;
}

/**
 * In-memory LRU cache. Dies with the process — right for short-lived agent
 * sessions. Summaries and abstracts are immutable (papers don't change) so
 * there's no TTL here; the LRU bound alone keeps memory in check.
 */
export class LRUBackend implements Cache {
  private readonly summaries: LRUCache<string, NcbiArticle>;
  private readonly abstracts: LRUCache<string, string>;
  private readonly fulltexts: LRUCache<string, FulltextData>;

  constructor(max = 200) {
    this.summaries = new LRUCache({ max });
    this.abstracts = new LRUCache({ max });
    // The LRU's own TTL evicts stale entries; getFulltext double-checks fetchedAt
    // so a caller-supplied stale timestamp is also honored.
    this.fulltexts = new LRUCache({ max, ttl: FULLTEXT_TTL_MS });
  }

  getSummary(pmid: string): NcbiArticle | null {
    return this.summaries.get(pmid) ?? null;
  }

  setSummary(pmid: string, article: NcbiArticle): void {
    this.summaries.set(pmid, article);
  }

  getAbstract(pmid: string): string | null {
    return this.abstracts.get(pmid) ?? null;
  }

  setAbstract(pmid: string, abstract: string): void {
    this.abstracts.set(pmid, abstract);
  }

  getFulltext(pmid: string): FulltextData | null {
    const data = this.fulltexts.get(pmid);
    if (!data) return null;
    if (Date.now() - data.fetchedAt > FULLTEXT_TTL_MS) {
      this.fulltexts.delete(pmid);
      return null;
    }
    return data;
  }

  setFulltext(pmid: string, data: FulltextData): void {
    this.fulltexts.set(pmid, data);
  }
}

/** A cache that stores nothing — useful for tests or explicit opt-out. */
export class NullCache implements Cache {
  getSummary(): NcbiArticle | null {
    return null;
  }
  setSummary(): void {}
  getAbstract(): string | null {
    return null;
  }
  setAbstract(): void {}
  getFulltext(): FulltextData | null {
    return null;
  }
  setFulltext(): void {}
}

export function createCache(options: CacheOptions): Cache {
  switch (options.backend) {
    case "memory":
      return new LRUBackend(options.max ?? 200);
    case "sqlite":
      throw new Error(
        "The sqlite cache backend is not implemented in v0.1.0 (planned for v0.2). Use backend: 'memory'.",
      );
    default: {
      const exhaustive: never = options.backend;
      throw new Error(`Unknown cache backend: ${String(exhaustive)}`);
    }
  }
}
