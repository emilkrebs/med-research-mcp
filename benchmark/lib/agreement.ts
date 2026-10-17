/**
 * Inter-rater agreement for human rubric grades.
 *
 * Input is the multi-grader override entries `grade.ts` writes (one exact-match
 * entry per grader per response). Only responses with numeric accuracy from at
 * least two distinct authors count. Statistics:
 *  - Krippendorff's alpha (interval metric) — tolerates missing ratings, so it
 *    uses every multi-rated item whatever the grader mix.
 *  - ICC(2,1) — two-way random effects, absolute agreement, single rater
 *    (Shrout & Fleiss 1979). Needs a complete items x raters table, so it is
 *    computed over items rated by the most common set of graders.
 *  - mean absolute pairwise difference, and a list of items whose graders
 *    differ by more than `threshold` points, for adjudication.
 */

import { createHash } from "node:crypto";
import type { OverridesFile, ScoreOverride } from "./types.js";

/** Items whose max-min grader spread exceeds this many points go on the adjudication list. */
export const DISAGREEMENT_THRESHOLD = 3;

/** Identity of one response, as used by override entries. */
export interface ResponseKey {
  queryId: string;
  condition: string;
  model: string;
  run: number;
}

export const responseKeyString = (k: ResponseKey): string => `${k.queryId}|${k.condition}|${k.model}|${k.run}`;

/**
 * Short opaque id for a response (8 hex chars of a SHA-256 over its identity).
 * Stable across graders and runs of grade.ts, reveals nothing about the
 * condition or model, and lets graders refer to the same item when adjudicating.
 */
export function itemIdFor(k: ResponseKey): string {
  return createHash("sha256").update(responseKeyString(k)).digest("hex").slice(0, 8);
}

/** One response with every grader's accuracy (author -> score). */
export interface RatedItem {
  itemId: string;
  key: ResponseKey;
  ratings: Map<string, number>;
}

const isExact = (o: ScoreOverride): o is ScoreOverride & { condition: string; model: string; run: number } =>
  o.condition !== "*" && o.model !== "*" && o.run !== "*";

/** Group exact-match numeric-accuracy entries by response; the last entry per author wins. Anonymous entries are ignored. */
export function collectRatings(overrides: OverridesFile): RatedItem[] {
  const items = new Map<string, RatedItem>();
  for (const o of overrides.overrides) {
    if (!isExact(o) || typeof o.accuracy !== "number" || !o.author) continue;
    const key: ResponseKey = { queryId: o.queryId, condition: o.condition, model: o.model, run: o.run };
    const id = responseKeyString(key);
    let item = items.get(id);
    if (!item) {
      item = { itemId: itemIdFor(key), key, ratings: new Map() };
      items.set(id, item);
    }
    item.ratings.set(o.author, o.accuracy);
  }
  return [...items.values()];
}

/**
 * Krippendorff's alpha. `units` is a list of rating lists (one list per item;
 * any number of raters per item, missing ratings simply absent). Items with
 * fewer than two ratings are unpairable and dropped. alpha = 1 - Do/De, where
 * Do is the observed within-item disagreement and De the disagreement expected
 * if ratings were shuffled across all items. Returns NaN when undefined (no
 * pairable items, or all ratings identical so De = 0).
 * Krippendorff (2011), "Computing Krippendorff's Alpha-Reliability".
 */
export function krippendorffAlpha(units: number[][], metric: "interval" | "nominal" = "interval"): number {
  const diff = (a: number, b: number): number => (metric === "interval" ? (a - b) ** 2 : a === b ? 0 : 1);
  const pairable = units.filter((u) => u.length >= 2);
  const n = pairable.reduce((s, u) => s + u.length, 0);
  if (n < 2) return Number.NaN;

  let observed = 0;
  for (const u of pairable) {
    let within = 0;
    for (let i = 0; i < u.length; i++) for (let j = 0; j < u.length; j++) if (i !== j) within += diff(u[i]!, u[j]!);
    observed += within / (u.length - 1);
  }
  observed /= n;

  const all = pairable.flat();
  let expected = 0;
  for (let i = 0; i < all.length; i++) for (let j = 0; j < all.length; j++) if (i !== j) expected += diff(all[i]!, all[j]!);
  expected /= n * (n - 1);

  return expected === 0 ? Number.NaN : 1 - observed / expected;
}

/**
 * ICC(2,1) from a complete table (rows = targets, columns = raters):
 * (MSR - MSE) / (MSR + (k-1) MSE + k (MSC - MSE) / n), Shrout & Fleiss (1979).
 * Needs at least 2 targets and 2 raters; NaN when the denominator is zero.
 */
