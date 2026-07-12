import { describe, it, expect } from "vitest";
import { LRUBackend, NullCache, createCache } from "../src/core/cache";
import type { DeepGradeOutput, NcbiArticle } from "../src/core/types";

const article: NcbiArticle = {
  pmid: "1",
  title: "Test",
  authors: [],
  journal: "J",
  pubDate: "2021",
  publicationTypes: [],
};

const grade: DeepGradeOutput = {
  pmid: "1",
  correctedStudyType: "cohort",
  correctedScore: 3,
  pico: {},
  redFlags: [],
  gradingReasoning: "test",
  gradingMethod: "llm",
};

describe("LRUBackend", () => {
  it("round-trips summaries, abstracts, and grades", () => {
    const c = new LRUBackend();
    c.setSummary("1", article);
    c.setAbstract("1", "an abstract");
    c.setLLMGrade("1", grade);
    expect(c.getSummary("1")).toEqual(article);
    expect(c.getAbstract("1")).toBe("an abstract");
    expect(c.getLLMGrade("1")).toEqual(grade);
  });

  it("returns null for misses", () => {
    const c = new LRUBackend();
    expect(c.getSummary("nope")).toBeNull();
    expect(c.getAbstract("nope")).toBeNull();
    expect(c.getLLMGrade("nope")).toBeNull();
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
