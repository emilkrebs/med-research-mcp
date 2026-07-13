import { describe, it, expect } from "vitest";
import { SciELOAdapter, parseScielo } from "../src/core/adapters/scielo";
import type { AdapterHttp } from "../src/core/adapters/http";
import { LRUBackend } from "../src/core/cache";

const RESPONSE = {
  response: {
    numFound: 2,
    docs: [
      {
        id: "S0102-86502020000100001",
        ti: ["Efeitos da creatina"],
        au: ["García M", "López P"],
        ab: ["Resumo do artigo sobre creatina."],
        journal_title: ["Rev Bras Med"],
        publication_year: "2020",
        la: ["pt"],
        doi: "10.1590/s0102-1",
        ur: "https://www.scielo.br/j/rbm/a/abc",
      },
      {
        // language-suffixed fields only — the parser must fall back to them.
        id: "S0102-2",
        ti_es: ["Título en español"],
        ab_es: ["Resumen."],
        la: ["es"],
      },
    ],
  },
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

describe("parseScielo", () => {
  it("maps Solr docs and handles language-suffixed fields", () => {
    const { count, articles } = parseScielo(RESPONSE);
    expect(count).toBe(2);

    const a = articles[0]!;
    expect(a.pmid).toBe("S0102-86502020000100001");
    expect(a.title).toBe("Efeitos da creatina");
    expect(a.authors).toEqual(["García M", "López P"]);
    expect(a.journal).toBe("Rev Bras Med");
    expect(a.pubDate).toBe("2020");
    expect(a.doi).toBe("10.1590/s0102-1");
    expect(a.language).toBe("pt");
    expect(a.database).toBe("scielo");
    expect(a.url).toBe("https://www.scielo.br/j/rbm/a/abc");

    // Second doc only has ti_es / ab_es.
    expect(articles[1]!.title).toBe("Título en español");
    expect(articles[1]!.abstract).toBe("Resumen.");
    expect(articles[1]!.language).toBe("es");
  });
});

describe("SciELOAdapter", () => {
  it("search() passes the language hint and count, and remembers results", async () => {
    const { http, urls } = fakeHttp(RESPONSE);
    const adapter = new SciELOAdapter(http);
    const cache = new LRUBackend();

    const { count, ids } = await adapter.search({ query: "creatina", language: "pt", maxResults: 5 });
    expect(count).toBe(2);
    expect(ids[0]).toBe("S0102-86502020000100001");
    expect(urls[0]).toContain("lang=pt");
    expect(urls[0]).toContain("count=5");

    const before = urls.length;
    const fetched = await adapter.fetch([ids[0]!], cache);
    expect(fetched[0]?.title).toBe("Efeitos da creatina");
    expect(urls.length).toBe(before); // served from memo
  });
});
