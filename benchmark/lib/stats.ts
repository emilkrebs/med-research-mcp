/**
 * Self-contained statistics for the report tables: descriptive stats, a seeded
 * bootstrap confidence interval for a mean, the Wilcoxon signed-rank test, and
 * Holm's correction. No numeric-library dependency.
 *
 * Every paired comparison uses one procedure, fixed in advance rather than
 * chosen from the data: the Wilcoxon signed-rank test on the per-query
 * differences, with a percentile-bootstrap interval for the mean difference.
 * Scores here are bounded and heavily tied (an accuracy is often exactly 0 or
 * 10), which rules out a t-test and the usual normal approximation, so the
 * p-value comes from the exact null distribution of the rank sum given the
 * observed ranks, ties included.
 */

export function mean(xs: number[]): number {
  return xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0;
}

/** Sample standard deviation (n−1). Zero for n<2. */
export function sd(xs: number[]): number {
  if (xs.length < 2) return 0;
  const m = mean(xs);
  return Math.sqrt(xs.reduce((a, b) => a + (b - m) ** 2, 0) / (xs.length - 1));
}

/** Median (mean of the two middle values for an even count). NaN for an empty list. */
export function median(xs: number[]): number {
  if (xs.length === 0) return Number.NaN;
  const sorted = [...xs].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2;
}

// ─── Bootstrap ──────────────────────────────────────────────────

