import { describe, it, expect } from "vitest";
import { searchLiterature, fetchLiterature } from "../src/core/literature";
import { cleanDoi, doiKey } from "../src/core/adapters/util";
import { LRUBackend } from "../src/core/cache";
import type { DatabaseAdapter } from "../src/core/adapters/types";
import type { NcbiArticle } from "../src/core/types";

/** A fake adapter that serves a fixed set of articles from memory. */
function fakeAdapter(id: string, articles: NcbiArticle[], count = articles.length): DatabaseAdapter {
  return {
    id,
    name: id,
    search: async () => ({ count, ids: articles.map((a) => a.pmid) }),
    fetch: async (ids) => articles.filter((a) => ids.includes(a.pmid)),
  };
}

const pubmedMeta: NcbiArticle = {
  pmid: "1",
  title: "Effects of creatine supplementation: a meta-analysis",
  authors: ["Doe J"],
  journal: "J Nutr",
  pubDate: "2020",
  doi: "10.1590/shared",
  publicationTypes: ["Meta-Analysis"],
};

const scieloReview: NcbiArticle = {
  pmid: "S1",
  title: "A review of creatine in sport",
  authors: ["García M"],
  journal: "Rev Bras",
  pubDate: "2019",
  doi: "10.1590/SHARED", // same DOI as pubmedMeta, different case — must dedupe
  publicationTypes: [],
  database: "scielo",
  language: "es",
};

const chinaxivRct: NcbiArticle = {
  pmid: "C1",
  title: "A randomized controlled trial of a peptide",
  authors: ["Wang L"],
  journal: "ChinaRXiv",
  pubDate: "2021",
  doi: "10.2074/other",
  publicationTypes: [],
  database: "chinaxiv",
  language: "zh",
};

const scieloPlain: NcbiArticle = {
  pmid: "S2",
  title: "Metabolic pathways of creatine",
  authors: ["López P"],
  journal: "Rev Bras",
  pubDate: "2018",
  publicationTypes: [],
  database: "scielo",
  language: "es",
};

describe("searchLiterature fan-out", () => {
  it("merges, grades, de-duplicates by DOI, and sorts by evidence score", async () => {
    const adapters = [
      fakeAdapter("pubmed", [pubmedMeta], 100),
      fakeAdapter("scielo", [scieloReview, scieloPlain], 20),
      fakeAdapter("chinaxiv", [chinaxivRct], 5),
    ];
    const out = await searchLiterature({ query: "creatine", database: "all" }, new LRUBackend(), adapters);

    // scieloReview shares a DOI with pubmedMeta (case-insensitive) and scores
    // lower (review=1 vs meta-analysis=5), so it is dropped.
    expect(out.articles.map((a) => a.pmid)).toEqual(["1", "C1", "S2"]);
    expect(out.articles.map((a) => a.evidenceScore)).toEqual([5, 4, 0]);
    // total sums each adapter's reported count.
    expect(out.total).toBe(125);
  });

  it("grades non-PubMed articles keyword-only (no NLM tags)", async () => {
    const out = await searchLiterature({ query: "x", database: "chinaxiv" }, new LRUBackend(), [
      fakeAdapter("chinaxiv", [chinaxivRct]),
    ]);
    expect(out.articles).toHaveLength(1);
    expect(out.articles[0]?.studyType).toBe("randomized-controlled-trial");
    expect(out.articles[0]?.database).toBe("chinaxiv");
  });

  it("applies minEvidenceScore across all databases", async () => {
    const adapters = [
      fakeAdapter("pubmed", [pubmedMeta]),
      fakeAdapter("scielo", [scieloReview, scieloPlain]),
      fakeAdapter("chinaxiv", [chinaxivRct]),
    ];
    const out = await searchLiterature(
      { query: "x", database: "all", minEvidenceScore: 4 },
      new LRUBackend(),
      adapters,
    );
    expect(out.articles.map((a) => a.pmid)).toEqual(["1", "C1"]);
    // scieloPlain is unclassified, not weak — the drop must be surfaced.
    expect(out.warnings?.some((w) => /1 result\(s\) with an undetermined study design/.test(w))).toBe(true);
  });

  it("applies the studyTypes filter", async () => {
    const adapters = [fakeAdapter("pubmed", [pubmedMeta]), fakeAdapter("chinaxiv", [chinaxivRct])];
    const out = await searchLiterature(
      { query: "x", database: "all", studyTypes: ["randomized-controlled-trial"] },
      new LRUBackend(),
      adapters,
    );
    expect(out.articles.map((a) => a.pmid)).toEqual(["C1"]);
  });

  it("degrades a failing adapter to a warning without sinking the others", async () => {
    const broken: DatabaseAdapter = {
      id: "boom",
      name: "Boom DB",
      search: async () => {
        throw new Error("upstream 503");
      },
      fetch: async () => [],
    };
    const out = await searchLiterature({ query: "x", database: "all" }, new LRUBackend(), [
      fakeAdapter("pubmed", [pubmedMeta]),
      broken,
    ]);
    expect(out.articles.map((a) => a.pmid)).toEqual(["1"]);
    expect(out.warnings?.some((w) => w.includes("Boom DB") && w.includes("upstream 503"))).toBe(true);
  });

  it("returns a warning when no adapter matches the requested database", async () => {
    const out = await searchLiterature({ query: "x", database: "nope" }, new LRUBackend(), []);
    expect(out.articles).toHaveLength(0);
    expect(out.warnings?.[0]).toContain("No known database adapter");
  });
});

describe("fetchLiterature", () => {
  it("fetches from a single adapter and reports missing ids", async () => {
    const adapter = fakeAdapter("scielo", [scieloReview, scieloPlain]);
    const out = await fetchLiterature({ ids: ["S1", "S2", "S404"], database: "scielo" }, new LRUBackend(), adapter);
    expect(out.articles.map((a) => a.pmid)).toEqual(["S1", "S2"]);
    expect(out.missing).toEqual(["S404"]);
    expect(out.warnings?.[0]).toContain("1 id(s) could not be fetched");
  });

  it("returns all ids as missing for an unknown database", async () => {
    const out = await fetchLiterature({ ids: ["S1"], database: "unknown-db" }, new LRUBackend());
    expect(out.articles).toHaveLength(0);
    expect(out.missing).toEqual(["S1"]);
    expect(out.warnings?.[0]).toContain("Unknown database");
  });
});

describe("DOI helpers", () => {
  it("cleanDoi strips prefixes but preserves case", () => {
    expect(cleanDoi("https://doi.org/10.1590/S0102-1")).toBe("10.1590/S0102-1");
    expect(cleanDoi("doi: 10.1234/abc")).toBe("10.1234/abc");
    expect(cleanDoi("not-a-doi")).toBeUndefined();
    expect(cleanDoi("10.1/abc")).toBeUndefined(); // registrant code too short
  });

  it("doiKey lowercases for case-insensitive dedup", () => {
    expect(doiKey("10.1234/ABC")).toBe("10.1234/abc");
    expect(doiKey("10.1234/abc")).toBe(doiKey("https://doi.org/10.1234/ABC"));
  });
});
