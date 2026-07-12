/**
 * Keyword / rule-based evidence grading — the fast, free path.
 *
 * Strategy: trust PubMed's own curated PublicationType tags first (NLM indexers
 * assign these, so they're far more reliable than scraping the abstract), then
 * fall back to regex over title + abstract. Known keyword-path weaknesses
 * (protocol papers read as RCTs, "unlike previous trials…" false positives,
 * animal studies with incidental human mentions) are damped via negative
 * patterns and surfaced in `limitations`.
 */

import type { GradedArticle, NcbiArticle, StudyType } from "./types.js";

export const SCORE_BY_TYPE: Record<StudyType, number> = {
  "meta-analysis": 5,
  "randomized-controlled-trial": 4,
  cohort: 3,
  review: 3,
  "case-control": 2,
  "case-report": 1,
  "animal-study": 0,
  unknown: 0,
};

interface Rule {
  studyType: StudyType;
  patterns: RegExp[];
}

/** Ordered by evidence score, highest first — first rule with a hit wins. */
const RULES: Rule[] = [
  {
    studyType: "meta-analysis",
    patterns: [/meta-analys[ie]s/i, /systematic review/i, /pooled analysis/i],
  },
  {
    studyType: "randomized-controlled-trial",
    patterns: [/randomi[sz]ed/i, /double-blind/i, /placebo[- ]control/i, /\bRCT\b/],
  },
  {
    studyType: "cohort",
    patterns: [/cohort/i, /longitudinal/i, /prospective/i, /follow-up/i],
  },
  {
    studyType: "review",
    // "systematic review" is caught above; a plain review lands here.
    patterns: [/\breview\b/i, /literature review/i, /narrative review/i],
  },
  {
    studyType: "case-control",
    patterns: [/case-control/i, /matched control/i],
  },
  {
    studyType: "case-report",
    patterns: [/case report/i, /case study/i, /case presentation/i],
  },
  {
    studyType: "animal-study",
    patterns: [/\bmurine\b/i, /\brodents?\b/i, /animal model/i, /\bmice\b/i, /\bmouse\b/i, /\brats?\b/i],
  },
];

/** NLM PublicationType → our taxonomy. Lowercased keys. */
const PUB_TYPE_MAP: Record<string, StudyType> = {
  "meta-analysis": "meta-analysis",
  "systematic review": "meta-analysis",
  "randomized controlled trial": "randomized-controlled-trial",
  // NLM tags EHR/registry/propensity-matched studies "Observational Study".
  // Without this, the abstract's mention of "randomized" trials it compares
  // against misfires the RCT regex and inflates the score.
  "observational study": "cohort",
  review: "review",
  "case reports": "case-report",
};

const HUMAN_TERMS =
  /\b(humans?|patients?|adults?|men|women|participants?|volunteers?|subjects?|children)\b/i;

/** Phrases that make a keyword hit untrustworthy. */
const NEGATIVE_PATTERNS: { pattern: RegExp; limitation: string }[] = [
  { pattern: /\bstudy protocol\b/i, limitation: "Reads as a study protocol, not a completed trial." },
  { pattern: /\bwe will\b/i, limitation: "Future-tense wording suggests a protocol/plan, not results." },
  { pattern: /\bprotocol for a\b/i, limitation: "Reads as a study protocol, not a completed trial." },
  { pattern: /unlike previous (randomi[sz]ed )?(trials|studies)/i, limitation: "Study-type keyword may be a false positive from comparative phrasing." },
];

const DOSAGE_RE = /\b(\d+(?:\.\d+)?)\s?(mg\/kg|mcg\/kg|g\/day|mg\/day|mg|mcg|µg|ug|g|IU|mL|ml)\b/i;
const POPULATION_RE =
  /\bin\s+((?:\d+\s+)?(?:healthy\s+)?(?:adults?|men|women|volunteers?|participants?|patients?(?:\s+with\s+[a-z][a-z\s-]{2,40})?|older adults|elderly|children|athletes))/i;
const LIMITATION_CUES =
  /([^.]*\b(?:limitation|small sample|underpowered|short duration|no control group|not blinded|preliminary|pilot study|single[- ]center)\b[^.]*\.)/gi;

export interface GradeResult {
  studyType: StudyType;
  evidenceScore: number;
  confidence: number;
  dosage?: string;
  population?: string;
  limitations?: string[];
}

