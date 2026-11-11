import { describe, expect, it } from "vitest";
import { CliError, parseCli, parsePositiveInt, parseTemperature } from "../lib/cli.js";
import { DEFAULTS, DEFAULT_MODELS, MODELS } from "../lib/config.js";
import { SCORER_VERSION } from "../lib/scoring/score.js";
import { buildManifest, effectiveScorerVersion, fingerprintFor, rescoreReason, resumeDecision, detectGit } from "../lib/manifest.js";
import { CONDITIONS, SKILL_TEXT, SYSTEM_PROMPT, systemPromptFor } from "../lib/config.js";
import { CATEGORIES, resolveConditions, resolveQueries, resolveSplit } from "../lib/cli.js";
import { QUERIES, queriesOf } from "../lib/queries.js";
import { RUN_STATUSES, isFailure, isScored, normalizeStatus, runOutcome } from "../lib/status.js";
import type { RunRecord, ScoreBreakdown } from "../lib/types.js";
import { statusTally } from "../run.js";

describe("CLI validation", () => {
  it("rejects non-numeric / non-positive integers", () => {
    for (const bad of ["abc", "0", "-1", "1.5", "", "3x"]) {
      expect(() => parseCli(["--concurrency", bad])).toThrow(CliError);
    }
    expect(() => parseCli(["--runs", "abc"])).toThrow(/--runs/);
    expect(() => parseCli(["--max-steps", "0"])).toThrow(/--max-steps/);
    expect(parsePositiveInt("runs", "4", 3)).toBe(4);
    expect(parsePositiveInt("runs", undefined, 3)).toBe(3);
  });

  it("validates temperature as a finite number in [0, 2]", () => {
    for (const bad of ["hot", "NaN", "Infinity", "-0.1", "2.5", ""]) {
      expect(() => parseTemperature(bad, 0)).toThrow(CliError);
    }
    expect(parseTemperature("0", 1)).toBe(0);
    expect(parseTemperature("1.5", 0)).toBe(1.5);
  });

  it("uses documented defaults", () => {
    const o = parseCli([]);
    expect(o.runs).toBe(DEFAULTS.runs);
    expect(o.concurrency).toBe(1);
    expect(o.models).toBe(DEFAULT_MODELS);
    expect(o.conditions).toEqual(["mcp"]);
  });

  it("errors on unknown flags, models and queries", () => {
    expect(() => parseCli(["--nope"])).toThrow(CliError);
    expect(() => parseCli(["--models", "no-such-model"])).toThrow(/Unknown model/);
    expect(() => parseCli(["--queries", "zzz"])).toThrow(/Unknown query/);
  });

  it("refuses to combine --publish with --models, --runs, --split or --queries", () => {
    expect(() => parseCli(["--publish", "--models", MODELS[0]!.label])).toThrow(/--publish.*--models/);
    expect(() => parseCli(["--publish", "--runs", "1"])).toThrow(/--runs/);
    expect(() => parseCli(["--publish", "--split", "dev"])).toThrow(/--split/);
    expect(() => parseCli(["--publish", "--queries", "factual-01"])).toThrow(/--queries/);
    const ok = parseCli(["--publish"]);
    expect(ok.runs).toBe(DEFAULTS.runs);
    expect(ok.models).toBe(DEFAULT_MODELS);
  });
});

describe("query sets", () => {
  it("a plain run takes the development set; only --publish or --split reaches the held-out one", () => {
    const dev = parseCli([]);
    expect(dev.split).toBe("dev");
    expect(dev.queries.length).toBeGreaterThan(0);
    expect(dev.queries.every((q) => q.split === "dev")).toBe(true);
    const publish = parseCli(["--publish"]);
    expect(publish.split).toBe("test");
    expect(publish.queries).toEqual(queriesOf("test"));
    expect(publish.queries.every((q) => q.split === "test")).toBe(true);
    expect(parseCli(["--split", "all"]).queries).toEqual(QUERIES);
    expect(() => parseCli(["--split", "prod"])).toThrow(/--split/);
    expect(resolveSplit(undefined)).toBe("dev");
    expect(resolveSplit("TEST")).toBe("test");
  });

  it("a category selects within the split; a named query is selected whatever its split", () => {
    const devBs = resolveQueries("bullshit", "dev");
    expect(devBs.length).toBe(4);
    expect(devBs.every((q) => q.split === "dev" && q.category === "bullshit")).toBe(true);
    expect(resolveQueries("bullshit", "all").length).toBeGreaterThanOrEqual(devBs.length);
    expect(resolveQueries("factual-01", "test").map((q) => q.id)).toEqual(["factual-01"]);
    expect(resolveQueries("factual-01,factual,factual-01", "dev").map((q) => q.id)).toEqual(["factual-01", "factual-02", "factual-03", "factual-04"]);
  });

  it("the beyond-PubMed categories are known to --queries and select within the held-out set", () => {
    for (const category of ["preprint", "regional", "fulltext"] as const) {
      expect(CATEGORIES).toContain(category);
      // Known category names never fail as "unknown query"; before the writers have merged, a category may be empty.
      const selected = resolveQueries(category, "test");
      expect(selected.every((q) => q.split === "test" && q.category === category && q.beyondPubmed === true)).toBe(true);
      expect(resolveQueries(category, "dev")).toEqual([]);
      expect(parseCli(["--split", "test", "--queries", category]).queries).toEqual(selected);
    }
    expect(() => resolveQueries("preprints", "test")).toThrow(/Unknown query or category/);
  });

  it("every query belongs to exactly one split and the two never share an id", () => {
    expect(QUERIES.every((q) => q.split === "dev" || q.split === "test")).toBe(true);
    expect(new Set(QUERIES.map((q) => q.id)).size).toBe(QUERIES.length);
    expect(queriesOf("dev").length + queriesOf("test").length).toBe(QUERIES.length);
  });
});

