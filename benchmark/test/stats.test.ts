import { describe, expect, it } from "vitest";
import { bootstrapMeanCI, comparePaired, holm, median, roundP, wilcoxon } from "../lib/stats.js";

// Darwin's Zea mays paired differences (cross- minus self-fertilized heights), n=15, no ties.
// Reference: R `wilcox.test(cross, self, paired = TRUE)` → V = 96, p-value = 0.04126 (exact);
// the classic worked example from Hollander & Wolfe / the R documentation.
const DARWIN = [49, -67, 8, 16, 6, 23, 28, 41, 14, 29, 56, 24, 75, 60, -48];

/** The exact two-sided p by enumerating all 2^n sign patterns: an independent check of the rank-sum distribution. */
function bruteForceP(diffs: number[]): number {
  const d = diffs.filter((x) => x !== 0);
  const order = d.map((x, i) => ({ abs: Math.abs(x), i })).sort((a, b) => a.abs - b.abs);
  const ranks = new Array<number>(d.length);
  for (let i = 0; i < order.length; ) {
    let j = i;
    while (j < order.length && order[j]!.abs === order[i]!.abs) j++;
    for (let k = i; k < j; k++) ranks[order[k]!.i] = (i + 1 + j) / 2;
    i = j;
  }
  const observed = d.reduce((s, x, i) => s + (x > 0 ? ranks[i]! : 0), 0);
  let lower = 0;
  let upper = 0;
  const total = 2 ** d.length;
  for (let mask = 0; mask < total; mask++) {
    let w = 0;
    for (let i = 0; i < d.length; i++) if (mask & (1 << i)) w += ranks[i]!;
    if (w <= observed + 1e-9) lower++;
    if (w >= observed - 1e-9) upper++;
  }
  return Math.min(1, (2 * Math.min(lower, upper)) / total);
}

describe("Wilcoxon signed-rank", () => {
  it("exact p matches R on Darwin data (V = 96, p = 0.04126)", () => {
    const r = wilcoxon(DARWIN);
    expect(r.method).toBe("exact");
    expect(r.statistic).toBe(96);
    expect(r.n).toBe(15);
    expect(r.p).toBeCloseTo(0.04126, 4);
    // r_rb = (96 − 24) / 120
    expect(r.r).toBeCloseTo(0.6, 4);
  });

  it("exact p for all-positive n=5 is 2/32 (combinatorial identity)", () => {
    const r = wilcoxon([1, 2, 3, 4, 5]);
    expect(r.method).toBe("exact");
    expect(r.p).toBeCloseTo(0.0625, 6);
    expect(r.r).toBe(1);
  });

  it("R docs depression example: V = 40, two-sided exact p = 0.03906", () => {
    const x = [1.83, 0.5, 1.62, 2.48, 1.68, 1.88, 1.55, 3.06, 1.3];
    const y = [0.878, 0.647, 0.598, 2.05, 1.06, 1.29, 1.06, 3.14, 1.29];
    const r = wilcoxon(x.map((v, i) => v - y[i]!));
    expect(r.statistic).toBe(40);
    expect(r.p).toBeCloseTo(0.03906, 4);
  });

  it("rank-biserial r is signed", () => {
    expect(wilcoxon([-1, -2, -3, -4, -5, -6]).r).toBe(-1);
    expect(wilcoxon([1, 2, 3, 4, 5, 6]).r).toBe(1);
    expect(wilcoxon([1, -2, 3, -4, 5, -6]).r).toBeCloseTo((9 - 12) / 21, 4);
  });

  it("ties keep the test exact: the p-value is the permutation p for the observed mean ranks", () => {
    // Ranks: the three |1|s → 2, the three |2|s → 5, then 7..10; W+ = 48 of 55.
    const tied = [1, 1, 2, 2, 3, -1, 4, 5, -2, 6];
    const r = wilcoxon(tied);
    expect(r.method).toBe("exact");
    expect(r.statistic).toBe(48);
    expect(r.r).toBeCloseTo(41 / 55, 3);
    expect(r.p).toBeCloseTo(bruteForceP(tied), 6);
  });

  it("matches brute-force enumeration on score-like data (many ties, zeros dropped)", () => {
    // Accuracy differences as the benchmark produces them: multiples of 3.33 and exact zeros.
    const cases = [
      [10, 10, 3.33, 0, 0, 6.67, 10, 0, 10, 10, 3.33, -3.33],
      [0, 0, 0, 10, -10, 6.67, 6.67, 3.33],
      [6.67, 3.33, 1.67, 0, 0, 0, 0, 0, 0],
      [-2.5, 2.5, 2.5, 5, 5, 5, 7.5, -7.5, 10, 10, 10, 0.5, -0.5, 1],
    ];
    for (const diffs of cases) {
      const r = wilcoxon(diffs);
      expect(r.method).toBe("exact");
      expect(r.n).toBe(diffs.filter((d) => d !== 0).length);
      expect(r.p).toBeCloseTo(bruteForceP(diffs), 6);
    }
  });

  it("stays exact for a hundred queries and only then falls back to the normal approximation", () => {
    const hundred = Array.from({ length: 100 }, (_, i) => (i % 3 === 0 ? -(i + 1) : i + 1));
    const exact = wilcoxon(hundred);
    expect(exact.method).toBe("exact");
    expect(exact.p).toBeGreaterThan(0);
    expect(exact.p).toBeLessThan(0.01);
    const large = wilcoxon(Array.from({ length: 320 }, (_, i) => (i % 3 === 0 ? -(i + 1) : i + 1) + i * 1e-3));
    expect(large.method).toBe("normal");
    expect(large.p).toBeGreaterThanOrEqual(0);
    expect(large.p).toBeLessThanOrEqual(1);
  });

  it("all-zero differences give p = 1", () => {
    const r = wilcoxon([0, 0, 0]);
    expect(r.p).toBe(1);
    expect(r.n).toBe(0);
  });
});

