/**
 * Typed error handling. Every failure path in the core library surfaces one of
 * these so callers (agents) can decide whether to retry, adjust, or give up.
 */

export type ResearchErrorCode =
  | "RATE_LIMIT"
  | "QUERY_TOO_BROAD"
  | "PARSE_FAILURE"
  | "NETWORK_ERROR"
  | "TIMEOUT"
  | "NOT_FOUND"
  | "INVALID_INPUT";

export interface ResearchError {
  code: ResearchErrorCode;
  /** Human-readable, for logs. */
  message: string;
  /** Actionable phrasing for the agent/user. */
  userMessage: string;
  /** Whether the caller can retry or adjust and succeed. */
  recoverable: boolean;
  /** Seconds to wait before retrying (rate limits). */
  retryAfter?: number;
}

export class ResearchApiException extends Error implements ResearchError {
  readonly code: ResearchErrorCode;
  readonly userMessage: string;
  readonly recoverable: boolean;
  readonly retryAfter?: number;

  constructor(error: ResearchError) {
    super(error.message);
    this.name = "ResearchApiException";
    this.code = error.code;
    this.userMessage = error.userMessage;
    this.recoverable = error.recoverable;
    this.retryAfter = error.retryAfter;
  }

  /** Plain serializable shape — safe to return in tool results. */
  toJSON(): ResearchError {
    return {
      code: this.code,
      message: this.message,
      userMessage: this.userMessage,
      recoverable: this.recoverable,
      ...(this.retryAfter !== undefined ? { retryAfter: this.retryAfter } : {}),
    };
  }
}

export function isMedResearchError(value: unknown): value is ResearchApiException {
  return value instanceof ResearchApiException;
}

export const errors = {
  /** @param source the database that answered 429, named in the message. */
  rateLimit(retryAfter = 1, source = "PubMed"): ResearchApiException {
    const hint = source === "PubMed" ? " Set NCBI_API_KEY to raise the limit from 3 to 10 requests/second." : "";
    return new ResearchApiException({
      code: "RATE_LIMIT",
      message: `${source} rate limit hit; retry after ${retryAfter}s`,
      userMessage: `Too many requests to ${source}. Wait ${retryAfter}s and try again.${hint}`,
      recoverable: true,
      retryAfter,
    });
  },

  queryTooBroad(count: number): ResearchApiException {
    return new ResearchApiException({
      code: "QUERY_TOO_BROAD",
      message: `Query matched ${count} results`,
      userMessage: `Your query matched ${count.toLocaleString()} articles — too broad. Narrow it with field tags like [tiab] (title/abstract), [mesh] (MeSH term), or add AND clauses.`,
      recoverable: true,
    });
  },

  parseFailure(detail: string): ResearchApiException {
    return new ResearchApiException({
      code: "PARSE_FAILURE",
      message: `Failed to parse upstream response: ${detail}`,
      userMessage: "The database returned a response that couldn't be fully parsed. Partial results may be available.",
      recoverable: true,
    });
  },

  network(detail: string): ResearchApiException {
    return new ResearchApiException({
      code: "NETWORK_ERROR",
      message: `Network error: ${detail}`,
      userMessage: "Couldn't reach the database. Check your connection and try again.",
      recoverable: true,
    });
  },

  /** A call with a deadline (see withDeadline in ./request.ts) used it up before it could send a request. */
  outOfTime(source: string): ResearchApiException {
    return new ResearchApiException({
      code: "TIMEOUT",
      message: `${source} wasn't asked: the call ran out of time`,
      userMessage:
        `The call ran out of time before ${source} was asked: this server gives each search or fetch a fixed time, and ` +
        `the database itself didn't fail. Retry once: what this call fetched is kept, so the next one gets further. If it ` +
        `fails again, ask for an earlier page or narrow the query (more specific terms, a dateRange); deep pages of a ` +
        `sort: "date" search cost the most.`,
      recoverable: true,
    });
  },

  notFound(pmid: string): ResearchApiException {
    return new ResearchApiException({
      code: "NOT_FOUND",
      message: `PMID ${pmid} not found`,
      userMessage: `No PubMed article found for PMID ${pmid}. Check the identifier.`,
      recoverable: false,
    });
  },

  /** A non-PubMed id reached a DOI-based lookup without a DOI. */
  noDoi(id: string): ResearchApiException {
    return new ResearchApiException({
      code: "NOT_FOUND",
      message: `No DOI for non-PubMed id ${id}`,
      userMessage:
        `"${id}" is not a PMID, PMCID or Europe PMC preprint id, and no DOI was given. Full text is found through the ` +
        `DOI: pass the doi from the literature_search result. Records without one (all ChinaXiv and RussiaRxiv records, ` +
        `some Europe PMC records) can't be resolved, unless they have a pmcid to pass as the id; open their url instead.`,
      recoverable: false,
    });
  },

  /** doi.org has no record of the DOI. */
  doiNotFound(doi: string): ResearchApiException {
    return new ResearchApiException({
      code: "NOT_FOUND",
      message: `DOI ${doi} not found at doi.org`,
      userMessage: `doi.org has no record of DOI ${doi}. Check it: pass the doi exactly as literature_search returned it.`,
      recoverable: false,
    });
  },

  /** A parameter the caller can correct: an unknown database, an empty query, a date that doesn't exist. */
  invalidInput(detail: string): ResearchApiException {
    return new ResearchApiException({
      code: "INVALID_INPUT",
      message: `Invalid input: ${detail}`,
      userMessage: detail,
      recoverable: true,
    });
  },
} as const;
