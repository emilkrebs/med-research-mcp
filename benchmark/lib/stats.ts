/**
 * Self-contained statistics for the paper tables: descriptive stats, paired
 * t-test (exact Student-t p via the regularized incomplete beta), Wilcoxon
 * signed-rank (normal approximation) as the non-normal fallback, Cohen's d, and
 * 95% confidence intervals. No numeric-library dependency.
 *
 * Test choice (spec §"Statistical tests: paired t-test or Wilcoxon depending on
 * normality"): a lightweight skewness/size heuristic on the paired differences
 * picks paired-t for roughly-normal, well-sized samples and Wilcoxon otherwise.
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

// ─── Special functions ──────────────────────────────────────────

function gammln(x: number): number {
  const cof = [
    76.18009172947146, -86.50532032941677, 24.01409824083091, -1.231739572450155, 0.1208650973866179e-2,
    -0.5395239384953e-5,
  ];
  let y = x;
  const tmp = x + 5.5 - (x + 0.5) * Math.log(x + 5.5);
  let ser = 1.000000000190015;
  for (const c of cof) ser += c / ++y;
  return -tmp + Math.log((2.5066282746310005 * ser) / x);
}

function betacf(a: number, b: number, x: number): number {
  const EPS = 3e-12;
  const FPMIN = 1e-300;
  const qab = a + b;
  const qap = a + 1;
  const qam = a - 1;
  let c = 1;
  let d = 1 - (qab * x) / qap;
  if (Math.abs(d) < FPMIN) d = FPMIN;
  d = 1 / d;
  let h = d;
  for (let m = 1; m <= 200; m++) {
    const m2 = 2 * m;
    let aa = (m * (b - m) * x) / ((qam + m2) * (a + m2));
    d = 1 + aa * d;
    if (Math.abs(d) < FPMIN) d = FPMIN;
    c = 1 + aa / c;
    if (Math.abs(c) < FPMIN) c = FPMIN;
    d = 1 / d;
    h *= d * c;
    aa = (-(a + m) * (qab + m) * x) / ((a + m2) * (qap + m2));
    d = 1 + aa * d;
    if (Math.abs(d) < FPMIN) d = FPMIN;
    c = 1 + aa / c;
    if (Math.abs(c) < FPMIN) c = FPMIN;
    d = 1 / d;
    const del = d * c;
    h *= del;
    if (Math.abs(del - 1) < EPS) break;
  }
  return h;
}

/** Regularized incomplete beta I_x(a,b). */
function betai(a: number, b: number, x: number): number {
  if (x <= 0) return 0;
  if (x >= 1) return 1;
  const bt = Math.exp(gammln(a + b) - gammln(a) - gammln(b) + a * Math.log(x) + b * Math.log(1 - x));
  return x < (a + 1) / (a + b + 2) ? (bt * betacf(a, b, x)) / a : 1 - (bt * betacf(b, a, 1 - x)) / b;
}

/** Student-t CDF, P(T ≤ t) with `df` degrees of freedom. */
function tCDF(t: number, df: number): number {
  const ib = 0.5 * betai(df / 2, 0.5, df / (df + t * t));
  return t > 0 ? 1 - ib : ib;
}

/** Two-tailed p-value for a t statistic. */
function tTwoTailedP(t: number, df: number): number {
  return betai(df / 2, 0.5, df / (df + t * t));
}

/** Critical t for a two-tailed CI at the given confidence, via bisection on the CDF. */
function tCritical(confidence: number, df: number): number {
  const target = 1 - (1 - confidence) / 2; // e.g. 0.975 for 95%
  let lo = 0;
  let hi = 1000;
  for (let i = 0; i < 200; i++) {
    const mid = (lo + hi) / 2;
    if (tCDF(mid, df) < target) lo = mid;
    else hi = mid;
  }
  return (lo + hi) / 2;
}

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

// ─── Normality heuristic ────────────────────────────────────────

/** Rough normality flag: enough data and not badly skewed. */
function looksNormal(xs: number[]): boolean {
  const n = xs.length;
  if (n < 8) return false;
  const m = mean(xs);
  const s = Math.sqrt(xs.reduce((a, b) => a + (b - m) ** 2, 0) / n); // population sd
  if (s === 0) return true;
  const g1 = xs.reduce((a, b) => a + ((b - m) / s) ** 3, 0) / n;
  return Math.abs(g1) < 1;
}

// ─── Paired comparison ──────────────────────────────────────────

