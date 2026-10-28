import { describe, it, expect } from "vitest";
import { EuropePmcAdapter, exactIdQuery, parseEuropePmc, toEpmcId } from "../src/core/adapters/europepmc";
import type { AdapterHttp } from "../src/core/adapters/http";
import { LRUBackend } from "../src/core/cache";
import { fetchLiterature } from "../src/core/literature";

const RESPONSE = {
  hitCount: 2,
  resultList: {
    result: [
      {
        id: "33000001",
        source: "MED",
        pmid: "33000001",
        doi: "10.1234/epmc-a",
        title: "Creatine and cognition.",
        authorString: "Smith J, Doe A",
        journalTitle: "Eur J Nutr",
        pubYear: "2021",
        abstractText: "A randomized controlled trial.",
        language: "eng",
        fullTextUrlList: { fullTextUrl: [{ url: "https://europepmc.org/article/MED/33000001" }] },
        pubTypeList: { pubType: ["Randomized Controlled Trial", "Journal Article"] },
        commentCorrectionList: {
          commentCorrection: [
            { id: "35000001", source: "MED", type: "Retraction in" },
            { id: "35000002", source: "MED", type: "Comment in" },
            { id: "123", source: "CBA", type: "Update in" },
          ],
        },
        meshHeadingList: { meshHeading: [{ majorTopic_YN: "Y", descriptorName: "Creatine" }, { majorTopic_YN: "N", descriptorName: "Humans" }] },
      },
      {
        id: "PPR12345",
        source: "PPR",
        doi: "10.1234/epmc-b",
        title: "Preprint on peptides",
        authorString: "Ivanov I",
        journalTitle: "bioRxiv",
        pubYear: "2022",
        abstractText: "Preprint abstract.",
        language: "eng",
        pubTypeList: { pubType: ["Preprint"] },
      },
    ],
  },
};

function recordingHttp(payload: unknown): { http: AdapterHttp; urls: string[] } {
  const urls: string[] = [];
  const http: AdapterHttp = {
    json: async <T>(url: string): Promise<T> => {
      urls.push(url);
      return payload as T;
    },
    text: async (url: string) => {
      urls.push(url);
      return String(payload);
    },
  };
  return { http, urls };
}

describe("parseEuropePmc", () => {
  it("maps core results into NcbiArticle with database/url/language", () => {
    const { count, articles } = parseEuropePmc(RESPONSE);
    expect(count).toBe(2);
    expect(articles).toHaveLength(2);

    const a = articles[0]!;
    expect(a.pmid).toBe("33000001");
    expect(a.title).toBe("Creatine and cognition"); // trailing period stripped
    expect(a.authors).toEqual(["Smith J", "Doe A"]);
    expect(a.doi).toBe("10.1234/epmc-a");
    expect(a.database).toBe("europepmc");
    expect(a.language).toBe("en"); // eng → en
    expect(a.url).toBe("https://europepmc.org/article/MED/33000001");

    // No full-text link → URL reconstructed from source + id.
    expect(articles[1]!.url).toBe("https://europepmc.org/article/PPR/PPR12345");
  });

  it("keeps NLM publication types and MeSH descriptor names", () => {
    const [med, ppr] = parseEuropePmc(RESPONSE).articles;
    expect(med!.publicationTypes).toEqual(["Randomized Controlled Trial", "Journal Article"]);
    expect(med!.meshHeadings).toEqual(["Creatine", "Humans"]);
    expect(ppr!.publicationTypes).toEqual(["Preprint"]);
    expect(ppr).not.toHaveProperty("meshHeadings");
  });

  it("maps retraction/update links to PubMed RefType names and drops comment links", () => {
    const [med, ppr] = parseEuropePmc(RESPONSE).articles;
    expect(med!.corrections).toEqual([
      { type: "RetractionIn", id: "35000001" },
      { type: "UpdateIn", id: "CBA:123" },
    ]);
    expect(ppr).not.toHaveProperty("corrections");
  });
});

