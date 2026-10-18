#!/usr/bin/env -S npx tsx
/**
 * LLM judge for rubric answers — a second opinion next to (never instead of)
 * human grading with grade.ts.
 *
 *   npx tsx benchmark/judge.ts <results-dir> [--judge <model-label>] [--conditions mcp,mcp-skill] [--limit <n>]
 *
 * The judge sees what a human grader sees in grade.ts — the prompt, the rubric,
 * the answer and the cited records' validity, study type and title, blind to
 * condition, model and run — plus the abstracts of the cited PubMed records,
 * because several rubrics ask whether a cited abstract supports the claim.
 *
 * Grades go to <dir>/judge-<label>.json (resumable: graded items are skipped)
 * and a report to <dir>/judge-<label>.md. They are NOT written to
 * overrides.json: the scorer treats overrides as human grades.
 *
 * An LLM judge can be wrong about medicine and may not know recent papers;
 * read its scores as indicative and spot-check a sample by hand.
 */

import { readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { generateText } from "ai";
import "./lib/loadenv.js";
import { MODELS, missingKeyFor } from "./lib/config.js";
import { resolveModel } from "./lib/providers.js";
import { queryById } from "./lib/queries.js";
import { comparePaired } from "./lib/stats.js";
import { compositeForCategory } from "./lib/scoring/composite.js";
import { fetchLiterature, LRUBackend, NcbiClient, PubMedAdapter } from "./lib/core.js";
import { buildView, loadRawItems, skipReason, type GradeView, type RawFile } from "./grade.js";
import type { BenchmarkQuery } from "./lib/types.js";

export interface JudgeGrade {
  itemId: string;
  queryId: string;
  condition: string;
  model: string;
  run: number;
  score: number;
  reason: string;
  judge: string;
  /** The exact model id the judge ran on (a pinned snapshot). */
  judgeModelId: string;
  inputTokens: number;
  outputTokens: number;
  judgedAt: string;
}

const ABSTRACT_CHARS = 1800;
const MAX_ABSTRACTS = 8;

export const JUDGE_SYSTEM =
  "You grade answers to biomedical research questions for a benchmark. Grade strictly against the rubric, " +
  "on a 0–10 scale (decimals allowed). Use the cited records and their abstracts to check whether the answer's " +
  "claims are supported; a claim the abstracts don't support counts against the answer unless it is common, " +
  "correct background knowledge. Fabricated citations (marked FABRICATED) are a serious error. Do not reward " +
  "length or confident tone. Reply with JSON only: {\"score\": <number 0-10>, \"reason\": \"<one or two sentences>\"}.";

/** The user message for one answer. Pure, so the exact judge input is testable. */
export function buildJudgePrompt(view: GradeView, abstracts: ReadonlyMap<string, string>): string {
  const cited = view.pmids.slice(0, 20).map((p, i) => {
    const head = `[${i + 1}] PMID ${p.pmid} — ${p.valid ? "VALID" : "FABRICATED"} | ${p.studyType} | ${p.title}`;
    const abstract = i < MAX_ABSTRACTS ? abstracts.get(p.pmid) : undefined;
    return abstract ? `${head}\nAbstract: ${abstract.slice(0, ABSTRACT_CHARS)}` : head;
  });
  return [
    `QUESTION:\n${view.prompt}`,
    `RUBRIC (grade against this):\n${view.rubric}`,
    `ANSWER:\n${view.answer}`,
    `CITED RECORDS (from the benchmark's citation audit):\n${cited.length > 0 ? cited.join("\n\n") : "(no citations)"}`,
  ].join("\n\n");
}

/** Parse `{"score": n, "reason": "..."}` out of a reply; null when malformed or out of range. */
export function parseJudgeReply(text: string): { score: number; reason: string } | null {
  const match = text.match(/\{[\s\S]*\}/);
  if (!match) return null;
  try {
    const parsed = JSON.parse(match[0]) as { score?: unknown; reason?: unknown };
    const score = Number(parsed.score);
    if (!Number.isFinite(score) || score < 0 || score > 10) return null;
    return { score: Math.round(score * 10) / 10, reason: String(parsed.reason ?? "").trim() };
  } catch {
    return null;
  }
}

/** Abstracts for every valid cited PMID, fetched from PubMed in batches. */
async function fetchAbstracts(pmids: string[]): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  const ncbi = new NcbiClient();
  const cache = new LRUBackend(5000);
  const adapter = new PubMedAdapter(ncbi);
  for (let i = 0; i < pmids.length; i += 50) {
    const { articles } = await fetchLiterature({ ids: pmids.slice(i, i + 50), database: "pubmed" }, cache, adapter);
    for (const a of articles) if (a.abstract) out.set(a.pmid, a.abstract);
  }
  return out;
}

