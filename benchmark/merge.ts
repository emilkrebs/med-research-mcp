#!/usr/bin/env -S npx tsx
/**
 * Merge benchmark results directories into `results/combined/`: one scores.csv,
 * summary and charts across several runs (e.g. different models run on different days).
 *
 *   npx tsx merge.ts                       # every results/ subdir except `combined`
 *   npx tsx merge.ts results/A results/B   # explicit dirs, later ones win a shared cell
 *   npx tsx merge.ts --min-rows 20         # skip dirs with fewer rows (smoke runs)
 *
 * A cell is (query, condition, model, run). When several dirs contain the same
 * cell the later dir wins, except that a failed row (status != ok) never
 * replaces an ok one. `combined/provenance.json` records which dir every cell
 * came from, and the merge warns when the dirs were produced by different MCP
 * commits, scorer versions or answer-key versions (their numbers are then not
 * strictly comparable). Legacy scores.csv files without the newer columns are
 * accepted and normalized.
 */

import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { pathToFileURL } from "node:url";
import { NORMALIZATION, WEIGHTS } from "./lib/config.js";
import { QUERIES, queryById } from "./lib/queries.js";
import { readManifest, type Manifest } from "./lib/manifest.js";
import { renderCharts } from "./lib/report/charts.js";
import { toCsv } from "./lib/report/csv.js";
import { buildSummary, toMarkdown, type SummaryMeta } from "./lib/report/summary.js";
import type { AccuracySource, ConditionId, RunStatus, ScoreRow } from "./lib/types.js";

const RESULTS_DIR = join(import.meta.dirname, "results");
const COMBINED = "combined";

/** Split CSV text into records of fields, honoring quotes (commas, doubled quotes, newlines inside). */
export function parseCsv(text: string): Record<string, string>[] {
  const records: string[][] = [];
  let row: string[] = [];
  let cur = "";
  let inQuotes = false;
  const endRow = (): void => {
    row.push(cur);
    cur = "";
    if (row.length > 1 || row[0] !== "") records.push(row);
    row = [];
  };
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]!;
    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') (cur += '"', i++);
        else inQuotes = false;
      } else cur += ch;
    } else if (ch === '"') inQuotes = true;
    else if (ch === ",") (row.push(cur), (cur = ""));
    else if (ch === "\n") endRow();
    else if (ch !== "\r") cur += ch;
  }
  if (cur !== "" || row.length > 0) endRow();
  const [header, ...body] = records;
  if (!header) return [];
  return body.map((vals) => Object.fromEntries(header.map((h, i) => [h, vals[i] ?? ""])));
}

/** An empty cell is an unscored value (NaN), not 0 — mirrors how toCsv writes NaN. */
const num = (s: string | undefined): number => (s === undefined || s.trim() === "" ? Number.NaN : Number(s));

/** Accuracy source implied by a query's answer-key kind (for legacy CSVs that predate the column). */
function sourceFromKey(queryId: string): AccuracySource {
  const kind = queryById(queryId)?.answerKey.kind;
  if (kind === "reject") return "reject";
  if (kind === "rubric") return "proxy";
  return "deterministic";
}

const STATUSES: RunStatus[] = ["ok", "provider-error", "truncated", "scoring-error"];

/** Convert one parsed CSV record to a ScoreRow, defaulting the columns legacy files lack. */
export function toScoreRow(r: Record<string, string>): ScoreRow {
  const input = num(r.input_tokens);
  const output = num(r.output_tokens);
  const status = STATUSES.includes(r.status as RunStatus) ? (r.status as RunStatus) : "ok";
  return {
    query_id: r.query_id!,
    category: r.category as ScoreRow["category"],
    condition: r.condition as ConditionId,
    model: r.model!,
    run: Number(r.run),
    status,
    accuracy: num(r.accuracy),
    accuracy_source: (r.accuracy_source as AccuracySource) || sourceFromKey(r.query_id!),
    evidence_quality: num(r.evidence_quality),
    bullshit_score: num(r.bullshit_score),
    speed_s: num(r.speed_s),
    input_tokens: input,
    output_tokens: output,
    total_tokens: r.total_tokens !== undefined && r.total_tokens !== "" ? Number(r.total_tokens) : input + output,
    tool_calls: num(r.tool_calls),
    tools_used: r.tools_used ?? "",
    pmids_cited: num(r.pmids_cited),
    pmids_valid: num(r.pmids_valid),
    pmids_fabricated: num(r.pmids_fabricated),
    other_citations: r.other_citations !== undefined && r.other_citations !== "" ? Number(r.other_citations) : 0,
    ...(r.citations_checked !== undefined && r.citations_checked !== ""
      ? { citations_checked: Number(r.citations_checked), citations_misattributed: num(r.citations_misattributed) }
      : {}),
    composite: num(r.composite),
  };
}

