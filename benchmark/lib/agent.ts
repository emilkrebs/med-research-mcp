/**
 * The agent loop: run one (model × condition × query) and capture everything
 * needed to score and audit it — text, tool calls, tokens, wall-clock.
 *
 * Conditions A, B, C and E differ only in the toolset handed to `generateText`:
 *   A closed-book → no tools
 *   B web-search  → Brave `web_search` / `web_fetch`
 *   E pubmed      → plain `pubmed_search` / `pubmed_fetch`: PubMed records as PubMed serves them
 *   C mcp         → literature_* tools served by the real MCP server (in-memory transport)
 * The system prompt is identical across those four (spec §"System Prompt").
 *   D mcp-skill   → C's tools plus the shipped `med-research` skill in the system prompt
 */

import { generateText, stepCountIs, type LanguageModel, type ModelMessage, type ToolSet } from "ai";
import { DEFAULTS, systemPromptFor, type ModelSpec } from "./config.js";
import { resolveModel } from "./providers.js";
import { mcpTools } from "./tools/literature.js";
import { pubmedTools } from "./tools/pubmed.js";
import { webSearchTools } from "./tools/websearch.js";
import type { BenchmarkQuery, ConditionId, RunRecord, ToolCallRecord, Usage } from "./types.js";

/** Tools for one run plus an optional cleanup hook (closes the MCP connection). */
interface ToolHandle {
  tools: ToolSet | undefined;
  close: () => Promise<void>;
}

const noClose = async (): Promise<void> => {};

/**
 * Build the toolset for a condition. Isolation: the mcp condition opens its own
 * in-memory MCP server/client pair per run (closed by the caller in `finally`),
 * with a fresh cache, so no connection or cached results are shared between
 * runs. Only the NCBI rate limiter is process-wide (see `sharedNcbi`), plus the
 * core's non-PubMed adapter registry — see `tools/literature.ts`.
 */
async function toolsFor(condition: ConditionId): Promise<ToolHandle> {
  switch (condition) {
    case "closed-book":
      return { tools: undefined, close: noClose };
    case "web-search":
      return { tools: webSearchTools(), close: noClose };
    case "pubmed":
      return { tools: pubmedTools(), close: noClose };
    case "mcp":
    case "mcp-skill":
      return mcpTools();
  }
}

/** Read token usage defensively; v7 reports `inputTokens`/`outputTokens`/`totalTokens` (older SDKs: prompt/completion). */
function extractUsage(result: Record<string, unknown>): Usage {
  const u = (result.totalUsage ?? result.usage ?? {}) as Record<string, number | undefined>;
  const inputTokens = u.inputTokens ?? u.promptTokens ?? 0;
  const outputTokens = u.outputTokens ?? u.completionTokens ?? 0;
  const totalTokens = u.totalTokens ?? inputTokens + outputTokens;
  return { inputTokens, outputTokens, totalTokens };
}

/**
 * Per-step `usage.inputTokens` in step order (v7 `StepResult.usage`; undefined
 * when the provider did not report it, kept as `undefined` → dropped here only
 * if absent for every step).
 */
function extractStepInputTokens(result: Record<string, unknown>): (number | undefined)[] {
  const steps = (result.steps ?? []) as { usage?: { inputTokens?: number } }[];
  return steps.map((s) => (typeof s.usage?.inputTokens === "number" ? s.usage.inputTokens : undefined));
}

/**
 * Provider-side context truncation detector. The conversation only grows (each
 * step re-sends every earlier message plus the new tool results), so a step's
 * input tokens can never legitimately fall below the previous step's. A drop
 * means the provider silently discarded the start of the prompt (e.g. Ollama's
 * 4096-token default context). Only compares consecutive steps that both report.
 */
export function detectContextTruncation(stepInputTokens: (number | undefined)[]): boolean {
  for (let i = 1; i < stepInputTokens.length; i++) {
    const prev = stepInputTokens[i - 1];
    const cur = stepInputTokens[i];
    if (prev !== undefined && cur !== undefined && cur < prev) return true;
  }
  return false;
}

/**
 * Live progress events from one run, for the runner's progress output. They are
 * purely observational: nothing in the RunRecord depends on them.
 *  - `step-start`: a model call is about to be made (`forced` = tools removed,
 *    the model must answer, and why; "forced completion" is the extra call after
 *    a loop that ended without an answer, see FORCED_COMPLETION_PROMPT).
 *  - `tool-start` / `tool-end`: one tool execution (the model asked for it).
 *  - `step-end`: the model call and its tool executions finished.
 */
export type RunEvent =
  | { type: "step-start"; step: number; forced?: "step limit" | "token cap" | "forced completion"; tokensSoFar: number }
  | { type: "tool-start"; step: number; toolName: string; input: unknown }
  | { type: "tool-end"; step: number; toolName: string; durationMs: number; outputChars: number; error?: string }
  | {
      type: "step-end";
      step: number;
      inputTokens?: number;
      outputTokens?: number;
      finishReason?: string;
      toolCalls: number;
      textChars: number;
    };

