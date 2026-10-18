/**
 * Request limits for the hosted HTTP entry point: client-IP extraction, a
 * per-IP token bucket and a global concurrency semaphore.
 *
 * Deliberately hand-rolled on top of node:http — the hosted server must not
 * pull in express, rate-limit packages or any other runtime dependency. The
 * structures are process-local: the hosted instance is a single long-running
 * Node process behind a TLS reverse proxy.
 */

import type { IncomingMessage } from "node:http";

/**
 * The client IP for rate limiting: the socket address, or — only when the
 * operator has opted in with MED_RESEARCH_TRUST_PROXY=1 — the first
 * X-Forwarded-For entry set by the reverse proxy. Without that opt-in the
 * header is attacker-controlled and must not feed the bucket.
 */
export function clientIp(req: IncomingMessage, trustProxy: boolean): string {
  if (trustProxy) {
    const header = req.headers["x-forwarded-for"];
    const first = Array.isArray(header) ? header[0] : header;
    const entry = first?.split(",")[0]?.trim();
    if (entry) return entry;
  }
  return req.socket.remoteAddress ?? "unknown";
}

export interface RateLimitResult {
  allowed: boolean;
  /** Whole seconds until a token is available again; 0 when allowed. */
  retryAfterSeconds: number;
}

interface Bucket {
  tokens: number;
  /** Last refill, from the injected clock (ms). */
  at: number;
}

/**
 * Per-key token bucket. Capacity is ratePerMin + burst, so a client may fire
 * rate + burst requests immediately and then sustains ratePerMin per minute;
 * tokens refill continuously.
 */
export class TokenBucketLimiter {
  private readonly buckets = new Map<string, Bucket>();
  private readonly capacity: number;

  constructor(
    private readonly ratePerMin: number,
    burst: number,
    private readonly now: () => number = Date.now,
  ) {
    this.capacity = ratePerMin + burst;
  }

  take(key: string): RateLimitResult {
    const at = this.now();
    const bucket = this.buckets.get(key) ?? { tokens: this.capacity, at };
    // Continuous refill at ratePerMin tokens per minute.
    const elapsedMin = Math.max(0, (at - bucket.at) / 60_000);
    bucket.tokens = Math.min(this.capacity, bucket.tokens + elapsedMin * this.ratePerMin);
    bucket.at = at;

    if (bucket.tokens >= 1) {
      bucket.tokens -= 1;
      this.buckets.set(key, bucket);
      return { allowed: true, retryAfterSeconds: 0 };
    }
    this.buckets.set(key, bucket);
    const missing = 1 - bucket.tokens;
    return { allowed: false, retryAfterSeconds: Math.max(1, Math.ceil((missing / this.ratePerMin) * 60)) };
  }

  /** Drop idle keys so the map doesn't grow without bound on a public endpoint. */
  sweep(olderThanMs = 3_600_000): void {
    const at = this.now();
    const cutoff = at - olderThanMs;
    for (const [key, bucket] of this.buckets) {
      if (bucket.at >= cutoff) continue;
      // Stored tokens are only refilled on take(), so project the refill before deciding.
      const refilled = bucket.tokens + ((at - bucket.at) / 60_000) * this.ratePerMin;
      if (refilled >= this.capacity) this.buckets.delete(key);
    }
  }
}

/**
 * Global concurrency semaphore with a bounded queue. `acquire()` resolves with
 * a release function, or with null when the queue is full (caller → 503).
 */
export class ConcurrencyLimiter {
  private active = 0;
  private readonly queue: Array<() => void> = [];

  constructor(
    private readonly max: number,
    private readonly maxQueue = 100,
  ) {}

  async acquire(): Promise<(() => void) | null> {
    if (this.active >= this.max) {
      if (this.queue.length >= this.maxQueue) return null;
      await new Promise<void>((resolve) => this.queue.push(resolve));
    }
    this.active += 1;
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.active -= 1;
      this.queue.shift()?.();
    };
  }

  get pending(): number {
    return this.queue.length;
  }

  get inFlight(): number {
    return this.active;
  }
}