export const cellKey = (r: ScoreRow): string => `${r.query_id}|${r.condition}|${r.model}|${r.run}`;

export interface Source {
  /** Directory name (provenance label). */
  dir: string;
  rows: ScoreRow[];
  manifest?: Partial<Manifest>;
}

export interface MergeResult {
  rows: ScoreRow[];
  /** cell key → source dir the surviving row came from. */
  provenance: Record<string, string>;
  /** Dirs that contributed at least one surviving cell. */
  sources: string[];
  warnings: string[];
}

/** Warn when merged dirs differ in MCP commit, scorer version or answer-key versions. */
export function provenanceWarnings(sources: Pick<Source, "dir" | "manifest">[]): string[] {
  const warnings: string[] = [];
  const withManifest = sources.filter((s) => s.manifest);
  const without = sources.filter((s) => !s.manifest).map((s) => s.dir);
  if (without.length > 0) warnings.push(`no manifest.json (legacy run, provenance unknown): ${without.join(", ")}`);

  const describe = (pick: (m: Partial<Manifest>) => string | undefined): string => {
    const groups = new Map<string, string[]>();
    for (const s of withManifest) {
      const v = pick(s.manifest!) ?? "unknown";
      groups.set(v, [...(groups.get(v) ?? []), s.dir]);
    }
    return [...groups].map(([v, dirs]) => `${v} (${dirs.join(", ")})`).join(" vs ");
  };
  const differs = (pick: (m: Partial<Manifest>) => string | undefined): boolean =>
    new Set(withManifest.map((s) => pick(s.manifest!) ?? "unknown")).size > 1;

  const commit = (m: Partial<Manifest>) => m.git?.commit;
  const scorer = (m: Partial<Manifest>) => (m.scorer_version === undefined ? undefined : String(m.scorer_version));
  const keys = (m: Partial<Manifest>) =>
    m.queries ? JSON.stringify([...m.queries].sort((a, b) => a.id.localeCompare(b.id))) : undefined;

  if (differs(commit)) warnings.push(`merged runs come from different MCP commits: ${describe(commit)}`);
  if (differs(scorer)) warnings.push(`merged runs used different scorer versions: ${describe(scorer)}`);
  if (differs(keys)) {
    // Name the queries whose key version differs, not an opaque blob.
    const byQuery = new Map<string, Set<number>>();
    for (const s of withManifest)
      for (const q of s.manifest!.queries ?? []) byQuery.set(q.id, (byQuery.get(q.id) ?? new Set()).add(q.answerKeyVersion));
    const changed = [...byQuery].filter(([, v]) => v.size > 1).map(([id]) => id);
    warnings.push(
      changed.length > 0
        ? `merged runs used different answer-key versions for: ${changed.join(", ")}`
        : "merged runs cover different query sets",
    );
  }
  return warnings;
}

/**
 * Merge sources in the order given (later wins a shared cell, but a non-ok row
 * never displaces an ok one). Dirs with fewer than `minRows` rows are skipped as
 * smoke runs.
 */
export function mergeSources(sources: Source[], minRows = 12): MergeResult {
  const warnings: string[] = [];
  const best = new Map<string, { row: ScoreRow; dir: string }>();
  const used: Source[] = [];

  for (const s of sources) {
    if (s.rows.length < minRows) {
      console.log(`  Skipping ${s.dir}: ${s.rows.length} rows (< --min-rows ${minRows})`);
      continue;
    }
    used.push(s);
    for (const row of s.rows) {
      const key = cellKey(row);
      const prev = best.get(key);
      if (prev && prev.row.status === "ok" && row.status !== "ok") continue;
      best.set(key, { row, dir: s.dir });
    }
  }

  warnings.push(...provenanceWarnings(used));
  const provenance: Record<string, string> = {};
  const rows: ScoreRow[] = [];
  for (const [key, { row, dir }] of best) {
    provenance[key] = dir;
    rows.push(row);
  }
  rows.sort(
    (a, b) =>
      a.query_id.localeCompare(b.query_id) ||
      a.condition.localeCompare(b.condition) ||
      a.model.localeCompare(b.model) ||
      a.run - b.run,
  );
  return { rows, provenance, sources: [...new Set(Object.values(provenance))].sort(), warnings };
}

