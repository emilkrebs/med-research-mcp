#!/usr/bin/env -S npx tsx
/**
 * CLI to human-grade rubric benchmark answers, bypassing the citation-quality proxy.
 * Writes scores to <results-dir>/overrides.json (or a shared file via --overrides).
 *
 * Grading is BLIND and RANDOMIZED by default: the grader sees an opaque item id,
 * the prompt, the rubric, the answer text and the cited PMIDs' validity / study
 * type / evidence grade (condition-neutral facts) — but not the condition, model,
 * run, or the provisional proxy score, and items come in a seeded shuffled order
 * rather than grouped by query and condition. Known limitation: the answer text
 * itself can still reveal the condition (e.g. "I searched PubMed…" or an
 * ungrounded closed-book style), so blinding is partial.
 *
 * Several graders may grade the same run (each with their own --grader id); the
 * scorer averages their grades and `--agreement` reports inter-rater reliability.
 *
 * Usage:
 *   npx tsx benchmark/grade.ts <results-dir> [options]
 *
 * Options:
 *   --grader <id>      Grader id written as `author` (default $USER, else "human")
 *   --seed <n>         Shuffle seed (default: derived from the grader id, so
 *                      different graders see different orders). Always printed.
 *   --overrides <path> Write to/read from this file instead of <dir>/overrides.json
 *   --unblind          Show condition, model, run and the proxy score (debugging)
 *   --agreement        Print inter-rater agreement and exit without prompting
 *
 * Controls:
 *   - 0-10: Grade the answer (followed by optional reason)
 *   - Enter / s: Skip
 *   - q: Save & Quit
 */

import { readFile, readdir, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { createInterface } from "node:readline";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import { stdin, stdout } from "node:process";
import { queryById } from "./lib/queries.js";
import { loadOverrides } from "./lib/overrides.js";
import { collectRatings, computeAgreement, formatAgreement, itemIdFor } from "./lib/agreement.js";
import type { BenchmarkQuery, OverridesFile, RunRecord, ScoreBreakdown, ScoreOverride } from "./lib/types.js";

/** A raw/*.json file: the RunRecord plus the `_scoring` breakdown run.ts embeds. */
export type RawFile = RunRecord & { _scoring?: ScoreBreakdown };

export interface RawItem {
  file: string;
  record: RawFile;
}

const RULE = "─".repeat(78);
const HEAVY_RULE = "═".repeat(78);

export interface CliOptions {
  dir: string;
  grader: string;
  seed: number;
  overridesPath?: string;
  unblind: boolean;
  agreement: boolean;
}

function usageAndExit(): never {
  console.error("Usage: npx tsx benchmark/grade.ts <results-dir> [--grader <id>] [--seed <n>] [--overrides <path>] [--unblind] [--agreement]");
  console.error("  e.g. npx tsx benchmark/grade.ts benchmark/results/2026-07-14-141739 --grader alice");
  process.exit(1);
}

/** Default grader id: `$USER`, else "human". */
export const defaultGrader = (): string => process.env.USER || "human";

/** Deterministic 32-bit seed from a string (first 4 bytes of its SHA-256). */
export function seedFromString(s: string): number {
  return createHash("sha256").update(s).digest().readUInt32BE(0);
}

/** Parse argv (without node/script). Returns null on bad usage. */
export function parseArgs(argv: string[]): CliOptions | null {
  let dir: string | undefined;
  let grader: string | undefined;
  let seed: number | undefined;
  let overridesPath: string | undefined;
  let unblind = false;
  let agreement = false;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === "--unblind") unblind = true;
    else if (a === "--agreement") agreement = true;
    else if (a === "--grader" || a === "--seed" || a === "--overrides") {
      const v = argv[++i];
      if (v === undefined) return null;
      if (a === "--grader") grader = v;
      else if (a === "--overrides") overridesPath = v;
      else {
        if (!/^-?\d+$/.test(v)) return null;
        seed = Number(v);
      }
    } else if (a.startsWith("--")) return null;
    else if (dir === undefined) dir = a;
    else return null;
  }
  if (!dir) return null;
  const g = grader ?? defaultGrader();
  return { dir, grader: g, seed: seed ?? seedFromString(g), overridesPath, unblind, agreement };
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
 * Why a response is not worth grading, or null if it is. Uses the scorer's
 * `_scoring.status` when present; legacy breakdowns without a status count as
 * ok unless the record has an `error` or empty text. Non-ok rows are excluded
 * from aggregation anyway, so a grade would never be used.
 */