const query = QUERIES[0]!;
const model = MODELS[0]!;
const settings = { temperature: 0, maxSteps: 16 };

function record(over: Partial<RunRecord> = {}): RunRecord {
  const want = fingerprintFor(query, model, settings);
  return {
    queryId: query.id,
    category: query.category,
    condition: "mcp",
    model: model.label,
    modelId: want.modelId,
    settings: want.settings,
    run: 1,
    systemPrompt: want.systemPrompt,
    prompt: want.prompt,
    text: "answer",
    toolCalls: [],
    toolCallCount: 0,
    toolsUsed: [],
    usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
    speedS: 1,
    startedAt: "",
    finishedAt: "",
    ...over,
  };
}

describe("resume fingerprint", () => {
  const want = fingerprintFor(query, model, settings);

  it("accepts a matching record", () => {
    expect(resumeDecision(record(), want)).toEqual({ reuse: true });
  });

  it("rejects each kind of mismatch with a reason", () => {
    const reason = (r: RunRecord) => {
      const d = resumeDecision(r, want);
      return d.reuse ? "reused" : d.reason;
    };
    expect(reason(record({ error: "Free quota exhausted." }))).toMatch(/provider error/);
    expect(reason(record({ contextTruncated: true }))).toMatch(/context truncated/);
    expect(reason(record({ modelId: "other" }))).toMatch(/model id/);
    expect(reason(record({ settings: { ...want.settings, temperature: 0.7 } }))).toMatch(/settings/);
    expect(reason(record({ settings: { ...want.settings, timeoutMs: 1 } }))).toMatch(/settings/);
    expect(reason(record({ prompt: "changed" }))).toMatch(/^prompt/);
    expect(reason(record({ systemPrompt: "changed" }))).toMatch(/system prompt/);
    const legacy = record();
    delete legacy.modelId;
    delete legacy.settings;
    expect(reason(legacy)).toMatch(/legacy/);
  });

  it("keeps a run that failed to answer: re-running it until it passes would be best-of-N", () => {
    expect(resumeDecision(record({ error: "timeout after 300s", text: "" }), want)).toEqual({ reuse: true });
    expect(resumeDecision(record({ text: "" }), want)).toEqual({ reuse: true });
    expect(resumeDecision(record({ text: "Let me search more.", finishReason: "tool-calls" }), want)).toEqual({ reuse: true });
  });
});

describe("run outcomes", () => {
  it("separates a failure of the system (scored 0) from missing data", () => {
    expect(runOutcome({ text: "An answer." })).toBeUndefined();
    expect(runOutcome({ text: "" })).toBe("no-answer");
    expect(runOutcome({ text: "partial", finishReason: "length" })).toBe("no-answer");
    expect(runOutcome({ text: "x", error: "timeout after 300s" })).toBe("timeout");
    expect(runOutcome({ text: "x", error: "Free quota exhausted." })).toBe("provider-error");
    expect(runOutcome({ text: "x", contextTruncated: true })).toBe("invalid");
    expect(RUN_STATUSES.filter(isScored)).toEqual(["ok", "no-answer", "timeout"]);
    expect(RUN_STATUSES.filter(isFailure)).toEqual(["no-answer", "timeout"]);
  });

  it("reads the old `truncated` as no-answer and anything unknown as ok", () => {
    expect(normalizeStatus("truncated")).toBe("no-answer");
    expect(normalizeStatus("timeout")).toBe("timeout");
    expect(normalizeStatus(undefined)).toBe("ok");
    expect(normalizeStatus("")).toBe("ok");
  });
});

