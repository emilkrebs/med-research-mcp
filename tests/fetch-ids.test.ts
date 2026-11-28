import { afterEach, describe, expect, it, vi } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { LRUBackend, NcbiClient } from "../src/core/index.js";
import { fetchLiterature } from "../src/core/literature";
import { EuropePmcAdapter } from "../src/core/adapters/europepmc";
import { PubMedAdapter } from "../src/core/adapters/pubmed";
import { ChinaRXivAdapter } from "../src/core/adapters/chinarxiv";
import { SovietRxivAdapter } from "../src/core/adapters/russiarxiv";
import { canonicalPmid } from "../src/core/adapters/util";
import type { AdapterHttp } from "../src/core/adapters/http";
import type { DatabaseAdapter } from "../src/core/adapters/types";
import type { NcbiArticle } from "../src/core/types";
import { createServer } from "../src/mcp/server";

const article = (id: string, extra: Partial<NcbiArticle> = {}): NcbiArticle => ({
  id,
  title: `Article ${id}`,
  authors: [],
  journal: "J Test",
  pubDate: "2020",
  publicationTypes: [],
  ...extra,
});

/** A fake adapter serving fixed articles, that records the ids it was asked for; `normalizeId` as given. */
function recordingAdapter(
  id: string,
  articles: NcbiArticle[],
  normalizeId?: (id: string) => string,
): { adapter: DatabaseAdapter; asked: string[][] } {
  const asked: string[][] = [];
  const adapter: DatabaseAdapter = {
    id,
    name: id,
    search: async () => ({ count: 0, ids: [] }),
    // In the order of the ids asked for, as the real adapters return them.
    fetch: async (ids) => {
      asked.push(ids);
      return ids.flatMap((i) => articles.filter((a) => a.id === i));
    },
    ...(normalizeId ? { normalizeId } : {}),
  };
  return { adapter, asked };
}

describe("canonicalPmid", () => {
  it("strips a PMID: or MED: prefix, in any case, with spaces around the colon", () => {
    for (const id of ["PMID:9500320", "pmid:9500320", "Pmid : 9500320", "MED:9500320", "med: 9500320", "MED :9500320"]) {
      expect(canonicalPmid(id), id).toBe("9500320");
    }
  });

  it("strips leading zeros from an all-digit id, and keeps a lone zero", () => {
    expect(canonicalPmid("00012345")).toBe("12345");
    expect(canonicalPmid("PMID:00012345")).toBe("12345");
    expect(canonicalPmid("0")).toBe("0");
    expect(canonicalPmid("000")).toBe("0");
    expect(canonicalPmid("9500320")).toBe("9500320");
  });

  it("leaves every other id as it came", () => {
    for (const id of ["PMC6181682", "pmc6181682", "PPR270079", "ppr270079", "CBA:644599", "cba:00644599", "IND609546324", "chinaxiv-202401.00001", "ru-196201.58177", "PMID:PMC6181682", "MED:abc", "12 345", ""]) {
      expect(canonicalPmid(id), id).toBe(id);
    }
  });
});

