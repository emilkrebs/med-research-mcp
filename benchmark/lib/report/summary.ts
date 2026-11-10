/**
 * Aggregate `ScoreRow[]` into `summary.json` and a Markdown version of it.
 *
 * There is no single score. Each thing the benchmark can measure is reported
 * on its own, per split (held-out `test`, development `dev`), model and condition:
 *
 *  - accuracy on the keyed queries (`values`, `reject`, `accept`: the ones with ground truth),
 *  - the share of fabricated studies rejected and of real-study controls accepted,
 *  - the share of cited records that are fabricated (don't exist, or are about something else),
 *  - the share of checkable claims next to a citation that contradict the cited record,
 *  - median tokens and wall-clock time,
 *  - how many runs failed or are missing.
 *
 * Rules that keep those numbers comparable:
 *  - The unit is the query. Runs of a query are averaged first, and every mean
 *    is a mean of per-query means with a bootstrap interval over queries, so a
 *    query with more surviving runs doesn't weigh more.
 *  - A run that produced no answer (`no-answer`, `timeout`) counts with accuracy
 *    0. A run that is missing data (`provider-error`, `invalid`, `scoring-error`)
 *    is left out and counted: a condition with missing runs is flagged, because
 *    its means are over a different set of answers.
 *  - Rubric answers have an accuracy only once a human has graded them.
 *  - The mean design tier of the cited records is listed as a description of
 *    what was cited. It is not a quality score and enters nothing else.
 *
 * Paired tests compare conditions on keyed accuracy per query (Wilcoxon
 * signed-rank, exact). Against the closed-book baseline the test is repeated
 * without the queries that training data cannot answer by construction.
 * All p-values in a summary are Holm-adjusted as one family.
 */

import type { Category, ConditionId, RunStatus, ScoreRow, Split } from "../types.js";
import { CONDITION_LETTER, DEFAULTS } from "../config.js";
import { bootstrapMeanCI, comparePaired, holm, mean, median, type PairedResult } from "../stats.js";
import { RUN_STATUSES, isScored } from "../status.js";

/** A mean of per-query means. */
export interface Estimate {
  /** Null when no query has a score. */
  mean: number | null;
  /** 95% percentile-bootstrap interval over queries; null with fewer than two queries. */
  ci_95: [number, number] | null;
  /** Queries the mean is over. */
  queries: number;
}

export interface ConditionSummary {
  /** All rows for this model × condition: the runs that were planned. */
  runs: number;
  /** Runs that count: answered, or failed to answer (scored 0). */
  runs_scored: number;
  /** Runs without data (provider error, invalid context, scoring error): to be run or scored again. */
  runs_missing: number;
  /** Share of all runs per status. */
  status_rates: Record<RunStatus, number>;
  /** Accuracy (0–10) on queries with ground truth; a run without an answer counts 0. */
  accuracy_keyed: Estimate;
  /** Accuracy (0–10) of human-graded rubric answers; a run without an answer counts 0. */
  accuracy_rubric: Estimate;
  /** Scored rubric runs that have an accuracy (human grade, or 0 for no answer). */
  rubric_runs_graded: number;
  /** Scored rubric runs still waiting for a human grade. */
  rubric_runs_ungraded: number;
  /** Fewest graders behind any human-graded answer; null when none is graded. */
  rubric_min_graders: number | null;
  /** Share of fabricated-study queries correctly rejected (0–1). */
  fabricated_rejected: Estimate;
  /** Share of real-study control queries not rejected (0–1). */
  real_accepted: Estimate;
  pmids_cited: number;
  /** Cited records that don't exist. */
  pmids_unresolved: number;
  /** Cited records that exist but are about something else. */
  pmids_off_topic: number;
  /** (unresolved + off-topic) ÷ cited, pooled over the condition's answers; null when nothing was cited. */
  fabrication_rate: number | null;
  /** Valid citations with a checkable claim next to them. */
  citations_checked: number;
  /** Share of those whose claim contradicts the record, pooled; null when none could be checked. */
  misattribution_rate: number | null;
  /** Mean design tier of the valid, rated citations, averaged over answers. Descriptive only. */
  design_tier_mean: number | null;
  /** Median total tokens of a scored run. */
  tokens_median: number | null;
  /** Median wall-clock seconds of a scored run (a timed-out run counts at the timeout). */
  speed_s_median: number | null;
}

