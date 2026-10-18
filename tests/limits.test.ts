import { describe, expect, it } from "vitest";
import { anonymizeIp, ConcurrencyLimiter, TokenBucketLimiter } from "../src/http/limits.js";

describe("ConcurrencyLimiter", () => {
  it("never exceeds the cap when an acquire races a waiter being released", async () => {
    const limiter = new ConcurrencyLimiter(1);
    let peak = 0;
    const track = () => (peak = Math.max(peak, limiter.inFlight));

    const first = (await limiter.acquire())!;
    track();
    const waiter = limiter.acquire(); // queued behind `first`
    first(); // hands the permit to the waiter, which hasn't resumed yet
    const racer = limiter.acquire(); // must queue, not slip into a "free" slot
    track();

    const second = (await waiter)!;
    track();
    expect(limiter.inFlight).toBe(1);
    expect(limiter.pending).toBe(1);
    second();
    const third = (await racer)!;
    track();
    third();

    expect(peak).toBe(1);
    expect(limiter.inFlight).toBe(0);
    expect(limiter.pending).toBe(0);
  });

  it("holds the cap under a burst of concurrent work", async () => {
    const limiter = new ConcurrencyLimiter(3);
    let running = 0;
    let peak = 0;
    await Promise.all(
      Array.from({ length: 50 }, async (_, i) => {
        const release = (await limiter.acquire())!;
        running += 1;
        peak = Math.max(peak, running, limiter.inFlight);
        await new Promise((r) => setTimeout(r, i % 3));
        running -= 1;
        release();
      }),
    );
    expect(peak).toBe(3);
    expect(limiter.inFlight).toBe(0);
  });

  it("returns null once the queue is full, and a double release is a no-op", async () => {
    const limiter = new ConcurrencyLimiter(1, 1);
    const first = (await limiter.acquire())!;
    const queued = limiter.acquire();
    expect(await limiter.acquire()).toBeNull();

    first();
    first();
    const second = (await queued)!;
    expect(limiter.inFlight).toBe(1);
    second();
    expect(limiter.inFlight).toBe(0);
  });
});

describe("anonymizeIp", () => {
  it.each([
    ["203.0.113.57", "203.0.113.0/24"],
    ["::ffff:203.0.113.57", "203.0.113.0/24"],
    ["2001:db8:abcd:12:34::1", "2001:db8:abcd::/48"],
    ["2001:0DB8:00AB::1", "2001:db8:ab::/48"],
    ["2001:db8::1", "2001:db8:0::/48"],
    ["::1", "0:0:0::/48"],
    ["fe80::1%eth0", "fe80:0:0::/48"],
    ["64:ff9b::192.0.2.33", "64:ff9b:0::/48"],
    ["unknown", "invalid"],
    ["1.2.3.4\n[fake] log line", "invalid"],
  ])("%j → %s", (ip, expected) => {
    expect(anonymizeIp(ip)).toBe(expected);
  });
});

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
