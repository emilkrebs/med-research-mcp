import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { SQLiteBackend } from "../src/core/cache";
import { FULLTEXT_TTL_MS } from "../src/core/cache";
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

  it("never expires summaries or abstracts", () => {
    const c = new SQLiteBackend(":memory:");
    // Even with an ancient write, immutable stores stay readable.
    c.setSummary("12345678", ARTICLE);
    c.setAbstract("12345678", "old but valid");
    expect(c.getSummary("12345678")).toEqual(ARTICLE);
    expect(c.getAbstract("12345678")).toBe("old but valid");
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
    raw.prepare("INSERT OR REPLACE INTO summaries (pmid, article, fetched_at) VALUES (?, ?, ?)").run(
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