export interface SummaryMeta {
  timestamp: string;
  /** Version and commit of the MCP the answers were generated with (from the run's manifest). */
  mcp_version: string;
  mcp_commit: string;
  benchmark_version: string;
  models: string[];
  conditions: ConditionId[];
  runs: number;
  total_responses: number;
  /** Keyed queries whose answer key nobody has verified. */
  unverified_queries: string[];
  overrides_applied?: number;
  overrides_excluded?: number;
  /** `SCORER_VERSION` the rows were scored with. */
  scorer_version?: number;
  /** Set when the stored answers were scored again after the run: when, and with which harness commit. */
  rescored?: { at: string; harness_commit: string };
  /** Provenance of merged result directories. */
  sources?: string[];
}

/** Which keyed queries a test is over. */
export type TestSubset =
  /** Every query with ground truth. */
  | "keyed"
  /** Without the queries that training data can't answer by construction (`retrieval_only`). */
  | "keyed-answerable";

/** A paired test as written to summary.json. */
export interface SummaryTest extends PairedResult {
  /** The test compares `a` with `b`; a positive difference favors `a`. */
  a: ConditionId;
  b: ConditionId;
  subset: TestSubset;
  /** Keyed queries of the subset left out because one side has no scored run for them. */
  queries_dropped: number;
  p_value_holm: number;
}

export interface SplitSummary {
  /** Distinct queries with rows in this split. */
  queries: number;
  /** model → condition → summary. */
  models: Record<string, Record<string, ConditionSummary>>;
  /** model → category → condition → keyed accuracy (mean of per-query means). */
  category_accuracy: Record<string, Record<string, Record<string, { mean: number; queries: number }>>>;
  /** model → paired tests. */
  tests: Record<string, SummaryTest[]>;
}

export interface Summary {
  _meta: SummaryMeta;
  splits: Partial<Record<Split, SplitSummary>>;
}

/** Condition pairs tested, `a` against `b`. */
const TEST_PAIRS: { a: ConditionId; b: ConditionId }[] = [
  { a: "mcp", b: "closed-book" },
  { a: "mcp", b: "web-search" },
  { a: "mcp", b: "pubmed" },
  { a: "mcp-skill", b: "mcp" },
];

const SPLIT_ORDER: Split[] = ["test", "dev"];
const CATEGORY_ORDER: Category[] = ["lookup", "factual", "drill-down", "synthesis", "edge-case", "compound", "recent", "bullshit", "control"];

const round = (x: number, dp = 4): number => Math.round(x * 10 ** dp) / 10 ** dp;

const isKeyed = (r: ScoreRow): boolean => r.key_kind !== "rubric";

/** Per-query mean of `value` over the rows where it is finite, keyed by query id. */
function perQuery(rows: ScoreRow[], value: (r: ScoreRow) => number): Map<string, number> {
  const groups = new Map<string, number[]>();
  for (const r of rows) {
    const v = value(r);
    if (!Number.isFinite(v)) continue;
    const g = groups.get(r.query_id);
    if (g) g.push(v);
    else groups.set(r.query_id, [v]);
  }
  // Sorted by query id so the bootstrap sees the same order whatever order the rows came in.
  return new Map([...groups].sort(([a], [b]) => a.localeCompare(b)).map(([q, xs]) => [q, mean(xs)] as const));
}

function estimate(values: number[]): Estimate {
  if (values.length === 0) return { mean: null, ci_95: null, queries: 0 };
  return { mean: round(mean(values)), ci_95: bootstrapMeanCI(values, { resamples: DEFAULTS.bootstrapResamples }), queries: values.length };
}

