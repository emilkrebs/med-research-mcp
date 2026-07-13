import { describe, it, expect } from "vitest";
import { ChinaXivAdapter, parseChinaXiv } from "../src/core/adapters/chinaxiv";
import type { AdapterHttp } from "../src/core/adapters/http";
import { LRUBackend } from "../src/core/cache";

const RESPONSE = {
  success: true,
  code: 200,
  data: {
    total: 1,
    content: [
      {
        id: "chinaxiv:202101.00001",
        entitle: "Exercise physiology in high altitude",
        enabstract: "English abstract of a Chinese paper.",
        authors: ["Wang L", "Li M"],
        journal: "ChinaXiv",
        year: "2021",
        doi: "10.12074/202101.00001",
      },
    ],
  },
};

function fakeHttp(payload: unknown): { http: AdapterHttp; urls: string[]; bodies: unknown[] } {
  const urls: string[] = [];
  const bodies: unknown[] = [];
  const http: AdapterHttp = {
    json: async <T>(url: string): Promise<T> => {
      urls.push(url);
      return payload as T;
    },
    text: async () => "",
    post: async <T>(url: string, body?: unknown): Promise<T> => {
      urls.push(url);
      bodies.push(body);
      return payload as T;
    },
  };
  return { http, urls, bodies };
}

describe("parseChinaXiv", () => {
  it("maps records from data.content and tags language zh", () => {
    const { count, articles } = parseChinaXiv(RESPONSE);
    expect(count).toBe(1);
    const a = articles[0]!;
    expect(a.pmid).toBe("chinaxiv:202101.00001");
    expect(a.title).toBe("Exercise physiology in high altitude");
    expect(a.authors).toEqual(["Wang L", "Li M"]);
    expect(a.doi).toBe("10.12074/202101.00001");
    expect(a.database).toBe("chinaxiv");
    expect(a.language).toBe("zh");
    expect(a.url).toBe("https://chinaxiv.org/abs/chinaxiv:202101.00001");
  });

  it("returns empty results for empty response", () => {
    const { count, articles } = parseChinaXiv({});
    expect(count).toBe(0);
    expect(articles).toEqual([]);
  });
});

describe("ChinaXivAdapter", () => {
  it("search() uses POST with JSON body and remembers results", async () => {
    const { http, urls, bodies } = fakeHttp(RESPONSE);
    const adapter = new ChinaXivAdapter(http);
    const cache = new LRUBackend();

    const { count, ids } = await adapter.search({ query: "exercise", maxResults: 8 });
    expect(count).toBe(1);
    // Should be a POST to the API
    expect(urls[0]).toBe("https://chinaxiv.org/api/search");
    expect(bodies[0]).toEqual({ q: "exercise", page: 0, size: 8 });

    const before = urls.length;
    const fetched = await adapter.fetch(ids, cache);
    expect(fetched[0]?.database).toBe("chinaxiv");
    expect(urls.length).toBe(before); // fetch hits memo, no network call
  });
});
