import { describe, expect, it } from "vitest";
import {
  collectRatings,
  computeAgreement,
  formatAgreement,
  icc21,
  itemIdFor,
  krippendorffAlpha,
} from "../lib/agreement.js";
import type { OverridesFile } from "../lib/types.js";

/**
 * Krippendorff (2011), "Computing Krippendorff's Alpha-Reliability", worked
 * example: 4 observers x 12 units with missing values (`null`). Published:
 * nominal alpha = 0.743, interval alpha = 0.849.
 */
const KRIPP: (number | null)[][] = [
  [1, 2, 3, 3, 2, 1, 4, 1, 2, null, null, null],
  [1, 2, 3, 3, 2, 2, 4, 1, 2, 5, null, 3],
  [null, 3, 3, 3, 2, 3, 4, 2, 2, 5, 1, null],
  [1, 2, 3, 3, 2, 4, 4, 1, 2, 5, 1, null],
];
const krippUnits = (): number[][] =>
  Array.from({ length: 12 }, (_, u) => KRIPP.map((row) => row[u]).filter((v): v is number => v !== null && v !== undefined));

describe("krippendorffAlpha", () => {
  it("matches Krippendorff's published nominal example (0.743)", () => {
    expect(krippendorffAlpha(krippUnits(), "nominal")).toBeCloseTo(0.743, 3);
  });

  it("matches Krippendorff's published interval example (0.849)", () => {
    expect(krippendorffAlpha(krippUnits(), "interval")).toBeCloseTo(0.849, 3);
  });

  it("equals 1 - MSW/MST for complete interval data (Krippendorff 2011 identity)", () => {
    // Shrout & Fleiss 1979 Table 2 ratings, one unit per target.
    const units = [[9, 2, 5, 8], [6, 1, 3, 2], [8, 4, 6, 8], [7, 1, 2, 6], [10, 5, 6, 9], [6, 2, 4, 7]];
    const all = units.flat();
    const grand = all.reduce((a, b) => a + b, 0) / all.length;
    const sst = all.reduce((s, v) => s + (v - grand) ** 2, 0);
    const ssw = units.reduce((s, u) => {
      const m = u.reduce((a, b) => a + b, 0) / u.length;
      return s + u.reduce((t, v) => t + (v - m) ** 2, 0);
    }, 0);
    const expected = 1 - ssw / (all.length - units.length) / (sst / (all.length - 1));
    expect(krippendorffAlpha(units, "interval")).toBeCloseTo(expected, 10);
  });

  it("is 1 for perfect agreement and ignores unpairable units", () => {
    expect(krippendorffAlpha([[1, 1], [5, 5], [9, 9], [3]])).toBe(1);
  });

  it("is NaN when no variation exists", () => {
    expect(krippendorffAlpha([[4, 4], [4, 4]])).toBeNaN();
  });
});

describe("icc21", () => {
  /**
   * Shrout & Fleiss (1979), "Intraclass correlations: uses in assessing rater
   * reliability", Psychological Bulletin 86(2), Table 2: 6 targets x 4 judges.
   * Published: ICC(1,1) = .17, ICC(2,1) = .29, ICC(3,1) = .71.
   */
  const SF = [
    [9, 2, 5, 8],
    [6, 1, 3, 2],
    [8, 4, 6, 8],
    [7, 1, 2, 6],
    [10, 5, 6, 9],
    [6, 2, 4, 7],
  ];

  it("matches the Shrout & Fleiss ICC(2,1) = .29", () => {
    expect(icc21(SF)).toBeCloseTo(0.29, 2);
  });

  it("is 1 for identical raters and needs >= 2x2", () => {
    expect(icc21([[1, 1], [5, 5], [9, 9]])).toBeCloseTo(1, 10);
    expect(icc21([[1, 2]])).toBeNaN();
  });
});

describe("collectRatings / computeAgreement", () => {
  const e = (queryId: string, run: number, author: string, accuracy: number) => ({
    queryId,
    condition: "mcp" as const,
    model: "m",
    run,
    accuracy,
    reason: "r",
    author,
  });
  const file: OverridesFile = {
    overrides: [
      e("q1", 1, "alice", 8), e("q1", 1, "bob", 7),
      e("q2", 1, "alice", 9), e("q2", 1, "bob", 3),
      e("q3", 1, "alice", 5), e("q3", 1, "bob", 5),
      e("q4", 1, "alice", 6), // single grader: excluded
      { queryId: "q5", condition: "*", model: "*", run: "*", accuracy: 1, reason: "r", author: "alice" }, // wildcard: ignored
      e("q1", 1, "alice", 8), // duplicate author: last wins, no double count
    ],
  };

  it("keeps the last entry per author and ignores wildcards", () => {
    const items = collectRatings(file);
    expect(items.map((i) => i.key.queryId).sort()).toEqual(["q1", "q2", "q3", "q4"]);
    expect(items.find((i) => i.key.queryId === "q1")!.ratings.size).toBe(2);
  });

  it("reports counts, mean abs diff and the disagreement list", () => {
    const r = computeAgreement(collectRatings(file));
    expect(r.itemCount).toBe(3);
    expect(r.graderCount).toBe(2);
    expect(r.meanAbsDiff).toBeCloseTo((1 + 6 + 0) / 3, 10);
    expect(r.iccItems).toBe(3);
    expect(r.disagreements).toHaveLength(1);
    expect(r.disagreements[0]).toMatchObject({ queryId: "q2", spread: 6, scores: { alice: 9, bob: 3 } });
    expect(r.disagreements[0]!.itemId).toBe(itemIdFor({ queryId: "q2", condition: "mcp", model: "m", run: 1 }));
    const text = formatAgreement(r);
    expect(text).toContain("q2");
    expect(text).toContain("alice=9, bob=3");
  });

  it("handles no multi-rated items", () => {
    const r = computeAgreement(collectRatings({ overrides: [e("q1", 1, "alice", 5)] }));
    expect(r.itemCount).toBe(0);
    expect(formatAgreement(r)).toMatch(/nothing to compare/);
  });
});
