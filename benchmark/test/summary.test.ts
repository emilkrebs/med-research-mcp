import { describe, expect, it } from "vitest";
import { buildSummary, toMarkdown, type ConditionSummary, type Summary, type SummaryMeta, type SummaryTest } from "../lib/report/summary.js";
import type { ConditionId, ScoreRow, Split } from "../lib/types.js";
import { scoreRow as row } from "./helpers.js";

const meta = (conditions: ConditionId[] = ["closed-book", "mcp"], over: Partial<SummaryMeta> = {}): SummaryMeta => ({
  timestamp: "t",
  mcp_version: "v",
  mcp_commit: "c",
  benchmark_version: "b",
  models: ["m1"],
  conditions,
  runs: 1,
  total_responses: 0,
  unverified_queries: [],
  ...over,
});

const cond = (s: Summary, c: string, split: Split = "dev", model = "m1"): ConditionSummary => s.splits[split]!.models[model]![c]!;
const tests = (s: Summary, split: Split = "dev", model = "m1"): SummaryTest[] => s.splits[split]!.tests[model]!;

/** 12 keyed queries: mcp beats closed-book on most of them. */
function dataset(runs: number[]): ScoreRow[] {
  const rows: ScoreRow[] = [];
  for (let q = 0; q < 12; q++) {
    for (const run of runs) {
      rows.push(row({ query_id: `q${String(q).padStart(2, "0")}`, condition: "closed-book", run, accuracy: q % 4 === 0 ? 10 : (q % 3) * 3.33 }));
      rows.push(row({ query_id: `q${String(q).padStart(2, "0")}`, condition: "mcp", run, accuracy: q === 5 ? 6.67 : 10 }));
    }
  }
  return rows;
}

describe("failed and missing runs", () => {
  const rows = [
    row({ query_id: "a", run: 1, accuracy: 10 }),
    row({ query_id: "a", run: 2, accuracy: 0, status: "no-answer", accuracy_source: "failed" }),
    row({ query_id: "b", run: 1, accuracy: 10 }),
    row({ query_id: "b", run: 2, accuracy: 0, status: "timeout", accuracy_source: "failed", speed_s: 300 }),
    row({ query_id: "c", run: 1, accuracy: Number.NaN, status: "provider-error" }),
    row({ query_id: "c", run: 2, accuracy: Number.NaN, status: "scoring-error" }),
    row({ query_id: "d", run: 1, accuracy: Number.NaN, status: "invalid" }),
    row({ query_id: "d", run: 2, accuracy: 10 }),
  ];
  const s = buildSummary(rows, meta(["mcp"]));
  const c = cond(s, "mcp");

  it("a run without an answer counts as 0 instead of dropping out", () => {
    // a: (10 + 0)/2, b: (10 + 0)/2, d: 10 from its one surviving run; c has no scored run.
    expect(c.accuracy_keyed.queries).toBe(3);
    expect(c.accuracy_keyed.mean).toBeCloseTo((5 + 5 + 10) / 3, 4);
  });

  it("a missing run is left out, counted and flagged", () => {
    expect(c.runs).toBe(8);
    expect(c.runs_scored).toBe(5);
    expect(c.runs_missing).toBe(3);
    expect(c.status_rates["no-answer"]).toBeCloseTo(0.125);
    expect(c.status_rates.timeout).toBeCloseTo(0.125);
    expect(c.status_rates["provider-error"]).toBeCloseTo(0.125);
    expect(c.status_rates.invalid).toBeCloseTo(0.125);
    expect(c.status_rates["scoring-error"]).toBeCloseTo(0.125);
    const md = toMarkdown(s);
    expect(md).toContain("3 of 8 runs are missing");
    expect(md).toContain("| mcp | 5/8 ⚠️ |");
    expect(md).toContain("scored 0: no-answer 12.5%, timeout 12.5%");
    expect(md).toContain("**missing: provider-error 12.5%, invalid 12.5%, scoring-error 12.5%**");
  });

  it("a condition that gave up on half its queries does not look better than one that answered them", () => {
    // The old report dropped failed runs: 3 perfect answers out of 6 queries then read as 10.00.
    const gaveUp = ["a", "b", "c", "d", "e", "f"].map((q, i) =>
      i < 3 ? row({ query_id: q, condition: "mcp", accuracy: 10 }) : row({ query_id: q, condition: "mcp", accuracy: 0, status: "no-answer", accuracy_source: "failed" }),
    );
    const answered = ["a", "b", "c", "d", "e", "f"].map((q) => row({ query_id: q, condition: "pubmed", accuracy: 8 }));
    const both = buildSummary([...gaveUp, ...answered], meta(["pubmed", "mcp"]));
    expect(cond(both, "mcp").accuracy_keyed.mean).toBe(5);
    expect(cond(both, "pubmed").accuracy_keyed.mean).toBe(8);
  });

  it("timed-out runs count in the median time, at the timeout", () => {
    expect(c.speed_s_median).toBe(10); // 10, 10, 10, 300, 10
  });
});

