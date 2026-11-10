import { describe, expect, it } from "vitest";
import { applyOverrides, parseOverrides, type RawRowWithBreakdown } from "../lib/overrides.js";
import type { ScoreBreakdown, ScoreOverride, ScoreRow } from "../lib/types.js";
import { scoreRow } from "./helpers.js";

/** An ungraded rubric answer, the row grade.ts works on. */
const makeRow = (over: Partial<ScoreRow> = {}): ScoreRow =>
  scoreRow({ category: "synthesis", key_kind: "rubric", accuracy: Number.NaN, accuracy_source: "ungraded", evidence_quality: 4, ...over });

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

describe("applyOverrides: human grades", () => {
  it("a grade gives an ungraded rubric answer its accuracy and marks the source human", () => {
    const res = apply(makeRow(), [ov({ accuracy: 7, author: "a" })]);
    const out = res.rows[0]!;
    expect(out.accuracy).toBe(7);
    expect(out.accuracy_source).toBe("human");
    expect(out.accuracy_graders).toBe(1);
  });

  it("null makes a score unscored and lists it as excluded", () => {
    const res = apply(scoreRow(), [ov({ accuracy: null })]);
    expect(res.rows[0]!.accuracy).toBeNaN();
    expect(res.rows[0]!.accuracy_source).toBe("deterministic");
    expect(res.excluded).toContain("q1|mcp|m1|1:accuracy");
  });

  it("rows with no override are left alone, and an entry that matches nothing warns", () => {
    const row = makeRow();
    const res = apply(row, [ov({ queryId: "other" })]);
    expect(res.rows[0]).toEqual(row);
    expect(res.warnings.some((w) => w.includes("matched no rows"))).toBe(true);
  });

  it("an old entry that sets the removed composite is ignored with a warning", () => {
    const row = makeRow();
    const res = apply(row, [{ ...ov({}), composite: 7.5 } as ScoreOverride]);
    expect(res.rows[0]).toEqual(row);
    expect(res.warnings.some((w) => w.includes('"composite"'))).toBe(true);
  });
});

describe("applyOverrides: fabricated-study and control rows", () => {
  const reject = (bullshit_score: number) =>
    scoreRow({ category: "bullshit", key_kind: "reject", bullshit_score, accuracy: bullshit_score * 10, accuracy_source: "reject" });

  it("correcting the premise score moves the accuracy with it", () => {
    // The lexical detector accepted "I couldn't verify it, but it found a 12% gain": a human marks it wrong.
    const res = apply(reject(1), [ov({ bullshit_score: 0, author: "a" })]);
    expect(res.rows[0]!.bullshit_score).toBe(0);
    expect(res.rows[0]!.accuracy).toBe(0);
    expect(res.rows[0]!.accuracy_source).toBe("human");
    expect(res.rows[0]!.accuracy_graders).toBe(1);
    const up = apply(reject(0), [ov({ bullshit_score: 1, author: "a" }), ov({ bullshit_score: 1, author: "b" })]);
    expect(up.rows[0]!.accuracy).toBe(10);
    expect(up.rows[0]!.accuracy_graders).toBe(2);
  });

  it("works the same on a real-study control", () => {
    const control = scoreRow({ category: "control", key_kind: "accept", bullshit_score: 0, accuracy: 0, accuracy_source: "accept" });
    expect(apply(control, [ov({ bullshit_score: 1, author: "a" })]).rows[0]!.accuracy).toBe(10);
  });

  it("an explicit accuracy in the same override wins", () => {
    const res = apply(reject(1), [ov({ bullshit_score: 0, accuracy: 5, author: "a" })]);
    expect(res.rows[0]!.accuracy).toBe(5);
  });

  it("does not touch the accuracy of other kinds of row", () => {
    const res = apply(scoreRow({ accuracy: 10 }), [ov({ bullshit_score: 0 })]);
    expect(res.rows[0]!.accuracy).toBe(10);
    expect(res.rows[0]!.accuracy_source).toBe("deterministic");
  });
});

describe("applyOverrides: multi-grader rule", () => {
  it("averages exact entries from distinct authors and counts the graders", () => {
    const res = apply(makeRow(), [ov({ accuracy: 4, author: "a" }), ov({ accuracy: 8, author: "b" })]);
    expect(res.rows[0]!.accuracy).toBe(6);
    expect(res.rows[0]!.accuracy_graders).toBe(2);
    expect(res.applied.get("q1|mcp|m1|1")!.authors).toEqual(["a", "b"]);
  });

  it("same author repeated: last wins, and it is still one grader", () => {
    const res = apply(makeRow(), [ov({ accuracy: 4, author: "a" }), ov({ accuracy: 9, author: "a" })]);
    expect(res.rows[0]!.accuracy).toBe(9);
    expect(res.rows[0]!.accuracy_graders).toBe(1);
    expect(res.applied.get("q1|mcp|m1|1")!.authors).toEqual(["a"]);
  });

  it("missing authors count as one anonymous grader", () => {
    const res = apply(makeRow(), [ov({ accuracy: 2 }), ov({ accuracy: 10 })]);
    expect(res.rows[0]!.accuracy).toBe(10);
    expect(res.rows[0]!.accuracy_graders).toBe(1);
  });

  it("exact entries override wildcard entries; wildcards apply in file order and count as one grader", () => {
    const res = apply(makeRow(), [
      ov({ model: "*", accuracy: 3 }),
      ov({ condition: "*", accuracy: 5 }),
      ov({ accuracy: 8, author: "a" }),
    ]);
    expect(res.rows[0]!.accuracy).toBe(8);
    const wildOnly = apply(makeRow(), [ov({ model: "*", accuracy: 3 }), ov({ condition: "*", accuracy: 5 })]);
    expect(wildOnly.rows[0]!.accuracy).toBe(5);
    expect(wildOnly.rows[0]!.accuracy_graders).toBe(1);
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

  it("accepts a valid entry, wildcards and every condition", () => {
    expect(() => parse({})).not.toThrow();
    expect(() => parse({ run: "*", condition: "*", model: "*", author: "me" })).not.toThrow();
    expect(() => parse({ condition: "pubmed" })).not.toThrow();
    // An entry from before the composite was removed still loads.
    expect(() => parse({ composite: null })).not.toThrow();
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
    [{ accuracy: "5" }, /accuracy/],
  ])("rejects %j", (patch, re) => {
    expect(() => parse(patch)).toThrow(re);
  });
});