export function parseArgs(argv: string[]): { dir: string; judge: string; conditions?: string[]; limit?: number } | null {
  const args = argv.slice(2);
  const flags = new Map<string, string>();
  let dir: string | undefined;
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    if (a.startsWith("--")) flags.set(a, args[++i] ?? "");
    else dir ??= a;
  }
  if (!dir) return null;
  const limit = flags.get("--limit");
  const conditions = flags.get("--conditions");
  return {
    dir,
    judge: flags.get("--judge") || "qwen3.8-max",
    ...(conditions ? { conditions: conditions.split(",").map((c) => c.trim()) } : {}),
    ...(limit ? { limit: Number(limit) } : {}),
  };
}

function report(grades: JudgeGrade[], items: { record: RawFile; query: BenchmarkQuery }[], judge: string): string {
  const out: string[] = [`# LLM-judge grades (${judge})`, "", "Blind, rubric-based 0–10 grades of the rubric answers. Indicative only — not human grades.", ""];
  const byKey = new Map(grades.map((g) => [g.itemId, g] as const));
  const conditions = [...new Set(grades.map((g) => g.condition))];
  out.push("| Condition | Answers judged | Judge score | Proxy score (same answers) | Composite with judge accuracy |", "|---|--:|--:|--:|--:|");
  const perQuery = new Map<string, Map<string, number[]>>();
  for (const condition of conditions) {
    const rows = items.filter((it) => it.record.condition === condition && byKey.has(buildView(it.record, it.query, false).itemId));
    const judged = rows.map((it) => byKey.get(buildView(it.record, it.query, false).itemId)!);
    const proxy = rows.map((it) => it.record._scoring?.accuracy?.score).filter((x): x is number => typeof x === "number" && Number.isFinite(x));
    const composites = rows
      .map((it, i) => {
        const s = it.record._scoring;
        if (!s) return Number.NaN;
        return compositeForCategory(it.record.category, {
          accuracy: judged[i]!.score,
          evidenceQuality: s.evidenceQuality?.score ?? Number.NaN,
          bullshitScore: s.bullshit?.score ?? Number.NaN,
          speedS: it.record.speedS,
          totalTokens: it.record.usage?.totalTokens ?? 0,
        });
      })
      .filter(Number.isFinite);
    const mean = (xs: number[]): string => (xs.length ? (xs.reduce((a, b) => a + b, 0) / xs.length).toFixed(2) : "—");
    out.push(`| ${condition} | ${judged.length} | ${mean(judged.map((g) => g.score))} | ${mean(proxy)} | ${mean(composites)} |`);
    for (const g of judged) {
      const q = perQuery.get(g.queryId) ?? new Map<string, number[]>();
      q.set(condition, [...(q.get(condition) ?? []), g.score]);
      perQuery.set(g.queryId, q);
    }
  }
  if (conditions.includes("mcp") && conditions.includes("mcp-skill")) {
    const a: number[] = [];
    const b: number[] = [];
    const avg = (xs: number[]): number => xs.reduce((x, y) => x + y, 0) / xs.length;
    for (const [, byCondition] of perQuery) {
      const skill = byCondition.get("mcp-skill");
      const mcp = byCondition.get("mcp");
      if (skill?.length && mcp?.length) {
        a.push(avg(skill));
        b.push(avg(mcp));
      }
    }
    const t = comparePaired(a, b);
    out.push("", t
      ? `Paired on query (judge score, runs averaged): mcp-skill ${t.meanA} vs mcp ${t.meanB}, Δ = ${t.meanDiff}, ${t.test}, n = ${t.n}, p = ${t.p_value}.`
      : "Paired on query: not enough paired data.");
  }
  out.push("", "| Query | " + conditions.join(" | ") + " |", "|---|" + conditions.map(() => "--:|").join(""));
  for (const [queryId, byCondition] of [...perQuery].sort()) {
    const cells = conditions.map((c) => {
      const xs = byCondition.get(c);
      return xs?.length ? (xs.reduce((x, y) => x + y, 0) / xs.length).toFixed(1) : "—";
    });
    out.push(`| ${queryId} | ${cells.join(" | ")} |`);
  }
  return out.join("\n") + "\n";
}

