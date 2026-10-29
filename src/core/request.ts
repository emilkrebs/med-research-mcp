/**
 * One upstream GET with the retries every database client shares: the NCBI
 * client (pubmed.ts) and the adapters' HTTP seam (adapters/http.ts).
 *
 * - A 429 is waited out for the server's Retry-After, at most twice, before
 *   RATE_LIMIT reaches the caller.
 * - A 500, 502, 503 or 504, a timeout or a dropped connection is retried at most
 *   twice, after 0.5 s and then 1 s: overloaded servers and the gateways in front
 *   of them often answer the next request. Other statuses fail at once.
 *
 * The timeout covers the whole response, body included: a body that stalls or
 * breaks off is retried like a connection that does.
 *
 * Every retry must fit in {@link RETRY_BUDGET_MS} from the first attempt, and a
 * retry's timeout is cut to what is left of it. A tool call makes several
 * requests in a row (PubMed: esearch, esummary, efetch), and a hosted server sits
 * behind a gateway that gives up on a slow call and answers 504 itself, so a call
 * run by {@link withDeadline} also bounds every attempt of every request it makes,
 * time spent waiting in the NCBI client's queue included.
 */

import { AsyncLocalStorage } from "node:async_hooks";
import { errors, isMedResearchError, type ResearchApiException } from "./errors.js";

/** 429s retried, after the server's Retry-After, before RATE_LIMIT reaches the caller. */
const RATE_LIMIT_RETRIES = 2;
/** The longest Retry-After waited out (NCBI sends 2 s); a longer one goes to the caller. */
const MAX_RETRY_WAIT_S = 5;
/** Retries of a server error, a timeout or a dropped connection. */
const TRANSIENT_RETRIES = 2;
/** Statuses that an overloaded server or a gateway in front of it sends, and that usually clear. */
const TRANSIENT_STATUSES: ReadonlySet<number> = new Set([500, 502, 503, 504]);
/** Wait before the first transient retry; it doubles for the next. */
const BACKOFF_MS = 500;
/** No retry starts later than this after the first attempt. */
const RETRY_BUDGET_MS = 20_000;
/** The shortest timeout an attempt is worth sending with. */
const MIN_ATTEMPT_MS = 2_000;

/** When the current call must be done, in ms since the epoch; set by {@link withDeadline}. */
const callDeadline = new AsyncLocalStorage<number>();

/**
 * Run a call whose requests must be done within `ms`: each attempt's timeout is cut to what is
 * left, and once too little is left, requests fail with TIMEOUT instead of being sent. A
 * deadline inside another keeps the earlier of the two.
 */
export function withDeadline<T>(ms: number, call: () => Promise<T>): Promise<T> {
  return callDeadline.run(Math.min(Date.now() + ms, callDeadline.getStore() ?? Infinity), call);
}

export interface RequestOptions {
  /** Timeout of each attempt in ms; a retry gets at most what is left of the budget. */
  timeoutMs: number;
  headers: Record<string, string>;
  /** The service, named in errors: "PubMed", "Europe PMC", … */
  source: string;
  /** Runs before every attempt, retries included; the NCBI client paces its requests here. */
  beforeAttempt?: () => Promise<void>;
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/**
 * GET a URL and return the body of the successful response. Throws RATE_LIMIT for a 429 its
 * retries don't clear, TIMEOUT when the call's deadline cuts an attempt short or leaves no time to send
 * one, and NETWORK_ERROR for any other failure, after retrying the transient ones.
 */
export async function requestWithRetries(url: string, options: RequestOptions): Promise<string> {
  const started = Date.now();
  // Retries stop at the budget; every attempt, the first included, at the call's deadline.
  const retryDeadline = started + RETRY_BUDGET_MS;
  const deadline = callDeadline.getStore() ?? Infinity;
  let rateLimited = 0;
  let transient = 0;
  /** What the last attempt got, and its message without the error code's prefix. */
  let failure: ResearchApiException | undefined;
  let detail: string | undefined;
  const fail = (message: string): ResearchApiException => {
    detail = message;
    return (failure = errors.network(message));
  };
  for (let attempt = 1; ; attempt += 1) {
    await options.beforeAttempt?.();
    const now = Date.now();
    const callLeft = deadline - now;
    const left = Math.min(attempt === 1 ? Infinity : retryDeadline - now, callLeft);
    if (left < MIN_ATTEMPT_MS) throw callLeft < MIN_ATTEMPT_MS ? errors.outOfTime(options.source, detail) : failure!;
    const timeoutMs = Math.min(options.timeoutMs, left);
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), timeoutMs);
    try {
      const res = await fetch(url, { signal: ac.signal, headers: options.headers });
      if (res.status === 429) {
        const retryAfter = Number(res.headers.get("retry-after")) || 1;
        await res.body?.cancel();
        failure = errors.rateLimit(retryAfter, options.source);
        const late = Date.now() + retryAfter * 1000 + MIN_ATTEMPT_MS > Math.min(retryDeadline, deadline);
        if (rateLimited >= RATE_LIMIT_RETRIES || retryAfter > MAX_RETRY_WAIT_S || late) throw failure;
        rateLimited += 1;
        await sleep(retryAfter * 1000);
        continue;
      }
      // Read within the timeout, so that a body that stalls or breaks off is retried too.
      if (res.ok) return await res.text();
      await res.body?.cancel();
      const message = `${options.source} returned HTTP ${res.status}${attempt > 1 ? ` (attempt ${attempt})` : ""}`;
      if (!TRANSIENT_STATUSES.has(res.status)) throw errors.network(message);
      fail(message);
    } catch (err) {
      if (isMedResearchError(err)) throw err;
      if (ac.signal.aborted) {
        const message = `${options.source} didn't answer within ${Math.round(timeoutMs / 100) / 10} s`;
        // The call's deadline, not the request's timeout, cut the attempt short.
        if (callLeft <= timeoutMs) throw errors.outOfTime(options.source, message);
        fail(message);
      } else {
        fail(err instanceof Error ? err.message : String(err));
      }
    } finally {
      clearTimeout(timer);
    }
    const retryAt = Date.now() + BACKOFF_MS * 2 ** transient + MIN_ATTEMPT_MS;
    if (transient >= TRANSIENT_RETRIES || retryAt > retryDeadline) throw failure;
    if (retryAt > deadline) throw errors.outOfTime(options.source, detail);
    await sleep(BACKOFF_MS * 2 ** transient);
    transient += 1;
  }
}
