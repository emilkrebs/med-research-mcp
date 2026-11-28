import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { adaptersFor } from "../src/core/adapters/registry";
import { ChinaRXivAdapter } from "../src/core/adapters/chinarxiv";
import { SovietRxivAdapter } from "../src/core/adapters/russiarxiv";
import { EuropePmcAdapter } from "../src/core/adapters/europepmc";
import { PubMedAdapter } from "../src/core/adapters/pubmed";
import { isIso639_1, normalizeLanguage } from "../src/core/adapters/util";
import type { AdapterHttp } from "../src/core/adapters/http";
import type { DatabaseAdapter } from "../src/core/adapters/types";
import { LRUBackend } from "../src/core/cache";
import { fetchFulltext, type FetchedResource, type FulltextDeps } from "../src/core/fulltext";
import { searchLiterature } from "../src/core/literature";
import type { ResearchApiException } from "../src/core/errors";
import type { NcbiClient } from "../src/core/pubmed";
import type { UnpaywallClient, UnpaywallLookup } from "../src/core/unpaywall";
import type { Article, NcbiArticle, SearchInput } from "../src/core/types";
import { createServer } from "../src/mcp/server";

/**
 * Five gaps in how input is read: an empty database list, a language that is no code or that a database doesn't act on,
 * DOI links without a scheme or with an encoded slash, MED:/PMID: ids for the full text, and abstractMaxChars below the
 * first word. Every network seam is stubbed; a request that gets out is a failure.
 */

const strayRequests: string[] = [];
beforeEach(() => {
  strayRequests.length = 0;
  vi.stubGlobal("fetch", async (url: unknown) => {
    strayRequests.push(String(url));
    throw new Error("no network in tests");
  });
});
afterEach(() => {
  vi.unstubAllGlobals();
  expect(strayRequests).toEqual([]);
});

const record = (id: string, extra: Partial<NcbiArticle> = {}): NcbiArticle => ({
  id,
  title: `Record ${id}`,
  authors: ["Doe J"],
  journal: "J Test",
  pubDate: "2021",
  publicationTypes: [],
  ...extra,
});

/** A fake adapter serving one record, that keeps the inputs of the searches it was given. */
function fakeAdapter(id: string, name: string, extra: Partial<DatabaseAdapter> = {}): { adapter: DatabaseAdapter; inputs: SearchInput[] } {
  const inputs: SearchInput[] = [];
  const adapter: DatabaseAdapter = {
    id,
    name,
    search: async (input) => {
      inputs.push(input);
      return { count: 1, ids: [`${id}-1`] };
    },
    fetch: async (ids) => ids.map((i) => record(i)),
    ...extra,
  };
  return { adapter, inputs };
}

const failure = (promise: Promise<unknown>): Promise<ResearchApiException> => promise.then(
  () => {
    throw new Error("expected a rejection");
  },
  (e: unknown) => e as ResearchApiException,
);

async function connect() {
  const server = createServer({ cache: new LRUBackend() });
  const client = new Client({ name: "test", version: "0.0.0" });
  const [ct, st] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(st), client.connect(ct)]);
  return { client, server };
}

