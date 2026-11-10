/**
 * Condition E tools: plain PubMed access. This is the baseline that separates
 * what the MCP adds from what any connection to PubMed gives.
 *
 * `pubmed_search` and `pubmed_fetch` return PubMed's records as PubMed serves
 * them — title, authors, journal, dates, DOI, NLM publication types, MeSH
 * headings, abstract — in PubMed's own order, with the search options
 * E-utilities itself has (date range, sort, paging). They leave out everything
 * the MCP layers on top: the study-design label and tier, the integrity flags,
 * sorting and filtering by design, the other databases (Europe PMC, ChinaXiv,
 * RussiaRxiv) and full text.
 *
 * Both run on the core's NcbiClient (the process-wide rate limiter, with its
 * retries), so the two conditions differ in what the tools return and not in
 * how reliably NCBI answers. Each toolset has its own cache, like each MCP server.
 */

import { tool, type ToolSet } from "ai";
import { z } from "zod";
import { fetchPubMed, LRUBackend, searchPubMed } from "../core.js";
import type { GradedArticle, NcbiClient } from "../core.js";
import { sharedNcbi } from "./literature.js";

export interface PubmedToolDeps {
  ncbi?: NcbiClient;
  /** Test seams; default to the core library's PubMed functions. */
  search?: typeof searchPubMed;
  fetch?: typeof fetchPubMed;
}

/** A search hit without the labels the MCP's grader adds. */
function plain(article: GradedArticle): Omit<GradedArticle, "studyType" | "designTier" | "flags"> {
  const { studyType: _studyType, designTier: _designTier, flags: _flags, ...record } = article;
  return record;
}

const errorText = (err: unknown): string => `Error: ${err instanceof Error ? err.message : String(err)}`;

/** Build the condition-E toolset. */
export function pubmedTools(deps: PubmedToolDeps = {}): ToolSet {
  const ncbi = deps.ncbi ?? sharedNcbi;
  const search = deps.search ?? searchPubMed;
  const fetchRecords = deps.fetch ?? fetchPubMed;
  const cache = new LRUBackend();

  return {
    pubmed_search: tool({
      description:
        "Search PubMed (NCBI E-utilities) and return the matching records in PubMed's order: PMID, title, authors, journal, " +
        "publication date, DOI, NLM publication types, MeSH headings and abstract. The query uses PubMed syntax: " +
        "space-separated words are ANDed; field tags such as [tiab], [au], [ta], [dp] and [pt], and AND/OR/NOT, are supported. " +
        "If nothing comes back, retry with fewer words.",
      inputSchema: z.object({
        query: z.string().min(1).describe("The PubMed query."),
        maxResults: z.number().int().min(1).max(50).optional().describe("Records per page. Default 10, max 50."),
        page: z.number().int().min(1).optional().describe("Page of results, from 1 (default)."),
        sort: z.enum(["relevance", "date"]).optional().describe('"relevance" (default) or "date" (newest first).'),
        dateRange: z
          .object({ from: z.string().optional(), to: z.string().optional() })
          .optional()
          .describe("Publication date filter: YYYY-MM-DD, YYYY-MM or YYYY."),
      }),
      execute: async (input) => {
        try {
          const out = await search(
            {
              query: input.query,
              maxResults: input.maxResults ?? 10,
              ...(input.page !== undefined ? { page: input.page } : {}),
              ...(input.sort ? { sort: input.sort } : {}),
              ...(input.dateRange ? { dateRange: input.dateRange } : {}),
            },
            cache,
            ncbi,
          );
          return JSON.stringify(
            {
              articles: out.articles.map(plain),
              total: out.total,
              query: out.query,
              page: out.page,
              maxResults: out.maxResults,
              ...(out.nextPage !== undefined ? { nextPage: out.nextPage } : {}),
              ...(out.warnings?.length ? { warnings: out.warnings } : {}),
            },
            null,
            2,
          );
        } catch (err) {
          return errorText(err);
        }
      },
    }),

    pubmed_fetch: tool({
      description:
        "Fetch PubMed records by PMID: title, authors, journal, publication date, DOI, NLM publication types, MeSH headings, " +
        "links to retraction and correction notices, and the abstract.",
      inputSchema: z.object({
        pmids: z.array(z.string()).min(1).max(50).describe("1–50 PMIDs."),
      }),
      execute: async ({ pmids }) => {
        try {
          return JSON.stringify(await fetchRecords({ ids: pmids }, cache, ncbi), null, 2);
        } catch (err) {
          return errorText(err);
        }
      },
    }),
  };
}
