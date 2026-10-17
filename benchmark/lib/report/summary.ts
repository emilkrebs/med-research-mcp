/**
 * Aggregate `ScoreRow[]` into `summary.json` (means, SDs, fabrication rates, and
 * paired significance tests) and a Markdown version for the README.
 *
 * Only `status === "ok"` rows enter means and tests; failures are reported as
 * rates. Metrics are NaN-aware (overrides can mark a score unscored). The
 * temperature-0 runs of a query are near-copies, so significance tests first
 * collapse runs to a per-(model, condition, query) mean and pair mcp vs baseline
 * on `query_id` — n is the number of queries, not queries × runs. All p-values
 * in the summary are Holm-adjusted as one family.
 */

import type { Category, ConditionId, ScoreRow } from "../types.js";
import { CONDITION_LETTER } from "../config.js";
import { mean, sd, comparePaired, holm, type PairedResult } from "../stats.js";

interface Stat {
  /** Mean over finite values; null when there are none. */
  mean: number | null;
  sd: number | null;
  /** How many finite values the mean/SD are over. */
  n: number;
}

interface ConditionSummary {
  /** All rows for this model × condition, including failed ones. */
  n: number;
  /** Rows with status "ok" — the basis of every mean below. */
  n_ok: number;
  provider_error_rate: number;
  truncated_rate: number;
  scoring_error_rate: number;
  composite: Stat;
  /** Overall accuracy including provisional proxy values for ungraded rubric rows. */
  accuracy: Stat;
  /** Accuracy over deterministic + reject + human rows only (no proxy). */
  accuracy_verified: Stat;
  /** Ok rows whose accuracy is still the citation-quality proxy (not correctness). */
  accuracy_proxy_n: number;
  evidence_quality: Stat;
  bullshit: Stat;
  speed_s: Stat;
  /** Fraction of all cited PMIDs that don't exist in PubMed. */
  fabrication_rate: number;
  /** Pooled fraction of checked citations whose surrounding claim contradicts the record; null when none were checked. */
  misattribution_rate: number | null;
  /** Citations the attribution audit could check (the rate's denominator). */
  citations_checked: number;
  /** Fraction of bullshit queries correctly rejected; null when none were run. */
  correct_rejection_rate: number | null;
}

export interface SummaryMeta {
  timestamp: string;
  mcp_version: string;
  mcp_commit: string;
  benchmark_version: string;
  models: string[];
  conditions: ConditionId[];
  runs: number;
  total_responses: number;
  weights: Record<string, number>;
  normalization: Record<string, number>;
  unverified_queries: string[];
  overrides_applied?: number;
  overrides_excluded?: number;
  /** `SCORER_VERSION` the rows were scored with. */
  scorer_version?: number;
  /** Rubric responses still on the proxy accuracy; overrides the count derived from rows when set. */
  ungraded_rubric_responses?: number;
  /** Provenance of merged result directories. */
  sources?: string[];
}

/** A paired test as written to summary.json: the raw result plus the Holm-adjusted p. */
export type SummaryTest = (PairedResult & { p_value_holm: number }) | null;

export interface ModelTests {
  composite_mcp_vs_web: SummaryTest;
  composite_mcp_vs_closed: SummaryTest;
}

export interface Summary {
  _meta: SummaryMeta;
  [modelOrTests: string]: unknown;
}

const CATEGORY_ORDER: Category[] = ["factual", "drill-down", "synthesis", "edge-case", "compound", "recent", "bullshit"];

const round = (x: number, dp = 4): number => Math.round(x * 10 ** dp) / 10 ** dp;

/** Mean/SD over the finite values only. */
function stat(xs: number[]): Stat {
  const f = xs.filter((x) => Number.isFinite(x));
  if (f.length === 0) return { mean: null, sd: null, n: 0 };
  return { mean: round(mean(f)), sd: round(sd(f)), n: f.length };
}