describe("an empty database list", () => {
  it("is INVALID_INPUT in the core, saying what to send, and no longer searches pubmed", async () => {
    const error = await failure(searchLiterature({ query: "creatine", database: [] }, new LRUBackend()));
    expect(error).toMatchObject({ code: "INVALID_INPUT", recoverable: true });
    expect(error.userMessage).toContain("database is an empty list");
    for (const id of ["pubmed", "europepmc", "chinaxiv", "russiarxiv", '"all"']) expect(error.userMessage).toContain(id);
    expect(error.userMessage).toContain("leave database out to search pubmed");
    expect(() => adaptersFor([])).toThrow(/empty list/);
    // No request was sent for it (strayRequests is checked after every test).
  });

  it("leaves an omitted database as pubmed, and a list with entries as it was", () => {
    expect(adaptersFor(undefined).map((a) => a.id)).toEqual(["pubmed"]);
    expect(adaptersFor(["europepmc", "PubMed", "europepmc"]).map((a) => a.id)).toEqual(["europepmc", "pubmed"]);
    expect(adaptersFor("all")).toHaveLength(4);
  });

  it("still refuses an explicit empty adapter list, with INVALID_INPUT that says what to pass", async () => {
    const error = await failure(searchLiterature({ query: "creatine" }, new LRUBackend(), []));
    expect(error).toMatchObject({ code: "INVALID_INPUT" });
    expect(error.userMessage).toContain("No database to search");
    expect(error.userMessage).toContain("Pass at least one adapter");
  });

  it("is refused by the MCP schema, with the same advice and a minItems of 1", async () => {
    const { client, server } = await connect();
    const { tools } = await client.listTools();
    const search = tools.find((t) => t.name === "literature_search")!;
    const database = (search.inputSchema as { properties: Record<string, { anyOf: { type: string; minItems?: number }[] }> }).properties.database!;
    expect(database.anyOf.find((s) => s.type === "array")).toMatchObject({ minItems: 1 });

    const result = await client.callTool({ name: "literature_search", arguments: { query: "creatine", database: [] } });
    expect(result.isError).toBe(true);
    const text = (result.content as { text: string }[])[0]!.text;
    expect(text).toContain("database is an empty list");
    expect(text).toContain("pubmed, europepmc, chinaxiv, russiarxiv");
    expect(text).toContain("leave database out");
    // An unknown id keeps its own message.
    const unknown = await client.callTool({ name: "literature_search", arguments: { query: "creatine", database: ["pubmd"] } });
    expect((unknown.content as { text: string }[])[0]!.text).toContain("Unknown database");
    await client.close();
    await server.close();
  });
});

