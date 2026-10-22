/**
 * MCP-over-HTTP request handling: one stateless Streamable HTTP transport per
 * POST, wired to a per-request McpServer that shares the process-wide cache
 * and NCBI client.
 *
 * The transport is stateless (no session ids, no SSE): `enableJsonResponse`
 * answers each JSON-RPC POST with a single application/json body, so reverse
 * proxies and CDNs never buffer an event stream, and nothing has to be cleaned
 * up between requests beyond closing the transport and server.
 */

import type { IncomingMessage, ServerResponse } from "node:http";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import type { Cache, NcbiClient, UnpaywallClient } from "../core/index.js";
import { createServer } from "../mcp/server.js";

/**
 * The time a search or fetch call's database requests get: a hosted server sits behind a gateway
 * that answers 504 itself when a call takes too long (nginx's proxy_read_timeout, for one, defaults
 * to 60 s), and an answer with the databases that did respond beats that.
 */
const CALL_BUDGET_MS = 30_000;

export interface McpHandlerDeps {
  /** Process-wide cache, shared by every request's tool calls. */
  cache: Cache;
  /** Process-wide NCBI client, so all requests share one rate limiter. */
  ncbi: NcbiClient;
  /** Process-wide Unpaywall client, so all requests reuse its answers. Defaults to a new one per request. */
  unpaywall?: UnpaywallClient;
  /** Host header allowlist for DNS-rebinding protection; empty disables it. */
  allowedHosts: string[];
}

/**
 * Handle one JSON-RPC POST on /mcp. The body must already be parsed and size-
 * checked by the caller (see index.ts). Writes the JSON-RPC response to `res`.
 */
export async function handleMcpPost(
  req: IncomingMessage,
  res: ServerResponse,
  body: unknown,
  deps: McpHandlerDeps,
): Promise<void> {
  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: undefined,
    enableJsonResponse: true,
    enableDnsRebindingProtection: deps.allowedHosts.length > 0,
    allowedHosts: deps.allowedHosts,
  });

  // Shared state (cache, NCBI rate limiter, Unpaywall answers) is injected; the
  // server object itself is per-request and dies with the response.
  const server = createServer({ cache: deps.cache, ncbi: deps.ncbi, unpaywall: deps.unpaywall, callBudgetMs: CALL_BUDGET_MS });

  res.on("close", () => {
    void transport.close();
    void server.close();
  });

  await server.connect(transport);
  await transport.handleRequest(req, res, body);
}