/** mulberry32: tiny seeded PRNG returning floats in [0, 1). */
export function seededRandom(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Fixed so that a report is a function of its rows alone: the same scores give the same intervals. */
export const BOOTSTRAP_SEED = 20261109;

export interface BootstrapOptions {
  resamples?: number;
  seed?: number;
  /** Two-sided confidence level. Default 0.95. */
  confidence?: number;
}

/**
 * Percentile-bootstrap confidence interval for the mean of `xs` (the units are
 * resampled with replacement; here a unit is a query). Null for fewer than two
 * values, where there is no spread to resample. With few units (under about
 * ten) the interval is too narrow; read it as a rough guide.
 */
export function bootstrapMeanCI(xs: number[], opts: BootstrapOptions = {}): [number, number] | null {
  const n = xs.length;
  if (n < 2) return null;
  const resamples = opts.resamples ?? 10_000;
  const alpha = 1 - (opts.confidence ?? 0.95);
  const random = seededRandom(opts.seed ?? BOOTSTRAP_SEED);
  const means = new Float64Array(resamples);
  for (let b = 0; b < resamples; b++) {
    let sum = 0;
    for (let i = 0; i < n; i++) sum += xs[Math.floor(random() * n)]!;
    means[b] = sum / n;
  }
  means.sort();
  const lo = means[Math.floor((alpha / 2) * resamples)]!;
  const hi = means[Math.min(resamples - 1, Math.ceil((1 - alpha / 2) * resamples) - 1)]!;
  return [round(lo), round(hi)];
}

// ─── Wilcoxon signed-rank ───────────────────────────────────────

/** Standard normal CDF via erf. */
function normalCDF(z: number): number {
  return 0.5 * (1 + erf(z / Math.SQRT2));
}

function erf(x: number): number {
  // Abramowitz & Stegun 7.1.26, |error| < 1.5e-7.
  const t = 1 / (1 + 0.3275911 * Math.abs(x));
  const y =
    1 - ((((1.061405429 * t - 1.453152027) * t + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t * Math.exp(-x * x);
  return x >= 0 ? y : -y;
}

/**
 * Exact two-sided p-value of the signed-rank statistic, given the observed
 * ranks. Under the null each rank is in W+ or not with probability ½, so the
 * distribution of W+ is built rank by rank over the reachable sums. Ranks are
 * passed doubled, which turns the midranks of tied values (x.5) into integers.
 */
function wilcoxonExactP(doubledRanks: number[], doubledWPlus: number): number {
  const max = doubledRanks.reduce((a, b) => a + b, 0);
  const prob = new Float64Array(max + 1);
  prob[0] = 1;
  for (const rank of doubledRanks) {
    for (let s = max; s >= 0; s--) prob[s] = 0.5 * prob[s]! + (s >= rank ? 0.5 * prob[s - rank]! : 0);
  }
  let lower = 0; // P(W+ ≤ observed)
  let upper = 0; // P(W+ ≥ observed)
  for (let s = 0; s <= max; s++) {
    if (s <= doubledWPlus) lower += prob[s]!;
    if (s >= doubledWPlus) upper += prob[s]!;
  }
  return Math.min(1, 2 * Math.min(lower, upper));
}

/** Largest number of non-zero differences for which the exact distribution is built (its size grows with n²). */
const WILCOXON_EXACT_MAX_N = 300;

export interface WilcoxonResult {
  /** Non-zero differences the test ran on. */
  n: number;
  /** W+ (R's `V`): the sum of the ranks of the positive differences. */
  statistic: number;
  p: number;
  /** Signed matched-pairs rank-biserial r = (W+ − W−)/(W+ + W−), −1..1. */
  r: number;
  method: "exact" | "normal";
}

/**
 * Wilcoxon signed-rank test. Zero differences are dropped (Wilcoxon's rule) and
 * tied absolute differences share their mean rank. The p-value is exact for up
 * to 300 non-zero differences, with or without ties; beyond that it is the
 * normal approximation with a continuity correction and the tie correction
 * Σ(t³−t)/48 in the variance.
 */
export function wilcoxon(diffs: number[]): WilcoxonResult {
  const nonzero = diffs.filter((d) => d !== 0);
  const n = nonzero.length;
  if (n === 0) return { n: 0, statistic: 0, p: 1, r: 0, method: "exact" };

  const ranked = nonzero
    .map((d) => ({ abs: Math.abs(d), sign: Math.sign(d) }))
    .sort((x, y) => x.abs - y.abs);
  // Doubled mean ranks for ties (integers); tie-group sizes for the variance correction.
  const doubled = new Array<number>(n);
  let tieTerm = 0;
  for (let i = 0; i < n; ) {
    let j = i;
    while (j < n && ranked[j]!.abs === ranked[i]!.abs) j++;
    for (let k = i; k < j; k++) doubled[k] = i + 1 + j; // 2 × mean of the 1-based ranks i+1..j
    tieTerm += (j - i) ** 3 - (j - i);
    i = j;
  }
  let doubledWPlus = 0;
  for (let i = 0; i < n; i++) if (ranked[i]!.sign > 0) doubledWPlus += doubled[i]!;
  const wPlus = doubledWPlus / 2;
  const total = (n * (n + 1)) / 2;
  const r = (wPlus - (total - wPlus)) / total;

  if (n <= WILCOXON_EXACT_MAX_N) {
    return { n, statistic: wPlus, p: roundP(wilcoxonExactP(doubled, doubledWPlus)), r: round(r), method: "exact" };
  }
  const meanW = total / 2;
  const sdW = Math.sqrt((n * (n + 1) * (2 * n + 1)) / 24 - tieTerm / 48);
  const cc = Math.sign(wPlus - meanW) * 0.5; // continuity correction
  const z = sdW === 0 ? 0 : (wPlus - meanW - cc) / sdW;
  const p = sdW === 0 ? 1 : 2 * (1 - normalCDF(Math.abs(z)));
  return { n, statistic: wPlus, p: roundP(Math.min(1, p)), r: round(r), method: "normal" };
}

/**
 * Holm–Bonferroni adjusted p-values (step-down, monotone, capped at 1), returned
 * in the input order. NaN inputs stay NaN and don't count toward the family size.
 */
export function holm(pValues: number[]): number[] {
  const idx = pValues.map((p, i) => ({ p, i })).filter((x) => Number.isFinite(x.p)).sort((a, b) => a.p - b.p);
  const m = idx.length;
  const out = pValues.map(() => Number.NaN);
  let running = 0;
  idx.forEach(({ p, i }, k) => {
    running = Math.max(running, Math.min(1, (m - k) * p));
    out[i] = running;
  });
  return out;
}

// ─── Paired comparison ──────────────────────────────────────────

export interface PairedResult {
  /** Pairs compared. */
  n: number;
  /** Pairs whose difference is not zero: the ones the test ranks. */
  n_nonzero: number;
  meanA: number;
  meanB: number;
  /** mean(A − B); positive means A scores higher. */
  meanDiff: number;
  test: "wilcoxon";
  /** How p_value was computed: the exact signed-rank distribution, or (over 300 non-zero pairs) the normal approximation. */
  p_method: "exact" | "normal";
  /** W+, the sum of the ranks of the positive differences. */
  statistic: number;
  p_value: number;
  /** Signed matched-pairs rank-biserial r (−1..1). */
  effect_size: number;
  /** 95% interval of the mean difference; null when it can't be computed. */
  ci_95: [number, number] | null;
  ci_method: "bootstrap-percentile";
}

/**
 * Compare two aligned paired samples (A vs B): Wilcoxon signed-rank test on the
 * differences and a percentile-bootstrap 95% interval for their mean. Returns
 * null with fewer than 2 pairs.
 */
export function comparePaired(a: number[], b: number[], opts: BootstrapOptions = {}): PairedResult | null {
  const n = Math.min(a.length, b.length);
  if (n < 2) return null;
  const diffs: number[] = [];
  for (let i = 0; i < n; i++) diffs.push(a[i]! - b[i]!);
  const w = wilcoxon(diffs);
  return {
    n,
    n_nonzero: w.n,
    meanA: round(mean(a.slice(0, n))),
    meanB: round(mean(b.slice(0, n))),
    meanDiff: round(mean(diffs)),
    test: "wilcoxon",
    p_method: w.method,
    statistic: w.statistic,
    p_value: w.p,
    effect_size: w.r,
    ci_95: bootstrapMeanCI(diffs, opts),
    ci_method: "bootstrap-percentile",
  };
}

function round(x: number, dp = 4): number {
  const f = 10 ** dp;
  return Math.round(x * f) / f;
}

/**
 * A p-value rounded to 6 decimals, except that a positive one that would round to 0 is kept as it is:
 * rounding turned the exact p of 86 differing queries (about 1e-23) into 0, and "p=0" is not a p-value.
 * Every other p-value is stored as before.
 */
export function roundP(p: number): number {
  const r = round(p, 6);
  return r === 0 && p > 0 ? p : r;
}