/** Every results subdir except `combined`, chronological (names are timestamps). */
export function defaultDirs(resultsDir: string = RESULTS_DIR): string[] {
  if (!existsSync(resultsDir)) return [];
  return readdirSync(resultsDir)
    .filter((d) => d !== COMBINED && statSync(join(resultsDir, d)).isDirectory())
    .sort()
    .map((d) => join(resultsDir, d));
}

/** Read one results dir's scores.csv (+ manifest); undefined when it has no CSV. */
export function loadSource(dir: string): Source | undefined {
  const csv = join(dir, "scores.csv");
  if (!existsSync(csv)) return undefined;
  const manifest = readManifest(dir);
  return {
    dir: basename(resolve(dir)),
    rows: parseCsv(readFileSync(csv, "utf-8")).map(toScoreRow),
    ...(manifest ? { manifest } : {}),
  };
}

function main(): void {
  const { values, positionals } = parseArgs({
    options: { "min-rows": { type: "string" }, help: { type: "boolean" } },
    allowPositionals: true,
  });
  if (values.help) {
    console.log("Usage: npx tsx merge.ts [--min-rows <n>] [results-dir ...]\nDefault: every results/ subdir except `combined`; --min-rows defaults to 12.");
    return;
  }
  const minRaw = values["min-rows"];
  if (minRaw !== undefined && !/^\d+$/.test(minRaw)) {
    console.error(`Error: --min-rows must be a non-negative integer (got "${minRaw}").`);
    process.exitCode = 2;
    return;
  }
  const minRows = minRaw === undefined ? 12 : Number(minRaw);

  const dirs = positionals.length > 0 ? positionals.map((d) => resolve(d)) : defaultDirs();
  const sources: Source[] = [];
  for (const dir of dirs) {
    const s = loadSource(dir);
    if (s) sources.push(s);
    else console.warn(`  ⚠  ${dir}: no scores.csv — skipped`);
  }

  const { rows, provenance, sources: used, warnings } = mergeSources(sources, minRows);
  if (rows.length === 0) {
    console.error("Nothing to merge.");
    process.exitCode = 1;
    return;
  }
  for (const w of warnings) console.warn(`  ⚠  ${w}`);
  console.log(`Merged ${rows.length} rows from ${used.length} dir(s)`);

  const outDir = join(RESULTS_DIR, COMBINED);
  mkdirSync(join(outDir, "charts"), { recursive: true });
  writeFileSync(join(outDir, "scores.csv"), toCsv(rows));
  writeFileSync(join(outDir, "provenance.json"), `${JSON.stringify({ sources: used, warnings, cells: provenance }, null, 2)}\n`);

  const charts = renderCharts(rows);
  for (const [name, svg] of Object.entries(charts)) writeFileSync(join(outDir, "charts", name), svg);
  console.log(`Rendered ${Object.keys(charts).length} charts to ${join(outDir, "charts")}`);

  const manifests = sources.filter((s) => used.includes(s.dir) && s.manifest).map((s) => s.manifest!);
  const single = (vals: (string | undefined)[]): string => {
    const u = new Set(vals);
    return u.size === 1 && !u.has(undefined) ? [...u][0]! : "merged";
  };
  const queryIds = new Set(rows.map((r) => r.query_id));
  const meta: SummaryMeta = {
    timestamp: "combined",
    mcp_version: single(manifests.map((m) => m.mcp_version)),
    mcp_commit: single(manifests.map((m) => m.git?.commit)),
    benchmark_version: single(manifests.map((m) => m.benchmark_version)),
    models: [...new Set(rows.map((r) => r.model))],
    conditions: [...new Set(rows.map((r) => r.condition))],
    runs: Math.max(1, ...rows.map((r) => r.run)),
    total_responses: rows.length,
    weights: { ...WEIGHTS },
    normalization: { ...NORMALIZATION },
    unverified_queries: QUERIES.filter((q) => !q.verified && queryIds.has(q.id)).map((q) => q.id),
    sources: used,
  };
  const summary = buildSummary(rows, meta);
  writeFileSync(join(outDir, "summary.json"), JSON.stringify(summary, null, 2));
  writeFileSync(join(outDir, "summary.md"), toMarkdown(summary));
  console.log(toMarkdown(summary));
}

// Only auto-run as a script, so tests can import the pure functions.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
