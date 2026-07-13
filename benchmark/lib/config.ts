/**
 * Central configuration: the models under test, the composite-score weights,
 * and the normalization references. Edit `MODELS` to change what gets run.
 *
 * Every field the paper depends on lives here so a run is reproducible from a
 * single file. API keys are read from the environment, never hard-coded.
 */

import type { ConditionId, ConditionLetter } from "./types.js";

/** Which AI SDK provider package backs a model. */
export type Provider = "openai" | "anthropic" | "deepseek";

export interface ModelSpec {
  /** Stable short label used in filenames, CSV rows, and report tables. */
  label: string;
  provider: Provider;
  /**
   * Pinned provider model id (e.g. `gpt-4o-2024-08-06`, not `gpt-4o`). Pinning
   * is required for reproducibility — an unpinned alias silently drifts.
   */
  modelId: string;
  /** Env var holding the API key. */
  apiKeyEnv: string;
}

/**
 * The models under test. Two by default (a "pro" and a "flash"), as the spec
 * describes. The DeepSeek ids below are the spec's examples — replace them with
 * ids you can actually call, and keep them pinned.
 *
 * To benchmark Claude or GPT instead, swap in entries like:
 *   { label: "claude-sonnet-4-5", provider: "anthropic",
 *     modelId: "claude-sonnet-4-5", apiKeyEnv: "ANTHROPIC_API_KEY" }
 *   { label: "gpt-4o", provider: "openai",
 *     modelId: "gpt-4o-2024-08-06", apiKeyEnv: "OPENAI_API_KEY" }
 */
export const MODELS: ModelSpec[] = [
  {
    label: "deepseek-v4-pro",
    provider: "deepseek",
    modelId: "deepseek-v4-pro",
    apiKeyEnv: "DEEPSEEK_API_KEY",
  },
  {
    label: "deepseek-v4-flash",
    provider: "deepseek",
    modelId: "deepseek-v4-flash",
    apiKeyEnv: "DEEPSEEK_API_KEY",
  },
];

/**
 * The model that grades free-text accuracy (synthesis rubrics, stated-value
 * extraction). Kept separate and capable so judging quality doesn't ride on the
 * model being tested. Override with `--judge <label>` or `BENCH_JUDGE_*`.
 */
export const JUDGE: ModelSpec = {
  label: process.env.BENCH_JUDGE_LABEL ?? "judge",
  provider: (process.env.BENCH_JUDGE_PROVIDER as Provider) ?? "openai",
  modelId: process.env.BENCH_JUDGE_MODEL ?? "gpt-4o-2024-08-06",
  apiKeyEnv: process.env.BENCH_JUDGE_KEY_ENV ?? "OPENAI_API_KEY",
};

/** The three conditions and the CLI letters that select them. */
export const CONDITIONS: Record<ConditionLetter, ConditionId> = {
  A: "closed-book",
  B: "web-search",
  C: "mcp",
};

export const CONDITION_LETTER: Record<ConditionId, ConditionLetter> = {
  "closed-book": "A",
  "web-search": "B",
  mcp: "C",
};

/**
 * Identical system prompt for every condition — the only thing that varies
 * between A/B/C is which tools are on the table. (Spec §"System Prompt".)
 */
export const SYSTEM_PROMPT =
  "Answer the following question. Support claims with specific evidence. " +
  "Cite papers by PMID where available.";

/** Composite-score weights. Must sum to 1. (Spec §"Composite Score".) */
export const WEIGHTS = {
  accuracy: 0.4,
  evidence: 0.25,
  bullshit: 0.25,
  speed: 0.05,
  cost: 0.05,
} as const;

/**
 * Normalization references for the two "faster/cheaper is better" terms, both
 * mapped to [0,1] (1 = instant / free, 0 = at or beyond the reference).
 * These set the scale of the 5% speed and 5% cost terms; document the values
 * you use alongside published results.
 */
export const NORMALIZATION = {
  /** A response at or above this wall-clock time gets speed_score 0. */
  speedRefS: Number(process.env.BENCH_SPEED_REF_S ?? 60),
  /** A response at or above this many total tokens gets cost_score 0. */
  tokenRef: Number(process.env.BENCH_TOKEN_REF ?? 20_000),
} as const;

export const DEFAULTS = {
  runs: 3,
  /** Steps in the agent loop (tool-call rounds) before it must answer. */
  maxSteps: 10,
  temperature: 0,
  /** Retries on a transient provider/network error, with backoff. */
  providerRetries: 2,
  /** Web-search results returned to the model in condition B. */
  webResults: 6,
} as const;