describe("manifest", () => {
  it("records the split and no scoring weights", () => {
    const m = buildManifest({ args: [], settings, models: [model], conditions: ["mcp"], queries: [query], split: "test", git: { commit: "abc", dirty: false } });
    expect(m.split).toBe("test");
    expect(m.scorer_version).toBe(SCORER_VERSION);
    expect("weights" in m).toBe(false);
    expect("normalization" in m).toBe(false);
  });

  it("the effective scorer version is the last rescore's", () => {
    expect(effectiveScorerVersion({ scorer_version: 4 })).toBe(4);
    expect(effectiveScorerVersion({ scorer_version: 4, rescored: { at: "", scorer_version: 8, harness_commit: "x", harness_dirty: false } })).toBe(8);
    expect(effectiveScorerVersion({})).toBeUndefined();
  });
});

describe("rescore staleness", () => {
  const bd = (over: Partial<ScoreBreakdown> = {}): ScoreBreakdown => ({
    status: "ok",
    accuracy: { score: 1, kind: "values" },
    evidenceQuality: { score: 1, pmids: [] },
    bullshit: { score: 0, rejected: false, fabricatedPmids: [] },
    scorerVersion: SCORER_VERSION,
    answerKeyVersion: query.answerKeyVersion ?? 1,
    ...over,
  });

  it("reuses a current breakdown", () => {
    expect(rescoreReason(bd(), query)).toBeUndefined();
  });

  it("re-scores on missing, scoring-error, old scorer, or changed key", () => {
    expect(rescoreReason(undefined, query)).toMatch(/no embedded/);
    expect(rescoreReason(bd({ status: "scoring-error" }), query)).toMatch(/scoring-error/);
    expect(rescoreReason(bd({ scorerVersion: undefined }), query)).toMatch(/scorer/);
    expect(rescoreReason(bd({ scorerVersion: SCORER_VERSION - 1 }), query)).toMatch(/scorer/);
    expect(rescoreReason(bd({ answerKeyVersion: 99 }), query)).toMatch(/answer key/);
  });
});

describe("misc", () => {
  it("detectGit never throws outside a repo", () => {
    expect(detectGit("/")).toEqual({ commit: "unknown", dirty: null });
  });

  it("statusTally counts every status", () => {
    const rows = [{ status: "ok" }, { status: "ok" }, { status: "no-answer" }, { status: "invalid" }] as never;
    expect(statusTally(rows)).toEqual({ ok: 2, "no-answer": 1, timeout: 0, "provider-error": 0, invalid: 1, "scoring-error": 0 });
  });
});

describe("condition E (plain PubMed tools)", () => {
  it("is selectable by letter or name and is one of the baselines", () => {
    expect(CONDITIONS.E).toBe("pubmed");
    expect(resolveConditions("e,C")).toEqual(["pubmed", "mcp"]);
    expect(resolveConditions("pubmed")).toEqual(["pubmed"]);
    expect(resolveConditions(undefined, true)).toEqual(["closed-book", "web-search", "pubmed", "mcp"]);
    expect(resolveConditions(undefined)).toEqual(["mcp"]);
    expect(() => resolveConditions("F")).toThrow(/Unknown condition/);
  });

  it("shares the system prompt of the other tool conditions", () => {
    expect(systemPromptFor("pubmed")).toBe(SYSTEM_PROMPT);
  });
});

describe("condition D (mcp-skill)", () => {
  it("is selectable by letter or name", () => {
    expect(CONDITIONS.D).toBe("mcp-skill");
    expect(resolveConditions("C,D")).toEqual(["mcp", "mcp-skill"]);
    expect(resolveConditions("mcp-skill")).toEqual(["mcp-skill"]);
  });

  it("appends the shipped med-research skill, without frontmatter, to D's system prompt only", () => {
    expect(SKILL_TEXT.startsWith("# Using the med-research-mcp MCP")).toBe(true);
    expect(SKILL_TEXT).toContain("## Ground rules of evidence");
    expect(systemPromptFor("mcp-skill")).toBe(`${SYSTEM_PROMPT}\n\n${SKILL_TEXT}`);
    for (const c of ["closed-book", "web-search", "mcp"] as const) expect(systemPromptFor(c)).toBe(SYSTEM_PROMPT);
  });

  it("never reuses an mcp record for mcp-skill on resume", () => {
    const skillWant = fingerprintFor(query, model, settings, "mcp-skill");
    expect(resumeDecision(record(), skillWant)).toEqual({ reuse: false, reason: "system prompt differs" });
  });
});
