import { describe, it, expect } from "vitest";
import { EuropePmcAdapter, exactIdQuery, parseEuropePmc, toEpmcId } from "../src/core/adapters/europepmc";
import { publicationDateClause, toEuropePmcQuery } from "../src/core/adapters/util";
import type { AdapterHttp } from "../src/core/adapters/http";
import { LRUBackend } from "../src/core/cache";
import { errors } from "../src/core/errors";
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

/** The clause a date range is searched with, written out: a record's first, electronic or print publication date in [a, b]. */
const dates = (a: string, b: string) => `(FIRST_PDATE:[${a} TO ${b}] OR E_PDATE:[${a} TO ${b}] OR P_PDATE:[${a} TO ${b}])`;

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
    // The dates a dateRange matches (first, electronic and print) can precede the issue date shown.
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
    expect(new URL(urls[0]!).searchParams.get("query")).toBe(`(peptide) AND ${dates("2020-01-01", "2021-12-31")}`);
  });

  it("matches a range against the first, electronic and print publication dates, as PubMed's [dp] does", async () => {
    // Europe PMC record 39680131 (online 2024-12-16, print July 2025) was found for 2025 by these three fields and not by FIRST_PDATE alone (2026-11-16);
    // for creatine[tiab] in 2024 they find 1,990 records against 1,777 for FIRST_PDATE alone and PubMed's 2,046. Preprints have FIRST_PDATE only.
    const { http, urls } = recordingHttp(RESPONSE);
    const adapter = new EuropePmcAdapter(http);
    await adapter.search({ query: "semaglutide", dateRange: { from: "2025", to: "2025" } });
    const query = new URL(urls[0]!).searchParams.get("query")!;
    expect(query).toContain("FIRST_PDATE:[2025-01-01 TO 2025-12-31]");
    expect(query).toContain("E_PDATE:[2025-01-01 TO 2025-12-31]");
    expect(query).toContain("P_PDATE:[2025-01-01 TO 2025-12-31]");
  });

  it("sends one end of a range with the other open, for all three date fields", async () => {
    // Europe PMC found 4,602 records of TITLE_ABS:creatine with these three fields from 2025 on (4,407 with FIRST_PDATE) and 18,114 up to 2000 (18,113; 2026-11-16).
    const { http, urls } = recordingHttp(RESPONSE);
    const adapter = new EuropePmcAdapter(http);
    const sent = async (dateRange: { from?: string; to?: string }) => {
      await adapter.search({ query: "creatine", dateRange });
      return new URL(urls.at(-1)!).searchParams.get("query");
    };
    expect(await sent({ from: "2025" })).toBe(`(creatine) AND ${dates("2025-01-01", "3000-01-01")}`);
    expect(await sent({ to: "2000" })).toBe(`(creatine) AND ${dates("1900-01-01", "2000-12-31")}`);
    expect(await sent({ from: "2025-03", to: "2025-04" })).toBe(`(creatine) AND ${dates("2025-03-01", "2025-04-30")}`);
    // An end that is not a date leaves that end open; with none left there is no clause.
    expect(await sent({ from: "2025", to: "soon" })).toBe(`(creatine) AND ${dates("2025-01-01", "3000-01-01")}`);
    expect(await sent({ from: "later" })).toBe("creatine");
  });

  it("builds the date clause of a dateRange and of a [dp] tag with one helper", async () => {
    // The same expression twice would let the two drift apart, as FIRST_PDATE alone and the three fields did.
    expect(publicationDateClause("2024-01-01", "2024-12-31")).toBe(dates("2024-01-01", "2024-12-31"));
    const { http, urls } = recordingHttp(RESPONSE);
    const adapter = new EuropePmcAdapter(http);
    await adapter.search({ query: "creatine", dateRange: { from: "2019-03", to: "2021" } });
    const ofRange = new URL(urls[0]!).searchParams.get("query");
    expect(ofRange).toBe(`(creatine) AND ${publicationDateClause("2019-03-01", "2021-12-31")}`);
    expect(toEuropePmcQuery("2019/03:2021[dp]")).toBe(publicationDateClause("2019-03-01", "2021-12-31"));
    expect(ofRange).toContain(toEuropePmcQuery("2019/03:2021[dp]"));
  });

  it("puts the query in parentheses, so that a date or design clause filters all of an OR query", async () => {
    const { http, urls } = recordingHttp(RESPONSE);
    const adapter = new EuropePmcAdapter(http);
    const sent = async (input: Parameters<EuropePmcAdapter["search"]>[0]) => {
      await adapter.search(input);
      return new URL(urls.at(-1)!).searchParams.get("query");
    };
    // Unparenthesized, Europe PMC counted 43,203 for this query in 2020, and 54,793 with parentheses (2026-11-11).
    expect(await sent({ query: "creatine OR cognition", dateRange: { from: "2020" } })).toBe(
      `(creatine OR cognition) AND ${dates("2020-01-01", "3000-01-01")}`,
    );
    expect(await sent({ query: "creatine OR cognition", dateRange: { to: "2020-06" }, studyTypes: ["case-report"] })).toBe(
      `(creatine OR cognition) AND (PUB_TYPE:"Case Reports") AND ${dates("1900-01-01", "2020-06-30")}`,
    );
    expect(await sent({ query: "creatine OR cognition" })).toBe("creatine OR cognition");
  });

  it("sends Europe PMC's own field syntax through unchanged, with a PubMed tag next to it translated", async () => {
    // The literature_search description tells a model to use these on europepmc alone (checked 2026-11-16):
    // TITLE_ABS:word is TITLE:word OR ABSTRACT:word, a tag covers the next word only, SRC:PPR keeps preprints.
    // PubMed reads them as words ("title"[All Fields] AND melatonin; SRC:PPR matched 0 records there).
    const { http, urls } = recordingHttp(RESPONSE);
    const adapter = new EuropePmcAdapter(http);
    const sent = async (input: Parameters<EuropePmcAdapter["search"]>[0]) => {
      await adapter.search(input);
      return new URL(urls.at(-1)!).searchParams.get("query");
    };
    expect(await sent({ query: "TITLE_ABS:melatonin TITLE_ABS:sleep" })).toBe("TITLE_ABS:melatonin TITLE_ABS:sleep");
    expect(await sent({ query: "TITLE:melatonin AND ABSTRACT:sleep AND SRC:PPR" })).toBe("TITLE:melatonin AND ABSTRACT:sleep AND SRC:PPR");
    expect(await sent({ query: 'TITLE:"melatonin sleep" OR TITLE:(sleep elderly)' })).toBe('TITLE:"melatonin sleep" OR TITLE:(sleep elderly)');
    expect(await sent({ query: "melatonin[tiab] AND TITLE_ABS:sleep" })).toBe("TITLE_ABS:melatonin AND TITLE_ABS:sleep");
    // Parenthesized as a whole beside the other clauses, so that a date range or design filter applies to all of it.
    expect(await sent({ query: "TITLE_ABS:melatonin OR SRC:PPR", dateRange: { from: "2020" } })).toBe(
      `(TITLE_ABS:melatonin OR SRC:PPR) AND ${dates("2020-01-01", "3000-01-01")}`,
    );
  });

  it("sorts by date as the merged results are, by first publication, with or without a dateRange", async () => {
    const { http, urls } = recordingHttp(RESPONSE);
    await new EuropePmcAdapter(http).search({ query: "semaglutide", sort: "date" });
    expect(new URL(urls[0]!).searchParams.get("sort")).toBe("FIRST_PDATE_D desc");
    // The range is matched on three dates and the sort stays on the first: a record first published before the range can be listed.
    await new EuropePmcAdapter(http).search({ query: "semaglutide", sort: "date", dateRange: { from: "2025", to: "2025" } });
    expect(new URL(urls[1]!).searchParams.get("sort")).toBe("FIRST_PDATE_D desc");
    expect(new URL(urls[1]!).searchParams.get("query")).toContain("P_PDATE:[2025-01-01 TO 2025-12-31]");
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

  it("stops a cold walk at the first response whose hit count shows the page is past the end", async () => {
    const { http, urls } = cursorHttp(4_000_000);
    const adapter = new EuropePmcAdapter(http);
    const out = await adapter.search({ query: "creatine", maxResults: 50, page: 100_000 });
    expect(out).toEqual({ count: 4_000_000, ids: [] });
    expect(urls).toHaveLength(1);
    // The hit count is known now: further pages past the end cost nothing.
    expect(await adapter.search({ query: "creatine", maxResults: 50, page: 90_000 })).toEqual({ count: 4_000_000, ids: [] });
    expect(urls).toHaveLength(1);

    const small = cursorHttp(1500);
    expect(await new EuropePmcAdapter(small.http).search({ query: "x", maxResults: 50, page: 40 })).toEqual({ count: 1500, ids: [] });
    expect(small.urls).toHaveLength(1);
  });

  it("treats a walk response without a new cursor as the end", async () => {
    const http: AdapterHttp = {
      json: async <T>(): Promise<T> =>
        ({ hitCount: 50, resultList: { result: [{ id: "1", source: "MED" }, { id: "2", source: "MED" }] } }) as T,
      text: async () => "",
    };
    expect(await new EuropePmcAdapter(http).search({ query: "x", maxResults: 2, page: 2 })).toEqual({ count: 50, ids: [] });
  });

  it("keeps a remembered cursor when its request fails, and doesn't retry it", async () => {
    const { http: inner, urls } = cursorHttp(100);
    let failNext = false;
    const http: AdapterHttp = {
      ...inner,
      json: async <T>(url: string): Promise<T> => {
        if (failNext) {
          failNext = false;
          urls.push(new URL(url).searchParams);
          throw errors.outOfTime("Europe PMC", "Europe PMC didn't answer within 9 s");
        }
        return inner.json<T>(url);
      },
    };
    const adapter = new EuropePmcAdapter(http);
    await adapter.search({ query: "creatine", maxResults: 10, page: 2 });

    urls.length = 0;
    failNext = true;
    await expect(adapter.search({ query: "creatine", maxResults: 10, page: 3 })).rejects.toMatchObject({ code: "TIMEOUT" });
    expect(urls.map((u) => u.get("cursorMark"))).toEqual(["c20"]);

    // The cursor survived the failure: the retry needs one request.
    urls.length = 0;
    expect((await adapter.search({ query: "creatine", maxResults: 10, page: 3 })).ids).toEqual(idRange(20, 30));
    expect(urls.map((u) => u.get("cursorMark"))).toEqual(["c20"]);
  });
});

