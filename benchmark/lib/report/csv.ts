/** Emit `scores.csv` — one row per run, R/pandas/Excel-ready (spec §"scores.csv"). */

import type { ScoreRow } from "../types.js";

const COLUMNS: (keyof ScoreRow)[] = [
  "query_id",
  "category",
  "condition",
  "model",
  "run",
  "status",
  "accuracy",
  "accuracy_source",
  "evidence_quality",
  "bullshit_score",
  "speed_s",
  "input_tokens",
  "output_tokens",
  "total_tokens",
  "tool_calls",
  "tools_used",
  "pmids_cited",
  "pmids_valid",
  "pmids_fabricated",
  "other_citations",
  "citations_checked",
  "citations_misattributed",
  "composite",
];

/** NaN (an unscored value) is written as an empty cell so R/pandas read NA, not the string "NaN". */
function cell(value: unknown): string {
  if (typeof value === "number" && !Number.isFinite(value)) return "";
  const s = String(value ?? "");
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export function toCsv(rows: ScoreRow[]): string {
  const header = COLUMNS.join(",");
  const body = rows.map((row) => COLUMNS.map((c) => cell(row[c])).join(","));
  return [header, ...body].join("\n") + "\n";
}