describe("fetchLiterature ids", () => {
  describe("duplicates", () => {
    it("fetches each id once and returns each article once, in the order of its first id", async () => {
      const { adapter, asked } = recordingAdapter("x", [article("A"), article("B"), article("C")]);
      const out = await fetchLiterature({ ids: ["C", "A", "C", "B", "A"], database: "x" }, new LRUBackend(), adapter);
      expect(asked).toEqual([["C", "A", "B"]]);
      expect(out.articles.map((a) => a.id)).toEqual(["C", "A", "B"]);
      expect(out.missing).toEqual([]);
      expect(out.warnings).toBeUndefined();
    });

    it("counts ids that differ only in case as one when the adapter folds case, as Europe PMC's does", async () => {
      const { adapter, asked } = recordingAdapter("europepmc", [article("PPR12345")], (id) => id.toUpperCase());
      const out = await fetchLiterature({ ids: ["PPR12345", "ppr12345"], database: "europepmc" }, new LRUBackend(), adapter);
      expect(asked).toEqual([["PPR12345"]]);
      expect(out.articles).toHaveLength(1);
      expect(out.missing).toEqual([]);
    });

    it("keeps ids that differ only in case apart when the adapter doesn't fold case", async () => {
      const { adapter, asked } = recordingAdapter("chinaxiv", [article("ru-1")]);
      const out = await fetchLiterature({ ids: ["RU-1", "ru-1", "RU-1"], database: "chinaxiv" }, new LRUBackend(), adapter);
      expect(asked).toEqual([["RU-1", "ru-1"]]);
      expect(out.articles.map((a) => a.id)).toEqual(["ru-1"]);
    });

    it("counts two spellings of one id as one, and returns the record once", async () => {
      const { adapter, asked } = recordingAdapter("pubmed", [article("9500320"), article("12345")], canonicalPmid);
      const out = await fetchLiterature(
        { ids: ["9500320", "PMID:9500320", "MED:9500320", "09500320", "12345"], database: "pubmed" },
        new LRUBackend(),
        adapter,
      );
      expect(asked).toEqual([["9500320", "12345"]]);
      expect(out.articles.map((a) => a.id)).toEqual(["9500320", "12345"]);
    });

    it("returns a record once when a PMCID and its PMID both name it", async () => {
      const record = article("29949275", { pmcid: "PMC6181682", database: "europepmc" });
      const epmc: DatabaseAdapter = { id: "europepmc", name: "Europe PMC", search: async () => ({ count: 0, ids: [] }), fetch: async (ids) => ids.map(() => record) };
      const out = await fetchLiterature({ ids: ["PMC6181682", "29949275"], database: "europepmc" }, new LRUBackend(), epmc);
      expect(out.articles.map((a) => a.id)).toEqual(["29949275"]);
      expect(out.missing).toEqual([]);
    });

    it("de-duplicates for an adapter that serves complete records separately (fetchFull)", async () => {
      const seen: string[][] = [];
      const adapter: DatabaseAdapter = {
        ...recordingAdapter("chinaxiv", []).adapter,
        fetchFull: async (ids) => {
          seen.push(ids);
          return ids.map((i) => article(i));
        },
      };
      const out = await fetchLiterature({ ids: ["chinaxiv-1", "chinaxiv-1", " chinaxiv-1"], database: "chinaxiv" }, new LRUBackend(), adapter);
      expect(seen).toEqual([["chinaxiv-1"]]);
      expect(out.articles).toHaveLength(1);
    });
  });

  describe("whitespace", () => {
    it("trims ids, so a padded id is found and not reported missing", async () => {
      const { adapter, asked } = recordingAdapter("x", [article("A")]);
      const out = await fetchLiterature({ ids: [" A ", "\tA\n", "B "], database: "x" }, new LRUBackend(), adapter);
      expect(asked).toEqual([["A", "B"]]);
      expect(out.articles.map((a) => a.id)).toEqual(["A"]);
      expect(out.missing).toEqual(["B"]);
    });
  });

  describe("empty ids", () => {
    // `found` held `a.pmcid ?? ""`, which counted "" as found as soon as one returned record had no PMCID.
    it("reports an empty id as missing, and counts it in the warning, beside a record without a PMCID", async () => {
      const { adapter, asked } = recordingAdapter("x", [article("A")]);
      const out = await fetchLiterature({ ids: ["", "A", "  ", "B"], database: "x" }, new LRUBackend(), adapter);
      expect(out.articles.map((a) => a.id)).toEqual(["A"]);
      expect(out.missing).toEqual(["", "B"]);
      expect(out.warnings).toEqual(["2 id(s) could not be fetched from x."]);
      expect(asked).toEqual([["A", "B"]]);
    });

    it("keeps an empty id missing when the records have a PMCID too", async () => {
      const { adapter } = recordingAdapter("x", [article("A", { pmcid: "PMC1" }), article("B")]);
      const out = await fetchLiterature({ ids: ["A", "", "B"], database: "x" }, new LRUBackend(), adapter);
      expect(out.missing).toEqual([""]);
    });

    it("asks the adapter for nothing when every id is empty", async () => {
      const { adapter, asked } = recordingAdapter("x", [article("A")]);
      const out = await fetchLiterature({ ids: ["", " "], database: "x" }, new LRUBackend(), adapter);
      expect(asked).toEqual([]);
      expect(out.articles).toEqual([]);
      expect(out.missing).toEqual([""]);
    });
  });

  describe("normalisation", () => {
    it("fetches the canonical id and returns the record under it", async () => {
      const { adapter, asked } = recordingAdapter("pubmed", [article("12345")], canonicalPmid);
      const out = await fetchLiterature({ ids: ["PMID:12345", "00012345"], database: "pubmed" }, new LRUBackend(), adapter);
      expect(asked).toEqual([["12345"]]);
      expect(out.articles.map((a) => a.id)).toEqual(["12345"]);
      expect(out.missing).toEqual([]);
    });

    it("lists a missing id as the caller sent it (trimmed), each spelling once, and not as its canonical form", async () => {
      const { adapter } = recordingAdapter("pubmed", [article("1")], canonicalPmid);
      const out = await fetchLiterature(
        { ids: [" PMID:99999999 ", "99999999", "00099999999", "99999999", "1"], database: "pubmed" },
        new LRUBackend(),
        adapter,
      );
      expect(out.missing).toEqual(["PMID:99999999", "99999999", "00099999999"]);
      // The warning counts ids, not spellings: these are one PMID.
      expect(out.warnings).toEqual(["1 id(s) could not be fetched from pubmed."]);
    });

    it("counts each id that could not be fetched once in the warning, whatever its spellings", async () => {
      const { adapter } = recordingAdapter("pubmed", [article("1")], canonicalPmid);
      const out = await fetchLiterature(
        { ids: ["PMID:7", "7", "1", "MED:8", "00008", "", " "], database: "pubmed" },
        new LRUBackend(),
        adapter,
      );
      expect(out.missing).toEqual(["PMID:7", "7", "MED:8", "00008", ""]);
      expect(out.warnings).toEqual(["3 id(s) could not be fetched from pubmed."]);
    });

    it("leaves an id alone for an adapter without normalizeId", async () => {
      const { adapter, asked } = recordingAdapter("chinaxiv", [article("chinaxiv-202401.00001")]);
      const out = await fetchLiterature({ ids: ["chinaxiv-202401.00001", "PMID:12345", "007"], database: "chinaxiv" }, new LRUBackend(), adapter);
      expect(asked).toEqual([["chinaxiv-202401.00001", "PMID:12345", "007"]]);
      expect(out.missing).toEqual(["PMID:12345", "007"]);
    });

    it("keeps the order of the first-seen ids for the returned articles", async () => {
      const { adapter } = recordingAdapter("pubmed", [article("1"), article("2"), article("3")], canonicalPmid);
      const out = await fetchLiterature({ ids: ["3", "PMID:1", "002", "0003", "1"], database: "pubmed" }, new LRUBackend(), adapter);
      expect(out.articles.map((a) => a.id)).toEqual(["3", "1", "2"]);
    });
  });
});

