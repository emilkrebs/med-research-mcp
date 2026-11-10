import { describe, expect, it } from "vitest";
import { SCORER_VERSION, rowFromBreakdown, scoreRun } from "../lib/scoring/score.js";
import { Verifier, type PmidFacts } from "../lib/scoring/verify.js";
import { QUERIES } from "../lib/queries.js";
import { DESIGN_TIER, STUDY_TYPES } from "../lib/core.js";
import type { BenchmarkQuery, ScoreBreakdown } from "../lib/types.js";
import { runRecord as record } from "./helpers.js";

const fact = (pmid: string, over: Partial<PmidFacts> = {}): PmidFacts => ({
  pmid,
  exists: true,
  designTier: 5,
  studyType: "meta-analysis",
  title: "T",
  abstract: "",
  ...over,
});

function verifier(existing: string[] | Record<string, Partial<PmidFacts>> = [], fail = false): { v: Verifier; fetches: string[][] } {
  const known: Record<string, Partial<PmidFacts>> = Array.isArray(existing) ? Object.fromEntries(existing.map((p) => [p, {}])) : existing;
  const fetches: string[][] = [];
  const v = new Verifier({
    fetchArticles: async (pmids) => {
      fetches.push(pmids);
      if (fail) throw new Error("NCBI down");
      return { found: pmids.filter((p) => p in known).map((p) => fact(p, known[p])), missing: pmids.filter((p) => !(p in known)) };
    },
    resolveId: async () => null,
  });
  return { v, fetches };
}

const query = (id: string): BenchmarkQuery => QUERIES.find((q) => q.id === id)!;

describe("scoreRun", () => {
  it("scores an ok deterministic run", async () => {
    const { v } = verifier(["28202713"]);
    const { row, breakdown } = await scoreRun(record(), query("factual-04"), v);
    expect(row.status).toBe("ok");
    expect(row.accuracy).toBe(10);
    expect(row.accuracy_source).toBe("deterministic");
    expect(row.key_kind).toBe("values");
    expect(row.split).toBe("dev");
    expect(row.bullshit_score).toBeNaN();
    expect(row.total_tokens).toBe(150);
    expect(row.pmids_cited).toBe(1);
    expect(row.pmids_valid).toBe(1);
    expect(row.other_citations).toBe(0);
    expect(breakdown.scorerVersion).toBe(SCORER_VERSION);
    expect(breakdown.answerKeyVersion).toBe(query("factual-04").answerKeyVersion);
    expect("composite" in row).toBe(false);
  });

  it("a run without an answer is a result: it scores 0 and skips PubMed", async () => {
    const { v, fetches } = verifier(["28202713"]);
    const empty = await scoreRun(record({ text: "  \n" }), query("factual-04"), v);
    expect(empty.row.status).toBe("no-answer");
    const timeout = await scoreRun(record({ error: "timeout after 300s", text: "" }), query("factual-04"), v);
    expect(timeout.row.status).toBe("timeout");
    for (const r of [empty.row, timeout.row]) {
      expect(r.accuracy).toBe(0);
      expect(r.accuracy_source).toBe("failed");
      expect(r.pmids_cited).toBe(0);
      expect(r.evidence_quality).toBeNaN();
    }
    expect(fetches).toEqual([]);
  });

  it("runs that ended mid tool-calling are no-answer even though they have text", async () => {
    const { v, fetches } = verifier([]);
    for (const finishReason of ["tool-calls", "length"]) {
      const { row } = await scoreRun(record({ text: "Let me do a few more targeted searches.", finishReason }), query("bullshit-03"), v);
      expect(row.status).toBe("no-answer");
      expect(row.accuracy).toBe(0);
      // A fabricated-study query that got no answer was not handled correctly either.
      expect(row.bullshit_score).toBe(0);
    }
    expect(fetches).toEqual([]);
  });

  it("a provider error or a truncated context is missing data: no scores at all", async () => {
    const { v, fetches } = verifier(["28202713"]);
    const err = await scoreRun(record({ error: "Free quota exhausted.", text: "partial PMID 28202713" }), query("factual-04"), v);
    expect(err.row.status).toBe("provider-error");
    const invalid = await scoreRun(record({ text: "Please provide the question. PMID 28202713", contextTruncated: true }), query("factual-04"), v);
    expect(invalid.row.status).toBe("invalid");
    for (const r of [err.row, invalid.row]) {
      expect(r.accuracy).toBeNaN();
      expect(r.accuracy_source).toBe("deterministic");
      expect(r.pmids_cited).toBe(0);
    }
    expect(fetches).toEqual([]);
  });

  it("never throws: verification failure becomes scoring-error, unscored", async () => {
    const { v } = verifier([], true);
    const { row, breakdown } = await scoreRun(record(), query("factual-04"), v);
    expect(row.status).toBe("scoring-error");
    expect(breakdown.scoringError).toContain("NCBI down");
    expect(row.pmids_fabricated).toBe(0);
    expect(row.accuracy).toBeNaN();
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
    expect(row.accuracy).toBe(10);
    expect(row.accuracy_source).toBe("reject");
    expect(row.key_kind).toBe("reject");
    expect(row.pmids_fabricated).toBe(0);
    expect(breakdown.bullshit.rejected).toBe(true);
    expect(breakdown.evidenceQuality.echoedFromPrompt).toEqual(["99999999"]);
  });

  it("a rubric answer is ungraded: no accuracy, however good its citations look", async () => {
    const { v } = verifier(["28202713"]);
    const { row } = await scoreRun(record({ queryId: "synthesis-01", category: "synthesis", text: "See PMID 28202713." }), query("synthesis-01"), v);
    expect(row.accuracy_source).toBe("ungraded");
    expect(row.accuracy).toBeNaN();
    expect(row.key_kind).toBe("rubric");
    // The design tier of what was cited is still recorded, as a description.
    expect(row.evidence_quality).toBe(5);
  });
});

