import { describe, expect, it } from "vitest";
import { buildJudgePrompt, parseArgs, parseJudgeReply } from "../judge.js";
import type { GradeView } from "../grade.js";

const view: GradeView = {
  itemId: "abc123",
  prompt: "What dose of X was studied?",
  rubric: "Full marks only if a dose is named and the cited abstract reports it.",
  answer: "300 mg/day (PMID 111).",
  pmids: [
    { pmid: "111", valid: true, studyType: "randomized-controlled-trial", designTier: 4, title: "X trial" },
    { pmid: "999", valid: false, studyType: "unknown", title: "(no title)" },
  ],
};

describe("buildJudgePrompt", () => {
  it("shows the blind grading view plus cited abstracts, and marks fabricated citations", () => {
    const p = buildJudgePrompt(view, new Map([["111", "Participants received 300 mg/day."]]));
    expect(p).toContain("QUESTION:\nWhat dose of X was studied?");
    expect(p).toContain("RUBRIC (grade against this):");
    expect(p).toContain("PMID 111 — VALID | randomized-controlled-trial | X trial\nAbstract: Participants received 300 mg/day.");
    expect(p).toContain("PMID 999 — FABRICATED");
    // Blind: nothing identifying the condition, model or run.
    expect(p).not.toMatch(/mcp|closed-book|haiku|run \d/i);
  });
});

describe("parseJudgeReply", () => {
  it("reads JSON, even wrapped in prose or a code fence", () => {
    expect(parseJudgeReply('{"score": 7.25, "reason": "ok"}')).toEqual({ score: 7.3, reason: "ok" });
    expect(parseJudgeReply('Here:\n```json\n{"score": 4, "reason": "weak"}\n```')).toEqual({ score: 4, reason: "weak" });
  });

  it("rejects malformed or out-of-range replies", () => {
    expect(parseJudgeReply("seven out of ten")).toBeNull();
    expect(parseJudgeReply('{"score": 11, "reason": "x"}')).toBeNull();
    expect(parseJudgeReply('{"score": "n/a"}')).toBeNull();
  });
});

describe("parseArgs", () => {
  it("defaults the judge to qwen3.8-max and reads flags", () => {
    expect(parseArgs(["node", "judge.ts", "results/x"])).toEqual({ dir: "results/x", judge: "qwen3.8-max" });
    expect(parseArgs(["node", "judge.ts", "--conditions", "mcp,mcp-skill", "results/x", "--limit", "5"])).toEqual({
      dir: "results/x",
      judge: "qwen3.8-max",
      conditions: ["mcp", "mcp-skill"],
      limit: 5,
    });
    expect(parseArgs(["node", "judge.ts"])).toBeNull();
  });
});
