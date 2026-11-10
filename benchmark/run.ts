#!/usr/bin/env -S npx tsx
/**
 * med-research-mcp benchmark runner.
 *
 * Runs each selected query under each condition (A closed-book / B web-search /
 * E plain PubMed tools / C mcp / D mcp + skill) for each model, `--runs` times,
 * scores every response, and writes a timestamped, auditable result tree under
 * `benchmark/results/`:
 * `manifest.json` (provenance), `raw/*.json` (record + embedded `_scoring`),
 * `overrides.json`, `scores.csv`, `summary.json/.md`, `charts/*.svg`.
 *
 * Pass 1 (run):
 *   npx tsx run.ts                                         # defaults: development set, every enabled model, mcp condition
 *   npx tsx run.ts --runs 1 --models <label> --conditions C
 *   npx tsx run.ts --publish                               # canonical: held-out set, all enabled models, 3 runs
 *   npx tsx run.ts --dry-run                               # plan only, no API calls
 *
 * Pass 2 (rescore): each run keeps its own `overrides.json` next to its `raw/`
 * files, so a reviewer records corrections in the run they're auditing.
 *   npx tsx run.ts --rescore results/2026-07-14-011335
 *   npx tsx run.ts --rescore results/2026-07-14-011335 --overrides path/to/shared-overrides.json
 *
 * Rubric queries need human grades (`npx tsx grade.ts <dir>`); until then they
 * have no accuracy and the report says so.
 *
 * See `--help`.
 */

