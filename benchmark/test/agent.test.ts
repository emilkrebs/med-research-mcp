import { afterEach, describe, expect, it } from "vitest";
import { tool } from "ai";
import { MockLanguageModelV4 } from "ai/test";
import { z } from "zod";
import { FORCED_COMPLETION_PROMPT, runOne } from "../lib/agent.js";
import { DEFAULT_MODELS, MODELS, missingKeyFor, type ModelSpec } from "../lib/config.js";
import { runOutcome } from "../lib/status.js";
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
  it("carries the query's retrieval-only and beyond-PubMed flags on the record, and nothing when they are not set", async () => {
    const llm = () => new MockLanguageModelV4({ doGenerate: async () => textResult("final answer") });
    const plain = await runOne(query, "closed-book", spec, 0, { languageModel: llm() });
    expect("beyondPubmed" in plain).toBe(false);
    expect("retrievalOnly" in plain).toBe(false);
    const flagged = await runOne({ ...query, beyondPubmed: true, retrievalOnly: true }, "closed-book", spec, 0, { languageModel: llm() });
    expect(flagged.beyondPubmed).toBe(true);
    expect(flagged.retrievalOnly).toBe(true);
    const inPubmed = await runOne({ ...query, beyondPubmed: false }, "closed-book", spec, 0, { languageModel: llm() });
    expect("beyondPubmed" in inPubmed).toBe(false);
  });

  it("removes the tools (not just toolChoice) on the forced last step, for providers that ignore toolChoice", async () => {
    const llm = new MockLanguageModelV4({
      doGenerate: async (options) => (options.tools?.length ? toolCallResult("c") : textResult("final answer")),
    });
    const rec = await runOne(query, "mcp", spec, 0, { maxSteps: 2, languageModel: llm, tools: stubTools });
    expect(llm.doGenerateCalls.map((c) => c.tools?.length ?? 0)).toEqual([1, 0]);
    expect(rec.text).toBe("final answer");
  });

  it("keeps the tool definitions on Anthropic's forced last step (it 400s on tool history without tools)", async () => {
    const llm = new MockLanguageModelV4({
      doGenerate: async (options) => (options.toolChoice?.type === "none" ? textResult("final answer") : toolCallResult("c")),
    });
    const anthropic: ModelSpec = { ...spec, provider: "anthropic", apiKeyEnv: "ANTHROPIC_API_KEY" };
    const rec = await runOne(query, "mcp", anthropic, 0, { maxSteps: 2, languageModel: llm, tools: stubTools });
    expect(llm.doGenerateCalls.map((c) => [c.tools?.length ?? 0, c.toolChoice?.type])).toEqual([
      [1, "auto"],
      [1, "none"],
    ]);
    expect(rec.text).toBe("final answer");
  });

  it("sends temperature normally, but not for fixedSampling models", async () => {
    const llm = new MockLanguageModelV4({ doGenerate: async () => textResult("ok") });
    await runOne(query, "closed-book", spec, 0, { languageModel: llm });
    await runOne(query, "closed-book", { ...spec, fixedSampling: true }, 0, { languageModel: llm });
    expect(llm.doGenerateCalls.map((c) => c.temperature)).toEqual([0, undefined]);
  });

  it("does not flag the forced text-only step (smaller prompt: no tool definitions) as context truncation", async () => {
    const big = { ...usage, inputTokens: { total: 20000, noCache: 20000, cacheRead: 0, cacheWrite: 0 } };
    const small = { ...usage, inputTokens: { total: 19000, noCache: 19000, cacheRead: 0, cacheWrite: 0 } };
    const llm = new MockLanguageModelV4({
      doGenerate: async (options) =>
        options.tools?.length ? { ...toolCallResult("c"), usage: big } : { ...textResult("final answer"), usage: small },
    });
    const rec = await runOne(query, "mcp", spec, 0, { maxSteps: 2, languageModel: llm, tools: stubTools });
    expect(rec.stepInputTokens).toEqual([20000, 19000]);
    expect(rec.contextTruncated).toBeUndefined();
  });

  it("emits live progress events in order (step start, tool start/end, step end)", async () => {
    let n = 0;
    const llm = new MockLanguageModelV4({
      doGenerate: async (options) => (options.tools?.length && n++ === 0 ? toolCallResult("c1") : textResult("done")),
    });
    const events: string[] = [];
    await runOne(query, "mcp", spec, 0, {
      maxSteps: 4,
      languageModel: llm,
      tools: stubTools,
      onEvent: (e) => events.push(`${e.type}:${e.step}${e.type === "tool-start" || e.type === "tool-end" ? `:${e.toolName}` : ""}`),
    });
    expect(events).toEqual(["step-start:0", "tool-start:0:lookup", "tool-end:0:lookup", "step-end:0", "step-start:1", "step-end:1"]);
  });

  it("a throwing progress callback never breaks the run", async () => {
    const llm = new MockLanguageModelV4({ doGenerate: async () => textResult("fine") });
    const rec = await runOne(query, "closed-book", spec, 0, {
      languageModel: llm,
      onEvent: () => {
        throw new Error("boom");
      },
    });
    expect(rec.error).toBeUndefined();
    expect(rec.text).toBe("fine");
  });

  it("forces an answer once the soft token cap is spent", async () => {
    // Each step reports 15 tokens; a cap of 20 is crossed after two steps.
    const llm = new MockLanguageModelV4({
      doGenerate: async (options) => (options.tools?.length ? toolCallResult("c") : textResult("capped answer")),
    });
    const rec = await runOne(query, "mcp", spec, 0, { maxSteps: 10, tokenCap: 20, languageModel: llm, tools: stubTools });
    expect(llm.doGenerateCalls.length).toBe(3);
    expect(rec.text).toBe("capped answer");
    expect(rec.finishReason).toBe("stop");
  });

  it("removes the tools on the last step and records provenance, output, durations", async () => {
    let n = 0;
    const llm = new MockLanguageModelV4({
      doGenerate: async (options) => {
        n++;
        // Step 3 (the last allowed with maxSteps=3) must have the tools removed.
        if (!options.tools?.length) return textResult("final answer");
        return toolCallResult(`call-${n}`);
      },
    });
    const rec = await runOne(query, "mcp", spec, 0, { maxSteps: 3, languageModel: llm, tools: stubTools });

    expect(rec.error).toBeUndefined();
    expect(llm.doGenerateCalls.map((c) => c.tools?.length ?? 0)).toEqual([1, 1, 0]);
    expect(rec.text).toBe("final answer");
    expect(rec.finishReason).toBe("stop");
    expect(rec.forcedCompletion).toBeUndefined();
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

  describe("forced completion after a loop that ends without an answer", () => {
    type Prompt = (typeof MockLanguageModelV4.prototype.doGenerateCalls)[number]["prompt"];
    const isCompletionCall = (prompt: Prompt): boolean => {
      const last = prompt.at(-1);
      return last?.role === "user" && last.content.some((p) => p.type === "text" && p.text === FORCED_COMPLETION_PROMPT);
    };

    it("records the stray tool call of the forced step, then answers from one extra call without tools", async () => {
      // DeepSeek's behaviour: it emits a tool call even when the request defines no tools.
      const llm = new MockLanguageModelV4({
        doGenerate: async (options) => (isCompletionCall(options.prompt) ? textResult("final answer") : toolCallResult(`c${options.prompt.length}`)),
      });
      const rec = await runOne(query, "mcp", spec, 0, { maxSteps: 2, languageModel: llm, tools: stubTools });

      expect(rec.error).toBeUndefined();
      expect(llm.doGenerateCalls.map((c) => c.tools?.length ?? 0)).toEqual([1, 0, 0]);
      expect(llm.doGenerateCalls.map((c) => c.toolChoice?.type ?? "unset")).not.toContain("none");
      // The extra call sees the whole conversation: the question, both steps (the executed tool result too), the nudge.
      const prompt = llm.doGenerateCalls[2]!.prompt;
      expect(prompt.map((m) => m.role)).toEqual(["system", "user", "assistant", "tool", "assistant", "tool", "user"]);
      expect(JSON.stringify(prompt[3])).toContain("PMID 123");
      expect(JSON.stringify(prompt[5])).toContain("AI_NoSuchToolError");

      expect(rec.text).toBe("final answer");
      expect(rec.forcedCompletion).toBe(true);
      expect(rec.finishReason).toBe("stop");
      expect(runOutcome(rec)).toBeUndefined();
      // Usage covers all three model calls (10 in / 5 out each); steps stay the loop's two.
      expect(rec.usage).toEqual({ inputTokens: 30, outputTokens: 15, totalTokens: 45 });
      expect(rec.stepCount).toBe(2);
      expect(rec.stepInputTokens).toEqual([10, 10]);
      expect(rec.toolCallCount).toBe(2);
      expect(rec.toolCalls[1]).toMatchObject({ toolName: "lookup", isError: true });
      expect(String(rec.toolCalls[1]?.output)).toContain("AI_NoSuchToolError");
    });

    it("stays a no-answer when the extra call is empty too, and makes only one", async () => {
      const llm = new MockLanguageModelV4({ doGenerate: async (options) => toolCallResult(`c${options.prompt.length}`) });
      const rec = await runOne(query, "mcp", spec, 0, { maxSteps: 2, languageModel: llm, tools: stubTools });
      expect(llm.doGenerateCalls.length).toBe(3);
      expect(rec.forcedCompletion).toBe(true);
      expect(rec.text).toBe("");
      expect(rec.finishReason).toBe("tool-calls");
      expect(runOutcome(rec)).toBe("no-answer");
    });

    it("also answers a forced step cut off by the length limit with no text", async () => {
      const cutOff = { content: [], finishReason: { unified: "length" as const, raw: undefined }, usage, warnings: [] };
      const llm = new MockLanguageModelV4({
        doGenerate: async (options) =>
          isCompletionCall(options.prompt) ? textResult("final answer") : options.tools?.length ? toolCallResult("c1") : cutOff,
      });
      const rec = await runOne(query, "mcp", spec, 0, { maxSteps: 2, languageModel: llm, tools: stubTools });
      expect(llm.doGenerateCalls.length).toBe(3);
      expect(rec.forcedCompletion).toBe(true);
      expect(rec.text).toBe("final answer");
    });

    it("keeps the tool definitions with toolChoice none on Anthropic's extra call", async () => {
      const cutOff = { content: [], finishReason: { unified: "length" as const, raw: undefined }, usage, warnings: [] };
      const llm = new MockLanguageModelV4({
        doGenerate: async (options) =>
          isCompletionCall(options.prompt) ? textResult("final answer") : options.toolChoice?.type === "none" ? cutOff : toolCallResult("c1"),
      });
      const anthropic: ModelSpec = { ...spec, provider: "anthropic", apiKeyEnv: "ANTHROPIC_API_KEY" };
      const rec = await runOne(query, "mcp", anthropic, 0, { maxSteps: 2, languageModel: llm, tools: stubTools });
      expect(llm.doGenerateCalls.map((c) => [c.tools?.length ?? 0, c.toolChoice?.type])).toEqual([
        [1, "auto"],
        [1, "none"],
        [1, "none"],
      ]);
      expect(rec.text).toBe("final answer");
      expect(rec.forcedCompletion).toBe(true);
    });

    it("makes no extra call without tools (closed-book), or when the loop ended with text", async () => {
      const empty = { content: [], finishReason: { unified: "length" as const, raw: undefined }, usage, warnings: [] };
      const closed = new MockLanguageModelV4({ doGenerate: async () => empty });
      const rec = await runOne(query, "closed-book", spec, 0, { languageModel: closed });
      expect(closed.doGenerateCalls.length).toBe(1);
      expect(rec.forcedCompletion).toBeUndefined();
      expect(runOutcome(rec)).toBe("no-answer");

      const answered = new MockLanguageModelV4({ doGenerate: async (o) => (o.tools?.length ? toolCallResult("c1") : textResult("done")) });
      const ok = await runOne(query, "mcp", spec, 0, { maxSteps: 2, languageModel: answered, tools: stubTools });
      expect(answered.doGenerateCalls.length).toBe(2);
      expect(ok.forcedCompletion).toBeUndefined();
    });

    it("reports the extra call as a forced step in the progress events", async () => {
      const llm = new MockLanguageModelV4({
        doGenerate: async (options) => (isCompletionCall(options.prompt) ? textResult("final answer") : toolCallResult(`c${options.prompt.length}`)),
      });
      const forced: (string | undefined)[] = [];
      await runOne(query, "mcp", spec, 0, {
        maxSteps: 2,
        languageModel: llm,
        tools: stubTools,
        onEvent: (e) => {
          if (e.type === "step-start") forced.push(`${e.step}:${e.forced ?? "-"}`);
        },
      });
      expect(forced).toEqual(["0:-", "1:step limit", "2:forced completion"]);
    });
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
