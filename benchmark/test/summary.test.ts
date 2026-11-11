import { describe, expect, it } from "vitest";
import { buildSummary, fmtP, partitionByCatalog, toMarkdown, type ConditionSummary, type Summary, type SummaryMeta, type SummaryTest } from "../lib/report/summary.js";
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
    row({ query_id: "b", run: 2, accuracy: 0, status: "timeout", accuracy_source: "failed", speed_s: 300, input_tokens: 0, output_tokens: 0, total_tokens: 0 }),
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

  it("but not in the median tokens: a run that timed out never reported what it used", () => {
    // Scored runs: 150, 150, 150, 0 (timeout), 150. With one more timeout the median over all scored runs would
    // still be 150, so take a condition where half the runs timed out: 150, 0, 0 must read 150, not 0.
    const half = [
      row({ query_id: "a", total_tokens: 150 }),
      row({ query_id: "b", status: "timeout", accuracy: 0, accuracy_source: "failed", total_tokens: 0 }),
      row({ query_id: "c", status: "timeout", accuracy: 0, accuracy_source: "failed", total_tokens: 0 }),
    ];
    expect(cond(buildSummary(half, meta(["mcp"])), "mcp").tokens_median).toBe(150);
    expect(c.tokens_median).toBe(150);
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

describe("queries that left the catalog", () => {
  // `gone` stands for a retired lookup: its rows are in a stored run, its query is not in the catalog any more.
  const inCatalog = (id: string): boolean => !id.startsWith("gone");
  const rows = [
    row({ query_id: "keep1", condition: "closed-book", accuracy: 0 }),
    row({ query_id: "keep1", condition: "mcp", accuracy: 10 }),
    row({ query_id: "keep2", condition: "closed-book", accuracy: 0 }),
    row({ query_id: "keep2", condition: "mcp", accuracy: 10 }),
    row({ query_id: "gone1", category: "lookup", split: "test", condition: "closed-book", accuracy: 10 }),
    row({ query_id: "gone1", category: "lookup", split: "test", condition: "mcp", accuracy: 0, status: "provider-error" }),
    row({ query_id: "gone2", category: "lookup", split: "test", condition: "mcp", accuracy: 3 }),
    row({ query_id: "gone2", category: "lookup", split: "test", condition: "closed-book", accuracy: 3 }),
  ];
  const s = buildSummary(rows, meta(["closed-book", "mcp"], { total_responses: rows.length }), { inCatalog });

  it("partitions rows by the catalog", () => {
    const { kept, retired } = partitionByCatalog(rows, inCatalog);
    expect(kept.map((r) => r.query_id)).toEqual(["keep1", "keep1", "keep2", "keep2"]);
    expect(retired).toHaveLength(4);
  });

  it("are left out of every number: queries, means, runs, missing runs, tests, categories", () => {
    expect(Object.keys(s.splits)).toEqual(["dev"]); // the retired rows were the only held-out ones
    expect(s.splits.dev!.queries).toBe(2);
    const c = cond(s, "mcp");
    expect(c.runs).toBe(2);
    expect(c.runs_missing).toBe(0); // gone1's provider error is not a missing run of the report
    expect(c.status_rates["provider-error"]).toBe(0);
    expect(c.accuracy_keyed).toMatchObject({ mean: 10, queries: 2 });
    expect(cond(s, "closed-book").accuracy_keyed).toMatchObject({ mean: 0, queries: 2 });
    expect(tests(s)[0]).toMatchObject({ n: 2, queries_dropped: 0 });
    expect(s.splits.dev!.category_accuracy.m1!.lookup).toBeUndefined();
    expect(s._meta.total_responses).toBe(4);
  });

  it("are counted in the meta and in one warning line", () => {
    expect(s._meta.retired_rows).toBe(4);
    expect(s._meta.retired_queries).toBe(2);
    const md = toMarkdown(s);
    expect(md.match(/no longer in the catalog/g)).toHaveLength(1);
    expect(md).toContain("4 rows of 2 queries that are no longer in the catalog were left out of every number below");
    expect(md).toContain("4 responses ·");
    expect(md).not.toContain("are missing");
  });

  it("change nothing when there are none, and without a catalog every row counts", () => {
    const clean = buildSummary(rows.filter((r) => inCatalog(r.query_id)), meta(), { inCatalog });
    expect(clean._meta.retired_rows).toBeUndefined();
    expect(toMarkdown(clean)).not.toContain("no longer in the catalog");
    const unfiltered = buildSummary(rows, meta());
    expect(unfiltered._meta.retired_rows).toBeUndefined();
    expect(unfiltered.splits.dev!.queries).toBe(2);
    expect(unfiltered.splits.test!.queries).toBe(2);
    expect(toMarkdown(unfiltered)).not.toContain("no longer in the catalog");
  });
});

describe("queries whose answer is beyond PubMed", () => {
  /** `inN` queries a PubMed abstract answers, `outN` beyond it; mcp reaches both, pubmed only the first kind. */
  function mixed(inN: number, outN: number, conditions: ConditionId[] = ["mcp", "pubmed"]): ScoreRow[] {
    const out: ScoreRow[] = [];
    for (let i = 0; i < inN + outN; i++) {
      const beyond = i >= inN;
      const query_id = `${beyond ? "b" : "i"}${String(i).padStart(2, "0")}`;
      for (const condition of conditions) {
        const accuracy = condition === "pubmed" ? (beyond ? 0 : 10) : i % 5 === 0 ? 6.67 : 10;
        out.push(row({ query_id, condition, beyond_pubmed: beyond, category: beyond ? "preprint" : "lookup", accuracy }));
      }
    }
    return out;
  }
  const s = buildSummary(mixed(10, 10), meta(["mcp", "pubmed"]));

  it("have their own accuracy estimates next to the keyed one", () => {
    expect(cond(s, "pubmed").accuracy_keyed).toMatchObject({ mean: 5, queries: 20 });
    expect(cond(s, "pubmed").accuracy_in_pubmed).toMatchObject({ mean: 10, queries: 10 });
    expect(cond(s, "pubmed").accuracy_beyond_pubmed).toMatchObject({ mean: 0, queries: 10 });
    // mcp: in-PubMed i00 and i05 score 6.67, the rest 10; beyond: i10 and i15 do.
    expect(cond(s, "mcp").accuracy_in_pubmed.mean).toBeCloseTo((8 * 10 + 2 * 6.67) / 10, 3);
    expect(cond(s, "mcp").accuracy_beyond_pubmed.mean).toBeCloseTo((8 * 10 + 2 * 6.67) / 10, 3);
    expect(cond(s, "mcp").accuracy_in_pubmed.ci_95).not.toBeNull();
  });

  it("are left out of the in-PubMed estimate, rubric answers out of both", () => {
    const rows = [...mixed(2, 2, ["mcp"]), row({ query_id: "r1", key_kind: "rubric", beyond_pubmed: true, accuracy: 9, accuracy_source: "human" })];
    const c = cond(buildSummary(rows, meta(["mcp"])), "mcp");
    expect(c.accuracy_beyond_pubmed.queries).toBe(2);
    expect(c.accuracy_in_pubmed.queries).toBe(2);
  });

  it("show as two table columns when the split has both kinds, and only then", () => {
    const md = toMarkdown(s);
    expect(md).toContain("| Condition | Runs scored | Accuracy, keyed queries (0–10) | Accuracy, in PubMed (0–10) | Accuracy, beyond PubMed (0–10) | Fabricated studies rejected |");
    expect(md).toContain("|---|--:|--:|--:|--:|--:|--:|--:|--:|--:|--:|--|");
    const columns = (md: string): number => md.split("\n").find((l) => l.startsWith("| mcp |"))!.split("|").length;
    const header = (md: string): number => md.split("\n").find((l) => l.startsWith("| Condition | Runs scored"))!.split("|").length;
    expect(columns(md)).toBe(header(md));
    const one = toMarkdown(buildSummary(mixed(10, 0), meta(["mcp", "pubmed"])));
    expect(one).not.toContain("beyond PubMed");
    expect(one).toContain("| Condition | Runs scored | Accuracy, keyed queries (0–10) | Fabricated studies rejected |");
    expect(one).toContain("|---|--:|--:|--:|--:|--:|--:|--:|--:|--|");
    expect(toMarkdown(buildSummary(mixed(0, 10), meta(["mcp", "pubmed"])))).not.toContain("Accuracy, in PubMed");
  });

  it("add two subsets to mcp vs pubmed, in the same Holm family", () => {
    const ts = tests(s);
    expect(ts.map((t) => `${t.a}/${t.b}/${t.subset}`)).toEqual(["mcp/pubmed/keyed", "mcp/pubmed/keyed-in-pubmed", "mcp/pubmed/keyed-beyond-pubmed"]);
    expect(ts[1]).toMatchObject({ n: 10 });
    expect(ts[2]).toMatchObject({ n: 10 });
    // Like for like, mcp is the one that lost points on two queries: pubmed scores 10 on all of them.
    expect(ts[1]!.meanDiff).toBeLessThan(0);
    expect(ts[2]!.meanDiff).toBeGreaterThan(9);
    // One family: the smallest p is multiplied by the number of tests, three here.
    const smallest = Math.min(...ts.map((t) => t.p_value));
    expect(ts.find((t) => t.p_value === smallest)!.p_value_holm).toBeCloseTo(Math.min(1, 3 * smallest), 6);
    const md = toMarkdown(s);
    expect(md).toContain("**mcp vs pubmed**, keyed queries a PubMed abstract answers (like for like)");
    expect(md).toContain("**mcp vs pubmed**, keyed queries beyond PubMed");
  });

  it("share the Holm family with the other pairs of the report", () => {
    const rows = mixed(10, 10, ["mcp", "pubmed"]).concat(mixed(10, 10, ["closed-book"]));
    const ts = tests(buildSummary(rows, meta(["closed-book", "mcp", "pubmed"])));
    // mcp vs closed-book (keyed), then mcp vs pubmed with its two subsets: four tests in all.
    expect(ts).toHaveLength(4);
    const smallest = Math.min(...ts.map((t) => t.p_value));
    expect(ts.find((t) => t.p_value === smallest)!.p_value_holm).toBeCloseTo(Math.min(1, 4 * smallest), 6);
  });

  it("say that plain PubMed tools cannot reach them, and only when the subsets exist", () => {
    const md = toMarkdown(s);
    expect(md).toContain("cannot reach them by construction");
    expect(md).toContain("measures what the extra reach is worth, not answer quality");
    expect(md).toContain("`keyed-in-pubmed` is the like-for-like comparison");
    const plain = toMarkdown(buildSummary(mixed(10, 0), meta(["mcp", "pubmed"])));
    expect(plain).not.toContain("cannot reach them by construction");
    expect(tests(buildSummary(mixed(10, 0), meta(["mcp", "pubmed"]))).map((t) => t.subset)).toEqual(["keyed"]);
  });

  it("do not split other baselines, or a split whose pair has only one kind", () => {
    const closed = buildSummary(mixed(10, 10, ["mcp", "closed-book"]), meta(["closed-book", "mcp"]));
    expect(tests(closed).map((t) => t.subset)).toEqual(["keyed"]);
    const web = buildSummary(mixed(10, 10, ["mcp", "web-search"]), meta(["web-search", "mcp"]));
    expect(tests(web).map((t) => t.subset)).toEqual(["keyed"]);
  });

  it("the categories of the new kinds appear in the category table", () => {
    const byCategory = s.splits.dev!.category_accuracy.m1!;
    expect(Object.keys(byCategory)).toEqual(["lookup", "preprint"]);
    expect(byCategory.preprint!.pubmed).toEqual({ mean: 0, queries: 10 });
  });
});

describe("p-values in the report", () => {
  // 40 queries where the first condition always wins: the exact two-sided p is 2 / 2^40, about 1.8e-12.
  const rows = Array.from({ length: 40 }, (_, i) => [
    row({ query_id: `w${String(i).padStart(2, "0")}`, condition: "closed-book", accuracy: i / 10 }),
    row({ query_id: `w${String(i).padStart(2, "0")}`, condition: "mcp", accuracy: 10 }),
  ]).flat();
  const s = buildSummary(rows, meta());

  it("one that four decimals cannot show prints as p<0.0001, and summary.json keeps its value", () => {
    const t = tests(s)[0]!;
    expect(t.p_value).toBeGreaterThan(0);
    expect(t.p_value).toBeLessThan(1e-6);
    expect(t.p_value_holm).toBeGreaterThan(0);
    expect(JSON.parse(JSON.stringify(s)).splits.dev.tests.m1[0].p_value).toBe(t.p_value);
    const md = toMarkdown(s);
    expect(md).toContain("p<0.0001, p_holm<0.0001");
    expect(md).not.toMatch(/p=0\.0[,)]|p_holm=0\.0[,)]/);
  });

  it("formats the others with two significant digits", () => {
    expect(fmtP("p", 0.5)).toBe("p=0.50");
    expect(fmtP("p", 1)).toBe("p=1.0");
    expect(fmtP("p_holm", 0.00012)).toBe("p_holm=0.00012");
    expect(fmtP("p", 0.0001)).toBe("p=0.00010");
    expect(fmtP("p", 0.00009)).toBe("p<0.0001");
    expect(fmtP("p_holm", 0)).toBe("p_holm<0.0001");
  });
});
