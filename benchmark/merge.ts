#!/usr/bin/env -S npx tsx
/**
 * Merge all benchmark scores.csv files, filter error rows, and regenerate
 * combined charts for the full model comparison.
 */
import { readFileSync, readdirSync, mkdirSync, writeFileSync } from "node:fs";
import { join, basename } from "node:path";
import { renderCharts } from "./lib/report/charts.js";
import { toCsv } from "./lib/report/csv.js";
import { buildSummary, toMarkdown, type SummaryMeta } from "./lib/report/summary.js";
import type { ScoreRow, ConditionId } from "./lib/types.js";

const RESULTS_DIR = join(import.meta.dirname, "results");
const OUT_DIR = join(import.meta.dirname, "results", "combined");

interface RawRow {
  query_id: string;
  category: string;
  condition: string;
  model: string;
  run: string;
  accuracy: string;
  evidence_quality: string;
  bullshit_score: string;
  speed_s: string;
  input_tokens: string;
  output_tokens: string;
  tool_calls: string;
  tools_used: string;
  pmids_cited: string;
  pmids_valid: string;
  pmids_fabricated: string;
  composite: string;
}

function parseCsv(text: string): RawRow[] {
  const lines = text.trim().split("\n");
  if (lines.length < 2) return [];
  const headers = lines[0]!.split(",");
  return lines.slice(1).map((line) => {
    // Proper CSV parsing: handle quoted fields containing commas
    const vals: string[] = [];
    let current = "";
    let inQuotes = false;
    for (let i = 0; i < line.length; i++) {
      const ch = line[i]!;
      if (inQuotes) {
        if (ch === '"') {
          if (line[i + 1] === '"') { current += '"'; i++; }
          else { inQuotes = false; }
        } else { current += ch; }
      } else {
        if (ch === '"') { inQuotes = true; }
        else if (ch === ",") { vals.push(current); current = ""; }
        else { current += ch; }
      }
    }
    vals.push(current);
    const obj: Record<string, string> = {};
    headers.forEach((h, i) => (obj[h] = vals[i] ?? ""));
    return obj as unknown as RawRow;
  });
}

function toScoreRow(r: RawRow): ScoreRow {
  return {
    query_id: r.query_id,
    category: r.category as ScoreRow["category"],
    condition: r.condition as ConditionId,
    model: r.model,
    run: Number(r.run),
    accuracy: Number(r.accuracy),
    evidence_quality: Number(r.evidence_quality),
    bullshit_score: Number(r.bullshit_score),
    speed_s: Number(r.speed_s),
    input_tokens: Number(r.input_tokens),
    output_tokens: Number(r.output_tokens),
    tool_calls: Number(r.tool_calls),
    tools_used: r.tools_used,
    pmids_cited: Number(r.pmids_cited),
    pmids_valid: Number(r.pmids_valid),
    pmids_fabricated: Number(r.pmids_fabricated),
    composite: Number(r.composite),
  };
}

// Load and merge all CSVs — prefer later runs when same cell appears in multiple runs
const seen = new Map<string, { row: ScoreRow; dir: string }>();
const allRows: ScoreRow[] = [];

const dirs = readdirSync(RESULTS_DIR).sort(); // chronological order
for (const dir of dirs) {
  const csvPath = join(RESULTS_DIR, dir, "scores.csv");
  try {
    const text = readFileSync(csvPath, "utf-8");
    const parsed = parseCsv(text);
    // Skip smoke-test runs (fewer than 12 rows = partial)
    if (parsed.length < 12) {
      console.log(`  Skipping smoke run: ${dir} (${parsed.length} rows)`);
      continue;
    }
    for (const raw of parsed) {
      const row = toScoreRow(raw);
      const key = `${row.query_id}|${row.condition}|${row.model}|${row.run}`;
      seen.set(key, { row, dir }); // later run overwrites
    }
  } catch {
    // skip missing CSVs
  }
}

// Build final list from the map
for (const [key, { row, dir }] of seen) {
  allRows.push(row);
}

console.log(`Merged ${allRows.length} rows from ${seen.size} unique query×condition×model×run cells`);

// Debug: verify qwen3.5-122b MCP scores
const check122b = allRows.filter(r => r.model === "qwen3.5-122b" && r.condition === "mcp");
const meanComp = check122b.reduce((s, r) => s + r.composite, 0) / check122b.length;
console.log(`  qwen3.5-122b MCP: ${check122b.length} rows, mean composite=${meanComp.toFixed(2)}`);

// Sort
allRows.sort((a, b) =>
  a.query_id.localeCompare(b.query_id) ||
  a.condition.localeCompare(b.condition) ||
  a.model.localeCompare(b.model) ||
  a.run - b.run
);

// Write merged CSV
mkdirSync(OUT_DIR, { recursive: true });
writeFileSync(join(OUT_DIR, "scores.csv"), toCsv(allRows));

// Render charts
const chartsDir = join(OUT_DIR, "charts");
mkdirSync(chartsDir, { recursive: true });
const charts = renderCharts(allRows);
for (const [name, svg] of Object.entries(charts)) {
  writeFileSync(join(chartsDir, name), svg);
}
console.log(`Rendered ${Object.keys(charts).length} charts to ${chartsDir}`);

// Summary
const models = [...new Set(allRows.map((r) => r.model))];
const conditions = [...new Set(allRows.map((r) => r.condition))];
const runs = Math.max(1, ...allRows.map((r) => r.run));
const meta: SummaryMeta = {
  timestamp: "combined",
  mcp_version: "merged",
  mcp_commit: "merged",
  models,
  conditions: conditions as ConditionId[],
  runs,
  total_responses: allRows.length,
  weights: { accuracy: 0.4, evidence: 0.25, bullshit: 0.25, speed: 0.05, cost: 0.05 },
  normalization: { speedRefS: 60, tokenRef: 20000 },
  unverified_queries: [],
};
const summary = buildSummary(allRows, meta);
writeFileSync(join(OUT_DIR, "summary.json"), JSON.stringify(summary, null, 2));
writeFileSync(join(OUT_DIR, "summary.md"), toMarkdown(summary));
console.log(toMarkdown(summary));
