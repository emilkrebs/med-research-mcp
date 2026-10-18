import { describe, it, expect, vi, afterEach } from "vitest";
import { ChinaRXivAdapter, chinaxivHeaders, parsePapers } from "../src/core/adapters/chinarxiv";
import { SovietRxivAdapter } from "../src/core/adapters/russiarxiv";
import type { AdapterHttp } from "../src/core/adapters/http";
import { LRUBackend } from "../src/core/cache";

const RESPONSE = {
  total: 1,
  data: [
    {
      id: "chinaxiv:202101.00001",
      title_en: "Exercise physiology in high altitude",
      abstract_en: "English abstract of a Chinese paper.",
      authors: ["Wang L", "Li M"],
      year: "2021",
      doi: "10.12074/202101.00001",
      source: "chinaxiv",
      _links: { self: "/api/v1/papers/chinaxiv:202101.00001" },
    },
  ],
};

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
  it("maps records from data array and tags language zh", () => {
    const { count, articles } = parsePapers(RESPONSE);
    expect(count).toBe(1);
    const a = articles[0]!;
    expect(a.pmid).toBe("chinaxiv:202101.00001");
    expect(a.title).toBe("Exercise physiology in high altitude");
    expect(a.authors).toEqual(["Wang L", "Li M"]);
    expect(a.doi).toBe("10.12074/202101.00001");
    expect(a.database).toBe("chinaxiv");
    expect(a.language).toBe("zh");
  });

  it("returns empty results for empty response", () => {
    const { count, articles } = parsePapers({});
    expect(count).toBe(0);
    expect(articles).toEqual([]);
  });
});

describe("ChinaRXivAdapter", () => {
  it("search() uses GET with query params and remembers results", async () => {
    const { http, urls } = fakeHttp(RESPONSE);
    const adapter = new ChinaRXivAdapter(http);
    const cache = new LRUBackend();

    const { count, ids } = await adapter.search({ query: "exercise", maxResults: 8 });
    expect(count).toBe(1);
    expect(urls[0]).toContain("https://chinarxiv.org/api/v1/papers");
    expect(urls[0]).toContain("q=exercise");
    expect(urls[0]).toContain("limit=8");

    const before = urls.length;
    const fetched = await adapter.fetch(ids, cache);
    expect(fetched[0]?.database).toBe("chinaxiv");
    expect(urls.length).toBe(before);
  });

  it("cold fetch() uses the exact /papers/{id} endpoint and maps the date field", async () => {
    const record = { id: "chinaxiv-202608.00133", title_en: "Outcome measures in TCM RCTs", date: "2026-08-26", source: "chinaxiv" };
    const { http, urls } = fakeHttp(record);
    const fetched = await new ChinaRXivAdapter(http).fetch(["chinaxiv-202608.00133"], new LRUBackend());
    expect(urls[0]).toBe("https://chinarxiv.org/api/v1/papers/chinaxiv-202608.00133");
    expect(fetched[0]?.pubDate).toBe("2026-08-26");

    const other = fakeHttp({ ...record, id: "chinaxiv-202601.00001" });
    expect(await new ChinaRXivAdapter(other.http).fetch(["chinaxiv-202608.00133"], new LRUBackend())).toEqual([]);
  });

  it("fetchFull() replaces a truncated search preview with the complete record", async () => {
    const preview = { ...RESPONSE.data[0]!, abstract_en: "Background: a long background that the search endpoint cuts off..." };
    const full = { ...RESPONSE.data[0]!, abstract_en: "Background: … Results: 38 studies were included." };
    const urls: string[] = [];
    const http: AdapterHttp = {
      json: async <T>(url: string): Promise<T> => {
        urls.push(url);
        return (url.includes("/papers?") ? { total: 1, data: [preview] } : full) as T;
      },
      text: async () => "",
    };
    const adapter = new ChinaRXivAdapter(http);
    const cache = new LRUBackend();
    const { ids } = await adapter.search({ query: "tcm" });
    expect((await adapter.fetch(ids, cache))[0]?.abstract).toContain("cuts off");

    const fetched = await adapter.fetchFull(ids, cache);
    expect(fetched[0]?.abstract).toContain("38 studies");
    expect(urls.at(-1)).toBe("https://chinarxiv.org/api/v1/papers/chinaxiv%3A202101.00001");
    // A later search re-caches the preview, but fetchFull still serves the complete record without a new request.
    await adapter.search({ query: "tcm" });
    await adapter.fetch(ids, cache);
    const before = urls.length;
    expect((await adapter.fetchFull(ids, cache))[0]?.abstract).toContain("38 studies");
    expect(urls.length).toBe(before);
  });

  it("fetchFull() falls back to the preview once when the detail endpoint fails, then retries it", async () => {
    const preview = { ...RESPONSE.data[0]!, abstract_en: "Background: a long background that the search endpoint cuts off..." };
    const full = { ...RESPONSE.data[0]!, abstract_en: "Background: … Results: 38 studies were included." };
    let detailUp = false;
    const urls: string[] = [];
    const http: AdapterHttp = {
      json: async <T>(url: string): Promise<T> => {
        urls.push(url);
        if (url.includes("/papers?")) return { total: 1, data: [preview] } as T;
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