describe("PubMed and Europe PMC adapters normalise ids", () => {
  it("normalizeId strips the prefix and leading zeros, and only for PMIDs", () => {
    for (const adapter of [new PubMedAdapter(new NcbiClient({ email: "test@example.com" })), new EuropePmcAdapter()]) {
      expect(adapter.normalizeId("PMID:9500320")).toBe("9500320");
      expect(adapter.normalizeId("MED:9500320")).toBe("9500320");
      expect(adapter.normalizeId("00012345")).toBe("12345");
      expect(adapter.normalizeId("PMC6181682")).toBe("PMC6181682");
      expect(adapter.normalizeId("CBA:644599")).toBe("CBA:644599");
    }
  });

  it("Europe PMC's normalizeId writes every other id in capitals, as it returns them", () => {
    const epmc = new EuropePmcAdapter();
    expect(epmc.normalizeId("pmc6181682")).toBe("PMC6181682");
    expect(epmc.normalizeId("ppr270079")).toBe("PPR270079");
    expect(epmc.normalizeId("cba:644599")).toBe("CBA:644599");
    expect(epmc.normalizeId("ind609546324")).toBe("IND609546324");
    expect(epmc.normalizeId("PMID:00009500320")).toBe("9500320");
  });

  it("PubMed's normalizeId leaves the case of an id that is no PMID alone", () => {
    expect(new PubMedAdapter(new NcbiClient({ email: "test@example.com" })).normalizeId("pmc6181682")).toBe("pmc6181682");
  });
});

