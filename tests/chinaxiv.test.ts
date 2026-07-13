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
});