describe("EuropePmcAdapter design filters", () => {
  it("narrows the query with PUB_TYPE, and sends none when the filter can keep nothing", async () => {
    const { http, urls } = recordingHttp({ hitCount: 0, resultList: { result: [] } });
    const adapter = new EuropePmcAdapter(http);
    await adapter.search({ query: "creatine[tiab]", minDesignTier: 4 });
    expect(new URL(urls[0]!).searchParams.get("query")).toBe(
      '(TITLE_ABS:creatine) AND (PUB_TYPE:"Network Meta-Analysis" OR PUB_TYPE:"Randomized Controlled Trial" OR PUB_TYPE:"Equivalence Trial")',
    );
    expect(await adapter.search({ query: "x", studyTypes: ["in-vitro"] })).toEqual({ count: 0, ids: [] });
    expect(urls).toHaveLength(1);
  });
});

describe("toEuropePmcQuery", () => {
  // Every expectation below follows what PubMed's esearch and Europe PMC answered on 2026-11-16 (see the doc comment of the function).

  it("turns [tiab] and [ti] into TITLE_ABS and TITLE, in any case and in long form", () => {
    // Europe PMC found 1,560 records for `tirzepatide apnea` and 142 for TITLE_ABS on both words (PubMed: 144 for [tiab]).
    expect(toEuropePmcQuery("tirzepatide[tiab] AND apnea[tiab]")).toBe("TITLE_ABS:tirzepatide AND TITLE_ABS:apnea");
    expect(toEuropePmcQuery("tirzepatide[Title/Abstract] AND apnea[TIAB]")).toBe("TITLE_ABS:tirzepatide AND TITLE_ABS:apnea");
    expect(toEuropePmcQuery("tirzepatide [ti] OR apnea[Title]")).toBe("TITLE:tirzepatide OR TITLE:apnea");
    expect(toEuropePmcQuery('"sleep apnea"[tiab] AND tirzepatide[tiab]')).toBe('TITLE_ABS:"sleep apnea" AND TITLE_ABS:tirzepatide');
  });

  it("reads a tag as PubMed does: it covers the term before it, not the words before that", () => {
    // esearch: `creatine AND cognition[tiab]` is ("creatine" mapped) AND "cognition"[Title/Abstract]; a quoted phrase and a group stay as they are.
    expect(toEuropePmcQuery("creatine AND cognition[tiab]")).toBe("creatine AND TITLE_ABS:cognition");
    expect(toEuropePmcQuery('"sleep apnea" cpap[tiab]')).toBe('"sleep apnea" TITLE_ABS:cpap');
    expect(toEuropePmcQuery("(sleep OR apnea) cpap[tiab]")).toBe("(sleep OR apnea) TITLE_ABS:cpap");
    expect(toEuropePmcQuery("tirzepatide[tiab] apnea[tiab]")).toBe("TITLE_ABS:tirzepatide TITLE_ABS:apnea");
    expect(toEuropePmcQuery("(tirzepatide[tiab] OR semaglutide[tiab]) AND apnea[tiab]")).toBe(
      "(TITLE_ABS:tirzepatide OR TITLE_ABS:semaglutide) AND TITLE_ABS:apnea",
    );
    expect(toEuropePmcQuery("creatine NOT cognition[tiab]")).toBe("creatine NOT TITLE_ABS:cognition");
  });

  it("removes the tag where PubMed's reading depends on more than the query text", () => {
    // Words before a tag are one phrase only if PubMed's phrase index holds it: `sleep apnea[tiab]` is "sleep apnea"[Title/Abstract],
    // `creatine cognition[tiab]` is creatine (mapped) AND "cognition"[Title/Abstract], `psittacine flight[tiab]` likewise.
    expect(toEuropePmcQuery("sleep apnea[tiab]")).toBe("sleep apnea");
    expect(toEuropePmcQuery("tirzepatide[tiab] sleep apnea[tiab]")).toBe("TITLE_ABS:tirzepatide sleep apnea");
    expect(toEuropePmcQuery("creatine and cognition[tiab]")).toBe("creatine and cognition");
    // PubMed ignores a tag after a group with an operator: `(tirzepatide OR semaglutide)[tiab]` has no [Title/Abstract] in its translation.
    expect(toEuropePmcQuery("(sleep OR apnea)[tiab] AND cpap[tiab]")).toBe("(sleep OR apnea) AND TITLE_ABS:cpap");
    expect(toEuropePmcQuery("(sleep apnea)[tiab]")).toBe("(sleep apnea)");
    // A word glued to the tag, a field already on the term, a tag with nothing before it.
    expect(toEuropePmcQuery("a[tiab]b[tiab]")).toBe("ab");
    expect(toEuropePmcQuery("TITLE_ABS:sleep[tiab]")).toBe("TITLE_ABS:sleep");
    expect(toEuropePmcQuery("creatine AND [tiab] AND memory")).toBe("creatine AND AND memory");
  });

  it("quotes a hyphenated term, keeps a wildcard that PubMed accepts, and drops the tag where Europe PMC reads the term differently", () => {
    // Unquoted, Europe PMC finds 232,653 records for TITLE_ABS:il-6 and 193,835 for the phrase (PubMed 195,634).
    expect(toEuropePmcQuery("il-6[tiab] AND covid-19[ti]")).toBe('TITLE_ABS:"il-6" AND TITLE:"covid-19"');
    // diabet*[tiab] 960,599 in PubMed, TITLE_ABS:diabet* 942,328 with SRC:MED; PubMed needs 4 characters before "*", and Europe PMC answers
    // HTTP 503 to a term that starts with one.
    expect(toEuropePmcQuery("diabet*[tiab] AND organi*ation*[ti]")).toBe("TITLE_ABS:diabet* AND TITLE:organi*ation*");
    expect(toEuropePmcQuery("ab*[tiab]")).toBe("ab*");
    expect(toEuropePmcQuery("*ation[tiab]")).toBe("*ation");
    // Europe PMC ignores a "*" in a phrase: TITLE_ABS:"breast feed*" finds the 1,048 of `"breast feed"`, PubMed's 15,911 for "breast feed*"[tiab].
    expect(toEuropePmcQuery('"breast feed*"[tiab]')).toBe('"breast feed*"');
    // A phrase with nothing to search, a term with punctuation that was not compared, a proximity or a [18F] bracket.
    expect(toEuropePmcQuery('"-"[tiab] AND alzheimer\'s[tiab] AND "sleep apnea"[tiab:~3] AND [18F]FDG[tiab]')).toBe(
      '"-" AND alzheimer\'s AND "sleep apnea" AND [18F]FDG',
    );
    expect(toEuropePmcQuery("and[tiab]")).toBe('TITLE_ABS:"and"');
  });

  it("turns [au] into AUTH for a surname and initials, where PubMed truncates the initials too", () => {
    // PubMed: Fauci AS[au] 1,076, Europe PMC AUTH:"Fauci AS" 1,075; Kreider R[au] 233 and 232 (both include Kreider RB).
    expect(toEuropePmcQuery("Fauci AS[au] AND Kreider R[Author]")).toBe('AUTH:"Fauci AS" AND AUTH:"Kreider R"');
    expect(toEuropePmcQuery("kreider[au] AND O'Brien J[auth] AND Garcia-Lopez J[au]")).toBe(
      'AUTH:"kreider" AND AUTH:"O\'Brien J" AND AUTH:"Garcia-Lopez J"',
    );
    // "Kreider R"[au] switches the truncation off in PubMed (36 records, Europe PMC finds 232), and more than a surname and initials is a name this does not parse.
    expect(toEuropePmcQuery('"Kreider R"[au]')).toBe('"Kreider R"');
    expect(toEuropePmcQuery("de Souza MA[au]")).toBe("de Souza MA");
    expect(toEuropePmcQuery("Kreider Richard[au]")).toBe("Kreider Richard");
  });

  it("turns [pt] into PUB_TYPE for the publication types it was compared on, and not for the ones PubMed explodes", () => {
    // With creatine[tiab]: Randomized Controlled Trial 2,872 in PubMed and 2,874 in Europe PMC, Review 3,655 and 3,480, Meta-Analysis 462 and 455.
    expect(toEuropePmcQuery('"Randomized Controlled Trial"[pt] AND review[Publication Type] AND meta-analysis[PT]')).toBe(
      'PUB_TYPE:"Randomized Controlled Trial" AND PUB_TYPE:"Review" AND PUB_TYPE:"Meta-Analysis"',
    );
    // esearch reads `randomized controlled trial[pt]` as the phrase "randomized controlled trial"[Publication Type].
    expect(toEuropePmcQuery("systematic review[pt] OR case reports[pt]")).toBe('PUB_TYPE:"Systematic Review" OR PUB_TYPE:"Case Reports"');
    // PubMed's "Clinical Trial"[pt] includes Phase I-IV, Controlled Clinical Trial and more: 4,148 records against Europe PMC's 2,370 (Controlled Clinical Trial 3,234 and 369).
    expect(toEuropePmcQuery('"Clinical Trial"[pt] AND "Controlled Clinical Trial"[pt]')).toBe('"Clinical Trial" AND "Controlled Clinical Trial"');
    expect(toEuropePmcQuery("review[pt:noexp]")).toBe("review");
    expect(toEuropePmcQuery("creatine randomized controlled trial[pt]")).toBe("creatine randomized controlled trial");
  });

  it("turns [ta] into JOURNAL for a quoted name or one word, and leaves an ISSN or several unquoted words", () => {
    // With 2021[dp]: "N Engl J Med" 1,515 in both, "Sci Rep" 24,534 in both, blood 947 and 948. JOURNAL:0028-0836 finds nothing.
    expect(toEuropePmcQuery('"N Engl J Med"[ta] OR lancet[Journal] OR blood[jour]')).toBe(
      'JOURNAL:"N Engl J Med" OR JOURNAL:"lancet" OR JOURNAL:"blood"',
    );
    expect(toEuropePmcQuery("N Engl J Med[ta]")).toBe("N Engl J Med");
    expect(toEuropePmcQuery('0028-0836[ta] AND "0028-0836"[ta]')).toBe('0028-0836 AND "0028-0836"');
  });

  it("turns [la] into LANG for the languages whose records Europe PMC tags like PubMed", () => {
    // Europe PMC keeps one language per record, English for a record in English and Spanish: it tags 225 of PubMed's 253 spa records and 41 of 81 por.
    expect(toEuropePmcQuery("english[la] AND ger[la] AND Chinese[Language]")).toBe("LANG:eng AND LANG:ger AND LANG:chi");
    expect(toEuropePmcQuery("spanish[la] AND por[la]")).toBe("spanish AND por");
  });

  it("turns [dp] into the three date fields, for a year, a month or a range of them", () => {
    // PubMed matches a record by its electronic or its print date: PMID 39680131 (online 2024-12-16, print 2025-07-01) is found for 2024[dp] and for 2025[dp];
    // FIRST_PDATE alone finds 1,777 of PubMed's 2,046 records for creatine[tiab] AND 2024[dp] and these three 1,990. Preprints have FIRST_PDATE only.
    expect(toEuropePmcQuery("2024[dp]")).toBe(dates("2024-01-01", "2024-12-31"));
    expect(toEuropePmcQuery("2019:2021[Publication Date] AND 2024/03[pdat]")).toBe(
      `${dates("2019-01-01", "2021-12-31")} AND ${dates("2024-03-01", "2024-03-31")}`,
    );
    expect(toEuropePmcQuery("2019/03:2021[dp]")).toBe(dates("2019-03-01", "2021-12-31"));
    // Europe PMC keeps an issue date to the month: 8 of the 13 records PubMed finds for 2024/03/15[dp] with creatine[tiab].
    expect(toEuropePmcQuery("2024/03/15[dp]")).toBe("2024/03/15");
    expect(toEuropePmcQuery('"last 5 years"[dp]')).toBe('"last 5 years"');
    expect(toEuropePmcQuery("2021:2020[dp]")).toBe("2021:2020");
    expect(toEuropePmcQuery("2024/13[dp]")).toBe("2024/13");
  });

  it("turns [pmid] and [uid] into an exact lookup in PubMed's records", () => {
    expect(toEuropePmcQuery("39680131[pmid] OR 35000001[UID]")).toBe("(EXT_ID:39680131 AND SRC:MED) OR (EXT_ID:35000001 AND SRC:MED)");
    expect(toEuropePmcQuery("PMC1234567[pmid]")).toBe("PMC1234567");
  });

  it("removes a tag it did not compare, [mh] among them, and keeps bracketed text with digits", () => {
    // "Sleep Apnea Syndromes"[mh]: 50,220 records, KW:"Sleep Apnea Syndromes" 17,963 (with tirzepatide[tiab] 54 and 2); PubMed explodes the heading.
    expect(toEuropePmcQuery('"Sleep Apnea Syndromes"[mh] AND humans[MeSH Terms] AND creatine[mesh] AND tirzepatide[tiab]')).toBe(
      '"Sleep Apnea Syndromes" AND humans AND creatine AND TITLE_ABS:tirzepatide',
    );
    expect(toEuropePmcQuery("memory[tw] AND Smith J[fau] AND UCLA[ad] AND english[lang] AND 2020[year] AND x[majr]")).toBe(
      "memory AND Smith J AND UCLA AND LANG:eng AND 2020 AND x",
    );
    expect(toEuropePmcQuery("[18F]FDG PET AND [Ca2+] signalling")).toBe("[18F]FDG PET AND [Ca2+] signalling");
  });

  it("passes Europe PMC's own syntax through", () => {
    for (const q of [
      "TITLE_ABS:melatonin TITLE_ABS:sleep",
      'TITLE:"melatonin sleep" OR TITLE:(sleep elderly)',
      "creatine AND SRC:PPR AND FIRST_PDATE:[2020-01-01 TO 2021-12-31]",
      'CITED:[10 TO *] AND AUTH:"Kreider R" AND PUB_YEAR:[2000 TO 2001]',
      "creatine",
    ]) {
      expect(toEuropePmcQuery(q)).toBe(q);
    }
  });

  it("falls back to removing the tags from a query it cannot parse", () => {
    expect(toEuropePmcQuery('"sleep apnea[tiab] AND cpap[tiab]')).toBe('"sleep apnea AND cpap');
    expect(toEuropePmcQuery("(creatine[tiab] OR cognition[tiab]")).toBe("(creatine OR cognition");
    expect(toEuropePmcQuery("creatine[tiab]) OR cognition[tiab]")).toBe("creatine) OR cognition");
    // Nothing left to search: the query as it was.
    expect(toEuropePmcQuery("[tiab]")).toBe("[tiab]");
  });

  it("never throws and keeps quotes and parentheses balanced, whatever it is given", () => {
    // A small deterministic generator of queries made of the pieces that matter.
    const pieces = ['"', "(", ")", "[", "]", "[tiab]", "[mh]", "[pt]", "[dp]", "[au]", " ", "  ", "AND", "OR", "NOT", "a", "sleep", "apnea*", "il-6", "2020", "2019:2021", "TITLE:", "*", "\\", "\n", "é"];
    let seed = 7;
    const next = () => (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648;
    const balanced = (q: string) => {
      let depth = 0;
      let quoted = false;
      for (const c of q) {
        if (c === '"') quoted = !quoted;
        else if (!quoted && c === "(") depth++;
        else if (!quoted && c === ")" && --depth < 0) return false;
      }
      return !quoted && depth === 0;
    };
    for (let i = 0; i < 3000; i++) {
      const q = Array.from({ length: 1 + Math.floor(next() * 12) }, () => pieces[Math.floor(next() * pieces.length)]).join(next() < 0.5 ? "" : " ");
      let out = "";
      expect(() => (out = toEuropePmcQuery(q)), q).not.toThrow();
      if (balanced(q)) expect(balanced(out), `${q} -> ${out}`).toBe(true);
    }
    // A long query is read in linear time.
    const long = "creatine[tiab] ".repeat(20_000);
    const started = Date.now();
    expect(toEuropePmcQuery(long).startsWith("TITLE_ABS:creatine TITLE_ABS:creatine")).toBe(true);
    expect(Date.now() - started).toBeLessThan(2000);
  });
});

describe("EuropePmcAdapter queries with PubMed tags", () => {
  const sent = async (input: Parameters<EuropePmcAdapter["search"]>[0]) => {
    const { http, urls } = recordingHttp(RESPONSE);
    await new EuropePmcAdapter(http).search(input);
    return { query: new URL(urls[0]!).searchParams.get("query"), url: urls[0]! };
  };

  it("sends a translated query, and the design and date clauses are ANDed in parentheses beside it", async () => {
    const { query } = await sent({
      query: "tirzepatide[tiab] AND apnea[tiab]",
      studyTypes: ["case-report"],
      dateRange: { from: "2024", to: "2025-06" },
    });
    expect(query).toBe(`(TITLE_ABS:tirzepatide AND TITLE_ABS:apnea) AND (PUB_TYPE:"Case Reports") AND ${dates("2024-01-01", "2025-06-30")}`);
  });

  it("keeps an OR inside the parentheses, so that the date clause filters all of it", async () => {
    expect((await sent({ query: "tirzepatide[tiab] OR semaglutide[ti]", dateRange: { from: "2020" } })).query).toBe(
      `(TITLE_ABS:tirzepatide OR TITLE:semaglutide) AND ${dates("2020-01-01", "3000-01-01")}`,
    );
    // A [dp] in the query is a group of its own and combines with the dateRange clause.
    expect((await sent({ query: "creatine[tiab] AND 2024[dp]", dateRange: { to: "2024-06" } })).query).toBe(
      `(TITLE_ABS:creatine AND ${dates("2024-01-01", "2024-12-31")}) AND ${dates("1900-01-01", "2024-06-30")}`,
    );
  });

  it("encodes the quotes, spaces and brackets of the query in the URL", async () => {
    const { url, query } = await sent({ query: '"sleep apnea"[tiab] AND Kreider R[au] AND 2019:2021[dp]' });
    expect(query).toBe(
      'TITLE_ABS:"sleep apnea" AND AUTH:"Kreider R" AND (FIRST_PDATE:[2019-01-01 TO 2021-12-31] OR E_PDATE:[2019-01-01 TO 2021-12-31] OR P_PDATE:[2019-01-01 TO 2021-12-31])',
    );
    const raw = url.slice(url.indexOf("query=") + 6).split("&")[0]!;
    expect(raw).toMatch(/^TITLE_ABS%3A%22sleep\+apnea%22\+AND\+AUTH%3A%22Kreider\+R%22\+AND\+%28FIRST_PDATE%3A%5B2019-01-01\+TO/);
    expect(raw).not.toMatch(/["\s[\]]/);
  });

  it("sends the query without its tags when it cannot be parsed", async () => {
    expect((await sent({ query: '"sleep apnea[tiab] AND cpap[tiab]' })).query).toBe('"sleep apnea AND cpap');
  });
});
