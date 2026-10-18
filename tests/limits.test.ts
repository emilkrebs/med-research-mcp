import { describe, expect, it } from "vitest";
import { TokenBucketLimiter } from "../src/http/limits.js";

describe("TokenBucketLimiter.sweep", () => {
  it("drops a bucket that has been idle long enough to refill", () => {
    let t = 0;
    const limiter = new TokenBucketLimiter(60, 20, () => t);
    limiter.take("a");
    t += 2 * 3_600_000;
    limiter.sweep();

    expect((limiter as unknown as { buckets: Map<string, unknown> }).buckets.size).toBe(0);
  });

  it("keeps an idle bucket that has not refilled yet", () => {
    let t = 0;
    const limiter = new TokenBucketLimiter(1, 100, () => t); // 101 min to refill fully
    for (let i = 0; i < 101; i++) limiter.take("a");
    t += 61 * 60_000;
    limiter.sweep();

    expect((limiter as unknown as { buckets: Map<string, unknown> }).buckets.size).toBe(1);
  });

  it("keeps recently used buckets", () => {
    let t = 0;
    const limiter = new TokenBucketLimiter(60, 20, () => t);
    limiter.take("a");
    t += 60_000;
    limiter.sweep();

    expect((limiter as unknown as { buckets: Map<string, unknown> }).buckets.size).toBe(1);
  });
});