describe("literature_fetch on PubMed", () => {
  afterEach(() => vi.unstubAllGlobals());

  /** NCBI answering esummary for the PMIDs it knows (none has a PMCID) and efetch with no records; `asked` is each esummary's `id`. */
  function stubNcbi(known: string[]): { asked: string[] } {
    const asked: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string | URL | Request) => {
        const url = new URL(String(input));
        if (url.pathname.endsWith("efetch.fcgi")) return new Response("<PubmedArticleSet/>");
        const ids = url.searchParams.get("id")!.split(",");
        asked.push(url.searchParams.get("id")!);
        const hits = ids.filter((id) => known.includes(id));
        return new Response(JSON.stringify({ result: { uids: hits, ...Object.fromEntries(hits.map((id) => [id, { uid: id, title: `T${id}`, pubdate: "2021" }])) } }));
      }),
    );
    return { asked };
  }

  it("fetches a duplicated, padded or prefixed PMID once, and reports what it didn't find as sent", async () => {
    const { asked } = stubNcbi(["38453139", "9500320"]);
    const adapter = new PubMedAdapter(new NcbiClient({ email: "test@example.com", apiKey: "test-key" }));
    const out = await fetchLiterature(
      { ids: ["38453139", "38453139", " 9500320 ", "PMID:38453139", "00009500320", " PMID: 12345 "], database: "pubmed" },
      new LRUBackend(),
      adapter,
    );
    expect(asked).toEqual(["38453139,9500320,12345"]);
    expect(out.articles.map((a) => a.id)).toEqual(["38453139", "9500320"]);
    expect(out.missing).toEqual(["PMID: 12345"]);
  });
});

