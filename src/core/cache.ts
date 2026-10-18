/**
 * Cache interface + backends.
 *
 * The interface is what the rest of the library depends on; backends are
 * swappable. Two ship: the in-memory `LRUBackend` (dies with the process) and
 * the persistent `SQLiteBackend` (survives restarts).
 *
 * better-sqlite3 is a native module, so it's loaded lazily — only when the
 * sqlite backend is actually constructed. That keeps `LRUBackend`-only
 * consumers from paying for (or being broken by) a native binding they never
 * use, and lets `createCache` fall back to LRU if the binding fails to load.
 */

import { createRequire } from "node:module";
import { LRUCache } from "lru-cache";
import type SqliteDatabase from "better-sqlite3";
import type { FulltextData, Article } from "./types.js";

/** Full texts expire after 30 days — the paper is stable but resolved OA URLs rot. */
export const FULLTEXT_TTL_MS = 30 * 24 * 60 * 60 * 1000;

/**
 * Summaries expire after 7 days. Abstracts don't change, but a summary's
 * metadata does: NLM adds publication types and MeSH when it indexes a record,
 * and retractions, expressions of concern and errata can arrive at any time.
 * A cached summary must not hide a retraction for long.
 */
export const SUMMARY_TTL_MS = 7 * 24 * 60 * 60 * 1000;

export interface Cache {
  /** Returns a cached summary, or null on a miss or if older than {@link SUMMARY_TTL_MS}. */
  getSummary(pmid: string): Article | null;
  setSummary(pmid: string, article: Article): void;
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
  /** Filesystem path for the sqlite backend. Use ":memory:" for an ephemeral DB. Default "./pubmed-cache.db". */
  path?: string;
}

/**
 * In-memory LRU cache. Dies with the process — right for short-lived agent
 * sessions. Abstracts never expire; summaries expire after {@link SUMMARY_TTL_MS}
 * (a server can run for days) and full texts after {@link FULLTEXT_TTL_MS}.
 */
export class LRUBackend implements Cache {
  private readonly summaries: LRUCache<string, Article>;
  private readonly abstracts: LRUCache<string, string>;
  private readonly fulltexts: LRUCache<string, FulltextData>;

  constructor(max = 200) {
    this.summaries = new LRUCache({ max, ttl: SUMMARY_TTL_MS });
    this.abstracts = new LRUCache({ max });
    // The LRU's own TTL evicts stale entries; getFulltext double-checks fetchedAt
    // so a caller-supplied stale timestamp is also honored.
    this.fulltexts = new LRUCache({ max, ttl: FULLTEXT_TTL_MS });
  }

  getSummary(pmid: string): Article | null {
    return this.summaries.get(pmid) ?? null;
  }

