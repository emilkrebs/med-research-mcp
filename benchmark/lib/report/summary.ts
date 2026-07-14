/**
 * Aggregate `ScoreRow[]` into `summary.json` (means, SDs, fabrication rates, and
 * paired significance tests) and a Markdown version for the README.
 *
 * Significance tests pair on (query, run) within a model, so mcp is compared
 * against web/closed-book on matched observations, exactly as `comparePaired`
 * expects (spec §"summary.json").
 */

import type { ConditionId, ScoreRow } from "../types.js";
import { CONDITIONS } from "../config.js";
import { mean, sd, comparePaired, type PairedResult } from "../stats.js";

const CONDITION_ORDER: ConditionId[] = ["closed-book", "web-search", "mcp"];

interface Stat {
  mean: number;
  sd: number;
}

interface ConditionSummary {
  n: number;
  composite: Stat;
  accuracy: Stat;
  evidence_quality: Stat;
  bullshit: Stat;
  speed_s: Stat;
  /** Fraction of all cited PMIDs that don't exist in PubMed. */
  fabrication_rate: number;
  /** Fraction of bullshit queries correctly rejected; null when none were run. */
  correct_rejection_rate: number | null;
}

export interface SummaryMeta {
  timestamp: string;
  mcp_version: string;
  mcp_commit: string;
  models: string[];
  conditions: ConditionId[];
  runs: number;
  total_responses: number;
  weights: Record<string, number>;
  normalization: Record<string, number>;
  unverified_queries: string[];
  overrides_applied?: number;
  overrides_excluded?: number;
}

export interface Summary {
  _meta: SummaryMeta;
  [modelOrTests: string]: unknown;
}

const round = (x: number, dp = 4): number => Math.round(x * 10 ** dp) / 10 ** dp;
const stat = (xs: number[]): Stat => ({ mean: round(mean(xs)), sd: round(sd(xs)) });

function summarizeCondition(rows: ScoreRow[]): ConditionSummary {
  const cited = rows.reduce((s, r) => s + r.pmids_cited, 0);
  const fabricated = rows.reduce((s, r) => s + r.pmids_fabricated, 0);
  const bullshitRows = rows.filter((r) => r.category === "bullshit");
  return {
    n: rows.length,
    composite: stat(rows.map((r) => r.composite)),
    accuracy: stat(rows.map((r) => r.accuracy)),
    evidence_quality: stat(rows.map((r) => r.evidence_quality)),
    bullshit: stat(rows.map((r) => r.bullshit_score)),
    speed_s: stat(rows.map((r) => r.speed_s)),
    fabrication_rate: cited > 0 ? round(fabricated / cited) : 0,
    correct_rejection_rate: bullshitRows.length > 0 ? round(mean(bullshitRows.map((r) => r.bullshit_score))) : null,
  };
}

/** Composite values keyed by (query|run) for one model+condition — the pairing key. */
function compositeByPair(rows: ScoreRow[], model: string, condition: ConditionId): Map<string, number> {
  const map = new Map<string, number>();
  for (const r of rows) {
    if (r.model === model && r.condition === condition) map.set(`${r.query_id}|${r.run}`, r.composite);
  }
  return map;
}

/** Align mcp vs `other` on shared (query|run) keys and run the paired test. */
function pairedTest(rows: ScoreRow[], model: string, other: ConditionId): PairedResult | null {
  const mcp = compositeByPair(rows, model, "mcp");
  const base = compositeByPair(rows, model, other);
  const a: number[] = [];
  const b: number[] = [];
  for (const [key, value] of mcp) {
    const paired = base.get(key);
    if (paired !== undefined) {
      a.push(value);
      b.push(paired);
    }
  }
  return comparePaired(a, b);
}

