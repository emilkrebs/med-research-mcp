/**
 * Turn one raw `RunRecord` into a fully-scored `ScoreRow`.
 *
 * Order: classify how the run ended → verify citations (existence and topic) →
 * attribution audit (do the claims next to each valid citation match it?) →
 * premise score (fabricated-study and real-study-control queries) → accuracy.
 * There is no composite: each of these is reported on its own.
 *
 * Accuracy is ground truth or nothing: a `values` key is matched field by
 * field, a `reject`/`accept` key mirrors the premise score, and a `rubric`
 * answer stays unscored (NaN) until a human grades it. A run that produced no
 * answer (`no-answer`, `timeout`) scores 0; a run that is missing data
 * (`provider-error`, `invalid`, `scoring-error`) has no scores at all.
 *
 * `scoreRun` never throws: a failed or missing run short-circuits (PubMed is
 * not touched) and a verification failure becomes a `scoring-error` row.
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
import { hasRejectionLanguage, premiseScore } from "./bullshit.js";
import { scoreAccuracy } from "./accuracy.js";
import { isFailure, isScored, normalizeStatus, runOutcome } from "../status.js";
import { queryById } from "../queries.js";

/**
 * Bump when scoring logic changes in a way that alters scores (v1 = substring
 * `values` matcher and PMID-only extraction; v2 = ANSWER-line parser, DOI/PMCID
 * resolution, prompt-echo exclusion, study-specific rejection patterns; v3 =
 * passive-voice rejections, markdown-tolerant PMID anchors, `contextTruncated` runs score as `truncated`;
 * v5 = attribution audit, Europe PMC / ChinaXiv citations looked up and graded;
 * v6 = a DOI, decimal or year after a PMID anchor is no longer read as a short PMID;
 * v7 = evidence quality is the mean design tier from NLM metadata; unrated citations are left out;
 * v8 = no composite and no rubric proxy (ungraded rubric answers are unscored); a cited record that is
 * off the query's topic is fabricated and leaves the attribution audit; runs without an answer score 0
 * (`no-answer`, `timeout`) instead of dropping out, missing runs are `provider-error`/`invalid`;
 * `accept` keys; the premise score is set on reject/accept queries only).
 */
export const SCORER_VERSION = 8;

/** First scorer version without the rubric citation proxy. */
const FIRST_VERSION_WITHOUT_PROXY = 8;

export interface ScoreResult {
  row: ScoreRow;
  breakdown: ScoreBreakdown;
}

const round2 = (x: number): number => Math.round(x * 100) / 100;

/** A stored score: JSON turns NaN ("unscored") into null, so null reads back as NaN; a missing field (older breakdowns) as 0. */
const scored = (x: number | null | undefined): number => (x === null ? Number.NaN : (x ?? 0));

type KeyKind = AnswerKey["kind"];

const isPremiseKind = (kind: KeyKind): kind is "reject" | "accept" => kind === "reject" || kind === "accept";

/** The answer-key kind a breakdown was scored with ("evidence-score" is scorer v1's name for a values key). */
function kindOf(raw: unknown): KeyKind {
  return raw === "rubric" || raw === "reject" || raw === "accept" ? raw : "values";
}

/** Map an answer-key kind to where its accuracy number comes from (overrides flip `ungraded` → `human` later). */
function sourceForKind(kind: KeyKind): AccuracySource {
  switch (kind) {
    case "reject":
      return "reject";
    case "accept":
      return "accept";
    case "rubric":
      return "ungraded";
    case "values":
      return "deterministic";
  }
}

/** The breakdown of a run that was not scored from its text: a failure (zeros) or missing data (unscored). */
function emptyBreakdown(status: RunStatus, query: BenchmarkQuery, scoringError?: string): ScoreBreakdown {
  const kind = query.answerKey.kind;
  const failed = isFailure(status);
  return {
    status,
    accuracy: { score: failed ? 0 : Number.NaN, kind },
    evidenceQuality: { score: Number.NaN, pmids: [] },
    bullshit: { score: failed && isPremiseKind(kind) ? 0 : Number.NaN, rejected: false, fabricatedPmids: [] },
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
    const breakdown = emptyBreakdown("scoring-error", query, err instanceof Error ? err.message : String(err));
    return { row: rowFromBreakdown(run, breakdown), breakdown };
  }
}