describe("the query is the unit", () => {
  it("means are means of per-query means: a query with more runs doesn't weigh more", () => {
    const rows = [
      row({ query_id: "a", run: 1, accuracy: 10 }),
      row({ query_id: "a", run: 2, accuracy: 10 }),
      row({ query_id: "a", run: 3, accuracy: 10 }),
      row({ query_id: "b", run: 1, accuracy: 0 }),
    ];
    const c = cond(buildSummary(rows, meta(["mcp"])), "mcp");
    expect(c.accuracy_keyed.mean).toBe(5); // not 7.5, the mean over rows
    expect(c.accuracy_keyed.queries).toBe(2);
  });

  it("reports a bootstrap interval over queries that brackets the mean, and none for a single query", () => {
    const c = cond(buildSummary(dataset([1]), meta()), "closed-book");
    const [lo, hi] = c.accuracy_keyed.ci_95!;
    expect(lo).toBeLessThan(c.accuracy_keyed.mean!);
    expect(hi).toBeGreaterThan(c.accuracy_keyed.mean!);
    expect(cond(buildSummary([row({})], meta(["mcp"])), "mcp").accuracy_keyed.ci_95).toBeNull();
  });

  it("the same data across 3 runs gives the same n, mean, interval and p as 1 run", () => {
    const one = buildSummary(dataset([1]), meta());
    const three = buildSummary(dataset([1, 2, 3]), meta());
    expect(cond(three, "mcp").accuracy_keyed).toEqual(cond(one, "mcp").accuracy_keyed);
    const t1 = tests(one)[0]!;
    const t3 = tests(three)[0]!;
    expect(t1.n).toBe(12);
    expect(t3.n).toBe(12);
    expect(t3.p_value).toBe(t1.p_value);
    expect(t3.ci_95).toEqual(t1.ci_95);
  });

  it("does not depend on the order of the rows", () => {
    const rows = dataset([1, 2]);
    const shuffled = [...rows].reverse();
    expect(buildSummary(shuffled, meta()).splits).toEqual(buildSummary(rows, meta()).splits);
  });
});

