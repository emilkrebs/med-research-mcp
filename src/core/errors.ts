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

  /** A PubMed client that was given a `broadThreshold` refused a search over it; the default client serves broad queries, with a warning. */
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

  /**
   * A call with a deadline (see withDeadline in ./request.ts) used it up: before it could send a request, or,
   * with `detail` (what the last attempt got), while waiting for an answer or before a retry.
   */
  outOfTime(source: string, detail?: string): ResearchApiException {
    return new ResearchApiException({
      code: "TIMEOUT",
      message: detail ? `${detail}: the call ran out of time` : `${source} wasn't asked: the call ran out of time`,
      userMessage:
        `This server gives each search or fetch a fixed time, and it ran out ${detail ? "while waiting for" : "before asking"} ` +
        `${source}. Retry. A deep page of a search keeps what it fetched, so each retry gets further, and the deepest ` +
        `sort: "date" pages can take several; if retries stop getting further, ask for an earlier page or narrow the ` +
        `query (more specific terms, a dateRange).`,
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

  /**
   * An id that no database record backs, and no DOI was given. `looked`: Europe PMC was asked for its record and had none
   * (or couldn't be reached); otherwise the id is none that literature_fulltext looks up.
   */
  noDoi(id: string, looked = false): ResearchApiException {
    return new ResearchApiException({
      code: "NOT_FOUND",
      message: looked ? `No Europe PMC record or DOI for id ${id}` : `No DOI for unrecognized id ${id}`,
      userMessage:
        (looked
          ? `Europe PMC has no record of "${id}" (or couldn't be reached), and no doi was given. `
          : `"${id}" is not an id literature_fulltext looks up: not a PMID (digits), a PMCID (PMC…), an id of Europe PMC ` +
            `(PPR…, CBA:…, IND…) or a ChinaXiv or RussiaRxiv id (chinaxiv-…, ru-…), and no doi was given. `) +
        `Pass the id of a literature_search result, with any prefix (CBA:644599), or the doi of that result; a ` +
        `record without a doi can't be fetched, so open its url instead. A url or originalUrl is not a doi: don't pass one ` +
        `as doi.`,
      recoverable: false,
    });
  },

  /** A `doi` that isn't one (a record's url, say) where the id can't be resolved without it. */
  notADoi(value: string): ResearchApiException {
    const shown = JSON.stringify(value.length > 200 ? `${value.slice(0, 200)}…` : value);
    return errors.invalidInput(
      `doi ${shown} is not a DOI. A DOI starts with 10. and a number, then a slash ("10.1234/abc"), alone or as a ` +
        `https://doi.org/10.1234/abc link. A record's url or originalUrl is not a doi: pass the doi field of the ` +
        `literature_search result. This id can't be resolved without one.`,
    );
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

  /** A parameter the caller can correct: an unknown database, an empty or unsearchable query, a date that doesn't exist. */
  invalidInput(detail: string): ResearchApiException {
    return new ResearchApiException({
      code: "INVALID_INPUT",
      message: `Invalid input: ${detail}`,
      userMessage: detail,
      recoverable: true,
    });
  },
} as const;
