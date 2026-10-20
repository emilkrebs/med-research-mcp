import { describe, expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { LRUBackend } from "../src/core/index.js";
import { createServer } from "../src/mcp/server.js";

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

  it("builds independent servers per call", () => {
    expect(createServer({ cache: new LRUBackend() })).not.toBe(createServer({ cache: new LRUBackend() }));
  });
});