function summarizeCondition(rows: ScoreRow[]): ConditionSummary {
  const ok = rows.filter((r) => r.status === "ok");
  const rate = (s: ScoreRow["status"]): number =>
    rows.length > 0 ? round(rows.filter((r) => r.status === s).length / rows.length) : 0;
  const cited = ok.reduce((s, r) => s + r.pmids_cited, 0);
  const fabricated = ok.reduce((s, r) => s + r.pmids_fabricated, 0);
  const checked = ok.reduce((s, r) => s + (r.citations_checked ?? 0), 0);
  const misattributed = ok.reduce((s, r) => s + (r.citations_misattributed ?? 0), 0);
  const bullshitScores = ok.filter((r) => r.category === "bullshit").map((r) => r.bullshit_score).filter(Number.isFinite);
  return {
    n: rows.length,
    n_ok: ok.length,
    provider_error_rate: rate("provider-error"),
    truncated_rate: rate("truncated"),
    scoring_error_rate: rate("scoring-error"),
    composite: stat(ok.map((r) => r.composite)),
    accuracy: stat(ok.map((r) => r.accuracy)),
    accuracy_verified: stat(ok.filter((r) => r.accuracy_source !== "proxy").map((r) => r.accuracy)),
    accuracy_proxy_n: ok.filter((r) => r.accuracy_source === "proxy" && Number.isFinite(r.accuracy)).length,
    evidence_quality: stat(ok.map((r) => r.evidence_quality)),
    bullshit: stat(ok.map((r) => r.bullshit_score)),
    speed_s: stat(ok.map((r) => r.speed_s)),
    // Pooled ratio (sum fabricated ÷ sum cited across the group), not a mean of
    // per-row ratios. report/charts.ts's fabrication-rate.svg chart (`pooledRatioBars`)
    // uses this same pooled formula so the chart and this table always agree.
    fabrication_rate: cited > 0 ? round(fabricated / cited) : 0,
    misattribution_rate: checked > 0 ? round(misattributed / checked) : null,
    citations_checked: checked,
    correct_rejection_rate: bullshitScores.length > 0 ? round(mean(bullshitScores)) : null,
  };
}

/**
 * Per-query composite for one model+condition: the mean over ok runs with a
 * finite composite. This collapses the (near-identical) repeated runs so each
 * query contributes one observation — the pairing key is `query_id`.
 */
function compositeByQuery(rows: ScoreRow[], model: string, condition: ConditionId): Map<string, number> {
  const groups = new Map<string, number[]>();
  for (const r of rows) {
    if (r.model !== model || r.condition !== condition || r.status !== "ok" || !Number.isFinite(r.composite)) continue;
    const g = groups.get(r.query_id) ?? [];
    g.push(r.composite);
    groups.set(r.query_id, g);
  }
  return new Map([...groups].map(([q, xs]) => [q, mean(xs)] as const));
}

/** Align mcp vs `other` on shared query ids and run the paired test. */
function pairedTest(rows: ScoreRow[], model: string, other: ConditionId): PairedResult | null {
  const mcp = compositeByQuery(rows, model, "mcp");
  const base = compositeByQuery(rows, model, other);
  const a: number[] = [];
  const b: number[] = [];
  for (const [query, value] of mcp) {
    const paired = base.get(query);
    if (paired !== undefined) {
      a.push(value);
      b.push(paired);
    }
  }
  return comparePaired(a, b);
}

