/**
 * Turn one raw `RunRecord` into a fully-scored `ScoreRow`.
 *
 * Order: classify the run's status → verify citations (existence + evidence
 * grade) → attribution audit (do the claims next to each citation match it?) →
 * bullshit sub-score → accuracy (deterministic answer-key, or a
 * provisional citation-quality proxy for rubric queries until a human grade is
 * applied via overrides) → composite. For bullshit queries, accuracy is the
 * rejection outcome on the 0–10 scale so the category still contributes to the
 * accuracy column, while the composite rule lives in `compositeForCategory`.
 *
 * `scoreRun` never throws: a provider error or empty answer short-circuits
 * (PubMed is not touched) and a verification failure becomes a `scoring-error`
 * row. Only `ok` rows enter downstream aggregation.
 *
 * Also returns a `ScoreBreakdown` suitable for embedding in the raw JSON so the
 * rescorer can re-derive the row without re-fetching PubMed (`rowFromBreakdown`).
 */

import type {
  AccuracySource,
  AnswerKey,
  BenchmarkQuery,
  RunRecord,
  RunStatus,
  ScoreBreakdown,
  ScoreRow,
} from "../types.js";
import { auditCitations, type CitationAudit, type Verifier } from "./verify.js";
import { checkAttribution } from "./attribution.js";
import { bullshitScore, hasRejectionLanguage } from "./bullshit.js";
import { scoreAccuracy } from "./accuracy.js";
import { compositeForCategory } from "./composite.js";

/**
 * Bump when scoring logic changes in a way that alters scores (v1 = substring
 * `values` matcher and PMID-only extraction; v2 = ANSWER-line parser, DOI/PMCID
 * resolution, prompt-echo exclusion, study-specific rejection patterns; v3 =
 * passive-voice rejections, markdown-tolerant PMID anchors, `contextTruncated` runs score as `truncated`;
 * v5 = attribution audit, Europe PMC / ChinaXiv citations looked up and graded).
 */
export const SCORER_VERSION = 5;

export interface ScoreResult {
  row: ScoreRow;
  breakdown: ScoreBreakdown;
}

const round2 = (x: number): number => Math.round(x * 100) / 100;

/** Map an answer-key kind to where its accuracy number comes from (overrides flip `proxy` → `human` later). */
function sourceForKind(kind: string): AccuracySource {
  switch (kind) {
    case "reject":
      return "reject";
    case "rubric":
      return "proxy";
    default:
      // "values" and the legacy "evidence-score" are both automated ground truth.
      return "deterministic";
  }
}

/** Status decided before any scoring: errors, empty answers and provider-truncated contexts skip PubMed entirely. */
function preStatus(run: RunRecord): RunStatus | undefined {
  if (run.error) return "provider-error";
  if (run.contextTruncated || String(run.text ?? "").trim() === "") return "truncated";
  // The loop ended mid-work (still calling tools, or cut off by a length limit): whatever text
  // exists is a progress note ("let me search more"), not an answer.
  if (run.finishReason === "tool-calls" || run.finishReason === "length") return "truncated";
  return undefined;
}

/** A breakdown with every numeric field zeroed, for runs that are not (or could not be) scored. */
function emptyBreakdown(status: RunStatus, kind: AnswerKey["kind"], query: BenchmarkQuery, scoringError?: string): ScoreBreakdown {
  return {
    status,
    accuracy: { score: 0, kind },
    evidenceQuality: { score: 0, pmids: [] },
    bullshit: { score: 0, rejected: false, fabricatedPmids: [] },
    composite: 0,
    answerKeyVersion: query.answerKeyVersion,
    scorerVersion: SCORER_VERSION,
    ...(scoringError !== undefined ? { scoringError } : {}),
  };
}

export async function scoreRun(run: RunRecord, query: BenchmarkQuery, verifier: Verifier): Promise<ScoreResult> {
  try {
    return await scoreRunUnsafe(run, query, verifier);
  } catch (err) {
    // Last line of defense: scoring must never take down the whole benchmark run.
    const breakdown = emptyBreakdown("scoring-error", query.answerKey.kind, query, err instanceof Error ? err.message : String(err));
    return { row: rowFromBreakdown(run, breakdown), breakdown };
  }
}