describe("accuracy has ground truth or a human grade", () => {
  const rows = [
    row({ query_id: "k1", accuracy: 10 }),
    row({ query_id: "k2", accuracy: 0 }),
    row({ query_id: "r1", key_kind: "rubric", category: "synthesis", accuracy: Number.NaN, accuracy_source: "ungraded" }),
    row({ query_id: "r2", key_kind: "rubric", category: "synthesis", accuracy: 7, accuracy_source: "human", accuracy_graders: 2 }),
    row({ query_id: "r3", key_kind: "rubric", category: "synthesis", accuracy: 9, accuracy_source: "human", accuracy_graders: 1 }),
    row({ query_id: "r4", key_kind: "rubric", category: "synthesis", accuracy: 0, accuracy_source: "failed", status: "no-answer" }),
  ];
  const s = buildSummary(rows, meta(["mcp"]));
  const c = cond(s, "mcp");

  it("keyed accuracy leaves rubric answers out entirely", () => {
    expect(c.accuracy_keyed.mean).toBe(5);
    expect(c.accuracy_keyed.queries).toBe(2);
  });

  it("rubric accuracy is over graded answers (and unanswered ones, at 0), with the grader count", () => {
    expect(c.accuracy_rubric.mean).toBeCloseTo((7 + 9 + 0) / 3, 4);
    expect(c.rubric_runs_graded).toBe(3);
    expect(c.rubric_runs_ungraded).toBe(1);
    expect(c.rubric_min_graders).toBe(1);
  });

  it("says how many answers still need a grade, and not otherwise", () => {
    expect(toMarkdown(s)).toContain("1 rubric answers not human-graded — run grade.ts, then --rescore");
    expect(toMarkdown(buildSummary(rows.filter((r) => r.query_id !== "r1"), meta(["mcp"])))).not.toContain("not human-graded");
  });

  it("is null (not NaN) when nothing is scored, and survives JSON", () => {
    const empty = buildSummary([row({ key_kind: "rubric", accuracy: Number.NaN, accuracy_source: "ungraded" })], meta(["mcp"]));
    expect(cond(empty, "mcp").accuracy_keyed.mean).toBeNull();
    expect(cond(empty, "mcp").accuracy_rubric.mean).toBeNull();
    expect(JSON.stringify(empty)).not.toContain("NaN");
  });
});

describe("premise and citation rates", () => {
  const rows = [
    row({ query_id: "f1", key_kind: "reject", category: "bullshit", accuracy: 10, bullshit_score: 1, accuracy_source: "reject" }),
    row({ query_id: "f2", key_kind: "reject", category: "bullshit", accuracy: 0, bullshit_score: 0, accuracy_source: "reject" }),
    row({ query_id: "c1", key_kind: "accept", category: "control", accuracy: 10, bullshit_score: 1, accuracy_source: "accept" }),
    row({ query_id: "c2", key_kind: "accept", category: "control", accuracy: 10, bullshit_score: 1, accuracy_source: "accept" }),
    row({ query_id: "k1", pmids_cited: 6, pmids_valid: 3, pmids_fabricated: 3, pmids_off_topic: 2, citations_checked: 4, citations_misattributed: 1 }),
  ];
  const c = cond(buildSummary(rows, meta(["mcp"])), "mcp");

  it("reports fabricated studies rejected and real studies accepted separately", () => {
    expect(c.fabricated_rejected.mean).toBe(0.5);
    expect(c.fabricated_rejected.queries).toBe(2);
    expect(c.real_accepted.mean).toBe(1);
    expect(c.real_accepted.queries).toBe(2);
  });

  it("pools fabricated citations (missing + off-topic) and contradicted claims over the condition", () => {
    expect(c.pmids_cited).toBe(14); // 4 rows × 2 + 6
    expect(c.pmids_unresolved).toBe(1);
    expect(c.pmids_off_topic).toBe(2);
    expect(c.fabrication_rate).toBeCloseTo(3 / 14, 4);
    expect(c.citations_checked).toBe(4);
    expect(c.misattribution_rate).toBe(0.25);
  });

  it("rates are null, not 0, when there is nothing to divide by", () => {
    const none = cond(buildSummary([row({ pmids_cited: 0, pmids_valid: 0 })], meta(["mcp"])), "mcp");
    expect(none.fabrication_rate).toBeNull();
    expect(none.misattribution_rate).toBeNull();
    expect(none.fabricated_rejected.mean).toBeNull();
  });

  it("the design tier of the citations is described, not scored", () => {
    expect(c.design_tier_mean).toBe(3);
    const md = toMarkdown(buildSummary(rows, meta(["mcp"])));
    expect(md).toContain("Mean design tier of citations (descriptive)");
    expect(md).not.toMatch(/composite/i);
  });
});

