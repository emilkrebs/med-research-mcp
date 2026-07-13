#!/usr/bin/env node
/**
 * Thin MCP adapter over the pubmed-bio core library.
 *
 * Exposes three stdio tools:
 *   - pubmed_search   — search + keyword classification (always cheap)
 *   - pubmed_fetch    — fetch full metadata + abstracts for given PMIDs (pure data)
 *   - pubmed_fulltext — resolve and return an article's full text as markdown
 *
 * All logic lives in ../core; this file only wires it to MCP.
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import {
  createCache,
  fetchFulltext,
  fetchLiterature,
  fetchPubMed,
  getAdapters,
  isPubMedError,
  LRUBackend,
  NcbiClient,
  PubMedAdapter,
  searchLiterature,
  searchPubMed,
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

// PubMed adapter bound to the shared NcbiClient so the literature_* tools reuse
// the same rate limiter as the pubmed_* tools (the registry's default adapter
// would otherwise create a second one).
const pubmedAdapter = new PubMedAdapter(ncbi);

function toIdList(database?: string | string[]): string[] {
  if (database == null) return ["pubmed"];
  const list = Array.isArray(database) ? database : [database];
  return list.length > 0 ? list : ["pubmed"];
}

/** Adapters for a search, with the shared-client PubMed adapter swapped in. */
function resolveAdapters(database?: string | string[]): DatabaseAdapter[] {
  return getAdapters(toIdList(database)).map((a) => (a.id === "pubmed" ? pubmedAdapter : a));
}

/** Single adapter for a fetch, with the shared-client PubMed adapter swapped in. */
function resolveAdapter(database: string): DatabaseAdapter | undefined {
  if (database === "pubmed") return pubmedAdapter;
  return getAdapters([database])[0];
}

if (!process.env.NCBI_EMAIL) {
  console.error(
    "[pubmed-bio] NCBI_EMAIL is not set. NCBI asks for a contact email on every request; set it to avoid throttling.",
  );
}

if (!process.env.PUBMED_UNPAYWALL_EMAIL && !process.env.NCBI_EMAIL) {
  console.error(
    "[pubmed-bio] Neither PUBMED_UNPAYWALL_EMAIL nor NCBI_EMAIL is set. pubmed_fulltext needs a contact email to query Unpaywall for open-access copies; without one it can only try the institutional proxy and direct DOI access.",
  );
}

const server = new McpServer({ name: "pubmed-bio", version: "0.3.0" });

const DATABASES = ["pubmed", "scielo", "cyberleninka", "europepmc", "chinaxiv", "jstage"] as const;

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

// ─── pubmed_fulltext ────────────────────────────────────────────

const fulltextInputShape = {
  pmid: z.string().describe("PubMed ID"),
  doi: z.string().optional().describe("DOI — if known, skips PMID→DOI lookup"),
};

server.registerTool(
  "pubmed_fulltext",
  {
    title: "Fetch full text for a PubMed article",
    description:
      "Attempts to fetch the full text of a PubMed article as markdown. " +
      "Tries Unpaywall (open access), institutional proxy (if configured), " +
      "and direct DOI access. Falls back to abstract-only if paywalled. " +
      "Use this when the abstract isn't sufficient — e.g., to verify dosage, " +
      "check sample sizes, read methods, or detect statistical flaws.",
    inputSchema: fulltextInputShape,
    annotations: { readOnlyHint: true, openWorldHint: true },
  },
  async (args) => {
    try {
      const result = await fetchFulltext({ pmid: args.pmid, ...(args.doi ? { doi: args.doi } : {}) }, cache, ncbi);
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
        "Options: pubmed, scielo (Latin America/Iberia/South Africa), cyberleninka (Russia/CIS, Cyrillic), " +
        "europepmc (Europe + preprints), chinaxiv (China preprints, Chinese), jstage (Japan).",
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

// ─── literature_fulltext ────────────────────────────────────────

const literatureFulltextShape = {
  pmid: z.string().describe("Article id — a PMID, or a non-PubMed database's id (then a DOI is required below)."),
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
      const result = await fetchFulltext({ pmid: args.pmid, ...(args.doi ? { doi: args.doi } : {}) }, cache, ncbi);
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

/** Persistent backends (SQLite) expose close(); flush the DB before exiting. */
function shutdown(signal: string): void {
  const maybeClose = (cache as { close?: () => void }).close;
  if (typeof maybeClose === "function") {
    try {
      maybeClose.call(cache);
    } catch (err) {
      console.error(`[pubmed-bio] error closing cache on ${signal}:`, err);
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
  console.error("[pubmed-bio] MCP server ready on stdio.");
}

main().catch((err) => {
  console.error("[pubmed-bio] fatal:", err);
  process.exit(1);
});
