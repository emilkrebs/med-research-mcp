import { describe, expect, it } from "vitest";
import { CliError, parseCli, parsePositiveInt, parseTemperature } from "../lib/cli.js";
import { DEFAULTS, DEFAULT_MODELS, MODELS } from "../lib/config.js";
import { SCORER_VERSION } from "../lib/scoring/score.js";
import { fingerprintFor, rescoreReason, resumeDecision, detectGit } from "../lib/manifest.js";
import { CONDITIONS, SKILL_TEXT, SYSTEM_PROMPT, systemPromptFor } from "../lib/config.js";
import { resolveConditions } from "../lib/cli.js";
import { QUERIES } from "../lib/queries.js";
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

  it("refuses to combine --publish with --models or --runs", () => {
    expect(() => parseCli(["--publish", "--models", MODELS[0]!.label])).toThrow(/--publish.*--models/);
    expect(() => parseCli(["--publish", "--runs", "1"])).toThrow(/--runs/);
    const ok = parseCli(["--publish"]);
    expect(ok.runs).toBe(DEFAULTS.runs);
    expect(ok.models).toBe(DEFAULT_MODELS);
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
    expect(reason(record({ error: "boom" }))).toMatch(/errored/);
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
});

describe("rescore staleness", () => {
  const bd = (over: Partial<ScoreBreakdown> = {}): ScoreBreakdown => ({
    status: "ok",
    accuracy: { score: 1, kind: "values" },
    evidenceQuality: { score: 1, pmids: [] },
    bullshit: { score: 0, rejected: false, fabricatedPmids: [] },
    composite: 1,
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
    const rows = [{ status: "ok" }, { status: "ok" }, { status: "truncated" }] as never;
    expect(statusTally(rows)).toEqual({ ok: 2, "provider-error": 0, truncated: 1, "scoring-error": 0 });
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
