import { afterEach, describe, expect, it, vi } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { LRUBackend, NcbiClient, PROJECT_CONTACT_EMAIL } from "../src/core/index.js";
import { parseChinaRXiv, parseEuropePmc } from "../src/core/index.js";
import { isPmidRecord, printedArticle, printedResult } from "../src/mcp/output.js";
import { contactEmailWarning, createServer } from "../src/mcp/server.js";

async function connect() {
  const server = createServer({ cache: new LRUBackend() });
  const client = new Client({ name: "test", version: "0.0.0" });
  const [ct, st] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(st), client.connect(ct)]);
  return { client, server };
}

describe("createServer", () => {
  it("lists the three literature tools", async () => {
    const { client, server } = await connect();
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual(["literature_fetch", "literature_fulltext", "literature_search"]);
    await client.close();
    await server.close();
  });

  it("literature_search schema includes dateRange, sort, language and page", async () => {
    const { client, server } = await connect();
    const { tools } = await client.listTools();
    const search = tools.find((t) => t.name === "literature_search")!;
    const props = Object.keys((search.inputSchema as { properties: object }).properties);
    expect(props).toEqual(expect.arrayContaining(["dateRange", "sort", "language", "page"]));
    await client.close();
    await server.close();
  });

  it("literature_search takes a whole-number page from 1, and rejects any other", async () => {
    const { client, server } = await connect();
    const { tools } = await client.listTools();
    const search = tools.find((t) => t.name === "literature_search")!;
    const page = (search.inputSchema as { properties: Record<string, unknown> }).properties.page;
    expect(page).toMatchObject({ type: "integer", minimum: 1, maximum: 10_000 });
    expect((search.inputSchema as { required?: string[] }).required ?? []).not.toContain("page");

    for (const bad of [0, -1, 1.5, "2", 10_001]) {
      const result = await client.callTool({ name: "literature_search", arguments: { query: "x", page: bad } });
      expect(result.isError, JSON.stringify(bad)).toBe(true);
      expect((result.content as { text: string }[])[0]!.text, JSON.stringify(bad)).toContain("page");
    }
    await client.close();
    await server.close();
  });

  it("literature_search refuses a page the core can't reach, with INVALID_INPUT", async () => {
    const { client, server } = await connect();
    // Within the schema's bound, but record 99,991 of a search.
    const result = await client.callTool({ name: "literature_search", arguments: { query: "x", page: 10_000 } });
    expect(result.isError).toBe(true);
    const text = (result.content as { text: string }[])[0]!.text;
    expect(text).toContain("INVALID_INPUT");
    expect(text).toContain("Narrow the query");
    await client.close();
    await server.close();
  });

  it("literature_search returns the page asked for, with nextPage while records remain", async () => {
    const pmids = Array.from({ length: 25 }, (_, i) => String(10_000_001 + i));
    const fetchMock = vi.fn(async (input: string | URL | Request) => {
      const url = new URL(String(input));
      if (url.pathname.endsWith("esummary.fcgi")) {
        const ids = url.searchParams.get("id")!.split(",");
        return new Response(JSON.stringify({ result: { uids: ids, ...Object.fromEntries(ids.map((id) => [id, { uid: id, title: id, pubdate: "2021" }])) } }));
      }
      if (url.pathname.endsWith("efetch.fcgi")) return new Response("<PubmedArticleSet/>");
      return new Response(JSON.stringify({ esearchresult: { count: "25", idlist: pmids } }));
    });
    vi.stubGlobal("fetch", fetchMock);
    try {
      const server = createServer({ cache: new LRUBackend(), ncbi: new NcbiClient({ email: "test@example.com", apiKey: "test-key" }) });
      const client = new Client({ name: "test", version: "0.0.0" });
      const [ct, st] = InMemoryTransport.createLinkedPair();
      await Promise.all([server.connect(st), client.connect(ct)]);
      const search = async (args: object) => {
        const result = await client.callTool({ name: "literature_search", arguments: { query: "x", ...args } });
        expect(result.isError).toBeFalsy();
        return JSON.parse((result.content as { text: string }[])[0]!.text) as { articles: { id: string; pmid: string }[]; total: number; page: number; nextPage?: number };
      };

      const first = await search({});
      expect(first).toMatchObject({ total: 25, page: 1, nextPage: 2 });
      expect(first.articles.map((a) => a.id)).toEqual(pmids.slice(0, 10));
      expect(first.articles.map((a) => a.pmid)).toEqual(pmids.slice(0, 10));
      const second = await search({ page: 2 });
      expect(second).toMatchObject({ page: 2, nextPage: 3 });
      expect(second.articles.map((a) => a.id)).toEqual(pmids.slice(10, 20));
      const third = await search({ page: 3 });
      expect(third.articles.map((a) => a.id)).toEqual(pmids.slice(20));
      expect(third.page).toBe(3);
      expect(third).not.toHaveProperty("nextPage");
      await client.close();
      await server.close();
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("literature_search takes abstractMaxChars as a whole number, 0 or more, and rejects any other", async () => {
    const { client, server } = await connect();
    const { tools } = await client.listTools();
    const search = tools.find((t) => t.name === "literature_search")!;
    const limit = (search.inputSchema as { properties: Record<string, unknown> }).properties.abstractMaxChars;
    expect(limit).toMatchObject({ type: "integer", minimum: 0 });
    expect((search.inputSchema as { required?: string[] }).required ?? []).not.toContain("abstractMaxChars");

    for (const bad of [-1, 1.5, "600"]) {
      const result = await client.callTool({ name: "literature_search", arguments: { query: "x", abstractMaxChars: bad } });
      expect(result.isError, JSON.stringify(bad)).toBe(true);
      expect((result.content as { text: string }[])[0]!.text, JSON.stringify(bad)).toContain("abstractMaxChars");
    }
    await client.close();
    await server.close();
  });

  it("describes in the search and fetch tools what a model needs to read their results", async () => {
    const { client, server } = await connect();
    const { tools } = await client.listTools();
    const tool = (name: string) => tools.find((t) => t.name === name)!;
    const prop = (name: string, key: string) =>
      ((tool(name).inputSchema as { properties: Record<string, { description?: string }> }).properties[key]!.description ?? "");
    const search = tool("literature_search").description!;
    const fetched = tool("literature_fetch").description!;

    // literature_fetch grades, and says so; it no longer calls its articles raw.
    expect(fetched).not.toMatch(/raw|no classification/i);
    for (const field of ["studyType", "designTier", "flags"]) expect(fetched).toContain(field);
    expect(fetched).toContain("whole abstract");

    // The abstract limit: its size guidance, and that fetch has the whole abstract.
    expect(prop("literature_search", "abstractMaxChars")).toMatch(/20,000-30,000 characters/);
    expect(prop("literature_search", "abstractMaxChars")).toContain("literature_fetch returns the whole abstract");
    expect(prop("literature_search", "maxResults")).toContain("with several databases a page holds up to maxResults from each");

    // id is the database's own id and pmid is set only for a PMID; a record in two databases counts twice in total.
    expect(search).toContain("id is the database's own id; pmid is set only for a PMID");
    expect(search).not.toContain("pmid is the database's own id");
    expect(prop("literature_fetch", "ids")).toContain("each a literature_search result's id");
    expect(prop("literature_fetch", "ids")).not.toContain("in pmid");
    expect(prop("literature_fulltext", "id")).toContain("A literature_search result's id");
    expect(prop("literature_fulltext", "id")).not.toContain("in pmid");
    expect(search).toContain("a record held by two databases counts twice in total");

    // Europe PMC reads full text and takes field syntax, which PubMed would read as words; RussiaRxiv is not medical.
    expect(prop("literature_search", "database")).toContain("it searches full text");
    expect(prop("literature_search", "database")).toContain("mostly mathematics, physics and chemistry; almost no medicine");
    expect(prop("literature_search", "database")).not.toContain("Soviet-era papers)");
    // The query description says which PubMed tags europepmc reads, that it drops the others, that ChinaXiv and RussiaRxiv ignore them,
    // and that Europe PMC's own SRC:PPR is for europepmc alone. Every byte of it is paid on every model call: it was 865 bytes before the tags were translated.
    const query = prop("literature_search", "query");
    expect(Buffer.byteLength(query)).toBeLessThanOrEqual(865);
    expect(query).toMatch(/europepmc reads \[tiab\] \[ti\] \[au\] \[pt\] \[ta\] \[la\] \[dp\] \[pmid\]/);
    expect(query).toMatch(/drops other tags such as \[mh\].*chinaxiv and russiarxiv ignore tags.*On europepmc alone, SRC:PPR keeps preprints/);
    expect(query).toContain('"sleep apnea"[tiab]');
    expect(query).not.toContain("pubmed reads these as words");
    await client.close();
    await server.close();
  });

  it("literature_fetch returns each article's grading, and literature_search says what it searched", async () => {
    // A retracted RCT looked up by PMID: the model got no studyType, designTier or flags from fetch, and missed that the design is graded.
    const abstract = "Creatine may improve memory in older adults, and this randomized trial tested it for twelve weeks.";
    const efetch = `<?xml version="1.0" ?><PubmedArticleSet><PubmedArticle><MedlineCitation><PMID Version="1">11111111</PMID><Article>
      <ArticleTitle>Creatine and memory</ArticleTitle><Abstract><AbstractText>${abstract}</AbstractText></Abstract>
      <PublicationTypeList><PublicationType UI="D016449">Randomized Controlled Trial</PublicationType>
      <PublicationType UI="D016441">Retracted Publication</PublicationType></PublicationTypeList></Article>
      <MeshHeadingList><MeshHeading><DescriptorName UI="D003401" MajorTopicYN="Y">Creatine</DescriptorName></MeshHeading></MeshHeadingList>
      </MedlineCitation></PubmedArticle></PubmedArticleSet>`;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string | URL | Request) => {
        const path = new URL(String(input)).pathname;
        if (path.endsWith("esummary.fcgi")) return new Response(JSON.stringify({ result: { uids: ["11111111"], "11111111": { uid: "11111111", title: "Creatine and memory", pubdate: "2021" } } }));
        if (path.endsWith("efetch.fcgi")) return new Response(efetch);
        return new Response(JSON.stringify({ esearchresult: { count: "1", idlist: ["11111111"] } }));
      }),
    );
    try {
      const server = createServer({ cache: new LRUBackend(), ncbi: new NcbiClient({ email: "test@example.com", apiKey: "test-key" }) });
      const client = new Client({ name: "test", version: "0.0.0" });
      const [ct, st] = InMemoryTransport.createLinkedPair();
      await Promise.all([server.connect(st), client.connect(ct)]);
      const call = async (name: string, args: object) => {
        const result = await client.callTool({ name, arguments: args });
        expect(result.isError).toBeFalsy();
        return JSON.parse((result.content as { text: string }[])[0]!.text) as Record<string, any>;
      };

      const fetched = await call("literature_fetch", { ids: ["11111111"], database: "pubmed" });
      expect(fetched.articles[0]).toMatchObject({
        id: "11111111",
        pmid: "11111111",
        studyType: "randomized-controlled-trial",
        designTier: 0,
        flags: ["retracted"],
        meshHeadings: ["Creatine"],
        abstract,
      });

      const searched = await call("literature_search", { query: "creatine", dateRange: { from: "2020" }, abstractMaxChars: 40 });
      expect(searched).toMatchObject({ databases: ["pubmed"], filters: { dateRange: { from: "2020" } }, total: 1 });
      expect(searched.articles[0]).toMatchObject({ studyType: "randomized-controlled-trial", abstract: "Creatine may improve memory in older…", abstractTruncated: true });
      expect(searched.articles[0]).not.toHaveProperty("meshHeadings");
      expect(searched).not.toHaveProperty("totalByDatabase");
      // Without the limit, the whole abstract and no flag.
      const whole = await call("literature_search", { query: "creatine" });
      expect(whole.articles[0]).toMatchObject({ abstract });
      expect(whole.articles[0]).not.toHaveProperty("abstractTruncated");
      expect(whole).not.toHaveProperty("filters");
      await client.close();
      await server.close();
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("lists the databases a search and a fetch accept, and rejects others before searching", async () => {
    const { client, server } = await connect();
    const { tools } = await client.listTools();
    const schema = (name: string) => JSON.stringify(tools.find((t) => t.name === name)!.inputSchema);
    for (const id of ["pubmed", "europepmc", "chinaxiv", "russiarxiv", "all"]) expect(schema("literature_search")).toContain(`"${id}"`);
    expect(schema("literature_fetch")).toContain('"russiarxiv"');

    for (const args of [{ query: "x", database: "scopus" }, { query: "x", database: ["pubmed", "PubMed"] }, { query: "  " }]) {
      const result = await client.callTool({ name: "literature_search", arguments: args });
      expect(result.isError, JSON.stringify(args)).toBe(true);
    }
    // The message names the valid ids, so the caller can correct the call.
    const unknown = await client.callTool({ name: "literature_search", arguments: { query: "x", database: "PubMed" } });
    expect((unknown.content as { text: string }[])[0]!.text).toContain('Use pubmed, europepmc, chinaxiv, russiarxiv or "all"');
    const fetched = await client.callTool({ name: "literature_fetch", arguments: { ids: ["1"], database: "scopus" } });
    expect(fetched.isError).toBe(true);
    await client.close();
    await server.close();
  });

  it("rejects an unknown argument instead of silently dropping it", async () => {
    const { client, server } = await connect();
    const result = await client.callTool({ name: "literature_search", arguments: { query: "x", databases: "chinaxiv" } });
    expect(result.isError).toBe(true);
    expect((result.content as { text: string }[])[0]!.text).toContain("databases");
    // The other two tools too: `DOI` for `doi` would otherwise read as "no DOI given".
    for (const [name, args] of [
      ["literature_fetch", { ids: ["1"], database: "pubmed", id: "1" }],
      ["literature_fulltext", { id: "chinaxiv-202401.00027", DOI: "10.1000/x" }],
    ] as const) {
      const refused = await client.callTool({ name, arguments: args });
      expect(refused.isError, name).toBe(true);
      expect((refused.content as { text: string }[])[0]!.text, name).toMatch(/"(id|DOI)"/);
    }
    await client.close();
    await server.close();
  });

  it("literature_fulltext reads a long text in parts with offset and maxChars", async () => {
    const cache = new LRUBackend();
    const text = "word ".repeat(400);
    cache.setFulltext("PMC1234567", { source: "europepmc", fulltext: text, format: "markdown", fetchedAt: Date.now() });
    const server = createServer({ cache });
    const client = new Client({ name: "test", version: "0.0.0" });
    const [ct, st] = InMemoryTransport.createLinkedPair();
    await Promise.all([server.connect(st), client.connect(ct)]);

    const { tools } = await client.listTools();
    const props = Object.keys((tools.find((t) => t.name === "literature_fulltext")!.inputSchema as { properties: object }).properties);
    expect(props).toEqual(expect.arrayContaining(["offset", "maxChars"]));

    const call = async (args: object) => {
      const result = await client.callTool({ name: "literature_fulltext", arguments: { id: "PMC1234567", ...args } });
      return JSON.parse((result.content as { text: string }[])[0]!.text) as Record<string, unknown>;
    };
    expect(await call({ maxChars: 1000 })).toMatchObject({ source: "europepmc", truncated: true, totalChars: 2000, nextOffset: 1000 });
    expect(await call({ offset: 1000, maxChars: 1000 })).toMatchObject({ fulltext: text.slice(1000), truncated: false });
    const bad = await client.callTool({ name: "literature_fulltext", arguments: { id: "PMC1234567", offset: -5 } });
    expect(bad.isError).toBe(true);
    await client.close();
    await server.close();
  });

  it("literature_fulltext tells which ids work alone, and that a ChinaRxiv text is a machine translation", async () => {
    const { client, server } = await connect();
    const { tools } = await client.listTools();
    const tool = tools.find((t) => t.name === "literature_fulltext")!;
    const props = (tool.inputSchema as { properties: Record<string, { description?: string }> }).properties;
    const description = tool.description ?? "";
    expect(description).toContain("chinaxiv and russiarxiv records come from ChinaRxiv as a machine translation");
    expect(description).toContain("originalUrl");
    // ChinaXiv and RussiaRxiv records are no longer said to be unresolvable.
    expect(description).not.toMatch(/can't be resolved|neither DOI nor PMCID/);
    // Sent to the model on every session: it stays short.
    expect(description.length).toBeLessThan(800);
    for (const shape of ["PMID", "PMC…", "PPR…", "CBA:…", "chinaxiv-…", "ru-…"]) expect(props.id!.description, shape).toContain(shape);
    // Europe PMC's other ids work alone too; doi is for an id none of them is.
    expect(props.id!.description).toContain("doi is for any other id");
    expect(props.id!.description).not.toContain("also needs doi");
    expect(props.doi!.description).toContain("a url or originalUrl is not one");
    await client.close();
    await server.close();
  });

  it("literature_fulltext returns a ChinaXiv text from the ChinaRxiv API, as a machine translation", async () => {
    const id = "chinaxiv-202401.00099";
    const body = "# A title\n\n" + "Translated sentence. ".repeat(60);
    const urls: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string | URL | Request) => {
        urls.push(String(input));
        if (String(input).endsWith("/text")) return new Response(JSON.stringify({ id, title: "T", body_md: body, word_count: 60 }));
        return new Response(
          JSON.stringify({ id, title: "T", authors: [], abstract: "Whole.", source: "chinaxiv", source_language: "zh", source_url: "https://chinaxiv.org/abs/202401.00099" }),
        );
      }),
    );
    try {
      const { client, server } = await connect();
      const result = await client.callTool({ name: "literature_fulltext", arguments: { id } });
      expect(result.isError).toBeFalsy();
      const out = JSON.parse((result.content as { text: string }[])[0]!.text) as Record<string, unknown>;
      expect(out).toMatchObject({ id, source: "chinarxiv", format: "markdown", truncated: false, fulltext: body.trim() });
      expect(out.warning).toContain("Machine translation into English by ChinaRxiv");
      expect(out.warning).toContain("https://chinaxiv.org/abs/202401.00099");
      // Only the ChinaRxiv API was asked, for this id.
      expect(urls.sort()).toEqual([`https://chinarxiv.org/api/v1/papers/${id}`, `https://chinarxiv.org/api/v1/papers/${id}/text`]);

      // A url passed as the doi of an id that needs one is named as the mistake.
      const refused = await client.callTool({ name: "literature_fulltext", arguments: { id: "CBA:644599", doi: "https://chinaxiv.org/abs/202401.00099" } });
      expect(refused.isError).toBe(true);
      expect((refused.content as { text: string }[])[0]!.text).toContain("INVALID_INPUT");
      await client.close();
      await server.close();
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("bounds search and fetch calls by callBudgetMs, and not literature_fulltext, whose fallback needs its abstract", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string | URL | Request) => {
        const path = new URL(String(input)).pathname;
        if (path.endsWith("esummary.fcgi")) return new Response(JSON.stringify({ result: { uids: ["12345678"], "12345678": { uid: "12345678", title: "T", pubdate: "2021" } } }));
        if (path.endsWith("efetch.fcgi")) return new Response("<PubmedArticleSet/>");
        return new Response(JSON.stringify({ esearchresult: { count: "1", idlist: ["12345678"] } }));
      }),
    );
    try {
      const server = createServer({ cache: new LRUBackend(), ncbi: new NcbiClient({ email: "test@example.com" }), callBudgetMs: 1 });
      const client = new Client({ name: "test", version: "0.0.0" });
      const [ct, st] = InMemoryTransport.createLinkedPair();
      await Promise.all([server.connect(st), client.connect(ct)]);
      const text = (result: Awaited<ReturnType<typeof client.callTool>>) => (result.content as { text: string }[])[0]!.text;

      const search = await client.callTool({ name: "literature_search", arguments: { query: "x" } });
      expect(search.isError).toBe(true);
      expect(text(search)).toContain("the call ran out of time");
      const fulltext = await client.callTool({ name: "literature_fulltext", arguments: { id: "12345678" } });
      expect(fulltext.isError).toBeFalsy();
      expect(JSON.parse(text(fulltext)).warning).toContain("Could not resolve a DOI");
      await client.close();
      await server.close();
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("builds independent servers per call", () => {
    expect(createServer({ cache: new LRUBackend() })).not.toBe(createServer({ cache: new LRUBackend() }));
  });
});

describe("the id the tools print", () => {
  const epmc = (...results: object[]) => parseEuropePmc({ resultList: { result: results } } as never).articles;
  const medline = { id: "33000001", source: "MED", pmid: "33000001", title: "t", abstractText: "a", pubTypeList: { pubType: ["Randomized Controlled Trial"] } };
  const preprint = { id: "PPR1244531", source: "PPR", title: "t", abstractText: "a", doi: "10.1234/ppr" };
  const cba = { id: "521529", source: "CBA", title: "t", abstractText: "a" };

  it("names a PMID: all digits, in PubMed or Europe PMC, and no other id", () => {
    const [med, ppr, chinese] = epmc(medline, preprint, cba);
    expect(isPmidRecord({ pmid: "12345678" })).toBe(true); // no database: PubMed's
    expect(isPmidRecord({ pmid: "12345678", database: "pubmed" })).toBe(true);
    expect([med, ppr, chinese].map((a) => [a!.pmid, isPmidRecord(a!)])).toEqual([["33000001", true], ["PPR1244531", false], ["CBA:521529", false]]);
    // PMC…, IND… and the like are Europe PMC ids that are no PMID; so is a number of ChinaXiv or RussiaRxiv.
    for (const pmid of ["PMC1234567", "IND606115927", "NBK1234"]) expect(isPmidRecord({ pmid, database: "europepmc" }), pmid).toBe(false);
    const [chinaxiv] = parseChinaRXiv({ data: [{ id: "chinaxiv-202608.00133", title: "t" }] } as never).articles;
    expect([chinaxiv!.pmid, isPmidRecord(chinaxiv!)]).toEqual(["chinaxiv-202608.00133", false]);
    for (const database of ["chinaxiv", "russiarxiv"]) expect(isPmidRecord({ pmid: "202608", database }), database).toBe(false);
  });

  it("prints id first, and pmid right after it only for a PMID; every other key keeps its name and place", () => {
    const pubmed = { pmid: "33000001", title: "t", authors: ["A"], journal: "j", pubDate: "2021", publicationTypes: [], studyType: "unknown", designTier: null };
    expect(Object.keys(printedArticle(pubmed as never))).toEqual(["id", "pmid", "title", "authors", "journal", "pubDate", "publicationTypes", "studyType", "designTier"]);
    expect(printedArticle(pubmed as never)).toMatchObject({ id: "33000001", pmid: "33000001" });

    const [, ppr, chinese] = epmc(medline, preprint, cba);
    const printedPreprint = printedArticle(ppr!);
    expect(Object.keys(printedPreprint)).toEqual(["id", ...Object.keys(ppr!).filter((k) => k !== "pmid")]);
    expect(printedPreprint).toMatchObject({ id: "PPR1244531", title: "t", doi: "10.1234/ppr" });
    expect(printedPreprint).not.toHaveProperty("pmid");
    expect(printedArticle(chinese!)).toMatchObject({ id: "CBA:521529" });
    expect(printedArticle(chinese!)).not.toHaveProperty("pmid");

    // The library's article is not changed: library users and the benchmark scorer read pmid there.
    expect(ppr!.pmid).toBe("PPR1244531");
    expect(ppr).not.toHaveProperty("id");
  });

  it("changes only the articles of a result, and keeps the place of its other keys", () => {
    const result = { articles: epmc(medline, preprint), total: 2, query: "q", warnings: ["w"], missing: [] };
    const printed = printedResult(result);
    expect(Object.keys(printed)).toEqual(["articles", "total", "query", "warnings", "missing"]);
    expect(printed.articles.map((a) => a.id)).toEqual(["33000001", "PPR1244531"]);
    expect(printed.articles.map((a) => "pmid" in a)).toEqual([true, false]);
    expect({ ...printed, articles: [] }).toEqual({ ...result, articles: [] });
  });

  it("is what literature_search and literature_fetch print, for PubMed and Europe PMC records alike", async () => {
    const body = { hitCount: 3, resultList: { result: [medline, preprint, cba] } };
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify(body))));
    try {
      const { client, server } = await connect();
      const call = async (name: string, args: object) => {
        const result = await client.callTool({ name, arguments: args });
        expect(result.isError).toBeFalsy();
        return JSON.parse((result.content as { text: string }[])[0]!.text) as { articles: Record<string, unknown>[] };
      };
      for (const [name, args] of [
        ["literature_search", { query: "x", database: "europepmc" }],
        ["literature_fetch", { ids: ["33000001", "PPR1244531", "CBA:521529"], database: "europepmc" }],
      ] as const) {
        const { articles } = await call(name, args);
        expect(articles.map((a) => a.id), name).toEqual(["33000001", "PPR1244531", "CBA:521529"]);
        expect(articles.map((a) => Object.keys(a).slice(0, 2)), name).toEqual([["id", "pmid"], ["id", "title"], ["id", "title"]]);
        expect(articles[0]!.pmid, name).toBe("33000001");
      }
      await client.close();
      await server.close();
    } finally {
      vi.unstubAllGlobals();
    }
  });
});

describe("contactEmailWarning", () => {
  afterEach(() => vi.unstubAllEnvs());

  it("names every service that carries the project's address", () => {
    for (const name of ["NCBI_EMAIL", "MED_RESEARCH_UNPAYWALL_EMAIL", "MED_RESEARCH_UNPAYWALL"]) vi.stubEnv(name, "");
    expect(contactEmailWarning()).toContain(`PubMed and Unpaywall requests carry the project's contact address (${PROJECT_CONTACT_EMAIL})`);
    vi.stubEnv("MED_RESEARCH_UNPAYWALL_EMAIL", "oa@example.com");
    expect(contactEmailWarning()).toContain("so PubMed requests carry");
    vi.stubEnv("NCBI_EMAIL", "user@example.com");
    expect(contactEmailWarning()).toBeUndefined();
  });
});
