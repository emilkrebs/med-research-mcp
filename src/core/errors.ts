/**
 * Typed error handling. Every failure path in the core library surfaces one of
 * these so callers (agents) can decide whether to retry, adjust, or give up.
 */

export type ResearchErrorCode =
  | "RATE_LIMIT"
  | "QUERY_TOO_BROAD"
  | "PARSE_FAILURE"
  | "NETWORK_ERROR"
  | "NOT_FOUND";

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
  rateLimit(retryAfter = 1): ResearchApiException {
    return new ResearchApiException({
      code: "RATE_LIMIT",
      message: `Rate limit hit; retry after ${retryAfter}s`,
      userMessage: `Too many requests to PubMed. Wait ${retryAfter}s and try again. Set an API-Key, like NCBI_API_KEY to raise the limit from 3 to 10 requests/second.`,
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

  notFound(pmid: string): ResearchApiException {
    return new ResearchApiException({
      code: "NOT_FOUND",
      message: `PMID ${pmid} not found`,
      userMessage: `No PubMed article found for PMID ${pmid}. Check the identifier.`,
      recoverable: false,
    });
  },
} as const;
