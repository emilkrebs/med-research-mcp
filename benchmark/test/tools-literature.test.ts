import { describe, expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createServer, LRUBackend } from "../lib/core.js";
import { mcpTools } from "../lib/tools/literature.js";

describe("mcpTools", () => {
  it("exposes the server's 3 tools with identical descriptions", async () => {
    const server = createServer({ cache: new LRUBackend() });
    const client = new Client({ name: "t", version: "0" });
    const [ct, st] = InMemoryTransport.createLinkedPair();
    await Promise.all([server.connect(st), client.connect(ct)]);
    const { tools: listed } = await client.listTools();
    await client.close();

    const { tools, close } = await mcpTools();
    try {
      expect(Object.keys(tools).sort()).toEqual(["literature_fetch", "literature_fulltext", "literature_search"]);
      for (const t of listed) expect(tools[t.name]?.description).toBe(t.description);
    } finally {
      await close();
    }
  });

  it("close() resolves", async () => {
    const { close } = await mcpTools();
    await expect(close()).resolves.toBeUndefined();
  });
});
