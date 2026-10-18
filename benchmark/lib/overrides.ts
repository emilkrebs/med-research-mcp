/**
 * Human score overrides — the correction layer between raw scores and published
 * results. Each run keeps its own `<results-dir>/overrides.json` (seeded next to
 * its `raw/` files with an inline `_example`, or a shared path passed via
 * `--overrides`); overrides are applied deterministically on every rescore.
 *
 * A wildcard (`"*"` for condition/model/run) matches every row with that queryId.
 * Setting a dimension to `null` excludes that specific score from aggregation
 * (treats it as missing / unscored). Overriding a component recomputes the
 * row's composite unless the override sets `composite` itself. Several graders
 * may score the same row (distinct `author`s); their values are averaged.
 *
 * The `reason` field is mandatory: an override without a rationale is rejected.
 */

import { readFile } from "node:fs/promises";
import { compositeForCategory } from "./scoring/composite.js";
import type {
  ConditionId,
  OverridesFile,
  ScoreOverride,
  ScoreRow,
  ScoreBreakdown,
  BenchmarkQuery,
} from "./types.js";

export interface RawRowWithBreakdown {
  filename: string;
  row: ScoreRow;
  breakdown: ScoreBreakdown;
  record: Record<string, unknown>;
}

type Dim = "accuracy" | "evidence_quality" | "bullshit_score" | "composite";
const DIMS: Dim[] = ["accuracy", "evidence_quality", "bullshit_score", "composite"];

/** Inclusive valid range per dimension. */
const RANGES: Record<Dim, [number, number]> = {
  accuracy: [0, 10],
  evidence_quality: [0, 5],
  bullshit_score: [0, 1],
  composite: [0, 10],
};

export function parseOverrides(raw: string): OverridesFile {
  const parsed = JSON.parse(raw) as OverridesFile;
  if (!parsed || typeof parsed !== "object") {
    throw new Error("overrides.json: expected an object");
  }
  if (!Array.isArray(parsed.overrides)) {
    throw new Error("overrides.json: `overrides` must be an array");
  }

  const validConditions = ["closed-book", "web-search", "mcp", "mcp-skill", "*"] as const;
  for (const [i, o] of parsed.overrides.entries()) {
    if (!o.queryId || typeof o.queryId !== "string") {
      throw new Error(`overrides[${i}]: missing or invalid queryId`);
    }
    if (!o.condition || !(validConditions as readonly string[]).includes(o.condition)) {
      throw new Error(`overrides[${i}]: invalid condition "${String(o.condition)}"`);
    }
    if (typeof o.model !== "string" || o.model === "") {
      throw new Error(`overrides[${i}]: model must be a non-empty string or "*" (queryId="${o.queryId}")`);
    }
    if (o.run !== "*" && !(typeof o.run === "number" && Number.isInteger(o.run) && o.run > 0)) {
      throw new Error(`overrides[${i}]: run must be a positive integer or "*" (got ${JSON.stringify(o.run)})`);
    }
    if (o.author !== undefined && typeof o.author !== "string") {
      throw new Error(`overrides[${i}]: author must be a string (got ${typeof o.author})`);
    }
    if (!o.reason || typeof o.reason !== "string") {
      throw new Error(`overrides[${i}]: reason is mandatory (queryId="${o.queryId}")`);
    }

    for (const dim of DIMS) {
      const v = o[dim];
      if (v === undefined || v === null) continue;
      if (typeof v !== "number" || Number.isNaN(v)) {
        throw new Error(`overrides[${i}]: ${dim} must be a number or null (got ${typeof v})`);
      }
      const [lo, hi] = RANGES[dim];
      if (v < lo || v > hi) {
        throw new Error(`overrides[${i}]: ${dim} must be in [${lo}, ${hi}] (got ${v})`);
      }
    }
  }
  return parsed;
}

export async function loadOverrides(path: string): Promise<OverridesFile | null> {
  try {
    const raw = await readFile(path, "utf-8");
    return parseOverrides(raw);
  } catch (err: unknown) {
    if ((err as { code?: string })?.code === "ENOENT") return null;
    throw err;
  }
}

function matches(override: ScoreOverride, row: ScoreRow): boolean {
  if (override.queryId !== row.query_id) return false;
  if (override.condition !== "*" && override.condition !== row.condition) return false;
  if (override.model !== "*" && override.model !== row.model) return false;
  if (override.run !== "*" && override.run !== row.run) return false;
  return true;
}

const isWildcard = (o: ScoreOverride): boolean => o.condition === "*" || o.model === "*" || o.run === "*";

const rowKey = (r: ScoreRow): string => `${r.query_id}|${r.condition}|${r.model}|${r.run}`;

export interface AppliedOverride {
  /** Reason of the last entry applied to the row. */
  reason: string;
  /** Author of the last entry applied (legacy convenience). */
  author?: string;
  /** Distinct authors of every entry applied to the row ("anonymous" for entries without one). */
  authors: string[];
}

