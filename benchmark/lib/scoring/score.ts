/**
 * Turn one raw `RunRecord` into a fully-scored `ScoreRow`.
 *
 * Order: verify citations (existence + evidence grade) → bullshit sub-score →
 * accuracy (answer-key or judge) → composite. For bullshit queries, accuracy is
 * the rejection outcome on the 0–10 scale so the category still contributes to
 * the accuracy column, while the 25% bullshit weight does the heavy lifting.
 */

import type { BenchmarkQuery, RunRecord, ScoreRow } from "../types.js";
import { auditCitations, type Verifier } from "./verify.js";
import { bullshitScore } from "./bullshit.js";
import { scoreAccuracy } from "./accuracy.js";
import { composite } from "./composite.js";

export async function scoreRun(run: RunRecord, query: BenchmarkQuery, verifier: Verifier): Promise<ScoreRow> {
  const audit = await auditCitations(run.text, verifier);
  const isBullshit = query.category === "bullshit";
  const text = String(run.text ?? "");
  const bs =
    isBullshit && text.trim().length === 0
      ? audit.fabricated.length === 0
        ? 1
        : 0
      : bullshitScore(text, audit, isBullshit);

  const accuracy = isBullshit ? bs * 10 : await scoreAccuracy(query, run.text, audit, verifier);

  // For fabricated-study probes, benchmark intent is binary rejection behavior.
  // Using the global composite here can over-penalize tool-using conditions for
  // speed/token overhead despite identical rejection correctness.
  const comp = isBullshit
    ? Math.round(bs * 10 * 100) / 100
    : composite({
        accuracy,
        evidenceQuality: audit.evidenceQuality,
        bullshitScore: bs,
        speedS: run.speedS,
        totalTokens: run.usage.totalTokens,
      });

  return {
    query_id: run.queryId,
    category: run.category,
    condition: run.condition,
    model: run.model,
    run: run.run,
    accuracy: Math.round(accuracy * 100) / 100,
    evidence_quality: Math.round(audit.evidenceQuality * 100) / 100,
    bullshit_score: Math.round(bs * 100) / 100,
    speed_s: Math.round(run.speedS * 100) / 100,
    input_tokens: run.usage.inputTokens,
    output_tokens: run.usage.outputTokens,
    tool_calls: run.toolCallCount,
    tools_used: run.toolsUsed.join(","),
    pmids_cited: audit.cited.length,
    pmids_valid: audit.valid.length,
    pmids_fabricated: audit.fabricated.length,
    composite: comp,
  };
}
