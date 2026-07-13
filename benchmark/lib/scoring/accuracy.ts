/**
 * Accuracy scoring (0–10), dispatched on the query's answer-key kind:
 *   evidence-score → recompute ground truth with the library grader, compare to
 *                    the score/study-type the model stated (fully automated).
 *   values         → fraction of required strings present, fuzzy-matched.
 *   rubric         → citation-quality proxy: evidenceQuality (0–5) × 2, clamped
 *                    to 0 when citations were expected but none are valid.
 *   reject         → handled by the bullshit scorer; accuracy mirrors it in score.ts.
 */

import type { BenchmarkQuery } from "../types.js";
import type { StudyType } from "../core.js";
import type { CitationAudit, Verifier } from "./verify.js";

const TYPE_PATTERNS: Record<StudyType, RegExp> = {
  "meta-analysis": /meta[-\s]?analys|systematic review|pooled analysis/i,
  "randomized-controlled-trial": /randomi[sz]ed|\brct\b|double[-\s]blind|placebo[-\s]control/i,
  cohort: /\bcohort\b|longitudinal|prospective/i,
  review: /\breview\b/i,
  "case-control": /case[-\s]control/i,
  "case-report": /case report|case study|case presentation/i,
  "animal-study": /\banimal\b|murine|rodent|\bmice\b|\bmouse\b|\brats?\b/i,
  unknown: /(?!)/, // never matches
};

/** Pull the score the model presents (e.g. "4/5", "score of 3.5", "4 out of 5"). */
function extractStatedScore(text: string): number | undefined {
  const outOf = text.match(/(\d(?:\.\d)?)\s*(?:\/|out\s+of)\s*5\b/i);
  if (outOf) return Number(outOf[1]);
  const labelled = text.match(/score[^\d]{0,25}(\d(?:\.\d)?)/i);
  if (labelled) return Number(labelled[1]);
  return undefined;
}

/** Score an evidence-score query against live-computed ground truth. */
async function scoreEvidenceScore(pmid: string, text: string, verifier: Verifier): Promise<number> {
  const truth = await verifier.verifyOne(pmid);
  if (!truth.exists) return 0; // unresolved key PMID — data problem, not the model's fault, but unscoreable

  const typeKnown = truth.studyType !== "unknown";
  const typeWeight = typeKnown ? 5 : 0;
  const scoreWeight = 10 - typeWeight;

  const typePoints = typeKnown && TYPE_PATTERNS[truth.studyType].test(text) ? typeWeight : 0;

  const stated = extractStatedScore(text);
  let scorePoints = 0;
  if (stated !== undefined) {
    const diff = Math.abs(stated - truth.evidenceScore);
    scorePoints = Math.max(0, 1 - diff / 5) * scoreWeight;
  }
  return Math.round((typePoints + scorePoints) * 100) / 100;
}

/** Score a values query: fraction of expected strings present, fuzzy on whitespace/case. */
function scoreValues(expected: string[], text: string): number {
  if (expected.length === 0) return 0;
  const hay = text.toLowerCase().replace(/\s+/g, " ");
  const hits = expected.filter((e) => hay.includes(e.toLowerCase().replace(/\s+/g, " "))).length;
  return Math.round((hits / expected.length) * 10 * 100) / 100;
}

/**
 * Rubric auto-grade: citation-quality proxy.
 * Scales evidenceQuality (0–5 mean over valid PMIDs) to 0–10.
 * Returns 0 when citations were expected (`expectPmids`) but none resolved.
 */
function scoreRubric(expectPmids: boolean | undefined, audit: CitationAudit): number {
  if (expectPmids && audit.valid.length === 0) return 0;
  return Math.round(audit.evidenceQuality * 2 * 100) / 100;
}

/** Compute the 0–10 accuracy for a (non-bullshit) run. Bullshit queries score in score.ts. */
export async function scoreAccuracy(
  query: BenchmarkQuery,
  answer: string,
  audit: CitationAudit,
  verifier: Verifier, // eslint-disable-line @typescript-eslint/no-unused-vars
): Promise<number> {
  const key = query.answerKey;
  switch (key.kind) {
    case "evidence-score":
      return scoreEvidenceScore(key.pmid, answer, verifier);
    case "values":
      return scoreValues(key.expected, answer);
    case "rubric":
      return scoreRubric(key.expectPmids, audit);
    case "reject":
      // Scored via the bullshit path; see score.ts.
      return 0;
  }
}