describe("language", () => {
  it("accepts ISO 639-1 codes only: two letters, in the registry's table", () => {
    for (const code of ["en", "de", "fr", "zh", "ja", "ru", "it", "es", "pt", "nb", "aa", "zu"]) expect(isIso639_1(code), code).toBe(true);
    // No code: unassigned, three letters (ISO 639-2 and PubMed's own), a locale, a name, the one 639-1 code the LoC table gives no two-letter form.
    for (const code of ["xx", "zz", "eng", "ger", "en-US", "english", "e", "", "bh", "1a"]) expect(isIso639_1(code), code).toBe(false);
    // The caller's spelling is normalised before the check: case and padding don't matter, a blank is no language.
    expect(normalizeLanguage(" RU ")).toBe("ru");
    expect(normalizeLanguage("En")).toBe("en");
    expect(normalizeLanguage("  ")).toBeUndefined();
    expect(normalizeLanguage("")).toBeUndefined();
    expect(normalizeLanguage(undefined)).toBeUndefined();
  });

  it("refuses a value that is no ISO 639-1 code with INVALID_INPUT, before any database is asked", async () => {
    const { adapter, inputs } = fakeAdapter("pubmed", "PubMed");
    for (const language of ["xx", "eng", "en-US", "english"]) {
      const error = await failure(searchLiterature({ query: "creatine", language }, new LRUBackend(), [adapter]));
      expect(error, language).toMatchObject({ code: "INVALID_INPUT", recoverable: true });
      expect(error.userMessage, language).toContain(`language ${JSON.stringify(language)} is not an ISO 639-1 code`);
      expect(error.userMessage, language).toContain('two-letter code such as "en", "de" or "ru"');
    }
    // A three-letter code says where PubMed's own go; the others don't mention it.
    const three = await failure(searchLiterature({ query: "creatine", language: "eng" }, new LRUBackend(), [adapter]));
    expect(three.userMessage).toContain("eng[la]");
    const xx = await failure(searchLiterature({ query: "creatine", language: "xx" }, new LRUBackend(), [adapter]));
    expect(xx.userMessage).not.toContain("[la]");
    expect(inputs).toEqual([]);
  });

  it("is refused through the MCP tool too", async () => {
    const { client, server } = await connect();
    const result = await client.callTool({ name: "literature_search", arguments: { query: "creatine", language: "xx" } });
    expect(result.isError).toBe(true);
    const text = (result.content as { text: string }[])[0]!.text;
    expect(text).toContain("INVALID_INPUT");
    expect(text).toContain("is not an ISO 639-1 code");
    await client.close();
    await server.close();
  });

  it("warns, naming the database, when a valid code reaches one that doesn't filter by it", async () => {
    const { adapter, inputs } = fakeAdapter("pubmed", "PubMed / NCBI");
    const out = await searchLiterature({ query: "creatine", language: "de" }, new LRUBackend(), [adapter]);
    expect(out.warnings).toEqual(['language "de" was not applied to PubMed. To filter PubMed by language, add a language tag to the query, such as ger[la].']);
    // The search itself still ran, with the language it was given.
    expect(inputs.map((i) => i.language)).toEqual(["de"]);
    expect(out.articles).toHaveLength(1);
  });

  it("names every database it was not applied to, and says which codes the others apply", async () => {
    const pubmed = fakeAdapter("pubmed", "PubMed / NCBI").adapter;
    const europepmc = fakeAdapter("europepmc", "Europe PMC").adapter;
    const chinaxiv = fakeAdapter("chinaxiv", "ChinaXiv (via ChinaRxiv)", { languages: ["ru"] }).adapter;
    const russiarxiv = fakeAdapter("russiarxiv", "RussiaRxiv (via ChinaRxiv)", { languages: ["ru"] }).adapter;
    const all = [pubmed, europepmc, chinaxiv, russiarxiv];

    const en = await searchLiterature({ query: "creatine", language: "en" }, new LRUBackend(), all);
    expect(en.warnings).toEqual([
      'language "en" was not applied to PubMed, Europe PMC, ChinaXiv and RussiaRxiv. ChinaXiv and RussiaRxiv apply only "ru". ' +
        "To filter PubMed and Europe PMC by language, add a language tag to the query, such as ger[la].",
    ]);

    // "ru" is applied by ChinaXiv and RussiaRxiv: only the other two are named.
    const ru = await searchLiterature({ query: "creatine", language: "ru" }, new LRUBackend(), all);
    expect(ru.warnings).toEqual([
      'language "ru" was not applied to PubMed and Europe PMC. To filter PubMed and Europe PMC by language, add a language tag to the query, such as ger[la].',
    ]);

    // Applied everywhere it is searched: nothing to say. And no language, no warning.
    const only = await searchLiterature({ query: "creatine", language: "ru" }, new LRUBackend(), [chinaxiv, russiarxiv]);
    expect(only.warnings).toBeUndefined();

    // One database that reads a code reads it in the singular; the pubmed and europepmc part is left out when neither is searched.
    const one = await searchLiterature({ query: "creatine", language: "zh" }, new LRUBackend(), [chinaxiv]);
    expect(one.warnings).toEqual(['language "zh" was not applied to ChinaXiv. ChinaXiv applies only "ru".']);
    const none = await searchLiterature({ query: "creatine" }, new LRUBackend(), all);
    expect(none.warnings).toBeUndefined();
  });

  it("names only the databases searched: one skipped for a design filter is left out", async () => {
    const pubmed = fakeAdapter("pubmed", "PubMed / NCBI").adapter;
    const chinaxiv = fakeAdapter("chinaxiv", "ChinaXiv (via ChinaRxiv)", { languages: ["ru"], designMetadata: false }).adapter;
    const out = await searchLiterature({ query: "creatine", language: "en", minDesignTier: 4 }, new LRUBackend(), [pubmed, chinaxiv]);
    const warning = out.warnings!.find((w) => w.startsWith("language"))!;
    expect(warning).toBe('language "en" was not applied to PubMed. To filter PubMed by language, add a language tag to the query, such as ger[la].');
    expect(out.warnings!.some((w) => w.includes("ChinaXiv (via ChinaRxiv) not searched"))).toBe(true);
  });

  it("hands the databases the language trimmed and in lower case, and none when it is blank", async () => {
    const { adapter, inputs } = fakeAdapter("chinaxiv", "ChinaXiv (via ChinaRxiv)", { languages: ["ru"] });
    await searchLiterature({ query: "creatine", language: " RU " }, new LRUBackend(), [adapter]);
    await searchLiterature({ query: "creatine", language: "   " }, new LRUBackend(), [adapter]);
    expect(inputs.map((i) => i.language)).toEqual(["ru", undefined]);
    expect("language" in inputs[1]!).toBe(false);
    // A blank language is no language: nothing to refuse and nothing to warn about.
    const out = await searchLiterature({ query: "creatine", language: "" }, new LRUBackend(), [fakeAdapter("pubmed", "PubMed").adapter]);
    expect(out.warnings).toBeUndefined();
  });

  /** An HTTP seam answering every search with one ChinaRxiv record, and keeping the URLs asked. */
  function chinarxivHttp(): { http: AdapterHttp; urls: string[] } {
    const urls: string[] = [];
    const http: AdapterHttp = {
      json: async <T>(url: string): Promise<T> => {
        urls.push(url);
        return { total: 0, data: [], next_cursor: null } as T;
      },
      text: async () => "",
    };
    return { http, urls };
  }

  it("is read by the ChinaXiv adapter as RussiaRxiv for ru in any case, and by no other code", async () => {
    for (const [language, source] of [["ru", "russiarxiv"], ["RU", "russiarxiv"], [" Ru ", "russiarxiv"], ["zh", "chinaxiv"], ["en", "chinaxiv"], [undefined, "chinaxiv"]] as const) {
      const { http, urls } = chinarxivHttp();
      await new ChinaRXivAdapter(http).search({ query: "clinical", ...(language ? { language } : {}) });
      expect(new URL(urls[0]!).searchParams.get("source"), String(language)).toBe(source);
    }
  });

  it("says in the registry's adapters which of them act on a code: the two ChinaRxiv corpora, for ru", () => {
    expect(new ChinaRXivAdapter().languages).toEqual(["ru"]);
    expect(new SovietRxivAdapter().languages).toEqual(["ru"]);
    expect(new PubMedAdapter().languages).toBeUndefined();
    expect(new EuropePmcAdapter().languages).toBeUndefined();
  });

  it("end to end through the real ChinaRxiv adapters: ru is applied, another code warns", async () => {
    const chinaxiv = new ChinaRXivAdapter(chinarxivHttp().http);
    const russiarxiv = new SovietRxivAdapter(chinarxivHttp().http);
    const ru = await searchLiterature({ query: "clinical", language: "RU" }, new LRUBackend(), [chinaxiv, russiarxiv]);
    expect(ru.warnings?.filter((w) => w.includes("was not applied"))).toEqual([]);
    const zh = await searchLiterature({ query: "clinical", language: "zh" }, new LRUBackend(), [chinaxiv, russiarxiv]);
    expect(zh.warnings).toContain('language "zh" was not applied to ChinaXiv and RussiaRxiv. ChinaXiv and RussiaRxiv apply only "ru".');
  });
});

