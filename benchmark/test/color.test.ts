import { describe, expect, it } from "vitest";
import { colorEnabled, palette, stripAnsi } from "../lib/color.js";
import { ProgressReporter } from "../lib/progress.js";
import type { RunRecord, ScoreRow } from "../lib/types.js";

describe("colorEnabled", () => {
  it("is on by default, piped or not", () => {
    expect(colorEnabled({})).toBe(true);
    expect(colorEnabled({ TERM: "dumb" })).toBe(true);
  });
  it("honors NO_COLOR and FORCE_COLOR=0 as the only opt-outs", () => {
    expect(colorEnabled({ NO_COLOR: "1" })).toBe(false);
    expect(colorEnabled({ NO_COLOR: "" })).toBe(true);
    expect(colorEnabled({ FORCE_COLOR: "0" })).toBe(false);
    expect(colorEnabled({ FORCE_COLOR: "1" })).toBe(true);
  });
});

describe("palette", () => {
  it("is the identity when disabled and wraps in SGR codes when enabled", () => {
    expect(palette(false).red("x")).toBe("x");
    expect(palette(true).red("x")).toBe("\u001b[31mx\u001b[39m");
    expect(stripAnsi(palette(true).bold(palette(true).green("ok")))).toBe("ok");
  });
});

describe("colored progress output", () => {
  function render(color: boolean, composite: number): string[] {
    const lines: string[] = [];
    let t = 0;
    const r = new ProgressReporter({ total: 2, concurrency: 1, color, tokenBudget: 100_000, write: (l) => lines.push(l), now: () => t });
    const jp = r.job({ index: 1, queryId: "bullshit-04", condition: "mcp", model: "m", run: 1 });
    jp.start();
    jp.event({ type: "step-start", step: 0, tokensSoFar: 0 });
    jp.event({ type: "tool-start", step: 0, toolName: "literature_fetch", input: { ids: ["99999999"], database: "pubmed" } });
    jp.event({ type: "tool-end", step: 0, toolName: "literature_fetch", durationMs: 200, outputChars: 131 });
    jp.event({ type: "tool-end", step: 0, toolName: "literature_fetch", durationMs: 50, outputChars: 0, error: "HTTP 500" });
    jp.event({ type: "step-end", step: 0, inputTokens: 1100, outputTokens: 167, finishReason: "tool-calls", toolCalls: 1, textChars: 0 });
    jp.event({ type: "step-start", step: 1, forced: "token cap", tokensSoFar: 52_000 });
    jp.scoring();
    t += 8000;
    jp.finished({ status: "ok", composite, accuracy: 10, evidence_quality: 0, bullshit_score: 1 } as ScoreRow, {
      speedS: 8,
      usage: { inputTokens: 2000, outputTokens: 600, totalTokens: 2600 },
      stepCount: 2,
      toolCallCount: 1,
    } as RunRecord, { reused: false });
    r.job({ index: 2, queryId: "factual-01", condition: "closed-book", model: "m", run: 1 }).skipped("token budget spent");
    return lines;
  }

  it("changes only the styling: stripped, it is identical to the plain output", () => {
    const plain = render(false, 10);
    const colored = render(true, 10);
    expect(colored.some((l) => l.includes("\u001b["))).toBe(true);
    expect(plain.some((l) => l.includes("\u001b["))).toBe(false);
    expect(colored.map(stripAnsi)).toEqual(plain);
  });

  it("colors by meaning: tool calls cyan, errors red, forced answers and skips yellow, composite by value", () => {
    const lines = render(true, 10);
    const find = (needle: string) => lines.find((l) => stripAnsi(l).includes(needle)) ?? "";
    expect(find("→ literature_fetch")).toContain("\u001b[36mliterature_fetch");
    expect(find("✖ literature_fetch")).toContain("\u001b[31m");
    expect(find("answer only, tools removed")).toContain("\u001b[33m");
    expect(find("skipped")).toContain("\u001b[33m");
    expect(find("composite")).toContain("\u001b[32m10.00");
    expect(render(true, 5.1).find((l) => stripAnsi(l).includes("composite"))).toContain("\u001b[33m5.10");
    expect(render(true, 2).find((l) => stripAnsi(l).includes("composite"))).toContain("\u001b[31m2.00");
  });
});
