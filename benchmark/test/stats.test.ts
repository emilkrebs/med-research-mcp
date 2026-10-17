import { describe, expect, it } from "vitest";
import { comparePaired, holm, pairedT, tTwoTailedP, wilcoxon } from "../lib/stats.js";

// Darwin's Zea mays paired differences (cross- minus self-fertilized heights), n=15, no ties.
// Reference: R `wilcox.test(cross, self, paired = TRUE)` → V = 96, p-value = 0.04126 (exact);
// the classic worked example from Hollander & Wolfe / the R documentation.
const DARWIN = [49, -67, 8, 16, 6, 23, 28, 41, 14, 29, 56, 24, 75, 60, -48];

describe("Student t p-values", () => {
  // Tabulated two-sided 5% critical values of Student's t (any t table).
  it.each([
    [12.706, 1],
    [4.303, 2],
    [2.228, 10],
    [2.1448, 14],
    [2.045, 29],
  ])("p(t=%s, df=%s) ≈ 0.05", (t, df) => {
    expect(tTwoTailedP(t, df)).toBeCloseTo(0.05, 3);
  });

  it("paired t on Darwin differences: t = 2.148, p ≈ 0.0497 (df 14)", () => {
    const r = pairedT(DARWIN);
    expect(r.statistic).toBeCloseTo(2.148, 2);
    expect(r.p).toBeCloseTo(0.0497, 3);
    expect(r.dz).toBeGreaterThan(0); // signed
  });
});

describe("Wilcoxon signed-rank", () => {
  it("exact p matches R on Darwin data (V = 96, p = 0.04126)", () => {
    const r = wilcoxon(DARWIN);
    expect(r.method).toBe("exact");
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
    expect(r.p).toBeCloseTo(0.03906, 4);
  });

  it("rank-biserial r is signed", () => {
    expect(wilcoxon([-1, -2, -3, -4, -5, -6]).r).toBe(-1);
    expect(wilcoxon([1, 2, 3, 4, 5, 6]).r).toBe(1);
    expect(wilcoxon([1, -2, 3, -4, 5, -6]).r).toBeCloseTo((9 - 12) / 21, 4);
  });

  it("ties switch to the normal approximation with tie-corrected variance", () => {
    // Hand calculation: ranks 1s→2, 2s→5; W+ = 48, W− = 7, n = 10.
    // var = 96.25 − (24+24)/48 = 95.25; z = (48 − 27.5 − 0.5)/√95.25 = 2.0492; p = 0.0404.
    const r = wilcoxon([1, 1, 2, 2, 3, -1, 4, 5, -2, 6]);
    expect(r.method).toBe("normal");
    expect(r.statistic).toBeCloseTo(2.0492, 3);
    expect(r.p).toBeCloseTo(0.0404, 3);
    expect(r.r).toBeCloseTo(41 / 55, 3);
  });

  it("large untied samples use the normal approximation", () => {
    const diffs = Array.from({ length: 40 }, (_, i) => (i % 3 === 0 ? -(i + 1) : i + 1) + i * 1e-3);
    const r = wilcoxon(diffs);
    expect(r.method).toBe("normal");
    expect(r.p).toBeGreaterThan(0);
    expect(r.p).toBeLessThanOrEqual(1);
  });

  it("all-zero differences give p = 1", () => {
    expect(wilcoxon([0, 0, 0]).p).toBe(1);
  });
});

describe("comparePaired", () => {
  it("labels the Wilcoxon CI as the t-based CI of the mean difference", () => {
    const r = comparePaired([5, 6, 7, 8, 9], [1, 1.5, 2.2, 3.1, 4.6])!;
    expect(r.test).toBe("wilcoxon");
    expect(r.ci_method).toBe("t-mean-diff");
    expect(r.effect_size).toBe(1);
    expect(r.p_method).toBe("exact");
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
