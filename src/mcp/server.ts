/**
 * MCP server construction for med-research-mcp.
 *
 * `createServer()` builds a fully wired McpServer — cache, NCBI client, the
 * shared-client PubMed adapter and the three literature_* tools — without
 * touching stdio, env warnings or process signals. `index.ts` is the CLI that
 * connects it to stdio; the benchmark connects it to an in-memory transport.
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import {
  adaptersFor,
  createCache,
  fetchFulltext,
  fetchLiterature,
  getAdapter,
  isMedResearchError,
  LRUBackend,
  NcbiClient,
  PROJECT_CONTACT_EMAIL,
  PubMedAdapter,
  searchLiterature,
  STUDY_TYPES,
  type Cache,
  type CacheBackend,
  type DatabaseAdapter,
  UnpaywallClient,
} from "../core/index.js";
import { withDeadline } from "../core/request.js";
import { envSetting, packageVersion } from "../core/version.js";

/** Re-exported for the HTTP entry and tests, which import it from here. */
export { packageVersion };

function formatError(payload: { code: string; message: string; recoverable?: boolean }): string {
  const recoverable = payload.recoverable === true ? "yes" : "no";
  return `Error: ${payload.message} (${payload.code})\n\nDetails:\n${JSON.stringify(payload, null, 2)}\n\nRecoverable: ${recoverable}`;
}

/**
 * The startup warning for an installation without its own contact email, whose PubMed (and
 * Unpaywall) requests carry the project's address; undefined when NCBI_EMAIL is set.
 */
export function contactEmailWarning(): string | undefined {
  if (envSetting("NCBI_EMAIL")) return undefined;
  const services = new UnpaywallClient().sharedContact ? "PubMed and Unpaywall" : "PubMed";
  return `[med-research-mcp] NCBI_EMAIL is not set, so ${services} requests carry the project's contact address (${PROJECT_CONTACT_EMAIL}). Set your own so NCBI can reach you directly before blocking an IP that exceeds its limits.`;
}