/** Mean composite per category × condition for one model (ok rows, finite values). */
function categoryComposites(rows: ScoreRow[], model: string, conditions: ConditionId[]) {
  const out: Record<string, Record<string, Stat>> = {};
  for (const category of CATEGORY_ORDER) {
    const perCondition: Record<string, Stat> = {};
    for (const condition of conditions) {
      const xs = rows
        .filter((r) => r.model === model && r.condition === condition && r.category === category && r.status === "ok")
        .map((r) => r.composite);
      if (xs.length > 0) perCondition[condition] = stat(xs);
    }
    if (Object.keys(perCondition).length > 0) out[category] = perCondition;
  }
  return out;
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

  const categories: Record<string, unknown> = {};
  for (const model of meta.models) categories[model] = categoryComposites(rows, model, meta.conditions);
  summary.category_composite = categories;

  // Run every test first, then Holm-adjust across the whole family.
  const raw: Record<string, { web: PairedResult | null; closed: PairedResult | null }> = {};
  const all: PairedResult[] = [];
  for (const model of meta.models) {
    const hasMcp = rows.some((r) => r.model === model && r.condition === "mcp");
    const web = hasMcp && meta.conditions.includes("web-search") ? pairedTest(rows, model, "web-search") : null;
    const closed = hasMcp && meta.conditions.includes("closed-book") ? pairedTest(rows, model, "closed-book") : null;
    raw[model] = { web, closed };
    for (const t of [web, closed]) if (t) all.push(t);
  }
  const adjusted = new Map<PairedResult, number>();
  holm(all.map((t) => t.p_value)).forEach((p, i) => adjusted.set(all[i]!, round(p, 6)));
  const withHolm = (t: PairedResult | null): SummaryTest => (t ? { ...t, p_value_holm: adjusted.get(t)! } : null);

  const tests: Record<string, ModelTests> = {};
  for (const model of meta.models) {
    tests[model] = {
      composite_mcp_vs_web: withHolm(raw[model]!.web),
      composite_mcp_vs_closed: withHolm(raw[model]!.closed),
    };
  }
  summary.statistical_tests = tests;

  return summary;
}

// ─── Markdown rendering ─────────────────────────────────────────

function fmt(s: Stat): string {
  return s.mean === null || s.sd === null ? "—" : `${s.mean.toFixed(2)} ± ${s.sd.toFixed(2)}`;
}

const pct = (x: number): string => `${(x * 100).toFixed(1)}%`;

/** Compact failure-rate cell: only non-zero rates, "—" when everything succeeded. */
function failures(s: ConditionSummary): string {
  const parts: string[] = [];
  if (s.provider_error_rate > 0) parts.push(`provider-error ${pct(s.provider_error_rate)}`);
  if (s.truncated_rate > 0) parts.push(`truncated ${pct(s.truncated_rate)}`);
  if (s.scoring_error_rate > 0) parts.push(`scoring-error ${pct(s.scoring_error_rate)}`);
  return parts.length > 0 ? parts.join(", ") : "—";
}

/** "4.2% (of 96)": the pooled rate and how many citations it is over; "—" when none were checked. */
function misattributedCell(s: ConditionSummary): string {
  return s.misattribution_rate === null || s.misattribution_rate === undefined ? "—" : `${pct(s.misattribution_rate)} (of ${s.citations_checked})`;
}

function conditionTable(perCondition: Record<string, ConditionSummary>): string {
  const header =
    "| Condition | n (ok/all) | Composite | Accuracy (verified) | Evidence (0–5) | Bullshit (0–1) | Speed (s) | Fabrication rate | Misattributed | Non-ok |\n" +
    "|---|---|--:|--:|--:|--:|--:|--:|--:|--|";
  const rows = Object.keys(perCondition).map((c) => {
    const s = perCondition[c]!;
    return `| ${c} | ${s.n_ok}/${s.n} | ${fmt(s.composite)} | ${fmt(s.accuracy_verified)} | ${fmt(s.evidence_quality)} | ${fmt(
      s.bullshit,
    )} | ${fmt(s.speed_s)} | ${pct(s.fabrication_rate)} | ${misattributedCell(s)} | ${failures(s)} |`;
  });
  return [header, ...rows].join("\n");
}

/** Category × condition composite means for one model. */
function categoryTable(byCategory: Record<string, Record<string, Stat>>, conditions: ConditionId[]): string {
  const header = `| Category | ${conditions.join(" | ")} |\n|---|${conditions.map(() => "--:").join("|")}|`;
  const rows = Object.keys(byCategory).map((cat) => {
    const cells = conditions.map((c) => {
      const s = byCategory[cat]![c];
      return s && s.mean !== null ? s.mean.toFixed(2) : "—";
    });
    return `| ${cat} | ${cells.join(" | ")} |`;
  });
  return [header, ...rows].join("\n");
}