async function scoreRunUnsafe(run: RunRecord, query: BenchmarkQuery, verifier: Verifier): Promise<ScoreResult> {
  // Failed and missing runs skip PubMed entirely.
  const outcome = runOutcome(run);
  if (outcome) {
    const breakdown = emptyBreakdown(outcome, query);
    return { row: rowFromBreakdown(run, breakdown), breakdown };
  }

  const text = String(run.text);
  let audit: CitationAudit;
  try {
    audit = await auditCitations(text, run.prompt || query.prompt, verifier, query.topics);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const breakdown = emptyBreakdown("scoring-error", query, message);
    return { row: rowFromBreakdown(run, breakdown), breakdown };
  }

  const key = query.answerKey;
  const kind = key.kind;
  const premise = key.kind === "reject" || key.kind === "accept" ? premiseScore(key, text, audit) : Number.NaN;
  const acc = isPremiseKind(kind) ? { score: premise * 10, detail: { score: premise * 10, kind } } : scoreAccuracy(query, text);

  // Claims next to the valid citations; off-topic ones are already counted as fabricated.
  const attribution = checkAttribution(text, audit.valid, [...audit.cited, ...audit.echoedFromPrompt]);
  const offTopic = new Map(audit.offTopic.map((f) => [f.pmid, f] as const));

  const breakdown: ScoreBreakdown = {
    status: "ok",
    accuracy: { ...acc.detail, score: round2(acc.score) },
    evidenceQuality: {
      score: round2(audit.evidenceQuality),
      pmids: audit.cited.map((pmid) => {
        const v = audit.valid.find((f) => f.pmid === pmid) ?? offTopic.get(pmid);
        if (!v) return { pmid, valid: false };
        const facts = { designTier: v.designTier, studyType: v.studyType, title: v.title, ...(v.database ? { database: v.database } : {}) };
        return offTopic.has(pmid) ? { pmid, valid: false, offTopic: true as const, ...facts } : { pmid, valid: true, ...facts };
      }),
      other: audit.other,
      echoedFromPrompt: audit.echoedFromPrompt,
    },
    bullshit: {
      score: premise,
      rejected: isPremiseKind(kind) && hasRejectionLanguage(text),
      fabricatedPmids: audit.fabricated,
      offTopicPmids: audit.offTopic.map((f) => f.pmid),
    },
    attribution,
    answerKeyVersion: query.answerKeyVersion,
    scorerVersion: SCORER_VERSION,
  };
  return { row: rowFromBreakdown(run, breakdown), breakdown };
}

/** The status of a stored breakdown; ones from before scorer v8 (no status, or `truncated`) are read off the record. */
function statusOf(record: RunRecord, breakdown: ScoreBreakdown): RunStatus {
  const stored = breakdown.status as string | undefined;
  if (stored === undefined || stored === "truncated") return runOutcome(record) ?? (stored === "truncated" ? "no-answer" : "ok");
  return normalizeStatus(stored);
}

/**
 * Rebuild a `ScoreRow` from an embedded `_scoring` breakdown with no network.
 * Tolerates older breakdowns: no `status` (read off the record), no
 * `scorerVersion`/`other`/`echoedFromPrompt`, `accuracy.kind` possibly
 * `"evidence-score"` (a values key), and a rubric accuracy that is the old
 * citation proxy (read as unscored).
 */
export function rowFromBreakdown(record: RunRecord, breakdown: ScoreBreakdown): ScoreRow {
  const status = statusOf(record, breakdown);
  const failed = isFailure(status);
  const kind = kindOf(breakdown.accuracy?.kind);
  const query = queryById(record.queryId);
  const pmids = breakdown.evidenceQuality?.pmids ?? [];
  const isProxy = kind === "rubric" && (breakdown.scorerVersion ?? 1) < FIRST_VERSION_WITHOUT_PROXY;

  let accuracy = Number.NaN;
  if (failed) accuracy = 0;
  else if (status === "ok" && !isProxy) accuracy = round2(scored(breakdown.accuracy?.score));

  let premise = Number.NaN;
  if (isPremiseKind(kind)) {
    if (failed) premise = 0;
    else if (status === "ok") premise = round2(scored(breakdown.bullshit?.score));
  }

  return {
    query_id: record.queryId,
    category: record.category,
    split: record.split ?? query?.split ?? "dev",
    key_kind: kind,
    retrieval_only: record.retrievalOnly ?? query?.retrievalOnly ?? false,
    condition: record.condition,
    model: record.model,
    run: record.run,
    status,
    accuracy,
    accuracy_source: failed ? "failed" : sourceForKind(kind),
    bullshit_score: premise,
    evidence_quality: status === "ok" ? round2(scored(breakdown.evidenceQuality?.score)) : Number.NaN,
    speed_s: round2(record.speedS),
    input_tokens: record.usage?.inputTokens ?? 0,
    output_tokens: record.usage?.outputTokens ?? 0,
    total_tokens: record.usage?.totalTokens ?? 0,
    tool_calls: record.toolCallCount,
    tools_used: (record.toolsUsed ?? []).join(","),
    pmids_cited: pmids.length,
    pmids_valid: pmids.filter((p) => p.valid).length,
    pmids_fabricated: pmids.filter((p) => !p.valid).length,
    pmids_off_topic: pmids.filter((p) => p.offTopic).length,
    other_citations: breakdown.evidenceQuality?.other?.length ?? 0,
    ...(breakdown.attribution && isScored(status)
      ? { citations_checked: breakdown.attribution.checked, citations_misattributed: breakdown.attribution.misattributed }
      : {}),
  };
}
