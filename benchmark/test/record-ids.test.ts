/**
 * The id of a record outside PubMed as the first field of an answer line (`record: <id>`): which forms the real
 * scorer accepts. A `preprint` or `regional` key expects `record: <id>`, the id exactly as the server prints it,
 * as a lookup expects `pmid: <PMID>`. The ids come out of the server's own parsers, so a change in how it prints
 * them shows up here.
 */

import { describe, expect, it } from "vitest";
import { parseChinaRXiv, parseEuropePmc } from "../lib/core.js";
import { scoreAccuracy } from "../lib/scoring/accuracy.js";
import { extractCitations } from "../lib/scoring/verify.js";
import type { BenchmarkQuery } from "../lib/types.js";

/** What the server prints as the id (`pmid` field) of a preprint, a Chinese Biological Abstracts record and a ChinaXiv record. */
const printed = {
  preprint: parseEuropePmc({ resultList: { result: [{ id: "PPR123456", source: "PPR", title: "t", abstractText: "a" }] } } as never).articles[0]!.pmid,
  cba: parseEuropePmc({ resultList: { result: [{ id: "521529", source: "CBA", title: "t", abstractText: "a" }] } } as never).articles[0]!.pmid,
  chinaxiv: parseChinaRXiv({ data: [{ id: "chinaxiv-202608.00133", title: "t" }] } as never).articles[0]!.pmid,
};

const query = (id: string): BenchmarkQuery => ({
  id: "q",
  category: "preprint",
  prompt: "p",
  verified: true,
  answerKey: { kind: "values", expected: [`record: ${id}`, "randomized: 120", "mean change: 4.2"] },
});
const score = (id: string, written: string, numbers = "randomized: 120 | mean change: 4.2"): number =>
  scoreAccuracy(query(id), `I found it.\nANSWER — record: ${written} | ${numbers}`).score;

describe("what the server prints", () => {
  it("is PPR…, CBA:… and chinaxiv-…", () => {
    expect(printed).toEqual({ preprint: "PPR123456", cba: "CBA:521529", chinaxiv: "chinaxiv-202608.00133" });
  });
});

describe("the id as first field of an answer line", () => {
  it.each([
    ["preprint", ["PPR123456", "ppr123456", "PPR123456.", "**PPR123456**", "`PPR123456`", "PPR123456 (preprint)"]],
    ["cba", ["CBA:521529", "cba:521529", "CBA:521529.", "`CBA:521529`", "CBA:521529 (Chinese Biological Abstracts)"]],
    ["chinaxiv", ["chinaxiv-202608.00133", "ChinaXiv-202608.00133", "`chinaxiv-202608.00133`", "chinaxiv‑202608.00133"]],
  ] as const)("scores a %s id written as the server prints it, whatever the case, markdown or final period", (kind, forms) => {
    for (const form of forms) expect(score(printed[kind], form), form).toBe(10);
  });

  it("does not take a record's id for another record's, and keeps the numbers' share (a third each)", () => {
    expect(score(printed.cba, "CBA:549902")).toBeCloseTo(6.67, 2);
    expect(score(printed.preprint, "PPR123457")).toBeCloseTo(6.67, 2);
    expect(score(printed.cba, "CBA:521529", "randomized: 119 | mean change: 4.2")).toBeCloseTo(6.67, 2);
    expect(score(printed.cba, "CBA:549902", "randomized: 119 | mean change: 4.2")).toBeCloseTo(3.33, 2);
  });

  it("compares text, not records: a form the server does not print is a wrong id (6.67), and the model is told to give the id as the database shows it", () => {
    // Known limits of the scorer, which this change leaves as it is: the accuracy scorer does not canonicalize ids.
    for (const form of ["CBA 521529", "CBA: 521529", "CBA/521529", "CBA521529", "521529"]) expect(score(printed.cba, form), form).toBeCloseTo(6.67, 2);
    for (const form of ["PPR 123456", "123456", "europepmc:PPR123456"]) expect(score(printed.preprint, form), form).toBeCloseTo(6.67, 2);
    for (const form of ["chinaxiv:202608.00133", "chinaxiv 202608.00133", "202608.00133"]) expect(score(printed.chinaxiv, form), form).toBeCloseTo(6.67, 2);
  });

  it("is still read as a citation of its record by the scorer's audit", () => {
    for (const [id, database] of [[printed.preprint, "europepmc"], [printed.cba, "europepmc"], [printed.chinaxiv, "chinaxiv"]] as const) {
      expect(extractCitations(`ANSWER — record: ${id} | randomized: 120`).regional).toEqual([{ database, id }]);
    }
  });
});
