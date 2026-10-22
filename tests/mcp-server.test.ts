import { afterEach, describe, expect, it, vi } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { LRUBackend, NcbiClient, PROJECT_CONTACT_EMAIL } from "../src/core/index.js";
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

  it("literature_search schema includes dateRange, sort and language", async () => {
    const { client, server } = await connect();
    const { tools } = await client.listTools();
    const search = tools.find((t) => t.name === "literature_search")!;
    const props = Object.keys((search.inputSchema as { properties: object }).properties);
    expect(props).toEqual(expect.arrayContaining(["dateRange", "sort", "language"]));
    await client.close();
    await server.close();
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
