/**
 * Accuracy scoring (0–10), dispatched on the query's answer-key kind:
 *   evidence-score → recompute ground truth with the library grader, compare to
 *                    the score/study-type the model stated (fully automated).
 *   values         → fraction of required strings present, fuzzy-matched.
 *   rubric         → LLM-as-judge, given the real abstracts of every cited PMID
 *                    so it can verify claims against sources.
 *   reject         → handled by the bullshit scorer; accuracy mirrors it in score.ts.
 */

import { generateText } from "ai";
import { JUDGE } from "../config.js";
import { resolveModel } from "../providers.js";
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

// ─── LLM judge ──────────────────────────────────────────────────

let judgeModelPromise: ReturnType<typeof resolveModel> | undefined;
function judgeModel() {
  if (!judgeModelPromise) judgeModelPromise = resolveModel(JUDGE);
  return judgeModelPromise;
}

const JUDGE_SYSTEM =
  "You are a meticulous scientific-evidence grader. You are given a question, a candidate answer, " +
  "a grading rubric, and the verified abstracts of every PubMed article the answer cited. " +
  "Score the answer from 0 to 10 by the rubric. Treat any claim not supported by a cited/verified " +
  "abstract as unsupported. Reply with ONLY a JSON object: {\"score\": <0-10 number>, \"reasoning\": <short string>}.";

function sourcesBlock(audit: CitationAudit): string {
  if (audit.valid.length === 0 && audit.fabricated.length === 0) return "No PMIDs were cited.";
  const lines: string[] = [];
  for (const f of audit.valid) {
    const abs = f.abstract.length > 900 ? `${f.abstract.slice(0, 900)}…` : f.abstract;
    lines.push(`PMID ${f.pmid} (VERIFIED, evidenceScore ${f.evidenceScore}/5, ${f.studyType}): ${f.title}\n${abs || "(no abstract)"}`);
  }
  for (const pmid of audit.fabricated) {
    lines.push(`PMID ${pmid}: DOES NOT EXIST in PubMed — any claim attributed to it is fabricated.`);
  }
  return lines.join("\n\n");
}

function parseJudgeScore(raw: string): number {
  const match = raw.match(/\{[\s\S]*\}/);
  if (match) {
    try {
      const obj = JSON.parse(match[0]) as { score?: unknown };
      const n = Number(obj.score);
      if (Number.isFinite(n)) return Math.max(0, Math.min(10, n));
    } catch {
      /* fall through to regex */
    }
  }
  const loose = raw.match(/(\d(?:\.\d)?)\s*(?:\/\s*10)?/);
  return loose ? Math.max(0, Math.min(10, Number(loose[1]))) : 0;
}

/** In-process cache so identical (query + answer) pairs are judged only once. */
const judgeCache = new Map<string, Promise<number>>();

async function scoreRubric(rubric: string, query: BenchmarkQuery, answer: string, audit: CitationAudit): Promise<number> {
  if (!answer.trim()) return 0;
  // Key on query id + full answer text — audit is deterministic from the answer.
  const cacheKey = `${query.id}\0${answer}`;
  const cached = judgeCache.get(cacheKey);
  if (cached !== undefined) return cached;
  const promise = (async () => {
    const prompt =
      `QUESTION:\n${query.prompt}\n\n` +
      `RUBRIC:\n${rubric}\n\n` +
      `CANDIDATE ANSWER:\n${answer}\n\n` +
      `VERIFIED SOURCES:\n${sourcesBlock(audit)}`;
    const result = await generateText({
      model: await judgeModel(),
      system: JUDGE_SYSTEM,
      prompt,
      temperature: 0,
    });
    return parseJudgeScore(result.text);
  })();
  judgeCache.set(cacheKey, promise);
  return promise;
}

/** Compute the 0–10 accuracy for a (non-bullshit) run. Bullshit queries score in score.ts. */
export async function scoreAccuracy(
  query: BenchmarkQuery,
  answer: string,
  audit: CitationAudit,
  verifier: Verifier,
): Promise<number> {
  const key = query.answerKey;
  switch (key.kind) {
    case "evidence-score":
      return scoreEvidenceScore(key.pmid, answer, verifier);
    case "values":
      return scoreValues(key.expected, answer);
    case "rubric":
      return scoreRubric(key.rubric, query, answer, audit);
    case "reject":
      // Scored via the bullshit path; see score.ts.
      return 0;
  }
}
