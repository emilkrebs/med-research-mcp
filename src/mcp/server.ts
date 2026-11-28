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
import { printedResult } from "./output.js";

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
  /**
   * Time in ms a literature_search or literature_fetch call's database requests get, retries and
   * waiting in the NCBI queue included (see ../core/request.ts). None by default; the HTTP server sets
   * one, to answer before a gateway gives up. literature_fulltext has none: its pages are fetched with
   * their own timeout, and a cut-off abstract lookup would leave its fallback without the abstract.
   */
  callBudgetMs?: number;
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


  /** A tool call's work, within the call budget when there is one. */
  const budgeted = <T>(call: () => Promise<T>): Promise<T> =>
    options.callBudgetMs === undefined ? call() : withDeadline(options.callBudgetMs, call);

  const server = new McpServer({ name: "med-research-mcp", version: packageVersion() });


  // ─── literature_search ──────────────────────────────────────────

  // Facts the descriptions below rest on, all checked 2026-11-16:
  // - russiarxiv: the ChinaRxiv API counts 25,456 records for source=russiarxiv, from five journals: Doklady
  //   Akademii Nauk SSSR 14,915, Izvestiya Tomskogo Politekhnicheskogo Instituta 7,228, Uspekhi Fizicheskikh Nauk 2,733,
  //   Differentsial'nye Uravneniya 481 and Gigiena i Sanitariya 99 (/api/v1/publications). By subject, Mathematics 5,847,
  //   Chemistry 4,600, Physics 2,226. Word counts (q=): sleep 0, rhodiola 0, eleutherococcus 0, cancer 1, rat 2,
  //   patients 5, therapy 7, disease 9, clinical 11, blood 14, water 1,381.
  // - Europe PMC matches a plain query against full text: for "melatonin sleep elderly" 5,719 hits, 250 with TITLE_ABS: on
  //   each word, and PMC13329461, with none of the three in its title or abstract, matches through BODY:. TITLE_ABS:word
  //   is exactly TITLE:word OR ABSTRACT:word (38,133 hits for one word, none in either difference). A tag covers the next
  //   word only: TITLE:melatonin sleep is TITLE:melatonin AND sleep (5,345), TITLE:(melatonin sleep) both in the title
  //   (1,302). SRC:PPR keeps preprints (melatonin 1,079 of 90,398; SRC:MED 85,634). Field names are listed by the API's
  //   /fields; europepmc.org's own help pages answered 403 (Cloudflare) from here, so the syntax is as the API behaves.
  // - PubMed reads that syntax as words: esearch turned TITLE:melatonin into "title"[All Fields] AND melatonin (77 hits,
  //   not 25,414 title hits) and SRC:PPR into "SRC"[All Fields] AND ("plan pract res"[Journal] OR … OR "ppr"[All Fields]),
  //   0 hits. So Europe PMC's own syntax is for a search of europepmc alone; with pubmed in it, it empties that half.
  // - Europe PMC reads PubMed tags since toEuropePmcQuery (util.ts; the counts of each tag are in its comment). Bare words
  //   `tirzepatide apnea` find 1,560 records there; tirzepatide[tiab] AND apnea[tiab] is sent as TITLE_ABS:tirzepatide AND
  //   TITLE_ABS:apnea, 142 (PubMed: 144). Translated: [tiab] [ti] [au] [pt] [ta] [la] [dp] [pmid]. Removed: every other tag, [mh]
  //   among them ("Sleep Apnea Syndromes"[mh] 50,220 records in PubMed, KW:"Sleep Apnea Syndromes" 17,963: Europe PMC has no
  //   MeSH field and does not explode a heading). A tag after several unquoted words is removed too: PubMed searches them as a
  //   phrase only if its phrase index holds it (`sleep apnea[tiab]` is the phrase, `creatine cognition[tiab]` is creatine
  //   mapped to MeSH AND "cognition"[Title/Abstract]), hence the advice to quote a phrase. The ChinaRxiv adapter sends words only.
  // - Size: for four generic queries, ten PubMed results came to 25,115-28,106 characters of JSON (PubMed's own answers run
  //   through searchLiterature), 12,760-13,330 with abstractMaxChars 600 and 6,577-7,154 with 0. The abstract text alone
  //   was 18,404-21,545 characters, about 2,000 per record.

  const literatureSearchShape = {
    query: z
      .string()
      .trim()
      .min(1, "The query is empty.")
      .describe(
        "Search query: 2-5 keywords, not a sentence. Every space-separated word is required (ANDed), so each extra word " +
          "narrows the results. On 0 results a warning names the word whose removal gives hits; retry without it before " +
          "concluding that no evidence exists. OR (upper case) joins alternatives on pubmed and europepmc; chinaxiv and " +
          "russiarxiv read it as one more required word. " +
          "PubMed field tags apply on pubmed. europepmc reads [tiab] [ti] [au] [pt] [ta] [la] [dp] [pmid] (quote a phrase " +
          'before its tag: "sleep apnea"[tiab]) and drops other tags such as [mh], keeping the words they tag; chinaxiv ' +
          "and russiarxiv ignore tags. On europepmc alone, SRC:PPR keeps preprints. " +
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
          "Options: pubmed, europepmc (PubMed's records plus preprints and other sources; it searches full text, so " +
          "papers that only mention the words match too), chinaxiv (Chinese preprints) and russiarxiv " +
          "(Soviet-era papers, mostly mathematics, physics and chemistry; almost no medicine), both via ChinaRxiv, a " +
          "third-party service that machine-translates them into English.",
      ),
    maxResults: z
      .number()
      .int()
      .min(1)
      .max(50)
      .optional()
      .describe(
        "Records per database and page: with several databases a page holds up to maxResults from each. Default 10, max 50.",
      ),
    abstractMaxChars: z
      .number()
      .int()
      .min(0)
      .optional()
      .describe(
        "Cut abstracts to at most this many characters, at a word boundary, ending in … and abstractTruncated true; 0 " +
          "leaves them out. Default: whole abstracts. A page of 10 full abstracts is roughly 20,000-30,000 characters " +
          "(600 halves it), so set one when searching several databases. literature_fetch returns the whole abstract.",
      ),
    page: z
      .number()
      .int()
      .min(1)
      .max(10_000)
      .optional()
      .describe(
        "Page of results, from 1 (default): page 2 holds each database's next maxResults records. Ask for the nextPage " +
          "a result gives to read past the first page, with the same maxResults (another one shifts the pages, repeating or " +
          "skipping records); each page is merged and sorted on its own. Paging reaches only " +
          "each database's first 10,000 records of a search, and a page starting past them is refused: narrow the query instead.",
      ),
    minDesignTier: z
      .number()
      .min(0)
      .max(5)
      .optional()
      .describe(
        "Drop results below this design tier (0-5; 4 = RCTs). No design gets tier 3, and only network meta-analyses get 5, " +
          "so 3 acts like 4 and 5 keeps little. Results with designTier null — unclassified records and all other " +
          "meta-analyses/systematic reviews — are left out too: the query is narrowed like studyTypes, so they are never " +
          "fetched, and a warning says so. To keep reviews and trials, use studyTypes instead.",
      ),
    studyTypes: z
      .array(z.enum(STUDY_TYPES))
      .optional()
      .describe(
        "Keep only these study types. PubMed and Europe PMC are queried for their publication types, so a page holds " +
          "matching records, short only of those classified as another type (a meta-analysis also tagged as a trial); " +
          "a short page comes with a warning, and total and nextPage count the records before the filter. " +
          "chinaxiv and russiarxiv, whose records are all unknown, are skipped unless unknown is asked for. cohort, case-control, " +
          "cross-sectional and in-vitro are never assigned from metadata (tagged observational studies come back as " +
          "observational), so filtering on them returns nothing. animal-study comes only from veterinary publication types; " +
          "laboratory animal studies are not labeled with it but flagged animals-not-humans.",
      ),
    dateRange: z
      .object({ from: isoDate.optional(), to: isoDate.optional() })
      .optional()
      .describe(
        "Publication date filter: YYYY-MM-DD, YYYY-MM or YYYY (a year or month covers all of it); from or to alone leaves " +
          "the other end open. On pubmed and europepmc it matches the electronic publication date too, so a record " +
          "published online within the range can show a later pubDate; see its epubDate.",
      ),
    sort: z
      .enum(["relevance", "date"])
      .optional()
      .describe(
        'Default "relevance": each database\'s relevance order, re-sorted by design tier, with null tiers after tier 2. ' +
          '"date": newest first by first publication (the earlier of pubDate and epubDate). chinaxiv and russiarxiv ' +
          "ignore it: they still return their most relevant records, which are only put in date order within the page.",
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
        "Search PubMed, Europe PMC, ChinaXiv and RussiaRxiv; each result has its study design. " +
        "studyType comes only from NLM PublicationType tags (PubMed, Europe PMC; assigned by NLM's automated indexing, " +
        "with human review of some records). Records with none naming a design are 'unknown', designTier null. " +
        "designTier (0-5) ranks the design for 'does this intervention help?' by the OCEBM 2011 levels; it is not an " +
        "appraisal. A meta-analysis or systematic review ranks with the studies it pooled, which the tags don't say, so " +
        "its designTier is null unless it is tagged Network Meta-Analysis (5). For a null tier, read the abstract for " +
        "the design or for what a review pooled. flags marks retracted, notice, " +
        "protocol and editorial records (designTier 0), and warns of an expression of concern, an erratum (corrected), " +
        "a newer version (updated; for a preprint, its published article, id in corrections), animals-not-humans indexing, " +
        "preprints, letters, machine-translated text and machine-generated abstracts (chinaxiv, russiarxiv: check originalUrl " +
        "before relying on a number). " +
        "id is the database's own id; pmid is set only for a PMID: cite any other (PPR…, CBA:…, chinaxiv-…, ru-…) " +
        "by id with the database, or by doi/url. Results are merged, de-duplicated by DOI or PMID and sorted, a page at a time: " +
        "when nextPage is set, more follow; a record held by two databases counts twice in total. " +
        "Use literature_fetch for full metadata of given ids, literature_fulltext for the article body.",
      // Strict, so a misnamed key (e.g. `databases`) errors instead of being stripped and silently searching PubMed.
      inputSchema: z.object(literatureSearchShape).strict(),
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async (args) => {
      try {
        const result = await budgeted(() => searchLiterature(args, cache, resolveAdapters(args.database)));
        return {
          content: [{ type: "text", text: JSON.stringify(printedResult(result), null, 2) }],
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
      .array(z.string().trim().min(1, "An id can't be empty."))
      .min(1)
      .max(50)
      .describe(
        "Database-specific ids to fetch, each a literature_search result's id: PMIDs for pubmed; PMIDs, PMCIDs or prefixed ids (e.g. CBA:644599, PPR… preprints) for europepmc; " +
          "the ids literature_search returned for chinaxiv and russiarxiv.",
      ),
    database: z.enum(DATABASES).describe(`Which database the ids belong to: ${DATABASES.join(", ")}.`),
  };

  server.registerTool(
    "literature_fetch",
    {
      title: "Fetch scientific articles (multi-database)",
      description:
        "Fetch full metadata and the whole abstract for one or more ids from a specific database. Each article is " +
        "graded as in literature_search (studyType, designTier, flags) and, for pubmed and europepmc, carries MeSH " +
        "headings and retraction/correction links. Ids that could not be fetched are listed in missing. " +
        "Use after literature_search to drill into specific papers.",
      // Strict, like literature_search: a misnamed key errors instead of being stripped.
      inputSchema: z.object(literatureFetchShape).strict(),
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async (args) => {
      try {
        const result = await budgeted(() =>
          fetchLiterature({ ids: args.ids, database: args.database }, cache, resolveAdapter(args.database)),
        );
        return {
          content: [{ type: "text", text: JSON.stringify(printedResult(result), null, 2) }],
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
        "A literature_search result's id: a PMID, a PMCID (PMC…, a record's pmcid), an id of Europe PMC " +
          "(PPR…, CBA:… with its prefix, IND…) or a chinaxiv or russiarxiv id (chinaxiv-…, ru-…). Each works alone; doi is for " +
          "any other id.",
      ),
    doi: z
      .string()
      .optional()
      .describe(
        "The record's doi (10.… or a https://doi.org/ link), from a search result's doi field; a url or originalUrl is " +
          "not one. Needed only for an id outside those above. With a PMID it must be that PMID's doi: a different one is " +
          "refused. A Europe PMC id without it uses the doi of Europe PMC's record.",
      ),
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
        "Fetches an article's full text as markdown (plain text without layout noise when format is pdf) via Europe PMC (a PMCID or PPR " +
        "preprint), Unpaywall (open access), institutional proxy (if configured) and direct DOI access; chinaxiv and " +
        "russiarxiv records come from ChinaRxiv as a machine translation (check originalUrl before relying on a number). " +
        "The warning opens with RETRACTED, NOTICE or EXPRESSION OF CONCERN when the record has that flag (see " +
        "literature_search); a retracted paper is no evidence. Without the text it says what each location answered, " +
        "and the abstract is returned, cut to maxChars if longer (then truncated is true, with no nextOffset; " +
        "literature_fetch has it whole). A long text comes in parts: see truncated, totalChars, offset. Use when the " +
        "abstract isn't enough (dosage, sample sizes, methods).",
      // Strict, like literature_search: a misnamed key errors instead of being stripped.
      inputSchema: z.object(literatureFulltextShape).strict(),
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async (args) => {
      try {
        const result = await fetchFulltext(
          {
            id: args.id,
            ...(args.doi ? { doi: args.doi } : {}),
            ...(args.offset !== undefined ? { offset: args.offset } : {}),
            ...(args.maxChars !== undefined ? { maxChars: args.maxChars } : {}),
          },
          cache,
          ncbi,
          { unpaywall },
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
