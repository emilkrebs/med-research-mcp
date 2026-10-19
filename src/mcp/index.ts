#!/usr/bin/env node
/**
 * Thin MCP adapter over the med-research-mcp core library.
 *
 * Exposes three stdio tools:
 *   - literature_search   — multi-database search, study designs labeled from NLM metadata (no LLM calls)
 *   - literature_fetch    — fetch full metadata + abstracts for given ids (pure data)
 *   - literature_fulltext — resolve and return an article's full text as markdown
 *
 * All logic lives in ../core; the server is built in ./server.ts. This file is
 * only the CLI: env warnings, stdio transport, and signal handling.
 */

import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import type { Cache } from "../core/index.js";
import { buildCache, createServer } from "./server.js";

if (!process.env.NCBI_EMAIL) {
  console.error(
    "[med-research-mcp] NCBI_EMAIL is not set. NCBI asks for a contact email on every request; set it to avoid throttling.",
  );
}

if (!process.env.MED_RESEARCH_UNPAYWALL_EMAIL && !process.env.NCBI_EMAIL) {
  console.error(
    "[med-research-mcp] Neither MED_RESEARCH_UNPAYWALL_EMAIL nor NCBI_EMAIL is set. literature_fulltext needs a contact email to query Unpaywall for open-access copies; without one it can only try the institutional proxy and direct DOI access.",
  );
}

// Built here (not inside createServer) so shutdown can close a persistent backend.
const cache: Cache = buildCache();
const server = createServer({ cache });

/** Persistent backends (SQLite) expose close(); flush the DB before exiting. */
function shutdown(signal: string): void {
  const maybeClose = (cache as { close?: () => void }).close;
  if (typeof maybeClose === "function") {
    try {
      maybeClose.call(cache);
    } catch (err) {
      console.error(`[med-research-mcp] error closing cache on ${signal}:`, err);
    }
  }
  process.exit(0);
}

async function main(): Promise<void> {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  for (const signal of ["SIGINT", "SIGTERM"] as const) {
    process.on(signal, () => shutdown(signal));
  }
  console.error("[med-research-mcp] MCP server ready on stdio.");
}

main().catch((err) => {
  console.error("[med-research-mcp] fatal:", err);
  process.exit(1);
});