describe("abstractMaxChars below the first word", () => {
  const abstract = "Supplementing with creatine is very effective in older adults.";
  const search = async (abstractMaxChars: number) => {
    const adapter = fakeAdapter("pubmed", "PubMed", { fetch: async (ids) => ids.map((i) => record(i, { abstract })) }).adapter;
    return (await searchLiterature({ query: "creatine", abstractMaxChars }, new LRUBackend(), [adapter])).articles[0]!;
  };

  it("cuts the first word where it stands when it is longer than the limit, and says so in the description", async () => {
    // "Supplementing" has 13 letters: a limit of 14 holds it and the "…"; below that there is no word boundary to cut at.
    expect((await search(14)).abstract).toBe("Supplementing…");
    expect((await search(13)).abstract).toBe("Supplementin…");
    expect((await search(5)).abstract).toBe("Supp…");
    expect((await search(2)).abstract).toBe("S…");
    for (const max of [2, 5, 13, 14]) expect((await search(max)).abstractTruncated, String(max)).toBe(true);
    // 1 leaves no room for a letter before the "…": the abstract is left out, as with 0, and the flag still says there was one.
    for (const max of [0, 1]) {
      const article = await search(max);
      expect(article.abstract, String(max)).toBeUndefined();
      expect(article.abstractTruncated, String(max)).toBe(true);
    }
    // Past the first word it still ends at a word boundary.
    expect((await search(24)).abstract).toBe("Supplementing with…");

    const { client, server } = await connect();
    const { tools } = await client.listTools();
    const props = (tools.find((t) => t.name === "literature_search")!.inputSchema as { properties: Record<string, { description: string }> }).properties;
    expect(props.abstractMaxChars!.description).toContain("If the first word and the … don't fit in the limit, that word is cut where it stands");
    expect(props.abstractMaxChars!.description).toContain("1 leaves the abstract out");
    await client.close();
    await server.close();
  });
});

