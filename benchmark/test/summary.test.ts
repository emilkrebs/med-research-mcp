import { describe, expect, it } from "vitest";
import { buildSummary, toMarkdown, type SummaryMeta } from "../lib/report/summary.js";
import type { Category, ConditionId, ScoreRow } from "../lib/types.js";

function row(over: Partial<ScoreRow>): ScoreRow {
  return {
    query_id: "q1",
    category: "synthesis",
    condition: "mcp",
    model: "m1",
    run: 1,
    status: "ok",
    accuracy: 5,
    accuracy_source: "deterministic",
    evidence_quality: 3,
    bullshit_score: 1,
    speed_s: 10,
    input_tokens: 100,
    output_tokens: 50,
    total_tokens: 150,
    tool_calls: 1,
    tools_used: "",
    pmids_cited: 2,
    pmids_valid: 2,
    pmids_fabricated: 0,
    other_citations: 0,
    composite: 5,
    ...over,
  };
}

const meta = (conditions: ConditionId[] = ["closed-book", "mcp"], over: Partial<SummaryMeta> = {}): SummaryMeta => ({
  timestamp: "t",
  mcp_version: "v",
  mcp_commit: "c",
  benchmark_version: "b",
  models: ["m1"],
  conditions,
  runs: 1,
  total_responses: 0,
  weights: {},
  normalization: {},
  unverified_queries: [],
  ...over,
});

/** 12 queries: mcp beats closed-book by a noisy, mostly-positive margin. */
function dataset(runs: number[]): ScoreRow[] {
  const rows: ScoreRow[] = [];
  for (let q = 0; q < 12; q++) {
    for (const run of runs) {
      rows.push(row({ query_id: `q${q}`, condition: "closed-book", run, composite: 4 + (q % 4) * 0.3 }));
      rows.push(row({ query_id: `q${q}`, condition: "mcp", run, composite: 4.5 + (q % 5) * 0.4 + q * 0.05 }));
    }
  }
  return rows;
}

type Cond = { n: number; n_ok: number; composite: { mean: number | null }; accuracy: { mean: number | null }; accuracy_verified: { mean: number | null }; accuracy_proxy_n: number; provider_error_rate: number; truncated_rate: number; scoring_error_rate: number };
const cond = (s: Record<string, unknown>, model: string, c: string): Cond => (s[model] as Record<string, Cond>)[c]!;

describe("buildSummary status handling", () => {
  it("excludes non-ok rows from means and reports rates", () => {
    const rows = [
      row({ run: 1, composite: 6 }),
      row({ run: 2, composite: 8 }),
      row({ run: 3, composite: 0, status: "provider-error" }),
      row({ run: 4, composite: 0, status: "truncated" }),
      row({ run: 5, composite: 0, status: "scoring-error" }),
    ];
    const s = buildSummary(rows, meta(["mcp"]));
    const c = cond(s, "m1", "mcp");
    expect(c.n).toBe(5);
    expect(c.n_ok).toBe(2);
    expect(c.composite.mean).toBe(7);
    expect(c.provider_error_rate).toBeCloseTo(0.2);
    expect(c.truncated_rate).toBeCloseTo(0.2);
    expect(c.scoring_error_rate).toBeCloseTo(0.2);
  });
});

describe("buildSummary NaN handling", () => {
  it("means are over finite values only", () => {
    const rows = [row({ run: 1, accuracy: 4 }), row({ run: 2, accuracy: Number.NaN }), row({ run: 3, accuracy: 8 })];
    const c = cond(buildSummary(rows, meta(["mcp"])), "m1", "mcp");
    expect(c.accuracy.mean).toBe(6);
  });

  it("is null (not NaN) when no finite values exist, and survives JSON", () => {
    const s = buildSummary([row({ accuracy: Number.NaN, composite: Number.NaN })], meta(["mcp"]));
    expect(cond(s, "m1", "mcp").accuracy.mean).toBeNull();
    expect(JSON.stringify(s)).not.toContain("NaN");
  });
});

