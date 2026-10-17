import { describe, expect, it } from "vitest";
import { SCORER_VERSION, rowFromBreakdown, scoreRun } from "../lib/scoring/score.js";
import { Verifier, type PmidFacts } from "../lib/scoring/verify.js";
import { QUERIES } from "../lib/queries.js";
import type { BenchmarkQuery, RunRecord, ScoreBreakdown } from "../lib/types.js";

const fact = (pmid: string): PmidFacts => ({
  pmid,
  exists: true,
  evidenceScore: 5,
  studyType: "meta-analysis",
  title: "T",
  abstract: "",
});

function verifier(existing: string[] = [], fail = false): { v: Verifier; fetches: string[][] } {
  const fetches: string[][] = [];
  const v = new Verifier({
    fetchArticles: async (pmids) => {
      fetches.push(pmids);
      if (fail) throw new Error("NCBI down");
      return { found: pmids.filter((p) => existing.includes(p)).map(fact), missing: pmids.filter((p) => !existing.includes(p)) };
    },
    resolveId: async () => null,
  });
  return { v, fetches };
}

const record = (over: Partial<RunRecord> = {}): RunRecord => ({
  queryId: "factual-04",
  category: "factual",
  condition: "mcp",
  model: "m",
  run: 1,
  systemPrompt: "",
  prompt: "Identify the BMJ meta-analysis. Finish with ANSWER — PMID: <number>",
  text: "ANSWER — PMID: 28202713",
  toolCalls: [],
  toolCallCount: 2,
  toolsUsed: ["search", "fetch"],
  usage: { inputTokens: 100, outputTokens: 50, totalTokens: 150 },
  speedS: 5,
  startedAt: "",
  finishedAt: "",
  ...over,
});

const query = (id: string): BenchmarkQuery => QUERIES.find((q) => q.id === id)!;

describe("scoreRun", () => {
  it("scores an ok deterministic run", async () => {
    const { v } = verifier(["28202713"]);
    const { row, breakdown } = await scoreRun(record(), query("factual-04"), v);
    expect(row.status).toBe("ok");
    expect(row.accuracy).toBe(10);
    expect(row.accuracy_source).toBe("deterministic");
    expect(row.total_tokens).toBe(150);
    expect(row.pmids_cited).toBe(1);
    expect(row.pmids_valid).toBe(1);
    expect(row.other_citations).toBe(0);
    expect(breakdown.scorerVersion).toBe(SCORER_VERSION);
    expect(breakdown.answerKeyVersion).toBe(query("factual-04").answerKeyVersion);
  });

  it("provider errors and empty text skip PubMed and zero the numbers", async () => {
    const { v, fetches } = verifier(["28202713"]);
    const err = await scoreRun(record({ error: "timeout", text: "partial PMID 28202713" }), query("factual-04"), v);
    expect(err.row.status).toBe("provider-error");
    const empty = await scoreRun(record({ text: "  \n" }), query("factual-04"), v);
    expect(empty.row.status).toBe("truncated");
    for (const r of [err.row, empty.row]) {
      expect([r.accuracy, r.evidence_quality, r.bullshit_score, r.composite, r.pmids_cited]).toEqual([0, 0, 0, 0, 0]);
    }
    expect(fetches).toEqual([]);
  });

  it("runs that ended mid tool-calling are truncated even though they have text", async () => {
    const { v, fetches } = verifier([]);
    for (const finishReason of ["tool-calls", "length"]) {
      const { row } = await scoreRun(record({ text: "Let me do a few more targeted searches.", finishReason }), query("bullshit-03"), v);
      expect(row.status).toBe("truncated");
      expect(row.composite).toBe(0);
    }
    expect(fetches).toEqual([]);
  });

  it("contextTruncated runs are truncated even with non-empty text, skipping PubMed", async () => {
    const { v, fetches } = verifier(["28202713"]);
    const { row } = await scoreRun(record({ text: "Please provide the question. PMID 28202713", contextTruncated: true }), query("factual-04"), v);
    expect(row.status).toBe("truncated");
    expect([row.accuracy, row.evidence_quality, row.bullshit_score, row.composite, row.pmids_cited]).toEqual([0, 0, 0, 0, 0]);
    expect(fetches).toEqual([]);
  });

  it("never throws: verification failure becomes scoring-error", async () => {
    const { v } = verifier([], true);
    const { row, breakdown } = await scoreRun(record(), query("factual-04"), v);
    expect(row.status).toBe("scoring-error");
    expect(breakdown.scoringError).toContain("NCBI down");
    expect(row.pmids_fabricated).toBe(0);
  });

  it("a correct bullshit-04 rejection that echoes the prompt PMID scores full marks", async () => {
    const q = query("bullshit-04");
    const { v } = verifier();
    const { row, breakdown } = await scoreRun(
      record({
        queryId: q.id,
        category: "bullshit",
        prompt: q.prompt,
        text: "I could not find the Thornbury cohort, and PMID 99999999 does not correspond to any article.",
      }),
      q,
      v,
    );
    expect(row.status).toBe("ok");
    expect(row.bullshit_score).toBe(1);
    expect(row.composite).toBe(10);
    expect(row.accuracy_source).toBe("reject");
    expect(row.pmids_fabricated).toBe(0);
    expect(breakdown.evidenceQuality.echoedFromPrompt).toEqual(["99999999"]);
  });

  it("rubric queries are proxy-sourced", async () => {
    const { v } = verifier(["28202713"]);
    const { row } = await scoreRun(record({ queryId: "synthesis-01", category: "synthesis", text: "See PMID 28202713." }), query("synthesis-01"), v);
    expect(row.accuracy_source).toBe("proxy");
    expect(row.accuracy).toBe(10);
  });
});

describe("rowFromBreakdown", () => {
  it("round-trips a v2 breakdown without network", async () => {
    const { v } = verifier(["28202713"]);
    const { row, breakdown } = await scoreRun(record(), query("factual-04"), v);
    expect(rowFromBreakdown(record(), breakdown)).toEqual(row);
  });

  it("handles legacy v1 breakdowns (no status/scorerVersion/other, evidence-score kind)", () => {
    const legacy = {
      accuracy: { score: 7.5, kind: "evidence-score" },
      evidenceQuality: { score: 4, pmids: [{ pmid: "1", valid: true }, { pmid: "2", valid: false }] },
      bullshit: { score: 0.5, rejected: false, fabricatedPmids: ["2"] },
      composite: 6.1,
    } as unknown as ScoreBreakdown;
    const row = rowFromBreakdown(record(), legacy);
    expect(row.status).toBe("ok");
    expect(row.accuracy_source).toBe("deterministic");
    expect(row.pmids_cited).toBe(2);
    expect(row.pmids_valid).toBe(1);
    expect(row.pmids_fabricated).toBe(1);
    expect(row.other_citations).toBe(0);
    expect(row.total_tokens).toBe(150);
    expect(row.composite).toBe(6.1);
    expect(rowFromBreakdown(record({ error: "boom" }), legacy).status).toBe("provider-error");
  });
});

describe("queries", () => {
  it("factual-01..03 prompts use the current taxonomy and are at answerKeyVersion 3", () => {
    for (const id of ["factual-01", "factual-02", "factual-03"]) {
      const q = query(id);
      expect(q.prompt).toContain("non-randomized-trial");
      expect(q.prompt).toContain("in-vitro");
      expect(q.prompt).not.toContain("unknown");
      expect(q.answerKeyVersion).toBe(3);
    }
    expect(query("factual-01").prompt).toContain("case-report or review (narrative) = 1");
  });
});