describe("paired tests", () => {
  it("compare keyed accuracy per query with the exact Wilcoxon test and a bootstrap interval", () => {
    const t = tests(buildSummary(dataset([1]), meta()))[0]!;
    expect(t).toMatchObject({ a: "mcp", b: "closed-book", subset: "keyed", test: "wilcoxon", p_method: "exact", ci_method: "bootstrap-percentile" });
    expect(t.meanDiff).toBeGreaterThan(0);
    expect(t.queries_dropped).toBe(0);
    expect(t.p_value_holm).toBeGreaterThanOrEqual(t.p_value);
  });

  it("never test rubric answers, graded or not", () => {
    const rows = [...dataset([1]), row({ query_id: "r1", key_kind: "rubric", condition: "mcp", accuracy: 9, accuracy_source: "human" }), row({ query_id: "r1", key_kind: "rubric", condition: "closed-book", accuracy: 1, accuracy_source: "human" })];
    expect(tests(buildSummary(rows, meta()))[0]!.n).toBe(12);
  });

  it("drop queries where either side has no scored run, and say how many", () => {
    const rows = dataset([1]).filter((r) => !(r.query_id === "q00" && r.condition === "mcp"));
    const lost = rows.find((r) => r.query_id === "q01" && r.condition === "closed-book")!;
    lost.status = "provider-error";
    lost.accuracy = Number.NaN;
    const t = tests(buildSummary(rows, meta()))[0]!;
    expect(t.n).toBe(10);
    expect(t.queries_dropped).toBe(2);
    expect(toMarkdown(buildSummary(rows, meta()))).toContain("2 left out for missing runs");
  });

  it("keep a query whose runs all failed: it is scored 0, not missing", () => {
    const rows = dataset([1]);
    const failed = rows.find((r) => r.query_id === "q02" && r.condition === "mcp")!;
    failed.status = "timeout";
    failed.accuracy = 0;
    const t = tests(buildSummary(rows, meta()))[0]!;
    expect(t.n).toBe(12);
    expect(t.queries_dropped).toBe(0);
  });

  it("against closed-book, repeat the test without the queries training data can't answer", () => {
    const rows = dataset([1]);
    // Four more queries only retrieval can answer: closed-book 0 by construction.
    for (let q = 0; q < 4; q++) {
      rows.push(row({ query_id: `new${q}`, category: "recent", retrieval_only: true, condition: "closed-book", accuracy: 0 }));
      rows.push(row({ query_id: `new${q}`, category: "recent", retrieval_only: true, condition: "mcp", accuracy: 10 }));
    }
    const ts = tests(buildSummary(rows, meta()));
    expect(ts.map((t) => t.subset)).toEqual(["keyed", "keyed-answerable"]);
    expect(ts[0]!.n).toBe(16);
    expect(ts[1]!.n).toBe(12);
    expect(ts[0]!.meanDiff).toBeGreaterThan(ts[1]!.meanDiff);
    expect(toMarkdown(buildSummary(rows, meta()))).toContain("keyed queries that training data could answer");
  });

  it("don't split by retrieval for other baselines, or when the set has only one kind", () => {
    expect(tests(buildSummary(dataset([1]), meta())).map((t) => t.subset)).toEqual(["keyed"]);
    const rows = dataset([1]).map((r) => ({ ...r, retrieval_only: r.query_id < "q06", condition: (r.condition === "closed-book" ? "pubmed" : "mcp") as ConditionId }));
    expect(tests(buildSummary(rows, meta(["pubmed", "mcp"]))).map((t) => `${t.a}/${t.b}/${t.subset}`)).toEqual(["mcp/pubmed/keyed"]);
  });

  it("test every baseline and the skill, Holm-adjusted as one family", () => {
    const rows = dataset([1]);
    for (const r of dataset([1])) {
      if (r.condition === "closed-book") {
        rows.push({ ...r, condition: "web-search", accuracy: Math.min(10, r.accuracy + 3.33) });
        rows.push({ ...r, condition: "pubmed", accuracy: 10 });
      } else rows.push({ ...r, condition: "mcp-skill" });
    }
    const ts = tests(buildSummary(rows, meta(["closed-book", "web-search", "pubmed", "mcp", "mcp-skill"])));
    expect(ts.map((t) => `${t.a} vs ${t.b}`)).toEqual(["mcp vs closed-book", "mcp vs web-search", "mcp vs pubmed", "mcp-skill vs mcp"]);
    const smallest = Math.min(...ts.map((t) => t.p_value));
    const adjSmallest = ts.find((t) => t.p_value === smallest)!.p_value_holm;
    expect(adjSmallest).toBeCloseTo(Math.min(1, 4 * smallest), 5);
    // Identical conditions: no difference, p = 1.
    expect(ts[3]).toMatchObject({ meanDiff: 0, n_nonzero: 0, p_value: 1 });
  });
});

