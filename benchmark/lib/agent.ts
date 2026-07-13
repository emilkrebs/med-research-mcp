/**
 * The agent loop: run one (model × condition × query) and capture everything
 * needed to score and audit it — text, tool calls, tokens, wall-clock.
 *
 * Conditions differ only in the toolset handed to `generateText`:
 *   A closed-book → no tools
 *   B web-search  → Brave `web_search`
 *   C mcp         → literature_search / _fetch / _fulltext over the core library
 * The system prompt is identical across all three (spec §"System Prompt").
 */

import { generateText, stepCountIs, type ToolSet } from "ai";
import { DEFAULTS, SYSTEM_PROMPT, type ModelSpec } from "./config.js";
import { resolveModel } from "./providers.js";
import { literatureTools } from "./tools/literature.js";
import { webSearchTools } from "./tools/websearch.js";
import { NcbiClient, LRUBackend } from "./core.js";
import type { BenchmarkQuery, ConditionId, RunRecord, ToolCallRecord, Usage } from "./types.js";

/** Build the toolset for a condition. Fresh cache/client per run for isolation. */
function toolsFor(condition: ConditionId): ToolSet | undefined {
  switch (condition) {
    case "closed-book":
      return undefined;
    case "web-search":
      return webSearchTools();
    case "mcp":
      return literatureTools(new LRUBackend(), new NcbiClient());
  }
}

/** Read token usage defensively — the AI SDK renamed these fields across versions. */
function extractUsage(result: Record<string, unknown>): Usage {
  const u = (result.totalUsage ?? result.usage ?? {}) as Record<string, number | undefined>;
  const inputTokens = u.inputTokens ?? u.promptTokens ?? 0;
  const outputTokens = u.outputTokens ?? u.completionTokens ?? 0;
  const totalTokens = u.totalTokens ?? inputTokens + outputTokens;
  return { inputTokens, outputTokens, totalTokens };
}

function preview(value: unknown, max = 1500): string {
  const s = typeof value === "string" ? value : JSON.stringify(value);
  return s.length > max ? `${s.slice(0, max)}…` : s;
}

/** Flatten tool calls (and their results) across every step of the loop. */
function extractToolCalls(result: Record<string, unknown>): ToolCallRecord[] {
  const steps = (result.steps ?? []) as Record<string, unknown>[];
  const records: ToolCallRecord[] = [];
  for (const step of steps) {
    const calls = (step.toolCalls ?? []) as Record<string, unknown>[];
    const results = (step.toolResults ?? []) as Record<string, unknown>[];
    for (const call of calls) {
      const toolName = String(call.toolName ?? "unknown");
      const match = results.find((r) => r.toolCallId === call.toolCallId);
      const output = match ? (match.output ?? match.result) : undefined;
      records.push({
        toolName,
        input: call.input ?? call.args,
        ...(output !== undefined ? { outputPreview: preview(output) } : {}),
        ...(match?.isError ? { isError: true } : {}),
      });
    }
  }
  return records;
}

async function withRetry<T>(fn: () => Promise<T>, retries: number): Promise<T> {
  let lastErr: unknown;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      if (attempt < retries) await new Promise((r) => setTimeout(r, 1000 * 2 ** attempt));
    }
  }
  throw lastErr;
}

export interface RunOptions {
  maxSteps?: number;
  temperature?: number;
  retries?: number;
}

/** Execute one run and return its full record. Never throws — provider failures
 * are captured in `error` so the batch keeps going and the row scores as a zero. */
export async function runOne(
  query: BenchmarkQuery,
  condition: ConditionId,
  model: ModelSpec,
  runIndex: number,
  opts: RunOptions = {},
): Promise<RunRecord> {
  const maxSteps = opts.maxSteps ?? DEFAULTS.maxSteps;
  const temperature = opts.temperature ?? DEFAULTS.temperature;
  const retries = opts.retries ?? DEFAULTS.providerRetries;

  const startedAt = new Date().toISOString();
  const t0 = Date.now();

  const base: Omit<RunRecord, "text" | "toolCalls" | "toolCallCount" | "toolsUsed" | "usage" | "speedS" | "finishedAt"> = {
    queryId: query.id,
    category: query.category,
    condition,
    model: model.label,
    run: runIndex,
    systemPrompt: SYSTEM_PROMPT,
    prompt: query.prompt,
    startedAt,
  };

  try {
    const llm = await resolveModel(model);
    const tools = toolsFor(condition);
    const result = (await withRetry(
      () =>
        generateText({
          model: llm,
          system: SYSTEM_PROMPT,
          prompt: query.prompt,
          temperature,
          ...(tools ? { tools, stopWhen: stepCountIs(maxSteps) } : {}),
        }),
      retries,
    )) as unknown as Record<string, unknown>;

    const toolCalls = extractToolCalls(result);
    const toolsUsed = [...new Set(toolCalls.map((c) => c.toolName))];

    return {
      ...base,
      text: String(result.text ?? ""),
      toolCalls,
      toolCallCount: toolCalls.length,
      toolsUsed,
      usage: extractUsage(result),
      speedS: (Date.now() - t0) / 1000,
      finishedAt: new Date().toISOString(),
    };
  } catch (err) {
    return {
      ...base,
      text: "",
      toolCalls: [],
      toolCallCount: 0,
      toolsUsed: [],
      usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
      speedS: (Date.now() - t0) / 1000,
      finishedAt: new Date().toISOString(),
      error: err instanceof Error ? err.message : String(err),
    };
  }
}