export function icc21(table: number[][]): number {
  const n = table.length;
  const k = table[0]?.length ?? 0;
  if (n < 2 || k < 2) return Number.NaN;

  const grand = table.flat().reduce((a, b) => a + b, 0) / (n * k);
  const rowMeans = table.map((r) => r.reduce((a, b) => a + b, 0) / k);
  const colMeans = Array.from({ length: k }, (_, j) => table.reduce((s, r) => s + r[j]!, 0) / n);

  const ssRows = k * rowMeans.reduce((s, m) => s + (m - grand) ** 2, 0);
  const ssCols = n * colMeans.reduce((s, m) => s + (m - grand) ** 2, 0);
  const ssTotal = table.flat().reduce((s, v) => s + (v - grand) ** 2, 0);
  const ssErr = ssTotal - ssRows - ssCols;

  const msr = ssRows / (n - 1);
  const msc = ssCols / (k - 1);
  const mse = ssErr / ((n - 1) * (k - 1));
  const denom = msr + (k - 1) * mse + (k * (msc - mse)) / n;
  return denom === 0 ? Number.NaN : (msr - mse) / denom;
}

export interface Disagreement {
  itemId: string;
  queryId: string;
  /** Scores by author. */
  scores: Record<string, number>;
  spread: number;
}

export interface AgreementReport {
  /** Items with >= 2 graders. */
  itemCount: number;
  /** Distinct graders across those items. */
  graderCount: number;
  graders: string[];
  alpha: number;
  icc: number;
  /** Items / graders the ICC was computed on (the most common complete grader set). */
  iccItems: number;
  iccGraders: string[];
  /** Mean absolute difference over all grader pairs on all multi-rated items. */
  meanAbsDiff: number;
  disagreements: Disagreement[];
}

/** Compute all agreement statistics over the multi-rated items. */
export function computeAgreement(rated: RatedItem[], threshold = DISAGREEMENT_THRESHOLD): AgreementReport {
  const multi = rated.filter((i) => i.ratings.size >= 2);
  const graders = [...new Set(multi.flatMap((i) => [...i.ratings.keys()]))].sort();

  const alpha = krippendorffAlpha(multi.map((i) => [...i.ratings.values()]));

  // ICC: the most common exact grader set (ties broken alphabetically for determinism).
  const bySet = new Map<string, RatedItem[]>();
  for (const i of multi) {
    const setKey = [...i.ratings.keys()].sort().join("\u0000");
    bySet.set(setKey, [...(bySet.get(setKey) ?? []), i]);
  }
  const best = [...bySet.entries()].sort((a, b) => b[1].length - a[1].length || a[0].localeCompare(b[0]))[0];
  const iccGraders = best ? best[0].split("\u0000") : [];
  const iccTable = best ? best[1].map((i) => iccGraders.map((g) => i.ratings.get(g)!)) : [];
  const icc = icc21(iccTable);

  let diffSum = 0;
  let diffN = 0;
  const disagreements: Disagreement[] = [];
  for (const i of multi) {
    const vals = [...i.ratings.values()];
    for (let a = 0; a < vals.length; a++) {
      for (let b = a + 1; b < vals.length; b++) {
        diffSum += Math.abs(vals[a]! - vals[b]!);
        diffN++;
      }
    }
    const spread = Math.max(...vals) - Math.min(...vals);
    if (spread > threshold) {
      disagreements.push({
        itemId: i.itemId,
        queryId: i.key.queryId,
        scores: Object.fromEntries([...i.ratings.entries()].sort(([x], [y]) => x.localeCompare(y))),
        spread,
      });
    }
  }
  disagreements.sort((a, b) => b.spread - a.spread || a.itemId.localeCompare(b.itemId));

  return {
    itemCount: multi.length,
    graderCount: graders.length,
    graders,
    alpha,
    icc,
    iccItems: iccTable.length,
    iccGraders,
    meanAbsDiff: diffN > 0 ? diffSum / diffN : Number.NaN,
    disagreements,
  };
}

const fmt = (x: number): string => (Number.isNaN(x) ? "n/a" : x.toFixed(3));

/** Human-readable report for `grade.ts --agreement`. */
export function formatAgreement(r: AgreementReport, threshold = DISAGREEMENT_THRESHOLD): string {
  if (r.itemCount === 0) {
    return "No responses have numeric accuracy from 2+ distinct graders yet — nothing to compare.";
  }
  const lines = [
    `Inter-rater agreement: ${r.itemCount} item(s) rated by 2+ graders; ${r.graderCount} grader(s): ${r.graders.join(", ")}`,
    `  Krippendorff's alpha (interval): ${fmt(r.alpha)}`,
    `  ICC(2,1) absolute agreement:     ${fmt(r.icc)}  (${r.iccItems} item(s) x ${r.iccGraders.length} grader(s): ${r.iccGraders.join(", ")})`,
    `  Mean absolute difference:        ${fmt(r.meanAbsDiff)} points`,
    "",
  ];
  if (r.disagreements.length === 0) {
    lines.push(`No items differ by more than ${threshold} points.`);
  } else {
    lines.push(`${r.disagreements.length} item(s) differ by more than ${threshold} points (adjudicate):`);
    for (const d of r.disagreements) {
      const scores = Object.entries(d.scores)
        .map(([a, s]) => `${a}=${s}`)
        .join(", ");
      lines.push(`  ${d.itemId}  ${d.queryId}  ${scores}  (spread ${d.spread})`);
    }
  }
  return lines.join("\n");
}