function summarizeCondition(rows: ScoreRow[]): ConditionSummary {
  const scored = rows.filter((r) => isScored(r.status));
  const ok = rows.filter((r) => r.status === "ok");
  const status_rates = Object.fromEntries(
    RUN_STATUSES.map((s) => [s, rows.length > 0 ? round(rows.filter((r) => r.status === s).length / rows.length) : 0]),
  ) as Record<RunStatus, number>;

  const rubric = scored.filter((r) => r.key_kind === "rubric");
  const graded = rubric.filter((r) => Number.isFinite(r.accuracy));
  const graders = graded.filter((r) => r.accuracy_source === "human").map((r) => r.accuracy_graders ?? 1);

  const cited = ok.reduce((s, r) => s + r.pmids_cited, 0);
  const fabricated = ok.reduce((s, r) => s + r.pmids_fabricated, 0);
  const offTopic = ok.reduce((s, r) => s + (r.pmids_off_topic ?? 0), 0);
  const checked = ok.reduce((s, r) => s + (r.citations_checked ?? 0), 0);
  const misattributed = ok.reduce((s, r) => s + (r.citations_misattributed ?? 0), 0);
  const tiers = ok.map((r) => r.evidence_quality).filter(Number.isFinite);
  // A run that threw (a timeout) never reported its usage, so its record holds 0 tokens: the median is
  // over the runs that returned. Its time is known (the timeout), so it stays in the median time.
  const tokens = scored.filter((r) => r.status !== "timeout").map((r) => r.total_tokens).filter(Number.isFinite);
  const speeds = scored.map((r) => r.speed_s).filter(Number.isFinite);

  return {
    runs: rows.length,
    runs_scored: scored.length,
    runs_missing: rows.length - scored.length,
    status_rates,
    accuracy_keyed: estimate([...perQuery(scored.filter(isKeyed), (r) => r.accuracy).values()]),
    accuracy_rubric: estimate([...perQuery(rubric, (r) => r.accuracy).values()]),
    rubric_runs_graded: graded.length,
    rubric_runs_ungraded: rubric.length - graded.length,
    rubric_min_graders: graders.length > 0 ? Math.min(...graders) : null,
    fabricated_rejected: estimate([...perQuery(scored.filter((r) => r.key_kind === "reject"), (r) => r.bullshit_score).values()]),
    real_accepted: estimate([...perQuery(scored.filter((r) => r.key_kind === "accept"), (r) => r.bullshit_score).values()]),
    pmids_cited: cited,
    pmids_unresolved: fabricated - offTopic,
    pmids_off_topic: offTopic,
    // Pooled ratios (sums across the condition's answers), not means of per-row ratios:
    // charts.ts's pooledRatioBars uses the same formula, so chart and table agree.
    fabrication_rate: cited > 0 ? round(fabricated / cited) : null,
    citations_checked: checked,
    misattribution_rate: checked > 0 ? round(misattributed / checked) : null,
    design_tier_mean: tiers.length > 0 ? round(mean(tiers)) : null,
    tokens_median: tokens.length > 0 ? median(tokens) : null,
    speed_s_median: speeds.length > 0 ? round(median(speeds), 2) : null,
  };
}

/** Keyed accuracy per query for one model × condition (scored runs, restricted by `keep`). */
function keyedByQuery(rows: ScoreRow[], model: string, condition: ConditionId, keep: (r: ScoreRow) => boolean): Map<string, number> {
  return perQuery(
    rows.filter((r) => r.model === model && r.condition === condition && isScored(r.status) && isKeyed(r) && keep(r)),
    (r) => r.accuracy,
  );
}

/** Pair `a` and `b` on the keyed queries both have a scored run for, and test the difference. */
function pairedTest(
  rows: ScoreRow[],
  model: string,
  a: ConditionId,
  b: ConditionId,
  subset: TestSubset,
): (PairedResult & { queries_dropped: number }) | null {
  const keep = subset === "keyed-answerable" ? (r: ScoreRow) => !r.retrieval_only : () => true;
  const left = keyedByQuery(rows, model, a, keep);
  const right = keyedByQuery(rows, model, b, keep);
  const xs: number[] = [];
  const ys: number[] = [];
  for (const [query, value] of left) {
    const other = right.get(query);
    if (other !== undefined) {
      xs.push(value);
      ys.push(other);
    }
  }
  const result = comparePaired(xs, ys, { resamples: DEFAULTS.bootstrapResamples });
  if (!result) return null;
  const all = new Set([...left.keys(), ...right.keys()]);
  return { ...result, queries_dropped: all.size - xs.length };
}

/** Mean keyed accuracy per category × condition for one model. */
function categoryAccuracy(rows: ScoreRow[], model: string, conditions: ConditionId[]): SplitSummary["category_accuracy"][string] {
  const out: SplitSummary["category_accuracy"][string] = {};
  for (const category of CATEGORY_ORDER) {
    const perCondition: Record<string, { mean: number; queries: number }> = {};
    for (const condition of conditions) {
      const values = [...keyedByQuery(rows, model, condition, (r) => r.category === category).values()];
      if (values.length > 0) perCondition[condition] = { mean: round(mean(values)), queries: values.length };
    }
    if (Object.keys(perCondition).length > 0) out[category] = perCondition;
  }
  return out;
}