/** Character length of a tool output as the model sees it (strings as-is, objects serialized). */
function outputLength(out: unknown): number {
  if (typeof out === "string") return out.length;
  try {
    return JSON.stringify(out)?.length ?? 0;
  } catch {
    return 0;
  }
}

/** What the `execute` wrapper observed for one tool call, keyed by `toolCallId`. */
interface ToolTiming {
  durationMs: number;
  /** Set when execute() threw; the SDK turns that into a tool-error result. */
  error?: string;
}

/**
 * Wrap every tool's `execute` to time it (and report it live via `emit`). Done
 * generically on the ToolSet so it works for MCP-proxied and local tools alike.
 * Streaming (async-iterable) executes are passed through untimed.
 */
function timeTools(
  tools: ToolSet,
  timings: Map<string, ToolTiming>,
  emit: (e: RunEvent) => void = () => {},
  currentStep: () => number = () => 0,
): ToolSet {
  const wrapped: ToolSet = {};
  for (const [name, t] of Object.entries(tools)) {
    const orig = (t as { execute?: (input: unknown, options: { toolCallId: string }) => unknown }).execute;
    if (!orig) {
      wrapped[name] = t;
      continue;
    }
    wrapped[name] = {
      ...t,
      execute: async (input: unknown, options: { toolCallId: string }) => {
        const t0 = Date.now();
        const step = currentStep();
        emit({ type: "tool-start", step, toolName: name, input });
        try {
          const out = await orig.call(t, input, options);
          const durationMs = Date.now() - t0;
          timings.set(options.toolCallId, { durationMs });
          emit({ type: "tool-end", step, toolName: name, durationMs, outputChars: outputLength(out) });
          return out;
        } catch (err) {
          const durationMs = Date.now() - t0;
          const error = err instanceof Error ? err.message : String(err);
          timings.set(options.toolCallId, { durationMs, error });
          emit({ type: "tool-end", step, toolName: name, durationMs, outputChars: 0, error });
          throw err;
        }
      },
    } as ToolSet[string];
  }
  return wrapped;
}

/**
 * The user turn of the one extra call made when a tool loop ends without an
 * answer (see `runOne`). Harness text, not part of the system prompt, so it does
 * not enter the run fingerprint.
 */
export const FORCED_COMPLETION_PROMPT = "You are out of tool budget. Answer now from the evidence above. Do not call tools.";

/** Every message the loop produced, in order (v7 `responseMessages`; `response.messages` holds the last step only). */
function loopMessages(result: Record<string, unknown>): ModelMessage[] {
  const all = result.responseMessages as ModelMessage[] | undefined;
  if (Array.isArray(all)) return all;
  return ((result.response as { messages?: ModelMessage[] } | undefined)?.messages ?? []) as ModelMessage[];
}

/** Flatten tool calls (full outputs, durations) across every step of the loop. */
function extractToolCalls(result: Record<string, unknown>, timings: Map<string, ToolTiming>): ToolCallRecord[] {
  const steps = (result.steps ?? []) as Record<string, unknown>[];
  const records: ToolCallRecord[] = [];
  for (const step of steps) {
    const calls = (step.toolCalls ?? []) as Record<string, unknown>[];
    // v7 puts results and errors in `content` parts; `toolResults` has successes only.
    const content = (step.content ?? []) as Record<string, unknown>[];
    const results = [
      ...((step.toolResults ?? []) as Record<string, unknown>[]),
      ...content.filter((p) => p.type === "tool-result" || p.type === "tool-error"),
    ];
    for (const call of calls) {
      const toolName = String(call.toolName ?? "unknown");
      const id = String(call.toolCallId ?? "");
      const match = results.find((r) => r.toolCallId === id);
      const timing = timings.get(id);
      const isError = match?.type === "tool-error" || match?.isError === true || timing?.error !== undefined;
      const output = match ? (match.output ?? match.result ?? match.error) : undefined;
      records.push({
        toolName,
        input: call.input ?? call.args,
        ...(output !== undefined ? { output } : timing?.error ? { output: timing.error } : {}),
        ...(isError ? { isError: true } : {}),
        ...(timing ? { durationMs: timing.durationMs } : {}),
      });
    }
  }
  return records;
}