/** Cache from the MED_RESEARCH_CACHE_* env vars; falls back to in-memory if the backend is unavailable. */
export function buildCache(): Cache {
  // `||` so an empty variable (as in .env.example) means the default, not an unknown backend.
  const backend = (process.env.MED_RESEARCH_CACHE_BACKEND?.trim() || "memory") as CacheBackend;
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

/**
 * The time a tool call's database requests get, retries and waiting in the NCBI queue included
 * (see ../core/request.ts): a hosted server sits behind a gateway that answers 504 itself when a
 * call takes too long (nginx's proxy_read_timeout, for one, defaults to 60 s). Full-text pages are
 * fetched with their own timeout.
 */
const TOOL_CALL_BUDGET_MS = 30_000;

const DATABASES = ["pubmed", "europepmc", "chinaxiv", "russiarxiv"] as const;
const DATABASE_OR_ALL = z.enum([...DATABASES, "all"]);

/** A date as PubMed reads it; the other adapters expand a year or month to its first or last day. */
const isoDate = z.string().regex(/^\d{4}(?:[-/]\d{1,2}(?:[-/]\d{1,2})?)?$/, "Use YYYY-MM-DD, YYYY-MM or YYYY.");

export interface CreateServerOptions {
  /** Cache shared by the server's tools. Defaults to the env-configured cache (MED_RESEARCH_CACHE_*). */
  cache?: Cache;
  /** NCBI client shared by the server's tools. Defaults to a new client. */
  ncbi?: NcbiClient;
  /** Unpaywall client for literature_fulltext; sharing one reuses its answers. Defaults to a new client. */
  unpaywall?: UnpaywallClient;
}

/**
 * Build a new MCP server with its own cache, NCBI client and PubMed adapter.
 * Every call returns independent instances.
 */
export function createServer(options: CreateServerOptions = {}): McpServer {
  // One cache shared across tool calls for the life of the server.
  const cache = options.cache ?? buildCache();

  // One NCBI client shared across tool calls — its rate limiter serializes and
  // spaces *every* request so concurrent tool calls don't blow past NCBI's limit.
  const ncbi = options.ncbi ?? new NcbiClient();
  const unpaywall = options.unpaywall ?? new UnpaywallClient({ tool: ncbi.tool });

  // NCBI adapter bound to the shared NcbiClient so all literature_* tools reuse
  // the same rate limiter (the registry's default adapter would otherwise create
  // a second client).
  const ncbiAdapter = new PubMedAdapter(ncbi);

  /** Adapters for a search, with the shared-client PubMed adapter swapped in. Throws INVALID_INPUT for an unknown id. */
  function resolveAdapters(database?: string | string[]): DatabaseAdapter[] {
    return adaptersFor(database).map((a) => (a.id === "pubmed" ? ncbiAdapter : a));
  }

  /** Single adapter for a fetch, with the shared-client PubMed adapter swapped in. */
  function resolveAdapter(database: string): DatabaseAdapter | undefined {
    const adapter = getAdapter(database);
    return adapter?.id === "pubmed" ? ncbiAdapter : adapter;
  }


  const server = new McpServer({ name: "med-research-mcp", version: packageVersion() });


  // ─── literature_search ──────────────────────────────────────────

  const literatureSearchShape = {
    query: z
      .string()
      .trim()
      .min(1, "The query is empty.")
      .describe(
        "Search query. PubMed field tags ([tiab], [mesh], [au]) apply to the pubmed database; for other databases they are removed. " +
          "The query is sent to third-party databases: never include names, dates of birth, record numbers or other details that " +
          "identify a person; describe the condition or intervention instead.",
      ),
    database: z
      .union([DATABASE_OR_ALL, z.array(DATABASE_OR_ALL)], {
        error: `Unknown database. Use ${DATABASES.join(", ")} or "all" (lower case), or a list of them.`,
      })
      .optional()
      .describe(
        'Database(s) to search: a single id, an array of ids, or "all". Default "pubmed". ' +
          "Options: pubmed, europepmc (Europe + preprints), chinaxiv (Chinese preprints) and russiarxiv (Soviet-era " +
          "papers), both via ChinaRxiv, a third-party service that machine-translates them into English.",
      ),
    maxResults: z.number().int().min(1).max(50).optional().describe("Results per database. Default 10, max 50."),
    minDesignTier: z
      .number()
      .min(0)
      .max(5)
      .optional()
      .describe(
        "Drop results below this design tier (0-5; 4 = RCTs). Results with designTier null — unclassified records and most " +
          "meta-analyses/systematic reviews — are left out too: the query is narrowed like studyTypes, so they are never " +
          "fetched, and a warning says so. To keep reviews and trials, use studyTypes instead.",
      ),
    studyTypes: z
      .array(z.enum(STUDY_TYPES))
      .optional()
      .describe(
        "Keep only these study types. PubMed and Europe PMC are queried for them, so maxResults counts matching " +
          "records; chinaxiv and russiarxiv, which have no design metadata, are skipped. cohort, case-control, " +
          "cross-sectional and in-vitro are never assigned from metadata (tagged observational studies come back as " +
          "observational), so filtering on them returns nothing. animal-study comes only from veterinary publication types; " +
          "laboratory animal studies are not labeled with it but flagged animals-not-humans.",
      ),
    dateRange: z
      .object({ from: isoDate.optional(), to: isoDate.optional() })
      .optional()
      .describe(
        "Publication date filter: YYYY-MM-DD, YYYY-MM or YYYY (a year or month covers all of it). It matches the electronic " +
          "publication date too, so a record published online within the range can show a later pubDate; see its epubDate.",
      ),
    sort: z
      .enum(["relevance", "date"])
      .optional()
      .describe(
        'Default "relevance": each database\'s relevance order, re-sorted by design tier. "date": newest first by first ' +
          "publication (the earlier of pubDate and epubDate), across databases.",
      ),
    language: z
      .string()
      .optional()
      .describe(
        'Content language hint (ISO 639-1). pubmed and europepmc ignore it; on chinaxiv, "ru" searches the Russian ' +
          'collection (same as database "russiarxiv").',
      ),
  };

  server.registerTool(
    "literature_search",
    {
      title: "Search scientific literature (multi-database)",
      description:
        "Search one or more scientific databases and return results with their study design. " +
        `Databases: ${DATABASES.join(", ")}, or "all" to fan out to every source. ` +
        "studyType comes only from NLM PublicationType tags (PubMed, Europe PMC; assigned largely by NLM's automated " +
        "indexing). Records without them are 'unknown' with designTier null: read the abstract to judge the design. " +
        "designTier (0-5) ranks the design for 'does this intervention help?' by the OCEBM 2011 levels; it is not an " +
        "appraisal. A meta-analysis or systematic review ranks with the studies it pooled, which metadata rarely shows, " +
        "so its designTier is usually null: read the abstract to see what it pooled. flags marks retracted, notice, " +
        "protocol and editorial records (designTier 0), and warns of an expression of concern, an erratum (corrected), " +
        "a newer version (updated), animals-not-humans indexing, preprints, letters, machine-translated text and " +
        "machine-generated abstracts (chinaxiv, russiarxiv: check originalUrl before relying on a number). Results are " +
        'merged, de-duplicated by DOI, and sorted by design tier (or by date with sort: "date"). Always cheap — no LLM calls. ' +
        "Use literature_fetch to get full metadata for specific ids, and literature_fulltext for the article body.",
      // Strict, so a misnamed key (e.g. `databases`) errors instead of being stripped and silently searching PubMed.
      inputSchema: z.object(literatureSearchShape).strict(),
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async (args) => {
      try {
        const result = await withDeadline(TOOL_CALL_BUDGET_MS, () => searchLiterature(args, cache, resolveAdapters(args.database)));
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
      .describe(
        "Database-specific ids to fetch: PMIDs for pubmed; PMIDs or prefixed ids (e.g. CBA:521529, PPR… preprints) " +
          "for europepmc; the ids literature_search returned for chinaxiv and russiarxiv.",
      ),
    database: z.enum(DATABASES).describe(`Which database the ids belong to: ${DATABASES.join(", ")}.`),
  };

  server.registerTool(
    "literature_fetch",
    {
      title: "Fetch scientific articles (multi-database)",
      description:
        "Fetch full metadata and abstracts for one or more ids from a specific database. " +
        "Returns raw article objects with publication types, MeSH headings and retraction/correction links (plus " +
        "database, url, and language fields for non-PubMed sources) — no classification. " +
        "Use after literature_search to drill into specific papers.",
      inputSchema: literatureFetchShape,
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async (args) => {
      try {
        const result = await withDeadline(TOOL_CALL_BUDGET_MS, () =>
          fetchLiterature({ ids: args.ids, database: args.database }, cache, resolveAdapter(args.database)),
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
    id: z
      .string()
      .describe(
        "Article id — a PMID, a PMCID (PMC…, a record's pmcid), a Europe PMC preprint id (PPR…), or another database's " +
          "id from literature_search. For any other id, a DOI is required below.",
      ),
    doi: z
      .string()
      .optional()
      .describe("DOI — database-agnostic. Required when the id is not a PMID, PMCID or PPR id; otherwise skips the id→DOI lookup."),
    offset: z
      .number()
      .int()
      .min(0)
      .optional()
      .describe("Character position to read the full text from: the nextOffset of the previous call. Default 0."),
    maxChars: z
      .number()
      .int()
      .min(1)
      .optional()
      .describe("Return at most this many characters; the server's limit (default 50,000) is the most."),
  };

  server.registerTool(
    "literature_fulltext",
    {
      title: "Fetch full text for a scientific article (multi-database)",
      description:
        "Attempts to fetch an article's full text as markdown via Europe PMC (records with a PMCID), Unpaywall (open " +
        "access), institutional proxy (if configured), and direct DOI access; falls back to the abstract, with a " +
        "warning saying what each location answered. DOI resolution is database-agnostic: for non-PubMed articles, " +
        "pass the DOI from the literature_search result. Records with neither DOI nor PMCID (all chinaxiv and " +
        "russiarxiv records) can't be resolved; their url links the record. A long text comes in parts: when truncated " +
        "is true, call again with offset set to nextOffset to read on (totalChars is the whole length). Use when the " +
        "abstract isn't enough (verify dosage, sample sizes, methods).",
      inputSchema: literatureFulltextShape,
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async (args) => {
      try {
        const result = await withDeadline(TOOL_CALL_BUDGET_MS, () =>
          fetchFulltext(
            {
              id: args.id,
              ...(args.doi ? { doi: args.doi } : {}),
              ...(args.offset !== undefined ? { offset: args.offset } : {}),
              ...(args.maxChars !== undefined ? { maxChars: args.maxChars } : {}),
            },
            cache,
            ncbi,
            { unpaywall },
          ),
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

  return server;
}
