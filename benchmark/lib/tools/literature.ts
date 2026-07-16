/**
 * Condition C tools: the three literature_* tools the MCP server exposes,
 * wired straight to the core library (no stdio). The schemas and semantics
 * mirror `src/mcp/index.ts` so the benchmark measures the real MCP surface.
 *
 * A single in-memory cache is shared across a run's tool calls, exactly as the
 * MCP server shares one cache for the life of its process.
 */

import { tool } from "ai";
import { z } from "zod";
import {
  searchLiterature,
  fetchLiterature,
  fetchFulltext,
  NcbiClient,
  LRUBackend,
  type Cache,
} from "../core.js";

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

const DATABASES = "pubmed, europepmc, chinaxiv, russiarxiv";

/**
 * Build the condition-C toolset over one shared cache + NCBI client.
 * The NcbiClient's rate limiter serializes all E-utilities calls, so parallel
 * tool calls from the agent won't exceed NCBI's request ceiling.
 */
export function literatureTools(cache: Cache = new LRUBackend(), ncbi: NcbiClient = new NcbiClient()) {
  return {
    literature_search: tool({
      description:
        "Search one or more scientific databases and return evidence-graded results " +
        `(databases: ${DATABASES}, or "all"). PubMed results are graded from NLM PublicationType tags; ` +
        "other databases are graded keyword-only (lower confidence). Results are merged, de-duplicated by DOI, " +
        "and sorted by evidence score. Always cheap — no LLM calls.",
      inputSchema: z.object({
        query: z
          .string()
          .describe("Search query. PubMed field tags ([tiab], [mesh], [au]) apply to the pubmed database."),
        database: z
          .union([z.string(), z.array(z.string())])
          .optional()
          .describe(`Database(s): a single id, an array, or "all". Default "pubmed". Options: ${DATABASES}.`),
        maxResults: z.number().int().min(1).max(50).optional().describe("Results per database. Default 10, max 50."),
        minEvidenceScore: z.number().min(0).max(5).optional().describe("Drop results below this evidence score (0-5)."),
        studyTypes: z.array(z.enum(STUDY_TYPES)).optional().describe("Keep only these study types."),
      }),
      execute: async (args) => searchLiterature(args, cache),
    }),

    literature_fetch: tool({
      description:
        "Fetch full metadata and abstracts for one or more ids from a specific database. " +
        "Returns raw article objects — no grading. Use after literature_search to drill into specific papers.",
      inputSchema: z.object({
        ids: z.array(z.string()).min(1).max(50).describe("Database-specific ids (PMIDs for pubmed)."),
        database: z.string().describe(`Which database the ids belong to: ${DATABASES}.`),
      }),
      execute: async (args) => fetchLiterature(args, cache),
    }),

    literature_fulltext: tool({
      description:
        "Attempt to fetch an article's full text as markdown via open access, an institutional proxy, or direct DOI; " +
        "falls back to abstract-only if paywalled. Use when the abstract isn't enough (verify dosage, sample sizes, methods).",
      inputSchema: z.object({
        id: z.string().describe("Article id (PMID, or a database id when a DOI is supplied)."),
        doi: z.string().optional().describe("DOI — required when the id is not a numeric PMID."),
      }),
      execute: async (args) => fetchFulltext({ id: args.id, ...(args.doi ? { doi: args.doi } : {}) }, cache, ncbi),
    }),
  };
}
