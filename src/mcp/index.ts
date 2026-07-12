#!/usr/bin/env node
/**
 * Thin MCP adapter over the pubmed-bio core library.
 *
 * Exposes two stdio tools:
 *   - pubmed_search — search + keyword classification (always cheap)
 *   - pubmed_fetch  — fetch full metadata + abstracts for given PMIDs (pure data)
 *
 * All logic lives in ../core; this file only wires it to MCP.
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import {
  createCache,
  fetchPubMed,
  isPubMedError,
  LRUBackend,
  NcbiClient,
  searchPubMed,
  type Cache,
  type CacheBackend,
} from "../core/index.js";

const STUDY_TYPES = [
  "meta-analysis",
  "randomized-controlled-trial",
  "cohort",
  "review",
  "case-control",
  "case-report",
  "animal-study",
  "unknown",
] as const;

function buildCache(): Cache {
  const backend = (process.env.PUBMED_CACHE_BACKEND ?? "memory") as CacheBackend;
  try {
    return createCache({
      backend,
      ...(process.env.PUBMED_CACHE_PATH ? { path: process.env.PUBMED_CACHE_PATH } : {}),
    });
  } catch (err) {
    console.error(
      `[pubmed-bio] ${err instanceof Error ? err.message : String(err)} — using in-memory cache.`,
    );
    return new LRUBackend();
  }
}

// One cache shared across tool calls for the life of the process.
const cache = buildCache();

// One NCBI client shared across tool calls — its rate limiter serializes and
// spaces *every* request so concurrent tool calls don't blow past NCBI's limit.
const ncbi = new NcbiClient();

if (!process.env.NCBI_EMAIL) {
  console.error(
    "[pubmed-bio] NCBI_EMAIL is not set. NCBI asks for a contact email on every request; set it to avoid throttling.",
  );
}

const server = new McpServer({ name: "pubmed-bio", version: "0.1.0" });

// ─── pubmed_search ──────────────────────────────────────────────

const searchInputShape = {
  query: z
    .string()
    .describe("PubMed query. Supports field tags: [tiab] (title/abstract), [mesh] (MeSH), [au] (author)."),
  maxResults: z.number().int().min(1).max(50).optional().describe("Results to return. Default 10, max 50."),
  minEvidenceScore: z.number().min(0).max(5).optional().describe("Drop results below this evidence score (0-5)."),
  studyTypes: z.array(z.enum(STUDY_TYPES)).optional().describe("Keep only these study types."),
  dateRange: z
    .object({ from: z.string().optional(), to: z.string().optional() })
    .optional()
    .describe("Publication date filter, YYYY-MM-DD."),
  sort: z.enum(["relevance", "date"]).optional().describe("Sort order. Default relevance."),
};

server.registerTool(
  "pubmed_search",
  {
    title: "Search PubMed",
    description:
      "Search PubMed and return results with automatic study-type classification (meta-analysis, RCT, cohort, review, case-control, case-report, animal-study) based on NLM PublicationType tags with keyword fallback. " +
      "Evidence scores: 5=meta-analysis, 4=RCT, 3=cohort/review, 2=case-control, 1=case-report, 0=animal/unknown. " +
      "Always cheap — no LLM calls. Use pubmed_fetch to get full metadata + abstracts for specific PMIDs.",
    inputSchema: searchInputShape,
    annotations: { readOnlyHint: true, openWorldHint: true },
  },
  async (args) => {
    try {
      const result = await searchPubMed(args, cache, ncbi);
      return {
        content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
      };
    } catch (err) {
      const payload = isPubMedError(err)
        ? err.toJSON()
        : { code: "UNKNOWN", message: err instanceof Error ? err.message : String(err), recoverable: false };
      return {
        isError: true,
        content: [{ type: "text", text: JSON.stringify(payload, null, 2) }],
      };
    }
  },
);

// ─── pubmed_fetch ───────────────────────────────────────────────

const fetchInputShape = {
  pmids: z
    .array(z.string())
    .min(1)
    .max(50)
    .describe("One or more PubMed IDs to fetch full metadata + abstracts for."),
};

server.registerTool(
  "pubmed_fetch",
  {
    title: "Fetch PubMed articles",
    description:
      "Fetch full metadata, abstracts, MeSH headings, and references for one or more PMIDs. " +
      "Returns raw NcbiArticle objects — no grading or classification. " +
      "The calling agent uses the returned data for its own analysis (PICO extraction, red flag detection, evidence assessment). " +
      "Use after pubmed_search to drill into specific papers of interest.",
    inputSchema: fetchInputShape,
    annotations: { readOnlyHint: true, openWorldHint: true },
  },
  async (args) => {
    try {
      const result = await fetchPubMed({ pmids: args.pmids }, cache, ncbi);
      return {
        content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
      };
    } catch (err) {
      const payload = isPubMedError(err)
        ? err.toJSON()
        : { code: "UNKNOWN", message: err instanceof Error ? err.message : String(err), recoverable: false };
      return {
        isError: true,
        content: [{ type: "text", text: JSON.stringify(payload, null, 2) }],
      };
    }
  },
);

// ─── Start ──────────────────────────────────────────────────────

async function main(): Promise<void> {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("[pubmed-bio] MCP server ready on stdio.");
}

main().catch((err) => {
  console.error("[pubmed-bio] fatal:", err);
  process.exit(1);
});