export interface PairedResult {
  n: number;
  meanA: number;
  meanB: number;
  /** mean(A − B); positive means A scores higher. */
  meanDiff: number;
  test: "paired-t" | "wilcoxon";
  /** t (paired-t) or z (wilcoxon). */
  statistic: number;
  p_value: number;
  /** Cohen's dz for paired-t, matched-pairs rank-biserial r for wilcoxon. */
  effect_size: number;
  ci_95: [number, number];
  test_reason: string;
}

/** Paired t-test on aligned samples a[i], b[i]. */
function pairedT(diffs: number[]): { statistic: number; p: number; dz: number; ci: [number, number] } {
  const n = diffs.length;
  const md = mean(diffs);
  const s = sd(diffs);
  const se = s / Math.sqrt(n);
  const df = n - 1;
  const t = se === 0 ? 0 : md / se;
  const p = se === 0 ? 1 : tTwoTailedP(t, df);
  const dz = s === 0 ? 0 : md / s;
  const tc = tCritical(0.95, df);
  const ci: [number, number] = [round(md - tc * se), round(md + tc * se)];
  return { statistic: round(t), p: round(p, 6), dz: round(dz), ci };
}

/** Wilcoxon signed-rank (normal approximation with continuity correction). */
function wilcoxon(diffs: number[]): { statistic: number; p: number; r: number } {
  const nonzero = diffs.filter((d) => d !== 0);
  const n = nonzero.length;
  if (n === 0) return { statistic: 0, p: 1, r: 0 };

  const ranked = nonzero
    .map((d) => ({ abs: Math.abs(d), sign: Math.sign(d) }))
    .sort((x, y) => x.abs - y.abs);
  // Average ranks for ties.
  const ranks = new Array<number>(n);
  for (let i = 0; i < n; ) {
    let j = i;
    while (j < n && ranked[j]!.abs === ranked[i]!.abs) j++;
    const avg = (i + 1 + j) / 2; // ranks are 1-based: mean of i+1..j
    for (let k = i; k < j; k++) ranks[k] = avg;
    i = j;
  }
  let wPlus = 0;
  for (let i = 0; i < n; i++) if (ranked[i]!.sign > 0) wPlus += ranks[i]!;

  const meanW = (n * (n + 1)) / 4;
  const sdW = Math.sqrt((n * (n + 1) * (2 * n + 1)) / 24);
  const cc = Math.sign(wPlus - meanW) * 0.5; // continuity correction
  const z = sdW === 0 ? 0 : (wPlus - meanW - cc) / sdW;
  const p = 2 * (1 - normalCDF(Math.abs(z)));
  const r = Math.abs(z) / Math.sqrt(n); // rank-biserial-style effect size
  return { statistic: round(z), p: round(Math.min(1, p), 6), r: round(r) };
}

/**
 * Compare two aligned paired samples (A vs B). Picks paired-t or Wilcoxon by a
 * normality heuristic on the differences. Returns null when fewer than 2 pairs.
 */
export function comparePaired(a: number[], b: number[]): PairedResult | null {
  const n = Math.min(a.length, b.length);
  if (n < 2) return null;
  const diffs: number[] = [];
  for (let i = 0; i < n; i++) diffs.push(a[i]! - b[i]!);

  const normal = looksNormal(diffs);
  if (normal) {
    const { statistic, p, dz, ci } = pairedT(diffs);
    return {
      n,
      meanA: round(mean(a.slice(0, n))),
      meanB: round(mean(b.slice(0, n))),
      meanDiff: round(mean(diffs)),
      test: "paired-t",
      statistic,
      p_value: p,
      effect_size: dz,
      ci_95: ci,
      test_reason: `n=${n}, differences ~normal (|skew|<1)`,
    };
  }
  const { statistic, p, r } = wilcoxon(diffs);
  // CI on the mean difference is still reported (t-based) as a convenience.
  const { ci } = pairedT(diffs);
  return {
    n,
    meanA: round(mean(a.slice(0, n))),
    meanB: round(mean(b.slice(0, n))),
    meanDiff: round(mean(diffs)),
    test: "wilcoxon",
    statistic,
    p_value: p,
    effect_size: r,
    ci_95: ci,
    test_reason: n < 8 ? `n=${n} < 8` : "differences non-normal (|skew|≥1)",
  };
}

function round(x: number, dp = 4): number {
  const f = 10 ** dp;
  return Math.round(x * f) / f;
}
