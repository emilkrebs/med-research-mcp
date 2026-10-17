import { describe, expect, it } from "vitest";
import { scoreAccuracy } from "../lib/scoring/accuracy.js";
import type { BenchmarkQuery } from "../lib/types.js";
import type { CitationAudit } from "../lib/scoring/verify.js";

const audit: CitationAudit = { cited: [], valid: [], fabricated: [], evidenceQuality: 0, other: [], echoedFromPrompt: [] };

const q = (expected: string[]): BenchmarkQuery => ({
  id: "t",
  category: "factual",
  prompt: "p",
  answerKey: { kind: "values", expected },
  verified: true,
});

const score = (expected: string[], text: string) => scoreAccuracy(q(expected), text, audit);

describe("values ANSWER-line parser", () => {
  it("'rct: not sure' does not match 'rct: no'", () => {
    const r = score(["rct: no", "study type: cohort"], "ANSWER — rct: not sure | study type: cohort");
    expect(r.score).toBe(5);
    expect(r.detail.hits).toEqual(["study type: cohort"]);
    expect(r.detail.missed).toEqual(["rct: no"]);
  });

  it("a hedge in the body does not score the hedged value", () => {
    const text = "Not study type: cohort. ANSWER — study type: randomized-controlled-trial";
    expect(score(["study type: cohort"], text).score).toBe(0);
    expect(score(["study type: randomized-controlled-trial"], text).score).toBe(10);
  });

  it("handles markdown and '5 / 5'", () => {
    expect(score(["study type: meta-analysis"], "**ANSWER — study type:** meta-analysis").score).toBe(10);
    expect(score(["study type: meta-analysis"], "ANSWER — **study type:** meta-analysis").score).toBe(10);
    expect(score(["evidence score: 5/5"], "ANSWER — study type: x | evidence score: 5 / 5").score).toBe(10);
  });

  it("accepts qualifiers after the value but not longer numbers", () => {
    expect(score(["hazard ratio: 0.74"], "ANSWER — PMID: 27633186 | hazard ratio: 0.74 (95% CI 0.58–0.95)").score).toBe(10);
    expect(score(["hazard ratio: 0.74"], "ANSWER — hazard ratio: 0.745").score).toBe(0);
    expect(score(["pmid: 28202713"], "ANSWER — PMID: 28202713.").score).toBe(10);
  });

  it("uses the LAST ANSWER line and tolerates unicode dashes and colons", () => {
    const text = "ANSWER — pmid: 1\nrevised:\nANSWER: pmid: 28202713";
    expect(score(["pmid: 28202713"], text).score).toBe(10);
    expect(score(["pmid: 28202713"], "answer – PMID: 28202713").score).toBe(10);
  });

  it("no ANSWER line scores 0 with everything missed, even if tokens appear in prose", () => {
    const r = score(["study type: cohort", "rct: no"], "It is a cohort study, so rct: no, study type: cohort");
    expect(r.score).toBe(0);
    expect(r.detail.answerLine).toBeUndefined();
    expect(r.detail.missed).toEqual(["study type: cohort", "rct: no"]);
  });

  it("records the answer line", () => {
    const r = score(["pmid: 1"], "intro\nANSWER — PMID: 1");
    expect(r.detail.answerLine).toBe("ANSWER — PMID: 1");
  });
});

describe("other kinds", () => {
  it("rubric uses the citation proxy", () => {
    const query: BenchmarkQuery = { ...q([]), answerKey: { kind: "rubric", rubric: "r", expectPmids: true } };
    expect(scoreAccuracy(query, "x", audit).score).toBe(0);
    const valid = [{ pmid: "1", exists: true, evidenceScore: 4, studyType: "cohort" as const, title: "", abstract: "" }];
    expect(scoreAccuracy(query, "x", { ...audit, valid, evidenceQuality: 4 }).score).toBe(8);
  });
});
