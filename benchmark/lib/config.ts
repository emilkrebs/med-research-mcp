/**
 * Central configuration: the composite-score weights and normalization
 * references. Models are defined in the adjacent `models.data.ts` catalog so
 * swapping models doesn't require editing this module.
 *
 * Every field the paper depends on lives here so a run is reproducible from a
 * single file. API keys are read from the environment, never hard-coded.
 */

import type { ConditionId, ConditionLetter } from "./types.js";
import { MODELS as DEFINED_MODELS } from "../models.data.js";

/** Which AI SDK provider package backs a model. */
export type Provider = "openai" | "anthropic" | "deepseek" | "ollama";

export interface ModelSpec {
  /** Stable short label used in filenames, CSV rows, and report tables. */
  label: string;
  provider: Provider;
  /**
   * Pinned provider model id (e.g. `gpt-4o-2024-08-06`, not `gpt-4o`). Pinning
   * is required for reproducibility — an unpinned alias silently drifts.
   */
  modelId: string;
  /**
   * Env var holding the API key. Optional for `provider: "ollama"` (a local
   * server needs none); required for every other provider — see `missingKeyFor`.
   */
  apiKeyEnv: string;
  /** Optional env var holding a custom base URL (proxy, local server, Azure, etc.). */
  baseUrlEnv?: string;
  /**
   * When true, a custom fetch interceptor maps the `role:"developer"` system
   * message AI SDK v5 emits for "reasoning" models back to `role:"system"`,
   * which strict OpenAI-compatible endpoints (DashScope MaaS) require. Set it on
   * the *thinking* models (they get the `developer` role); leave it off for
   * ordinary chat models like qwen-max, which want the modern `role:"tool"`
   * results untouched. (Name kept for compatibility; it no longer rewrites tool
   * results to `role:"function"`.)
   */
  legacyFunctions?: boolean;
  /**
   * Included in default runs unless `false`. Disabled models stay in the catalog
   * (so past results stay reproducible) and are still selectable explicitly with
   * `--models <label>`.
   */
  enabled?: boolean;
  /**
   * True when `modelId` is a moving alias (`qwen-max`, `:latest`) rather than a
   * pinned snapshot. The runner warns about these: results may drift over time.
   */
  unpinned?: boolean;
}

/** Validate the model catalog defined in `benchmark/models.data.ts` (unique labels). */
function loadModels(): ModelSpec[] {
  const seen = new Set<string>();
  for (const m of DEFINED_MODELS) {
    if (seen.has(m.label)) throw new Error(`Duplicate model label in models.data.ts: "${m.label}"`);
    seen.add(m.label);
  }
  return DEFINED_MODELS;
}

export const MODELS: ModelSpec[] = loadModels();

/** Models run by default: everything not explicitly `enabled: false`. */
export const DEFAULT_MODELS: ModelSpec[] = MODELS.filter((m) => m.enabled !== false);

/**
 * Name of the env var that must be set but isn't, or undefined if the model is
 * runnable. Ollama (a local server) does not require a key; every other
 * provider does. Used by the runner's preflight and by `resolveModel`.
 */
export function missingKeyFor(spec: ModelSpec): string | undefined {
  if (spec.provider === "ollama") return undefined;
  return process.env[spec.apiKeyEnv] ? undefined : spec.apiKeyEnv;
}

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
  "Cite papers by PMID where available. Give your best answer with the " +
  "evidence you have gathered so far rather than continuing to search for " +
  "certainty — an answer with caveats beats no answer.";

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
  /**
   * Steps in the agent loop (tool-call rounds) before it must answer. 10 was
   * too tight for the mcp condition: models that hit zero results kept
   * reformulating queries across providers/languages and got cut off with an
   * empty final answer before ever synthesizing one (0% fabrication but 0
   * accuracy). 16 gives more room to converge without materially changing cost.
   */
  maxSteps: 16,
  temperature: 0,
  /** Per-call retries the AI SDK makes on a transient provider/network error (`maxRetries`). */
  providerRetries: 2,
  /** Wall-clock cap for one whole agent loop, so a hung provider can't stall the batch. */
  timeoutMs: Number(process.env.BENCH_TIMEOUT_MS ?? 300_000),
  /** Web-search results returned to the model in condition B. */
  webResults: 6,
} as const;