export function buildSummary(rows: ScoreRow[], meta: SummaryMeta): Summary {
  const summary: Summary = { _meta: meta };

  for (const model of meta.models) {
    const perCondition: Record<string, ConditionSummary> = {};
    for (const condition of meta.conditions) {
      const subset = rows.filter((r) => r.model === model && r.condition === condition);
      if (subset.length > 0) perCondition[condition] = summarizeCondition(subset);
    }
    summary[model] = perCondition;
  }

  const tests: Record<string, unknown> = {};
  for (const model of meta.models) {
    const mcpRows = rows.some((r) => r.model === model && r.condition === "mcp");
    tests[model] = {
      composite_mcp_vs_web: mcpRows && meta.conditions.includes("web-search") ? pairedTest(rows, model, "web-search") : null,
      composite_mcp_vs_closed: mcpRows && meta.conditions.includes("closed-book") ? pairedTest(rows, model, "closed-book") : null,
    };
  }
  summary.statistical_tests = tests;

  return summary;
}

// ─── Markdown rendering ─────────────────────────────────────────

function fmt(s: Stat): string {
  return `${s.mean.toFixed(2)} ± ${s.sd.toFixed(2)}`;
}

function conditionTable(perCondition: Record<string, ConditionSummary>): string {
  const header =
    "| Condition | n | Composite | Accuracy | Evidence (0–5) | Bullshit (0–1) | Speed (s) | Fabrication rate |\n" +
    "|---|---|--:|--:|--:|--:|--:|--:|";
  const rows = Object.keys(perCondition).map((c) => {
    const s = perCondition[c]!;
    return `| ${c} | ${s.n} | ${fmt(s.composite)} | ${fmt(s.accuracy)} | ${fmt(s.evidence_quality)} | ${fmt(
      s.bullshit,
    )} | ${fmt(s.speed_s)} | ${(s.fabrication_rate * 100).toFixed(1)}% |`;
  });
  return [header, ...rows].join("\n");
}

function testLine(label: string, r: PairedResult | null): string {
  if (!r) return `- **${label}**: not enough paired data`;
  const sig = r.p_value < 0.05 ? "✅" : "—";
  return (
    `- **${label}** ${sig}: mcp ${r.meanA.toFixed(2)} vs ${r.meanB.toFixed(2)} ` +
    `(Δ=${r.meanDiff.toFixed(2)}, ${r.test}, p=${r.p_value.toPrecision(2)}, ` +
    `d=${r.effect_size.toFixed(2)}, 95% CI [${r.ci_95[0].toFixed(2)}, ${r.ci_95[1].toFixed(2)}])`
  );
}

export function toMarkdown(summary: Summary): string {
  const meta = summary._meta;
  const parts: string[] = [];
  parts.push(`# med-research-mcp benchmark — ${meta.timestamp}`);
  parts.push(
    `${meta.total_responses} responses · ${meta.models.length} model(s) · ` +
      `${meta.conditions.length} condition(s) · ${meta.runs} run(s)/query. ` +
      `Conditions: ${Object.entries(CONDITIONS)
        .map(([l, c]) => `${l}=${c}`)
        .join(", ")}.`,
  );

  if (meta.unverified_queries.length > 0) {
    parts.push(
      `> ⚠️ **${meta.unverified_queries.length} queries have unverified answer keys** ` +
        `(${meta.unverified_queries.join(", ")}). Their scores are indicative only — review the keys before publishing.`,
    );
  }

  for (const model of meta.models) {
    parts.push(`## ${model}`);
    parts.push(conditionTable(summary[model] as Record<string, ConditionSummary>));
  }

  const hasBaselineComparison =
    meta.conditions.includes("mcp") &&
    (meta.conditions.includes("web-search") || meta.conditions.includes("closed-book"));

  if (hasBaselineComparison) {
    parts.push(`## Significance (composite, paired on query×run)`);
    const tests = summary.statistical_tests as Record<string, { composite_mcp_vs_web: PairedResult | null; composite_mcp_vs_closed: PairedResult | null }>;
    for (const model of meta.models) {
      parts.push(`**${model}**`);
      parts.push(testLine("mcp vs web-search", tests[model]!.composite_mcp_vs_web));
      parts.push(testLine("mcp vs closed-book", tests[model]!.composite_mcp_vs_closed));
    }
  }

  return parts.join("\n\n") + "\n";
}
