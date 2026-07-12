/**
 * Typed error handling. Every failure path in the core library surfaces one of
 * these so callers (agents) can decide whether to retry, adjust, or give up.
 */

export type PubMedErrorCode =
  | "RATE_LIMIT"
  | "QUERY_TOO_BROAD"
  | "NO_ABSTRACT"
  | "PARSE_FAILURE"
  | "LLM_UNAVAILABLE"
  | "LLM_TIMEOUT"
  | "NETWORK_ERROR"
  | "NOT_FOUND";

export interface PubMedError {
  code: PubMedErrorCode;
  /** Human-readable, for logs. */
  message: string;
  /** Actionable phrasing for the agent/user. */
  userMessage: string;
  /** Whether the caller can retry or adjust and succeed. */
  recoverable: boolean;
  /** Seconds to wait before retrying (rate limits). */
  retryAfter?: number;
}

export class PubMedException extends Error implements PubMedError {
  readonly code: PubMedErrorCode;
  readonly userMessage: string;
  readonly recoverable: boolean;
  readonly retryAfter?: number;

  constructor(error: PubMedError) {
    super(error.message);
    this.name = "PubMedException";
    this.code = error.code;
    this.userMessage = error.userMessage;
    this.recoverable = error.recoverable;
    this.retryAfter = error.retryAfter;
  }

  /** Plain serializable shape — safe to return in tool results. */
  toJSON(): PubMedError {
    return {
      code: this.code,
      message: this.message,
      userMessage: this.userMessage,
      recoverable: this.recoverable,
      ...(this.retryAfter !== undefined ? { retryAfter: this.retryAfter } : {}),
    };
  }
}

export function isPubMedError(value: unknown): value is PubMedException {
  return value instanceof PubMedException;
}

export const errors = {
  rateLimit(retryAfter = 1): PubMedException {
    return new PubMedException({
      code: "RATE_LIMIT",
      message: `NCBI rate limit hit; retry after ${retryAfter}s`,
      userMessage: `Too many requests to PubMed. Wait ${retryAfter}s and try again. Set NCBI_API_KEY to raise the limit from 3 to 10 requests/second.`,
      recoverable: true,
      retryAfter,
    });
  },

  queryTooBroad(count: number): PubMedException {
    return new PubMedException({
      code: "QUERY_TOO_BROAD",
      message: `Query matched ${count} results`,
      userMessage: `Your query matched ${count.toLocaleString()} articles — too broad to grade meaningfully. Narrow it with field tags like [tiab] (title/abstract), [mesh] (MeSH term), or add AND clauses.`,
      recoverable: true,
    });
  },

  parseFailure(detail: string): PubMedException {
    return new PubMedException({
      code: "PARSE_FAILURE",
      message: `Failed to parse NCBI response: ${detail}`,
      userMessage: "PubMed returned a response that couldn't be fully parsed. Partial results may be available.",
      recoverable: true,
    });
  },

  network(detail: string): PubMedException {
    return new PubMedException({
      code: "NETWORK_ERROR",
      message: `Network error contacting NCBI: ${detail}`,
      userMessage: "Couldn't reach PubMed. Check your connection and try again.",
      recoverable: true,
    });
  },

  notFound(pmid: string): PubMedException {
    return new PubMedException({
      code: "NOT_FOUND",
      message: `PMID ${pmid} not found`,
      userMessage: `No PubMed article found for PMID ${pmid}. Check the identifier.`,
      recoverable: false,
    });
  },

  llmUnavailable(detail: string): PubMedException {
    return new PubMedException({
      code: "LLM_UNAVAILABLE",
      message: `LLM provider unavailable: ${detail}`,
      userMessage: "The deep-grading LLM is not configured or unreachable. Falling back to keyword grading.",
      recoverable: true,
    });
  },

  llmTimeout(timeoutMs: number): PubMedException {
    return new PubMedException({
      code: "LLM_TIMEOUT",
      message: `LLM grading timed out after ${timeoutMs}ms`,
      userMessage: "Deep grading took too long and timed out. Falling back to keyword grading.",
      recoverable: true,
    });
  },
} as const;