function testLine(label: string, r: SummaryTest): string {
  if (!r) return `- **${label}**: not enough paired data`;
  const sig = r.p_value_holm < 0.05 ? "✅" : "—";
  const effect = r.test === "paired-t" ? "dz" : "r_rb";
  return (
    `- **${label}** ${sig}: mcp ${r.meanA.toFixed(2)} vs ${r.meanB.toFixed(2)} ` +
    `(Δ=${r.meanDiff.toFixed(2)}, ${r.test}, n=${r.n}, p=${r.p_value.toPrecision(2)}, ` +
    `p_holm=${r.p_value_holm.toPrecision(2)}, ${effect}=${r.effect_size.toFixed(2)}, ` +
    `95% t-CI of mean Δ [${r.ci_95[0].toFixed(2)}, ${r.ci_95[1].toFixed(2)}])`
  );
}

export function toMarkdown(summary: Summary): string {
  const meta = summary._meta;
  const parts: string[] = [];
  parts.push(`# med-research-mcp benchmark — ${meta.timestamp}`);
  parts.push(
    `${meta.total_responses} responses · ${meta.models.length} model(s) · ` +
      `${meta.conditions.length} condition(s) · ${meta.runs} run(s)/query. ` +
      `Conditions: ${meta.conditions.map((c) => `${CONDITION_LETTER[c] ?? "?"}=${c}`).join(", ")}.`,
  );

  // Count proxy-accuracy rows from the summary itself unless the caller supplied a figure.
  let proxyN = 0;
  for (const model of meta.models) {
    for (const s of Object.values((summary[model] ?? {}) as Record<string, ConditionSummary>)) proxyN += s.accuracy_proxy_n;
  }
  const ungraded = meta.ungraded_rubric_responses ?? proxyN;
  if (ungraded > 0) {
    parts.push(
      `> ⚠️ **${ungraded} rubric responses not human-graded — run grade.ts, then --rescore.** ` +
        `Their accuracy is a citation-quality proxy (it measures citation tier, not correctness) and is ` +
        `excluded from the "Accuracy (verified)" column.`,
    );
  }

  if (meta.unverified_queries.length > 0) {
    parts.push(
      `> ⚠️ **${meta.unverified_queries.length} queries have unverified answer keys** ` +
        `(${meta.unverified_queries.join(", ")}). Their scores are indicative only — review the keys before publishing.`,
    );
  }

  const categories = (summary.category_composite ?? {}) as Record<string, Record<string, Record<string, Stat>>>;
  for (const model of meta.models) {
    parts.push(`## ${model}`);
    parts.push(conditionTable(summary[model] as Record<string, ConditionSummary>));
    const byCategory = categories[model];
    if (byCategory && Object.keys(byCategory).length > 0) {
      parts.push(`Composite by category (mean over ok runs):`);
      parts.push(categoryTable(byCategory, meta.conditions));
    }
  }

  const hasBaselineComparison =
    meta.conditions.includes("mcp") &&
    (meta.conditions.includes("web-search") || meta.conditions.includes("closed-book"));

  if (hasBaselineComparison) {
    parts.push(
      `## Significance (composite, paired on query)\n\n` +
        `Runs are averaged per query first, so n = number of queries. ✅ = Holm-adjusted p < 0.05 ` +
        `(family = all tests below). Effect size: dz for paired-t, r_rb (rank-biserial) for Wilcoxon.`,
    );
    const tests = summary.statistical_tests as Record<string, ModelTests>;
    for (const model of meta.models) {
      parts.push(`**${model}**`);
      parts.push(testLine("mcp vs web-search", tests[model]!.composite_mcp_vs_web));
      parts.push(testLine("mcp vs closed-book", tests[model]!.composite_mcp_vs_closed));
    }
  }

  return parts.join("\n\n") + "\n";
}
