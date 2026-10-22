/**
 * A tiny HTTP seam shared by the REST/HTML adapters.
 *
 * It centralizes timeout, User-Agent, retries (of a 429, a server error or a
 * timeout; see ../request.ts) and error mapping so each adapter is just URL
 * construction + response parsing. The
 * `AdapterHttp` interface is injectable: adapters take one in their constructor
 * and default to {@link defaultHttp}, so tests pass a fake that returns fixtures
 * without touching the network — mirroring how `NcbiClient` and `fetchFulltext`
 * are tested elsewhere in the library.
 */

import { errors } from "../errors.js";
import { requestWithRetries } from "../request.js";
import { USER_AGENT } from "../version.js";

const DEFAULT_TIMEOUT_MS = 15_000;

/** Fetches a URL and returns either parsed JSON or raw text. */
export interface AdapterHttp {
  json<T>(url: string): Promise<T>;
  text(url: string): Promise<string>;
}

export interface HttpOptions {
  /** Per-request timeout in ms. Default 15000. */
  timeoutMs?: number;
  /** Sent as the User-Agent header. */
  userAgent?: string;
  /** Extra headers merged into every request (after User-Agent/Accept, so they can override). */
  headers?: Record<string, string>;
  /** Service name for errors, e.g. "Europe PMC". */
  source?: string;
}

export function defaultHttp(options: HttpOptions = {}): AdapterHttp {
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const userAgent = options.userAgent ?? USER_AGENT;
  const source = options.source ?? "the database";

  // A longer Retry-After than the helper waits out (ChinaRxiv's limit is per minute) goes to the caller.
  const request = (url: string, accept: string): Promise<Response> =>
    requestWithRetries(url, { timeoutMs, source, headers: { "User-Agent": userAgent, Accept: accept, ...options.headers } });

  return {
    async json<T>(url: string): Promise<T> {
      const res = await request(url, "application/json");
      try {
        return (await res.json()) as T;
      } catch (err) {
        throw errors.parseFailure(err instanceof Error ? err.message : "invalid JSON from upstream");
      }
    },
    async text(url: string): Promise<string> {
      const res = await request(url, "text/html,application/xhtml+xml,*/*");
      return res.text();
    },
  };
}
