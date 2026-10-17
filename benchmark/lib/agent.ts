/**
 * The agent loop: run one (model × condition × query) and capture everything
 * needed to score and audit it — text, tool calls, tokens, wall-clock.
 *
 * Conditions differ only in the toolset handed to `generateText`:
 *   A closed-book → no tools
 *   B web-search  → Brave `web_search` / `web_fetch`
 *   C mcp         → literature_* tools served by the real MCP server (in-memory transport)
 * The system prompt is identical across all three (spec §"System Prompt").
 */

import { generateText, stepCountIs, type LanguageModel, type ToolSet } from "ai";
import { DEFAULTS, SYSTEM_PROMPT, type ModelSpec } from "./config.js";
import { resolveModel } from "./providers.js";
import { mcpTools } from "./tools/literature.js";
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
    case "mcp":
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

/** What the `execute` wrapper observed for one tool call, keyed by `toolCallId`. */
interface ToolTiming {
  durationMs: number;
  /** Set when execute() threw; the SDK turns that into a tool-error result. */
  error?: string;
}

/**
 * Wrap every tool's `execute` to time it. Done generically on the ToolSet so it
 * works for MCP-proxied and local tools alike. Streaming (async-iterable)
 * executes are passed through untimed.
 */
function timeTools(tools: ToolSet, timings: Map<string, ToolTiming>): ToolSet {
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
        try {
          const out = await orig.call(t, input, options);
          timings.set(options.toolCallId, { durationMs: Date.now() - t0 });
          return out;
        } catch (err) {
          timings.set(options.toolCallId, {
            durationMs: Date.now() - t0,
            error: err instanceof Error ? err.message : String(err),
          });
          throw err;
        }
      },
    } as ToolSet[string];
  }
  return wrapped;
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
  /** Test injection: use this model instead of resolving `model` via providers. */
  languageModel?: LanguageModel;
  /** Test injection: use these tools instead of the condition's toolset. */
  tools?: ToolSet;
}

/** Execute one run and return its full record. Never throws — provider failures
 * and timeouts are captured in `error` so the batch keeps going and the row scores as a zero. */
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

  const base: Omit<RunRecord, "text" | "toolCalls" | "toolCallCount" | "toolsUsed" | "usage" | "speedS" | "finishedAt"> = {
    queryId: query.id,
    category: query.category,
    condition,
    model: model.label,
    provider: model.provider,
    modelId: model.modelId,
    settings: { temperature, maxSteps, timeoutMs },
    run: runIndex,
    systemPrompt: SYSTEM_PROMPT,
    prompt: query.prompt,
    startedAt,
  };

  let close = noClose;
  try {
    const llm = opts.languageModel ?? (await resolveModel(model));
    const handle: ToolHandle = opts.tools ? { tools: opts.tools, close: noClose } : await toolsFor(condition);
    close = handle.close;
    const timings = new Map<string, ToolTiming>();
    const tools = handle.tools ? timeTools(handle.tools, timings) : undefined;

    const result = (await generateText({
      model: llm,
      system: SYSTEM_PROMPT,
      prompt: query.prompt,
      temperature,
      maxRetries,
      abortSignal,
      ...(tools
        ? {
            tools,
            stopWhen: stepCountIs(maxSteps),
            // `stepNumber` is 0-based, so the last allowed step is maxSteps - 1.
            // Forbid tool calls there so the model must write its answer instead
            // of burning the final step on a tool call and leaving `text` empty.
            prepareStep: ({ stepNumber }: { stepNumber: number }) =>
              stepNumber >= maxSteps - 1 ? { toolChoice: "none" as const } : undefined,
          }
        : {}),
    })) as unknown as Record<string, unknown>;

    const toolCalls = extractToolCalls(result, timings);
    const toolsUsed = [...new Set(toolCalls.map((c) => c.toolName))];
    const steps = (result.steps ?? []) as unknown[];
    const stepTokens = extractStepInputTokens(result);
    const toolS = toolCalls.reduce((sum, c) => sum + (c.durationMs ?? 0), 0) / 1000;

    return {
      ...base,
      text: String(result.text ?? ""),
      toolCalls,
      toolCallCount: toolCalls.length,
      toolsUsed,
      usage: extractUsage(result),
      speedS: (Date.now() - t0) / 1000,
      toolS,
      ...(result.finishReason !== undefined ? { finishReason: String(result.finishReason) } : {}),
      stepCount: steps.length,
      // Unreported steps are stored as 0 so the array stays index-aligned with steps.
      ...(stepTokens.length > 0 ? { stepInputTokens: stepTokens.map((t) => t ?? 0) } : {}),
      ...(detectContextTruncation(stepTokens) ? { contextTruncated: true } : {}),
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
