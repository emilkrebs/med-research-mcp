/**
 * Condition C tools: the real med-research-mcp server, driven in-process.
 *
 * `mcpTools()` builds a fresh server (`createServer`), links it to an MCP
 * client over an in-memory transport, and exposes each tool the server lists as
 * an AI SDK tool. Descriptions and input schemas come straight from the server,
 * so the benchmark measures the actual MCP surface and cannot drift from it.
 *
 * The AI SDK (v7) ships no MCP client and `@ai-sdk/mcp` is not installed, so
 * this is a small hand-rolled adapter. Results are presented as an MCP host
 * would hand them to the model: the tool's text content, including for
 * `isError` results (the server formats those as "Error: ... (CODE)"), so the
 * model sees the error text rather than the harness throwing.
 *
 * Isolation: each call gets its own server, cache and PubMed adapter, so one
 * run's results are never served from another run's cache. The NcbiClient is
 * deliberately shared process-wide (`sharedNcbi`): it holds no data, only
 * NCBI's request-rate limiter, and per-run clients would let `--concurrency`
 * multiply the request rate past NCBI's ceiling. The core's non-PubMed adapter
 * registry (`ADAPTERS` in `src/core/adapters/registry.ts`) is process-global
 * and keeps its own per-instance memo, so those databases are not run-isolated.
 */

import { jsonSchema, tool, type ToolSet } from "ai";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createServer, LRUBackend, NcbiClient } from "../core.js";

/**
 * One NcbiClient (= one rate limiter) for every MCP server in the process. The
 * scorer's Verifier should use it too, so scoring and agent runs share the budget.
 */
export const sharedNcbi = new NcbiClient();

/** Flatten an MCP tool result's content blocks into the text the model sees. */
function contentToText(content: unknown): string {
  if (!Array.isArray(content)) return JSON.stringify(content ?? null);
  return content
    .map((block: { type?: string; text?: string }) =>
      block.type === "text" && typeof block.text === "string" ? block.text : JSON.stringify(block),
    )
    .join("\n");
}

/**
 * Start a fresh in-process MCP server + client and return its tools.
 * Call `close()` when the run finishes.
 */
export async function mcpTools(): Promise<{ tools: ToolSet; close: () => Promise<void> }> {
  const server = createServer({ cache: new LRUBackend(), ncbi: sharedNcbi });
  const client = new Client({ name: "med-research-benchmark", version: "0.0.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);

  const { tools: listed } = await client.listTools();
  const tools: ToolSet = {};
  for (const t of listed) {
    tools[t.name] = tool({
      description: t.description ?? "",
      inputSchema: jsonSchema(t.inputSchema as Parameters<typeof jsonSchema>[0]),
      execute: async (args: unknown) => {
        const result = await client.callTool({ name: t.name, arguments: args as Record<string, unknown> });
        return contentToText(result.content);
      },
    });
  }

  return {
    tools,
    close: async () => {
      await client.close();
      await server.close();
    },
  };
}