async function main(): Promise<void> {
  const opts = parseArgs(process.argv);
  if (!opts) {
    console.error("Usage: npx tsx benchmark/judge.ts <results-dir> [--judge <model-label>] [--conditions mcp,mcp-skill] [--limit <n>]");
    process.exitCode = 1;
    return;
  }
  const spec = MODELS.find((m) => m.label === opts.judge);
  if (!spec) throw new Error(`Unknown judge model "${opts.judge}" (add it to models.data.ts)`);
  const missing = missingKeyFor(spec);
  if (missing) throw new Error(`Missing ${missing} for judge ${spec.label} — add it to benchmark/.env`);

  const dir = resolve(opts.dir);
  const outPath = join(dir, `judge-${spec.label}.json`);
  const existing: JudgeGrade[] = JSON.parse(await readFile(outPath, "utf-8").catch(() => "[]"));
  const done = new Set(existing.map((g) => g.itemId));

  const items = (await loadRawItems(join(dir, "raw")))
    .map(({ record }) => ({ record, query: queryById(record.queryId) }))
    .filter((it): it is { record: RawFile; query: BenchmarkQuery } => it.query?.answerKey.kind === "rubric" && skipReason(it.record) === null)
    .filter((it) => !opts.conditions || opts.conditions.includes(it.record.condition));
  const todo = items.filter((it) => !done.has(buildView(it.record, it.query, false).itemId));
  const pending = todo.slice(0, opts.limit ?? Infinity);
  console.log(`${items.length} rubric answers, ${items.length - todo.length} already judged, judging ${pending.length} with ${spec.label} (${spec.modelId})`);

  const pmids = [...new Set(pending.flatMap((it) => buildView(it.record, it.query, false).pmids.filter((p) => p.valid).map((p) => p.pmid)))];
  const abstracts = await fetchAbstracts(pmids.filter((p) => /^\d+$/.test(p)));
  console.log(`fetched ${abstracts.size} abstracts for ${pmids.length} cited records`);

  const llm = await resolveModel(spec);
  const grades = [...existing];
  for (const [i, it] of pending.entries()) {
    const view = buildView(it.record, it.query, false);
    let parsed: { score: number; reason: string } | null = null;
    let inputTokens = 0;
    let outputTokens = 0;
    for (let attempt = 0; attempt < 3 && !parsed; attempt++) {
      try {
        const { text, usage } = await generateText({
          model: llm,
          system: JUDGE_SYSTEM,
          prompt: buildJudgePrompt(view, abstracts),
          ...(spec.fixedSampling ? {} : { temperature: 0 }),
          maxRetries: 2,
        });
        inputTokens += usage?.inputTokens ?? 0;
        outputTokens += usage?.outputTokens ?? 0;
        parsed = parseJudgeReply(text);
      } catch (err) {
        console.warn(`  ⚠ ${view.itemId}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
    if (!parsed) {
      console.warn(`  ✖ ${view.itemId} (${it.record.queryId}): no valid grade after 3 attempts`);
      continue;
    }
    grades.push({
      itemId: view.itemId,
      queryId: it.record.queryId,
      condition: it.record.condition,
      model: it.record.model,
      run: it.record.run,
      score: parsed.score,
      reason: parsed.reason,
      judge: spec.label,
      judgeModelId: spec.modelId,
      inputTokens,
      outputTokens,
      judgedAt: new Date().toISOString(),
    });
    await writeFile(outPath, JSON.stringify(grades, null, 2));
    console.log(`  [${i + 1}/${pending.length}] ${it.record.queryId} ${parsed.score}/10 — ${parsed.reason.slice(0, 100)}`);
  }

  const tokensIn = grades.reduce((s, g) => s + (g.inputTokens ?? 0), 0);
  const tokensOut = grades.reduce((s, g) => s + (g.outputTokens ?? 0), 0);
  console.log(`judge tokens so far: ${tokensIn} input, ${tokensOut} output`);
  const md = report(grades, items, `${spec.label} (${spec.modelId})`);
  await writeFile(join(dir, `judge-${spec.label}.md`), md);
  console.log(`\n${md}\nWrote ${outPath} and judge-${spec.label}.md`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((err) => {
    console.error("Fatal:", err instanceof Error ? (err.stack ?? err.message) : err);
    process.exitCode = 1;
  });
}