export function buildSummary(rows: ScoreRow[], meta: SummaryMeta): Summary {
  const summary: Summary = { _meta: meta, splits: {} };
  const pending: { test: PairedResult & { queries_dropped: number }; into: SummaryTest[]; a: ConditionId; b: ConditionId; subset: TestSubset }[] = [];

  for (const split of SPLIT_ORDER) {
    const inSplit = rows.filter((r) => r.split === split);
    if (inSplit.length === 0) continue;
    const part: SplitSummary = { queries: new Set(inSplit.map((r) => r.query_id)).size, models: {}, category_accuracy: {}, tests: {} };

    for (const model of meta.models) {
      const ofModel = inSplit.filter((r) => r.model === model);
      if (ofModel.length === 0) continue;
      const perCondition: Record<string, ConditionSummary> = {};
      for (const condition of meta.conditions) {
        const subset = ofModel.filter((r) => r.condition === condition);
        if (subset.length > 0) perCondition[condition] = summarizeCondition(subset);
      }
      part.models[model] = perCondition;
      part.category_accuracy[model] = categoryAccuracy(ofModel, model, meta.conditions);

      const tests: SummaryTest[] = [];
      part.tests[model] = tests;
      for (const { a, b } of TEST_PAIRS) {
        if (!perCondition[a] || !perCondition[b]) continue;
        const all = pairedTest(ofModel, model, a, b, "keyed");
        if (all) pending.push({ test: all, into: tests, a, b, subset: "keyed" });
        // Against a closed-book baseline, retrieval-only queries are decided before the run:
        // report the comparison without them as well, when the set has both kinds.
        const keyed = ofModel.filter((r) => isKeyed(r) && (r.condition === a || r.condition === b));
        if (b === "closed-book" && keyed.some((r) => r.retrieval_only) && keyed.some((r) => !r.retrieval_only)) {
          const answerable = pairedTest(ofModel, model, a, b, "keyed-answerable");
          if (answerable) pending.push({ test: answerable, into: tests, a, b, subset: "keyed-answerable" });
        }
      }
    }
    summary.splits[split] = part;
  }

  // Holm-adjust across every test in the report, then file each under its model.
  const adjusted = holm(pending.map((p) => p.test.p_value));
  pending.forEach((p, i) => p.into.push({ ...p.test, a: p.a, b: p.b, subset: p.subset, p_value_holm: round(adjusted[i]!, 6) }));
  return summary;
}

// ─── Markdown rendering ─────────────────────────────────────────

const pct = (x: number): string => `${(x * 100).toFixed(1)}%`;

/** "9.02 [8.10, 9.71] (n=84)"; "—" when there is nothing to average. */
function fmtEstimate(e: Estimate, format: (x: number) => string = (x) => x.toFixed(2)): string {
  if (e.mean === null) return "—";
  const ci = e.ci_95 ? ` [${format(e.ci_95[0])}, ${format(e.ci_95[1])}]` : "";
  return `${format(e.mean)}${ci} (n=${e.queries})`;
}

const fmtShare = (e: Estimate): string => fmtEstimate(e, (x) => `${Math.round(x * 100)}%`);

/** 1234 → "1.2k". */
function fmtTokens(n: number | null): string {
  if (n === null) return "—";
  return n < 1000 ? String(Math.round(n)) : `${(n / 1000).toFixed(n < 10_000 ? 1 : 0)}k`;
}

/** "0.5% of 406"; "—" when the denominator is zero. */
function fmtRate(rate: number | null, of: number): string {
  return rate === null ? "—" : `${pct(rate)} of ${of}`;
}

/** Failed runs (scored 0) and missing runs, non-zero rates only; "—" when every run answered. */
function failures(s: ConditionSummary): string {
  const part = (statuses: RunStatus[]): string =>
    statuses
      .filter((st) => s.status_rates[st] > 0)
      .map((st) => `${st} ${pct(s.status_rates[st])}`)
      .join(", ");
  const failed = part(["no-answer", "timeout"]);
  const missing = part(["provider-error", "invalid", "scoring-error"]);
  const out = [failed ? `scored 0: ${failed}` : "", missing ? `**missing: ${missing}**` : ""].filter(Boolean);
  return out.length > 0 ? out.join("; ") : "—";
}