function classifyByPublicationType(publicationTypes: string[]): StudyType | null {
  for (const pt of publicationTypes) {
    const mapped = PUB_TYPE_MAP[pt.trim().toLowerCase()];
    if (mapped) return mapped;
  }
  return null;
}

function countHits(text: string, patterns: RegExp[]): number {
  let hits = 0;
  for (const p of patterns) {
    if (p.test(text)) hits += 1;
  }
  return hits;
}

function classifyByKeywords(text: string): { studyType: StudyType; hits: number } {
  for (const rule of RULES) {
    if (rule.studyType === "animal-study" && HUMAN_TERMS.test(text)) {
      // Animal keywords with human terms present: don't force animal-study.
      continue;
    }
    const hits = countHits(text, rule.patterns);
    if (hits > 0) return { studyType: rule.studyType, hits };
  }
  return { studyType: "unknown", hits: 0 };
}

function extract(text: string): Pick<GradeResult, "dosage" | "population" | "limitations"> {
  const out: Pick<GradeResult, "dosage" | "population" | "limitations"> = {};

  const dosage = text.match(DOSAGE_RE);
  if (dosage) out.dosage = dosage[0].trim();

  const population = text.match(POPULATION_RE);
  if (population?.[1]) out.population = population[1].trim();

  const limitations: string[] = [];
  for (const m of text.matchAll(LIMITATION_CUES)) {
    const sentence = m[1]?.trim();
    if (sentence) limitations.push(sentence);
  }
  if (limitations.length > 0) out.limitations = limitations.slice(0, 5);

  return out;
}

/** Grade from raw fields. Exposed for testing without constructing an NcbiArticle. */
export function gradeText(
  title: string,
  abstract: string | undefined,
  publicationTypes: string[] = [],
): GradeResult {
  const text = `${title}\n${abstract ?? ""}`.trim();

  // 1. Trust curated PublicationType tags when present.
  const byPubType = classifyByPublicationType(publicationTypes);

  // 2. Keyword classification (also used to corroborate / fall back).
  const byKeyword = classifyByKeywords(text);

  let studyType: StudyType;
  let confidence: number;
  if (byPubType) {
    studyType = byPubType;
    // High confidence: NLM-assigned. A corroborating keyword hit nudges it higher.
    confidence = byKeyword.studyType === byPubType ? 0.95 : 0.85;
  } else {
    studyType = byKeyword.studyType;
    // Spec formula: positiveHits * 0.4 + 0.2, capped at 1.
    confidence = studyType === "unknown" ? 0.1 : Math.min(1, byKeyword.hits * 0.4 + 0.2);
  }

  const extracted = extract(text);
  const limitations = [...(extracted.limitations ?? [])];

  // Negative keywords halve confidence and are recorded as limitations.
  let negativeHit = false;
  for (const neg of NEGATIVE_PATTERNS) {
    if (neg.pattern.test(text)) {
      negativeHit = true;
      if (!limitations.includes(neg.limitation)) limitations.push(neg.limitation);
    }
  }
  if (negativeHit) confidence = confidence / 2;

  // Title-only grade (no abstract) is inherently less certain.
  if (!abstract) {
    confidence = Math.min(confidence, 0.5);
    limitations.push("Graded from title only — no abstract available.");
  }

  const result: GradeResult = {
    studyType,
    evidenceScore: SCORE_BY_TYPE[studyType],
    confidence: Math.max(0, Math.min(1, Number(confidence.toFixed(3)))),
  };
  if (extracted.dosage) result.dosage = extracted.dosage;
  if (extracted.population) result.population = extracted.population;
  if (limitations.length > 0) result.limitations = limitations;
  return result;
}

/** Grade an article fetched from NCBI. */
export function keywordGrade(article: NcbiArticle): GradedArticle {
  const grade = gradeText(article.title, article.abstract, article.publicationTypes);
  return {
    ...article,
    studyType: grade.studyType,
    evidenceScore: grade.evidenceScore,
    confidence: grade.confidence,
    ...(grade.dosage ? { dosage: grade.dosage } : {}),
    ...(grade.population ? { population: grade.population } : {}),
    ...(grade.limitations ? { limitations: grade.limitations } : {}),
  };
}
