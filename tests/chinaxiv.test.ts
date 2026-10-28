import { describe, it, expect, vi, afterEach } from "vitest";
import { ChinaRXivAdapter, chinaxivHeaders, parsePapers } from "../src/core/adapters/chinarxiv";
import { SovietRxivAdapter } from "../src/core/adapters/russiarxiv";
import { defaultHttp, type AdapterHttp } from "../src/core/adapters/http";
import { LRUBackend } from "../src/core/cache";
import { classifyArticle } from "../src/core/grader";

/** A ChinaXiv search result as the v1 API returns it (PaperSummary, abstract cut at 500 characters). */
const CHINAXIV_RECORD = {
  id: "chinaxiv-202401.00027",
  title: "Clinical Characteristics and Influencing Factors of Gastrointestinal Dysfunction.",
  authors: ["Li Jing", "Ma Leilei"],
  abstract: "Objective: a long background that the search endpoint cuts off...",
  abstract_source: "source",
  date: "2024-01-03",
  source: "chinaxiv",
  source_language: "zh",
  source_url: "https://chinaxiv.org/abs/202401.00027",
  publication: null,
  subjects: [],
  _links: { self: "/api/v1/papers/chinaxiv-202401.00027" },
};

/** A RussiaRxiv detail record (PaperDetail): its abstract was written by ChinaRxiv. */
const RUSSIARXIV_RECORD = {
  id: "ru-196201.58177",
  title: "Total Synthesis of Linoleic, Linolenic, Arachidonic, and 7,10,13,16-Docosatetraenoic Acids",
  authors: ["N. A. PREOBRAZHENSKII"],
  abstract: "This paper describes synthetic routes to higher polyenoic fatty acids.",
  abstract_source: "machine_generated",
  machine_generated_abstract: "This paper describes synthetic routes to higher polyenoic fatty acids.",
  date: "1962-01-01",
  source: "russiarxiv",
  source_language: "ru",
  source_url: "https://www.mathnet.ru/eng/dan27147",
  publication: "doklady_akademii_nauk_sssr",
  publication_title: "Doklady Akademii Nauk SSSR",
  _links: { self: "/api/v1/papers/ru-196201.58177" },
};

const RESPONSE = { total: 1, limit: 10, next_cursor: null, data: [CHINAXIV_RECORD] };

function fakeHttp(payload: unknown): { http: AdapterHttp; urls: string[] } {
  const urls: string[] = [];
  const http: AdapterHttp = {
    json: async <T>(url: string): Promise<T> => {
      urls.push(url);
      return payload as T;
    },
    text: async () => "",
  };
  return { http, urls };
}