function conditionTable(perCondition: Record<string, ConditionSummary>): string {
  const header =
    "| Condition | Runs scored | Accuracy, keyed queries (0–10) | Fabricated studies rejected | Real studies accepted | Fabricated citations | Contradicted claims | Median tokens | Median time (s) | Failed or missing |\n" +
    "|---|--:|--:|--:|--:|--:|--:|--:|--:|--|";
  const rows = Object.entries(perCondition).map(([c, s]) => {
    const incomplete = s.runs_missing > 0 ? " ⚠️" : "";
    return (
      `| ${c} | ${s.runs_scored}/${s.runs}${incomplete} | ${fmtEstimate(s.accuracy_keyed)} | ${fmtShare(s.fabricated_rejected)} | ${fmtShare(s.real_accepted)} | ` +
      `${fmtRate(s.fabrication_rate, s.pmids_cited)} | ${fmtRate(s.misattribution_rate, s.citations_checked)} | ${fmtTokens(s.tokens_median)} | ` +
      `${s.speed_s_median === null ? "—" : s.speed_s_median.toFixed(1)} | ${failures(s)} |`
    );
  });
  return [header, ...rows].join("\n");
}

/** What was cited, and the human-graded rubric answers. */
function detailTable(perCondition: Record<string, ConditionSummary>): string {
  const header =
    "| Condition | PMIDs cited | Don't exist | Off-topic | Mean design tier of citations (descriptive) | Rubric accuracy, human-graded (0–10) | Rubric answers graded | Graders per answer |\n" +
    "|---|--:|--:|--:|--:|--:|--:|--:|";
  const rows = Object.entries(perCondition).map(([c, s]) => {
    const rubricRuns = s.rubric_runs_graded + s.rubric_runs_ungraded;
    return (
      `| ${c} | ${s.pmids_cited} | ${s.pmids_unresolved} | ${s.pmids_off_topic} | ${s.design_tier_mean === null ? "—" : s.design_tier_mean.toFixed(2)} | ` +
      `${fmtEstimate(s.accuracy_rubric)} | ${rubricRuns > 0 ? `${s.rubric_runs_graded}/${rubricRuns}` : "—"} | ${s.rubric_min_graders === null ? "—" : `≥${s.rubric_min_graders}`} |`
    );
  });
  return [header, ...rows].join("\n");
}

/** Category × condition keyed accuracy for one model. */
function categoryTable(byCategory: Record<string, Record<string, { mean: number; queries: number }>>, conditions: ConditionId[]): string {
  const header = `| Category | Queries | ${conditions.join(" | ")} |\n|---|--:|${conditions.map(() => "--:").join("|")}|`;
  const rows = Object.keys(byCategory).map((cat) => {
    const cells = conditions.map((c) => {
      const s = byCategory[cat]![c];
      return s ? s.mean.toFixed(2) : "—";
    });
    const queries = Math.max(...Object.values(byCategory[cat]!).map((s) => s.queries));
    return `| ${cat} | ${queries} | ${cells.join(" | ")} |`;
  });
  return [header, ...rows].join("\n");
}

const SUBSET_LABEL: Record<TestSubset, string> = {
  keyed: "keyed queries",
  "keyed-answerable": "keyed queries that training data could answer",
};

function testLine(t: SummaryTest): string {
  const sig = t.p_value_holm < 0.05 ? "✅" : "—";
  const sign = t.meanDiff >= 0 ? "+" : "";
  const ci = t.ci_95 ? ` [${t.ci_95[0].toFixed(2)}, ${t.ci_95[1].toFixed(2)}]` : "";
  const dropped = t.queries_dropped > 0 ? `, ${t.queries_dropped} left out for missing runs` : "";
  return (
    `- **${t.a} vs ${t.b}**, ${SUBSET_LABEL[t.subset]} ${sig}: ${t.meanA.toFixed(2)} vs ${t.meanB.toFixed(2)} ` +
    `(Δ=${sign}${t.meanDiff.toFixed(2)}${ci}, n=${t.n} queries${dropped}, ${t.n_nonzero} differ, ` +
    `p=${t.p_value.toPrecision(2)}, p_holm=${t.p_value_holm.toPrecision(2)}, r_rb=${t.effect_size.toFixed(2)})`
  );
}

const SPLIT_TITLE: Record<Split, string> = { test: "Held-out set", dev: "Development set" };
const SPLIT_NOTE: Record<Split, string> = {
  test: "Queries nothing was tuned against. These are the numbers to report.",
  dev: "Queries used while building the server, the skill and the scorer. Use them to develop; don't report them as results.",
};

