import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { searchLiterature, resetProbeAllowance } from "../src/core/literature";
import { ChinaRXivAdapter } from "../src/core/adapters/chinarxiv";
import { SovietRxivAdapter } from "../src/core/adapters/russiarxiv";
import { EuropePmcAdapter } from "../src/core/adapters/europepmc";
import type { AdapterHttp } from "../src/core/adapters/http";
import type { DatabaseAdapter } from "../src/core/adapters/types";
import { LRUBackend } from "../src/core/cache";
import type { NcbiArticle, SearchInput } from "../src/core/types";

/** Searches that end without saying why: a query ChinaXiv and RussiaRxiv can't match, and Europe PMC's last reachable page. */

const pubmedRecord: NcbiArticle = {
  id: "1",
  title: "Metformin and glycaemic control",
  authors: ["Doe J"],
  journal: "J Test",
  pubDate: "2020",
  publicationTypes: ["Randomized Controlled Trial"],
};

describe("a query in another script, searched in ChinaXiv or RussiaRxiv", () => {
  // The two corpora find nothing for a query that is not English: 糖尿病 0 against diabetes 292 on ChinaXiv (2026-11-28).
  // The fake API does the same: a query with a character outside ASCII matches nothing, any other query 5 records.
  function chinaRxiv() {
    const urls: URLSearchParams[] = [];
    const http: AdapterHttp = {
      json: async <T>(url: string) => {
        const params = new URL(url).searchParams;
        urls.push(params);
        const found = /^[\x20-\x7e]*$/.test(params.get("q") ?? "");
        const record = { id: `${params.get("source")}-1`, title: "A record", source: params.get("source"), source_language: "en" };
        return { data: found ? [record] : [], total: found ? 5 : 0 } as T;
      },
      text: async () => "",
    };
    return { china: new ChinaRXivAdapter(http), russia: new SovietRxivAdapter(http), urls };
  }
  const probesOf = (urls: URLSearchParams[]) => urls.filter((u) => u.get("limit") === "1");
  const searched = (urls: URLSearchParams[]) => urls.filter((u) => u.get("limit") !== "1");

  beforeEach(() => {
    resetProbeAllowance();
    // A contact email in the environment lifts ChinaRxiv's allowance from 30 requests a minute to 300.
    vi.stubEnv("MED_RESEARCH_CHINAXIV_EMAIL", "");
    vi.stubEnv("NCBI_EMAIL", "");
  });
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  const chinaWarning =
    "The query holds CJK or Cyrillic letters, but ChinaXiv is searched in English: ChinaRxiv matches a query against its English " +
    "machine translation, so the query finds little or nothing there. Query ChinaXiv in English; the query is not translated.";

  it("marks the ChinaRxiv adapters as English only, and no other", () => {
    expect(new ChinaRXivAdapter().englishOnly).toBe(true);
    expect(new SovietRxivAdapter().englishOnly).toBe(true);
    expect(new EuropePmcAdapter().englishOnly).toBeUndefined();
  });

  it("tells a one-word Chinese query on chinaxiv to be English, and gives no advice that blames the word", async () => {
    const { china, urls } = chinaRxiv();
    const out = await searchLiterature({ query: "糖尿病", database: "chinaxiv" }, new LRUBackend(), [china]);
    expect(out).toMatchObject({ total: 0, articles: [] });
    expect(out.warnings).toEqual([chinaWarning]);
    // The query went out as typed, in one request.
    expect(urls.map((u) => u.get("q"))).toEqual(["糖尿病"]);
  });

  it("does not probe two Chinese words, which would blame their number, and warns the same", async () => {
    const { china, urls } = chinaRxiv();
    const out = await searchLiterature({ query: "糖尿病 二甲双胍", database: "chinaxiv" }, new LRUBackend(), [china]);
    expect(out.warnings).toEqual([chinaWarning]);
    expect(probesOf(urls)).toEqual([]);
    expect(searched(urls)).toHaveLength(1);
    expect(out.warnings!.join(" ")).not.toMatch(/too specific|fewer|one or two key words|synonym/);
  });

  it("does the same for Russian on russiarxiv, naming RussiaRxiv", async () => {
    const { russia, urls } = chinaRxiv();
    for (const query of ["диабет", "диабет метформин"]) {
      const out = await searchLiterature({ query, database: "russiarxiv" }, new LRUBackend(), [russia]);
      expect(out.warnings).toEqual([chinaWarning.replaceAll("ChinaXiv", "RussiaRxiv")]);
    }
    expect(probesOf(urls)).toEqual([]);
  });

  it.each([
    ["Han", "糖尿病"],
    ["Hiragana", "ひらがな"],
    ["Katakana", "ダイエット"],
    ["Hangul", "당뇨병"],
    ["Cyrillic", "диабет"],
    ["a Latin word beside a Han one", "metformin 糖尿病"],
    ["a quoted phrase and a field tag", '"диабет"[tiab]'],
  ])("warns for %s letters", async (_script, query) => {
    const { china } = chinaRxiv();
    const out = await searchLiterature({ query, database: "chinaxiv" }, new LRUBackend(), [china]);
    expect(out.warnings).toEqual([chinaWarning]);
  });

  it.each(["diabetes", "β-blocker", "α-synuclein aggregation", "Müller cells", "café", "COVID-19 µg/dL"])(
    "does not warn for %s: Latin and Greek letters, and symbols, are English text",
    async (query) => {
      const { china } = chinaRxiv();
      const out = await searchLiterature({ query, database: "chinaxiv" }, new LRUBackend(), [china]);
      expect(out.warnings?.some((w) => w.includes("searched in English")) ?? false).toBe(false);
    },
  );

  it("names both databases in one warning when both are searched", async () => {
    const { china, russia, urls } = chinaRxiv();
    const out = await searchLiterature({ query: "糖尿病 二甲双胍", database: ["chinaxiv", "russiarxiv"] }, new LRUBackend(), [china, russia]);
    expect(out.warnings).toEqual([
      "The query holds CJK or Cyrillic letters, but ChinaXiv and RussiaRxiv are searched in English: ChinaRxiv matches a query against its " +
        "English machine translation, so the query finds little or nothing there. Query ChinaXiv and RussiaRxiv in English; the query is not translated.",
    ]);
    expect(urls).toHaveLength(2);
  });

  it("leaves an English query as it was: probed when it finds nothing, and no warning when it finds records", async () => {
    const { china, urls } = chinaRxiv();
    const found = await searchLiterature({ query: "diabetes metformin", database: "chinaxiv" }, new LRUBackend(), [china]);
    expect(found.warnings).toBeUndefined();
    expect(found.total).toBe(5);
    expect(urls).toHaveLength(1);

    // Words in English letters that match nothing together: the zero-result probe runs, one request per word.
    let requests = 0;
    const none: AdapterHttp = {
      json: async <T>() => {
        requests += 1;
        return { data: [], total: 0 } as T;
      },
      text: async () => "",
    };
    const out = await searchLiterature({ query: "vitamin depression", database: "chinaxiv" }, new LRUBackend(), [new ChinaRXivAdapter(none)]);
    expect(requests).toBe(1 + 2);
    expect(out.warnings).toEqual([expect.stringMatching(/^Leaving out any one word still matches nothing in ChinaXiv/)]);
  });

  it("warns also when another database found records, and shows the zero in totalByDatabase", async () => {
    const { china } = chinaRxiv();
    const pubmed: DatabaseAdapter = {
      id: "pubmed",
      name: "PubMed / NCBI",
      search: async () => ({ count: 7, ids: ["1"] }),
      fetch: async () => [pubmedRecord],
    };
    const out = await searchLiterature({ query: "糖尿病", database: ["pubmed", "chinaxiv"] }, new LRUBackend(), [pubmed, china]);
    expect(out.totalByDatabase).toEqual({ pubmed: 7, chinaxiv: 0 });
    expect(out.articles).toHaveLength(1);
    expect(out.warnings).toEqual([chinaWarning]);
  });

  it("warns on a later page too", async () => {
    const { china } = chinaRxiv();
    const out = await searchLiterature({ query: "糖尿病", database: "chinaxiv", page: 2 }, new LRUBackend(), [china]);
    expect(out.warnings).toEqual([chinaWarning]);
  });

  it("probes the databases that read the language, and not ChinaXiv, so that what the probes say is about them", async () => {
    const { china, urls } = chinaRxiv();
    const probes: SearchInput[] = [];
    const pubmed: DatabaseAdapter = {
      id: "pubmed",
      name: "PubMed / NCBI",
      search: async (input) => {
        if (input.maxResults === 1) probes.push(input);
        return { count: 0, ids: [] };
      },
      fetch: async () => [],
    };
    const out = await searchLiterature({ query: "糖尿病 二甲双胍", database: ["pubmed", "chinaxiv"] }, new LRUBackend(), [pubmed, china]);
    expect(probes.map((p) => p.query).sort()).toEqual(["二甲双胍", "糖尿病"]);
    expect(probesOf(urls)).toEqual([]);
    expect(out.warnings).toEqual([chinaWarning, expect.stringMatching(/^Leaving out any one word still matches nothing in PubMed,/)]);
    expect(out.warnings![1]).not.toContain("ChinaXiv");
  });

  it("keeps the generic zero-result advice when another database searched is not explained by the language", async () => {
    const { china } = chinaRxiv();
    const pubmed: DatabaseAdapter = { id: "pubmed", name: "PubMed / NCBI", search: async () => ({ count: 0, ids: [] }), fetch: async () => [] };
    const out = await searchLiterature({ query: "糖尿病", database: ["pubmed", "chinaxiv"] }, new LRUBackend(), [pubmed, china]);
    expect(out.warnings).toEqual([chinaWarning, expect.stringContaining('No record matched the query "糖尿病"')]);
  });

  it("gives a zero under a dateRange no other advice either, when the language explains it", async () => {
    const { china } = chinaRxiv();
    const out = await searchLiterature({ query: "糖尿病", database: "chinaxiv", dateRange: { from: "2020" } }, new LRUBackend(), [china]);
    expect(out.warnings).toEqual([chinaWarning]);
  });

  it("does not name a database that a design filter leaves out", async () => {
    const { china, urls } = chinaRxiv();
    const out = await searchLiterature({ query: "糖尿病", database: "chinaxiv", minDesignTier: 4 }, new LRUBackend(), [china]);
    expect(out.warnings?.some((w) => w.includes("searched in English")) ?? false).toBe(false);
    expect(urls).toEqual([]);
  });

  it("does not warn for a database that reads the language: Europe PMC finds records for a Chinese query", async () => {
    const searches: SearchInput[] = [];
    const epmc: DatabaseAdapter = {
      id: "europepmc",
      name: "Europe PMC",
      search: async (input) => {
        searches.push(input);
        return { count: 0, ids: [] };
      },
      fetch: async () => [],
    };
    const out = await searchLiterature({ query: "糖尿病 二甲双胍", database: "europepmc" }, new LRUBackend(), [epmc]);
    // Unchanged: the two words are probed, as for any other database.
    expect(searches).toHaveLength(1 + 2);
    expect(out.warnings).toEqual([expect.stringMatching(/^Leaving out any one word still matches nothing in Europe PMC/)]);
  });
});

