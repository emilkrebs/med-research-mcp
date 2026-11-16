import { describe, it, expect, vi } from "vitest";
import { searchLiterature, fetchLiterature } from "../src/core/literature";
import { adaptersFor } from "../src/core/adapters/registry";
import { ChinaRXivAdapter } from "../src/core/adapters/chinarxiv";
import { SovietRxivAdapter } from "../src/core/adapters/russiarxiv";
import type { AdapterHttp } from "../src/core/adapters/http";
import { cleanDoi, dateKey, doiKey, isoDateBound, pageWindow, withoutPubMedTags } from "../src/core/adapters/util";
import { errors } from "../src/core/errors";
import { LRUBackend } from "../src/core/cache";
import type { DatabaseAdapter } from "../src/core/adapters/types";
import type { NcbiArticle, SearchInput } from "../src/core/types";

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

  it("doesn't add the generic zero warning when a design filter or a failed database explains it", async () => {
    const filtered = await searchLiterature(
      { query: "x", database: "europepmc", studyTypes: ["randomized-controlled-trial"] },
      new LRUBackend(),
      [fakeAdapter("europepmc", [], 0)],
    );
    expect(filtered.warnings ?? []).not.toContainEqual(expect.stringContaining("not evidence of absence"));
    const tiered = await searchLiterature({ query: "x y", database: "europepmc", minDesignTier: 4 }, new LRUBackend(), [fakeAdapter("europepmc", [], 0)]);
    expect(tiered.warnings ?? []).not.toContainEqual(expect.stringContaining("not evidence of absence"));

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

  it("warns that a zero under a dateRange names the range and is not evidence of absence", async () => {
    // Two models read 0 results under a dateRange, with no warning and no trace of the filter in the result,
    // as the filter having been ignored.
    const run = (dateRange: { from?: string; to?: string }, query = "psilocybin glucose") =>
      searchLiterature({ query, dateRange }, new LRUBackend(), [fakeAdapter("pubmed", [], 0)]);
    const both = await run({ from: "2020", to: "2021-06" });
    expect(both.warnings).toEqual([
      'No record matched the query "psilocybin glucose" within dateRange 2020 to 2021-06. This is not evidence of absence: retry without the dateRange, or with fewer keywords.',
    ]);
    expect((await run({ from: "2020" })).warnings?.[0]).toContain("within dateRange from 2020.");
    expect((await run({ to: "2021" })).warnings?.[0]).toContain("within dateRange up to 2021.");
    // One warning, not this one and the generic one.
    expect(both.warnings).toHaveLength(1);
    // A one-word query has no keywords to drop.
    expect((await run({ from: "2020" }, "psilocybin")).warnings?.[0]).toContain("or with a synonym");
    // An empty dateRange is no filter.
    const none = await run({});
    expect(none.warnings).toEqual([expect.stringContaining("No record matched every term of the query")]);
    expect(none.warnings?.[0]).not.toContain("dateRange");
  });

  it("still warns about a dateRange zero when a design filter is set, and not when records were found or a database failed", async () => {
    const filtered = await searchLiterature(
      { query: "x y", database: "europepmc", studyTypes: ["randomized-controlled-trial"], dateRange: { from: "2020" } },
      new LRUBackend(),
      [fakeAdapter("europepmc", [], 0)],
    );
    expect(filtered.warnings).toEqual([expect.stringContaining("within dateRange from 2020")]);

    const found = await searchLiterature({ query: "x y", dateRange: { from: "2020" } }, new LRUBackend(), [fakeAdapter("pubmed", [pubmedMeta])]);
    expect(found.warnings).toBeUndefined();

    const failing: DatabaseAdapter = { id: "boom", name: "Boom DB", search: async () => { throw new Error("upstream 503"); }, fetch: async () => [] };
    const partial = await searchLiterature({ query: "x y", database: "all", dateRange: { from: "2020" } }, new LRUBackend(), [fakeAdapter("pubmed", [], 0), failing]);
    expect(partial.warnings ?? []).not.toContainEqual(expect.stringContaining("not evidence of absence"));
  });

  it("tells a one-word query to try a synonym or another spelling, not to use fewer keywords", async () => {
    const one = await searchLiterature({ query: "psilocybin", database: "pubmed" }, new LRUBackend(), [fakeAdapter("pubmed", [], 0)]);
    expect(one.warnings).toEqual([
      'No record matched the query "psilocybin". This is not evidence of absence: try a synonym or another spelling, or another database.',
    ]);
    // Several databases searched: no other one to suggest from here.
    const several = await searchLiterature({ query: "psilocybin", database: "all" }, new LRUBackend(), [fakeAdapter("pubmed", [], 0), fakeAdapter("europepmc", [], 0)]);
    expect(several.warnings).toEqual([
      'No record matched the query "psilocybin". This is not evidence of absence: try a synonym or another spelling.',
    ]);
    expect(JSON.stringify(one.warnings) + JSON.stringify(several.warnings)).not.toContain("fewer");
    // Surrounding whitespace doesn't make two words.
    const padded = await searchLiterature({ query: " psilocybin ", database: "pubmed" }, new LRUBackend(), [fakeAdapter("pubmed", [], 0)]);
    expect(padded.warnings?.[0]).toContain("try a synonym");
  });

  describe("what the result says was searched", () => {
    it("lists the databases searched, in order, and the filters given", async () => {
      const out = await searchLiterature(
        { query: "x", database: "all", dateRange: { from: "2020", to: "2021" }, studyTypes: ["randomized-controlled-trial"], minDesignTier: 3 },
        new LRUBackend(),
        [fakeAdapter("pubmed", [pubmedMeta]), fakeAdapter("europepmc", [epmcRct])],
      );
      expect(out.databases).toEqual(["pubmed", "europepmc"]);
      expect(out.filters).toEqual({ dateRange: { from: "2020", to: "2021" }, studyTypes: ["randomized-controlled-trial"], minDesignTier: 3 });
    });

    it("holds only the filters the caller gave, and none when they gave none", async () => {
      const search = (input: Partial<SearchInput>) => searchLiterature({ query: "x", ...input }, new LRUBackend(), [fakeAdapter("pubmed", [pubmedMeta])]);
      expect(await search({})).not.toHaveProperty("filters");
      expect(await search({ dateRange: { to: "2021" } })).toMatchObject({ filters: { dateRange: { to: "2021" } } });
      expect((await search({ dateRange: { to: "2021" } })).filters?.dateRange).not.toHaveProperty("from");
      expect(await search({ minDesignTier: 0 })).toMatchObject({ filters: { minDesignTier: 0 } });
      // An empty dateRange or studyTypes list is no filter, as the search itself reads them.
      expect(await search({ dateRange: {}, studyTypes: [] })).not.toHaveProperty("filters");
      // Not the sort, the language or the page size: those are not filters.
      expect(await search({ sort: "date", language: "ru", maxResults: 5 })).not.toHaveProperty("filters");
    });

    it("leaves out a database skipped for lack of design metadata, and keeps one that failed", async () => {
      const china: DatabaseAdapter = { ...fakeAdapter("chinaxiv", [chinaxivRct]), designMetadata: false };
      const filtered = await searchLiterature({ query: "x", database: "all", studyTypes: ["randomized-controlled-trial"] }, new LRUBackend(), [
        fakeAdapter("europepmc", [epmcRct]),
        china,
      ]);
      expect(filtered.databases).toEqual(["europepmc"]);

      const failing: DatabaseAdapter = { id: "boom", name: "Boom DB", search: async () => { throw new Error("upstream 503"); }, fetch: async () => [] };
      const partial = await searchLiterature({ query: "x", database: "all" }, new LRUBackend(), [fakeAdapter("pubmed", [pubmedMeta]), failing]);
      expect(partial.databases).toEqual(["pubmed", "boom"]);
      expect(partial.warnings).toEqual([expect.stringContaining("Boom DB search failed")]);
    });

    it("says so on the early returns that search nothing too", async () => {
      const never = await searchLiterature({ query: "x", studyTypes: ["cohort"], dateRange: { from: "2020" } }, new LRUBackend(), [fakeAdapter("pubmed", [pubmedMeta])]);
      expect(never).toMatchObject({ articles: [], databases: [], filters: { studyTypes: ["cohort"], dateRange: { from: "2020" } } });

      const china: DatabaseAdapter = { ...fakeAdapter("chinaxiv", [chinaxivRct]), designMetadata: false };
      const skipped = await searchLiterature({ query: "x", database: "chinaxiv", minDesignTier: 4 }, new LRUBackend(), [china]);
      expect(skipped).toMatchObject({ articles: [], databases: [], filters: { minDesignTier: 4 } });
      expect(skipped.warnings?.some((w) => w.startsWith("chinaxiv not searched"))).toBe(true);
    });
  });

  describe("total across several databases", () => {
    // Two databases hold the same records: the sum counted each twice, 4 for 2 articles.
    const shared: NcbiArticle[] = [pubmedMeta, { ...epmcRct, pmid: "2", doi: "10.1234/second" }];
    const copies = (id: string): NcbiArticle[] => shared.map((a) => ({ ...a, pmid: `${id}-${a.pmid}` }));

    it("counts a record held by two databases twice, and says how many each database reported", async () => {
      const out = await searchLiterature({ query: "x", database: "all" }, new LRUBackend(), [
        fakeAdapter("pubmed", copies("p")),
        fakeAdapter("europepmc", copies("e")),
      ]);
      expect(out.articles).toHaveLength(2);
      expect(out.total).toBe(4);
      expect(out.totalByDatabase).toEqual({ pubmed: 2, europepmc: 2 });
    });

    it("gives each database's own count, in the order searched", async () => {
      const out = await searchLiterature({ query: "x", database: "all" }, new LRUBackend(), [
        fakeAdapter("pubmed", [pubmedMeta], 100),
        fakeAdapter("europepmc", [epmcRct], 7),
        fakeAdapter("chinaxiv", [], 0),
      ]);
      expect(out.totalByDatabase).toEqual({ pubmed: 100, europepmc: 7, chinaxiv: 0 });
      expect(Object.keys(out.totalByDatabase!)).toEqual(["pubmed", "europepmc", "chinaxiv"]);
      expect(out.total).toBe(107);
    });

    it("leaves a failed database out of it, and sets none for a single database", async () => {
      const failing: DatabaseAdapter = { id: "boom", name: "Boom DB", search: async () => { throw new Error("upstream 503"); }, fetch: async () => [] };
      const partial = await searchLiterature({ query: "x", database: "all" }, new LRUBackend(), [fakeAdapter("pubmed", [pubmedMeta], 9), failing]);
      expect(partial.totalByDatabase).toEqual({ pubmed: 9 });
      expect(partial.totalByDatabase).not.toHaveProperty("boom");

      const single = await searchLiterature({ query: "x" }, new LRUBackend(), [fakeAdapter("pubmed", [pubmedMeta], 9)]);
      expect(single.total).toBe(9);
      expect(single).not.toHaveProperty("totalByDatabase");
    });

    it("sets none when a design filter left a single database to search", async () => {
      const china: DatabaseAdapter = { ...fakeAdapter("chinaxiv", [chinaxivRct]), designMetadata: false };
      const out = await searchLiterature({ query: "x", database: "all", studyTypes: ["randomized-controlled-trial"] }, new LRUBackend(), [fakeAdapter("europepmc", [epmcRct], 7), china]);
      expect(out.total).toBe(7);
      expect(out).not.toHaveProperty("totalByDatabase");
    });
  });

  describe("one warning when several databases match nothing for the same reason", () => {
    const sentence = "matched nothing: it returns only records containing every word of the query and treats AND/OR as words. Try one or two key words.";
    /** An adapter that found nothing and says why, like the ChinaRxiv ones. */
    const silent = (id: string, name: string, emptyReason?: "every-word"): DatabaseAdapter => ({
      ...fakeAdapter(id, []),
      name,
      search: async () => ({ count: 0, ids: [], warning: `${name} ${sentence}`, ...(emptyReason ? { emptyReason } : {}) }),
    });

    it("names them all in a single warning, in the order requested", async () => {
      const out = await searchLiterature({ query: "a b", database: "all" }, new LRUBackend(), [
        silent("chinaxiv", "ChinaXiv (via ChinaRxiv)", "every-word"),
        silent("russiarxiv", "RussiaRxiv (via ChinaRxiv)", "every-word"),
      ]);
      expect(out.warnings).toEqual([
        "ChinaXiv (via ChinaRxiv) and RussiaRxiv (via ChinaRxiv) matched nothing: they return only records containing every word of the query and treat AND/OR as words. Try one or two key words.",
        // PubMed-style generic warning: nothing matched anywhere.
        expect.stringContaining('No record matched every term of the query "a b"'),
      ]);
    });

    it("lists three or more with commas", async () => {
      const out = await searchLiterature({ query: "a b", database: "all" }, new LRUBackend(), [
        silent("one", "One", "every-word"),
        silent("two", "Two", "every-word"),
        silent("three", "Three", "every-word"),
      ]);
      expect(out.warnings?.[0]).toMatch(/^One, Two and Three matched nothing: they return only records/);
    });

    it("keeps a lone database's own warning, as a single-database search always has", async () => {
      const lone = await searchLiterature({ query: "a b", database: "chinaxiv" }, new LRUBackend(), [silent("chinaxiv", "ChinaXiv (via ChinaRxiv)", "every-word")]);
      expect(lone.warnings?.[0]).toBe(`ChinaXiv (via ChinaRxiv) ${sentence}`);
      // One of the two databases found something: the other keeps its own warning.
      const mixed = await searchLiterature({ query: "a b", database: "all" }, new LRUBackend(), [
        fakeAdapter("pubmed", [pubmedMeta]),
        silent("chinaxiv", "ChinaXiv (via ChinaRxiv)", "every-word"),
      ]);
      expect(mixed.warnings).toEqual([`ChinaXiv (via ChinaRxiv) ${sentence}`]);
    });

    it("does so for the real ChinaXiv and RussiaRxiv adapters, which answer a many-word query with nothing", async () => {
      const empty: AdapterHttp = { json: async <T>() => ({ data: [], total: 0 }) as T, text: async () => "" };
      const adapters = [new ChinaRXivAdapter(empty), new SovietRxivAdapter(empty)];
      const out = await searchLiterature({ query: "vitamin depression", database: ["chinaxiv", "russiarxiv"] }, new LRUBackend(), adapters);
      const matched = out.warnings!.filter((w) => w.includes("matched nothing"));
      expect(matched).toEqual([
        "ChinaXiv (via ChinaRxiv) and RussiaRxiv (via ChinaRxiv) matched nothing: they return only records containing every word of the query and treat AND/OR as words. Try one or two key words.",
      ]);
      // Alone, each keeps the warning it always had.
      const alone = await searchLiterature({ query: "vitamin depression", database: "russiarxiv" }, new LRUBackend(), [adapters[1]!]);
      expect(alone.warnings?.[0]).toMatch(/^RussiaRxiv \(via ChinaRxiv\) matched nothing: it returns only records containing every word/);
      // One word is not explained by that rule.
      const oneWord = await searchLiterature({ query: "vitamin", database: ["chinaxiv", "russiarxiv"] }, new LRUBackend(), adapters);
      expect(oneWord.warnings!.some((w) => w.includes("matched nothing"))).toBe(false);
    });

    it("doesn't merge warnings that carry no reason, or a database's warning with another's", async () => {
      const out = await searchLiterature({ query: "a b", database: "all" }, new LRUBackend(), [
        silent("chinaxiv", "ChinaXiv (via ChinaRxiv)"),
        silent("russiarxiv", "RussiaRxiv (via ChinaRxiv)"),
      ]);
      expect(out.warnings?.slice(0, 2)).toEqual([`ChinaXiv (via ChinaRxiv) ${sentence}`, `RussiaRxiv (via ChinaRxiv) ${sentence}`]);
    });
  });

  describe("abstractMaxChars", () => {
    const LONG = "alpha beta gamma delta epsilon"; // 30 characters
    const record = (pmid: string, abstract?: string, extra: Partial<NcbiArticle> = {}): NcbiArticle => ({
      ...pubmedMeta,
      pmid,
      doi: undefined,
      ...(abstract !== undefined ? { abstract } : {}),
      ...extra,
    });
    const search = (articles: NcbiArticle[], abstractMaxChars?: number) =>
      searchLiterature({ query: "x", ...(abstractMaxChars !== undefined ? { abstractMaxChars } : {}) }, new LRUBackend(), [fakeAdapter("pubmed", articles)]);

    it("returns whole abstracts when absent, whatever their length", async () => {
      const long = "word ".repeat(2_000).trim();
      const out = await search([record("1", long), record("2")]);
      expect(out.articles[0]!.abstract).toBe(long);
      expect(out.articles[0]).not.toHaveProperty("abstractTruncated");
      expect(out.articles[1]).not.toHaveProperty("abstract");
    });

    it("cuts a longer abstract at a word boundary, ends it with an ellipsis within the limit, and flags it", async () => {
      const out = await search([record("1", LONG)], 20);
      expect(out.articles[0]).toMatchObject({ abstract: "alpha beta gamma…", abstractTruncated: true });
    });

    it("never goes past the limit, and cuts between words whenever a first word fits", async () => {
      for (let max = 6; max < LONG.length; max++) {
        const { abstract } = (await search([record("1", LONG)], max)).articles[0]!;
        expect(abstract!.length, `max ${max}`).toBeLessThanOrEqual(max);
        expect(abstract!.endsWith("…"), `max ${max}`).toBe(true);
        const kept = abstract!.slice(0, -1);
        expect(LONG.startsWith(kept), `max ${max}`).toBe(true);
        expect(LONG[kept.length], `max ${max}`).toBe(" ");
      }
    });

    it("leaves an abstract that fits alone, with no flag, and cuts one a single character over", async () => {
      const fits = await search([record("1", LONG)], LONG.length);
      expect(fits.articles[0]!.abstract).toBe(LONG);
      expect(fits.articles[0]).not.toHaveProperty("abstractTruncated");
      const over = await search([record("1", LONG)], LONG.length - 1);
      expect(over.articles[0]).toMatchObject({ abstract: "alpha beta gamma delta…", abstractTruncated: true });
      expect(over.articles[0]!.abstract!.length).toBeLessThanOrEqual(LONG.length - 1);
    });

    it("ends the cut at the last word, not on the whitespace before it, and counts a newline as one", async () => {
      expect((await search([record("1", "alpha  beta gamma")], 9)).articles[0]!.abstract).toBe("alpha…");
      expect((await search([record("1", "alpha\nbeta gamma")], 10)).articles[0]!.abstract).toBe("alpha…");
      expect((await search([record("1", "alpha beta gamma")], 11)).articles[0]!.abstract).toBe("alpha beta…");
    });

    it("cuts a text without spaces where it stands, not through a surrogate pair", async () => {
      expect((await search([record("1", "中".repeat(50))], 11)).articles[0]!.abstract).toBe(`${"中".repeat(10)}…`);
      // Budget 3 would end between the two halves of the second emoji.
      expect((await search([record("1", "😀".repeat(20))], 4)).articles[0]!.abstract).toBe("😀…");
    });

    it("leaves the abstract out for 0, flags an article that had one, and not one that had none", async () => {
      const out = await search([record("1", LONG), record("2")], 0);
      expect(out.articles[0]).toMatchObject({ pmid: "1", abstractTruncated: true });
      expect(out.articles[0]).not.toHaveProperty("abstract");
      // Told apart from an omitted one: nothing was left out of this record.
      expect(out.articles[1]).toMatchObject({ pmid: "2" });
      expect(out.articles[1]).not.toHaveProperty("abstract");
      expect(out.articles[1]).not.toHaveProperty("abstractTruncated");
    });

    it("leaves the abstract out when nothing of it would fit before the ellipsis", async () => {
      const out = await search([record("1", LONG)], 1);
      expect(out.articles[0]).toMatchObject({ abstractTruncated: true });
      expect(out.articles[0]).not.toHaveProperty("abstract");
    });

    it("never clears an abstractTruncated an adapter set, whether or not it cuts more", async () => {
      // A ChinaXiv search preview, cut at 500 characters by the database.
      const preview = record("C1", LONG, { abstractTruncated: true });
      expect((await search([preview], 1_000)).articles[0]).toMatchObject({ abstract: LONG, abstractTruncated: true });
      expect((await search([preview])).articles[0]).toMatchObject({ abstract: LONG, abstractTruncated: true });
      expect((await search([preview], 20)).articles[0]).toMatchObject({ abstract: "alpha beta gamma…", abstractTruncated: true });
      // Without an abstract there is nothing to cut: the adapter's word stands.
      expect((await search([record("C2", undefined, { abstractTruncated: true })], 0)).articles[0]).toMatchObject({ abstractTruncated: true });
    });

    it("doesn't change the adapter's own records", async () => {
      const own = record("1", LONG);
      await search([own], 10);
      expect(own.abstract).toBe(LONG);
      expect(own).not.toHaveProperty("abstractTruncated");
    });

    it("applies after de-duplication, to the copy that is kept, and across databases", async () => {
      const longEpmc = { ...epmcRct, abstract: LONG, doi: "10.1590/shared" };
      const out = await searchLiterature({ query: "x", database: "all", abstractMaxChars: 20 }, new LRUBackend(), [
        fakeAdapter("pubmed", [{ ...pubmedMeta, abstract: "a different abstract of the same paper" }]),
        fakeAdapter("europepmc", [longEpmc]),
        fakeAdapter("chinaxiv", [record("C1", LONG, { database: "chinaxiv", doi: "10.2074/other" })]),
      ]);
      // The RCT copy outranks the unrated meta-analysis copy that shares its DOI.
      expect(out.articles.map((a) => a.pmid)).toEqual(["E1", "C1"]);
      expect(out.articles.map((a) => a.abstract)).toEqual(["alpha beta gamma…", "alpha beta gamma…"]);
      expect(out.articles.every((a) => a.abstractTruncated)).toBe(true);
    });

    it("leaves ordering, filtering and the total to the full abstracts: only the text changes", async () => {
      const articles = [record("1", LONG, { publicationTypes: ["Case Reports"] }), record("2", LONG, { publicationTypes: ["Randomized Controlled Trial"] })];
      const full = await search(articles);
      const capped = await search(articles, 8);
      expect(capped.articles.map((a) => [a.pmid, a.studyType, a.designTier])).toEqual(full.articles.map((a) => [a.pmid, a.studyType, a.designTier]));
      expect(capped.total).toBe(full.total);
    });

    it("raises INVALID_INPUT for a limit that isn't a whole number, 0 or more, before searching", async () => {
      const searchSpy = vi.fn(async (_input: SearchInput) => ({ count: 1, ids: ["1"] }));
      const adapters: DatabaseAdapter[] = [{ ...fakeAdapter("pubmed", [pubmedMeta]), search: searchSpy }];
      for (const abstractMaxChars of [-1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, "10" as unknown as number, null as unknown as number]) {
        await expect(searchLiterature({ query: "x", abstractMaxChars }, new LRUBackend(), adapters), String(abstractMaxChars)).rejects.toMatchObject({
          code: "INVALID_INPUT",
          userMessage: expect.stringContaining("abstractMaxChars"),
        });
      }
      expect(searchSpy).not.toHaveBeenCalled();
      await expect(searchLiterature({ query: "x", abstractMaxChars: 0 }, new LRUBackend(), adapters)).resolves.toBeDefined();
    });
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

describe("searchLiterature paging", () => {
  const run = (input: Partial<SearchInput>, ...counts: number[]) =>
    searchLiterature({ query: "x", ...input }, new LRUBackend(), counts.map((count, i) => fakeAdapter(`db${i}`, [], count)));

  it("returns the page asked for, 1 by default, and hands it to each database", async () => {
    const search = vi.fn(async (_input: SearchInput) => ({ count: 100, ids: ["1"] }));
    const adapter: DatabaseAdapter = { ...fakeAdapter("pubmed", [pubmedMeta]), search };
    expect(await searchLiterature({ query: "x" }, new LRUBackend(), [adapter])).toMatchObject({ page: 1, nextPage: 2 });
    expect(await searchLiterature({ query: "x", page: 3 }, new LRUBackend(), [adapter])).toMatchObject({ page: 3, nextPage: 4 });
    expect(search).toHaveBeenLastCalledWith(expect.objectContaining({ page: 3 }));
  });

  it("returns the page even when nothing is searched", async () => {
    const chinaxiv: DatabaseAdapter = { ...fakeAdapter("chinaxiv", [chinaxivRct]), designMetadata: false };
    const none = await searchLiterature({ query: "x", studyTypes: ["cohort"], page: 2 }, new LRUBackend(), [fakeAdapter("pubmed", [pubmedMeta])]);
    expect(none).toMatchObject({ articles: [], page: 2, maxResults: 10 });
    const skipped = await searchLiterature({ query: "x", database: "chinaxiv", studyTypes: ["randomized-controlled-trial"], page: 2 }, new LRUBackend(), [chinaxiv]);
    expect(skipped).toMatchObject({ articles: [], page: 2, maxResults: 10 });
  });

  it("returns the page size, so that nextPage is asked for with it", async () => {
    expect(await run({}, 11)).toMatchObject({ maxResults: 10, nextPage: 2 });
    expect(await run({ maxResults: 20 }, 50)).toMatchObject({ maxResults: 20, nextPage: 2 });
    expect(await run({ maxResults: 100 }, 51)).toMatchObject({ maxResults: 50 });
  });

  it("sets nextPage while a database has records past the page, and not once every count is within it", async () => {
    expect(await run({}, 11)).toMatchObject({ page: 1, nextPage: 2 });
    expect(await run({}, 10)).not.toHaveProperty("nextPage");
    expect(await run({}, 0)).not.toHaveProperty("nextPage");
    expect(await run({ page: 2 }, 21)).toMatchObject({ page: 2, nextPage: 3 });
    expect(await run({ page: 2 }, 20)).not.toHaveProperty("nextPage");
    // The page size is maxResults, at most 50.
    expect(await run({ maxResults: 50 }, 50)).not.toHaveProperty("nextPage");
    expect(await run({ maxResults: 50 }, 51)).toMatchObject({ nextPage: 2 });
    expect(await run({ maxResults: 100 }, 51)).toMatchObject({ nextPage: 2 });
    expect(await run({ maxResults: 100 }, 50)).not.toHaveProperty("nextPage");
  });

  it("sets nextPage when only one of several databases has records past the page", async () => {
    expect(await run({ page: 2 }, 15, 25)).toMatchObject({ nextPage: 3 });
    expect(await run({ page: 2 }, 25, 15)).toMatchObject({ nextPage: 3 });
    expect(await run({ page: 2 }, 15, 20)).not.toHaveProperty("nextPage");
  });

  it("sets no nextPage when the next page would start at the 10,000th record", async () => {
    expect(await run({ page: 999 }, 50_000)).toMatchObject({ nextPage: 1000 });
    expect(await run({ page: 1000 }, 50_000)).not.toHaveProperty("nextPage");
    expect(await run({ page: 199, maxResults: 50 }, 50_000)).toMatchObject({ nextPage: 200 });
    expect(await run({ page: 200, maxResults: 50 }, 50_000)).not.toHaveProperty("nextPage");
  });

  it("follows a database's own word on whether a later page can be served", async () => {
    const capped: DatabaseAdapter = { ...fakeAdapter("pubmed", [pubmedMeta]), search: async () => ({ count: 30_000, ids: ["1"], more: false }) };
    expect(await searchLiterature({ query: "x" }, new LRUBackend(), [capped])).not.toHaveProperty("nextPage");
  });

  it("raises INVALID_INPUT for a page that isn't a whole number from 1, before searching", async () => {
    const search = vi.fn(async (_input: SearchInput) => ({ count: 1, ids: ["1"] }));
    const adapters: DatabaseAdapter[] = [{ ...fakeAdapter("pubmed", [pubmedMeta]), search }];
    for (const page of [0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
      await expect(searchLiterature({ query: "x", page }, new LRUBackend(), adapters), String(page)).rejects.toMatchObject({
        code: "INVALID_INPUT",
        userMessage: expect.stringContaining("page"),
      });
    }
    expect(search).not.toHaveBeenCalled();
    await expect(searchLiterature({ query: "x", page: 1 }, new LRUBackend(), adapters)).resolves.toMatchObject({ page: 1 });
  });

  it("raises INVALID_INPUT for a page starting at or past the 10,000th record, before searching", async () => {
    const search = vi.fn(async (_input: SearchInput) => ({ count: 50_000, ids: ["1"] }));
    const adapters: DatabaseAdapter[] = [{ ...fakeAdapter("pubmed", [pubmedMeta]), search }];
    for (const input of [
      { page: 1001 },
      { page: 201, maxResults: 50 },
      { page: 5001, maxResults: 2.5 },
      { page: 10_001, maxResults: 1 },
      { page: 1_000_000 },
    ]) {
      await expect(searchLiterature({ query: "x", ...input }, new LRUBackend(), adapters), JSON.stringify(input)).rejects.toMatchObject({
        code: "INVALID_INPUT",
        userMessage: expect.stringContaining("Narrow the query"),
      });
    }
    expect(search).not.toHaveBeenCalled();
    for (const input of [{ page: 1000 }, { page: 200, maxResults: 50 }, { page: 5000, maxResults: 2.5 }, { page: 10_000, maxResults: 1 }]) {
      await expect(searchLiterature({ query: "x", ...input }, new LRUBackend(), adapters), JSON.stringify(input)).resolves.toMatchObject({
        page: input.page,
      });
    }
  });

  it("warns that a page is past the last result, when nothing is fetched for it", async () => {
    const past = await run({ page: 4 }, 25);
    expect(past).toMatchObject({ articles: [], total: 25, page: 4 });
    expect(past).not.toHaveProperty("nextPage");
    expect(past.warnings).toEqual([expect.stringContaining("Page 4 is past the last result")]);

    // The last reachable page of a one-record page size is record 10,000, not a cap.
    const boundary = await run({ page: 10_000, maxResults: 1 }, 5);
    expect(boundary).toMatchObject({ articles: [], total: 5, page: 10_000, maxResults: 1 });
    expect(boundary).not.toHaveProperty("nextPage");
    expect(boundary.warnings).toEqual([expect.stringContaining("Page 10000 is past the last result")]);
  });

  it("doesn't call a page past the last result when it holds records, is the first or found nothing, and names the databases that answered when one failed", async () => {
    const adapter = (articles: NcbiArticle[], count: number) => fakeAdapter("pubmed", articles, count);
    const filled = await searchLiterature({ query: "x", page: 2 }, new LRUBackend(), [adapter([pubmedMeta], 11)]);
    expect(filled.warnings).toBeUndefined();
    // Records that the filter then drops were still found on the page.
    const filtered = await searchLiterature({ query: "x", page: 2, minDesignTier: 4 }, new LRUBackend(), [adapter([pubmedMeta], 11)]);
    expect(filtered.warnings ?? []).not.toContainEqual(expect.stringContaining("past the last result"));
    const first = await searchLiterature({ query: "x" }, new LRUBackend(), [adapter([], 25)]);
    expect(first.warnings).toBeUndefined();
    const empty = await searchLiterature({ query: "x", page: 2 }, new LRUBackend(), [adapter([], 0)]);
    expect(empty.warnings).toEqual([expect.stringContaining("not evidence of absence")]);

    const failing: DatabaseAdapter = {
      id: "boom",
      name: "Boom DB",
      search: async () => {
        throw new Error("upstream 503");
      },
      fetch: async () => [],
    };
    const partial = await searchLiterature({ query: "x", database: "all", page: 4 }, new LRUBackend(), [adapter([], 25), failing]);
    expect(partial.warnings).toEqual([
      expect.stringContaining("Boom DB search failed"),
      "Page 4 is past the last result: the databases that answered have no more records for this query.",
    ]);
  });

  it("doesn't call a page past the last result while a database still counts records beyond it", async () => {
    // One database is exhausted, the other isn't: the page is empty only because the other served no ids.
    expect((await run({ page: 2 }, 5, 25)).warnings).toBeUndefined();
    // ids came back but fetch returned nothing: not the end of the results.
    const unfetched: DatabaseAdapter = { ...fakeAdapter("pubmed", [], 100), search: async () => ({ count: 100, ids: ["1"] }), fetch: async () => [] };
    expect((await searchLiterature({ query: "x", page: 2 }, new LRUBackend(), [unfetched])).warnings).toBeUndefined();
  });

  it("passes on a database's warning about a page it can't serve, without calling the page past the end", async () => {
    const warning = "PubMed serves only the first 9,999 records of a search.";
    const capped: DatabaseAdapter = { ...fakeAdapter("pubmed", [], 50_000), search: async () => ({ count: 50_000, ids: [], warning }) };
    const out = await searchLiterature({ query: "x", page: 200, maxResults: 50 }, new LRUBackend(), [capped]);
    expect(out).toMatchObject({ articles: [], total: 50_000, page: 200 });
    expect(out.warnings).toEqual([warning]);
  });

  it("doesn't call a page past the last result when a database counts 50,000 records but serves none", async () => {
    const silent: DatabaseAdapter = { ...fakeAdapter("pubmed", [], 50_000), search: async () => ({ count: 50_000, ids: [] }) };
    const out = await searchLiterature({ query: "x", page: 2 }, new LRUBackend(), [silent]);
    expect(out).toMatchObject({ articles: [], total: 50_000, page: 2, nextPage: 3 });
    expect(out.warnings).toBeUndefined();
  });
});

describe("pageWindow", () => {
  it("is the first 10 records by default, with the size clamped to 1 to 50 and the page to 1 or more", () => {
    expect(pageWindow({})).toEqual({ offset: 0, size: 10 });
    expect(pageWindow({ page: 3, maxResults: 20 })).toEqual({ offset: 40, size: 20 });
    expect(pageWindow({ page: 2, maxResults: 500 })).toEqual({ offset: 50, size: 50 });
    expect(pageWindow({ page: 2, maxResults: 0 })).toEqual({ offset: 1, size: 1 });
    expect(pageWindow({ page: 0 })).toEqual({ offset: 0, size: 10 });
  });

  it("floors a fractional maxResults", () => {
    expect(pageWindow({ maxResults: 2.5 })).toEqual({ offset: 0, size: 2 });
    expect(pageWindow({ page: 3, maxResults: 2.5 })).toEqual({ offset: 4, size: 2 });
    expect(pageWindow({ maxResults: 0.5 })).toEqual({ offset: 0, size: 1 });
    expect(pageWindow({ maxResults: 50.9 })).toEqual({ offset: 0, size: 50 });
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

  describe("grading", () => {
    // A model that looked up a retracted RCT by PMID got no studyType, designTier or flags, and missed that the design is graded.
    const retractedRct: NcbiArticle = {
      ...epmcRct,
      pmid: "9",
      doi: "10.1234/retracted",
      publicationTypes: ["Randomized Controlled Trial", "Journal Article", "Retracted Publication"],
      database: undefined,
    };

    it("classifies every fetched article like a search result does", async () => {
      const out = await fetchLiterature({ ids: ["9", "1", "C1"], database: "pubmed" }, new LRUBackend(), fakeAdapter("pubmed", [retractedRct, pubmedMeta, chinaxivRct]));
      expect(out.articles.map((a) => a.pmid)).toEqual(["9", "1", "C1"]);
      expect(out.articles[0]).toMatchObject({ studyType: "randomized-controlled-trial", designTier: 0, flags: ["retracted"] });
      expect(out.articles[1]).toMatchObject({ studyType: "meta-analysis", designTier: null });
      expect(out.articles[2]).toMatchObject({ studyType: "unknown", designTier: null });
      expect(out.articles[1]).not.toHaveProperty("flags");
    });

    it("returns what a search returns for the same record, with the MeSH headings added", async () => {
      const adapter = fakeAdapter("europepmc", [epmcRct]);
      const searched = await searchLiterature({ query: "x", database: "europepmc" }, new LRUBackend(), [adapter]);
      const fetched = await fetchLiterature({ ids: ["E1"], database: "europepmc" }, new LRUBackend(), adapter);
      expect(fetched.articles[0]).toEqual({ ...searched.articles[0], meshHeadings: ["Creatine", "Humans", "Aged"] });
    });

    it("grades the complete records of an adapter that serves them separately, and returns the whole abstract", async () => {
      const preview: NcbiArticle = { ...chinaxivRct, abstract: "short preview", abstractTruncated: true };
      const complete: NcbiArticle = { ...chinaxivRct, abstract: "the complete abstract, which goes on far past the preview" };
      const adapter: DatabaseAdapter = { ...fakeAdapter("chinaxiv", [preview]), fetchFull: async () => [complete] };
      const out = await fetchLiterature({ ids: ["C1"], database: "chinaxiv" }, new LRUBackend(), adapter);
      expect(out.articles[0]).toMatchObject({ abstract: complete.abstract, studyType: "unknown", designTier: null });
      expect(out.articles[0]).not.toHaveProperty("abstractTruncated");
    });

    it("grades nothing for a missing id, and still reports it", async () => {
      const out = await fetchLiterature({ ids: ["9", "404"], database: "pubmed" }, new LRUBackend(), fakeAdapter("pubmed", [retractedRct]));
      expect(out.articles).toHaveLength(1);
      expect(out.missing).toEqual(["404"]);
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
