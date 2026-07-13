/**
 * A tiny HTTP seam shared by the REST/HTML adapters.
 *
 * It centralizes timeout, User-Agent, rate-limit (429) handling, and error
 * mapping so each adapter is just URL construction + response parsing. The
 * `AdapterHttp` interface is injectable: adapters take one in their constructor
 * and default to {@link defaultHttp}, so tests pass a fake that returns fixtures
 * without touching the network — mirroring how `NcbiClient` and `fetchFulltext`
 * are tested elsewhere in the library.
 */

import { errors } from "../errors.js";

const DEFAULT_TIMEOUT_MS = 15_000;
const DEFAULT_USER_AGENT = "med-research-mcp/0.3.0 (https://github.com/emilkrebs/med-research-mcp)";

/** Fetches a URL and returns either parsed JSON or raw text. */
export interface AdapterHttp {
  json<T>(url: string): Promise<T>;
  text(url: string): Promise<string>;
  /** POST with optional JSON body. */
  post<T>(url: string, body?: unknown): Promise<T>;
}

export interface HttpOptions {
  /** Per-request timeout in ms. Default 15000. */
  timeoutMs?: number;
  /** Sent as the User-Agent header. */
  userAgent?: string;
}

export function defaultHttp(options: HttpOptions = {}): AdapterHttp {
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const userAgent = options.userAgent ?? DEFAULT_USER_AGENT;

  async function request(url: string, accept: string): Promise<Response> {
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), timeoutMs);
    let res: Response;
    try {
      res = await fetch(url, { signal: ac.signal, headers: { "User-Agent": userAgent, Accept: accept } });
    } catch (err) {
      throw errors.network(err instanceof Error ? err.message : String(err));
    } finally {
      clearTimeout(timer);
    }
    if (res.status === 429) {
      throw errors.rateLimit(Number(res.headers.get("retry-after")) || 1);
    }
    if (!res.ok) {
      throw errors.network(`Upstream returned HTTP ${res.status}`);
    }
    return res;
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
    async post<T>(url: string, body?: unknown): Promise<T> {
      const ac = new AbortController();
      const timer = setTimeout(() => ac.abort(), timeoutMs);
      let res: Response;
      try {
        res = await fetch(url, {
          method: "POST",
          signal: ac.signal,
          headers: {
            "User-Agent": userAgent,
            "Content-Type": "application/json; charset=utf-8",
            Accept: "application/json",
          },
          body: body != null ? JSON.stringify(body) : undefined,
        });
      } catch (err) {
        throw errors.network(err instanceof Error ? err.message : String(err));
      } finally {
        clearTimeout(timer);
      }
      if (res.status === 429) {
        throw errors.rateLimit(Number(res.headers.get("retry-after")) || 1);
      }
      if (!res.ok) {
        throw errors.network(`Upstream returned HTTP ${res.status}`);
      }
      try {
        return (await res.json()) as T;
      } catch (err) {
        throw errors.parseFailure(err instanceof Error ? err.message : "invalid JSON from upstream");
      }
    },
  };
}
