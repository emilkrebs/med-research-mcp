/** Shared benchmark types: queries, raw run records, and scored rows. */

/**
 * The query families. The development set uses the spec's six plus `recent`
 * (literature newer than the models' training data); the held-out set uses
 * `lookup` (a sampled trial to find and read), `bullshit` (a fabricated study)
 * and `control` (a real study asked about in the same form as a fabricated one),
 * and, from version 2, three kinds whose answer is in no PubMed abstract
 * (`beyondPubmed`): `preprint` (a Europe PMC preprint without a PubMed record),
 * `regional` (a Chinese Biological Abstracts record or a ChinaXiv preprint) and
 * `fulltext` (a figure the full text of a PubMed-indexed trial states and its
 * abstract does not).
 */
export type Category =
  | "factual"
  | "drill-down"
  | "synthesis"
  | "edge-case"
  | "compound"
  | "bullshit"
  | "recent"
  | "lookup"
  | "control"
  | "preprint"
  | "regional"
  | "fulltext";

/**
 * Which set a query belongs to. `dev` queries were used while building the
 * server, the skill and this scorer, so their scores are development numbers.
 * `test` queries are held out: never tune anything against them.
 */
export type Split = "dev" | "test";

/** The experimental conditions. */
export type ConditionId = "closed-book" | "web-search" | "pubmed" | "mcp" | "mcp-skill";

/** Short CLI/flag aliases for conditions. */
export type ConditionLetter = "A" | "B" | "C" | "D" | "E";

/** The database record an answer key was read from, with the passage that states it. */
export interface KeySource {
  database: "pubmed" | "europepmc" | "chinaxiv";
  /** PMID, `CBA:521529`, `chinaxiv-202608.00133`. */
  id: string;
  /**
   * Verbatim passage of the record's abstract (or title) that states every
   * expected number (but the full-text figure of a `fulltext` key, see `fullTextQuote`).
   * `scripts/verify-keys.ts` fetches the record and checks that the passage is in it
   * and that each expected number is in the passage.
   */
  quote: string;
  /**
   * `fulltext` keys only: a verbatim passage of the record's FULL TEXT, as the library's own
   * full-text function (`literature_fulltext`) returns it, that states the figure the abstract
   * does not. `quote` then covers the number the abstract states, `fullTextQuote` the other one.
   * `scripts/verify-keys.ts` fetches the full text and checks that the passage is in it and holds
   * the number, and that the abstract does not contain that number at all.
   */
  fullTextQuote?: string;
}

/**
 * How a query's accuracy is scored. Discriminated on `kind`:
 *  - `values` — the query forces a final `ANSWER — field: value | …` line; the
 *    scorer parses that line and compares each expected `field: value` pair
 *    exactly (after normalizing case, whitespace, markdown, and dashes). Score
 *    is the fraction of fields that match.
 *  - `rubric` — open-ended; there is no ground-truth string to match, so a human
 *    reviews the answer against the rubric using `grade.ts` and writes a 0–10
 *    accuracy into the run's `overrides.json` (applied by `--rescore`). Until
 *    then the answer has no accuracy at all (unscored).
 *  - `reject` — a fabricated study: full marks only for refusing to corroborate
 *    a study that does not exist.
 *  - `accept` — a real study, asked about in the same form as a fabricated one:
 *    full marks for not rejecting it. Paired with `reject`, it shows whether a
 *    model tells real from fabricated or rejects (or accepts) everything.
 */
export type AnswerKey =
  | { kind: "values"; expected: string[]; note?: string; source?: KeySource }
  | { kind: "rubric"; rubric: string }
  | {
      kind: "reject";
      fabricated: string;
      /**
       * PubMed query that should return zero hits if the study really is
       * fabricated. `scripts/verify-keys.ts` runs it live before a publish run.
       */
      probe?: string;
    }
  | {
      kind: "accept";
      /** PMID of the real study the prompt describes. */
      pmid: string;
      /** Surname of the author the prompt names; must be one of the record's authors. */
      author: string;
      /** Publication year the prompt names; must be within a year of the record's. */
      year: number;
    };