export interface RunOptions {
  maxSteps?: number;
  temperature?: number;
  /** Per-call SDK retries on transient provider errors (not whole-loop reruns). */
  retries?: number;
  /** Wall-clock budget for the whole agent loop; the run errors out when exceeded. */
  timeoutMs?: number;
  /**
   * Soft per-run token cap (input + output, summed over steps). Once the steps
   * so far have used this many tokens, the next step is text-only so the model
   * must answer. Soft because the step that crosses the line is already paid for.
   */
  tokenCap?: number;
  /**
   * Live progress callback (step starts/ends, tool calls). Must not throw; any
   * exception it raises is swallowed so progress output can never break a run.
   */
  onEvent?: (event: RunEvent) => void;
  /** Test injection: use this model instead of resolving `model` via providers. */
  languageModel?: LanguageModel;
  /** Test injection: use these tools instead of the condition's toolset. */
  tools?: ToolSet;
}

/** Execute one run and return its full record. Never throws — provider failures
 * and timeouts are captured in `error` so the batch keeps going (a timeout scores 0, a provider failure is missing data). */
export async function runOne(
  query: BenchmarkQuery,
  condition: ConditionId,
  model: ModelSpec,
  runIndex: number,
  opts: RunOptions = {},
): Promise<RunRecord> {
  const maxSteps = opts.maxSteps ?? DEFAULTS.maxSteps;
  const temperature = opts.temperature ?? DEFAULTS.temperature;
  const maxRetries = opts.retries ?? DEFAULTS.providerRetries;
  const timeoutMs = opts.timeoutMs ?? DEFAULTS.timeoutMs;

  const startedAt = new Date().toISOString();
  const t0 = Date.now();
  const abortSignal = AbortSignal.timeout(timeoutMs);
  const systemPrompt = systemPromptFor(condition);

  const base: Omit<RunRecord, "text" | "toolCalls" | "toolCallCount" | "toolsUsed" | "usage" | "speedS" | "finishedAt"> = {
    queryId: query.id,
    category: query.category,
    split: query.split ?? "dev",
    ...(query.retrievalOnly ? { retrievalOnly: true } : {}),
    ...(query.beyondPubmed ? { beyondPubmed: true } : {}),
    condition,
    model: model.label,
    provider: model.provider,
    modelId: model.modelId,
    settings: { temperature, maxSteps, timeoutMs },
    run: runIndex,
    systemPrompt,
    prompt: query.prompt,
    startedAt,
  };

  let close = noClose;
  try {
    const llm = opts.languageModel ?? (await resolveModel(model));
    const handle: ToolHandle = opts.tools ? { tools: opts.tools, close: noClose } : await toolsFor(condition);
    close = handle.close;
    const timings = new Map<string, ToolTiming>();
    const emit = (e: RunEvent): void => {
      try {
        opts.onEvent?.(e);
      } catch {
        /* progress output must never break a run */
      }
    };
    let currentStep = 0;
    const tools = handle.tools ? timeTools(handle.tools, timings, emit, () => currentStep) : undefined;
    // Anthropic honors `toolChoice: "none"` and 400s ("Requests which include tool_use or
    // tool_result blocks must define tools") once the history holds tool calls but the request
    // defines no tools, so its forced step keeps the definitions and relies on toolChoice alone.
    // Every other provider gets the tools removed and no toolChoice: with no tools, the OpenAI,
    // DeepSeek and Ollama adapters send no tool_choice anyway, and since ai 7.0.149 an SDK-level
    // "none" turns a stray tool call (DeepSeek emits them with no tools defined) into a thrown
    // ToolChoiceViolationError that loses the run. Without it the stray call is recorded as an
    // AI_NoSuchToolError tool error, the loop ends without text, and the completion call below answers.
    const keepToolsWhenForced = model.provider === "anthropic";

    const onStepEnd = (step: {
      usage?: { inputTokens?: number; outputTokens?: number };
      finishReason?: string;
      toolCalls?: unknown[];
      text?: string;
    }): void => {
      emit({
        type: "step-end",
        step: currentStep,
        ...(typeof step.usage?.inputTokens === "number" ? { inputTokens: step.usage.inputTokens } : {}),
        ...(typeof step.usage?.outputTokens === "number" ? { outputTokens: step.usage.outputTokens } : {}),
        ...(step.finishReason !== undefined ? { finishReason: String(step.finishReason) } : {}),
        toolCalls: step.toolCalls?.length ?? 0,
        textChars: step.text?.length ?? 0,
      });
    };

    // First step with the tools removed. Dropping the tool definitions shrinks the prompt, so
    // that step's input tokens legitimately fall; it must not be read as context truncation.
    let forcedAt: number | undefined;
    const result = (await generateText({
      model: llm,
      system: systemPrompt,
      prompt: query.prompt,
      ...(model.fixedSampling ? {} : { temperature }),
      maxRetries,
      abortSignal,
      ...(tools ? { tools, stopWhen: stepCountIs(maxSteps) } : {}),
      // Runs for every step, with or without tools. `stepNumber` is 0-based, so the
      // last allowed step is maxSteps - 1. With tools, forbid tool calls there (or
      // once the token cap is spent) so the model must write its answer instead of
      // leaving `text` empty. Some providers ignore `toolChoice: "none"`, so the
      // tools are taken off the table instead (except on Anthropic, see above).
      prepareStep: ({ stepNumber, steps }: { stepNumber: number; steps: Array<{ usage?: { totalTokens?: number } }> }) => {
        currentStep = stepNumber;
        const spent = steps.reduce((sum, st) => sum + (st.usage?.totalTokens ?? 0), 0);
        const forced: "step limit" | "token cap" | undefined = !tools
          ? undefined
          : stepNumber >= maxSteps - 1
            ? "step limit"
            : opts.tokenCap !== undefined && spent >= opts.tokenCap
              ? "token cap"
              : undefined;
        if (forced && forcedAt === undefined) forcedAt = stepNumber;
        emit({ type: "step-start", step: stepNumber, ...(forced ? { forced } : {}), tokensSoFar: spent });
        if (!forced) return undefined;
        return keepToolsWhenForced ? { toolChoice: "none" as const } : { activeTools: [] };
      },
      onStepEnd,
    })) as unknown as Record<string, unknown>;

    const steps = (result.steps ?? []) as unknown[];
    const stepTokens = extractStepInputTokens(result);
    const loopUsage = extractUsage(result);
    const loopText = String(result.text ?? "");
    const loopFinish = result.finishReason !== undefined ? String(result.finishReason) : undefined;

    // A tool loop that ends still calling tools (or cut off by the output limit) with no text has
    // no answer, even after the forced step: some models emit a tool call with no tools defined.
    // One extra call, without tools, on the whole conversation so far asks for the answer. It is
    // flagged `forcedCompletion`; its usage is added to the run's, and `stepCount` stays the loop's.
    // When this call is empty too, the run is a real no-answer.
    let completion: Record<string, unknown> | undefined;
    if (tools && loopText.trim() === "" && (loopFinish === "tool-calls" || loopFinish === "length")) {
      currentStep = steps.length;
      emit({ type: "step-start", step: currentStep, forced: "forced completion", tokensSoFar: loopUsage.totalTokens });
      completion = (await generateText({
        model: llm,
        system: systemPrompt,
        messages: [{ role: "user", content: query.prompt }, ...loopMessages(result), { role: "user", content: FORCED_COMPLETION_PROMPT }],
        ...(model.fixedSampling ? {} : { temperature }),
        maxRetries,
        abortSignal,
        // Anthropic needs the definitions whenever the history holds tool calls (see above).
        ...(keepToolsWhenForced ? { tools, toolChoice: "none" as const } : {}),
        onStepEnd,
      })) as unknown as Record<string, unknown>;
    }

    const toolCalls = [...extractToolCalls(result, timings), ...(completion ? extractToolCalls(completion, timings) : [])];
    const toolsUsed = [...new Set(toolCalls.map((c) => c.toolName))];
    const toolS = toolCalls.reduce((sum, c) => sum + (c.durationMs ?? 0), 0) / 1000;
    const completionUsage = completion ? extractUsage(completion) : undefined;
    const usage: Usage = completionUsage
      ? {
          inputTokens: loopUsage.inputTokens + completionUsage.inputTokens,
          outputTokens: loopUsage.outputTokens + completionUsage.outputTokens,
          totalTokens: loopUsage.totalTokens + completionUsage.totalTokens,
        }
      : loopUsage;
    const finishReason = completion ? (completion.finishReason !== undefined ? String(completion.finishReason) : undefined) : loopFinish;

    return {
      ...base,
      text: completion ? String(completion.text ?? "") : loopText,
      toolCalls,
      toolCallCount: toolCalls.length,
      toolsUsed,
      usage,
      speedS: (Date.now() - t0) / 1000,
      toolS,
      ...(finishReason !== undefined ? { finishReason } : {}),
      ...(completion ? { forcedCompletion: true } : {}),
      stepCount: steps.length,
      // Unreported steps are stored as 0 so the array stays index-aligned with steps.
      ...(stepTokens.length > 0 ? { stepInputTokens: stepTokens.map((t) => t ?? 0) } : {}),
      ...(detectContextTruncation(forcedAt === undefined ? stepTokens : stepTokens.slice(0, forcedAt)) ? { contextTruncated: true } : {}),
      finishedAt: new Date().toISOString(),
    };
  } catch (err) {
    const message = abortSignal.aborted
      ? `timeout after ${Math.round(timeoutMs / 1000)}s`
      : err instanceof Error
        ? err.message
        : String(err);
    return {
      ...base,
      text: "",
      toolCalls: [],
      toolCallCount: 0,
      toolsUsed: [],
      usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
      speedS: (Date.now() - t0) / 1000,
      finishedAt: new Date().toISOString(),
      error: message,
    };
  } finally {
    await close().catch(() => {});
  }
}
