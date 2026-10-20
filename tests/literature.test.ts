import { describe, it, expect } from "vitest";
import { searchLiterature, fetchLiterature } from "../src/core/literature";
import { cleanDoi, doiKey, isoDateBound, withoutPubMedTags } from "../src/core/adapters/util";
import { errors } from "../src/core/errors";
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

const epmcRct: NcbiArticle = {
  pmid: "E1",
  title: "Creatine supplementation in older adults",
  authors: ["Smith J"],
  journal: "Eur J Nutr",
  pubDate: "2022",
  doi: "10.1234/epmc",
  publicationTypes: ["Randomized Controlled Trial", "Journal Article"],
  meshHeadings: ["Creatine", "Humans", "Aged"],
  database: "europepmc",
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
  it("merges, classifies, de-duplicates by DOI, and sorts by design tier", async () => {
    const adapters = [
      fakeAdapter("pubmed", [pubmedMeta], 100),
      fakeAdapter("scielo", [scieloReview, scieloPlain], 20),
      fakeAdapter("chinaxiv", [chinaxivRct], 5),
      fakeAdapter("europepmc", [epmcRct], 7),
    ];
    const out = await searchLiterature({ query: "creatine", database: "all" }, new LRUBackend(), adapters);

    // scieloReview shares a DOI with pubmedMeta (case-insensitive) and neither
    // outranks the other, so the first-seen copy stays. The meta-analysis's pooled
    // designs aren't indexed, so it is unrated and sorts with the unclassified
    // records, which keep their per-adapter order after the rated RCT.
    expect(out.articles.map((a) => a.pmid)).toEqual(["E1", "1", "S2", "C1"]);
    expect(out.articles.map((a) => a.designTier)).toEqual([4, null, null, null]);
    // total sums each adapter's reported count.
    expect(out.total).toBe(132);
  });

  it("classifies non-PubMed records from their own metadata and leaves untagged ones unknown", async () => {
    const out = await searchLiterature({ query: "x", database: "all" }, new LRUBackend(), [
      fakeAdapter("europepmc", [epmcRct]),
      fakeAdapter("chinaxiv", [chinaxivRct]),
    ]);
    expect(out.articles.map((a) => [a.pmid, a.studyType])).toEqual([
      ["E1", "randomized-controlled-trial"],
      // "randomized controlled trial" in the title is not metadata.
      ["C1", "unknown"],
    ]);
  });

  it("leaves MeSH headings out of search results", async () => {
    const out = await searchLiterature({ query: "x", database: "europepmc" }, new LRUBackend(), [
      fakeAdapter("europepmc", [epmcRct]),
    ]);
    expect(out.articles[0]).not.toHaveProperty("meshHeadings");
  });

  it("applies minDesignTier across all databases and reports dropped unrated records", async () => {
    const adapters = [
      fakeAdapter("pubmed", [pubmedMeta]),
      fakeAdapter("scielo", [scieloReview, scieloPlain]),
      fakeAdapter("chinaxiv", [chinaxivRct]),
      fakeAdapter("europepmc", [epmcRct]),
    ];
    const out = await searchLiterature(
      { query: "x", database: "all", minDesignTier: 4 },
      new LRUBackend(),
      adapters,
    );
    expect(out.articles.map((a) => a.pmid)).toEqual(["E1"]);
    // Unrated, not weak — the drop (including the unrated meta-analysis) must be surfaced.
    // Counted per paper: scieloReview is a copy of pubmedMeta.
    expect(out.warnings?.some((w) => /3 result\(s\) with an unknown design tier/.test(w))).toBe(true);
  });

  describe("a retraction indexed in only one database", () => {
    const retractedPubmed: NcbiArticle = {
      ...epmcRct,
      pmid: "P9",
      doi: "10.1234/EPMC",
      publicationTypes: ["Randomized Controlled Trial", "Journal Article", "Retracted Publication"],
      database: undefined,
    };

    it("survives de-duplication, whichever copy comes first", async () => {
      for (const order of [[retractedPubmed, epmcRct], [epmcRct, retractedPubmed]]) {
        const out = await searchLiterature({ query: "x", database: "all" }, new LRUBackend(), [
          fakeAdapter("a", [order[0]!]),
          fakeAdapter("b", [order[1]!]),
        ]);
        expect(out.articles).toHaveLength(1);
        expect(out.articles[0]).toMatchObject({ studyType: "randomized-controlled-trial", designTier: 0, flags: ["retracted"] });
      }
    });

    it("survives a copy without design metadata, which outranks tier 0", async () => {
      const out = await searchLiterature({ query: "x", database: "all" }, new LRUBackend(), [
        fakeAdapter("pubmed", [retractedPubmed]),
        fakeAdapter("chinaxiv", [{ ...chinaxivRct, doi: "10.1234/epmc" }]),
      ]);
      expect(out.articles).toHaveLength(1);
      expect(out.articles[0]).toMatchObject({ designTier: 0, flags: ["retracted"] });
    });

    it("is not bypassed by minDesignTier dropping the retracted copy first", async () => {
      const out = await searchLiterature({ query: "x", database: "all", minDesignTier: 3 }, new LRUBackend(), [
        fakeAdapter("pubmed", [retractedPubmed]),
        fakeAdapter("europepmc", [epmcRct]),
      ]);
      expect(out.articles).toEqual([]);
    });
  });

  it("keeps unclassified records at minDesignTier 0", async () => {
    const out = await searchLiterature({ query: "x", database: "chinaxiv", minDesignTier: 0 }, new LRUBackend(), [
      fakeAdapter("chinaxiv", [chinaxivRct]),
    ]);
    expect(out.articles.map((a) => a.pmid)).toEqual(["C1"]);
    expect(out.warnings).toBeUndefined();
  });

  it("applies the studyTypes filter", async () => {
    const adapters = [fakeAdapter("pubmed", [pubmedMeta]), fakeAdapter("europepmc", [epmcRct])];
    const out = await searchLiterature(
      { query: "x", database: "all", studyTypes: ["randomized-controlled-trial"] },
      new LRUBackend(),
      adapters,
    );
    expect(out.articles.map((a) => a.pmid)).toEqual(["E1"]);
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

  it("raises the error when every database it searched failed, instead of an empty result", async () => {
    const tooBroad: DatabaseAdapter = {
      id: "pubmed",
      name: "PubMed / NCBI",
      search: async () => {
        throw errors.queryTooBroad(250_000);
      },
      fetch: async () => [],
    };
    // An empty article list would read as "no studies exist"; the caller gets the code and the hint instead.
    await expect(searchLiterature({ query: "x" }, new LRUBackend(), [tooBroad])).rejects.toMatchObject({
      code: "QUERY_TOO_BROAD",
    });
  });

  it("words a partial failure's warning with the error's actionable message", async () => {
    const limited: DatabaseAdapter = {
      id: "europepmc",
      name: "Europe PMC",
      search: async () => {
        throw errors.rateLimit(30, "Europe PMC");
      },
      fetch: async () => [],
    };
    const out = await searchLiterature({ query: "x", database: "all" }, new LRUBackend(), [
      fakeAdapter("pubmed", [pubmedMeta]),
      limited,
    ]);
    expect(out.articles.map((a) => a.pmid)).toEqual(["1"]);
    expect(out.warnings).toContain("Europe PMC search failed: Too many requests to Europe PMC. Wait 30s and try again.");
  });

  it("counts a PMCID as found when Europe PMC returns the record under its PMID", async () => {
    const epmc: DatabaseAdapter = {
      id: "europepmc",
      name: "Europe PMC",
      search: async () => ({ count: 0, ids: [] }),
      fetch: async () => [{ ...pubmedMeta, pmid: "36615805", pmcid: "PMC9824573", database: "europepmc" }],
    };
    const out = await fetchLiterature({ ids: ["pmc9824573"], database: "europepmc" }, new LRUBackend(), epmc);
    expect(out.articles).toHaveLength(1);
    expect(out.missing).toEqual([]);
  });

  it("merges a DOI-less record that two adapters returned from the same database", async () => {
    const soviet: NcbiArticle = { ...pubmedMeta, pmid: "ru-196201.58177", doi: undefined, database: "russiarxiv", publicationTypes: [] };
    // The chinaxiv adapter with language "ru" and the russiarxiv adapter search the same corpus.
    const out = await searchLiterature({ query: "x", database: "all", language: "ru" }, new LRUBackend(), [
      { ...fakeAdapter("chinaxiv", [soviet]), id: "chinaxiv" },
      fakeAdapter("russiarxiv", [soviet]),
    ]);
    expect(out.articles.map((a) => a.pmid)).toEqual(["ru-196201.58177"]);
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

describe("withoutPubMedTags", () => {
  it("drops PubMed field tags that other databases would search as words", () => {
    expect(withoutPubMedTags("creatine AND cognition[tiab]")).toBe("creatine AND cognition");
    expect(withoutPubMedTags('"Creatine"[mesh] AND (memory[Title/Abstract] OR randomized controlled trial[pt])')).toBe(
      '"Creatine" AND (memory OR randomized controlled trial)',
    );
    expect(withoutPubMedTags("Kreider R[au] creatine")).toBe("Kreider R creatine");
  });

  it("keeps bracketed chemistry such as radiotracers", () => {
    expect(withoutPubMedTags("[18F]FDG PET AND [Ca2+] signalling")).toBe("[18F]FDG PET AND [Ca2+] signalling");
  });
});

describe("isoDateBound", () => {
  it("turns a year or month into the first or last day, and refuses non-dates", () => {
    expect(isoDateBound("2020", "from")).toBe("2020-01-01");
    expect(isoDateBound("2020", "to")).toBe("2020-12-31");
    expect(isoDateBound("2024-02", "to")).toBe("2024-02-29");
    expect(isoDateBound("2023/5/7", "from")).toBe("2023-05-07");
    expect(isoDateBound("2023-02-30", "from")).toBeUndefined();
    expect(isoDateBound("last year", "from")).toBeUndefined();
    expect(isoDateBound(undefined, "to")).toBeUndefined();
  });
});