  setSummary(pmid: string, article: Article): void {
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
  getSummary(): Article | null {
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

// ─── SQLite backend ─────────────────────────────────────────────

const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS summaries (
    pmid       TEXT PRIMARY KEY,
    article    TEXT NOT NULL,
    fetched_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS abstracts (
    pmid       TEXT PRIMARY KEY,
    abstract   TEXT NOT NULL,
    fetched_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS fulltexts (
    pmid       TEXT PRIMARY KEY,
    source     TEXT NOT NULL,
    fulltext   TEXT NOT NULL,
    format     TEXT NOT NULL,
    fetched_at INTEGER NOT NULL
);
`;

interface FulltextRow {
  source: string;
  fulltext: string;
  format: string;
  fetched_at: number;
}

/**
 * Loads the native better-sqlite3 module on first use (see the module header).
 *
 * Resolves from this module's own location so better-sqlite3 is found even when
 * med-research-mcp is a nested dependency. `__filename` exists in the CJS build;
 * `import.meta.url` exists in the ESM build — esbuild leaves the other one
 * undefined per format, so `typeof` picks whichever is real. (`typeof` on an
 * undeclared identifier is safe — it evaluates to "undefined" rather than
 * throwing.)
 */
function loadSqlite(): typeof SqliteDatabase {
  const from = typeof __filename !== "undefined" ? __filename : import.meta.url;
  const require = createRequire(from);
  return require("better-sqlite3") as typeof SqliteDatabase;
}

/**
 * Persistent cache backed by a single SQLite file. Drop-in replacement for
 * {@link LRUBackend} — same interface, same semantics, but survives restarts so
 * abstracts are fetched from NCBI at most once.
 *
 * Abstracts never expire. Summaries expire after {@link SUMMARY_TTL_MS} because
 * their metadata changes (indexing, retractions, corrections); full texts after
 * {@link FULLTEXT_TTL_MS} because resolved OA URLs and proxy sessions rot.
 * Expiry is enforced at read time and swept by {@link vacuum}.
 */
export class SQLiteBackend implements Cache {
  private readonly db: SqliteDatabase.Database;
  private readonly stmts: {
    getSummary: SqliteDatabase.Statement<[string]>;
    vacuumSummary: SqliteDatabase.Statement<[number]>;
    setSummary: SqliteDatabase.Statement<[string, string, number]>;
    delSummary: SqliteDatabase.Statement<[string]>;
    getAbstract: SqliteDatabase.Statement<[string]>;
    setAbstract: SqliteDatabase.Statement<[string, string, number]>;
    getFulltext: SqliteDatabase.Statement<[string]>;
    setFulltext: SqliteDatabase.Statement<[string, string, string, string, number]>;
    delFulltext: SqliteDatabase.Statement<[string]>;
    vacuumFulltext: SqliteDatabase.Statement<[number]>;
  };

  constructor(path: string) {
    const Database = loadSqlite();
    this.db = new Database(path);
    this.db.pragma("journal_mode = WAL"); // concurrent reads while another process writes
    this.db.pragma("synchronous = NORMAL"); // safe with WAL, faster writes
    this.db.exec(SCHEMA_SQL);

    this.stmts = {
      getSummary: this.db.prepare("SELECT article, fetched_at FROM summaries WHERE pmid = ?"),
      vacuumSummary: this.db.prepare("DELETE FROM summaries WHERE fetched_at < ?"),
      setSummary: this.db.prepare("INSERT OR REPLACE INTO summaries (pmid, article, fetched_at) VALUES (?, ?, ?)"),
      delSummary: this.db.prepare("DELETE FROM summaries WHERE pmid = ?"),
      getAbstract: this.db.prepare("SELECT abstract FROM abstracts WHERE pmid = ?"),
      setAbstract: this.db.prepare("INSERT OR REPLACE INTO abstracts (pmid, abstract, fetched_at) VALUES (?, ?, ?)"),
      getFulltext: this.db.prepare("SELECT source, fulltext, format, fetched_at FROM fulltexts WHERE pmid = ?"),
      setFulltext: this.db.prepare(
        "INSERT OR REPLACE INTO fulltexts (pmid, source, fulltext, format, fetched_at) VALUES (?, ?, ?, ?, ?)",
      ),
      delFulltext: this.db.prepare("DELETE FROM fulltexts WHERE pmid = ?"),
      vacuumFulltext: this.db.prepare("DELETE FROM fulltexts WHERE fetched_at < ?"),
    };

    this.vacuum();
  }

  getSummary(pmid: string): Article | null {
    const row = this.stmts.getSummary.get(pmid) as { article: string; fetched_at: number } | undefined;
    if (!row) return null;
    if (Date.now() - row.fetched_at > SUMMARY_TTL_MS) {
      this.stmts.delSummary.run(pmid);
      return null;
    }
    try {
      return JSON.parse(row.article) as Article;
    } catch {
      // Corrupt JSON — drop the row and treat as a miss.
      this.stmts.delSummary.run(pmid);
      return null;
    }
  }

  setSummary(pmid: string, article: Article): void {
    this.stmts.setSummary.run(pmid, JSON.stringify(article), Date.now());
  }

  getAbstract(pmid: string): string | null {
    const row = this.stmts.getAbstract.get(pmid) as { abstract: string } | undefined;
    return row ? row.abstract : null;
  }

  setAbstract(pmid: string, abstract: string): void {
    this.stmts.setAbstract.run(pmid, abstract, Date.now());
  }

  getFulltext(pmid: string): FulltextData | null {
    const row = this.stmts.getFulltext.get(pmid) as FulltextRow | undefined;
    if (!row) return null;
    if (Date.now() - row.fetched_at > FULLTEXT_TTL_MS) {
      this.stmts.delFulltext.run(pmid);
      return null;
    }
    return {
      source: row.source,
      fulltext: row.fulltext,
      format: row.format === "pdf" ? "pdf" : "markdown",
      fetchedAt: row.fetched_at,
    };
  }

  setFulltext(pmid: string, data: FulltextData): void {
    this.stmts.setFulltext.run(pmid, data.source, data.fulltext, data.format, data.fetchedAt ?? Date.now());
  }

  /** Delete every expired summary and full-text row. Runs on construction; call periodically if desired. */
  vacuum(): void {
    this.stmts.vacuumSummary.run(Date.now() - SUMMARY_TTL_MS);
    this.stmts.vacuumFulltext.run(Date.now() - FULLTEXT_TTL_MS);
  }

  /** Total rows across all three tables — handy for debugging. */
  get size(): number {
    const count = (table: string): number =>
      (this.db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n;
    return count("summaries") + count("abstracts") + count("fulltexts");
  }

  /** Close the database connection. Call on process exit; operations afterward throw. */
  close(): void {
    this.db.close();
  }
}

export function createCache(options: CacheOptions): Cache {
  switch (options.backend) {
    case "memory":
      return new LRUBackend(options.max ?? 200);
    case "sqlite":
      return new SQLiteBackend(options.path ?? "./pubmed-cache.db");
    default: {
      const exhaustive: never = options.backend;
      throw new Error(`Unknown cache backend: ${String(exhaustive)}`);
    }
  }
}
