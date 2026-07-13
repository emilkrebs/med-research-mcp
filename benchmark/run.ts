#!/usr/bin/env -S npx tsx
/**
 * med-research-mcp benchmark runner.
 *
 * Runs each selected query under each condition (A closed-book / B web-search /
 * C mcp) for each model, `--runs` times, scores every response, and writes a
 * timestamped, auditable result tree under `benchmark/results/`.
 *
 *   npx tsx benchmark/run.ts                              # defaults (spec)
 *   npx tsx benchmark/run.ts --runs 1 --models deepseek-v4-pro --conditions C
 *   npx tsx benchmark/run.ts --publish                   # full run + report
 *   npx tsx benchmark/run.ts --dry-run                   # plan only, no API calls
 *
 * See `--help`.
 */

import "./lib/loadenv.js"; // MUST be first — populates process.env before config/providers read it
import { parseArgs } from "node:util";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { CONDITIONS, DEFAULTS, JUDGE, MODELS, NORMALIZATION, WEIGHTS, type ModelSpec } from "./lib/config.js";
import { QUERIES, queryById } from "./lib/queries.js";
import type { BenchmarkQuery, Category, ConditionId, RunRecord, ScoreRow } from "./lib/types.js";
import { runOne } from "./lib/agent.js";
import { Verifier } from "./lib/scoring/verify.js";
import { scoreRun } from "./lib/scoring/score.js";
import { toCsv } from "./lib/report/csv.js";
import { buildSummary, toMarkdown, type SummaryMeta } from "./lib/report/summary.js";
import { renderCharts } from "./lib/report/charts.js";

const CATEGORIES: Category[] = ["factual", "drill-down", "synthesis", "edge-case", "compound", "bullshit"];

function help(): void {
  console.log(`med-research-mcp benchmark

Usage: npx tsx benchmark/run.ts [options]

  --runs <n>          runs per query per condition per model (default ${DEFAULTS.runs})
  --models <list>     comma-separated model labels (default: all in config)
  --conditions <list> comma-separated A|B|C or closed-book|web-search|mcp (default: all)
  --queries <list>    comma-separated query ids and/or categories (default: all 24)
  --temperature <t>   sampling temperature (default ${DEFAULTS.temperature})
  --max-steps <n>     agent tool-call rounds (default ${DEFAULTS.maxSteps})
  --concurrency <n>   parallel runs (default 1; NCBI rate limits favor 1)
  --out <dir>         output root (default benchmark/results)
  --publish           full run (3 runs, all models/conditions) + report
  --dry-run           print the plan and preflight, make no API calls
  --help

Known models: ${MODELS.map((m) => m.label).join(", ")}
Known categories: ${CATEGORIES.join(", ")}
`);
}

function resolveConditions(input?: string): ConditionId[] {
  if (!input) return ["closed-book", "web-search", "mcp"];
  const byLetter = CONDITIONS as Record<string, ConditionId>;
  const all: ConditionId[] = ["closed-book", "web-search", "mcp"];
  return input.split(",").map((raw) => {
    const t = raw.trim();
    const upper = t.toUpperCase();
    if (byLetter[upper]) return byLetter[upper]!;
    const found = all.find((c) => c === t.toLowerCase());
    if (!found) throw new Error(`Unknown condition "${t}". Use A|B|C or ${all.join("|")}.`);
    return found;
  });
}

function resolveModels(input?: string): ModelSpec[] {
  if (!input) return MODELS;
  return input.split(",").map((raw) => {
    const label = raw.trim();
    const spec = MODELS.find((m) => m.label === label);
    if (!spec) throw new Error(`Unknown model "${label}". Known: ${MODELS.map((m) => m.label).join(", ")}.`);
    return spec;
  });
}

