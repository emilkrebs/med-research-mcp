import { describe, expect, it } from "vitest";
import { ProgressReporter, formatDuration, formatTokens, summarizeToolInput } from "../lib/progress.js";
import type { RunRecord, ScoreRow } from "../lib/types.js";

function harness(opts: { concurrency?: number; quiet?: boolean; tokenBudget?: number; total?: number } = {}) {
  const lines: string[] = [];
  let t = 0;
  const reporter = new ProgressReporter({
    total: opts.total ?? 4,
    concurrency: opts.concurrency ?? 1,
    quiet: opts.quiet ?? false,
    timeoutMs: 300_000,
    heartbeatMs: 20_000,
    ...(opts.tokenBudget !== undefined ? { tokenBudget: opts.tokenBudget } : {}),
    write: (l) => lines.push(l),
    now: () => t,
  });
  return { lines, reporter, advance: (ms: number) => (t += ms) };
}

const info = { index: 1, queryId: "synthesis-02", condition: "mcp", model: "m", run: 1 };

const row = (over: Partial<ScoreRow> = {}): ScoreRow =>
  ({ status: "ok", composite: 8.5, accuracy: 9, evidence_quality: 4.5, bullshit_score: 1, ...over }) as ScoreRow;

const record = (over: Partial<RunRecord> = {}): RunRecord =>
  ({ speedS: 38, usage: { inputTokens: 15000, outputTokens: 1800, totalTokens: 16800 }, stepCount: 2, toolCallCount: 1, ...over }) as RunRecord;

describe("formatting helpers", () => {
  it("formats tokens and durations compactly", () => {
    expect([formatTokens(950), formatTokens(1234), formatTokens(16_800), formatTokens(1_234_567)]).toEqual(["950", "1.2k", "17k", "1.23M"]);
    expect([formatDuration(45_000), formatDuration(252_000), formatDuration(3_780_000)]).toEqual(["45s", "4m12s", "1h03m"]);
  });

  it("summarizes the MCP and web tools' inputs", () => {
    expect(summarizeToolInput("literature_search", { query: "magnesium sleep", database: ["pubmed", "europepmc"], maxResults: 10 })).toBe(
      'literature_search "magnesium sleep" (pubmed+europepmc, max 10)',
    );
    expect(summarizeToolInput("literature_fetch", { ids: ["1", "2"], database: "pubmed" })).toBe("literature_fetch 1, 2 (pubmed)");
    expect(summarizeToolInput("literature_fetch", { ids: ["1", "2", "3", "4"], database: "pubmed" })).toBe("literature_fetch 4 ids (pubmed)");
    expect(summarizeToolInput("literature_fulltext", { id: "36615805" })).toBe("literature_fulltext 36615805");
    expect(summarizeToolInput("web_fetch", { url: "https://example.org/a" })).toBe("web_fetch example.org/a");
    expect(summarizeToolInput("other", { x: 1 })).toBe('other {"x":1}');
  });
});

describe("JobProgress", () => {
  it("prints header, step/tool events, and a result line with run facts", () => {
    const { lines, reporter } = harness();
    const jp = reporter.job(info);
    jp.start();
    jp.event({ type: "step-start", step: 0, tokensSoFar: 0 });
    jp.event({ type: "tool-start", step: 0, toolName: "literature_search", input: { query: "magnesium sleep" } });
    jp.event({ type: "tool-end", step: 0, toolName: "literature_search", durationMs: 1400, outputChars: 12_300 });
    jp.event({ type: "step-end", step: 0, inputTokens: 1400, outputTokens: 210, finishReason: "tool-calls", toolCalls: 1, textChars: 0 });
    jp.event({ type: "step-start", step: 1, forced: "step limit", tokensSoFar: 1610 });
    jp.scoring();
    jp.finished(row(), record(), { reused: false });
    expect(lines).toEqual([
      "▶ [1/4] synthesis-02 · mcp · m · run 1",
      "  │ step 1 · calling model…",
      '  │   → literature_search "magnesium sleep"',
      "  │   ← literature_search · 1.4s · 12k chars",
      "  │ step 1 done · 1.4k in / 210 out · 1 tool call · tool-calls",
      "  │ step 2 · answer only, tools removed (step limit, 1.6k tok so far)…",
      "  │ scoring · verifying citations against PubMed…",
      "✔ [1/4] synthesis-02 · mcp · composite 8.50 (acc 9.0 · ev 4.5 · bs 1.00) · 38s · 17k tok · 2 steps · 1 tool call",
      "  ⏱ 1/4 done · elapsed 0s · 17k tok used",
    ]);
  });

  it("emits a heartbeat only after the configured silence, naming what it waits for", () => {
    const { lines, reporter, advance } = harness();
    const jp = reporter.job(info);
    jp.start();
    jp.event({ type: "step-start", step: 0, tokensSoFar: 0 });
    advance(10_000);
    jp.heartbeat(20_000);
    expect(lines.some((l) => l.includes("⋯"))).toBe(false);
    advance(15_000);
    jp.heartbeat(20_000);
    expect(lines.at(-1)).toBe("  │ ⋯ waiting for the model · step 1 · run time 25s / 5m00s timeout");
    jp.event({ type: "tool-start", step: 0, toolName: "literature_fulltext", input: { id: "1" } });
    advance(21_000);
    jp.heartbeat(20_000);
    expect(lines.at(-1)).toContain("waiting for literature_fulltext");
    jp.finished(row(), record(), { reused: false });
  });

  it("tags lines with the job number when runs execute in parallel", () => {
    const { lines, reporter } = harness({ concurrency: 3 });
    const jp = reporter.job(info);
    jp.start();
    jp.event({ type: "step-start", step: 0, tokensSoFar: 0 });
    expect(lines.at(-1)).toBe("  [1/4] step 1 · calling model…");
    jp.finished(row(), record(), { reused: false });
  });

  it("quiet mode prints only the result and overall lines", () => {
    const { lines, reporter } = harness({ quiet: true });
    const jp = reporter.job(info);
    jp.start();
    jp.event({ type: "step-start", step: 0, tokensSoFar: 0 });
    jp.finished(row({ status: "truncated" }), record(), { reused: false, reason: "no final answer" });
    expect(lines.map((l) => l.slice(0, 2))).toEqual(["▶ ", "✖ ", "  "]);
    expect(lines[1]).toContain("TRUNCATED: no final answer");
  });

  it("forecasts ETA and the runs left in the token budget from executed runs only", () => {
    const { lines, reporter, advance } = harness({ total: 4, tokenBudget: 100_000 });
    const a = reporter.job({ ...info, index: 1 });
    a.start();
    advance(60_000);
    a.finished(row(), record({ usage: { inputTokens: 0, outputTokens: 0, totalTokens: 20_000 } }), { reused: false });
    reporter.job({ ...info, index: 2 }).finished(row(), record(), { reused: true });
    reporter.job({ ...info, index: 3 }).skipped("token budget spent");
    expect(lines.filter((l) => l.startsWith("  ⏱")).at(-1)).toBe(
      "  ⏱ 3/4 done · elapsed 1m00s · ETA ~1m00s · 20k tok used · budget 100k (80k left, ~4 runs)",
    );
    expect(lines.some((l) => l.includes("reused from --resume"))).toBe(true);
    expect(lines.some((l) => l.startsWith("⏭ [3/4]"))).toBe(true);
  });
});
