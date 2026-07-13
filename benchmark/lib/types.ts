/** Shared benchmark types: queries, raw run records, and scored rows. */

/** The six query families from the spec. */
export type Category =
  | "factual"
  | "drill-down"
  | "synthesis"
  | "edge-case"
  | "compound"
  | "bullshit";

/** The three experimental conditions. */
export type ConditionId = "closed-book" | "web-search" | "mcp";

/** Short CLI/flag aliases for conditions (A/B/C). */
export type ConditionLetter = "A" | "B" | "C";

/**
 * How a query's accuracy is scored. Discriminated on `kind`:
 *  - `evidence-score` — ground truth is computed live by grading the PMID with
 *    the library's own grader, then compared to the number the model stated.
 *  - `values` — every expected string (a dose, a PMID, a study type) must appear
 *    in the answer; score is the fraction found, fuzzy-matched.
 *  - `rubric` — an LLM judge scores the answer 0–10 against the rubric, with the
 *    real abstracts of every cited PMID supplied so it can catch unsupported claims.
 *  - `reject` — a bullshit query: full marks only for correctly refusing to
 *    corroborate a study that does not exist.
 */
export type AnswerKey =
  | { kind: "evidence-score"; pmid: string }
  | { kind: "values"; expected: string[]; note?: string }
  | { kind: "rubric"; rubric: string; expectPmids?: boolean }
  | { kind: "reject"; fabricated: string };

export interface BenchmarkQuery {
  id: string;
  category: Category;
  prompt: string;
  answerKey: AnswerKey;
  /**
   * True once the answer key has been checked against reality by a human.
   * Unverified keys still run and score, but must not be used for a published
   * claim — the harness prints a warning and lists them in the report.
   */
  verified: boolean;
}

/** One tool invocation the model made during a run. */
export interface ToolCallRecord {
  toolName: string;
  input: unknown;
  /** Serialized tool output, truncated for the audit log. */
  outputPreview?: string;
  isError?: boolean;
}

export interface Usage {
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
}

/** The full, auditable record of a single model response. Saved to `raw/`. */
export interface RunRecord {
  queryId: string;
  category: Category;
  condition: ConditionId;
  /** Model label from config (e.g. `deepseek-v4-pro`), not the raw provider id. */
  model: string;
  run: number;
  systemPrompt: string;
  prompt: string;
  text: string;
  toolCalls: ToolCallRecord[];
  toolCallCount: number;
  toolsUsed: string[];
  usage: Usage;
  speedS: number;
  startedAt: string;
  finishedAt: string;
  /** Set when the provider call threw; the row still scores as a zero response. */
  error?: string;
}

/** One fully-scored run — becomes one row of `scores.csv`. */
export interface ScoreRow {
  query_id: string;
  category: Category;
  condition: ConditionId;
  model: string;
  run: number;
  accuracy: number; // 0–10
  evidence_quality: number; // 0–5
  bullshit_score: number; // 0–1
  speed_s: number;
  input_tokens: number;
  output_tokens: number;
  tool_calls: number;
  tools_used: string; // comma-joined
  pmids_cited: number;
  pmids_valid: number;
  pmids_fabricated: number;
  composite: number; // 0–10
}
