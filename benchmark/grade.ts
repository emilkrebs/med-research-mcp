#!/usr/bin/env -S npx tsx
/**
 * CLI to human-grade rubric benchmark answers, bypassing the citation-quality proxy.
 * Overwrites/appends scores directly to <results-dir>/overrides.json.
 *
 * Usage:
 *   npx tsx benchmark/grade.ts <results-dir>
 *
 * Controls:
 *   - 0-10: Grade the answer (followed by optional reason)
 *   - Enter / s: Skip
 *   - q: Save & Quit
 */

import { readFile, readdir, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { createInterface } from "node:readline";
import { stdin, stdout } from "node:process";
import { queryById } from "./lib/queries.js";
import { loadOverrides } from "./lib/overrides.js";
import type { BenchmarkQuery, OverridesFile, RunRecord, ScoreBreakdown, ScoreOverride } from "./lib/types.js";

/** A raw/*.json file: the RunRecord plus the `_scoring` breakdown run.ts embeds. */
type RawFile = RunRecord & { _scoring?: ScoreBreakdown };

interface RawItem {
  file: string;
  record: RawFile;
}

const RULE = "─".repeat(78);
const HEAVY_RULE = "═".repeat(78);

function usageAndExit(): never {
  console.error("Usage: npx tsx benchmark/grade.ts <results-dir>");
  console.error("  e.g. npx tsx benchmark/grade.ts benchmark/results/2026-07-14-141739");
  process.exit(1);
}

/** Load every raw/*.json in a results dir, tolerating and warning on unparseable files. */
async function loadRawItems(rawDir: string): Promise<RawItem[]> {
  let files: string[];
  try {
    files = (await readdir(rawDir)).filter((f) => f.endsWith(".json")).sort();
  } catch (err) {
    console.error(`Cannot read ${rawDir}: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  }

  const items: RawItem[] = [];
  for (const file of files) {
    try {
      const record = JSON.parse(await readFile(join(rawDir, file), "utf-8")) as RawFile;
      items.push({ file, record });
    } catch (err) {
      console.warn(`  ⚠ skipping ${file}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  return items;
}

/**
 * True if `overrides` already has a human accuracy grade for this exact
 * response. Only an exact {queryId, condition, model, run} match with a
 * numeric `accuracy` counts — wildcard ("*") entries and the seeded
 * `_example` demo (which lives outside the `overrides` array entirely, so
 * the parser never sees it) are never mistaken for a real grade.
 */
function isAlreadyGraded(overrides: OverridesFile, record: RawFile): boolean {
  return overrides.overrides.some(
    (o) =>
      o.queryId === record.queryId &&
      o.condition === record.condition &&
      o.model === record.model &&
      o.run === record.run &&
      typeof o.accuracy === "number",
  );
}

/** Insert or replace (exact match only, never a wildcard) the human's override entry. */
function upsertOverride(overrides: OverridesFile, entry: ScoreOverride): void {
  const idx = overrides.overrides.findIndex(
    (o) => o.queryId === entry.queryId && o.condition === entry.condition && o.model === entry.model && o.run === entry.run,
  );
  if (idx >= 0) overrides.overrides[idx] = entry;
  else overrides.overrides.push(entry);
}

async function writeOverrides(path: string, overrides: OverridesFile): Promise<void> {
  await writeFile(path, `${JSON.stringify(overrides, null, 2)}\n`);
}

function printItem(index: number, total: number, record: RawFile, query: BenchmarkQuery): void {
  const rubric = query.answerKey.kind === "rubric" ? query.answerKey.rubric : "(no rubric — should not happen)";

  console.log(`\n${HEAVY_RULE}`);
  console.log(`${record.queryId} | ${record.condition} | ${record.model} | run ${record.run}   (${index + 1} of ${total})`);
  console.log(HEAVY_RULE);

  console.log("\nPROMPT:");
  console.log(query.prompt);

  console.log("\nRUBRIC (grade the answer against this):");
  console.log(rubric);

  console.log("\nMODEL ANSWER:");
  if (record.error) {
    console.log(`  [run errored: ${record.error}]`);
    console.log("  (no answer was produced — an errored response typically grades 0)");
  } else if (!record.text || record.text.trim() === "") {
    console.log("  (empty answer — typically grades 0)");
  } else {
    console.log(record.text);
  }

  console.log("\nCITED PMIDS (from this run's own citation audit — not re-fetched):");
  const pmids = record._scoring?.evidenceQuality?.pmids ?? [];
  if (pmids.length === 0) {
    console.log("  (no citations)");
  } else {
    for (const p of pmids) {
      const status = p.valid ? "VALID" : "FABRICATED";
      const type = p.studyType ?? "unknown";
      const score = p.evidenceScore !== undefined ? `${p.evidenceScore}/5` : "n/a";
      const title = p.title ?? "(no title)";
      console.log(`  PMID ${p.pmid} — ${status} | ${type} | evidence score ${score} | "${title}"`);
    }
  }

  const proxy = record._scoring?.accuracy?.score;
  console.log(
    `\nCurrent auto-score (PROVISIONAL citation-quality proxy — NOT correctness): ${proxy !== undefined ? proxy.toFixed(2) : "n/a"} / 10`,
  );
  console.log(RULE);
}

type PromptResult = { action: "score"; value: number } | { action: "skip" } | { action: "quit" };

/**
 * Reads one line of input, having already written `prompt` to stdout.
 * Returns `null` at EOF (stdin closed, e.g. piped input ran out).
 *
 * This is deliberately NOT `readline/promises`' `rl.question()`: that method
 * attaches a fresh one-time `'line'` listener per call, so when input arrives
 * in one burst (as it does through a pipe — `printf '8\nq\n' | tsx grade.ts`
 * — rather than an interactive TTY sending one line at a time), every line
 * beyond the first can be emitted and dropped before the *next* `question()`
 * call has a listener attached to receive it, leaving later prompts hanging
 * forever. Driving the interface's async iterator instead (which internally
 * queues `'line'` events) reads every line correctly regardless of timing.
 */
type AskFn = (prompt: string) => Promise<string | null>;

async function promptAccuracy(ask: AskFn): Promise<PromptResult> {
  for (; ;) {
    const line = await ask("accuracy 0–10 (Enter=skip, q=save & quit): ");
    if (line === null) return { action: "quit" }; // stdin closed with no answer — stop gracefully
    const raw = line.trim();
    if (raw === "" || raw.toLowerCase() === "s") return { action: "skip" };
    if (raw.toLowerCase() === "q") return { action: "quit" };
    if (!/^\d{1,2}(\.\d)?$/.test(raw)) {
      console.log("  Please enter a number 0–10 (integer or one decimal), Enter to skip, or q to quit.");
      continue;
    }
    const value = Number(raw);
    if (value < 0 || value > 10) {
      console.log("  Out of range — enter a number between 0 and 10.");
      continue;
    }
    return { action: "score", value };
  }
}

async function main(): Promise<void> {
  const arg = process.argv[2];
  if (!arg) usageAndExit();

  const resultsDir = resolve(process.cwd(), arg);
  const rawDir = join(resultsDir, "raw");
  const overridesPath = join(resultsDir, "overrides.json");

  const allItems = await loadRawItems(rawDir);
  const rubricItems = allItems.filter(({ record }) => queryById(record.queryId)?.answerKey.kind === "rubric");

  let overrides: OverridesFile = (await loadOverrides(overridesPath)) ?? { overrides: [] };

  const toGrade = rubricItems.filter(({ record }) => !isAlreadyGraded(overrides, record));
  const alreadyDoneCount = rubricItems.length - toGrade.length;

  console.log(`${rubricItems.length} rubric response(s) found in ${rawDir}`);
  console.log(`  ${alreadyDoneCount} already graded, ${toGrade.length} left to grade.\n`);

  if (toGrade.length === 0) {
    console.log("Nothing to do — every rubric response already has a human accuracy grade.");
    return;
  }

  const rl = createInterface({ input: stdin, output: stdout });
  const lineIterator = rl[Symbol.asyncIterator]();
  const ask: AskFn = async (prompt) => {
    stdout.write(prompt);
    const { value, done } = await lineIterator.next();
    return done ? null : value;
  };

  let graded = 0;
  let skipped = 0;
  let quit = false;

  try {
    for (let i = 0; i < toGrade.length; i++) {
      const { record } = toGrade[i]!;
      const query = queryById(record.queryId);
      if (!query) continue; // can't happen (filtered above), but keeps tsc happy

      printItem(i, toGrade.length, record, query);

      const result = await promptAccuracy(ask);
      if (result.action === "quit") {
        quit = true;
        break;
      }
      if (result.action === "skip") {
        skipped++;
        continue;
      }

      const reasonAnswer = await ask("reason (Enter for default): ");
      const reason = reasonAnswer?.trim() || "human rubric grade";

      const entry: ScoreOverride = {
        queryId: record.queryId,
        condition: record.condition,
        model: record.model,
        run: record.run,
        accuracy: result.value,
        reason,
        author: process.env.USER || "human",
        at: new Date().toISOString(),
      };
      upsertOverride(overrides, entry);
      await writeOverrides(overridesPath, overrides);
      graded++;
      console.log(`  ✓ saved accuracy=${result.value} → ${overridesPath}`);
    }
  } finally {
    rl.close();
  }

  console.log(`\n${RULE}`);
  console.log(`graded ${graded}, skipped ${skipped}, ${alreadyDoneCount} already done${quit ? " (stopped early)" : ""}`);
  console.log(`\nNext: npx tsx benchmark/run.ts --rescore ${arg}`);
}

main().catch((err) => {
  console.error("Fatal:", err instanceof Error ? (err.stack ?? err.message) : err);
  process.exitCode = 1;
});