export interface BenchmarkQuery {
  id: string;
  category: Category;
  /** Defaults to `dev` (applied in lib/queries.ts). */
  split?: Split;
  prompt: string;
  answerKey: AnswerKey;
  /**
   * True once the answer key has been checked against reality by a human.
   * Unverified keys still run, but must not be used for a published claim —
   * the harness prints a warning and lists them in the report.
   */
  verified: boolean;
  /**
   * Bumped when the answer key (or the prompt it depends on) is revised. The
   * rescorer re-scores raw data that was scored with an older version.
   */
  answerKeyVersion?: number;
  /**
   * Terms a cited paper must mention (title, abstract or MeSH; case-insensitive,
   * matched at a word start, so `creatin` covers "creatine"). A cited record that
   * mentions none of them is about something else and counts as a fabricated
   * citation. Omit when any paper could legitimately be cited (fabricated studies).
   */
  topics?: string[];
  /**
   * True when the answer is out of reach of training data by construction: a
   * paper published after the benchmarked models were trained, or a record that
   * only a regional database holds. Against a closed-book baseline these queries
   * are decided before the run, so tests are also reported without them.
   */
  retrievalOnly?: boolean;
  /**
   * True when the answer is not stated in any PubMed abstract: a preprint without a PubMed record,
   * a record only a regional database holds, or a figure only a full text states. The plain PubMed
   * tools cannot reach such an answer by construction, so the report separates these queries
   * (`accuracy_beyond_pubmed`) from the ones PubMed can answer (`accuracy_in_pubmed`).
   */
  beyondPubmed?: boolean;
  /** Clinical field of a held-out `lookup` query (its sampling stratum). */
  specialty?: string;
}

/**
 * Outcome of a run, decided at scoring time.
 *
 * Scored (they enter every mean; see `isScored` in lib/status.ts):
 *  - `ok` — answered and scored.
 *  - `no-answer` — the agent loop ended without a final answer: empty text, still
 *    calling tools at the step limit, or cut off by the output length limit.
 *    The system under test failed the query, so its accuracy is 0.
 *  - `timeout` — the run exceeded the wall-clock budget. Accuracy 0, same reason.
 *
 * Not scored (missing data: the cell has to be run or scored again):
 *  - `provider-error` — the model call threw (quota, authentication, server error).
 *  - `invalid` — the provider silently dropped part of the conversation
 *    (`RunRecord.contextTruncated`), so the answer is not a response to the question.
 *  - `scoring-error` — the response exists but could not be scored (e.g. PubMed
 *    was unreachable while verifying citations). Re-run `--rescore` later.
 */
export type RunStatus = "ok" | "no-answer" | "timeout" | "provider-error" | "invalid" | "scoring-error";

/** Where a row's accuracy number came from. */
export type AccuracySource =
  /** Deterministic `values` key — fully automated ground truth. */
  | "deterministic"
  /** Fabricated-study query — accuracy mirrors the rejection outcome. */
  | "reject"
  /** Real-study control — accuracy mirrors the acceptance outcome. */
  | "accept"
  /** Rubric query graded by one or more humans via overrides. */
  | "human"
  /** Rubric query nobody has graded: accuracy is unscored (NaN). */
  | "ungraded"
  /** The run produced no answer (`no-answer`, `timeout`): accuracy is 0 by rule. */
  | "failed";

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
  /** The query's split when it ran. Absent on records from before the split existed (all `dev`). */
  split?: Split;
  /** The query's `retrievalOnly` flag when it ran. Absent on older records. */
  retrievalOnly?: boolean;
  /** The query's `beyondPubmed` flag when it ran. Absent on older records and when false. */
  beyondPubmed?: boolean;
  condition: ConditionId;
  /** Model label from config (e.g. `deepseek-v4.1-flash`), not the raw provider id. */
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
   * without part of the prompt. Such runs are `invalid`.
   */
  contextTruncated?: boolean;
  startedAt: string;
  finishedAt: string;
  /** Set when the provider call threw (or timed out: "timeout after 300s"). */
  error?: string;
}

