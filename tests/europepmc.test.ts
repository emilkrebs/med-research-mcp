import { describe, it, expect } from "vitest";
import { EuropePmcAdapter, parseEuropePmc } from "../src/core/adapters/europepmc";
import type { AdapterHttp } from "../src/core/adapters/http";
import { LRUBackend } from "../src/core/cache";

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
});