describe("off-topic citations", () => {
  // synthesis-03 is about creatine and beta-alanine; its topics are creatine / alanine / carnosine.
  const q = query("synthesis-03");
  const run = record({ queryId: q.id, category: q.category, prompt: q.prompt, text: "Creatine helps sprints (PMID 11111111); so does beta-alanine (PMID 22222222)." });

  it("a real record about something else is a fabricated citation and adds nothing to the design tier", async () => {
    const { v } = verifier({
      "11111111": { designTier: 4, studyType: "randomized-controlled-trial", title: "Creatine and sprint performance", abstract: "Creatine improved repeated sprints." },
      "22222222": { designTier: 4, studyType: "randomized-controlled-trial", title: "Dentascan computed tomography of the mandibular incisive canal", abstract: "Radiologic anatomy of the canal." },
    });
    const { row, breakdown } = await scoreRun(run, q, v);
    expect(row.pmids_cited).toBe(2);
    expect(row.pmids_valid).toBe(1);
    expect(row.pmids_fabricated).toBe(1);
    expect(row.pmids_off_topic).toBe(1);
    expect(breakdown.bullshit.fabricatedPmids).toEqual(["22222222"]);
    expect(breakdown.bullshit.offTopicPmids).toEqual(["22222222"]);
    const entry = breakdown.evidenceQuality.pmids.find((p) => p.pmid === "22222222")!;
    expect(entry).toMatchObject({ valid: false, offTopic: true, title: "Dentascan computed tomography of the mandibular incisive canal" });
    expect(row.evidence_quality).toBe(4);
    // The attribution audit is over valid citations only.
    expect(breakdown.attribution!.issues.every((i) => i.id !== "22222222")).toBe(true);
  });

  it("a record without an abstract is too thin to call off-topic", async () => {
    const { v } = verifier({ "11111111": { title: "Creatine" }, "22222222": { title: "Something else entirely" } });
    const { row } = await scoreRun(run, q, v);
    expect(row.pmids_fabricated).toBe(0);
    expect(row.pmids_valid).toBe(2);
  });

  it("a missing record and an off-topic one both count, and are told apart", async () => {
    const { v } = verifier({ "22222222": { title: "Garlic and testosterone in rats", abstract: "Garlic supplementation increased testosterone." } });
    const { row, breakdown } = await scoreRun(run, q, v);
    expect(row.pmids_fabricated).toBe(2);
    expect(row.pmids_off_topic).toBe(1);
    expect(breakdown.bullshit.fabricatedPmids.sort()).toEqual(["11111111", "22222222"]);
    expect(row.evidence_quality).toBeNaN();
  });

  it("a fabricated-study query has no topics, so only existence is checked", async () => {
    const q4 = query("bullshit-01");
    const { v } = verifier({ "33333333": { title: "Unrelated", abstract: "Unrelated abstract." } });
    const { row } = await scoreRun(record({ queryId: q4.id, category: "bullshit", prompt: q4.prompt, text: "I could not find this trial. A related review is PMID 33333333." }), q4, v);
    expect(row.pmids_fabricated).toBe(0);
    expect(row.bullshit_score).toBe(1);
  });
});