describe("chinaxivHeaders (X-API-Email)", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
  });

  /** Stub global fetch, run one search with the env-configured default http, return the sent headers. */
  async function sentHeaders(): Promise<Record<string, string>> {
    let captured: Record<string, string> = {};
    vi.stubGlobal("fetch", async (_url: string, init?: RequestInit) => {
      captured = (init?.headers ?? {}) as Record<string, string>;
      return new Response(JSON.stringify({ total: 0, data: [] }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    });
    await new ChinaRXivAdapter().search({ query: "exercise" });
    return captured;
  }

  it("sends X-API-Email when MED_RESEARCH_CHINAXIV_EMAIL is set", async () => {
    vi.stubEnv("MED_RESEARCH_CHINAXIV_EMAIL", "chinaxiv@example.com");
    vi.stubEnv("NCBI_EMAIL", "ncbi@example.com");
    expect(chinaxivHeaders()).toEqual({ "X-API-Email": "chinaxiv@example.com" });
    expect((await sentHeaders())["X-API-Email"]).toBe("chinaxiv@example.com");
  });

  it("falls back to NCBI_EMAIL when MED_RESEARCH_CHINAXIV_EMAIL is unset", async () => {
    vi.stubEnv("NCBI_EMAIL", "ncbi@example.com");
    expect(chinaxivHeaders()).toEqual({ "X-API-Email": "ncbi@example.com" });
    expect((await sentHeaders())["X-API-Email"]).toBe("ncbi@example.com");
  });

  it("falls back to NCBI_EMAIL when MED_RESEARCH_CHINAXIV_EMAIL is empty (as in .env.example)", () => {
    vi.stubEnv("MED_RESEARCH_CHINAXIV_EMAIL", "");
    vi.stubEnv("NCBI_EMAIL", "ncbi@example.com");
    expect(chinaxivHeaders()).toEqual({ "X-API-Email": "ncbi@example.com" });
  });

  it("treats a placeholder the MCP host left unfilled as unset", () => {
    vi.stubEnv("MED_RESEARCH_CHINAXIV_EMAIL", "${user_config.chinaxivEmail}");
    vi.stubEnv("NCBI_EMAIL", "ncbi@example.com");
    expect(chinaxivHeaders()).toEqual({ "X-API-Email": "ncbi@example.com" });
  });

  it("sends no X-API-Email when neither email is set", async () => {
    expect(chinaxivHeaders()).toEqual({});
    expect((await sentHeaders())["X-API-Email"]).toBeUndefined();
  });

  it("SovietRxivAdapter sends the same default header", async () => {
    vi.stubEnv("MED_RESEARCH_CHINAXIV_EMAIL", "chinaxiv@example.com");
    let captured: Record<string, string> = {};
    vi.stubGlobal("fetch", async (_url: string, init?: RequestInit) => {
      captured = (init?.headers ?? {}) as Record<string, string>;
      return new Response(JSON.stringify({ total: 0, data: [] }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    });
    await new SovietRxivAdapter().search({ query: "exercise" });
    expect(captured["X-API-Email"]).toBe("chinaxiv@example.com");
  });
});

describe("parsePapers", () => {
  it("maps a ChinaXiv record, linking its English page and the original", () => {
    const { count, articles } = parsePapers(RESPONSE);
    expect(count).toBe(1);
    const a = articles[0]!;
    expect(a.pmid).toBe("chinaxiv-202401.00027");
    expect(a.title).toBe("Clinical Characteristics and Influencing Factors of Gastrointestinal Dysfunction");
    expect(a.authors).toEqual(["Li Jing", "Ma Leilei"]);
    expect(a.pubDate).toBe("2024-01-03");
    expect(a.journal).toBe("ChinaXiv");
    expect(a.database).toBe("chinaxiv");
    expect(a.language).toBe("zh");
    expect(a.url).toBe("https://chinarxiv.org/items/chinaxiv-202401.00027");
    expect(a.originalUrl).toBe("https://chinaxiv.org/abs/202401.00027");
    expect(a.doi).toBeUndefined();
  });

  it("marks translated text unless the original is English, and machine-written abstracts", () => {
    const parse = (r: Record<string, unknown>) => parsePapers({ data: [r] }).articles[0]!;
    expect(parse(CHINAXIV_RECORD).machineTranslated).toBe(true);
    expect(parse(CHINAXIV_RECORD).machineGeneratedAbstract).toBeUndefined();
    expect(parse({ ...CHINAXIV_RECORD, source_language: "mixed" }).machineTranslated).toBe(true);
    const { source_language: _l, ...legacy } = CHINAXIV_RECORD;
    expect(parse(legacy).machineTranslated).toBe(true);
    expect(parse({ ...CHINAXIV_RECORD, source_language: "en" }).machineTranslated).toBeUndefined();
    expect(parse({ ...CHINAXIV_RECORD, source_language: "en" }).language).toBe("en");

    const soviet = parse(RUSSIARXIV_RECORD);
    expect(soviet.machineGeneratedAbstract).toBe(true);
    expect(soviet.machineTranslated).toBe(true);
    expect(soviet.database).toBe("russiarxiv");
    expect(soviet.language).toBe("ru");
    expect(soviet.journal).toBe("Doklady Akademii Nauk SSSR");
    expect(soviet.url).toBe("https://sovietrxiv.org/items/ru-196201.58177");
    expect(soviet.originalUrl).toBe("https://www.mathnet.ru/eng/dan27147");
  });

  it("surfaces both as warning flags; the design stays unknown", () => {
    const graded = classifyArticle(parsePapers({ data: [RUSSIARXIV_RECORD] }).articles[0]!);
    expect(graded.studyType).toBe("unknown");
    expect(graded.designTier).toBeNull();
    expect(graded.flags).toEqual(["machine-translated", "machine-generated-abstract"]);
  });

  it("returns empty results for empty response", () => {
    const { count, articles } = parsePapers({});
    expect(count).toBe(0);
    expect(articles).toEqual([]);
  });
});

describe("ChinaRXivAdapter", () => {
  it("search() asks for the chinaxiv corpus only and remembers results", async () => {
    const { http, urls } = fakeHttp(RESPONSE);
    const adapter = new ChinaRXivAdapter(http);
    const cache = new LRUBackend();

    const { count, ids } = await adapter.search({ query: "exercise", maxResults: 8 });
    expect(count).toBe(1);
    const url = new URL(urls[0]!);
    expect(url.origin + url.pathname).toBe("https://chinarxiv.org/api/v1/papers");
    expect(url.searchParams.get("q")).toBe("exercise");
    expect(url.searchParams.get("limit")).toBe("8");
    // Without `source`, the API mixes in RussiaRxiv records and counts them in `total`.
    expect(url.searchParams.get("source")).toBe("chinaxiv");

    const before = urls.length;
    const fetched = await adapter.fetch(ids, cache);
    expect(fetched[0]?.database).toBe("chinaxiv");
    expect(urls.length).toBe(before);
  });

  it('search() reads language "ru" as the RussiaRxiv corpus and passes dateRange', async () => {
    const { http, urls } = fakeHttp({ total: 0, data: [] });
    await new ChinaRXivAdapter(http).search({
      query: "vitamin",
      language: "ru",
      dateRange: { from: "1960-01-01", to: "1961-12-31" },
    });
    const params = new URL(urls[0]!).searchParams;
    expect(params.get("source")).toBe("russiarxiv");
    expect(params.get("from_date")).toBe("1960-01-01");
    expect(params.get("to_date")).toBe("1961-12-31");
  });

  it("expands a year or month to full dates and drops PubMed field tags from the query", async () => {
    const { http, urls } = fakeHttp({ total: 0, data: [] });
    await new ChinaRXivAdapter(http).search({ query: "creatine AND cognition[tiab]", dateRange: { from: "2020", to: "2021-02" } });
    const params = new URL(urls[0]!).searchParams;
    expect(params.get("q")).toBe("creatine AND cognition");
    expect(params.get("from_date")).toBe("2020-01-01");
    expect(params.get("to_date")).toBe("2021-02-28");

    const invalid = fakeHttp({ total: 0, data: [] });
    await new ChinaRXivAdapter(invalid.http).search({ query: "x", dateRange: { from: "last year" } });
    expect(new URL(invalid.urls[0]!).searchParams.has("from_date")).toBe(false);
  });

  it("cold fetch() uses the exact /papers/{id} endpoint and maps the date field", async () => {
    const record = { ...CHINAXIV_RECORD, id: "chinaxiv-202608.00133", date: "2026-08-26" };
    const { http, urls } = fakeHttp(record);
    const fetched = await new ChinaRXivAdapter(http).fetch(["chinaxiv-202608.00133"], new LRUBackend());
    expect(urls[0]).toBe("https://chinarxiv.org/api/v1/papers/chinaxiv-202608.00133");
    expect(fetched[0]?.pubDate).toBe("2026-08-26");

    const other = fakeHttp({ ...record, id: "chinaxiv-202601.00001" });
    expect(await new ChinaRXivAdapter(other.http).fetch(["chinaxiv-202608.00133"], new LRUBackend())).toEqual([]);
  });

  it("fetchFull() replaces a truncated search preview with the complete record", async () => {
    const full = { ...CHINAXIV_RECORD, abstract: "Objective: … Results: 38 studies were included." };
    const urls: string[] = [];
    const http: AdapterHttp = {
      json: async <T>(url: string): Promise<T> => {
        urls.push(url);
        return (url.includes("/papers?") ? RESPONSE : full) as T;
      },
      text: async () => "",
    };
    const adapter = new ChinaRXivAdapter(http);
    const cache = new LRUBackend();
    const { ids } = await adapter.search({ query: "tcm" });
    expect((await adapter.fetch(ids, cache))[0]?.abstract).toContain("cuts off");

    const fetched = await adapter.fetchFull(ids, cache);
    expect(fetched[0]?.abstract).toContain("38 studies");
    expect(urls.at(-1)).toBe("https://chinarxiv.org/api/v1/papers/chinaxiv-202401.00027");
    // A later search re-caches the preview, but fetchFull still serves the complete record without a new request.
    await adapter.search({ query: "tcm" });
    await adapter.fetch(ids, cache);
    const before = urls.length;
    expect((await adapter.fetchFull(ids, cache))[0]?.abstract).toContain("38 studies");
    expect(urls.length).toBe(before);
  });

  it("fetchFull() falls back to the preview once when the detail endpoint fails, then retries it", async () => {
    const full = { ...CHINAXIV_RECORD, abstract: "Objective: … Results: 38 studies were included." };
    let detailUp = false;
    const urls: string[] = [];
    const http: AdapterHttp = {
      json: async <T>(url: string): Promise<T> => {
        urls.push(url);
        if (url.includes("/papers?")) return RESPONSE as T;
        if (!detailUp) throw new Error("HTTP 503");
        return full as T;
      },
      text: async () => "",
    };
    const adapter = new ChinaRXivAdapter(http);
    const cache = new LRUBackend();
    const { ids } = await adapter.search({ query: "tcm" });

    let before = urls.length;
    expect((await adapter.fetchFull(ids, cache))[0]?.abstract).toContain("cuts off");
    expect(urls.length - before).toBe(1); // one failed detail request, no repeat

    detailUp = true;
    before = urls.length;
    expect((await adapter.fetchFull(ids, cache))[0]?.abstract).toContain("38 studies");
    expect(urls.length - before).toBe(1);
  });
});

describe("SovietRxivAdapter", () => {
  it("search() asks for the russiarxiv corpus", async () => {
    const { http, urls } = fakeHttp({ total: 1, data: [RUSSIARXIV_RECORD] });
    const { ids } = await new SovietRxivAdapter(http).search({ query: "fatty acids" });
    expect(new URL(urls[0]!).searchParams.get("source")).toBe("russiarxiv");
    expect(ids).toEqual(["ru-196201.58177"]);
  });

  it("looks ids up exactly, never by text search, and loads complete records", async () => {
    const { http, urls } = fakeHttp(RUSSIARXIV_RECORD);
    const adapter = new SovietRxivAdapter(http);
    const fetched = await adapter.fetchFull(["ru-196201.58177"], new LRUBackend());
    expect(urls).toEqual(["https://chinarxiv.org/api/v1/papers/ru-196201.58177"]);
    expect(fetched[0]?.journal).toBe("Doklady Akademii Nauk SSSR");

    // A record under a different id is another paper, not this one.
    const other = fakeHttp({ ...RUSSIARXIV_RECORD, id: "ru-196101.52277" });
    expect(await new SovietRxivAdapter(other.http).fetch(["ru-196201.58177"], new LRUBackend())).toEqual([]);
  });
});

/** A fake ChinaRxiv that pages by opaque base64 cursors whose per_page overrides `limit`, over `total` records. */
function pagedHttp(total: number): { http: AdapterHttp; urls: URLSearchParams[] } {
  const urls: URLSearchParams[] = [];
  const http: AdapterHttp = {
    json: async <T>(url: string): Promise<T> => {
      const p = new URL(url).searchParams;
      urls.push(p);
      const cursor = p.get("cursor");
      const { page, per_page } = cursor
        ? (JSON.parse(Buffer.from(cursor, "base64").toString()) as { page: number; per_page: number })
        : { page: 1, per_page: Number(p.get("limit")) };
      const start = (page - 1) * per_page;
      const data = Array.from({ length: Math.max(0, Math.min(per_page, total - start)) }, (_, i) => ({
        ...CHINAXIV_RECORD,
        id: `chinaxiv-${start + i}`,
      }));
      const next = start + per_page < total ? Buffer.from(JSON.stringify({ page: page + 1, per_page })).toString("base64") : null;
      return { total, limit: per_page, next_cursor: next, data } as T;
    },
    text: async () => "",
  };
  return { http, urls };
}

const idRange = (from: number, to: number): string[] => Array.from({ length: to - from }, (_, i) => `chinaxiv-${from + i}`);

describe("ChinaRxiv paging", () => {
  it("page 1 sends no cursor and keeps the page size as limit", async () => {
    const { http, urls } = pagedHttp(100);
    const out = await new ChinaRXivAdapter(http).search({ query: "depression", maxResults: 10 });
    expect(out).toEqual({ count: 100, ids: idRange(0, 10) });
    expect(urls).toHaveLength(1);
    expect(urls[0]!.get("limit")).toBe("10");
    expect(urls[0]!.has("cursor")).toBe(false);
  });

  it("page 2 after page 1 uses the remembered cursor in one request", async () => {
    const { http, urls } = pagedHttp(100);
    const adapter = new ChinaRXivAdapter(http);
    await adapter.search({ query: "depression", maxResults: 10 });
    const out = await adapter.search({ query: "depression", maxResults: 10, page: 2 });
    expect(out.ids).toEqual(idRange(10, 20));
    expect(urls).toHaveLength(2);
    expect(urls[1]!.get("cursor")).toBeTruthy();
    expect(urls[1]!.get("limit")).toBe("10");
  });

  it("walks cold to a later page one request per page, then remembers every cursor", async () => {
    const { http, urls } = pagedHttp(100);
    const adapter = new ChinaRXivAdapter(http);
    const out = await adapter.search({ query: "depression", maxResults: 10, page: 3 });
    expect(out.ids).toEqual(idRange(20, 30));
    expect(urls.map((u) => [u.get("limit"), u.has("cursor")])).toEqual([
      ["10", false],
      ["10", true],
      ["10", true],
    ]);

    urls.length = 0;
    expect((await adapter.search({ query: "depression", maxResults: 10, page: 2 })).ids).toEqual(idRange(10, 20));
    expect((await adapter.search({ query: "depression", maxResults: 10, page: 4 })).ids).toEqual(idRange(30, 40));
    expect(urls).toHaveLength(2);
  });

  it("does not reuse cursors made for another page size or query", async () => {
    const { http, urls } = pagedHttp(100);
    const adapter = new ChinaRXivAdapter(http);
    await adapter.search({ query: "depression", maxResults: 10 });
    urls.length = 0;
    // A page-size-10 cursor would override limit=5 and return the wrong records.
    expect((await adapter.search({ query: "depression", maxResults: 5, page: 2 })).ids).toEqual(idRange(5, 10));
    expect(urls.map((u) => [u.get("limit"), u.has("cursor")])).toEqual([
      ["5", false],
      ["5", true],
    ]);
    urls.length = 0;
    await adapter.search({ query: "anxiety", maxResults: 10, page: 2 });
    expect(urls).toHaveLength(2);
  });

  it("returns no ids, with the total and no warning, for a page past the end", async () => {
    const { http, urls } = pagedHttp(25);
    const out = await new ChinaRXivAdapter(http).search({ query: "vitamin depression", maxResults: 10, page: 5 });
    expect(out).toEqual({ count: 25, ids: [] });
    expect(urls).toHaveLength(3);
  });

  it("returns the partial last page and nothing right after it", async () => {
    const adapter = new ChinaRXivAdapter(pagedHttp(25).http);
    expect((await adapter.search({ query: "depression", maxResults: 10, page: 3 })).ids).toEqual(idRange(20, 25));
    expect(await adapter.search({ query: "depression", maxResults: 10, page: 4 })).toEqual({ count: 25, ids: [] });
  });

  it("pages the RussiaRxiv corpus the same way", async () => {
    const { http, urls } = pagedHttp(100);
    await new SovietRxivAdapter(http).search({ query: "acids", maxResults: 10, page: 2 });
    expect(urls.map((u) => u.get("source"))).toEqual(["russiarxiv", "russiarxiv"]);
  });
});

describe("ChinaRxiv query rules", () => {
  it("explains an empty result for a query of several words, which must all match", async () => {
    const { http } = fakeHttp({ total: 0, data: [] });
    const adapter = new ChinaRXivAdapter(http);
    expect((await adapter.search({ query: "vitamin D[tiab] AND depression" })).warning).toMatch(/every word of the query/);
    expect((await adapter.search({ query: "microbiota" })).warning).toBeUndefined();
  });

  it("declares that its records carry no design metadata", () => {
    expect(new ChinaRXivAdapter().designMetadata).toBe(false);
    expect(new SovietRxivAdapter().designMetadata).toBe(false);
  });
});

describe("rate limits", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it("waits out a short Retry-After and retries", async () => {
    vi.useFakeTimers();
    const responses = [
      new Response("", { status: 429, headers: { "retry-after": "1" } }),
      new Response(JSON.stringify({ total: 0, data: [] }), { status: 200 }),
    ];
    const fetchMock = vi.fn(async () => responses.shift()!);
    vi.stubGlobal("fetch", fetchMock);
    const pending = defaultHttp({ source: "ChinaRxiv" }).json("https://chinarxiv.org/api/v1/papers?q=x");
    await vi.advanceTimersByTimeAsync(1500);
    await expect(pending).resolves.toEqual({ total: 0, data: [] });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("names the database that answered 429, without PubMed's API-key advice", async () => {
    vi.stubGlobal("fetch", async () => new Response("", { status: 429, headers: { "retry-after": "30" } }));
    const error = await defaultHttp({ source: "ChinaRxiv" })
      .json("https://chinarxiv.org/api/v1/papers?q=x")
      .catch((e: unknown) => e);
    expect(error).toMatchObject({ code: "RATE_LIMIT", retryAfter: 30 });
    expect((error as { userMessage: string }).userMessage).toContain("ChinaRxiv");
    expect((error as { userMessage: string }).userMessage).not.toContain("NCBI_API_KEY");
  });
});