describe("tool descriptions", () => {
  it("tell a client about the empty list, the language rule, and the id and DOI forms literature_fulltext reads", async () => {
    const { client, server } = await connect();
    const { tools } = await client.listTools();
    const props = (name: string) => (tools.find((t) => t.name === name)!.inputSchema as { properties: Record<string, { description: string }> }).properties;
    expect(props("literature_search").database!.description).toContain("not empty");
    expect(props("literature_search").language!.description).toContain("ISO 639-1");
    expect(props("literature_search").language!.description).toContain("any other value is refused");
    expect(props("literature_fulltext").id!.description).toContain("PMID:…");
    expect(props("literature_fulltext").id!.description).toContain("MED:…");
    expect(props("literature_fulltext").doi!.description).toContain("%2F");
    await client.close();
    await server.close();
  });
});

// ─── literature_fulltext: DOI forms and MED:/PMID: ids ─────────────

const DOI = "10.1000/xyz123";

const paywalled = (): FetchedResource => ({ ok: false, status: 403, contentType: "text/html", finalUrl: "x" });
const htmlResource = (text: string): FetchedResource => ({ ok: true, status: 200, contentType: "text/html", finalUrl: "https://oa.example/article", text });
const LONG_MARKDOWN = "# Methods\n\n" + "word ".repeat(600);
/** No adapter for any database: a lookup of a record that PubMed doesn't know finds nothing. */
const noRecords: FulltextDeps["adapter"] = () => undefined;

/** An NCBI client whose esummary and efetch answer for the one PMID, and keep the PMIDs they were asked for. */
function fakeClient(summary: Article | null) {
  const asked: string[] = [];
  const client = {
    tool: "med-research-mcp",
    esummary: async (pmids: string[]) => {
      asked.push(...pmids);
      return new Map(summary ? [[pmids[0]!, summary]] : []);
    },
    efetch: async (pmids: string[]) => new Map([[pmids[0]!, { abstract: "An abstract.", publicationTypes: [], meshHeadings: [], corrections: [] }]]),
  } as unknown as NcbiClient;
  return { client, asked };
}

describe("literature_fulltext reads a DOI given as a doi.org link in any usual form", () => {
  /** The DOI each form reaches Unpaywall as, for an id that needs the DOI; null when the form was refused. */
  async function resolved(doi: string): Promise<string | null | ResearchApiException> {
    const lookup = vi.fn(async (): Promise<UnpaywallLookup> => ({ status: "none" }));
    const deps: FulltextDeps = { unpaywall: { lookup } as unknown as UnpaywallClient, fetchUrl: async () => paywalled(), adapter: noRecords };
    try {
      await fetchFulltext({ id: "CBA:644599", doi }, new LRUBackend(), fakeClient(null).client, deps);
    } catch (e) {
      return e as ResearchApiException;
    }
    return (lookup.mock.calls[0] as unknown as [string])[0];
  }

  it("without a scheme: doi.org/, dx.doi.org/ and www.doi.org/", async () => {
    for (const doi of [`doi.org/${DOI}`, `dx.doi.org/${DOI}`, `www.doi.org/${DOI}`, `DOI.ORG/${DOI}`, ` doi.org/${DOI} `]) {
      expect(await resolved(doi), doi).toBe(DOI);
    }
  });

  it("with the scheme as before, and with a doi: prefix", async () => {
    for (const doi of [`https://doi.org/${DOI}`, `http://dx.doi.org/${DOI}`, `https://www.doi.org/${DOI}`, `doi:${DOI}`, `DOI: ${DOI}`, DOI]) {
      expect(await resolved(doi), doi).toBe(DOI);
    }
  });

  it("with the slash of the DOI percent-encoded, in a link", async () => {
    for (const doi of ["https://doi.org/10.1000%2Fxyz123", "https://doi.org/10.1000%2fxyz123", "doi.org/10.1000%2Fxyz123", "https://dx.doi.org/10.1000%2Fxyz123"]) {
      expect(await resolved(doi), doi).toBe(DOI);
    }
    // Other escapes in a link are read too: the parentheses of an old Wiley DOI.
    expect(await resolved("https://doi.org/10.1002%2F%28SICI%291097-4571")).toBe("10.1002/(SICI)1097-4571");
    // The trailing punctuation of a sentence is dropped after decoding, as for any DOI.
    expect(await resolved("https://doi.org/10.1000%2Fxyz123.")).toBe(DOI);
  });

  it("decodes nothing in a bare DOI: a % there is the DOI's own, and one without a slash is no DOI", async () => {
    expect(await resolved("10.1000/abc%2Fdef")).toBe("10.1000/abc%2Fdef");
    expect(await resolved("doi:10.1000/abc%2Fdef")).toBe("10.1000/abc%2Fdef");
    const noSlash = await resolved("10.1000%2Fxyz123");
    expect(noSlash).toMatchObject({ code: "INVALID_INPUT" });
  });

  it("still refuses a URL that is not a DOI link, however its path reads", async () => {
    const refused = [
      "https://example.org/10.1000/xyz123",
      "example.org/10.1000/xyz123",
      "https://doi.org.example.net/10.1000/xyz123",
      "doi.org.example.net/10.1000/xyz123",
      "https://doi.org@example.net/10.1000/xyz123",
      "https://example.org/doi.org/10.1000/xyz123",
      "https://chinaxiv.org/abs/202401.00027",
      "https://doi.org/",
      "doi.org/10.1000",
      "https://doi.org/10.1000%2Fxyz%20123",
      "https://doi.org/10.1000%2F%E0%A4%A",
    ];
    for (const doi of refused) {
      const error = await resolved(doi);
      expect(error, doi).toMatchObject({ code: "INVALID_INPUT" });
      expect((error as ResearchApiException).userMessage, doi).toContain(`doi ${JSON.stringify(doi)} is not a DOI`);
    }
  });

  it("names the accepted forms in the error for a value that is none of them", async () => {
    const error = (await resolved("not a doi")) as ResearchApiException;
    expect(error.userMessage).toContain("doi.org/10.1234/abc link (https:// optional)");
  });
});

