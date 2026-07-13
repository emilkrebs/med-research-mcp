import { describe, it, expect } from "vitest";
import { CyberLeninkaAdapter, parseCyberLeninkaHtml } from "../src/core/adapters/cyberleninka";
import type { AdapterHttp } from "../src/core/adapters/http";
import { LRUBackend } from "../src/core/cache";

const HTML = `
<ul class="search-results">
  <li>
    <div class="title"><a href="/article/n/12345/vliyanie-peptidov">Влияние пептидов Хавинсона на организм</a></div>
    <span class="authors">Иванов И.И., Петров П.П.</span>
    <span class="date">2019</span>
    <p class="snippet">Аннотация статьи про пептиды и биорегуляторы.</p>
  </li>
  <li>
    <div class="title"><a href="/article/n/67890/bioregulyatory">Биорегуляторы в клинической медицине</a></div>
    <span class="authors">Сидоров С.С.</span>
    <p class="snippet">Краткое описание исследования.</p>
  </li>
</ul>
<div class="results-count">Найдено 42 статьи</div>
`;

function fakeHttp(text: string): { http: AdapterHttp; urls: string[] } {
  const urls: string[] = [];
  const http: AdapterHttp = {
    json: async <T>(): Promise<T> => ({}) as T,
    text: async (url: string) => {
      urls.push(url);
      return text;
    },
  };
  return { http, urls };
}

describe("parseCyberLeninkaHtml", () => {
  it("scrapes article id, title, authors, abstract, year, and total count", () => {
    const { count, articles } = parseCyberLeninkaHtml(HTML);
    expect(count).toBe(42);
    expect(articles).toHaveLength(2);

    const a = articles[0]!;
    expect(a.pmid).toBe("12345");
    expect(a.title).toBe("Влияние пептидов Хавинсона на организм");
    expect(a.authors).toEqual(["Иванов И.И.", "Петров П.П."]);
    expect(a.abstract).toBe("Аннотация статьи про пептиды и биорегуляторы.");
    expect(a.pubDate).toBe("2019");
    expect(a.database).toBe("cyberleninka");
    expect(a.language).toBe("ru");
    expect(a.url).toBe("https://cyberleninka.ru/article/n/12345/vliyanie-peptidov");

    expect(articles[1]!.pmid).toBe("67890");
  });

  it("returns no articles for a page with no article links", () => {
    const { articles } = parseCyberLeninkaHtml("<html><body>Ничего не найдено</body></html>");
    expect(articles).toHaveLength(0);
  });
});

describe("CyberLeninkaAdapter", () => {
  it("search() scrapes, honours maxResults, and fetch() serves from the memo", async () => {
    const { http, urls } = fakeHttp(HTML);
    const adapter = new CyberLeninkaAdapter(http);
    const cache = new LRUBackend();

    const { count, ids } = await adapter.search({ query: "пептиды Хавинсона", maxResults: 1 });
    expect(count).toBe(42);
    expect(ids).toEqual(["12345"]); // sliced to maxResults
    expect(urls[0]).toContain("cyberleninka.ru/search");

    const before = urls.length;
    const fetched = await adapter.fetch(["12345"], cache);
    expect(fetched[0]?.title).toBe("Влияние пептидов Хавинсона на организм");
    expect(urls.length).toBe(before);
  });
});
