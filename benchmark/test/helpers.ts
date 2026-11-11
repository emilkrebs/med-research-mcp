/** Shared fixtures for the offline tests. */

import type { RunRecord, ScoreRow } from "../lib/types.js";

/** A scored row of a keyed development query, answered and fully right unless overridden. */
export function scoreRow(over: Partial<ScoreRow> = {}): ScoreRow {
  return {
    query_id: "q1",
    category: "factual",
    split: "dev",
    key_kind: "values",
    retrieval_only: false,
    beyond_pubmed: false,
    condition: "mcp",
    model: "m1",
    run: 1,
    status: "ok",
    accuracy: 10,
    accuracy_source: "deterministic",
    bullshit_score: Number.NaN,
    evidence_quality: 3,
    speed_s: 10,
    input_tokens: 100,
    output_tokens: 50,
    total_tokens: 150,
    tool_calls: 1,
    tools_used: "",
    pmids_cited: 2,
    pmids_valid: 2,
    pmids_fabricated: 0,
    pmids_off_topic: 0,
    other_citations: 0,
    ...over,
  };
}

/** A raw run record that answered `factual-04` correctly unless overridden. */
export function runRecord(over: Partial<RunRecord> = {}): RunRecord {
  return {
    queryId: "factual-04",
    category: "factual",
    condition: "mcp",
    model: "m",
    run: 1,
    systemPrompt: "",
    prompt: "Identify the BMJ meta-analysis. Finish with ANSWER — PMID: <number>",
    text: "ANSWER — PMID: 28202713",
    toolCalls: [],
    toolCallCount: 2,
    toolsUsed: ["search", "fetch"],
    usage: { inputTokens: 100, outputTokens: 50, totalTokens: 150 },
    speedS: 5,
    startedAt: "",
    finishedAt: "",
    ...over,
  };
}
