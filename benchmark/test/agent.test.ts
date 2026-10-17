import { afterEach, describe, expect, it } from "vitest";
import { tool } from "ai";
import { MockLanguageModelV4 } from "ai/test";
import { z } from "zod";
import { runOne } from "../lib/agent.js";
import { DEFAULT_MODELS, MODELS, missingKeyFor, type ModelSpec } from "../lib/config.js";
import type { BenchmarkQuery } from "../lib/types.js";

const query: BenchmarkQuery = {
  id: "q1",
  category: "factual",
  prompt: "What is X?",
  answerKey: { kind: "rubric", rubric: "n/a" },
  verified: true,
};

const spec: ModelSpec = { label: "mock", provider: "openai", modelId: "mock-1", apiKeyEnv: "OPENAI_API_KEY" };

const usage = {
  inputTokens: { total: 10, noCache: 10, cacheRead: 0, cacheWrite: 0 },
  outputTokens: { total: 5, text: 5, reasoning: 0 },
};

const toolCallResult = (id: string) => ({
  content: [{ type: "tool-call" as const, toolCallId: id, toolName: "lookup", input: JSON.stringify({ q: "x" }) }],
  finishReason: { unified: "tool-calls" as const, raw: undefined },
  usage,
  warnings: [],
});

const textResult = (text: string) => ({
  content: [{ type: "text" as const, text }],
  finishReason: { unified: "stop" as const, raw: undefined },
  usage,
  warnings: [],
});

const stubTools = {
  lookup: tool({
    description: "stub",
    inputSchema: z.object({ q: z.string() }),
    execute: async () => {
      await new Promise((r) => setTimeout(r, 20));
      return { hit: "PMID 123" };
    },
  }),
};

describe("runOne", () => {
  it("forces toolChoice none on the last step and records provenance, output, durations", async () => {
    let n = 0;
    const llm = new MockLanguageModelV4({
      doGenerate: async (options) => {
        n++;
        // Step 3 (the last allowed with maxSteps=3) must have tools disabled.
        if (options.toolChoice?.type === "none") return textResult("final answer");
        return toolCallResult(`call-${n}`);
      },
    });
    const rec = await runOne(query, "mcp", spec, 0, { maxSteps: 3, languageModel: llm, tools: stubTools });

    expect(rec.error).toBeUndefined();
    expect(llm.doGenerateCalls.map((c) => c.toolChoice?.type)).toEqual(["auto", "auto", "none"]);
    expect(rec.text).toBe("final answer");
    expect(rec.finishReason).toBe("stop");
    expect(rec.stepCount).toBe(3);
    expect(rec.provider).toBe("openai");
    expect(rec.modelId).toBe("mock-1");
    expect(rec.settings).toMatchObject({ maxSteps: 3, temperature: 0 });
    expect(rec.toolCallCount).toBe(2);
    expect(rec.toolCalls[0]?.output).toEqual({ hit: "PMID 123" });
    expect(rec.toolCalls[0]?.durationMs).toBeGreaterThanOrEqual(15);
    expect(rec.toolS).toBeGreaterThanOrEqual(0.03);
    expect(rec.toolS).toBeLessThanOrEqual(rec.speedS);
    expect(rec.usage.totalTokens).toBeGreaterThan(0);
  });

  it("flags contextTruncated when a later step reports fewer input tokens", async () => {
    let n = 0;
    const withInput = (total: number, r: ReturnType<typeof textResult> | ReturnType<typeof toolCallResult>) => ({
      ...r,
      usage: { ...usage, inputTokens: { total, noCache: total, cacheRead: 0, cacheWrite: 0 } },
    });
    const llm = new MockLanguageModelV4({
      doGenerate: async () => {
        n++;
        // Step 2 re-sends a longer conversation but the provider reports fewer tokens: it dropped the start.
        return n === 1 ? withInput(1000, toolCallResult("c1")) : withInput(400, textResult("Please provide the question."));
      },
    });
    const rec = await runOne(query, "mcp", spec, 0, { maxSteps: 3, languageModel: llm, tools: stubTools });
    expect(rec.stepInputTokens).toEqual([1000, 400]);
    expect(rec.contextTruncated).toBe(true);
  });

  it("does not flag contextTruncated when input tokens grow", async () => {
    let n = 0;
    const llm = new MockLanguageModelV4({
      doGenerate: async () => {
        n++;
        const total = n * 500;
        const r = n === 1 ? toolCallResult("c1") : textResult("ok");
        return { ...r, usage: { ...usage, inputTokens: { total, noCache: total, cacheRead: 0, cacheWrite: 0 } } };
      },
    });
    const rec = await runOne(query, "mcp", spec, 0, { maxSteps: 3, languageModel: llm, tools: stubTools });
    expect(rec.stepInputTokens).toEqual([500, 1000]);
    expect(rec.contextTruncated).toBeUndefined();
  });

  it("captures a provider error in `error`", async () => {
    const llm = new MockLanguageModelV4({
      doGenerate: async () => {
        throw new Error("boom");
      },
    });
    const rec = await runOne(query, "closed-book", spec, 0, { languageModel: llm, retries: 0 });
    expect(rec.error).toContain("boom");
    expect(rec.text).toBe("");
  });

  it("records a timeout", async () => {
    const llm = new MockLanguageModelV4({
      doGenerate: (options) =>
        new Promise((_, reject) => {
          options.abortSignal?.addEventListener("abort", () => reject(new Error("aborted")));
        }),
    });
    const rec = await runOne(query, "closed-book", spec, 0, { languageModel: llm, timeoutMs: 50, retries: 0 });
    expect(rec.error).toMatch(/timeout/i);
  });
});

describe("model catalog", () => {
  const saved = process.env.OPENAI_API_KEY;
  afterEach(() => {
    if (saved === undefined) delete process.env.OPENAI_API_KEY;
    else process.env.OPENAI_API_KEY = saved;
  });

  it("missingKeyFor: ollama needs no key, openai does", () => {
    delete process.env.OPENAI_API_KEY;
    expect(missingKeyFor({ ...spec, provider: "ollama", apiKeyEnv: "OLLAMA_API_KEY" })).toBeUndefined();
    expect(missingKeyFor(spec)).toBe("OPENAI_API_KEY");
    process.env.OPENAI_API_KEY = "k";
    expect(missingKeyFor(spec)).toBeUndefined();
  });

  it("DEFAULT_MODELS excludes disabled models", () => {
    expect(DEFAULT_MODELS.length).toBeGreaterThan(0);
    expect(DEFAULT_MODELS.length).toBeLessThan(MODELS.length);
    expect(DEFAULT_MODELS.every((m) => m.enabled !== false)).toBe(true);
  });
});
