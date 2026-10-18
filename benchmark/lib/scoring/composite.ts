/**
 * The composite score (spec §"Composite Score").
 *
 *   composite = 10 · ( 0.40·(accuracy/10)
 *                    + 0.25·(evidence_quality/5)
 *                    + 0.25·bullshit_score
 *                    + 0.05·speed_score
 *                    + 0.05·cost_score )
 *
 * accuracy is 0–10, evidence_quality 0–5, bullshit_score 0–1. speed_score and
 * cost_score are "faster/cheaper is better" terms in [0,1], derived from the
 * wall-clock time and token count against the references in `config.NORMALIZATION`.
 * All five components are put on a common 0–1 footing, weighted, and rescaled to 0–10.
 * Bullshit queries are the exception — see `compositeForCategory`.
 *
 * evidence_quality is NaN when every cited record's design tier is unknown
 * (e.g. only meta-analyses whose pooled designs aren't indexed): there is
 * nothing to score, so the evidence term is dropped and the other weights are
 * rescaled to sum to 1. A NaN accuracy or bullshit score still makes the
 * composite NaN (unscored).
 */

import { WEIGHTS, NORMALIZATION } from "../config.js";
import type { Category } from "../types.js";

const clamp01 = (x: number): number => Math.max(0, Math.min(1, x));

/** 1 = instant, 0 = at/over the speed reference. */
export function speedScore(speedS: number): number {
  return clamp01(1 - speedS / NORMALIZATION.speedRefS);
}

/** 1 = free, 0 = at/over the token reference. */
export function costScore(totalTokens: number): number {
  return clamp01(1 - totalTokens / NORMALIZATION.tokenRef);
}

export interface CompositeInputs {
  accuracy: number; // 0–10
  evidenceQuality: number; // 0–5
  bullshitScore: number; // 0–1
  speedS: number;
  totalTokens: number;
}

export function composite({ accuracy, evidenceQuality, bullshitScore, speedS, totalTokens }: CompositeInputs): number {
  if (!Number.isFinite(accuracy) || !Number.isFinite(bullshitScore)) return Number.NaN;
  const hasEvidence = Number.isFinite(evidenceQuality);
  const weighted =
    WEIGHTS.accuracy * clamp01(accuracy / 10) +
    (hasEvidence ? WEIGHTS.evidence * clamp01(evidenceQuality / 5) : 0) +
    WEIGHTS.bullshit * clamp01(bullshitScore) +
    WEIGHTS.speed * speedScore(speedS) +
    WEIGHTS.cost * costScore(totalTokens);
  const normalized = hasEvidence ? weighted : weighted / (1 - WEIGHTS.evidence);
  return Math.round(normalized * 10 * 100) / 100;
}

/**
 * The composite for a row of a given category — the single place the
 * bullshit-query rule lives. A bullshit query has one correct behavior
 * (refuse to corroborate the fabricated study), so its composite is the
 * rejection outcome on the 0–10 scale; evidence, speed, and cost don't apply.
 * Every other category uses the weighted formula above. Used both at scoring
 * time and when overrides change a component and the composite is recomputed.
 */
export function compositeForCategory(category: Category, inputs: CompositeInputs): number {
  if (category === "bullshit") {
    if (!Number.isFinite(inputs.bullshitScore)) return Number.NaN;
    return Math.round(clamp01(inputs.bullshitScore) * 10 * 100) / 100;
  }
  return composite(inputs);
}
