/** Shared benchmark types: queries, raw run records, and scored rows. */

/** The query families: the spec's six plus `recent` (literature newer than the models' training data). */
export type Category =
  | "factual"
  | "drill-down"
  | "synthesis"
  | "edge-case"
  | "compound"
  | "bullshit"
  | "recent";

/** The three experimental conditions. */
export type ConditionId = "closed-book" | "web-search" | "mcp";

/** Short CLI/flag aliases for conditions (A/B/C). */
export type ConditionLetter = "A" | "B" | "C";

/**
 * How a query's accuracy is scored. Discriminated on `kind`:
 *  - `values` — the query forces a final `ANSWER — field: value | …` line; the
 *    scorer parses that line and compares each expected `field: value` pair
 *    exactly (after normalizing case, whitespace, markdown, and dashes). Score
 *    is the fraction of fields that match.
 *  - `rubric` — open-ended; there is no ground-truth string to match, so a human
 *    reviews the answer against the rubric using `grade.ts` and writes a 0–10
 *    accuracy into the run's `overrides.json` (applied by `--rescore`). Until a
 *    human grades it, accuracy falls back to a provisional citation-quality
 *    proxy (mean evidence grade of cited PMIDs × 2) — that measures citation
 *    tier, not correctness, and must not be quoted on its own.
 *  - `reject` — a bullshit query: full marks only for correctly refusing to
 *    corroborate a study that does not exist.
 */
export type AnswerKey =
  | { kind: "values"; expected: string[]; note?: string }
  | { kind: "rubric"; rubric: string; expectPmids?: boolean }
  | {
      kind: "reject";
      fabricated: string;
      /**
       * PubMed query that should return zero hits if the study really is
       * fabricated. `scripts/verify-keys.ts` runs it live before a publish run.
       */
      probe?: string;
    };

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
  /**
   * Bumped when the answer key (or the prompt it depends on) is revised. The
   * rescorer re-scores raw data that was scored with an older version.
   */
  answerKeyVersion?: number;
  /**
   * Terms a cited paper must mention (title, abstract or MeSH; case-insensitive,
   * matched at a word start, so `creatin` covers "creatine"). At least one must
   * appear, or the citation is flagged as off-topic by the attribution check.
   * Omit when any paper could legitimately be cited (e.g. bullshit queries).
   */
  topics?: string[];
}

/**
 * Outcome of a run, decided at scoring time. Only `ok` rows enter means and
 * significance tests; the others are reported as rates so failures are visible
 * instead of silently scoring as (non-)zeros.
 *  - `provider-error` — the model call threw (RunRecord.error is set).
 *  - `truncated` — the agent loop ended without a final answer (empty text),
 *    e.g. it hit the step limit or the timeout mid-tool-call; also covers
 *    provider-side context truncation (`RunRecord.contextTruncated`), where the
 *    provider silently dropped the start of the conversation so the answer is
 *    not a valid response to the question.
 *  - `scoring-error` — the response exists but could not be scored (e.g. PubMed
 *    was unreachable while verifying citations). Re-run `--rescore` later.
 */
export type RunStatus = "ok" | "provider-error" | "truncated" | "scoring-error";

/** Where a row's accuracy number came from. */
export type AccuracySource =
  /** Deterministic `values` key — fully automated ground truth. */
  | "deterministic"
  /** Bullshit query — accuracy mirrors the rejection outcome. */
  | "reject"
  /** Rubric query graded by one or more humans via overrides. */
  | "human"
  /** Rubric query not yet graded — citation-quality proxy, NOT correctness. */
  | "proxy";

/** One tool invocation the model made during a run. */
export interface ToolCallRecord {
  toolName: string;
  input: unknown;
  /** Full tool output, as returned to the model. */
  output?: unknown;
  /** Truncated serialized output. Legacy records (pre-2026-10) only have this. */
  outputPreview?: string;
  isError?: boolean;
  /** Wall-clock time spent inside the tool's execute(), in ms. */
  durationMs?: number;
}

export interface Usage {
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
}

/** Generation settings a run used — part of the resume fingerprint. */
export interface RunSettings {
  temperature: number;
  maxSteps: number;
  timeoutMs: number;
}

/** The full, auditable record of a single model response. Saved to `raw/`. */
export interface RunRecord {
  queryId: string;
  category: Category;
  condition: ConditionId;
  /** Model label from config (e.g. `deepseek-v3.2`), not the raw provider id. */
  model: string;
  /** Provider backing the model (`openai`, `deepseek`, …). Absent on legacy records. */
  provider?: string;
  /** Exact provider model id that was called. Absent on legacy records. */
  modelId?: string;
  /** Settings this run was generated with. Absent on legacy records. */
  settings?: RunSettings;
  run: number;
  systemPrompt: string;
  prompt: string;
  text: string;
  toolCalls: ToolCallRecord[];
  toolCallCount: number;
  toolsUsed: string[];
  usage: Usage;
  /** Total wall-clock seconds for the run (model + tools). */
  speedS: number;
  /** Seconds spent inside tool executes (summed). Absent on legacy records. */
  toolS?: number;
  /** AI SDK finish reason of the last step (`stop`, `tool-calls`, `length`, …). */
  finishReason?: string;
  /** Number of agent-loop steps taken. */
  stepCount?: number;
  /**
   * `usage.inputTokens` reported for each agent-loop step, for auditing. Steps
   * whose provider reported nothing are 0. Absent on legacy records.
   */
  stepInputTokens?: number[];
  /**
   * True when some step's input tokens were lower than the previous step's. The
   * conversation only grows, so this means the provider silently truncated the
   * context (e.g. Ollama's default 4096-token window) and the model answered
   * without part of the prompt. Such runs are scored as `truncated`.
   */
  contextTruncated?: boolean;
  startedAt: string;
  finishedAt: string;
  /** Set when the provider call threw (or timed out). */
  error?: string;
}

