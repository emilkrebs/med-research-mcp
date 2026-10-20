/**
 * A tiny HTTP seam shared by the REST/HTML adapters.
 *
 * It centralizes timeout, User-Agent, rate-limit (429) retries, and error
 * mapping so each adapter is just URL construction + response parsing. The
 * `AdapterHttp` interface is injectable: adapters take one in their constructor
 * and default to {@link defaultHttp}, so tests pass a fake that returns fixtures
 * without touching the network — mirroring how `NcbiClient` and `fetchFulltext`
 * are tested elsewhere in the library.
 */

import { errors } from "../errors.js";
import { USER_AGENT } from "../version.js";

const DEFAULT_TIMEOUT_MS = 15_000;
/** 429s retried, after the server's Retry-After, before RATE_LIMIT reaches the caller. */
const RATE_LIMIT_RETRIES = 2;
/** The longest Retry-After waited out; a longer one (ChinaRxiv's limit is per minute) goes to the caller. */
const MAX_RETRY_WAIT_S = 5;

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
  /** Service name for rate-limit errors, e.g. "Europe PMC". */
  source?: string;
}

export function defaultHttp(options: HttpOptions = {}): AdapterHttp {
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const userAgent = options.userAgent ?? USER_AGENT;
  const source = options.source ?? "the database";

  async function request(url: string, accept: string): Promise<Response> {
    for (let attempt = 0; ; attempt += 1) {
      const ac = new AbortController();
      const timer = setTimeout(() => ac.abort(), timeoutMs);
      let res: Response;
      try {
        res = await fetch(url, {
          signal: ac.signal,
          headers: { "User-Agent": userAgent, Accept: accept, ...options.headers },
        });
      } catch (err) {
        throw errors.network(err instanceof Error ? err.message : String(err));
      } finally {
        clearTimeout(timer);
      }
      if (res.status === 429) {
        const retryAfter = Number(res.headers.get("retry-after")) || 1;
        await res.body?.cancel();
        if (attempt >= RATE_LIMIT_RETRIES || retryAfter > MAX_RETRY_WAIT_S) throw errors.rateLimit(retryAfter, source);
        await new Promise((r) => setTimeout(r, retryAfter * 1000));
        continue;
      }
      if (!res.ok) {
        throw errors.network(`Upstream returned HTTP ${res.status}`);
      }
      return res;
    }
  }

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
