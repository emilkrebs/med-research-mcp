/**
 * Run provenance and the two "can I trust old data?" decisions the runner makes:
 *  - the run manifest written to `<outDir>/manifest.json` at start, and
 *  - the resume fingerprint (may a stored raw record stand in for a new job?), and
 *  - the rescore staleness rule (does a stored `_scoring` need recomputing?).
 *
 * Pure functions plus a best-effort git probe; nothing here touches the network.
 */

import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { DEFAULTS, NORMALIZATION, WEIGHTS, systemPromptFor, type ModelSpec } from "./config.js";
import { SCORER_VERSION } from "./scoring/score.js";
import type { BenchmarkQuery, ConditionId, RunRecord, RunSettings, ScoreBreakdown } from "./types.js";

const REPO_ROOT = join(import.meta.dirname, "..", "..");
const BENCH_ROOT = join(import.meta.dirname, "..");

export interface GitInfo {
  /** Short commit hash, or "unknown" outside a git repo / without git. */
  commit: string;
  /** True when the working tree has uncommitted changes; null when unknown. */
  dirty: boolean | null;
}

/** Best-effort git state of `cwd`. Never throws. */
export function detectGit(cwd: string = REPO_ROOT): GitInfo {
  const git = (args: string[]): string =>
    execFileSync("git", args, { cwd, encoding: "utf-8", stdio: ["ignore", "pipe", "ignore"] }).trim();
  try {
    const commit = git(["rev-parse", "--short", "HEAD"]);
    let dirty: boolean | null = null;
    try {
      dirty = git(["status", "--porcelain"]).length > 0;
    } catch {
      /* status unavailable: leave unknown */
    }
    return { commit, dirty };
  } catch {
    return { commit: "unknown", dirty: null };
  }
}

function packageVersion(dir: string): string {
  const pkg = join(dir, "package.json");
  if (!existsSync(pkg)) return "unknown";
  try {
    return JSON.parse(readFileSync(pkg, "utf-8")).version ?? "unknown";
  } catch {
    return "unknown";
  }
}

export const detectMcpVersion = (): string => packageVersion(REPO_ROOT);
export const detectBenchmarkVersion = (): string => packageVersion(BENCH_ROOT);

/** The settings a run is generated with; also the resume-fingerprint settings. */
export interface ResolvedSettings extends RunSettings {
  retries: number;
}

export interface Manifest {
  timestamp: string;
  args: string[];
  git: GitInfo;
  mcp_version: string;
  benchmark_version: string;
  scorer_version: number;
  settings: ResolvedSettings;
  models: { label: string; provider: string; modelId: string; unpinned: boolean; fixedSampling?: true }[];
  conditions: ConditionId[];
  queries: { id: string; answerKeyVersion: number }[];
  weights: Record<string, number>;
  normalization: Record<string, number>;
  node: string;
}

export function buildManifest(input: {
  args: string[];
  settings: { temperature: number; maxSteps: number };
  models: ModelSpec[];
  conditions: ConditionId[];
  queries: BenchmarkQuery[];
  git?: GitInfo;
}): Manifest {
  return {
    timestamp: new Date().toISOString(),
    args: input.args,
    git: input.git ?? detectGit(),
    mcp_version: detectMcpVersion(),
    benchmark_version: detectBenchmarkVersion(),
    scorer_version: SCORER_VERSION,
    settings: {
      temperature: input.settings.temperature,
      maxSteps: input.settings.maxSteps,
      timeoutMs: DEFAULTS.timeoutMs,
      retries: DEFAULTS.providerRetries,
    },
    models: input.models.map((m) => ({
      label: m.label,
      provider: m.provider,
      modelId: m.modelId,
      unpinned: m.unpinned === true,
      ...(m.fixedSampling ? { fixedSampling: true as const } : {}),
    })),
    conditions: input.conditions,
    queries: input.queries.map((q) => ({ id: q.id, answerKeyVersion: q.answerKeyVersion ?? 1 })),
    weights: { ...WEIGHTS },
    normalization: { ...NORMALIZATION },
    node: process.version,
  };
}

/** Read `<dir>/manifest.json` if present and parseable. */
export function readManifest(dir: string): Partial<Manifest> | undefined {
  try {
    return JSON.parse(readFileSync(join(dir, "manifest.json"), "utf-8")) as Partial<Manifest>;
  } catch {
    return undefined;
  }
}

/** What a stored record must have been generated with to stand in for a new job. */
export interface Fingerprint {
  modelId: string;
  settings: RunSettings;
  prompt: string;
  systemPrompt: string;
}

export function fingerprintFor(
  query: BenchmarkQuery,
  model: ModelSpec,
  settings: { temperature: number; maxSteps: number },
  condition: ConditionId = "mcp",
): Fingerprint {
  return {
    modelId: model.modelId,
    settings: { temperature: settings.temperature, maxSteps: settings.maxSteps, timeoutMs: DEFAULTS.timeoutMs },
    prompt: query.prompt,
    systemPrompt: systemPromptFor(condition),
  };
}

/** Resume decision: reusable, or a short reason it is not (used for the rejection tally). */
export type ResumeDecision = { reuse: true } | { reuse: false; reason: string };

export function resumeDecision(record: RunRecord, want: Fingerprint): ResumeDecision {
  if (record.error) return { reuse: false, reason: "previous attempt errored" };
  if (!record.modelId || !record.settings) {
    return { reuse: false, reason: "legacy record (no modelId/settings to verify against)" };
  }
  if (record.modelId !== want.modelId) return { reuse: false, reason: "model id differs" };
  const a = record.settings;
  const b = want.settings;
  if (a.temperature !== b.temperature || a.maxSteps !== b.maxSteps || a.timeoutMs !== b.timeoutMs) {
    return { reuse: false, reason: "settings differ (temperature/max-steps/timeout)" };
  }
  if (record.prompt !== want.prompt) return { reuse: false, reason: "prompt differs" };
  if (record.systemPrompt !== want.systemPrompt) return { reuse: false, reason: "system prompt differs" };
  return { reuse: true };
}

/**
 * Whether an embedded `_scoring` is stale and the record must be re-scored
 * (live PubMed). Returns the reason, or undefined when it can be reused offline.
 * A missing scorerVersion means a v1 breakdown; a missing answerKeyVersion means v1.
 */
export function rescoreReason(breakdown: ScoreBreakdown | undefined, query: BenchmarkQuery): string | undefined {
  if (!breakdown) return "no embedded scoring";
  if (breakdown.status === "scoring-error") return "previous scoring-error";
  if ((breakdown.scorerVersion ?? 1) < SCORER_VERSION) return "older scorer version";
  if ((breakdown.answerKeyVersion ?? 1) !== (query.answerKeyVersion ?? 1)) return "answer key changed";
  return undefined;
}
