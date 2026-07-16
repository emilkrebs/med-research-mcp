#!/usr/bin/env node
/**
 * Thin MCP adapter over the med-research-mcp core library.
 *
 * Exposes three stdio tools:
 *   - literature_search   — multi-database search + keyword classification (always cheap)
 *   - literature_fetch    — fetch full metadata + abstracts for given ids (pure data)
 *   - literature_fulltext — resolve and return an article's full text as markdown
 *
 * All logic lives in ../core; this file only wires it to MCP.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

// __dirname exists in the CJS build; import.meta.dirname in the ESM build —
// esbuild leaves the other undefined per format (see src/core/cache.ts loadSqlite).
const moduleDir = typeof __dirname !== "undefined" ? __dirname : import.meta.dirname;
const { version: pkgVersion } = JSON.parse(
  readFileSync(join(moduleDir, "../../package.json"), "utf-8"),
) as { version: string };
import {
  createCache,
  fetchFulltext,
  fetchLiterature,
  getAdapters,
  isMedResearchError,
  LRUBackend,
  NcbiClient,
  PubMedAdapter,
  searchLiterature,
  type Cache,
  type CacheBackend,
  type DatabaseAdapter,
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

function formatError(payload: { code: string; message: string; recoverable?: boolean }): string {
  const recoverable = payload.recoverable === true ? "yes" : "no";
  return `Error: ${payload.message} (${payload.code})\n\nDetails:\n${JSON.stringify(payload, null, 2)}\n\nRecoverable: ${recoverable}`;
}

function buildCache(): Cache {
  const backend = (process.env.MED_RESEARCH_CACHE_BACKEND ?? "memory") as CacheBackend;
  try {
    return createCache({
      backend,
      ...(process.env.MED_RESEARCH_CACHE_PATH ? { path: process.env.MED_RESEARCH_CACHE_PATH } : {}),
    });
  } catch (err) {
    console.error(
      `[med-research-mcp] ${err instanceof Error ? err.message : String(err)} — using in-memory cache.`,
    );
    return new LRUBackend();
  }
}

// One cache shared across tool calls for the life of the process.
const cache = buildCache();

// One NCBI client shared across tool calls — its rate limiter serializes and
// spaces *every* request so concurrent tool calls don't blow past NCBI's limit.
const ncbi = new NcbiClient();

// NCBI adapter bound to the shared NcbiClient so all literature_* tools reuse
// the same rate limiter (the registry's default adapter would otherwise create
// a second client).
const ncbiAdapter = new PubMedAdapter(ncbi);

function toIdList(database?: string | string[]): string[] {
  if (database == null) return ["pubmed"];
  const list = Array.isArray(database) ? database : [database];
  return list.length > 0 ? list : ["pubmed"];
}

/** Adapters for a search, with the shared-client PubMed adapter swapped in. */
function resolveAdapters(database?: string | string[]): DatabaseAdapter[] {
  return getAdapters(toIdList(database)).map((a) => (a.id === "pubmed" ? ncbiAdapter : a));
}

/** Single adapter for a fetch, with the shared-client PubMed adapter swapped in. */
function resolveAdapter(database: string): DatabaseAdapter | undefined {
  if (database === "pubmed") return ncbiAdapter;
  return getAdapters([database])[0];
}

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

const server = new McpServer({ name: "med-research-mcp", version: pkgVersion });

const DATABASES = ["pubmed", "europepmc", "chinaxiv", "russiarxiv"] as const;

// ─── literature_search ──────────────────────────────────────────

const literatureSearchShape = {
  query: z
    .string()
    .describe(
      "Search query. PubMed field tags ([tiab], [mesh], [au]) apply to the pubmed database; other databases receive it as plain text.",
    ),
  database: z
    .union([z.string(), z.array(z.string())])
    .optional()
    .describe(
      'Database(s) to search: a single id, an array of ids, or "all". Default "pubmed". ' +
        "Options: pubmed, europepmc (Europe + preprints), chinaxiv (China preprints), russiarxiv (Soviet/Russian papers).",
    ),
  maxResults: z.number().int().min(1).max(50).optional().describe("Results per database. Default 10, max 50."),
  minEvidenceScore: z
    .number()
    .min(0)
    .max(5)
    .optional()
    .describe("Drop results below this evidence score (0-5). Non-PubMed results are graded keyword-only and score lower."),
  studyTypes: z.array(z.enum(STUDY_TYPES)).optional().describe("Keep only these study types."),
  dateRange: z
    .object({ from: z.string().optional(), to: z.string().optional() })
    .optional()
    .describe("Publication date filter, YYYY-MM-DD."),
  sort: z
    .enum(["relevance", "date"])
    .optional()
    .describe("Per-database sort order. Merged results are always re-ordered by evidence score."),
  language: z
    .string()
    .optional()
    .describe("Preferred content language (ISO 639-1) hint for adapters that support it (e.g. SciELO)."),
};