describe("parseEuropePmc — core results", () => {
  it("reads the journal and date where core results put them, and a preprint's server", () => {
    const { articles } = parseEuropePmc({
      hitCount: 3,
      resultList: {
        result: [
          {
            id: "42668123",
            source: "MED",
            title: "The cognitive effects of creatine supplementation in older adults",
            journalInfo: { journal: { title: "Ageing research reviews" }, dateOfPublication: "2026 Nov" },
            pubYear: "2026",
            firstPublicationDate: "2026-08-29",
            electronicPublicationDate: "2026-08-29",
          },
          {
            id: "PPR1308156",
            source: "PPR",
            title: "A preprint",
            bookOrReportDetails: { publisher: "medRxiv" },
            pubYear: "2026",
            firstPublicationDate: "2026-08-28",
            pubTypeList: { pubType: ["Preprint"] },
          },
          {
            // Recently added to PMC: no pubYear, a blank issue date.
            id: "PMC13442150",
            source: "PMC",
            pmcid: "PMC13442150",
            title: "A conference abstract",
            journalInfo: { journal: { title: "European psychiatry" }, dateOfPublication: " " },
            firstPublicationDate: "2026-09-04",
          },
        ],
      },
    } as Parameters<typeof parseEuropePmc>[0]);
    expect(articles.map((a) => [a.journal, a.pubDate])).toEqual([
      ["Ageing research reviews", "2026 Nov"],
      ["medRxiv", "2026-08-28"],
      ["European psychiatry", "2026-09-04"],
    ]);
    // The date a dateRange matches (FIRST_PDATE) can precede the issue date shown.
    expect(articles.map((a) => a.epubDate)).toEqual(["2026-08-29", undefined, undefined]);
  });

  it("turns the HTML in titles and abstracts into text, escaped or not", () => {
    // Shapes from records 42422741, PPR1333599 and PPR1248025 and a "semaglutide lean mass" search (2026-10-22).
    const { articles } = parseEuropePmc({
      hitCount: 2,
      resultList: {
        result: [
          {
            id: "42422741",
            source: "MED",
            title: "&lt;i&gt;Akkermansia muciniphila&lt;/i&gt; in cardiovascular diseases: opportunities and challenges.",
            abstractText:
              "<h4>Background</h4>Semaglutide lowers body weight.<h4>Results</h4>Lean mass fell (p < 0.001; I<sup>2</sup> = 98%).",
          },
          {
            id: "PPR1333599",
            source: "PPR",
            title: "Effects of CO  <sub>2</sub>  on the growth of  <i>Akkermansia muciniphila</i>",
            abstractText: "<title>Abstract</title>  <p>The human gut is home to <b>many</b> bacteria.</p>",
          },
        ],
      },
    } as Parameters<typeof parseEuropePmc>[0]);
    expect(articles.map((a) => [a.title, a.abstract])).toEqual([
      [
        "Akkermansia muciniphila in cardiovascular diseases: opportunities and challenges",
        "Background: Semaglutide lowers body weight.\nResults: Lean mass fell (p < 0.001; I² = 98%).",
      ],
      ["Effects of CO 2 on the growth of Akkermansia muciniphila", "The human gut is home to many bacteria."],
    ]);
  });
});