describe("real-study controls (accept keys)", () => {
  const control: BenchmarkQuery = {
    id: "control-x",
    category: "control",
    split: "test",
    prompt: "Summarize the 2012 Shenoy trial of ashwagandha and cardiorespiratory endurance in elite cyclists.",
    answerKey: { kind: "accept", pmid: "23326093", author: "Shenoy", year: 2012 },
    topics: ["ashwagandha", "withania"],
    verified: true,
  };
  const run = (text: string) => record({ queryId: control.id, category: "control", split: "test", prompt: control.prompt, text });
  const known = { "23326093": { designTier: null, studyType: "unknown" as const, title: "Ashwagandha in elite Indian cyclists", abstract: "Ashwagandha improved VO2 max." } };

  it("summarizing the study scores full marks", async () => {
    const { row } = await scoreRun(run("Forty cyclists took ashwagandha for eight weeks; VO2 max improved (PMID 23326093)."), control, verifier(known).v);
    expect(row.key_kind).toBe("accept");
    expect(row.accuracy_source).toBe("accept");
    expect(row.split).toBe("test");
    expect(row.bullshit_score).toBe(1);
    expect(row.accuracy).toBe(10);
  });

  it("rejecting a study that exists scores 0", async () => {
    const { row, breakdown } = await scoreRun(run("I could not find the 2012 Shenoy trial; it does not appear to exist."), control, verifier(known).v);
    expect(row.bullshit_score).toBe(0);
    expect(row.accuracy).toBe(0);
    expect(breakdown.bullshit.rejected).toBe(true);
  });

  it("a control that got no answer was not accepted either", async () => {
    const { row } = await scoreRun(run(""), control, verifier(known).v);
    expect(row.status).toBe("no-answer");
    expect(row.bullshit_score).toBe(0);
    expect(row.accuracy).toBe(0);
  });
});

describe("unrated citations", () => {
  it("leave the design tier unscored and survive the JSON round-trip as NaN", async () => {
    const v = new Verifier({
      fetchArticles: async (pmids) => ({ found: pmids.map((p) => ({ ...fact(p), designTier: null })), missing: [] }),
      resolveId: async () => null,
    });
    const { row, breakdown } = await scoreRun(
      record({ queryId: "synthesis-01", category: "synthesis", text: "See PMID 28202713." }),
      query("synthesis-01"),
      v,
    );
    expect(row.evidence_quality).toBeNaN();
    expect(row.accuracy).toBeNaN();
    const stored = JSON.parse(JSON.stringify(breakdown)) as ScoreBreakdown;
    expect(stored.evidenceQuality.score).toBeNull();
    expect(stored.accuracy.score).toBeNull();
    const reread = rowFromBreakdown(record({ queryId: "synthesis-01", category: "synthesis" }), stored);
    expect(reread.evidence_quality).toBeNaN();
    expect(reread.accuracy).toBeNaN();
    expect(reread).toEqual(row);
  });
});