export interface OverrideAppResult {
  rows: ScoreRow[];
  /** Map of `${queryId}|${condition}|${model}|${run}` → override metadata for the breakdown. */
  applied: Map<string, AppliedOverride>;
  /** Rows that were excluded (set to null) from aggregation. */
  excluded: string[];
  /** Warnings: e.g. stale overrides due to answer key version mismatch. */
  warnings: string[];
}

/**
 * Resolve one dimension across the entries matching a row. Wildcard entries are
 * applied first in file order (last wins); exact entries then take precedence:
 * the last value per author, averaged across distinct authors (entries without
 * an author count as one anonymous grader). Numeric values win over `null`
 * among exact graders; all-null yields null. `undefined` = not overridden.
 */
function resolveDim(wild: ScoreOverride[], exact: ScoreOverride[], dim: Dim): number | null | undefined {
  let value: number | null | undefined;
  for (const o of wild) if (o[dim] !== undefined) value = o[dim];

  const perAuthor = new Map<string, number | null>();
  for (const o of exact) {
    if (o[dim] !== undefined) perAuthor.set(o.author ?? "\u0000anonymous", o[dim]!);
  }
  if (perAuthor.size > 0) {
    const nums = [...perAuthor.values()].filter((v): v is number => typeof v === "number");
    value = nums.length > 0 ? nums.reduce((a, b) => a + b, 0) / nums.length : null;
  }
  return value;
}

/**
 * Apply overrides to scored rows. After a component (accuracy / evidence /
 * bullshit) is overridden, the composite is recomputed via `compositeForCategory`
 * unless an override sets `composite` explicitly. A `null` component becomes NaN
 * ("unscored"): a NaN accuracy or bullshit score makes a recomputed composite NaN
 * too, while a NaN evidence score drops that term (see `composite`). Any numeric accuracy
 * override marks the row's `accuracy_source` as `human`.
 */
export function applyOverrides(
  raw: RawRowWithBreakdown[],
  overrides: OverridesFile | null,
  queryByVersion: Map<string, number>,
): OverrideAppResult {
  const rows = raw.map((r) => ({ ...r.row }));
  const applied = new Map<string, AppliedOverride>();
  const excluded: string[] = [];
  const warnings: string[] = [];

  if (!overrides || overrides.overrides.length === 0) {
    return { rows, applied, excluded, warnings };
  }

  // Entries that match nothing are worth a warning (typo in queryId/model/run).
  for (const o of overrides.overrides) {
    if (!raw.some((r) => matches(o, r.row))) {
      warnings.push(`override for queryId="${o.queryId}" matched no rows`);
    }
  }

  raw.forEach((match, idx) => {
    const entries = overrides.overrides.filter((o) => matches(o, match.row));
    if (entries.length === 0) return;
    const key = rowKey(match.row);
    const target = rows[idx]!;

    const currentVersion = queryByVersion.get(match.row.query_id);
    const scoredVersion = match.breakdown.answerKeyVersion;
    if (currentVersion !== undefined && scoredVersion !== undefined && currentVersion !== scoredVersion) {
      warnings.push(
        `override for ${key}: answer key version mismatch (key=v${currentVersion}, scored with v${scoredVersion}) — override may be stale`,
      );
    }

    const wild = entries.filter(isWildcard);
    const exact = entries.filter((o) => !isWildcard(o));
    const resolved = {} as Record<Dim, number | null | undefined>;
    for (const dim of DIMS) {
      const v = resolveDim(wild, exact, dim);
      resolved[dim] = v;
      if (v === null) {
        target[dim] = Number.NaN;
        excluded.push(`${key}:${dim}`);
      } else if (typeof v === "number") {
        target[dim] = v;
      }
    }

    if (typeof resolved.accuracy === "number") target.accuracy_source = "human";

    // An explicit composite wins; otherwise a changed component forces a recompute.
    if (resolved.composite === undefined) {
      const componentChanged =
        resolved.accuracy !== undefined || resolved.evidence_quality !== undefined || resolved.bullshit_score !== undefined;
      if (componentChanged) {
        target.composite = compositeForCategory(target.category, {
          accuracy: target.accuracy,
          evidenceQuality: target.evidence_quality,
          bullshitScore: target.bullshit_score,
          speedS: target.speed_s,
          totalTokens: target.total_tokens,
        });
      }
    }

    const authors = [...new Set(entries.map((o) => o.author ?? "anonymous"))];
    const last = entries[entries.length - 1]!;
    applied.set(key, { reason: last.reason, author: last.author, authors });
  });

  return { rows, applied, excluded, warnings };
}

export function warnStaleOverrides(
  overrides: OverridesFile,
  queries: BenchmarkQuery[],
): string[] {
  const warnings: string[] = [];
  const byId = new Map(queries.map((q) => [q.id, q] as const));
  for (let i = 0; i < overrides.overrides.length; i++) {
    const o = overrides.overrides[i]!;
    const q = byId.get(o.queryId);
    if (!q) {
      warnings.push(`overrides[${i}]: unknown queryId "${o.queryId}"`);
    }
  }
  return warnings;
}
