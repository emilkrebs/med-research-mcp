import { describe, it, expect } from "vitest";
import { JStageAdapter, parseJStage } from "../src/core/adapters/jstage";
import type { AdapterHttp } from "../src/core/adapters/http";
import { LRUBackend } from "../src/core/cache";

const RESPONSE = {
  total: 2,
  records: [
    {
      id: "jstage-1",
      title: "Pharmacology of a Japanese herbal formula",
      authors: ["Tanaka H", "Sato K"],
      doi: "10.1248/jstage-1",
      journal: "J Pharm Sci",
      year: "2020",
      abstract: "English abstract.",
      url: "https://www.jstage.jst.go.jp/article/x",
      language: "en",
    },
    {
      // author string variant + id falls back to DOI + default language.
      title: "別の研究",
      authorString: "Yamada T, Suzuki M",
      doi: "10.1248/jstage-2",
      journal: "Nihon Yakurigaku",
      year: "2019",
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

describe("parseJStage", () => {
  it("maps records, splits author strings, and defaults language to ja", () => {
    const { count, articles } = parseJStage(RESPONSE);
    expect(count).toBe(2);

    const a = articles[0]!;
    expect(a.pmid).toBe("jstage-1");
    expect(a.authors).toEqual(["Tanaka H", "Sato K"]);
    expect(a.doi).toBe("10.1248/jstage-1");
    expect(a.database).toBe("jstage");
    expect(a.language).toBe("en");
    expect(a.url).toBe("https://www.jstage.jst.go.jp/article/x");

    const b = articles[1]!;
    expect(b.pmid).toBe("10.1248/jstage-2"); // id fell back to DOI
    expect(b.authors).toEqual(["Yamada T", "Suzuki M"]); // authorString split
    expect(b.language).toBe("ja"); // default
  });
});

describe("JStageAdapter", () => {
  it("search() sends the count param and remembers results", async () => {
    const { http, urls } = fakeHttp(RESPONSE);
    const adapter = new JStageAdapter(http);
    const cache = new LRUBackend();

    const { count, ids } = await adapter.search({ query: "herbal", maxResults: 12 });
    expect(count).toBe(2);
    expect(urls[0]).toContain("count=12");

    const before = urls.length;
    const fetched = await adapter.fetch([ids[0]!], cache);
    expect(fetched[0]?.pmid).toBe("jstage-1");
    expect(urls.length).toBe(before);
  });
});
