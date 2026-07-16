/**
 * Human score overrides — the correction layer between raw scores and published
 * results. Each run keeps its own `<results-dir>/overrides.json` (seeded next to
 * its `raw/` files with an inline `_example`, or a shared path passed via
 * `--overrides`); overrides are applied deterministically on every rescore.
 *
 * A wildcard (`"*"` for condition/model/run) matches every row with that queryId.
 * Setting a dimension to `null` excludes that specific score from aggregation
 * (treats it as missing / unscored).
 *
 * The `reason` field is mandatory: an override without a rationale is rejected.
 */

import { readFile } from "node:fs/promises";
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

export function parseOverrides(raw: string): OverridesFile {
  const parsed = JSON.parse(raw) as OverridesFile;
  if (!parsed || typeof parsed !== "object") {
    throw new Error("overrides.json: expected an object");
  }
  if (!Array.isArray(parsed.overrides)) {
    throw new Error("overrides.json: `overrides` must be an array");
  }

  const validConditions = ["closed-book", "web-search", "mcp", "*"] as const;
  for (const [i, o] of parsed.overrides.entries()) {
    if (!o.queryId || typeof o.queryId !== "string") {
      throw new Error(`overrides[${i}]: missing or invalid queryId`);
    }
    if (o.condition && !(validConditions as readonly string[]).includes(o.condition)) {
      throw new Error(`overrides[${i}]: invalid condition "${o.condition}"`);
    }
    if (!o.reason || typeof o.reason !== "string") {
      throw new Error(`overrides[${i}]: reason is mandatory (queryId="${o.queryId}")`);
    }

    const dims: ("accuracy" | "evidence_quality" | "bullshit_score" | "composite")[] =
      ["accuracy", "evidence_quality", "bullshit_score", "composite"];
    for (const dim of dims) {
      const v = o[dim];
      if (v !== undefined && v !== null && typeof v !== "number") {
        throw new Error(`overrides[${i}]: ${dim} must be a number or null (got ${typeof v})`);
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

export interface OverrideAppResult {
  rows: ScoreRow[];
  /** Map of `${queryId}|${condition}|${model}|${run}` → override metadata for the breakdown. */
  applied: Map<string, { reason: string; author?: string }>;
  /** Rows that were excluded (set to null) from aggregation. */
  excluded: string[];
  /** Warnings: e.g. stale overrides due to answer key version mismatch. */
  warnings: string[];
}

export function applyOverrides(
  raw: RawRowWithBreakdown[],
  overrides: OverridesFile | null,
  queryByVersion: Map<string, number>,
): OverrideAppResult {
  const rows = raw.map((r) => ({ ...r.row }));
  const applied = new Map<string, { reason: string; author?: string }>();
  const excluded: string[] = [];
  const warnings: string[] = [];

  if (!overrides || overrides.overrides.length === 0) {
    return { rows, applied, excluded, warnings };
  }

  for (const o of overrides.overrides) {
    const rawMatches = raw.filter((r) => matches(o, r.row));
    if (rawMatches.length === 0) {
      warnings.push(`override for queryId="${o.queryId}" matched no rows`);
      continue;
    }

    for (const match of rawMatches) {
      const key = `${match.row.query_id}|${match.row.condition}|${match.row.model}|${match.row.run}`;
      const currentVersion = queryByVersion.get(match.row.query_id);
      const scoredVersion = match.breakdown.answerKeyVersion;

      if (currentVersion !== undefined && scoredVersion !== undefined && currentVersion !== scoredVersion) {
        warnings.push(
          `override for ${key}: answer key version mismatch (key=v${currentVersion}, scored with v${scoredVersion}) — override may be stale`,
        );
      }

      const rowIdx = rows.findIndex(
        (r) =>
          r.query_id === match.row.query_id &&
          r.condition === match.row.condition &&
          r.model === match.row.model &&
          r.run === match.row.run,
      );
      if (rowIdx < 0) continue;
      const target = rows[rowIdx]!;

      const dims: ("accuracy" | "evidence_quality" | "bullshit_score" | "composite")[] =
        ["accuracy", "evidence_quality", "bullshit_score", "composite"];
      for (const dim of dims) {
        const v = o[dim];
        if (v === null) {
          target[dim] = Number.NaN;
          excluded.push(`${key}:${dim}`);
        } else if (typeof v === "number") {
          target[dim] = v;
        }
      }

      applied.set(key, { reason: o.reason, author: o.author });
    }
  }

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