/** One fully-scored run — becomes one row of `scores.csv`. */
export interface ScoreRow {
  query_id: string;
  category: Category;
  condition: ConditionId;
  model: string;
  run: number;
  status: RunStatus;
  accuracy: number; // 0–10
  accuracy_source: AccuracySource;
  evidence_quality: number; // 0–5
  bullshit_score: number; // 0–1
  speed_s: number;
  input_tokens: number;
  output_tokens: number;
  total_tokens: number;
  tool_calls: number;
  tools_used: string; // comma-joined
  pmids_cited: number;
  pmids_valid: number;
  pmids_fabricated: number;
  /** Non-PubMed identifiers cited (DOIs that don't map to a PMID, preprint ids). Counted, not graded. */
  other_citations: number;
  /** Resolved citations the attribution check could test (absent on rows scored before scorer v5). */
  citations_checked?: number;
  /** Of those, citations whose surrounding claim contradicts the record (wrong topic/year/author/design/numbers). */
  citations_misattributed?: number;
  composite: number; // 0–10
}

/** Per-dimension breakdown embedded in raw JSON via `_scoring`. */
export interface AccuracyDetail {
  score: number;
  kind: AnswerKey["kind"];
  /** Only for values: the parsed final ANSWER line (absent when none was found). */
  answerLine?: string;
  /** Only for values: which expected `field: value` pairs matched / didn't. */
  hits?: string[];
  missed?: string[];
}

export interface EvidenceDetail {
  score: number; // 0–5 mean
  /** Every resolved citation; regional records (Europe PMC non-PubMed, ChinaXiv) carry `database`. */
  pmids: { pmid: string; valid: boolean; evidenceScore?: number; studyType?: string; title?: string; database?: string }[];
  /** Non-PubMed identifiers found in the answer (counted, not graded). */
  other?: { id: string; kind: "doi" | "europepmc" | "arxiv-like" | "url" }[];
  /** PMIDs that appeared in the answer but were excluded because the prompt itself contains them. */
  echoedFromPrompt?: string[];
}

export interface BullshitDetail {
  score: number; // 0–1
  rejected: boolean;
  fabricatedPmids: string[];
}

/** One way a citation's surrounding claim contradicts the cited record. */
export interface AttributionIssue {
  /** The cited id (PMID, `CBA:…`, `chinaxiv-…`). */
  id: string;
  check: "topic" | "year" | "author" | "design" | "numbers";
  /** What the answer said next to the citation. */
  claimed: string;
  /** What the record says. */
  actual: string;
}

/** Deterministic citation-attribution audit (lib/scoring/attribution.ts). */
export interface AttributionDetail {
  /** Resolved citations with at least one applicable check. */
  checked: number;
  /** Of those, citations failing at least one check. */
  misattributed: number;
  issues: AttributionIssue[];
}

export interface ScoreBreakdown {
  status: RunStatus;
  accuracy: AccuracyDetail;
  evidenceQuality: EvidenceDetail;
  bullshit: BullshitDetail;
  /** Absent on breakdowns from scorer v4 and earlier. */
  attribution?: AttributionDetail;
  composite: number;
  answerKeyVersion?: number;
  /** `SCORER_VERSION` from lib/scoring/score.ts at scoring time; rescore re-scores older breakdowns. */
  scorerVersion?: number;
  /** Set when status is `scoring-error`. */
  scoringError?: string;
  overridden?: { by: string; reason: string; at: string };
}

/**
 * One human-override entry in `overrides.json`.
 *
 * Multi-grader rule: several entries may match the same row exactly
 * (same queryId/condition/model/run, no wildcards) with different `author`s —
 * one per grader. For each dimension, the applied value is the MEAN of those
 * graders' numeric values. Wildcard entries are applied first, then exact ones.
 */
export interface ScoreOverride {
  queryId: string;
  condition: ConditionId | "*";
  model: string | "*";
  run: number | "*";
  accuracy?: number | null;
  evidence_quality?: number | null;
  bullshit_score?: number | null;
  composite?: number | null;
  reason: string;
  /** Grader id. grade.ts always sets it; entries from the same author for the same row replace each other. */
  author?: string;
  at?: string;
}

/** The full overrides file schema. */
export interface OverridesFile {
  notes?: Record<string, { answer_key_note?: string }>;
  overrides: ScoreOverride[];
}