function resolveQueries(input?: string): BenchmarkQuery[] {
  if (!input) return QUERIES;
  const out: BenchmarkQuery[] = [];
  const seen = new Set<string>();
  for (const raw of input.split(",")) {
    const t = raw.trim();
    if ((CATEGORIES as string[]).includes(t)) {
      for (const q of QUERIES.filter((q) => q.category === t)) if (!seen.has(q.id)) (seen.add(q.id), out.push(q));
      continue;
    }
    const q = queryById(t);
    if (!q) throw new Error(`Unknown query or category "${t}".`);
    if (!seen.has(q.id)) (seen.add(q.id), out.push(q));
  }
  return out;
}

function timestamp(): string {
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

/** Run `fn` over `items` with at most `limit` in flight, preserving input order. */
async function mapPool<T, R>(items: T[], limit: number, fn: (item: T, index: number) => Promise<R>): Promise<R[]> {
  const out = new Array<R>(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (true) {
      const i = next++;
      if (i >= items.length) break;
      out[i] = await fn(items[i]!, i);
    }
  });
  await Promise.all(workers);
  return out;
}

interface Job {
  query: BenchmarkQuery;
  condition: ConditionId;
  model: ModelSpec;
  run: number;
}

/** A degraded, all-zeros row used when scoring a response throws. */
function zeroRow(record: RunRecord): ScoreRow {
  return {
    query_id: record.queryId,
    category: record.category,
    condition: record.condition,
    model: record.model,
    run: record.run,
    accuracy: 0,
    evidence_quality: 0,
    bullshit_score: 0,
    speed_s: Math.round(record.speedS * 100) / 100,
    input_tokens: record.usage.inputTokens,
    output_tokens: record.usage.outputTokens,
    tool_calls: record.toolCallCount,
    tools_used: record.toolsUsed.join(","),
    pmids_cited: 0,
    pmids_valid: 0,
    pmids_fabricated: 0,
    composite: 0,
  };
}

/** Preflight: keys present for the work we're about to do. Returns fatal problems. */
function preflight(models: ModelSpec[], conditions: ConditionId[], queries: BenchmarkQuery[]): string[] {
  const problems: string[] = [];
  const need = new Set<string>();
  for (const m of models) need.add(m.apiKeyEnv);
  const needsJudge = queries.some((q) => q.answerKey.kind === "rubric");
  if (needsJudge) need.add(JUDGE.apiKeyEnv); // rubric scoring uses the judge model
  for (const env of need) if (!process.env[env]) problems.push(`Missing ${env}`);
  if (conditions.includes("web-search") && !process.env.BRAVE_API_KEY) problems.push("Missing BRAVE_API_KEY (condition B)");
  if (!process.env.NCBI_EMAIL) console.warn("⚠️  NCBI_EMAIL not set — NCBI may throttle. Set it to a contact email.");
  return problems;
}