describe("pseudo-replication", () => {
  it("the same data across 3 runs gives the same n and p as 1 run", () => {
    const one = buildSummary(dataset([1]), meta());
    const three = buildSummary(dataset([1, 2, 3]), meta());
    const t1 = (one.statistical_tests as Record<string, { composite_mcp_vs_closed: { n: number; p_value: number } }>).m1!.composite_mcp_vs_closed;
    const t3 = (three.statistical_tests as Record<string, { composite_mcp_vs_closed: { n: number; p_value: number } }>).m1!.composite_mcp_vs_closed;
    expect(t1.n).toBe(12);
    expect(t3.n).toBe(12);
    expect(t3.p_value).toBeCloseTo(t1.p_value, 10);
  });

  it("drops queries where either side has no ok runs and reports Holm p", () => {
    const rows = dataset([1]).filter((r) => !(r.query_id === "q0" && r.condition === "mcp"));
    rows.find((r) => r.query_id === "q1" && r.condition === "closed-book")!.status = "truncated";
    const s = buildSummary(rows, meta());
    const t = (s.statistical_tests as Record<string, { composite_mcp_vs_closed: { n: number; p_value: number; p_value_holm: number } }>).m1!.composite_mcp_vs_closed;
    expect(t.n).toBe(10);
    expect(t.p_value_holm).toBeGreaterThanOrEqual(t.p_value);
  });

  it("Holm-adjusts across web and closed tests", () => {
    const rows = dataset([1]);
    for (const r of dataset([1])) if (r.condition === "closed-book") rows.push({ ...r, condition: "web-search", composite: r.composite + 0.2 });
    const s = buildSummary(rows, meta(["closed-book", "web-search", "mcp"]));
    const t = (s.statistical_tests as Record<string, Record<string, { p_value: number; p_value_holm: number }>>).m1!;
    const ps = [t.composite_mcp_vs_web!.p_value, t.composite_mcp_vs_closed!.p_value];
    const smallest = Math.min(...ps);
    const adjSmallest = t.composite_mcp_vs_web!.p_value === smallest ? t.composite_mcp_vs_web!.p_value_holm : t.composite_mcp_vs_closed!.p_value_holm;
    expect(adjSmallest).toBeCloseTo(Math.min(1, 2 * smallest), 5);
  });
});

describe("accuracy provenance", () => {
  const rows = [
    row({ run: 1, accuracy: 10, accuracy_source: "human" }),
    row({ run: 2, accuracy: 2, accuracy_source: "proxy" }),
    row({ run: 3, accuracy: 6, accuracy_source: "deterministic" }),
  ];

  it("reports verified accuracy separately from overall", () => {
    const c = cond(buildSummary(rows, meta(["mcp"])), "m1", "mcp");
    expect(c.accuracy.mean).toBe(6);
    expect(c.accuracy_verified.mean).toBe(8);
    expect(c.accuracy_proxy_n).toBe(1);
  });

  it("prints a prominent warning when proxy rows exist, and not otherwise", () => {
    expect(toMarkdown(buildSummary(rows, meta(["mcp"])))).toContain("1 rubric responses not human-graded — run grade.ts, then --rescore");
    const clean = toMarkdown(buildSummary([rows[0]!, rows[2]!], meta(["mcp"])));
    expect(clean).not.toContain("not human-graded");
  });
});

describe("markdown and category table", () => {
  it("lists only present conditions and labels effect sizes", () => {
    const md = toMarkdown(buildSummary(dataset([1]), meta()));
    expect(md).toContain("A=closed-book, C=mcp");
    expect(md).not.toContain("B=web-search");
    expect(md).toMatch(/dz=|r_rb=/);
    expect(md).toContain("p_holm=");
  });

  it("emits a per-category composite table in json and markdown", () => {
    const cats: Category[] = ["factual", "bullshit"];
    const rows = cats.flatMap((category) => [
      row({ category, condition: "closed-book", composite: 2 }),
      row({ category, condition: "mcp", composite: 8 }),
    ]);
    const s = buildSummary(rows, meta());
    const cc = s.category_composite as Record<string, Record<string, Record<string, { mean: number }>>>;
    expect(cc.m1!.factual!.mcp!.mean).toBe(8);
    expect(toMarkdown(s)).toContain("| factual | 2.00 | 8.00 |");
  });
});
