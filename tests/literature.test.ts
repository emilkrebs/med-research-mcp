import { describe, it, expect, vi } from "vitest";
import { searchLiterature, fetchLiterature } from "../src/core/literature";
import { adaptersFor } from "../src/core/adapters/registry";
import { cleanDoi, dateKey, doiKey, isoDateBound, withoutPubMedTags } from "../src/core/adapters/util";
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
    // Unrated, not weak — leaving them out (the unrated meta-analysis included) must be surfaced.
    expect(out.warnings?.some((w) => w.startsWith("minDesignTier 4 leaves out every record with an unknown design tier"))).toBe(true);
  });

  it("says minDesignTier leaves out unrated records even when the narrowed query fetched none", async () => {
    // PubMed and Europe PMC are asked only for publication types that can reach the tier, so for
    // "creatine supplementation" at minDesignTier 3 every record fetched was an RCT (2026-10-22).
    const out = await searchLiterature({ query: "x", database: "europepmc", minDesignTier: 3 }, new LRUBackend(), [
      fakeAdapter("europepmc", [epmcRct]),
    ]);
    expect(out.articles.map((a) => a.pmid)).toEqual(["E1"]);
    expect(out.warnings).toEqual([expect.stringContaining("leaves out every record with an unknown design tier")]);
  });

  it("doesn't warn about unrated records when studyTypes wouldn't keep them anyway", async () => {
    const out = await searchLiterature(
      { query: "x", database: "europepmc", studyTypes: ["randomized-controlled-trial"], minDesignTier: 4 },
      new LRUBackend(),
      [fakeAdapter("europepmc", [epmcRct])],
    );
    expect(out.articles.map((a) => a.pmid)).toEqual(["E1"]);
    expect(out.warnings).toBeUndefined();
  });

  it("says a zero is not evidence of absence, naming the query", async () => {
    // PubMed ANDs space-separated terms, so 4 keywords can match nothing while the literature holds
    // hits ("psilocybin glucose" returns 14). A bare 0 was read as "no such evidence exists" (2026-10-23).
    const out = await searchLiterature(
      { query: "psilocybin glucose metabolism glycemic", database: "pubmed" },
      new LRUBackend(),
      [fakeAdapter("pubmed", [], 0)],
    );
    expect(out.articles).toEqual([]);
    expect(out.total).toBe(0);
    expect(out.warnings).toEqual([expect.stringContaining("not evidence of absence")]);
    expect(out.warnings?.[0]).toContain("psilocybin glucose metabolism glycemic");
  });

  it("doesn't add the zero warning when a design filter, a date range or a failed database explains it", async () => {
    const filtered = await searchLiterature(
      { query: "x", database: "europepmc", studyTypes: ["randomized-controlled-trial"] },
      new LRUBackend(),
      [fakeAdapter("europepmc", [], 0)],
    );
    expect(filtered.warnings ?? []).not.toContainEqual(expect.stringContaining("not evidence of absence"));

    const dated = await searchLiterature({ query: "x y", dateRange: { from: "2020" } }, new LRUBackend(), [fakeAdapter("pubmed", [], 0)]);
    expect(dated.warnings).toBeUndefined();

    const failing: DatabaseAdapter = {
      id: "boom",
      name: "Boom DB",
      search: async () => {
        throw new Error("upstream 503");
      },
      fetch: async () => [],
    };
    const partial = await searchLiterature({ query: "x", database: "all" }, new LRUBackend(), [
      fakeAdapter("pubmed", [], 0),
      failing,
    ]);
    expect(partial.warnings ?? []).not.toContainEqual(expect.stringContaining("not evidence of absence"));
    expect(partial.warnings?.some((w) => w.includes("Boom DB"))).toBe(true);
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

  it('orders by date, not design tier, with sort "date"', async () => {
    // The review's semaglutide 2015–2018 search: PubMed returned these newest first, and 0.6.0
    // re-sorted them by tier (Aug, Apr, Mar, Feb, Nov-Dec, …).
    const record = (pmid: string, pubDate: string, publicationTypes: string[], database?: string): NcbiArticle => ({
      pmid, title: pmid, authors: [], journal: "J", pubDate, publicationTypes, ...(database ? { database } : {}),
    });
    const pubmed = [
      // Issue date 2020 Feb, online since 2019 Jun 3: PubMed sorts by the earlier date.
      { ...record("P0", "2020 Feb", ["Journal Article"]), epubDate: "2019 Jun 3" },
      record("P1", "2019 Nov-Dec", ["Review"]),
      record("P2", "2019 Aug", ["Randomized Controlled Trial"]),
      record("P3", "2019 May", ["Case Reports"]),
      record("P4", "2019", ["Randomized Controlled Trial"]),
    ];
    const europepmc = [record("E9", "2019-10-02", [], "europepmc"), record("E8", "", [], "europepmc"), record("E7", "2019 Aug 1", [], "europepmc")];
    const byDate = await searchLiterature({ query: "x", database: "all", sort: "date" }, new LRUBackend(), [
      fakeAdapter("pubmed", pubmed),
      fakeAdapter("europepmc", europepmc),
    ]);
    // Merged newest first by first publication; a record without a date goes last.
    expect(byDate.articles.map((a) => a.pmid)).toEqual(["P1", "E9", "E7", "P2", "P0", "P3", "P4", "E8"]);

    // A date that only narrows the other is the date: PMID 42422741 has issue "2026" and online "2026 Jun 24".
    const narrowed = await searchLiterature({ query: "x", sort: "date" }, new LRUBackend(), [
      fakeAdapter("pubmed", [
        record("Q1", "2026 Feb", []),
        { ...record("Q2", "2026", []), epubDate: "2026 Jun 24" },
        record("Q3", "2026 Oct 3", []),
        { ...record("Q4", "2026 Oct", []), epubDate: "2026 Oct 20" },
        { ...record("Q5", "2026 Dec", []), epubDate: "2026 Sep 1" },
      ]),
    ]);
    expect(narrowed.articles.map((a) => a.pmid)).toEqual(["Q4", "Q3", "Q5", "Q2", "Q1"]);

    const byRelevance = await searchLiterature({ query: "x", database: "pubmed" }, new LRUBackend(), [fakeAdapter("pubmed", pubmed)]);
    expect(byRelevance.articles.map((a) => a.pmid)).toEqual(["P2", "P4", "P0", "P1", "P3"]);
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

  it("raises INVALID_INPUT for an unknown database, so a typo can't pass for an empty result", async () => {
    await expect(searchLiterature({ query: "x", database: "nope" })).rejects.toMatchObject({
      code: "INVALID_INPUT",
      userMessage: expect.stringContaining('Unknown database "nope"'),
    });
    await expect(searchLiterature({ query: "x", database: ["pubmed", "scopus"] })).rejects.toMatchObject({
      code: "INVALID_INPUT",
      userMessage: expect.stringContaining('"scopus"'),
    });
    await expect(searchLiterature({ query: "x" }, new LRUBackend(), [])).rejects.toMatchObject({ code: "INVALID_INPUT" });
  });
});

describe("searchLiterature input and design filters", () => {
  it("raises INVALID_INPUT for an empty query and for dates PubMed would silently ignore", async () => {
    const adapters = [fakeAdapter("pubmed", [pubmedMeta])];
    await expect(searchLiterature({ query: "  " }, new LRUBackend(), adapters)).rejects.toMatchObject({ code: "INVALID_INPUT" });
    for (const dateRange of [{ from: "2020-13" }, { to: "2021-02-30" }, { from: "last year" }, { from: "2022", to: "2021" }]) {
      await expect(searchLiterature({ query: "x", dateRange }, new LRUBackend(), adapters), JSON.stringify(dateRange)).rejects.toMatchObject({
        code: "INVALID_INPUT",
      });
    }
    // The same year as both bounds is a valid range.
    await expect(searchLiterature({ query: "x", dateRange: { from: "2021", to: "2021" } }, new LRUBackend(), adapters)).resolves.toBeDefined();
  });

  it("reads database ids case-insensitively", () => {
    expect(adaptersFor("PubMed").map((a) => a.id)).toEqual(["pubmed"]);
    expect(adaptersFor([" EuropePMC ", "pubmed", "pubmed"]).map((a) => a.id)).toEqual(["europepmc", "pubmed"]);
    expect(adaptersFor(undefined).map((a) => a.id)).toEqual(["pubmed"]);
    expect(adaptersFor([]).map((a) => a.id)).toEqual(["pubmed"]);
    expect(adaptersFor("ALL")).toHaveLength(4);
  });

  it("doesn't search a database without design metadata under a design filter, and says so", async () => {
    const search = vi.fn(async () => ({ count: 1, ids: ["C1"] }));
    const china: DatabaseAdapter = { ...fakeAdapter("chinaxiv", [chinaxivRct]), name: "ChinaXiv", designMetadata: false, search };
    const out = await searchLiterature(
      { query: "x", database: "all", studyTypes: ["randomized-controlled-trial"] },
      new LRUBackend(),
      [fakeAdapter("europepmc", [epmcRct]), china],
    );
    expect(out.articles.map((a) => a.pmid)).toEqual(["E1"]);
    expect(search).not.toHaveBeenCalled();
    expect(out.warnings?.some((w) => w.startsWith("ChinaXiv not searched"))).toBe(true);

    // Without a filter it is searched as usual.
    await searchLiterature({ query: "x", database: "all" }, new LRUBackend(), [china]);
    expect(search).toHaveBeenCalledTimes(1);
  });

  it("searches nothing for designs metadata never assigns, and says why", async () => {
    const search = vi.fn(async () => ({ count: 1, ids: ["1"] }));
    const out = await searchLiterature({ query: "x", studyTypes: ["cohort"] }, new LRUBackend(), [
      { ...fakeAdapter("pubmed", [pubmedMeta]), search },
    ]);
    expect(out).toMatchObject({ articles: [], total: 0 });
    expect(search).not.toHaveBeenCalled();
    expect(out.warnings?.[0]).toContain("cohort");
  });

  it("explains a studyTypes filter that minDesignTier contradicts", async () => {
    const out = await searchLiterature({ query: "x", studyTypes: ["systematic-review"], minDesignTier: 1 }, new LRUBackend(), [
      fakeAdapter("pubmed", [pubmedMeta]),
    ]);
    expect(out.articles).toEqual([]);
    expect(out.warnings).toEqual([expect.stringContaining("minDesignTier 1 leaves out every record with an unknown design tier")]);
  });

  it("names the study types below minDesignTier, and doesn't blame the animal-study label for them", async () => {
    const vet: NcbiArticle = { ...epmcRct, pmid: "V1", doi: "10.1/vet", publicationTypes: ["Clinical Trial, Veterinary"] };
    const out = await searchLiterature(
      { query: "x", database: "europepmc", studyTypes: ["animal-study", "review", "randomized-controlled-trial"], minDesignTier: 2 },
      new LRUBackend(),
      [fakeAdapter("europepmc", [epmcRct, vet])],
    );
    expect(out.articles.map((a) => a.pmid)).toEqual(["E1"]);
    expect(out.warnings).toEqual([
      "animal-study (designTier 0) and review (designTier 1) records are below minDesignTier 2, so none are kept. Lower minDesignTier to keep them.",
    ]);
  });

  it("explains an animal-study filter that finds none: lab-animal studies show up as a flag instead", async () => {
    // The review's semaglutide search: no veterinary record, so no animal-study label (2026-10-22).
    const mouseStudy: NcbiArticle = { ...epmcRct, pmid: "M1", publicationTypes: ["Journal Article"], meshHeadings: ["Animals", "Mice"] };
    const out = await searchLiterature({ query: "x", database: "europepmc", studyTypes: ["animal-study"] }, new LRUBackend(), [
      fakeAdapter("europepmc", [mouseStudy]),
    ]);
    expect(out.articles).toEqual([]);
    expect(out.warnings).toEqual([expect.stringContaining("flagged animals-not-humans")]);

    const vet: NcbiArticle = { ...epmcRct, pmid: "V1", publicationTypes: ["Clinical Trial, Veterinary"] };
    const found = await searchLiterature({ query: "x", database: "europepmc", studyTypes: ["animal-study"] }, new LRUBackend(), [
      fakeAdapter("europepmc", [vet]),
    ]);
    expect(found.articles.map((a) => a.pmid)).toEqual(["V1"]);
    expect(found.warnings).toBeUndefined();
  });

  it("passes on a database's warning about records it returned incomplete, in a search and a fetch", async () => {
    const incomplete: DatabaseAdapter = {
      ...fakeAdapter("pubmed", [pubmedMeta]),
      name: "PubMed / NCBI",
      fetch: async (ids, _cache, warn) => {
        warn?.("Some abstracts could not be fetched; those articles lack abstracts, MeSH headings and retraction/correction links.");
        return [pubmedMeta].filter((a) => ids.includes(a.pmid));
      },
    };
    const searched = await searchLiterature({ query: "x" }, new LRUBackend(), [incomplete]);
    expect(searched.warnings).toEqual([expect.stringMatching(/^PubMed \/ NCBI: Some abstracts could not be fetched/)]);
    const fetched = await fetchLiterature({ ids: ["1", "2"], database: "pubmed" }, new LRUBackend(), incomplete);
    expect(fetched.warnings).toEqual([expect.stringContaining("Some abstracts could not be fetched"), "1 id(s) could not be fetched from PubMed / NCBI."]);
  });

  it("treats an empty studyTypes list as no filter", async () => {
    const out = await searchLiterature({ query: "x", studyTypes: [] }, new LRUBackend(), [fakeAdapter("pubmed", [pubmedMeta])]);
    expect(out.articles.map((a) => a.pmid)).toEqual(["1"]);
  });

  it("passes on a database's explanation of an empty result", async () => {
    const quiet: DatabaseAdapter = {
      ...fakeAdapter("chinaxiv", []),
      search: async () => ({ count: 0, ids: [], warning: "ChinaXiv matched nothing: try fewer words." }),
    };
    const out = await searchLiterature({ query: "a b", database: "all" }, new LRUBackend(), [fakeAdapter("pubmed", [pubmedMeta]), quiet]);
    expect(out.warnings).toContain("ChinaXiv matched nothing: try fewer words.");
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

  it("raises INVALID_INPUT for an unknown database", async () => {
    await expect(fetchLiterature({ ids: ["S1"], database: "unknown-db" }, new LRUBackend())).rejects.toMatchObject({
      code: "INVALID_INPUT",
    });
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

describe("dateKey", () => {
  it("reads the date forms the databases report, in chronological order", () => {
    expect(dateKey("2021 Mar 15")).toBe(20210315);
    expect(dateKey("2019 Nov-Dec")).toBe(20191100);
    expect(dateKey("2019 Dec 15-31")).toBe(20191215);
    expect(dateKey("2020 Sept")).toBe(20200900);
    expect(dateKey("2021 Spring")).toBe(20210000);
    expect(dateKey("2021")).toBe(20210000);
    expect(dateKey("2024-12-16")).toBe(20241216);
    expect(dateKey("2026/06/24")).toBe(20260624);
    expect(dateKey("")).toBeUndefined();
    expect(dateKey(undefined)).toBeUndefined();
  });
});
