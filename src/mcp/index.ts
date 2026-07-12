#!/usr/bin/env node
/**
 * Thin MCP adapter over the pubmed-bio core library.
 *
 * Exposes two stdio tools:
 *   - pubmed_search — search + fast keyword grading (always cheap)
 *   - pubmed_grade  — LLM deep grading of one paper (costs tokens)
 *
 * All the logic lives in ../core; this file only wires it to MCP.
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import {
  createCache,
  gradeArticle,
  isPubMedError,
  LRUBackend,
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

if (!process.env.NCBI_EMAIL) {
  console.error(
    "[pubmed-bio] NCBI_EMAIL is not set. NCBI asks for a contact email on every request; set it to avoid throttling.",
  );
}

const server = new McpServer({ name: "pubmed-bio", version: "0.1.0" });

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

const searchOutputShape = {
  articles: z.array(z.record(z.string(), z.any())),
  total: z.number(),
  query: z.string(),
  warnings: z.array(z.string()).optional(),
};

server.registerTool(
  "pubmed_search",
  {
    title: "Search PubMed (fast grade)",
    description:
      "Search PubMed and return evidence-graded results using fast keyword heuristics (PubMed publication types + title/abstract rules). Always cheap. Use pubmed_grade for a precise LLM grade of a specific paper.",
    inputSchema: searchInputShape,
    outputSchema: searchOutputShape,
    annotations: { readOnlyHint: true, openWorldHint: true },
  },
  async (args) => {
    try {
      const result = await searchPubMed(args, cache);
      return {
        content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
        structuredContent: result as unknown as Record<string, unknown>,
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

const gradeInputShape = {
  pmid: z.string().describe("PubMed ID to deep-grade."),
  abstract: z.string().optional().describe("Abstract text, if already fetched, to skip a network round-trip."),
};

const gradeOutputShape = {
  pmid: z.string(),
  correctedStudyType: z.string(),
  correctedScore: z.number(),
  pico: z.record(z.string(), z.any()),
  sampleSize: z.number().optional(),
  effectSize: z.string().optional(),
  fundingSource: z.string().optional(),
  redFlags: z.array(z.string()),
  gradingReasoning: z.string(),
  gradingMethod: z.literal("llm"),
  fallback: z.boolean().optional(),
  warning: z.string().optional(),
};

server.registerTool(
  "pubmed_grade",
  {
    title: "Deep-grade a paper (LLM)",
    description:
      "Precisely grade one PubMed paper with an LLM: verify the study-type classification, extract PICO/sample size/effect size/funding, and flag red flags (conflicts of interest, tiny sample, preprint, retracted). Costs tokens. Falls back to keyword grading if no LLM is configured or it times out.",
    inputSchema: gradeInputShape,
    outputSchema: gradeOutputShape,
    annotations: { readOnlyHint: true, openWorldHint: true },
  },
  async (args) => {
    try {
      const result = await gradeArticle(args, cache);
      return {
        content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
        structuredContent: result as unknown as Record<string, unknown>,
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

async function main(): Promise<void> {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("[pubmed-bio] MCP server ready on stdio.");
}

main().catch((err) => {
  console.error("[pubmed-bio] fatal:", err);
  process.exit(1);
});
