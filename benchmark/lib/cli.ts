/**
 * Command-line parsing and validation for `run.ts`, kept free of side effects
 * (no process.exit, no I/O) so it can be unit-tested. Every user mistake is
 * reported as a `CliError` carrying a message fit to print as-is.
 */

import { parseArgs } from "node:util";
import { CONDITIONS, DEFAULT_MODELS, DEFAULTS, MODELS, type ModelSpec } from "./config.js";
import { QUERIES, queriesOf, queryById } from "./queries.js";
import type { BenchmarkQuery, Category, ConditionId, Split } from "./types.js";

export const CATEGORIES: Category[] = ["factual", "drill-down", "synthesis", "edge-case", "compound", "recent", "bullshit", "lookup", "control"];

/** The set a run takes its queries from. */
export type SplitChoice = Split | "all";

/** A usage error: print `message` and exit non-zero, no stack trace. */
export class CliError extends Error {}

/** Fully-validated options for one invocation of the runner. */
export interface CliOptions {
  help: boolean;
  rescore?: string;
  overrides?: string;
  publish: boolean;
  dryRun: boolean;
  runs: number;
  models: ModelSpec[];
  conditions: ConditionId[];
  /** Query set: the development set by default, the held-out set for `--publish`. */
  split: SplitChoice;
  queries: BenchmarkQuery[];
  temperature: number;
  maxSteps: number;
  concurrency: number;
  /** Only print one result line per job (no step/tool events or heartbeats). */
  quiet: boolean;
  /** Stop starting new runs once this many tokens have been spent (undefined = no limit). */
  tokenBudget?: number;
  /** Soft per-run cap: past it, the model must answer without more tool calls. */
  runTokenCap?: number;
  out?: string;
  resume?: string;
}

const OPTION_SPEC = {
  runs: { type: "string" },
  models: { type: "string" },
  conditions: { type: "string" },
  "with-baselines": { type: "boolean" },
  split: { type: "string" },
  queries: { type: "string" },
  temperature: { type: "string" },
  "max-steps": { type: "string" },
  concurrency: { type: "string" },
  "token-budget": { type: "string" },
  quiet: { type: "boolean" },
  "run-token-cap": { type: "string" },
  out: { type: "string" },
  resume: { type: "string" },
  publish: { type: "boolean" },
  "dry-run": { type: "boolean" },
  rescore: { type: "string" },
  overrides: { type: "string" },
  help: { type: "boolean" },
} as const;

/** Parse `--flag <n>` as a positive integer (strict: "3abc", "1.5", "0" and "" are all rejected). */
export function parsePositiveInt(flag: string, raw: string | undefined, fallback: number): number {
  if (raw === undefined) return fallback;
  if (!/^\d+$/.test(raw.trim()) || Number(raw) < 1) {
    throw new CliError(`--${flag} must be a positive integer (got "${raw}").`);
  }
  return Number(raw);
}

/** Parse `--temperature` as a finite number in [0, 2]. */
export function parseTemperature(raw: string | undefined, fallback: number): number {
  if (raw === undefined) return fallback;
  const n = raw.trim() === "" ? Number.NaN : Number(raw);
  if (!Number.isFinite(n) || n < 0 || n > 2) {
    throw new CliError(`--temperature must be a number between 0 and 2 (got "${raw}").`);
  }
  return n;
}

export function resolveConditions(input?: string, withBaselines = false): ConditionId[] {
  if (!input) {
    return withBaselines ? ["closed-book", "web-search", "pubmed", "mcp"] : ["mcp"];
  }
  const byLetter = CONDITIONS as Record<string, ConditionId>;
  const all: ConditionId[] = ["closed-book", "web-search", "pubmed", "mcp", "mcp-skill"];
  const out: ConditionId[] = [];
  for (const raw of input.split(",")) {
    const t = raw.trim();
    const found = byLetter[t.toUpperCase()] ?? all.find((c) => c === t.toLowerCase());
    if (!found) throw new CliError(`Unknown condition "${t}". Use A|B|C|D|E or ${all.join("|")}.`);
    if (!out.includes(found)) out.push(found);
  }
  return out;
}

/** Default (no input) = every enabled model; an explicit label may also select a disabled one. */
export function resolveModels(input?: string): ModelSpec[] {
  if (!input) return DEFAULT_MODELS;
  const out: ModelSpec[] = [];
  for (const raw of input.split(",")) {
    const label = raw.trim();
    const spec = MODELS.find((m) => m.label === label);
    if (!spec) throw new CliError(`Unknown model "${label}". Known: ${MODELS.map((m) => m.label).join(", ")}.`);
    if (!out.includes(spec)) out.push(spec);
  }
  return out;
}

/** Parse `--split`. */
export function resolveSplit(input?: string, fallback: SplitChoice = "dev"): SplitChoice {
  if (input === undefined) return fallback;
  const t = input.trim().toLowerCase();
  if (t === "dev" || t === "test" || t === "all") return t;
  throw new CliError(`--split must be dev, test or all (got "${input}").`);
}

/**
 * The queries a run covers. Without `--queries`: every query of the split. A
 * category name selects that category within the split; a query id selects
 * that query whatever its split (naming it is explicit enough).
 */
export function resolveQueries(input?: string, split: SplitChoice = "dev"): BenchmarkQuery[] {
  const pool = queriesOf(split);
  if (!input) return pool;
  const out: BenchmarkQuery[] = [];
  const seen = new Set<string>();
  for (const raw of input.split(",")) {
    const t = raw.trim();
    if ((CATEGORIES as string[]).includes(t)) {
      for (const q of pool.filter((q) => q.category === t)) if (!seen.has(q.id)) (seen.add(q.id), out.push(q));
      continue;
    }
    const q = queryById(t);
    if (!q) throw new CliError(`Unknown query or category "${t}".`);
    if (!seen.has(q.id)) (seen.add(q.id), out.push(q));
  }
  return out;
}