describe("literature_fetch on Europe PMC", () => {
  /** Europe PMC answering each exact-id query with its record, or with none. */
  function epmcHttp(records: Record<string, object>): { http: AdapterHttp; queries: string[] } {
    const queries: string[] = [];
    const http: AdapterHttp = {
      json: async <T>(url: string): Promise<T> => {
        const query = new URL(url).searchParams.get("query")!;
        queries.push(query);
        const hit = records[query];
        return { hitCount: hit ? 1 : 0, resultList: { result: hit ? [hit] : [] } } as T;
      },
    };
    return { http, queries };
  }

  const medline = { id: "9500320", source: "MED", pmid: "9500320", title: "A MEDLINE record", pubYear: "1998" };
  const preprint = { id: "PPR270079", source: "PPR", title: "A preprint", pubYear: "2020" };
  const pmc = { id: "30243806", source: "MED", pmid: "30243806", pmcid: "PMC6181682", title: "A PMC record", pubYear: "2018" };
  const cba = { id: "644599", source: "CBA", title: "A CBA record", pubYear: "2007" };
  const records = {
    "EXT_ID:9500320 AND SRC:MED": medline,
    "EXT_ID:PPR270079 AND SRC:PPR": preprint,
    "PMCID:PMC6181682": pmc,
    "EXT_ID:644599 AND SRC:CBA": cba,
  };

  it("finds MED: and PMID: ids as the PMID, and keeps PMCIDs, PPR and CBA ids working in any case", async () => {
    const { http, queries } = epmcHttp(records);
    const out = await fetchLiterature(
      { ids: ["MED:9500320", "PMID:9500320", " PPR270079 ", "pmc6181682", "CBA:644599", "ppr270079", "cba:644599"], database: "europepmc" },
      new LRUBackend(),
      new EuropePmcAdapter(http),
    );
    expect(out.articles.map((a) => a.id)).toEqual(["9500320", "PPR270079", "30243806", "CBA:644599"]);
    expect(out.missing).toEqual([]);
    expect(out.warnings).toBeUndefined();
    // One lookup per record: the spellings of one id share it.
    expect(queries).toEqual(["EXT_ID:9500320 AND SRC:MED", "EXT_ID:PPR270079 AND SRC:PPR", "PMCID:PMC6181682", "EXT_ID:644599 AND SRC:CBA"]);
  });

  it("looks each record up once when its id is sent in two cases", async () => {
    const { http, queries } = epmcHttp(records);
    const out = await fetchLiterature(
      { ids: ["ppr270079", "PPR270079", "PMC6181682", "pmc6181682", "cba:644599", "CBA:644599"], database: "europepmc" },
      new LRUBackend(),
      new EuropePmcAdapter(http),
    );
    expect(queries).toEqual(["EXT_ID:PPR270079 AND SRC:PPR", "PMCID:PMC6181682", "EXT_ID:644599 AND SRC:CBA"]);
    expect(out.articles.map((a) => a.id)).toEqual(["PPR270079", "30243806", "CBA:644599"]);
    expect(out.missing).toEqual([]);
  });

  it("looks a zero-padded PMID up as its number, and lists a PMID it can't find as sent", async () => {
    const { http, queries } = epmcHttp(records);
    const out = await fetchLiterature({ ids: ["009500320", "MED:123"], database: "europepmc" }, new LRUBackend(), new EuropePmcAdapter(http));
    expect(queries).toEqual(["EXT_ID:9500320 AND SRC:MED", "EXT_ID:123 AND SRC:MED"]);
    expect(out.articles.map((a) => a.id)).toEqual(["9500320"]);
    expect(out.missing).toEqual(["MED:123"]);
  });
});

describe("literature_fetch on ChinaXiv and RussiaRxiv", () => {
  const chinaxiv = { id: "chinaxiv-202401.00027", title: "A ChinaXiv record", authors: [], date: "2024-01-03", source: "chinaxiv", source_language: "zh" };
  const russiarxiv = { id: "ru-196201.58177", title: "A RussiaRxiv record", authors: [], date: "1962-01-01", source: "russiarxiv", source_language: "ru" };

  /** ChinaRxiv answering `/papers/{id}` by exact id, and 404 (an error to the HTTP seam) for any other case, as the live API does. */
  function caseSensitiveHttp(): { http: AdapterHttp; ids: string[] } {
    const ids: string[] = [];
    const records: Record<string, object> = { [chinaxiv.id]: chinaxiv, [russiarxiv.id]: russiarxiv };
    const http: AdapterHttp = {
      json: async <T>(url: string): Promise<T> => {
        const id = decodeURIComponent(url.slice(url.lastIndexOf("/") + 1));
        ids.push(id);
        const record = records[id];
        if (!record) throw new Error("HTTP 404");
        return record as T;
      },
      text: async () => "",
    };
    return { http, ids };
  }

  const cases: [string, (http: AdapterHttp) => DatabaseAdapter, string][] = [
    ["chinaxiv", (http) => new ChinaRXivAdapter(http), chinaxiv.id],
    ["russiarxiv", (http) => new SovietRxivAdapter(http), russiarxiv.id],
  ];

  for (const [database, make, id] of cases) {
    it(`${database}: asks for each id as sent, so a wrong-case id first can't hide the right-case one`, async () => {
      const { http, ids } = caseSensitiveHttp();
      const out = await fetchLiterature({ ids: [id.toUpperCase(), id], database }, new LRUBackend(), make(http));
      expect(ids).toEqual([id.toUpperCase(), id]);
      expect(out.articles.map((a) => a.id)).toEqual([id]);
    });

    it(`${database}: reports a wrong-case id missing when it is the only spelling sent`, async () => {
      const { http } = caseSensitiveHttp();
      const out = await fetchLiterature({ ids: [id.toUpperCase()], database }, new LRUBackend(), make(http));
      expect(out.articles).toEqual([]);
      expect(out.missing).toEqual([id.toUpperCase()]);
      expect(out.warnings).toEqual([expect.stringContaining("1 id(s) could not be fetched")]);
    });

    it(`${database}: fetches an id sent twice, or padded, once`, async () => {
      const { http, ids } = caseSensitiveHttp();
      const out = await fetchLiterature({ ids: [id, ` ${id} `, id], database }, new LRUBackend(), make(http));
      expect(ids).toEqual([id]);
      expect(out.articles.map((a) => a.id)).toEqual([id]);
      expect(out.missing).toEqual([]);
    });
  }
});

