import { describe, expect, it } from "vitest";
import { CSV_COLUMNS, toCsv } from "../lib/report/csv.js";
import { renderCharts } from "../lib/report/charts.js";
import type { ConditionId, ScoreRow } from "../lib/types.js";
import { scoreRow } from "./helpers.js";

const row = (over: Partial<ScoreRow> = {}): ScoreRow => scoreRow({ tools_used: "a,b", other_citations: 1, ...over });

describe("toCsv", () => {
  it("writes NaN as an empty cell and has the columns a reader needs to filter on", () => {
    const csv = toCsv([row({ accuracy: Number.NaN, key_kind: "rubric", accuracy_source: "ungraded", split: "test", retrieval_only: true })]);
    const [header, line] = csv.trim().split("\n");
    const cols = header!.split(",");
    for (const c of ["status", "split", "key_kind", "retrieval_only", "accuracy_source", "total_tokens", "pmids_off_topic", "other_citations"]) expect(cols).toContain(c);
    expect(cols).not.toContain("composite");
    expect(cols).toEqual(CSV_COLUMNS);
    expect(csv).not.toContain("NaN");
    const cells = line!.replace(/"a,b"/, "ab").split(",");
    expect(cells[cols.indexOf("accuracy")]).toBe("");
    expect(cells[cols.indexOf("bullshit_score")]).toBe("");
    expect(cells[cols.indexOf("accuracy_graders")]).toBe("");
    expect(cells[cols.indexOf("status")]).toBe("ok");
    expect(cells[cols.indexOf("split")]).toBe("test");
    expect(cells[cols.indexOf("key_kind")]).toBe("rubric");
    expect(cells[cols.indexOf("retrieval_only")]).toBe("true");
    expect(cells[cols.indexOf("total_tokens")]).toBe("150");
  });
});

describe("renderCharts", () => {
  const conds: ConditionId[] = ["closed-book", "web-search", "pubmed", "mcp"];
  const rows: ScoreRow[] = [];
  for (const condition of conds) {
    for (let i = 0; i < 4; i++) {
      rows.push(row({ condition, query_id: `q${i}`, accuracy: 3 + i, speed_s: 5 + i * 7 }));
    }
    rows.push(row({ condition, query_id: "f1", category: "bullshit", key_kind: "reject", bullshit_score: 1, accuracy: 10 }));
    rows.push(row({ condition, query_id: "c1", category: "control", key_kind: "accept", bullshit_score: 0, accuracy: 0 }));
    rows.push(row({ condition, query_id: "q5", status: "provider-error", accuracy: Number.NaN }));
    rows.push(row({ condition, query_id: "r1", key_kind: "rubric", accuracy: Number.NaN, evidence_quality: Number.NaN }));
    rows.push(row({ condition, query_id: "q6", status: "timeout", accuracy: 0, accuracy_source: "failed", speed_s: 300 }));
    rows.push(row({ condition, query_id: "q7", status: "no-answer", accuracy: 0, accuracy_source: "failed", speed_s: Number.NaN }));
  }

  it("renders every chart without NaN in the SVG, and none of the composite-era ones", () => {
    const charts = renderCharts(rows);
    expect(Object.keys(charts).sort()).toEqual([
      "accuracy-bars.svg",
      "bullshit-rate.svg",
      "control-acceptance-rate.svg",
      "evidence-histogram.svg",
      "fabrication-rate.svg",
      "misattribution-rate.svg",
      "speed-vs-accuracy-scatter.svg",
    ]);
    for (const [name, svg] of Object.entries(charts)) {
      expect(svg, name).toContain("<svg");
      expect(svg, name).not.toContain("NaN");
      expect(svg, name).not.toMatch(/composite/i);
    }
  });

  it("plots scored runs in the scatter: failures at 0, but not missing or ungraded runs", () => {
    const svg = renderCharts(rows)["speed-vs-accuracy-scatter.svg"]!;
    // Per condition: 4 keyed + reject + accept + the timeout (accuracy 0, 300 s). The no-answer row has no time,
    // the provider error no score, the rubric row no grade.
    expect((svg.match(/<circle/g) ?? []).length).toBe(conds.length * 7);
  });

  it("the accuracy bar counts failures as 0 and leaves rubric rows out", () => {
    const one = renderCharts([
      row({ query_id: "a", accuracy: 10 }),
      row({ query_id: "b", accuracy: 0, status: "no-answer", accuracy_source: "failed" }),
      row({ query_id: "r", key_kind: "rubric", accuracy: 9, accuracy_source: "human" }),
    ])["accuracy-bars.svg"]!;
    expect(one).toContain(">5.00<");
  });

  it("says which set a chart shows, preferring the held-out one", () => {
    expect(renderCharts(rows)["accuracy-bars.svg"]).toContain("development set");
    const mixed = [...rows, row({ split: "test", query_id: "t1", accuracy: 2 })];
    const svg = renderCharts(mixed)["accuracy-bars.svg"]!;
    expect(svg).toContain("held-out set");
    expect(svg).toContain(">2.00<");
  });

  it("renders when every row is bullshit-only or empty", () => {
    expect(() => renderCharts([])).not.toThrow();
    const onlyBs = renderCharts([row({ category: "bullshit", key_kind: "reject", bullshit_score: 1 })]);
    for (const svg of Object.values(onlyBs)) expect(svg).not.toContain("NaN");
  });
});