async function scoreRunUnsafe(run: RunRecord, query: BenchmarkQuery, verifier: Verifier): Promise<ScoreResult> {
  const pre = preStatus(run);
  if (pre) {
    const breakdown = emptyBreakdown(pre, query.answerKey.kind, query);
    return { row: rowFromBreakdown(run, breakdown), breakdown };
  }

  const text = String(run.text);
  let audit: CitationAudit;
  try {
    audit = await auditCitations(text, run.prompt || query.prompt, verifier);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const breakdown = emptyBreakdown("scoring-error", query.answerKey.kind, query, message);
    return { row: rowFromBreakdown(run, breakdown), breakdown };
  }

  const isBullshit = query.category === "bullshit";
  const rejected = isBullshit && hasRejectionLanguage(text);
  const bs = bullshitScore(text, audit, isBullshit);
  const acc = isBullshit
    ? { score: bs * 10, detail: { score: round2(bs * 10), kind: query.answerKey.kind } }
    : scoreAccuracy(query, text, audit);

  // Reported next to the composite, not inside it (see lib/scoring/attribution.ts).
  const attribution = checkAttribution(text, audit.valid, [...audit.cited, ...audit.echoedFromPrompt], query.topics);

  const composite = compositeForCategory(run.category, {
    accuracy: acc.score,
    evidenceQuality: audit.evidenceQuality,
    bullshitScore: bs,
    speedS: run.speedS,
    totalTokens: run.usage.totalTokens,
  });

  const breakdown: ScoreBreakdown = {
    status: "ok",
    accuracy: { ...acc.detail, score: round2(acc.score) },
    evidenceQuality: {
      score: round2(audit.evidenceQuality),
      pmids: audit.cited.map((pmid) => {
        const v = audit.valid.find((f) => f.pmid === pmid);
        return v
          ? { pmid, valid: true, evidenceScore: v.evidenceScore, studyType: v.studyType, title: v.title, ...(v.database ? { database: v.database } : {}) }
          : { pmid, valid: false };
      }),
      other: audit.other,
      echoedFromPrompt: audit.echoedFromPrompt,
    },
    bullshit: { score: round2(bs), rejected, fabricatedPmids: audit.fabricated },
    attribution,
    composite,
    answerKeyVersion: query.answerKeyVersion,
    scorerVersion: SCORER_VERSION,
  };
  return { row: rowFromBreakdown(run, breakdown), breakdown };
}

/**
 * Rebuild a `ScoreRow` from an embedded `_scoring` breakdown with no network.
 * Tolerates scorer-v1 breakdowns: no `status` (derived from `record.error`), no
 * `scorerVersion`/`other`/`echoedFromPrompt`, and `accuracy.kind` possibly
 * `"evidence-score"` (treated as deterministic).
 */
export function rowFromBreakdown(record: RunRecord, breakdown: ScoreBreakdown): ScoreRow {
  const status: RunStatus = breakdown.status ?? (record.error ? "provider-error" : "ok");
  const pmids = breakdown.evidenceQuality?.pmids ?? [];
  const fabricated = breakdown.bullshit?.fabricatedPmids?.length ?? pmids.filter((p) => !p.valid).length;
  return {
    query_id: record.queryId,
    category: record.category,
    condition: record.condition,
    model: record.model,
    run: record.run,
    status,
    accuracy: round2(breakdown.accuracy?.score ?? 0),
    accuracy_source: sourceForKind(String(breakdown.accuracy?.kind)),
    evidence_quality: round2(breakdown.evidenceQuality?.score ?? 0),
    bullshit_score: round2(breakdown.bullshit?.score ?? 0),
    speed_s: round2(record.speedS),
    input_tokens: record.usage?.inputTokens ?? 0,
    output_tokens: record.usage?.outputTokens ?? 0,
    total_tokens: record.usage?.totalTokens ?? 0,
    tool_calls: record.toolCallCount,
    tools_used: (record.toolsUsed ?? []).join(","),
    pmids_cited: pmids.length,
    pmids_valid: pmids.filter((p) => p.valid).length,
    pmids_fabricated: fabricated,
    other_citations: breakdown.evidenceQuality?.other?.length ?? 0,
    ...(breakdown.attribution
      ? { citations_checked: breakdown.attribution.checked, citations_misattributed: breakdown.attribution.misattributed }
      : {}),
    composite: round2(breakdown.composite ?? 0),
  };
}