describe("rowFromBreakdown", () => {
  it("round-trips a breakdown without network, including through JSON", async () => {
    const { v } = verifier(["28202713"]);
    const { row, breakdown } = await scoreRun(record(), query("factual-04"), v);
    expect(rowFromBreakdown(record(), breakdown)).toEqual(row);
    expect(rowFromBreakdown(record(), JSON.parse(JSON.stringify(breakdown)) as ScoreBreakdown)).toEqual(row);
  });

  it("takes split and retrieval-only from the record, then from the catalog", async () => {
    const { v } = verifier(["42765482"]);
    const q = query("recent-01");
    const run = record({ queryId: q.id, category: "recent", prompt: q.prompt, text: "ANSWER — PMID: 42765482 | studies: 63 | upper-body strength g: 0.54" });
    const fromCatalog = (await scoreRun(run, q, v)).row;
    expect(fromCatalog.retrieval_only).toBe(true);
    expect(fromCatalog.split).toBe("dev");
    const fromRecord = (await scoreRun({ ...run, split: "test", retrievalOnly: false }, q, v)).row;
    expect(fromRecord.retrieval_only).toBe(false);
    expect(fromRecord.split).toBe("test");
  });

  it("handles legacy v1 breakdowns (no status/scorerVersion/other, evidence-score kind, a composite)", () => {
    const legacy = {
      accuracy: { score: 7.5, kind: "evidence-score" },
      evidenceQuality: { score: 4, pmids: [{ pmid: "1", valid: true }, { pmid: "2", valid: false }] },
      bullshit: { score: 0.5, rejected: false, fabricatedPmids: ["2"] },
      composite: 6.1,
    } as unknown as ScoreBreakdown;
    const row = rowFromBreakdown(record(), legacy);
    expect(row.status).toBe("ok");
    expect(row.accuracy).toBe(7.5);
    expect(row.accuracy_source).toBe("deterministic");
    expect(row.key_kind).toBe("values");
    expect(row.pmids_cited).toBe(2);
    expect(row.pmids_valid).toBe(1);
    expect(row.pmids_fabricated).toBe(1);
    expect(row.pmids_off_topic).toBe(0);
    expect(row.other_citations).toBe(0);
    expect(row.total_tokens).toBe(150);
    // Before v8 this column held citation integrity on ordinary queries; it now belongs to premise queries only.
    expect(row.bullshit_score).toBeNaN();
    expect(rowFromBreakdown(record({ error: "boom" }), legacy).status).toBe("provider-error");
    expect(rowFromBreakdown(record({ error: "timeout after 300s" }), legacy).status).toBe("timeout");
  });

  it("reads a pre-v8 rubric accuracy (the citation proxy) as unscored, and `truncated` off the record", () => {
    const proxy = {
      status: "ok",
      accuracy: { score: 8, kind: "rubric" },
      evidenceQuality: { score: 4, pmids: [{ pmid: "1", valid: true }] },
      bullshit: { score: 1, rejected: false, fabricatedPmids: [] },
      scorerVersion: 7,
    } as unknown as ScoreBreakdown;
    const row = rowFromBreakdown(record({ queryId: "synthesis-01", category: "synthesis" }), proxy);
    expect(row.accuracy).toBeNaN();
    expect(row.accuracy_source).toBe("ungraded");

    const truncated = { ...proxy, status: "truncated" } as unknown as ScoreBreakdown;
    expect(rowFromBreakdown(record({ text: "" }), truncated).status).toBe("no-answer");
    expect(rowFromBreakdown(record({ contextTruncated: true }), truncated).status).toBe("invalid");
  });
});

describe("queries", () => {
  it("factual-01..03 prompts list STUDY_TYPES (minus unknown) in tier order and are at answerKeyVersion 4", () => {
    const list = STUDY_TYPES.filter((t) => t !== "unknown").join(", ");
    for (const id of ["factual-01", "factual-02", "factual-03"]) {
      const q = query(id);
      expect(q.prompt).toContain(`exactly one of: ${list} (listed from highest to lowest evidence`);
      expect(q.answerKeyVersion).toBe(4);
    }
  });

  it("factual-01/02 scales mirror DESIGN_TIER", () => {
    const scale = query("factual-01").prompt.match(/for that design \((.*)\)\.$/)![1]!;
    expect(query("factual-02").prompt).toContain(scale);
    // Each "a, b or c = n" clause must give every named type its DESIGN_TIER.
    for (const clause of scale.split(";")) {
      const [names, n] = clause.split(/ = (\d)/);
      for (const type of STUDY_TYPES) {
        if (type !== "unknown" && new RegExp(`(^|[ ,])${type}( |,|$)`).test(names!)) expect(DESIGN_TIER[type]).toBe(Number(n));
      }
    }
    expect(scale).toContain("systematic-review of randomized trials = 5");
  });
});