describe("EuropePmcAdapter", () => {
  it("search() returns ids and encodes the query; fetch() serves from the memo", async () => {
    const { http, urls } = recordingHttp(RESPONSE);
    const adapter = new EuropePmcAdapter(http);
    const cache = new LRUBackend();

    const { count, ids } = await adapter.search({ query: "creatine cognition" });
    expect(count).toBe(2);
    expect(ids).toEqual(["33000001", "PPR12345"]);
    expect(urls[0]).toContain("query=creatine+cognition");
    expect(urls[0]).toContain("resultType=core");

    // fetch() should hit the per-instance memo, not the network again.
    const before = urls.length;
    const fetched = await adapter.fetch(["33000001"], cache);
    expect(fetched[0]?.pmid).toBe("33000001");
    expect(urls.length).toBe(before);
    // and it is written through to the cache under a database-scoped key.
    expect(cache.getSummary("europepmc:33000001")?.pmid).toBe("33000001");
  });

  it("appends a date-range clause to the query", async () => {
    const { http, urls } = recordingHttp(RESPONSE);
    const adapter = new EuropePmcAdapter(http);
    await adapter.search({ query: "peptide", dateRange: { from: "2020-01-01", to: "2021-12-31" } });
    expect(urls[0]).toContain("FIRST_PDATE");
  });

  it("sorts by date as the merged results are, by first publication", async () => {
    const { http, urls } = recordingHttp(RESPONSE);
    await new EuropePmcAdapter(http).search({ query: "semaglutide", sort: "date" });
    expect(new URL(urls[0]!).searchParams.get("sort")).toBe("FIRST_PDATE_D desc");
  });

  it("cold fetch() looks a record up by EXT_ID + SRC and rejects a non-matching hit", async () => {
    const cba = {
      hitCount: 1,
      resultList: { result: [{ id: "521529", source: "CBA", title: "Yishen Zhuanggu Tongbi Decoction", pubYear: "2005" }] },
    };
    const { http, urls } = recordingHttp(cba);
    const fetched = await new EuropePmcAdapter(http).fetch(["CBA:521529"], new LRUBackend());
    expect(decodeURIComponent(urls[0]!.replace(/\+/g, " "))).toContain("query=EXT_ID:521529 AND SRC:CBA");
    expect(fetched.map((a) => a.pmid)).toEqual(["CBA:521529"]);

    // A bare PMID is looked up in MED; a hit for some other record is not returned as that id.
    const wrong = recordingHttp(RESPONSE);
    expect(await new EuropePmcAdapter(wrong.http).fetch(["42756947"], new LRUBackend())).toEqual([]);
    expect(decodeURIComponent(wrong.urls[0]!.replace(/\+/g, " "))).toContain("query=EXT_ID:42756947 AND SRC:MED");
  });
});

describe("Europe PMC ids", () => {
  it("prefixes numeric non-PubMed ids with their source so they cannot collide with PMIDs", () => {
    expect(toEpmcId("MED", "33000001")).toBe("33000001");
    expect(toEpmcId("CBA", "521529")).toBe("CBA:521529");
    expect(toEpmcId("PPR", "PPR12345")).toBe("PPR12345");
    expect(parseEuropePmc({ resultList: { result: [{ id: "521529", source: "CBA" }] } }).articles[0]?.url).toBe(
      "https://europepmc.org/article/CBA/521529",
    );
  });

  it("builds an exact-match query for every id shape", () => {
    expect(exactIdQuery("CBA:521529")).toBe("EXT_ID:521529 AND SRC:CBA");
    expect(exactIdQuery("PPR12345")).toBe("EXT_ID:PPR12345 AND SRC:PPR");
    expect(exactIdQuery("PMC1234567")).toBe("PMCID:PMC1234567");
    expect(exactIdQuery("33000001")).toBe("EXT_ID:33000001 AND SRC:MED");
  });

  it("accepts any case and looks non-numeric ids from other sources up without a SRC clause", () => {
    expect(exactIdQuery("cba:521529")).toBe("EXT_ID:521529 AND SRC:CBA");
    expect(exactIdQuery("ppr12345")).toBe("EXT_ID:PPR12345 AND SRC:PPR");
    expect(exactIdQuery("IND44331483")).toBe('EXT_ID:"IND44331483"');
    expect(exactIdQuery("NBK623750")).toBe('EXT_ID:"NBK623750"');
    expect(exactIdQuery("CN101548780")).toBe('EXT_ID:"CN101548780"');
  });

  it("fetchLiterature() returns a lower-case id's record and does not report it missing", async () => {
    const ppr = { hitCount: 1, resultList: { result: [{ id: "PPR12345", source: "PPR", title: "A preprint", pubYear: "2025" }] } };
    const { http } = recordingHttp(ppr);
    const out = await fetchLiterature({ ids: ["ppr12345"], database: "europepmc" }, new LRUBackend(), new EuropePmcAdapter(http));
    expect(out.articles.map((a) => a.pmid)).toEqual(["PPR12345"]);
    expect(out.missing).toEqual([]);
  });
});

