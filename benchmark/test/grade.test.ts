import { describe, expect, it } from "vitest";
import {
  buildView,
  isAlreadyGraded,
  parseArgs,
  renderView,
  seedFromString,
  seededShuffle,
  selectItems,
  skipReason,
  upsertOverride,
  type RawFile,
  type RawItem,
} from "../grade.js";
import type { BenchmarkQuery, OverridesFile, ScoreBreakdown, ScoreOverride } from "../lib/types.js";

const query: BenchmarkQuery = {
  id: "synth-1",
  category: "synthesis",
  prompt: "PROMPT-TEXT",
  answerKey: { kind: "rubric", rubric: "RUBRIC-TEXT" },
  verified: true,
};

function breakdown(status: ScoreBreakdown["status"] | undefined, proxy = 6.66): ScoreBreakdown {
  return {
    ...(status ? { status } : {}),
    accuracy: { score: proxy, kind: "rubric" },
    evidenceQuality: {
      score: 3,
      pmids: [{ pmid: "111", valid: true, studyType: "cohort", evidenceScore: 3, title: "A title" }],
    },
    bullshit: { score: 0, rejected: false, fabricatedPmids: [] },
    composite: 5,
  } as ScoreBreakdown;
}

function rec(run: number, extra: Partial<RawFile> = {}, status: ScoreBreakdown["status"] | null = "ok"): RawItem {
  const record = {
    queryId: "synth-1",
    category: "synthesis",
    condition: "mcp",
    model: "secret-model",
    run,
    prompt: "PROMPT-TEXT",
    text: "an answer",
    _scoring: breakdown(status ?? undefined),
    ...extra,
  } as RawFile;
  return { file: `f${run}.json`, record };
}

const grade = (record: RawFile, author: string, accuracy = 7): ScoreOverride => ({
  queryId: record.queryId,
  condition: record.condition,
  model: record.model,
  run: record.run,
  accuracy,
  reason: "r",
  author,
});

const isRubric = (): boolean => true;

describe("blinding", () => {
  const { record } = rec(1);

  it("hides condition, model, run and proxy by default", () => {
    const text = renderView(buildView(record, query, false), 0, 1);
    expect(text).toContain("PROMPT-TEXT");
    expect(text).toContain("RUBRIC-TEXT");
    expect(text).toContain("an answer");
    expect(text).toContain("PMID 111");
    expect(text).not.toContain("secret-model");
    expect(text).not.toMatch(/\bmcp\b/);
    expect(text).not.toContain("6.66");
    expect(text).not.toMatch(/proxy/i);
  });

  it("shows them with --unblind", () => {
    const text = renderView(buildView(record, query, true), 0, 1);
    expect(text).toContain("secret-model");
    expect(text).toContain("mcp");
    expect(text).toContain("6.66");
  });

  it("uses a stable opaque item id", () => {
    expect(buildView(record, query, false).itemId).toMatch(/^[0-9a-f]{8}$/);
    expect(buildView(record, query, false).itemId).toBe(buildView(rec(1).record, query, true).itemId);
    expect(buildView(rec(2).record, query, false).itemId).not.toBe(buildView(record, query, false).itemId);
  });
});

describe("seeded shuffle", () => {
  const xs = Array.from({ length: 20 }, (_, i) => i);

  it("is deterministic for a seed, differs across seeds, and is a permutation", () => {
    expect(seededShuffle(xs, 42)).toEqual(seededShuffle(xs, 42));
    expect(seededShuffle(xs, 42)).not.toEqual(seededShuffle(xs, 43));
    expect([...seededShuffle(xs, 42)].sort((a, b) => a - b)).toEqual(xs);
    expect(xs[0]).toBe(0); // input untouched
  });

  it("derives different default seeds for different graders", () => {
    expect(seedFromString("alice")).not.toBe(seedFromString("bob"));
    expect(seedFromString("alice")).toBe(seedFromString("alice"));
  });
});

describe("parseArgs", () => {
  it("parses flags and derives the seed from the grader", () => {
    const o = parseArgs(["dir", "--grader", "alice", "--overrides", "x.json", "--unblind"])!;
    expect(o).toMatchObject({ dir: "dir", grader: "alice", overridesPath: "x.json", unblind: true, agreement: false });
    expect(o.seed).toBe(seedFromString("alice"));
    expect(parseArgs(["dir", "--seed", "5"])!.seed).toBe(5);
    expect(parseArgs(["dir", "--agreement"])!.agreement).toBe(true);
  });

  it("rejects bad usage", () => {
    expect(parseArgs([])).toBeNull();
    expect(parseArgs(["dir", "--seed", "x"])).toBeNull();
    expect(parseArgs(["dir", "--bogus"])).toBeNull();
    expect(parseArgs(["dir", "--grader"])).toBeNull();
  });
});

describe("already graded / upsert are per grader", () => {
  const { record } = rec(1);

  it("only counts this grader's exact numeric grade", () => {
    const o: OverridesFile = { overrides: [grade(record, "alice")] };
    expect(isAlreadyGraded(o, record, "alice")).toBe(true);
    expect(isAlreadyGraded(o, record, "bob")).toBe(false);
    const wild: OverridesFile = { overrides: [{ ...grade(record, "alice"), condition: "*" }] };
    expect(isAlreadyGraded(wild, record, "alice")).toBe(false);
    const noNum: OverridesFile = { overrides: [{ ...grade(record, "alice"), accuracy: null }] };
    expect(isAlreadyGraded(noNum, record, "alice")).toBe(false);
  });

  it("upserts per author: replaces own entry, keeps others'", () => {
    const o: OverridesFile = { overrides: [] };
    upsertOverride(o, grade(record, "alice", 5));
    upsertOverride(o, grade(record, "bob", 9));
    upsertOverride(o, grade(record, "alice", 6));
    expect(o.overrides.map((x) => [x.author, x.accuracy])).toEqual([["alice", 6], ["bob", 9]]);
  });
});

describe("item selection", () => {
  it("skips non-ok runs with reasons, and legacy breakdowns follow error/empty-text rules", () => {
    const items = [
      rec(1),
      rec(2, {}, "provider-error"),
      rec(3, {}, "truncated"),
      rec(4, {}, "scoring-error"),
      rec(5, {}, null), // legacy, fine
      rec(6, { error: "boom" }, null), // legacy, errored
      rec(7, { text: "  " }, null), // legacy, empty
    ];
    expect(skipReason(items[4]!.record)).toBeNull();
    const sel = selectItems(items, { overrides: [] }, "alice", 1, isRubric);
    expect(sel.toGrade.map((i) => i.record.run).sort()).toEqual([1, 5]);
    expect(sel.skipped).toEqual({ "provider-error": 2, truncated: 2, "scoring-error": 1 });
    expect(sel.rubricTotal).toBe(7);
  });

  it("removes this grader's graded items only, and ordering depends on the seed", () => {
    const items = Array.from({ length: 12 }, (_, i) => rec(i + 1));
    const o: OverridesFile = { overrides: [grade(items[0]!.record, "alice")] };
    const a = selectItems(items, o, "alice", 7, isRubric);
    const b = selectItems(items, o, "bob", 7, isRubric);
    expect(a.toGrade).toHaveLength(11);
    expect(a.alreadyDone).toBe(1);
    expect(b.toGrade).toHaveLength(12);
    expect(selectItems(items, o, "alice", 7, isRubric).toGrade.map((i) => i.file)).toEqual(a.toGrade.map((i) => i.file));
    expect(selectItems(items, o, "alice", 8, isRubric).toGrade.map((i) => i.file)).not.toEqual(a.toGrade.map((i) => i.file));
  });
});