export function skipReason(record: RawFile): string | null {
  const status = record._scoring?.status;
  if (status !== undefined) return status === "ok" ? null : status;
  if (record.error) return "provider-error";
  if (!record.text || record.text.trim() === "") return "truncated";
  return null;
}

/** Opaque id for an item (same hash `--agreement` prints). */
export const itemId = (record: RawFile): string => itemIdFor(record);

/**
 * True if `overrides` already has a numeric accuracy grade for this exact
 * response BY THIS GRADER. Wildcard ("*") entries, other graders' entries and
 * the seeded `_example` demo (outside the `overrides` array) never count.
 */
export function isAlreadyGraded(overrides: OverridesFile, record: RawFile, grader: string): boolean {
  return overrides.overrides.some(
    (o) =>
      o.queryId === record.queryId &&
      o.condition === record.condition &&
      o.model === record.model &&
      o.run === record.run &&
      o.author === grader &&
      typeof o.accuracy === "number",
  );
}

/**
 * Insert or replace the grader's entry for a response. The key is
 * (queryId, condition, model, run, author) — exact only, never a wildcard — so
 * each grader keeps their own entry and a re-grade replaces only their own.
 */
export function upsertOverride(overrides: OverridesFile, entry: ScoreOverride): void {
  const idx = overrides.overrides.findIndex(
    (o) =>
      o.queryId === entry.queryId &&
      o.condition === entry.condition &&
      o.model === entry.model &&
      o.run === entry.run &&
      o.author === entry.author,
  );
  if (idx >= 0) overrides.overrides[idx] = entry;
  else overrides.overrides.push(entry);
}

/** mulberry32: tiny seeded PRNG returning floats in [0, 1). */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Fisher-Yates shuffle with a seeded PRNG; returns a new array, deterministic per (input order, seed). */
export function seededShuffle<T>(items: readonly T[], seed: number): T[] {
  const out = [...items];
  const rand = mulberry32(seed);
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [out[i], out[j]] = [out[j]!, out[i]!];
  }
  return out;
}

export interface Selection {
  /** Items this grader still has to grade, in seeded random order. */
  toGrade: RawItem[];
  /** Rubric responses (ok status) already graded by this grader. */
  alreadyDone: number;
  /** Count of non-ok rubric responses skipped, by reason. */
  skipped: Record<string, number>;
  /** Total rubric responses considered (including skipped). */
  rubricTotal: number;
}

/**
 * Pick the items to grade: rubric queries only, non-ok runs dropped (counted by
 * reason), this grader's existing grades removed, and the rest shuffled with `seed`.
 * Files are sorted first so the shuffle depends only on the seed, not on readdir order.
 */
export function selectItems(
  all: RawItem[],
  overrides: OverridesFile,
  grader: string,
  seed: number,
  isRubric: (queryId: string) => boolean = (id) => queryById(id)?.answerKey.kind === "rubric",
): Selection {
  const rubric = all.filter(({ record }) => isRubric(record.queryId)).sort((a, b) => a.file.localeCompare(b.file));
  const skipped: Record<string, number> = {};
  const gradable: RawItem[] = [];
  for (const item of rubric) {
    const reason = skipReason(item.record);
    if (reason) skipped[reason] = (skipped[reason] ?? 0) + 1;
    else gradable.push(item);
  }
  const pending = gradable.filter(({ record }) => !isAlreadyGraded(overrides, record, grader));
  return {
    toGrade: seededShuffle(pending, seed),
    alreadyDone: gradable.length - pending.length,
    skipped,
    rubricTotal: rubric.length,
  };
}

/** Everything the grader is shown for one response. Blind views carry no condition/model/run/proxy. */
export interface GradeView {
  itemId: string;
  prompt: string;
  rubric: string;
  answer: string;
  pmids: { pmid: string; valid: boolean; studyType: string; evidenceScore?: number; title: string }[];
  /** Only present with --unblind. */
  unblinded?: { condition: string; model: string; run: number; proxy?: number };
}

/** Build the view for a response; `unblind` adds the identifying details and proxy score. */
export function buildView(record: RawFile, query: BenchmarkQuery, unblind: boolean): GradeView {
  const rubric = query.answerKey.kind === "rubric" ? query.answerKey.rubric : "(no rubric — should not happen)";
  let answer: string;
  if (record.error) answer = `[run errored: ${record.error}]`;
  else if (!record.text || record.text.trim() === "") answer = "(empty answer — typically grades 0)";
  else answer = record.text;

  const view: GradeView = {
    itemId: itemId(record),
    prompt: query.prompt,
    rubric,
    answer,
    pmids: (record._scoring?.evidenceQuality?.pmids ?? []).map((p) => ({
      pmid: p.pmid,
      valid: p.valid,
      studyType: p.studyType ?? "unknown",
      evidenceScore: p.evidenceScore,
      title: p.title ?? "(no title)",
    })),
  };
  if (unblind) {
    view.unblinded = {
      condition: record.condition,
      model: record.model,
      run: record.run,
      proxy: record._scoring?.accuracy?.score,
    };
  }
  return view;
}