describe("bootstrapMeanCI", () => {
  it("is deterministic, brackets the mean, and narrows with more data", () => {
    const xs = [2, 4, 4, 5, 7, 9, 10, 10, 3, 6];
    const a = bootstrapMeanCI(xs)!;
    expect(bootstrapMeanCI(xs)).toEqual(a);
    expect(a[0]).toBeLessThan(6);
    expect(a[1]).toBeGreaterThan(6);
    const wide = bootstrapMeanCI(xs.slice(0, 4))!;
    const narrow = bootstrapMeanCI([...xs, ...xs, ...xs, ...xs])!;
    expect(narrow[1] - narrow[0]).toBeLessThan(wide[1] - wide[0]);
  });

  it("is close to the normal-theory interval for a well-behaved sample", () => {
    // 200 evenly spread values on [0, 10]: mean 5, SE = 2.90/√200 = 0.205 → about [4.60, 5.40].
    const xs = Array.from({ length: 200 }, (_, i) => (i * 10) / 199);
    const [lo, hi] = bootstrapMeanCI(xs)!;
    expect(lo).toBeCloseTo(4.6, 1);
    expect(hi).toBeCloseTo(5.4, 1);
  });

  it("collapses for constant data and is null for fewer than two values", () => {
    expect(bootstrapMeanCI([10, 10, 10])).toEqual([10, 10]);
    expect(bootstrapMeanCI([7])).toBeNull();
    expect(bootstrapMeanCI([])).toBeNull();
  });

  it("depends on the seed", () => {
    // Continuous values: on a coarse lattice two seeds can land on the same percentiles.
    const xs = Array.from({ length: 40 }, (_, i) => 5 + 4 * Math.sin(i * 1.7));
    expect(bootstrapMeanCI(xs, { seed: 1, resamples: 500 })).not.toEqual(bootstrapMeanCI(xs, { seed: 2, resamples: 500 }));
  });
});

describe("median", () => {
  it("handles odd, even and empty lists", () => {
    expect(median([3, 1, 2])).toBe(2);
    expect(median([4, 1, 3, 2])).toBe(2.5);
    expect(median([])).toBeNaN();
  });
});

describe("comparePaired", () => {
  it("always runs the Wilcoxon test and reports a bootstrap interval of the mean difference", () => {
    const r = comparePaired([5, 6, 7, 8, 9], [1, 1.5, 2.2, 3.1, 4.6])!;
    expect(r.test).toBe("wilcoxon");
    expect(r.p_method).toBe("exact");
    expect(r.ci_method).toBe("bootstrap-percentile");
    expect(r.effect_size).toBe(1);
    expect(r.n).toBe(5);
    expect(r.n_nonzero).toBe(5);
    expect(r.meanDiff).toBeCloseTo(4.52, 2);
    expect(r.ci_95![0]).toBeLessThanOrEqual(r.meanDiff);
    expect(r.ci_95![1]).toBeGreaterThanOrEqual(r.meanDiff);
  });

  it("does not switch tests on well-behaved data (no data-dependent choice)", () => {
    const a = Array.from({ length: 30 }, (_, i) => 5 + Math.sin(i) + 0.5);
    const b = Array.from({ length: 30 }, (_, i) => 5 + Math.sin(i + 1));
    expect(comparePaired(a, b)!.test).toBe("wilcoxon");
  });

  it("counts zero differences in n but not in n_nonzero", () => {
    const r = comparePaired([10, 10, 10, 10, 6.67], [10, 10, 10, 3.33, 0])!;
    expect(r.n).toBe(5);
    expect(r.n_nonzero).toBe(2);
    expect(r.p_value).toBe(0.5); // two positive differences: 2 × (1/4)
  });

  it("returns null with fewer than 2 pairs", () => {
    expect(comparePaired([1], [2])).toBeNull();
  });
});

describe("holm", () => {
  it("matches R p.adjust(method = 'holm')", () => {
    const adj = holm([0.01, 0.04, 0.03, 0.005]);
    expect(adj[0]).toBeCloseTo(0.03, 10);
    expect(adj[1]).toBeCloseTo(0.06, 10);
    expect(adj[2]).toBeCloseTo(0.06, 10);
    expect(adj[3]).toBeCloseTo(0.02, 10);
  });

  it("caps at 1, preserves order, ignores NaN", () => {
    expect(holm([0.9, 0.8])).toEqual([1, 1]);
    const adj = holm([Number.NaN, 0.01]);
    expect(Number.isNaN(adj[0])).toBe(true);
    expect(adj[1]).toBeCloseTo(0.01, 10);
    expect(holm([])).toEqual([]);
  });
});

describe("p-values are rounded to 6 decimals, but never to zero", () => {
  it("roundP keeps a positive value that 6 decimals would turn into 0, and rounds the rest as before", () => {
    expect(roundP(0.1234567891)).toBe(0.123457);
    expect(roundP(1)).toBe(1);
    expect(roundP(0)).toBe(0);
    expect(roundP(2e-12)).toBe(2e-12);
    expect(roundP(0.0000004)).toBe(0.0000004);
    expect(roundP(0.0000006)).toBe(0.000001);
  });

  it("an exact test of 40 one-sided differences is 2 / 2^40, not 0", () => {
    const r = wilcoxon(Array.from({ length: 40 }, (_, i) => i + 1));
    expect(r.method).toBe("exact");
    expect(r.p).toBeGreaterThan(0);
    expect(r.p).toBeCloseTo(2 / 2 ** 40, 20);
  });
});
