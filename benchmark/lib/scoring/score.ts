/**
 * Turn one raw `RunRecord` into a fully-scored `ScoreRow`.
 *
 * Order: verify citations (existence + evidence grade) → bullshit sub-score →
 * accuracy (deterministic answer-key, or a provisional citation-quality proxy
 * for rubric queries until a human grade is applied via overrides) → composite.
 * For bullshit queries, accuracy is
 * the rejection outcome on the 0–10 scale so the category still contributes to
 * the accuracy column, while the 25% bullshit weight does the heavy lifting.
 *
 * Also returns a `ScoreBreakdown` suitable for embedding in the raw JSON so the
 * rescorer can re-derive the row without re-fetching PubMed.
 */

import type { BenchmarkQuery, RunRecord, ScoreRow, ScoreBreakdown } from "../types.js";
import { auditCitations, type Verifier } from "./verify.js";
import { bullshitScore, hasRejectionLanguage } from "./bullshit.js";
import { scoreAccuracy } from "./accuracy.js";
import { composite } from "./composite.js";

export interface ScoreResult {
  row: ScoreRow;
  breakdown: ScoreBreakdown;
}

export async function scoreRun(run: RunRecord, query: BenchmarkQuery, verifier: Verifier): Promise<ScoreResult> {
  const audit = await auditCitations(run.text, verifier);
  const isBullshit = query.category === "bullshit";
  const text = String(run.text ?? "");
  // An empty response never counts as a correct rejection: bullshitScore already
  // returns 0 for empty text on a bullshit query (hasRejectionLanguage("") is
  // false), so a provider error/timeout with no text correctly scores 0 rather
  // than being mistaken for a perfect "I can't corroborate this" rejection.
  const bs = bullshitScore(text, audit, isBullshit);

  const accResult = isBullshit
    ? { score: bs * 10, detail: { score: bs * 10, kind: query.answerKey.kind as "reject" } }
    : await scoreAccuracy(query, run.text, audit, verifier);
  const accuracy = accResult.score;

  const comp = isBullshit
    ? Math.round(bs * 10 * 100) / 100
    : composite({
        accuracy,
        evidenceQuality: audit.evidenceQuality,
        bullshitScore: bs,
        speedS: run.speedS,
        totalTokens: run.usage.totalTokens,
      });

  const row: ScoreRow = {
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

  const breakdown: ScoreBreakdown = {
    accuracy: accResult.detail,
    evidenceQuality: {
      score: row.evidence_quality,
      pmids: audit.cited.map((pmid) => {
        const v = audit.valid.find((f) => f.pmid === pmid);
        return v
          ? { pmid, valid: true, evidenceScore: v.evidenceScore, studyType: v.studyType, title: v.title }
          : { pmid, valid: false };
      }),
    },
    bullshit: {
      score: row.bullshit_score,
      rejected: isBullshit && hasRejectionLanguage(text),
      fabricatedPmids: audit.fabricated,
    },
    composite: comp,
    answerKeyVersion: query.answerKeyVersion,
  };

  return { row, breakdown };
}