export function toMarkdown(summary: Summary): string {
  const meta = summary._meta;
  const parts: string[] = [];
  parts.push(`# med-research-mcp benchmark — ${meta.timestamp}`);
  parts.push(
    `${meta.total_responses} responses · ${meta.models.length} model(s) · ` +
      `${meta.conditions.length} condition(s) · ${meta.runs} run(s)/query. ` +
      `Conditions: ${meta.conditions.map((c) => `${CONDITION_LETTER[c] ?? "?"}=${c}`).join(", ")}.`,
  );
  const scoredWith = meta.scorer_version !== undefined ? ` · scorer v${meta.scorer_version}` : "";
  const rescored = meta.rescored ? ` · scored again ${meta.rescored.at.slice(0, 10)} with harness ${meta.rescored.harness_commit}` : "";
  parts.push(`Answers generated with MCP ${meta.mcp_version} (${meta.mcp_commit})${scoredWith}${rescored}.`);

  const all = Object.values(summary.splits).flatMap((s) => Object.values(s!.models).flatMap((m) => Object.values(m)));
  const missing = all.reduce((n, s) => n + s.runs_missing, 0);
  if (missing > 0) {
    parts.push(
      `> ⚠️ **${missing} of ${all.reduce((n, s) => n + s.runs, 0)} runs are missing** (provider error, invalid context or scoring error). ` +
        `The conditions marked ⚠️ are averaged over fewer answers than planned and are not comparable until those runs exist: ` +
        `run them with \`--resume\`, or \`--rescore\` for scoring errors.`,
    );
  }
  const ungraded = all.reduce((n, s) => n + s.rubric_runs_ungraded, 0);
  if (ungraded > 0) {
    parts.push(
      `> ⚠️ **${ungraded} rubric answers not human-graded — run grade.ts, then --rescore.** ` +
        `An open-ended answer has no accuracy until a person grades it, and nothing stands in for the grade.`,
    );
  }
  if (meta.unverified_queries.length > 0) {
    parts.push(
      `> ⚠️ **${meta.unverified_queries.length} keyed queries have unverified answer keys** ` +
        `(${meta.unverified_queries.join(", ")}). Their accuracy counts below — check the keys before publishing.`,
    );
  }

  let anyTest = false;
  for (const split of SPLIT_ORDER) {
    const part = summary.splits[split];
    if (!part) continue;
    parts.push(`## ${SPLIT_TITLE[split]} — ${part.queries} queries\n\n${SPLIT_NOTE[split]}`);
    for (const model of meta.models) {
      const perCondition = part.models[model];
      if (!perCondition) continue;
      parts.push(`### ${model}`);
      parts.push(conditionTable(perCondition));
      parts.push(detailTable(perCondition));
      const byCategory = part.category_accuracy[model];
      if (byCategory && Object.keys(byCategory).length > 0) {
        parts.push(`Accuracy by category (keyed queries, mean over queries):`);
        parts.push(categoryTable(byCategory, meta.conditions));
      }
      const tests = part.tests[model] ?? [];
      if (tests.length > 0) {
        anyTest = true;
        parts.push(`Paired tests (${model}, ${SPLIT_TITLE[split].toLowerCase()}):\n\n${tests.map(testLine).join("\n")}`);
      }
    }
  }

  parts.push(
    `**Reading the tables.** Accuracy is over queries with ground truth: an exact answer key, a fabricated study to reject, ` +
      `or a real study not to reject. A run that produced no answer or timed out counts as 0; a missing run is left out and flagged. ` +
      `Means are means of per-query means, with a 95% bootstrap interval over queries in brackets. ` +
      `A fabricated citation is a cited record that doesn't exist or is about something else; a contradicted claim is a year, author, ` +
      `design or figure stated next to a valid citation that the record contradicts. Both rates are pooled over the condition's answers.`,
  );
  if (anyTest) {
    parts.push(
      `**Reading the tests.** Runs are averaged per query first, so n is the number of queries. The test is the Wilcoxon signed-rank test ` +
        `with its exact null distribution; Δ is the mean difference with a 95% bootstrap interval; r_rb is the rank-biserial effect size. ` +
        `✅ = Holm-adjusted p < 0.05, the family being every test in this report.`,
    );
  }
  return parts.join("\n\n") + "\n";
}