/** One fully-scored run — becomes one row of `scores.csv`. */
export interface ScoreRow {
  query_id: string;
  category: Category;
  split: Split;
  /** The query's answer-key kind, so a row says by itself whether it has ground truth. */
  key_kind: AnswerKey["kind"];
  /** The query's `retrievalOnly` flag. */
  retrieval_only: boolean;
  /** The query's `beyondPubmed` flag: the answer is in no PubMed abstract. */
  beyond_pubmed: boolean;
  condition: ConditionId;
  model: string;
  run: number;
  status: RunStatus;
  /** 0–10. NaN (an empty CSV cell) when unscored: an ungraded rubric answer, or a run that is missing data. */
  accuracy: number;
  accuracy_source: AccuracySource;
  /** Distinct human graders behind a `human` accuracy; absent otherwise. */
  accuracy_graders?: number;
  /**
   * `reject` and `accept` queries only: 1 when the premise was handled correctly
   * (a fabricated study rejected, a real one not rejected), else 0. NaN for every other query.
   */
  bullshit_score: number;
  /**
   * Mean 0–5 design tier of the valid, rated citations. A description of what
   * was cited, not a score: it says nothing about whether the answer is right.
   */
  evidence_quality: number;
  speed_s: number;
  input_tokens: number;
  output_tokens: number;
  total_tokens: number;
  tool_calls: number;
  tools_used: string; // comma-joined
  pmids_cited: number;
  /** Cited records that exist and are on the query's topic. */
  pmids_valid: number;
  /** Cited records that don't exist, plus those that exist but are about something else (`pmids_off_topic`). */
  pmids_fabricated: number;
  /** The part of `pmids_fabricated` that resolved to a record mentioning none of the query's topics. */
  pmids_off_topic: number;
  /** Non-PubMed identifiers cited (DOIs that don't map to a PMID, preprint ids). Counted, not graded. */
  other_citations: number;
  /** Valid citations with a claim next to them that the attribution check could test (absent on rows scored before scorer v5). */
  citations_checked?: number;
  /** Of those, citations whose surrounding claim contradicts the record (wrong year/author/design/numbers). */
  citations_misattributed?: number;
}

/** Per-dimension breakdown embedded in raw JSON via `_scoring`. */
export interface AccuracyDetail {
  /** NaN (null in JSON) when unscored. */
  score: number;
  kind: AnswerKey["kind"];
  /** Only for values: the parsed final ANSWER line (absent when none was found). */
  answerLine?: string;
  /** Only for values: which expected `field: value` pairs matched / didn't. */
  hits?: string[];
  missed?: string[];
}

export interface EvidenceDetail {
  score: number; // 0–5 mean design tier of the valid, rated citations (descriptive)
  /**
   * Every cited record. `valid` is false for one that doesn't exist and for one
   * that exists but is off the query's topic (`offTopic`, which keeps its title).
   * Regional records (Europe PMC non-PubMed, ChinaXiv) carry `database`.
   * `designTier` is null for a record without design metadata (scorer v7+; older runs stored `evidenceScore`).
   */
  pmids: {
    pmid: string;
    valid: boolean;
    offTopic?: true;
    designTier?: number | null;
    studyType?: string;
    title?: string;
    database?: string;
  }[];
  /** Non-PubMed identifiers found in the answer (counted, not graded). */
  other?: { id: string; kind: "doi" | "europepmc" | "arxiv-like" | "url" }[];
  /** PMIDs that appeared in the answer but were excluded because the prompt itself contains them. */
  echoedFromPrompt?: string[];
}

export interface BullshitDetail {
  /** `reject`/`accept` queries: 1 or 0. NaN (null in JSON) for other queries. */
  score: number;
  /** Whether the answer says the study itself can't be found or doesn't exist. */
  rejected: boolean;
  /** Cited ids that don't exist or are off-topic. */
  fabricatedPmids: string[];
  /** The off-topic part of `fabricatedPmids` (scorer v8+). */
  offTopicPmids?: string[];
}

/** One way a citation's surrounding claim contradicts the cited record. */
export interface AttributionIssue {
  /** The cited id (PMID, `CBA:…`, `chinaxiv-…`). */
  id: string;
  /** `topic` only appears in breakdowns from scorer v5–v7; since v8 an off-topic citation is a fabricated one. */
  check: "topic" | "year" | "author" | "design" | "numbers";
  /** What the answer said next to the citation. */
  claimed: string;
  /** What the record says. */
  actual: string;
}

/** Deterministic citation-attribution audit (lib/scoring/attribution.ts). */
export interface AttributionDetail {
  /** Valid citations with at least one applicable check. */
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