/** A fake Europe PMC that pages by cursorMark (`c{position}`) over `total` records, ids 1000 + position. */
function cursorHttp(total: number): { http: AdapterHttp; urls: URLSearchParams[] } {
  const urls: URLSearchParams[] = [];
  const http: AdapterHttp = {
    json: async <T>(url: string): Promise<T> => {
      const p = new URL(url).searchParams;
      urls.push(p);
      const cursor = p.get("cursorMark") ?? "*";
      const start = cursor === "*" ? 0 : Number(cursor.slice(1));
      const n = Math.max(0, Math.min(Number(p.get("pageSize")), total - start));
      const result = Array.from({ length: n }, (_, i) => ({ id: String(1000 + start + i), source: "MED" }));
      return { hitCount: total, nextCursorMark: `c${start + n}`, resultList: { result } } as T;
    },
    text: async () => "",
  };
  return { http, urls };
}

const idRange = (from: number, to: number): string[] => Array.from({ length: to - from }, (_, i) => String(1000 + from + i));

describe("EuropePmcAdapter paging", () => {
  it("page 1 starts at cursorMark * and returns the first records", async () => {
    const { http, urls } = cursorHttp(100);
    const out = await new EuropePmcAdapter(http).search({ query: "creatine", maxResults: 10 });
    expect(out).toEqual({ count: 100, ids: idRange(0, 10) });
    expect(urls).toHaveLength(1);
    expect(urls[0]!.get("cursorMark")).toBe("*");
    expect(urls[0]!.get("resultType")).toBe("core");
    expect(urls[0]!.get("pageSize")).toBe("10");
  });

  it("page 2 after page 1 reuses the remembered cursor in one request", async () => {
    const { http, urls } = cursorHttp(100);
    const adapter = new EuropePmcAdapter(http);
    await adapter.search({ query: "creatine", maxResults: 10 });
    const out = await adapter.search({ query: "creatine", maxResults: 10, page: 2 });
    expect(out.ids).toEqual(idRange(10, 20));
    expect(urls).toHaveLength(2);
    expect(urls[1]!.get("cursorMark")).toBe("c10");
    expect(urls[1]!.get("resultType")).toBe("core");
  });

  it("walks cold to a later page with id-only requests, then remembers the cursors it passed", async () => {
    const { http, urls } = cursorHttp(100);
    const adapter = new EuropePmcAdapter(http);
    const out = await adapter.search({ query: "creatine", maxResults: 10, page: 3 });
    expect(out.ids).toEqual(idRange(20, 30));
    expect(urls.map((u) => [u.get("resultType"), u.get("pageSize"), u.get("cursorMark")])).toEqual([
      ["idlist", "20", "*"],
      ["core", "10", "c20"],
    ]);

    // The walk memoized position 20 and the page position 30: neighbours cost one request.
    urls.length = 0;
    expect((await adapter.search({ query: "creatine", maxResults: 10, page: 4 })).ids).toEqual(idRange(30, 40));
    expect((await adapter.search({ query: "creatine", maxResults: 10, page: 3 })).ids).toEqual(idRange(20, 30));
    expect(urls).toHaveLength(2);
  });

  it("walks in steps of at most 1000 ids", async () => {
    const { http, urls } = cursorHttp(2000);
    const out = await new EuropePmcAdapter(http).search({ query: "creatine", maxResults: 50, page: 30 });
    expect(out.ids).toEqual(idRange(1450, 1500));
    expect(urls.map((u) => [u.get("resultType"), u.get("pageSize"), u.get("cursorMark")])).toEqual([
      ["idlist", "1000", "*"],
      ["idlist", "450", "c1000"],
      ["core", "50", "c1450"],
    ]);
  });

  it("starts from the nearest remembered position, not from the start", async () => {
    const { http, urls } = cursorHttp(100);
    const adapter = new EuropePmcAdapter(http);
    await adapter.search({ query: "creatine", maxResults: 10 });
    urls.length = 0;
    expect((await adapter.search({ query: "creatine", maxResults: 10, page: 4 })).ids).toEqual(idRange(30, 40));
    expect(urls.map((u) => [u.get("resultType"), u.get("pageSize"), u.get("cursorMark")])).toEqual([
      ["idlist", "20", "c10"],
      ["core", "10", "c30"],
    ]);
  });

  it("does not share cursors between queries or sorts", async () => {
    const { http, urls } = cursorHttp(100);
    const adapter = new EuropePmcAdapter(http);
    await adapter.search({ query: "creatine", maxResults: 10 });
    urls.length = 0;
    await adapter.search({ query: "creatine", maxResults: 10, page: 2, sort: "date" });
    await adapter.search({ query: "peptide", maxResults: 10, page: 2 });
    expect(urls.map((u) => [u.get("resultType"), u.get("cursorMark")])).toEqual([
      ["idlist", "*"],
      ["core", "c10"],
      ["idlist", "*"],
      ["core", "c10"],
    ]);
    expect(urls[1]!.get("sort")).toBe("FIRST_PDATE_D desc");
  });

  it("returns no ids, with the hit count, for a page past the end", async () => {
    const { http, urls } = cursorHttp(25);
    const adapter = new EuropePmcAdapter(http);
    expect(await adapter.search({ query: "creatine", maxResults: 10, page: 4 })).toEqual({ count: 25, ids: [] });
    expect(urls).toHaveLength(1);
    // The last page is partial; the page right after the last record is empty.
    expect((await adapter.search({ query: "creatine", maxResults: 10, page: 3 })).ids).toEqual(idRange(20, 25));
    const exact = new EuropePmcAdapter(cursorHttp(20).http);
    expect(await exact.search({ query: "creatine", maxResults: 10, page: 3 })).toEqual({ count: 20, ids: [] });
  });

  it("treats a walk response without a new cursor as the end", async () => {
    const http: AdapterHttp = {
      json: async <T>(): Promise<T> =>
        ({ hitCount: 50, resultList: { result: [{ id: "1", source: "MED" }, { id: "2", source: "MED" }] } }) as T,
      text: async () => "",
    };
    expect(await new EuropePmcAdapter(http).search({ query: "x", maxResults: 2, page: 2 })).toEqual({ count: 50, ids: [] });
  });
});

describe("EuropePmcAdapter design filters", () => {
  it("narrows the query with PUB_TYPE, and sends none when the filter can keep nothing", async () => {
    const { http, urls } = recordingHttp({ hitCount: 0, resultList: { result: [] } });
    const adapter = new EuropePmcAdapter(http);
    await adapter.search({ query: "creatine[tiab]", minDesignTier: 4 });
    expect(new URL(urls[0]!).searchParams.get("query")).toBe(
      '(creatine) AND (PUB_TYPE:"Network Meta-Analysis" OR PUB_TYPE:"Randomized Controlled Trial" OR PUB_TYPE:"Equivalence Trial")',
    );
    expect(await adapter.search({ query: "x", studyTypes: ["in-vitro"] })).toEqual({ count: 0, ids: [] });
    expect(urls).toHaveLength(1);
  });
});
