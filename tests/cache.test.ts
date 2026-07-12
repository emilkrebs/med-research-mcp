import { describe, it, expect } from "vitest";
import { LRUBackend, NullCache, createCache } from "../src/core/cache";
import type { NcbiArticle } from "../src/core/types";

const article: NcbiArticle = {
  pmid: "1",
  title: "Test",
  authors: [],
  journal: "J",
  pubDate: "2021",
  publicationTypes: [],
};

describe("LRUBackend", () => {
  it("round-trips summaries and abstracts", () => {
    const c = new LRUBackend();
    c.setSummary("1", article);
    c.setAbstract("1", "an abstract");
    expect(c.getSummary("1")).toEqual(article);
    expect(c.getAbstract("1")).toBe("an abstract");
  });

  it("returns null for misses", () => {
    const c = new LRUBackend();
    expect(c.getSummary("nope")).toBeNull();
    expect(c.getAbstract("nope")).toBeNull();
  });

  it("evicts least-recently-used entries past capacity", () => {
    const c = new LRUBackend(2);
    c.setSummary("a", { ...article, pmid: "a" });
    c.setSummary("b", { ...article, pmid: "b" });
    c.setSummary("c", { ...article, pmid: "c" });
    expect(c.getSummary("a")).toBeNull();
    expect(c.getSummary("b")?.pmid).toBe("b");
    expect(c.getSummary("c")?.pmid).toBe("c");
  });
});

describe("NullCache", () => {
  it("never stores anything", () => {
    const c = new NullCache();
    c.setSummary("1", article);
    expect(c.getSummary("1")).toBeNull();
  });
});

describe("createCache", () => {
  it("builds an in-memory backend", () => {
    const c = createCache({ backend: "memory" });
    c.setAbstract("1", "x");
    expect(c.getAbstract("1")).toBe("x");
  });

  it("throws for the unimplemented sqlite backend", () => {
    expect(() => createCache({ backend: "sqlite" })).toThrow(/not implemented/i);
  });
});
