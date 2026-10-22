import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { CACHE_FORMAT_VERSION, SQLiteBackend } from "../src/core/cache";
import { FULLTEXT_TTL_MS, SUMMARY_TTL_MS } from "../src/core/cache";
import type { FulltextData, NcbiArticle } from "../src/core/types";

const ARTICLE: NcbiArticle = {
  pmid: "12345678",
  title: "Creatine and cognition",
  abstract: "A trial abstract.",
  authors: ["Doe J", "Roe R"],
  journal: "J Test",
  pubDate: "2021 Mar",
  doi: "10.1000/xyz123",
  publicationTypes: ["Randomized Controlled Trial", "Journal Article"],
  meshHeadings: ["Creatine", "Cognition"],
};

const FULLTEXT: FulltextData = {
  source: "unpaywall",
  fulltext: "# Methods\n\nFull text body.",
  format: "markdown",
  fetchedAt: Date.now(),
};

let dir: string;
let counter = 0;
/** A fresh DB path per test so state never leaks between them. */
function freshPath(): string {
  return join(dir, `cache-${counter++}.db`);
}

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "pubmed-sqlite-"));
});
afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("SQLiteBackend round-trip", () => {
  it("stores and reads back a summary", () => {
    const c = new SQLiteBackend(":memory:");
    c.setSummary("12345678", ARTICLE);
    expect(c.getSummary("12345678")).toEqual(ARTICLE);
    c.close();
  });

  it("stores and reads back an abstract", () => {
    const c = new SQLiteBackend(":memory:");
    c.setAbstract("12345678", "the abstract");
    expect(c.getAbstract("12345678")).toBe("the abstract");
    c.close();
  });

  it("stores and reads back a full text", () => {
    const c = new SQLiteBackend(":memory:");
    c.setFulltext("12345678", FULLTEXT);
    expect(c.getFulltext("12345678")).toEqual(FULLTEXT);
    c.close();
  });

  it("returns null for missing keys", () => {
    const c = new SQLiteBackend(":memory:");
    expect(c.getSummary("nope")).toBeNull();
    expect(c.getAbstract("nope")).toBeNull();
    expect(c.getFulltext("nope")).toBeNull();
    c.close();
  });
});

describe("SQLiteBackend persistence", () => {
  it("survives closing and reopening the database file", () => {
    const path = freshPath();

    const first = new SQLiteBackend(path);
    first.setSummary("12345678", ARTICLE);
    first.setAbstract("12345678", "persisted abstract");
    first.setFulltext("12345678", { ...FULLTEXT, fetchedAt: Date.now() });
    first.close();

    const second = new SQLiteBackend(path);
    expect(second.getSummary("12345678")).toEqual(ARTICLE);
    expect(second.getAbstract("12345678")).toBe("persisted abstract");
    expect(second.getFulltext("12345678")?.fulltext).toBe(FULLTEXT.fulltext);
    second.close();
  });

  /** A file as 0.6.0 left it: tables without a version in their names. */
  function writtenBy060(path: string): Database.Database {
    const raw = new Database(path);
    raw.exec(`
      CREATE TABLE summaries (pmid TEXT PRIMARY KEY, article TEXT NOT NULL, fetched_at INTEGER NOT NULL);
      CREATE TABLE abstracts (pmid TEXT PRIMARY KEY, abstract TEXT NOT NULL, fetched_at INTEGER NOT NULL);
      CREATE TABLE fulltexts (pmid TEXT PRIMARY KEY, source TEXT NOT NULL, fulltext TEXT NOT NULL, format TEXT NOT NULL, fetched_at INTEGER NOT NULL);
    `);
    raw.prepare("INSERT INTO summaries VALUES (?, ?, ?)").run("12345678", JSON.stringify(ARTICLE), Date.now());
    raw.prepare("INSERT INTO abstracts VALUES (?, ?, ?)").run("12345678", "(= 0.03), 31 &#xb1; 8 years", Date.now());
    raw.prepare("INSERT INTO fulltexts VALUES (?, ?, ?, ?, ?)").run("12345678", "unpaywall", "# References", "markdown", Date.now());
    return raw;
  }

  it("never serves what 0.6.0 or earlier stored, whose abstracts were parsed without their inline markup", () => {
    const path = freshPath();
    writtenBy060(path).close();

    const upgraded = new SQLiteBackend(path);
    expect(upgraded.getSummary("12345678")).toBeNull();
    expect(upgraded.getAbstract("12345678")).toBeNull();
    expect(upgraded.getFulltext("12345678")).toBeNull();
    expect(upgraded.size).toBe(0);
    upgraded.close();
    // The old tables are emptied, not dropped.
    const raw = new Database(path);
    expect(raw.prepare("SELECT COUNT(*) AS n FROM abstracts").get()).toEqual({ n: 0 });
    raw.close();
  });

  it("never serves what 0.6.0 writes while it runs on the same file", () => {
    const path = freshPath();
    const old = writtenBy060(path);
    const current = new SQLiteBackend(path);
    old.prepare("INSERT OR REPLACE INTO abstracts VALUES (?, ?, ?)").run("12345678", "(= 0.03)", Date.now());
    old.close();
    expect(current.getAbstract("12345678")).toBeNull();
    current.setAbstract("12345678", "(r = 0.03)");
    expect(current.getAbstract("12345678")).toBe("(r = 0.03)");
    current.close();
  });

  it("leaves a newer version's tables alone", () => {
    const path = freshPath();
    const raw = new Database(path);
    raw.exec(`CREATE TABLE abstracts_v${CACHE_FORMAT_VERSION + 1} (pmid TEXT PRIMARY KEY, abstract TEXT NOT NULL, fetched_at INTEGER NOT NULL)`);
    raw.prepare(`INSERT INTO abstracts_v${CACHE_FORMAT_VERSION + 1} VALUES (?, ?, ?)`).run("12345678", "newer abstract", Date.now());
    raw.close();

    new SQLiteBackend(path).close();
    const reopened = new Database(path);
    expect(reopened.prepare(`SELECT abstract FROM abstracts_v${CACHE_FORMAT_VERSION + 1}`).get()).toEqual({ abstract: "newer abstract" });
    reopened.close();
  });
});