import "./lib/loadenv.js"; // MUST be first — populates process.env before config/providers read it
import { copyFile, mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { DEFAULTS, missingKeyFor, type ModelSpec } from "./lib/config.js";
import { QUERIES, queryById } from "./lib/queries.js";
import { runOne } from "./lib/agent.js";
import { envSetting } from "./lib/core.js";
import { ProgressReporter } from "./lib/progress.js";
import { colorEnabled, palette, type Palette } from "./lib/color.js";
import { CliError, helpText, parseCli, type CliOptions } from "./lib/cli.js";
import {
  buildManifest,
  detectBenchmarkVersion,
  detectGit,
  fingerprintFor,
  readManifest,
  rescoreReason,
  resumeDecision,
  type RescoreInfo,
} from "./lib/manifest.js";
import { RUN_STATUSES, isFailure, isScored, runOutcome } from "./lib/status.js";
import { Verifier } from "./lib/scoring/verify.js";
import { SCORER_VERSION, rowFromBreakdown, scoreRun } from "./lib/scoring/score.js";
import { sharedNcbi } from "./lib/tools/literature.js";
import { toCsv } from "./lib/report/csv.js";
import { buildSummary, toMarkdown, type SummaryMeta } from "./lib/report/summary.js";
import { renderCharts } from "./lib/report/charts.js";
import { loadOverrides, applyOverrides, warnStaleOverrides, type RawRowWithBreakdown } from "./lib/overrides.js";
import type { BenchmarkQuery, ConditionId, RunRecord, RunStatus, ScoreBreakdown, ScoreRow } from "./lib/types.js";

/** One shared verifier per process: memoizes PubMed lookups and uses the same NCBI rate limiter as the agent runs. */
const newVerifier = (): Verifier => new Verifier({ ncbi: sharedNcbi });

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

const rawFilename = (j: Job): string =>
  `${j.query.id}-${j.condition}-${j.model.label}-run-${String(j.run).padStart(2, "0")}.json`;

const sortRows = (rows: ScoreRow[]): ScoreRow[] =>
  rows.sort(
    (a, b) =>
      a.query_id.localeCompare(b.query_id) ||
      a.condition.localeCompare(b.condition) ||
      a.model.localeCompare(b.model) ||
      a.run - b.run,
  );

/** Counts of rows per status, in a fixed order. */
export function statusTally(rows: ScoreRow[]): Record<RunStatus, number> {
  const t = Object.fromEntries(RUN_STATUSES.map((s) => [s, 0])) as Record<RunStatus, number>;
  for (const r of rows) t[r.status]++;
  return t;
}

/** "ok 3 | no-answer 1 | …" — ok in green, runs scored 0 in yellow, missing runs in red (non-zero counts only). */
const formatTally = (t: Record<RunStatus, number>, c: Palette = palette(false)): string =>
  RUN_STATUSES.map((k) => {
    const text = `${k} ${t[k]}`;
    if (k === "ok") return c.green(text);
    if (t[k] === 0) return text;
    return isFailure(k) ? c.yellow(text) : c.red(text);
  }).join(" | ");

/** Preflight: keys present for the work we're about to do. Returns fatal problems. */
function preflight(models: ModelSpec[], conditions: ConditionId[]): string[] {
  const problems: string[] = [];
  for (const m of models) {
    const missing = missingKeyFor(m);
    if (missing) problems.push(`Missing ${missing} (model ${m.label})`);
  }
  if (conditions.includes("web-search") && !process.env.BRAVE_API_KEY) problems.push("Missing BRAVE_API_KEY (condition B)");
  if (conditions.some((c) => c === "mcp" || c === "mcp-skill" || c === "pubmed") && !envSetting("NCBI_EMAIL")) console.warn("⚠️  NCBI_EMAIL not set — PubMed requests carry the project's contact address instead. Set your own: a run sends over 100 requests, and NCBI contacts that address before blocking your IP.");
  return problems;
}

/**
 * Self-documenting empty overrides file seeded into each results dir. A reviewer
 * reading that run's `raw/` files edits this to correct scores, then re-runs
 * `--rescore <dir>`. Kept empty (no active overrides) so a fresh run applies
 * nothing until a human fills it in. The `_help`/`_example` keys are ignored by
 * the parser (only `overrides` and `notes` are read), so they document the
 * schema inline without affecting scoring.
 */
const OVERRIDES_TEMPLATE = {
  _help:
    "Score corrections for THIS run (rubric queries are normally graded with `npx tsx grade.ts <dir>`, which writes here). " +
    "Move an entry from `_example` into `overrides`, edit it, then re-run: npx tsx run.ts --rescore <this-dir>. " +
    "Each entry needs a queryId and a reason; `author` identifies the grader. " +
    'condition/model/run accept "*" wildcards (raw/ filenames are queryId-condition-model-run). Set ' +
    "accuracy/evidence_quality/bullshit_score to a number to replace it, or null to drop it from aggregation. " +
    "On a fabricated-study or control row, correct bullshit_score (1 = handled correctly) and the accuracy follows. " +
    "Multi-grader rule: when several entries with DIFFERENT authors match the same row exactly (no wildcards), " +
    "their values are averaged per dimension; the same author's later entry replaces their earlier one.",
  _example: [
    {
      queryId: "synthesis-03",
      condition: "mcp",
      model: "<model-label from raw/ filename>",
      run: 1,
      accuracy: 8.0,
      author: "alice",
      reason: "Correct effect, different terminology than the answer key",
    },
    { queryId: "bullshit-02", condition: "mcp", model: "<model-label>", run: 2, bullshit_score: 0, author: "alice", reason: "Says it could not find the study, then reports its findings anyway" },
    { queryId: "drill-down-03", condition: "*", model: "*", run: "*", accuracy: null, author: "alice", reason: "Unscored — answer key needs verification" },
  ],
  overrides: [] as unknown[],
};

/** Write the overrides template into a results dir if it doesn't already have one. Returns the path. */
async function seedOverrides(dir: string): Promise<string> {
  const path = join(dir, "overrides.json");
  if (!existsSync(path)) await writeFile(path, `${JSON.stringify(OVERRIDES_TEMPLATE, null, 2)}\n`);
  return path;
}

/** Fingerprint-checked records from a previous run dir, plus why the rest were refused. */
interface ResumePool {
  contents: Map<string, Record<string, unknown>>;
}

/**
 * Apply overrides to scored entries and (re)write scores.csv, summary.{json,md}
 * and charts into `outDir`. Shared by the run and rescore passes. Returns the
 * post-override rows.
 */
async function writeReports(
  outDir: string,
  entries: RawRowWithBreakdown[],
  overridesPath: string,
  meta: Pick<SummaryMeta, "models" | "conditions" | "runs">,
): Promise<ScoreRow[]> {
  const overrides = await loadOverrides(overridesPath);
  if (overrides) console.log(`Loaded ${overrides.overrides.length} overrides from ${overridesPath}`);
  else console.log("No overrides file found — using raw scores only.");
  if (overrides) for (const w of warnStaleOverrides(overrides, QUERIES)) console.warn(`  ⚠  ${w}`);

  const queryByVersion = new Map<string, number>();
  for (const q of QUERIES) if (q.answerKeyVersion !== undefined) queryByVersion.set(q.id, q.answerKeyVersion);

  const { rows: applied, applied: appliedMap, excluded, warnings } = applyOverrides(entries, overrides, queryByVersion);
  for (const w of warnings) console.warn(`  ⚠  ${w}`);
  if (appliedMap.size > 0) console.log(`  Applied overrides to ${appliedMap.size} row(s)`);
  if (excluded.length > 0) console.log(`  Excluded ${excluded.length} score(s) from aggregation`);

  const rows = sortRows(applied);
  const ungraded = rows.filter((r) => r.status === "ok" && r.accuracy_source === "ungraded").length;

  // Provenance comes from the run's manifest: the answers were generated by that MCP version and
  // commit, whatever the working tree is now (a rescore months later must not relabel them).
  const manifest = readManifest(outDir);
  const full: SummaryMeta = {
    timestamp: outDir,
    mcp_version: manifest?.mcp_version ?? "unknown",
    mcp_commit: manifest?.git?.commit ?? "unknown",
    benchmark_version: manifest?.benchmark_version ?? detectBenchmarkVersion(),
    ...meta,
    total_responses: rows.length,
    unverified_queries: QUERIES.filter((q) => !q.verified && q.answerKey.kind !== "rubric" && rows.some((r) => r.query_id === q.id)).map((q) => q.id),
    overrides_applied: appliedMap.size,
    overrides_excluded: excluded.length,
    scorer_version: SCORER_VERSION,
    ...(manifest?.rescored ? { rescored: { at: manifest.rescored.at, harness_commit: manifest.rescored.harness_commit } } : {}),
  };
  const summary = buildSummary(rows, full);

  const chartsDir = join(outDir, "charts");
  await mkdir(chartsDir, { recursive: true });
  await writeFile(join(outDir, "scores.csv"), toCsv(rows));
  await writeFile(join(outDir, "summary.json"), JSON.stringify(summary, null, 2));
  await writeFile(join(outDir, "summary.md"), toMarkdown(summary));
  const charts = renderCharts(rows);
  for (const [name, svg] of Object.entries(charts)) await writeFile(join(chartsDir, name), svg);
  // Charts an older harness wrote here (the composite bars, the radar) would contradict the new report.
  for (const stale of (await readdir(chartsDir)).filter((f) => f.endsWith(".svg") && !(f in charts))) await rm(join(chartsDir, stale));

  console.log(`\n  Status: ${formatTally(statusTally(rows))}`);
  const missing = rows.filter((r) => !isScored(r.status)).length;
  if (missing > 0) {
    console.warn(`⚠️  ${missing} run(s) are missing (provider error, invalid context or scoring error). Nothing is comparable until they exist: --resume ${outDir}, or --rescore for scoring errors.`);
  }
  if (ungraded > 0) {
    console.warn(`⚠️  ${ungraded} rubric answer(s) have no accuracy until a human grades them: npx tsx grade.ts ${outDir}`);
  }
  console.log(toMarkdown(summary));
  return rows;
}

/** Pass 2: regenerate reports from raw + overrides, re-scoring only stale records. */
async function rescore(resultsDir: string, overridesPath: string): Promise<void> {
  const rawDir = join(resultsDir, "raw");
  const files = (await readdir(rawDir)).filter((f) => f.endsWith(".json")).sort();
  const verifier = newVerifier();

  const entries: RawRowWithBreakdown[] = [];
  let reused = 0;
  let rescored = 0;
  let failed = 0;
  const reasons = new Map<string, number>();

  for (const file of files) {
    const content = JSON.parse(await readFile(join(rawDir, file), "utf-8")) as Record<string, unknown>;
    const record = content as unknown as RunRecord;
    let breakdown = content._scoring as ScoreBreakdown | undefined;
    const query = queryById(record.queryId);

    if (!query) {
      if (!breakdown) {
        console.warn(`  ⚠  ${file}: unknown query "${record.queryId}" and no _scoring — skipping`);
        continue;
      }
      reused++;
    } else {
      const reason = rescoreReason(breakdown, query);
      if (reason === undefined) {
        reused++;
      } else {
        reasons.set(reason, (reasons.get(reason) ?? 0) + 1);
        const result = await scoreRun(record, query, verifier);
        breakdown = result.breakdown;
        rescored++;
        if (breakdown.status === "scoring-error") {
          failed++;
          console.warn(`  ⚠  ${file}: scoring failed — ${breakdown.scoringError ?? "unknown error"}`);
        }
        // Persist so the next rescore doesn't refetch from PubMed.
        await writeFile(join(rawDir, file), JSON.stringify({ ...content, _scoring: breakdown }, null, 2));
      }
    }
    entries.push({ filename: file, row: rowFromBreakdown(record, breakdown!), breakdown: breakdown!, record: content });
  }

  const why = [...reasons].map(([r, n]) => `${r}: ${n}`).join("; ");
  console.log(`Loaded ${entries.length} raw records from ${rawDir}`);
  console.log(`  Scoring: ${reused} reused, ${rescored} re-scored${why ? ` (${why})` : ""}, ${failed} failed`);

  // Say in the manifest that these answers were scored again, and with what; it keeps describing the run otherwise.
  const manifest = readManifest(resultsDir);
  if (manifest && rescored > 0) {
    const git = detectGit();
    const info: RescoreInfo = { at: new Date().toISOString(), scorer_version: SCORER_VERSION, harness_commit: git.commit, harness_dirty: git.dirty };
    await writeFile(join(resultsDir, "manifest.json"), `${JSON.stringify({ ...manifest, rescored: info }, null, 2)}\n`);
  }

  const rows = entries.map((e) => e.row);
  await writeReports(resultsDir, entries, overridesPath, {
    models: [...new Set(rows.map((r) => r.model))],
    conditions: [...new Set(rows.map((r) => r.condition))],
    runs: Math.max(1, ...rows.map((r) => r.run)),
  });
  console.log(`\n  Scores regenerated in ${resultsDir}`);
}

/** Load a resume dir's raw records keyed by filename. */
async function loadResumePool(resumeDir: string): Promise<ResumePool> {
  const contents = new Map<string, Record<string, unknown>>();
  const rawDir = join(resumeDir, "raw");
  try {
    for (const file of await readdir(rawDir)) {
      if (!file.endsWith(".json")) continue;
      contents.set(file, JSON.parse(await readFile(join(rawDir, file), "utf-8")) as Record<string, unknown>);
    }
    console.log(`Loaded ${contents.size} existing records from ${rawDir}`);
  } catch {
    console.warn(`⚠️  Could not read resume dir: ${resumeDir}`);
  }
  return { contents };
}

/** Why a run did not end `ok`, in words a person can act on. */
function failureReason(record: RunRecord, breakdown: ScoreBreakdown | undefined): string {
  if (breakdown?.scoringError) return `${breakdown.scoringError} — retry with --rescore`;
  switch (runOutcome(record)) {
    case "timeout":
      return `${record.error} — scored 0`;
    case "provider-error":
      return `${record.error} — missing, re-run with --resume`;
    case "invalid":
      return `provider truncated the context (input tokens per step: ${record.stepInputTokens?.join(" → ")}) — raise the model's context window and re-run with --resume`;
    default:
      if (record.finishReason === "tool-calls") return "still calling tools when the loop ended — scored 0";
      if (record.finishReason === "length") return "cut off by the output length limit — scored 0";
      return "no final answer — scored 0";
  }
}

async function runBenchmark(opts: CliOptions, argv: string[]): Promise<void> {
  const { publish, runs, models, conditions, queries, split, temperature, maxSteps, concurrency } = opts;
  const c = palette(colorEnabled());
  // Anchor the default to the package dir (not cwd) so `npx tsx run.ts` lands in
  // `benchmark/results` from anywhere. An explicit `--out` is resolved relative to cwd.
  const outRoot = opts.out ?? join(import.meta.dirname, "results");

  const jobs: Job[] = [];
  for (const query of queries)
    for (const condition of conditions) for (const model of models) for (let run = 1; run <= runs; run++) jobs.push({ query, condition, model, run });

  // A rubric query has no key to verify: it is graded by people. Only an unchecked key with ground truth is a hazard.
  const unverified = queries.filter((q) => !q.verified && q.answerKey.kind !== "rubric").map((q) => q.id);
  const rubric = queries.filter((q) => q.answerKey.kind === "rubric").length;
  const unpinned = models.filter((m) => m.unpinned).map((m) => m.label);
  const fixedSampling = models.filter((m) => m.fixedSampling).map((m) => m.label);
  const heldOut = queries.filter((q) => q.split === "test").length;

  console.log(
    `Plan: ${queries.length} queries × ${conditions.length} conditions × ${models.length} models × ${runs} runs = ${jobs.length} responses`,
  );
  console.log(`Queries: ${split === "all" ? "development + held-out sets" : split === "test" ? "held-out set" : "development set"} (${heldOut} held-out, ${queries.length - heldOut} development)`);
  console.log(`Conditions: ${conditions.join(", ")}  |  Models: ${models.map((m) => m.label).join(", ")}`);
  if (heldOut > 0 && !publish)
    console.warn(c.yellow("⚠️  This run includes held-out queries. Read their results, but change nothing in the server, the skill or the scorer because of them: tune on the development set."));
  if (unverified.length > 0)
    console.warn(c.yellow(`⚠️  ${unverified.length} selected keyed queries have UNVERIFIED answer keys: ${unverified.join(", ")}`));
  if (publish && unverified.length > 0)
    console.warn("⚠️  --publish with unverified keys: results are provisional. Run `npm run verify-keys` and review the keys before quoting numbers.");
  if (rubric > 0) console.log(c.dim(`${rubric} of the queries are open-ended (rubric): they get an accuracy only from human grades (grade.ts).`));
  if (unpinned.length > 0) {
    console.warn(c.yellow(`⚠️  UNPINNED model id(s) (moving aliases, results may drift): ${unpinned.join(", ")}`));
    if (publish) console.warn("⚠️⚠️  --publish with UNPINNED models: these results are NOT reproducible. Pin the model ids in models.data.ts first.");
  }
  if (fixedSampling.length > 0)
    console.warn(c.yellow(`⚠️  Model(s) that reject sampling params run at provider-default sampling, not temperature ${temperature}: ${fixedSampling.join(", ")}`));

  const problems = preflight(models, conditions);
  if (problems.length > 0) {
    console.error(c.red(`\nPreflight problems:\n  - ${problems.join("\n  - ")}`));
    if (!opts.dryRun) {
      console.error("\nFix the above or run with --dry-run to plan without API calls.");
      process.exitCode = 1;
      return;
    }
  }

  const pool = opts.resume ? await loadResumePool(opts.resume) : undefined;

  if (opts.dryRun) {
    console.log("\n--dry-run: no API calls made. Job matrix validated.");
    return;
  }

  const outDir = join(outRoot, timestamp());
  const rawDir = join(outDir, "raw");
  await mkdir(rawDir, { recursive: true });
  await mkdir(join(outDir, "charts"), { recursive: true });

  const git = detectGit();
  if (publish && git.dirty) console.warn("⚠️⚠️  --publish from a working tree with uncommitted changes: the commit in the manifest does not describe the code that ran. Commit first.");
  await writeFile(
    join(outDir, "manifest.json"),
    `${JSON.stringify(buildManifest({ args: argv, settings: { temperature, maxSteps }, models, conditions, queries, split, git }), null, 2)}\n`,
  );

  if (opts.resume) {
    const prev = readManifest(opts.resume)?.git?.commit;
    if (prev && prev !== git.commit) {
      console.warn(`⚠️  Resume dir was produced at commit ${prev}; current commit is ${git.commit}. Reused records may come from different code.`);
    }
    // Human grades must survive a resume.
    const prevOverrides = join(opts.resume, "overrides.json");
    if (existsSync(prevOverrides)) {
      await copyFile(prevOverrides, join(outDir, "overrides.json"));
      console.log(`Copied overrides.json from ${opts.resume}`);
    }
  }

  // Decide up front which jobs reuse a stored record, so the tally is printed before the long part.
  const reuse = new Map<string, Record<string, unknown>>();
  if (pool) {
    const rejected = new Map<string, number>();
    for (const job of jobs) {
      const file = rawFilename(job);
      const stored = pool.contents.get(file);
      if (!stored) continue;
      const d = resumeDecision(stored as unknown as RunRecord, fingerprintFor(job.query, job.model, { temperature, maxSteps }, job.condition));
      if (d.reuse) reuse.set(file, stored);
      else rejected.set(d.reason, (rejected.get(d.reason) ?? 0) + 1);
    }
    const why = [...rejected].map(([r, n]) => `${n} ${r}`).join("; ");
    console.log(`Resume: reusing ${reuse.size}, rejected ${[...rejected.values()].reduce((a, b) => a + b, 0)}${why ? ` (${why})` : ""}`);
  }

  const verifier = newVerifier();
  const entries: RawRowWithBreakdown[] = [];
  let tokensSpent = 0;
  const skippedForBudget: string[] = [];

  const limits = [
    `timeout ${Math.round(DEFAULTS.timeoutMs / 1000)}s/run`,
    `max ${maxSteps} steps`,
    ...(opts.runTokenCap !== undefined ? [`answer forced after ${opts.runTokenCap} tok/run`] : []),
    ...(opts.tokenBudget !== undefined ? [`stop at ${opts.tokenBudget} tok total`] : []),
  ];
  console.log(`\n${c.dim("Writing to")} ${c.bold(outDir)}`);
  console.log(`${c.dim("Limits:")} ${limits.join(c.dim(" · "))}${concurrency > 1 ? ` · ${concurrency} runs in parallel` : ""}\n`);

  const progress = new ProgressReporter({
    total: jobs.length,
    concurrency,
    quiet: opts.quiet,
    color: c.enabled,
    timeoutMs: DEFAULTS.timeoutMs,
    ...(opts.tokenBudget !== undefined ? { tokenBudget: opts.tokenBudget } : {}),
  });

  await mapPool(jobs, concurrency, async (job, i) => {
    const filename = rawFilename(job);
    const stored = reuse.get(filename);
    const jp = progress.job({ index: i + 1, queryId: job.query.id, condition: job.condition, model: job.model.label, run: job.run });
    let content: Record<string, unknown>;
    if (stored) {
      content = stored;
    } else {
      if (opts.tokenBudget !== undefined && tokensSpent >= opts.tokenBudget) {
        skippedForBudget.push(filename.replace(/\.json$/, ""));
        jp.skipped(`token budget (${opts.tokenBudget}) spent`);
        return;
      }
      jp.start();
      content = {
        ...(await runOne(job.query, job.condition, job.model, job.run, {
          temperature,
          maxSteps,
          ...(opts.runTokenCap !== undefined ? { tokenCap: opts.runTokenCap } : {}),
          onEvent: (e) => jp.event(e),
        })),
      };
      tokensSpent += (content as unknown as RunRecord).usage.totalTokens;
    }
    const record = content as unknown as RunRecord;

    let breakdown = content._scoring as ScoreBreakdown | undefined;
    if (rescoreReason(breakdown, job.query) !== undefined) {
      if (!record.error && String(record.text ?? "").trim() !== "") jp.scoring();
      breakdown = (await scoreRun(record, job.query, verifier)).breakdown;
    }
    const row = rowFromBreakdown(record, breakdown!);

    await writeFile(join(rawDir, filename), JSON.stringify({ ...content, _scoring: breakdown }, null, 2));
    entries.push({ filename, row, breakdown: breakdown!, record: content });

    jp.finished(row, record, {
      reused: Boolean(stored),
      ...(row.status === "ok" ? {} : { reason: failureReason(record, breakdown) }),
    });
  });
  if (skippedForBudget.length > 0) {
    console.warn(c.yellow(`\n⚠️  ${skippedForBudget.length} run(s) skipped because the token budget was spent (${tokensSpent} tokens used): ${skippedForBudget.join(", ")}`));
  }

  const overridesPath = await seedOverrides(outDir);
  const rows = await writeReports(outDir, entries, overridesPath, {
    models: models.map((m) => m.label),
    conditions,
    runs,
  });

  const tally = statusTally(rows);
  console.log(`\n${c.green("✅ Done.")} Results in ${c.bold(outDir)}`);
  console.log(`   Status: ${formatTally(tally, c)}`);
  console.log(`   To correct any scores: edit ${overridesPath}, then --rescore ${outDir}`);
  if (tally.ok === 0) {
    console.error(c.red("❌ No job ended ok."));
    process.exitCode = 1;
  }
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  let opts: CliOptions;
  try {
    opts = parseCli(argv);
  } catch (err) {
    if (err instanceof CliError) {
      console.error(`Error: ${err.message}`);
      process.exitCode = 2;
      return;
    }
    throw err;
  }

  if (opts.help) {
    console.log(helpText());
    return;
  }
  if (opts.rescore) {
    // Default: this run's own overrides.json (seeded next to raw/). An explicit
    // --overrides points at a shared/global file instead.
    return rescore(opts.rescore, opts.overrides ?? (await seedOverrides(opts.rescore)));
  }
  return runBenchmark(opts, argv);
}

// Only auto-run as a script, so tests can import the pure helpers.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err) => {
    console.error("Fatal:", err instanceof Error ? err.stack ?? err.message : err);
    process.exitCode = 1;
  });
}
