/** Emit `scores.csv` — one row per run, R/pandas/Excel-ready (spec §"scores.csv"). */

import type { ScoreRow } from "../types.js";

export const CSV_COLUMNS: (keyof ScoreRow)[] = [
  "query_id",
  "category",
  "split",
  "key_kind",
  "retrieval_only",
  "beyond_pubmed",
  "condition",
  "model",
  "run",
  "status",
  "accuracy",
  "accuracy_source",
  "accuracy_graders",
  "bullshit_score",
  "evidence_quality",
  "speed_s",
  "input_tokens",
  "output_tokens",
  "total_tokens",
  "tool_calls",
  "tools_used",
  "pmids_cited",
  "pmids_valid",
  "pmids_fabricated",
  "pmids_off_topic",
  "other_citations",
  "citations_checked",
  "citations_misattributed",
];

/** NaN (an unscored value) is written as an empty cell so R/pandas read NA, not the string "NaN". */
function cell(value: unknown): string {
  if (typeof value === "number" && !Number.isFinite(value)) return "";
  const s = String(value ?? "");
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export function toCsv(rows: ScoreRow[]): string {
  const header = CSV_COLUMNS.join(",");
  const body = rows.map((row) => CSV_COLUMNS.map((c) => cell(row[c])).join(","));
  return [header, ...body].join("\n") + "\n";
}
