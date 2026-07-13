import { describe, it, expect } from "vitest";
import { ChinaXivAdapter, parseChinaXiv } from "../src/core/adapters/chinaxiv";
import type { AdapterHttp } from "../src/core/adapters/http";
import { LRUBackend } from "../src/core/cache";

const RESPONSE = {
  total: 1,
  data: [
    {
      id: "chinaxiv:202101.00001",
      title: "Exercise physiology in high altitude",
      abstract: "English abstract of a Chinese paper.",
      authors: ["Wang L", "Li M"],
      journal: "ChinaXiv",
      year: "2021",
      doi: "10.12074/202101.00001",
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

describe("parseChinaXiv", () => {
  it("maps records and tags language zh", () => {
    const { count, articles } = parseChinaXiv(RESPONSE);
    expect(count).toBe(1);
    const a = articles[0]!;
    expect(a.pmid).toBe("chinaxiv:202101.00001");
    expect(a.title).toBe("Exercise physiology in high altitude");
    expect(a.authors).toEqual(["Wang L", "Li M"]);
    expect(a.doi).toBe("10.12074/202101.00001");
    expect(a.database).toBe("chinaxiv");
    expect(a.language).toBe("zh");
    expect(a.url).toBe("http://chinaxiv.org/abs/chinaxiv:202101.00001");
  });

  it("accepts the alternative count/records envelope", () => {
    const { count, articles } = parseChinaXiv({
      count: 3,
      records: [{ id: "x", title: "T", url: "http://chinaxiv.org/abs/x" }],
    });
    expect(count).toBe(3);
    expect(articles[0]!.url).toBe("http://chinaxiv.org/abs/x");
  });
});

describe("ChinaXivAdapter", () => {
  it("search() sends the size param and remembers results", async () => {
    const { http, urls } = fakeHttp(RESPONSE);
    const adapter = new ChinaXivAdapter(http);
    const cache = new LRUBackend();

    const { count, ids } = await adapter.search({ query: "exercise", maxResults: 8 });
    expect(count).toBe(1);
    expect(urls[0]).toContain("size=8");

    const before = urls.length;
    const fetched = await adapter.fetch(ids, cache);
    expect(fetched[0]?.database).toBe("chinaxiv");
    expect(urls.length).toBe(before);
  });
});