server.registerTool(
  "literature_search",
  {
    title: "Search scientific literature (multi-database)",
    description:
      "Search one or more scientific databases and return evidence-graded results. " +
      `Databases: ${DATABASES.join(", ")}, or "all" to fan out to every source. ` +
      "PubMed results are graded from NLM PublicationType tags; other databases are graded keyword-only " +
      "(lower confidence, treat their scores as less reliable). Results are merged, de-duplicated by DOI, " +
      "and sorted by evidence score. Always cheap — no LLM calls. " +
      "Use literature_fetch to get full metadata for specific ids, and literature_fulltext for the article body.",
    inputSchema: literatureSearchShape,
    annotations: { readOnlyHint: true, openWorldHint: true },
  },
  async (args) => {
    try {
      const result = await searchLiterature(args, cache, resolveAdapters(args.database));
      return {
        content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
      };
    } catch (err) {
      const payload = isMedResearchError(err)
        ? err.toJSON()
        : { code: "UNKNOWN", message: err instanceof Error ? err.message : String(err), recoverable: false };
      return {
        isError: true,
        content: [{ type: "text", text: formatError(payload) }],
      };
    }
  },
);

// ─── literature_fetch ───────────────────────────────────────────

const literatureFetchShape = {
  ids: z
    .array(z.string())
    .min(1)
    .max(50)
    .describe("Database-specific ids to fetch (PMIDs for pubmed, SciELO ids for scielo, etc.)."),
  database: z
    .string()
    .describe(`Which database the ids belong to: ${DATABASES.join(", ")}.`),
};

server.registerTool(
  "literature_fetch",
  {
    title: "Fetch scientific articles (multi-database)",
    description:
      "Fetch full metadata and abstracts for one or more ids from a specific database. " +
      "Returns raw article objects (with database, url, and language fields for non-PubMed sources) — no grading. " +
      "Use after literature_search to drill into specific papers.",
    inputSchema: literatureFetchShape,
    annotations: { readOnlyHint: true, openWorldHint: true },
  },
  async (args) => {
    try {
      const result = await fetchLiterature(
        { ids: args.ids, database: args.database },
        cache,
        resolveAdapter(args.database),
      );
      return {
        content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
      };
    } catch (err) {
      const payload = isMedResearchError(err)
        ? err.toJSON()
        : { code: "UNKNOWN", message: err instanceof Error ? err.message : String(err), recoverable: false };
      return {
        isError: true,
        content: [{ type: "text", text: formatError(payload) }],
      };
    }
  },
);

// ─── literature_fulltext ────────────────────────────────────────

const literatureFulltextShape = {
  id: z.string().describe("Article id — a database-specific identifier (PMID, SciELO id, etc.). When the id is not a numeric PMID, a DOI is required below."),
  doi: z
    .string()
    .optional()
    .describe("DOI — database-agnostic. Required when the id is not a numeric PMID; otherwise skips the id→DOI lookup."),
};

server.registerTool(
  "literature_fulltext",
  {
    title: "Fetch full text for a scientific article (multi-database)",
    description:
      "Attempts to fetch an article's full text as markdown via Unpaywall (open access), institutional proxy " +
      "(if configured), and direct DOI access; falls back to abstract-only if paywalled. DOI resolution is " +
      "database-agnostic, so this works for any source — pass the DOI from a literature_search result for " +
      "non-PubMed articles. Use when the abstract isn't enough (verify dosage, sample sizes, methods).",
    inputSchema: literatureFulltextShape,
    annotations: { readOnlyHint: true, openWorldHint: true },
  },
  async (args) => {
    try {
      const result = await fetchFulltext({ id: args.id, ...(args.doi ? { doi: args.doi } : {}) }, cache, ncbi);
      return {
        content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
      };
    } catch (err) {
      const payload = isMedResearchError(err)
        ? err.toJSON()
        : { code: "UNKNOWN", message: err instanceof Error ? err.message : String(err), recoverable: false };
      return {
        isError: true,
        content: [{ type: "text", text: formatError(payload) }],
      };
    }
  },
);

// ─── Start ──────────────────────────────────────────────────────

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