describe("Europe PMC at the last page paging reaches", () => {
  /** A fake Europe PMC that pages by cursorMark (`c{position}`) over `total` records, ids 1000 + position. */
  function europePmc(total: number): { adapter: EuropePmcAdapter; urls: URLSearchParams[] } {
    const urls: URLSearchParams[] = [];
    const http: AdapterHttp = {
      json: async <T>(url: string): Promise<T> => {
        const p = new URL(url).searchParams;
        urls.push(p);
        const cursor = p.get("cursorMark") ?? "*";
        const start = cursor === "*" ? 0 : Number(cursor.slice(1));
        const n = Math.max(0, Math.min(Number(p.get("pageSize")), total - start));
        const result = Array.from({ length: n }, (_, i) => ({ id: String(1000 + start + i), source: "MED", pmid: String(1000 + start + i), title: "A record" }));
        return { hitCount: total, nextCursorMark: `c${start + n}`, resultList: { result } } as T;
      },
      text: async () => "",
    };
    return { adapter: new EuropePmcAdapter(http), urls };
  }
  const capWarning =
    "Paging serves only the first 10,000 records of a Europe PMC search: narrow the query (more specific terms, a dateRange or a studyTypes " +
    "filter) to reach the rest.";
  const run = (adapter: EuropePmcAdapter, input: Partial<SearchInput>) =>
    searchLiterature({ query: "diabetes metformin", database: "europepmc", abstractMaxChars: 0, ...input }, new LRUBackend(), [adapter]);

  it("warns on page 200 of 50 records of a search that has more, which has no nextPage (107,339 records for diabetes metformin, 2026-11-27)", async () => {
    const { adapter } = europePmc(107_339);
    const out = await run(adapter, { page: 200, maxResults: 50 });
    expect(out).toMatchObject({ total: 107_339, page: 200, maxResults: 50 });
    expect(out.articles).toHaveLength(50);
    expect(out).not.toHaveProperty("nextPage");
    expect(out.warnings).toEqual([capWarning]);
  });

  it("says nothing on the pages before it, which have a nextPage", async () => {
    const { adapter } = europePmc(107_339);
    const out = await run(adapter, { page: 199, maxResults: 50 });
    expect(out).toMatchObject({ nextPage: 200 });
    expect(out.warnings).toBeUndefined();
  });

  it("warns on the last page of another size, even when it runs past the 10,000th record", async () => {
    // 30 per page: page 333 ends at record 9,990 and has a nextPage; page 334 holds 9,991 to 10,020, the last one reachable.
    const { adapter } = europePmc(107_339);
    const before = await run(adapter, { page: 333, maxResults: 30 });
    expect(before).toMatchObject({ nextPage: 334 });
    expect(before.warnings).toBeUndefined();
    const last = await run(adapter, { page: 334, maxResults: 30 });
    expect(last).not.toHaveProperty("nextPage");
    expect(last.warnings).toEqual([capWarning]);
    // One record a page: page 10,000 is record 10,000.
    const single = await run(adapter, { page: 10_000, maxResults: 1 });
    expect(single.articles).toHaveLength(1);
    expect(single.warnings).toEqual([capWarning]);
  });

  it("does not warn when the search ends on that page: there is nothing to reach", async () => {
    // Exactly 10,000 records: the last page is the end of the results. One more record is a cap.
    for (const [total, warned] of [
      [10_000, false],
      [10_001, true],
    ] as const) {
      const { adapter } = europePmc(total);
      const out = await run(adapter, { page: 200, maxResults: 50 });
      expect(out.total).toBe(total);
      expect(out).not.toHaveProperty("nextPage");
      expect(out.warnings !== undefined, `total ${total}`).toBe(warned);
    }
    const small = await run(europePmc(9_975).adapter, { page: 200, maxResults: 50 });
    expect(small.articles).toHaveLength(25);
    expect(small.warnings).toBeUndefined();
  });

  it("does not warn a search of fewer records, on any of its pages", async () => {
    const { adapter } = europePmc(120);
    for (const page of [1, 2, 3]) {
      const out = await run(adapter, { page, maxResults: 50 });
      expect(out.warnings, `page ${page}`).toBeUndefined();
    }
  });

  it("refuses a page that starts past the limit before searching, and says why", async () => {
    const { adapter, urls } = europePmc(107_339);
    for (const input of [
      { page: 201, maxResults: 50 },
      { page: 335, maxResults: 30 },
      { page: 10_001, maxResults: 1 },
    ]) {
      await expect(run(adapter, input), JSON.stringify(input)).rejects.toMatchObject({
        code: "INVALID_INPUT",
        userMessage: expect.stringMatching(/paging reaches only the first 10,000 records of a search\. Narrow the query/),
      });
    }
    expect(urls).toEqual([]);
  });

  it("carries the warning through the adapter, for a page past the limit asked of the adapter itself", async () => {
    const { adapter } = europePmc(107_339);
    const direct = await adapter.search({ query: "diabetes metformin", page: 201, maxResults: 50 });
    expect(direct).toMatchObject({ count: 107_339, warning: capWarning });
    expect(direct.ids).toHaveLength(50);
    // And a page that ends within the limit, or a search that ends on its page, has none.
    expect(await adapter.search({ query: "diabetes metformin", page: 199, maxResults: 50 })).not.toHaveProperty("warning");
    expect(await europePmc(10_000).adapter.search({ query: "x", page: 200, maxResults: 50 })).not.toHaveProperty("warning");
  });

  it("is the only database to warn when it holds the records beyond the page: another that ran out says nothing", async () => {
    const { adapter } = europePmc(107_339);
    const pubmed: DatabaseAdapter = {
      id: "pubmed",
      name: "PubMed / NCBI",
      search: async () => ({ count: 9_980, ids: [] }),
      fetch: async () => [],
    };
    const out = await searchLiterature(
      { query: "diabetes metformin", database: ["pubmed", "europepmc"], page: 200, maxResults: 50, abstractMaxChars: 0 },
      new LRUBackend(),
      [pubmed, adapter],
    );
    expect(out).not.toHaveProperty("nextPage");
    expect(out.warnings).toEqual([capWarning]);
  });
});