/** Render a view as the text shown to the grader. */
export function renderView(view: GradeView, index: number, total: number): string {
  const out: string[] = [];
  out.push(`\n${HEAVY_RULE}`);
  const u = view.unblinded;
  out.push(
    `item ${view.itemId}   (${index + 1} of ${total})` + (u ? `   [UNBLINDED: ${u.condition} | ${u.model} | run ${u.run}]` : ""),
  );
  out.push(HEAVY_RULE);
  out.push("\nPROMPT:", view.prompt);
  out.push("\nRUBRIC (grade the answer against this):", view.rubric);
  out.push("\nMODEL ANSWER:", view.answer);
  out.push("\nCITED PMIDS (from this run's own citation audit — not re-fetched):");
  if (view.pmids.length === 0) out.push("  (no citations)");
  for (const p of view.pmids) {
    const score = p.evidenceScore !== undefined ? `${p.evidenceScore}/5` : "n/a";
    out.push(`  PMID ${p.pmid} — ${p.valid ? "VALID" : "FABRICATED"} | ${p.studyType} | evidence score ${score} | "${p.title}"`);
  }
  if (u) {
    out.push(
      `\nAuto-score (PROVISIONAL citation-quality proxy — NOT correctness): ${u.proxy !== undefined ? u.proxy.toFixed(2) : "n/a"} / 10`,
    );
  }
  out.push(RULE);
  return out.join("\n");
}

async function writeOverrides(path: string, overrides: OverridesFile): Promise<void> {
  await writeFile(path, `${JSON.stringify(overrides, null, 2)}\n`);
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
  const opts = parseArgs(process.argv.slice(2));
  if (!opts) usageAndExit();

  const resultsDir = resolve(process.cwd(), opts.dir);
  const rawDir = join(resultsDir, "raw");
  const overridesPath = opts.overridesPath ? resolve(process.cwd(), opts.overridesPath) : join(resultsDir, "overrides.json");

  const overrides: OverridesFile = (await loadOverrides(overridesPath)) ?? { overrides: [] };

  if (opts.agreement) {
    console.log(formatAgreement(computeAgreement(collectRatings(overrides))));
    return;
  }

  const allItems = await loadRawItems(rawDir);
  const sel = selectItems(allItems, overrides, opts.grader, opts.seed);
  const skippedTotal = Object.values(sel.skipped).reduce((a, b) => a + b, 0);

  console.log(`${sel.rubricTotal} rubric response(s) found in ${rawDir}`);
  console.log(`grader: ${opts.grader}   seed: ${opts.seed}   ${opts.unblind ? "UNBLINDED" : "blind"}`);
  if (skippedTotal > 0) {
    const why = Object.entries(sel.skipped).map(([r, n]) => `${n} ${r}`).join(", ");
    console.log(`  ${skippedTotal} skipped (not ok, excluded from aggregation anyway): ${why}`);
  }
  console.log(`  ${sel.alreadyDone} already graded by ${opts.grader}, ${sel.toGrade.length} left to grade.\n`);

  if (sel.toGrade.length === 0) {
    console.log(`Nothing to do — every gradable rubric response already has a grade from ${opts.grader}.`);
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
    for (let i = 0; i < sel.toGrade.length; i++) {
      const { record } = sel.toGrade[i]!;
      const query = queryById(record.queryId);
      if (!query) continue; // can't happen (filtered above), but keeps tsc happy

      console.log(renderView(buildView(record, query, opts.unblind), i, sel.toGrade.length));

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
        author: opts.grader,
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
  console.log(`graded ${graded}, skipped ${skipped}, ${sel.alreadyDone} already done${quit ? " (stopped early)" : ""}`);
  console.log(`\nNext: npx tsx benchmark/run.ts --rescore ${opts.dir}`);
}

// Only run when executed directly, so tests can import the pure helpers.
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((err) => {
    console.error("Fatal:", err instanceof Error ? (err.stack ?? err.message) : err);
    process.exitCode = 1;
  });
}