describe("literature_fulltext reads MED: and PMID: ids as PMIDs", () => {
  const SUMMARY: Article = { id: "12345678", title: "Creatine and cognition", authors: ["Doe J"], journal: "J Test", pubDate: "2021", doi: DOI, publicationTypes: [] };
  const deps = (adapter: NonNullable<FulltextDeps["adapter"]>): FulltextDeps => ({
    unpaywall: { lookup: async (): Promise<UnpaywallLookup> => ({ status: "found", result: { doi: DOI, isOa: true, urls: ["https://oa.example/article"] } }) } as unknown as UnpaywallClient,
    fetchUrl: async () => htmlResource("<html><body>text</body></html>"),
    htmlToMarkdown: async () => LONG_MARKDOWN,
    adapter,
  });

  it("returns the PMID's text under the bare PMID, without asking Europe PMC for a record named MED:…", async () => {
    for (const id of ["MED:12345678", "med: 12345678", "PMID:12345678", "pmid : 12345678", "MED:0012345678", "12345678"]) {
      const lookedUp: string[] = [];
      const { client, asked } = fakeClient(SUMMARY);
      const out = await fetchFulltext({ id, maxChars: 100 }, new LRUBackend(), client, deps(() => ({ fetch: async (ids: string[]) => (lookedUp.push(...ids), []) })));
      expect(out, id).toMatchObject({ id: "12345678", doi: DOI, source: "unpaywall", format: "markdown" });
      expect(asked, id).toEqual(["12345678"]);
      expect(lookedUp, id).toEqual([]);
    }
  });

  it("checks a doi given with the prefixed id against the PMID's record", async () => {
    const { client } = fakeClient(SUMMARY);
    const error = await failure(fetchFulltext({ id: "MED:12345678", doi: "10.1000/other" }, new LRUBackend(), client, deps(noRecords)));
    expect(error).toMatchObject({ code: "INVALID_INPUT" });
    expect(error.userMessage).toContain("is not the DOI of PMID 12345678");
  });

  it("leaves the other prefixed ids as they were: CBA:… is still Europe PMC's, MED: with no number is no id", async () => {
    const lookedUp: string[] = [];
    const found = await failure(
      fetchFulltext({ id: "CBA:644599" }, new LRUBackend(), fakeClient(null).client, deps(() => ({ fetch: async (ids: string[]) => (lookedUp.push(...ids), []) }))),
    );
    expect(found).toMatchObject({ code: "NOT_FOUND" });
    expect(lookedUp).toEqual(["CBA:644599"]);
    const unrecognized = await failure(fetchFulltext({ id: "MED:PMC123" }, new LRUBackend(), fakeClient(null).client, deps(noRecords)));
    expect(unrecognized).toMatchObject({ code: "NOT_FOUND" });
    expect(unrecognized.userMessage).toContain('"MED:PMC123" is not an id literature_fulltext looks up');
  });
});
