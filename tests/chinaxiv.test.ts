import { describe, it, expect } from "vitest";
import { ChinaRXivAdapter, parsePapers } from "../src/core/adapters/chinarxiv";
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