async function main(): Promise<void> {
  const { values } = parseArgs({
    options: {
      runs: { type: "string" },
      models: { type: "string" },
      conditions: { type: "string" },
      queries: { type: "string" },
      temperature: { type: "string" },
      "max-steps": { type: "string" },
      concurrency: { type: "string" },
      out: { type: "string" },
      publish: { type: "boolean" },
      "dry-run": { type: "boolean" },
      help: { type: "boolean" },
    },
    allowPositionals: false,
  });

  if (values.help) return help();

  const publish = Boolean(values.publish);
  const runs = publish ? DEFAULTS.runs : Number(values.runs ?? DEFAULTS.runs);
  const models = publish ? MODELS : resolveModels(values.models);
  const conditions = publish ? (["closed-book", "web-search", "mcp"] as ConditionId[]) : resolveConditions(values.conditions);
  const queries = resolveQueries(values.queries);
  const temperature = Number(values.temperature ?? DEFAULTS.temperature);
  const maxSteps = Number(values["max-steps"] ?? DEFAULTS.maxSteps);
  const concurrency = Math.max(1, Number(values.concurrency ?? 1));
  const outRoot = values.out ?? join("benchmark", "results");

  // Build the job matrix.
  const jobs: Job[] = [];
  for (const query of queries)
    for (const condition of conditions) for (const model of models) for (let run = 1; run <= runs; run++) jobs.push({ query, condition, model, run });

  const unverified = queries.filter((q) => !q.verified).map((q) => q.id);

  console.log(
    `Plan: ${queries.length} queries × ${conditions.length} conditions × ${models.length} models × ${runs} runs = ${jobs.length} responses`,
  );
  console.log(`Conditions: ${conditions.join(", ")}  |  Models: ${models.map((m) => m.label).join(", ")}`);
  if (unverified.length > 0)
    console.warn(`⚠️  ${unverified.length} selected queries have UNVERIFIED answer keys: ${unverified.join(", ")}`);
  if (publish && unverified.length > 0)
    console.warn("⚠️  --publish with unverified keys: results are provisional. Review the keys before quoting numbers.");

  const problems = preflight(models, conditions, queries);
  if (problems.length > 0) {
    console.error(`\nPreflight problems:\n  - ${problems.join("\n  - ")}`);
    if (!values["dry-run"]) {
      console.error("\nFix the above or run with --dry-run to plan without API calls.");
      process.exitCode = 1;
      return;
    }
  }

  if (values["dry-run"]) {
    console.log("\n--dry-run: no API calls made. Job matrix validated.");
    return;
  }

  const outDir = join(outRoot, timestamp());
  const rawDir = join(outDir, "raw");
  const chartsDir = join(outDir, "charts");
  await mkdir(rawDir, { recursive: true });
  await mkdir(chartsDir, { recursive: true });

  // A shared verifier caches PubMed lookups across all runs' scoring.
  const verifier = new Verifier();
  const rows: ScoreRow[] = [];
  let done = 0;

  await mapPool(jobs, concurrency, async (job) => {
    const record: RunRecord = await runOne(job.query, job.condition, job.model, job.run, { temperature, maxSteps });
    const filename = `${job.query.id}-${job.condition}-${job.model.label}-run-${String(job.run).padStart(2, "0")}.json`;
    await writeFile(join(rawDir, filename), JSON.stringify(record, null, 2));

    // Scoring hits the network (PubMed verification, LLM judge). A transient
    // failure must not sink a run that already cost real API calls — degrade to
    // a zero row so the batch completes and every raw response is preserved.
    let row: ScoreRow;
    let scoreErr = "";
    try {
      row = await scoreRun(record, job.query, verifier);
    } catch (err) {
      scoreErr = err instanceof Error ? err.message : String(err);
      row = zeroRow(record);
    }
    rows.push(row);
    done++;
    const status = record.error
      ? `ERROR: ${record.error}`
      : scoreErr
        ? `SCORING FAILED: ${scoreErr}`
        : `composite ${row.composite.toFixed(2)}`;
    console.log(`[${done}/${jobs.length}] ${job.query.id} ${job.condition} ${job.model.label} r${job.run} — ${status}`);
  });

  // Deterministic row order for the CSV regardless of completion order.
  rows.sort(
    (a, b) => a.query_id.localeCompare(b.query_id) || a.condition.localeCompare(b.condition) || a.model.localeCompare(b.model) || a.run - b.run,
  );

  const meta: SummaryMeta = {
    timestamp: outDir,
    models: models.map((m) => m.label),
    conditions,
    runs,
    total_responses: rows.length,
    weights: { ...WEIGHTS },
    normalization: { ...NORMALIZATION },
    unverified_queries: unverified,
  };
  const summary = buildSummary(rows, meta);

  await writeFile(join(outDir, "scores.csv"), toCsv(rows));
  await writeFile(join(outDir, "summary.json"), JSON.stringify(summary, null, 2));
  await writeFile(join(outDir, "summary.md"), toMarkdown(summary));
  for (const [name, svg] of Object.entries(renderCharts(rows))) await writeFile(join(chartsDir, name), svg);

  console.log(`\n✅ Done. Results in ${outDir}`);
  console.log(toMarkdown(summary));
}

main().catch((err) => {
  console.error("Fatal:", err instanceof Error ? err.stack ?? err.message : err);
  process.exitCode = 1;
});
