import { describe, expect, it } from "vitest";
import { toCsv } from "../lib/report/csv.js";
import { renderCharts } from "../lib/report/charts.js";
import type { ConditionId, ScoreRow } from "../lib/types.js";

function row(over: Partial<ScoreRow> = {}): ScoreRow {
  return {
    query_id: "q1",
    category: "synthesis",
    condition: "mcp",
    model: "m1",
    run: 1,
    status: "ok",
    accuracy: 5,
    accuracy_source: "human",
    evidence_quality: 3,
    bullshit_score: 1,
    speed_s: 10,
    input_tokens: 100,
    output_tokens: 50,
    total_tokens: 150,
    tool_calls: 1,
    tools_used: "a,b",
    pmids_cited: 2,
    pmids_valid: 2,
    pmids_fabricated: 0,
    other_citations: 1,
    composite: 5,
    ...over,
  };
}

describe("toCsv", () => {
  it("writes NaN as an empty cell and includes the new columns", () => {
    const csv = toCsv([row({ accuracy: Number.NaN, composite: Number.NaN })]);
    const [header, line] = csv.trim().split("\n");
    const cols = header!.split(",");
    for (const c of ["status", "accuracy_source", "total_tokens", "other_citations"]) expect(cols).toContain(c);
    expect(csv).not.toContain("NaN");
    const cells = line!.replace(/"a,b"/, "ab").split(",");
    expect(cells[cols.indexOf("accuracy")]).toBe("");
    expect(cells[cols.indexOf("composite")]).toBe("");
    expect(cells[cols.indexOf("status")]).toBe("ok");
    expect(cells[cols.indexOf("total_tokens")]).toBe("150");
  });
});

describe("renderCharts", () => {
  const conds: ConditionId[] = ["closed-book", "web-search", "mcp"];
  const rows: ScoreRow[] = [];
  for (const condition of conds) {
    for (let i = 0; i < 4; i++) {
      rows.push(row({ condition, run: i + 1, accuracy: 3 + i, composite: 4 + i, speed_s: 5 + i * 7 }));
    }
    rows.push(row({ condition, run: 9, category: "bullshit", bullshit_score: 1, composite: 10 }));
    rows.push(row({ condition, run: 10, status: "provider-error", accuracy: 0, composite: 0 }));
    rows.push(row({ condition, run: 11, accuracy: Number.NaN, composite: Number.NaN, evidence_quality: Number.NaN }));
    rows.push(row({ condition, run: 12, status: "truncated", speed_s: Number.NaN }));
  }

  it("renders all charts without NaN in the SVG", () => {
    const charts = renderCharts(rows);
    expect(Object.keys(charts).length).toBeGreaterThanOrEqual(6);
    for (const [name, svg] of Object.entries(charts)) {
      expect(svg, name).toContain("<svg");
      expect(svg, name).not.toContain("NaN");
    }
  });

  it("does not plot non-ok rows in the scatter", () => {
    const svg = renderCharts(rows)["speed-vs-accuracy-scatter.svg"]!;
    // 3 conditions × (4 regular + 1 bullshit) ok rows with finite values; the NaN row is dropped too.
    expect((svg.match(/<circle/g) ?? []).length).toBe(15);
  });

  it("renders when every row is bullshit-only or empty", () => {
    expect(() => renderCharts([])).not.toThrow();
    const onlyBs = renderCharts([row({ category: "bullshit" })]);
    for (const svg of Object.values(onlyBs)) expect(svg).not.toContain("NaN");
  });
});