describe("SQLiteBackend full-text TTL", () => {
  it("expires a full text older than the TTL on read", () => {
    const c = new SQLiteBackend(":memory:");
    c.setFulltext("12345678", { ...FULLTEXT, fetchedAt: Date.now() - (FULLTEXT_TTL_MS + 1000) });
    expect(c.getFulltext("12345678")).toBeNull();
    c.close();
  });

  it("keeps a full text within the TTL", () => {
    const c = new SQLiteBackend(":memory:");
    c.setFulltext("12345678", { ...FULLTEXT, fetchedAt: Date.now() - 1000 });
    expect(c.getFulltext("12345678")).not.toBeNull();
    c.close();
  });

});

describe("SQLiteBackend summary TTL", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("expires summaries after SUMMARY_TTL_MS so a later retraction can't stay hidden, but keeps abstracts", () => {
    vi.useFakeTimers();
    const c = new SQLiteBackend(":memory:");
    c.setSummary("12345678", ARTICLE);
    c.setAbstract("12345678", "old but valid");
    vi.advanceTimersByTime(SUMMARY_TTL_MS - 1000);
    expect(c.getSummary("12345678")).toEqual(ARTICLE);
    vi.advanceTimersByTime(2000);
    expect(c.getSummary("12345678")).toBeNull();
    expect(c.getAbstract("12345678")).toBe("old but valid");
    c.close();
  });

  it("vacuums expired summaries", () => {
    vi.useFakeTimers();
    const c = new SQLiteBackend(":memory:");
    c.setSummary("stale", ARTICLE);
    vi.advanceTimersByTime(SUMMARY_TTL_MS + 1000);
    c.setSummary("fresh", ARTICLE);
    c.vacuum();
    expect(c.size).toBe(1);
    expect(c.getSummary("fresh")).toEqual(ARTICLE);
    c.close();
  });
});

describe("SQLiteBackend vacuum", () => {
  it("deletes expired full-text rows", () => {
    const c = new SQLiteBackend(":memory:");
    c.setFulltext("fresh", { ...FULLTEXT, fetchedAt: Date.now() });
    c.setFulltext("stale", { ...FULLTEXT, fetchedAt: Date.now() - (FULLTEXT_TTL_MS + 1000) });
    expect(c.size).toBe(2);

    c.vacuum();
    expect(c.size).toBe(1);
    expect(c.getFulltext("fresh")).not.toBeNull();
    c.close();
  });

  it("counts rows across all three tables in size", () => {
    const c = new SQLiteBackend(":memory:");
    c.setSummary("1", ARTICLE);
    c.setAbstract("1", "a");
    c.setFulltext("1", { ...FULLTEXT, fetchedAt: Date.now() });
    expect(c.size).toBe(3);
    c.close();
  });
});

describe("SQLiteBackend resilience", () => {
  it("returns null and drops the row on corrupt summary JSON", () => {
    const path = freshPath();
    // Seed the schema via the backend, then inject invalid JSON directly.
    new SQLiteBackend(path).close();
    const raw = new Database(path);
    raw.prepare(`INSERT OR REPLACE INTO summaries_v${CACHE_FORMAT_VERSION} (pmid, article, fetched_at) VALUES (?, ?, ?)`).run(
      "bad",
      "{ not valid json",
      Date.now(),
    );
    raw.close();

    const c = new SQLiteBackend(path);
    expect(c.getSummary("bad")).toBeNull();
    // The corrupt row was deleted, so it stays a miss.
    expect(c.size).toBe(0);
    c.close();
  });

  it("throws on operations after close()", () => {
    const c = new SQLiteBackend(":memory:");
    c.close();
    expect(() => c.getSummary("1")).toThrow();
    expect(() => c.setSummary("1", ARTICLE)).toThrow();
  });
});

describe("SQLiteBackend WAL concurrent readers", () => {
  it("lets a second connection read what the first wrote", () => {
    const path = freshPath();
    const writer = new SQLiteBackend(path);
    const reader = new SQLiteBackend(path);

    writer.setSummary("12345678", ARTICLE);
    // WAL + autocommit: the committed write is visible to the other connection.
    expect(reader.getSummary("12345678")).toEqual(ARTICLE);

    writer.close();
    reader.close();
  });
});
