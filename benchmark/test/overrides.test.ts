import { describe, expect, it } from "vitest";
import { applyOverrides, parseOverrides, type RawRowWithBreakdown } from "../lib/overrides.js";
import { compositeForCategory } from "../lib/scoring/composite.js";
import type { ScoreBreakdown, ScoreOverride, ScoreRow } from "../lib/types.js";

function makeRow(over: Partial<ScoreRow> = {}): ScoreRow {
  const base: ScoreRow = {
    query_id: "q1",
    category: "synthesis",
    condition: "mcp",
    model: "m1",
    run: 1,
    status: "ok",
    accuracy: 6,
    accuracy_source: "proxy",
    evidence_quality: 4,
    bullshit_score: 1,
    speed_s: 10,
    input_tokens: 1000,
    output_tokens: 500,
    total_tokens: 1500,
    tool_calls: 2,
    tools_used: "search",
    pmids_cited: 3,
    pmids_valid: 3,
    pmids_fabricated: 0,
    other_citations: 0,
    composite: 0,
    ...over,
  };
  base.composite = over.composite ?? compositeForCategory(base.category, {
    accuracy: base.accuracy,
    evidenceQuality: base.evidence_quality,
    bullshitScore: base.bullshit_score,
    speedS: base.speed_s,
    totalTokens: base.total_tokens,
  });
  return base;
}

const raw = (row: ScoreRow): RawRowWithBreakdown => ({
  filename: "x.json",
  row,
  breakdown: { answerKeyVersion: 1 } as ScoreBreakdown,
  record: {},
});

const ov = (o: Partial<ScoreOverride>): ScoreOverride => ({
  queryId: "q1",
  condition: "mcp",
  model: "m1",
  run: 1,
  reason: "r",
  ...o,
});

const apply = (row: ScoreRow, overrides: ScoreOverride[]) =>
  applyOverrides([raw(row)], { overrides }, new Map([["q1", 1]]));

describe("applyOverrides: composite recomputation", () => {
  it("accuracy 6 -> 1 changes the composite and marks the source human", () => {
    const row = makeRow();
    const before = row.composite;
    const res = apply(row, [ov({ accuracy: 1, author: "a" })]);
    const out = res.rows[0]!;
    expect(out.accuracy).toBe(1);
    expect(out.accuracy_source).toBe("human");
    expect(out.composite).toBeLessThan(before);
    expect(out.composite).toBe(
      compositeForCategory("synthesis", { accuracy: 1, evidenceQuality: 4, bullshitScore: 1, speedS: 10, totalTokens: 1500 }),
    );
  });

  it("null component becomes NaN and the recomputed composite is NaN", () => {
    const res = apply(makeRow(), [ov({ accuracy: null })]);
    expect(res.rows[0]!.accuracy).toBeNaN();
    expect(res.rows[0]!.composite).toBeNaN();
    expect(res.excluded).toContain("q1|mcp|m1|1:accuracy");
  });

  it("an explicit composite wins over recomputation (number or null)", () => {
    const a = apply(makeRow(), [ov({ accuracy: 1, composite: 7.5 })]);
    expect(a.rows[0]!.composite).toBe(7.5);
    const b = apply(makeRow(), [ov({ accuracy: 1, composite: null })]);
    expect(b.rows[0]!.composite).toBeNaN();
  });

  it("rows with no override keep their composite and source", () => {
    const row = makeRow();
    const res = apply(row, [ov({ queryId: "other" })]);
    expect(res.rows[0]).toEqual(row);
    expect(res.warnings.some((w) => w.includes("matched no rows"))).toBe(true);
  });

  it("bullshit rows recompute with the bullshit rule", () => {
    const row = makeRow({ category: "bullshit", bullshit_score: 1 });
    const res = apply(row, [ov({ bullshit_score: 0 })]);
    expect(res.rows[0]!.composite).toBe(0);
  });
});

describe("applyOverrides: multi-grader rule", () => {
  it("averages exact entries from distinct authors", () => {
    const res = apply(makeRow(), [ov({ accuracy: 4, author: "a" }), ov({ accuracy: 8, author: "b" })]);
    expect(res.rows[0]!.accuracy).toBe(6);
    expect(res.applied.get("q1|mcp|m1|1")!.authors).toEqual(["a", "b"]);
  });

  it("same author repeated: last wins", () => {
    const res = apply(makeRow(), [ov({ accuracy: 4, author: "a" }), ov({ accuracy: 9, author: "a" })]);
    expect(res.rows[0]!.accuracy).toBe(9);
    expect(res.applied.get("q1|mcp|m1|1")!.authors).toEqual(["a"]);
  });

  it("missing authors count as one anonymous grader", () => {
    const res = apply(makeRow(), [ov({ accuracy: 2 }), ov({ accuracy: 10 })]);
    expect(res.rows[0]!.accuracy).toBe(10);
  });

  it("exact entries override wildcard entries; wildcards apply in file order", () => {
    const res = apply(makeRow(), [
      ov({ model: "*", accuracy: 3 }),
      ov({ condition: "*", accuracy: 5 }),
      ov({ accuracy: 8, author: "a" }),
    ]);
    expect(res.rows[0]!.accuracy).toBe(8);
    const wildOnly = apply(makeRow(), [ov({ model: "*", accuracy: 3 }), ov({ condition: "*", accuracy: 5 })]);
    expect(wildOnly.rows[0]!.accuracy).toBe(5);
  });

  it("averages per dimension independently", () => {
    const res = apply(makeRow(), [
      ov({ accuracy: 2, author: "a" }),
      ov({ accuracy: 4, evidence_quality: 2, author: "b" }),
    ]);
    expect(res.rows[0]!.accuracy).toBe(3);
    expect(res.rows[0]!.evidence_quality).toBe(2);
  });
});

describe("parseOverrides validation", () => {
  const good = { queryId: "q1", condition: "mcp", model: "m", run: 1, reason: "r", accuracy: 5 };
  const parse = (o: Record<string, unknown>) => parseOverrides(JSON.stringify({ overrides: [{ ...good, ...o }] }));

  it("accepts a valid entry and wildcards", () => {
    expect(() => parse({})).not.toThrow();
    expect(() => parse({ run: "*", condition: "*", model: "*", author: "me", composite: null })).not.toThrow();
  });

  it.each([
    [{ run: 0 }, /run/],
    [{ run: 1.5 }, /run/],
    [{ run: "2" }, /run/],
    [{ model: 3 }, /model/],
    [{ author: 5 }, /author/],
    [{ condition: "x" }, /condition/],
    [{ reason: "" }, /reason/],
    [{ accuracy: 11 }, /accuracy/],
    [{ accuracy: -1 }, /accuracy/],
    [{ evidence_quality: 5.5 }, /evidence_quality/],
    [{ bullshit_score: 1.2 }, /bullshit_score/],
    [{ composite: 10.1 }, /composite/],
    [{ accuracy: "5" }, /accuracy/],
  ])("rejects %j", (patch, re) => {
    expect(() => parse(patch)).toThrow(re);
  });
});