/** Parse and validate `argv` (without the node/script prefix). Throws `CliError` on any problem. */
export function parseCli(argv: string[]): CliOptions {
  let values: ReturnType<typeof parseArgs<{ options: typeof OPTION_SPEC }>>["values"];
  try {
    values = parseArgs({ args: argv, options: OPTION_SPEC, allowPositionals: false }).values;
  } catch (err) {
    throw new CliError(`${err instanceof Error ? err.message : String(err)} (see --help)`);
  }

  const publish = Boolean(values.publish);
  if (publish) {
    const clash = (["models", "runs", "split", "queries"] as const).filter((f) => values[f] !== undefined).map((f) => `--${f}`);
    if (clash.length > 0) {
      throw new CliError(
        `--publish fixes the models (all enabled), --runs (${DEFAULTS.runs}) and the query set (the whole held-out set); ` +
          `it cannot be combined with ${clash.join(" or ")}. Drop --publish for a custom run.`,
      );
    }
  }
  const split = resolveSplit(values.split, publish ? "test" : "dev");

  const opts: CliOptions = {
    help: Boolean(values.help),
    publish,
    dryRun: Boolean(values["dry-run"]),
    runs: parsePositiveInt("runs", values.runs, DEFAULTS.runs),
    models: resolveModels(values.models),
    conditions: resolveConditions(values.conditions, Boolean(values["with-baselines"])),
    split,
    queries: resolveQueries(values.queries, split),
    temperature: parseTemperature(values.temperature, DEFAULTS.temperature),
    maxSteps: parsePositiveInt("max-steps", values["max-steps"], DEFAULTS.maxSteps),
    concurrency: parsePositiveInt("concurrency", values.concurrency, 1),
    quiet: Boolean(values.quiet),
    ...(values["token-budget"] !== undefined ? { tokenBudget: parsePositiveInt("token-budget", values["token-budget"], 0) } : {}),
    ...(values["run-token-cap"] !== undefined ? { runTokenCap: parsePositiveInt("run-token-cap", values["run-token-cap"], 0) } : {}),
    ...(values.out !== undefined ? { out: values.out } : {}),
    ...(values.resume !== undefined ? { resume: values.resume } : {}),
    ...(values.rescore !== undefined ? { rescore: values.rescore } : {}),
    ...(values.overrides !== undefined ? { overrides: values.overrides } : {}),
  };
  return opts;
}

export function helpText(): string {
  return `med-research-mcp benchmark

Usage: npx tsx run.ts [options]

Pass 1 - Run + score:
  --runs <n>          runs per query per model, positive integer (default ${DEFAULTS.runs})
  --models <list>     comma-separated model labels (default: every enabled model;
                      a disabled model can still be named explicitly)
  --conditions <list> comma-separated A|B|C|D|E or closed-book|web-search|mcp|mcp-skill|pubmed (default: mcp)
  --with-baselines    add the baselines: closed-book (A), web-search (B) and plain PubMed tools (E)
  --split <set>       dev (default): the ${queriesOf("dev").length} development queries, for building and tuning.
                      test: the ${queriesOf("test").length} held-out queries; never tune anything against them.
                      all: both (${QUERIES.length}).
  --queries <list>    comma-separated query ids and/or categories (default: every query of the split;
                      a category selects within the split, an id selects that query whatever its split)
  --temperature <t>   sampling temperature, 0-2 (default ${DEFAULTS.temperature})
  --max-steps <n>     agent tool-call rounds, positive integer (default ${DEFAULTS.maxSteps})
  --concurrency <n>   parallel runs, positive integer (default 1; NCBI rate limits favor 1)
  --token-budget <n>  stop starting new runs once n tokens have been spent in this
                      invocation (reused records are free). Runs left over are skipped
                      and listed; a run already in flight may overshoot by its own cost.
  --run-token-cap <n> soft per-run cap: once a run has used n tokens its next step is
                      text-only, so it must answer instead of searching further
  --quiet             one line per finished run; no live step/tool progress or heartbeats
  --out <dir>         output root (default benchmark/results)
  --resume <dir>      reuse raw records from an existing results dir and only run the rest.
                      A record is reused only if its model id, settings (temperature,
                      max steps, timeout), prompt and system prompt all match this run;
                      legacy records without those fields are re-run, and so are runs
                      that hit a provider error or a truncated context. A run that timed
                      out or gave no answer is a result (scored 0) and is kept. The dir's
                      overrides.json (human grades) is copied into the new dir.
  --publish           canonical publication run: ALL enabled models, ${DEFAULTS.runs} runs per query, the whole
                      held-out set. Cannot be combined with --models, --runs, --split or --queries.
                      Conditions stay selectable (default: mcp). Warns loudly about unpinned
                      models, unverified answer keys and a dirty working tree.
  --dry-run           print the plan and preflight, make no API calls

Pass 2 - Rescore from raw + overrides:
  --rescore <dir>     read raw JSON from dir/raw and regenerate reports in place. Records are
                      re-scored against live PubMed only when they have no embedded scoring,
                      an older scorer version, a different answer-key version, or a
                      scoring-error; otherwise the embedded scoring is reused offline.
  --overrides <path>  overrides file to apply (default: <dir>/overrides.json, seeded next to raw/)

  --help

Known models: ${MODELS.map((m) => m.label + (m.enabled === false ? " (disabled)" : "")).join(", ")}
Known categories: ${CATEGORIES.join(", ")}
Human grading of rubric queries: npx tsx grade.ts <results-dir>
`;
}