describe("splits", () => {
  const rows = [
    ...dataset([1]),
    ...dataset([1]).map((r) => ({ ...r, split: "test" as const, query_id: `t-${r.query_id}`, category: "lookup" as const, accuracy: r.condition === "mcp" ? 6.67 : 3.33 })),
  ];
  const s = buildSummary(rows, meta());

  it("are summarized apart: a development query never enters a held-out number", () => {
    expect(s.splits.test!.queries).toBe(12);
    expect(s.splits.dev!.queries).toBe(12);
    expect(cond(s, "mcp", "test").accuracy_keyed.mean).toBe(6.67);
    expect(cond(s, "mcp", "dev").accuracy_keyed.mean).toBeCloseTo((11 * 10 + 6.67) / 12, 3);
    expect(tests(s, "test")[0]!.n).toBe(12);
  });

  it("the held-out set comes first in the report, each with its note", () => {
    const md = toMarkdown(s);
    expect(md.indexOf("## Held-out set — 12 queries")).toBeGreaterThan(0);
    expect(md.indexOf("## Held-out set")).toBeLessThan(md.indexOf("## Development set — 12 queries"));
    expect(md).toContain("These are the numbers to report.");
    expect(md).toContain("don't report them as results");
  });

  it("a run of one split has only that section", () => {
    const dev = buildSummary(dataset([1]), meta());
    expect(Object.keys(dev.splits)).toEqual(["dev"]);
    expect(toMarkdown(dev)).not.toContain("Held-out set");
  });
});

describe("markdown", () => {
  it("lists only present conditions and labels the test", () => {
    const md = toMarkdown(buildSummary(dataset([1]), meta()));
    expect(md).toContain("A=closed-book, C=mcp");
    expect(md).not.toContain("B=web-search");
    expect(md).toContain("r_rb=");
    expect(md).toContain("p_holm=");
    expect(md).toContain("Wilcoxon signed-rank");
  });

  it("names the MCP version that generated the answers, and a later rescore", () => {
    const md = toMarkdown(buildSummary(dataset([1]), meta(undefined, { mcp_version: "0.3.0", mcp_commit: "b401d06", scorer_version: 8, rescored: { at: "2026-11-09T10:00:00.000Z", harness_commit: "fd72c8b" } })));
    expect(md).toContain("Answers generated with MCP 0.3.0 (b401d06) · scorer v8 · scored again 2026-11-09 with harness fd72c8b.");
  });

  it("warns about unverified keys", () => {
    expect(toMarkdown(buildSummary(dataset([1]), meta(undefined, { unverified_queries: ["t-lookup-07"] })))).toContain("1 keyed queries have unverified answer keys");
  });

  it("emits a per-category accuracy table in json and markdown", () => {
    const rows = (["factual", "bullshit"] as const).flatMap((category) => [
      row({ query_id: category, category, condition: "closed-book", accuracy: 2 }),
      row({ query_id: category, category, condition: "mcp", accuracy: 8 }),
    ]);
    const s = buildSummary(rows, meta());
    expect(s.splits.dev!.category_accuracy.m1!.factual!.mcp).toEqual({ mean: 8, queries: 1 });
    expect(toMarkdown(s)).toContain("| factual | 1 | 2.00 | 8.00 |");
  });
});