describe("literature_fetch tool", () => {
  afterEach(() => vi.unstubAllGlobals());

  async function connect(ncbi?: NcbiClient) {
    const server = createServer({ cache: new LRUBackend(), ...(ncbi ? { ncbi } : {}) });
    const client = new Client({ name: "test", version: "0.0.0" });
    const [ct, st] = InMemoryTransport.createLinkedPair();
    await Promise.all([server.connect(st), client.connect(ct)]);
    return { client, server };
  }

  it("describes each id as a non-empty string in its schema", async () => {
    const { client, server } = await connect();
    const { tools } = await client.listTools();
    const ids = (tools.find((t) => t.name === "literature_fetch")!.inputSchema as { properties: { ids: object } }).properties.ids;
    expect(ids).toMatchObject({ type: "array", minItems: 1, maxItems: 50, items: { type: "string", minLength: 1 } });
    await client.close();
    await server.close();
  });

  it("refuses an empty or blank id with a message that names it, and fetches nothing", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const { client, server } = await connect();
    for (const ids of [[""], ["38453139", ""], ["  ", "38453139"]]) {
      const result = await client.callTool({ name: "literature_fetch", arguments: { database: "pubmed", ids } });
      expect(result.isError, JSON.stringify(ids)).toBe(true);
      const text = (result.content as { text: string }[])[0]!.text;
      expect(text, JSON.stringify(ids)).toContain("ids");
      expect(text, JSON.stringify(ids)).toContain("An id can't be empty.");
    }
    expect(fetchMock).not.toHaveBeenCalled();
    await client.close();
    await server.close();
  });

  it("trims and de-duplicates ids end to end", async () => {
    const asked: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string | URL | Request) => {
        const url = new URL(String(input));
        if (url.pathname.endsWith("efetch.fcgi")) return new Response("<PubmedArticleSet/>");
        const ids = url.searchParams.get("id")!.split(",");
        asked.push(...ids);
        return new Response(JSON.stringify({ result: { uids: ids, ...Object.fromEntries(ids.map((id) => [id, { uid: id, title: `T${id}`, pubdate: "2021" }])) } }));
      }),
    );
    const { client, server } = await connect(new NcbiClient({ email: "test@example.com", apiKey: "test-key" }));
    const result = await client.callTool({
      name: "literature_fetch",
      arguments: { database: "pubmed", ids: ["38453139", "38453139", " 9500320 ", "PMID:9500320"] },
    });
    expect(result.isError).toBeFalsy();
    const out = JSON.parse((result.content as { text: string }[])[0]!.text) as { articles: { id: string }[]; missing: string[]; warnings?: string[] };
    expect(asked).toEqual(["38453139", "9500320"]);
    expect(out.articles.map((a) => a.id)).toEqual(["38453139", "9500320"]);
    expect(out.missing).toEqual([]);
    expect(out.warnings).toBeUndefined();
    await client.close();
    await server.close();
  });
});
