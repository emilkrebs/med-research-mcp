/**
 * Deep grading — the precise, token-costing path behind the `pubmed_grade` tool.
 *
 * Runs a static verify/extract/flag prompt against the configured LLM and parses
 * strict JSON into a DeepGradeOutput. Any failure (no key, timeout, bad JSON)
 * degrades gracefully to the keyword grade with a warning — never throws at the
 * caller. The prompt is a fixed template (no dynamic generation) for
 * deterministic output.
 */

import type { Cache } from "./cache.js";
import { LRUBackend } from "./cache.js";
import { isPubMedError } from "./errors.js";
import { keywordGrade, SCORE_BY_TYPE } from "./grader.js";
import { callLlm, isLlmUsable, llmConfigFromEnv } from "./llm-providers.js";
import { NcbiClient } from "./pubmed.js";
import type { DeepGradeInput, DeepGradeOutput, LlmConfig, NcbiArticle, Pico, StudyType } from "./types.js";

const VALID_STUDY_TYPES: ReadonlySet<StudyType> = new Set([
  "meta-analysis",
  "randomized-controlled-trial",
  "cohort",
  "review",
  "case-control",
  "case-report",
  "animal-study",
  "unknown",
]);

const SYSTEM_PROMPT = `You are a rigorous evidence-grading assistant for biomedical literature.
You verify study-type classifications, extract structured data, and flag quality problems.
Respond with a SINGLE JSON object and nothing else. Do not wrap it in markdown fences.`;

function buildUserPrompt(article: NcbiArticle, keywordStudyType: StudyType): string {
  return `Grade this PubMed article.

TITLE: ${article.title}
JOURNAL: ${article.journal}
PUBLICATION TYPES (from PubMed): ${article.publicationTypes.join(", ") || "none"}
KEYWORD CLASSIFICATION (to verify): ${keywordStudyType}

ABSTRACT:
${article.abstract ?? "(no abstract available — grade from title and metadata only)"}

Return JSON with exactly these fields:
{
  "correctedStudyType": one of ["meta-analysis","randomized-controlled-trial","cohort","review","case-control","case-report","animal-study","unknown"],
  "correctedScore": integer 0-5 (5=meta-analysis/systematic review, 4=RCT, 3=cohort/review, 2=case-control, 1=case-report, 0=animal/unknown),
  "pico": { "population": string, "intervention": string, "comparison": string, "outcome": string },
  "sampleSize": integer or null,
  "effectSize": string or null,
  "fundingSource": string or null,
  "redFlags": array of strings (e.g. "conflict of interest", "n < 20", "preprint", "retracted", "no full text"),
  "gradingReasoning": string explaining the grade and any correction to the keyword classification
}

1. VERIFY: Is the keyword classification correct? If a protocol paper was read as an RCT, a meta-analysis of poor studies was scored 5, or an animal study was misread as human, correct it and explain.
2. EXTRACT: Pull PICO, sample size, effect size, and funding source from the abstract where present.
3. FLAG: List red flags — conflicts of interest, tiny sample (n < 20), preprint, retracted, paywalled/no full text.`;
}

function stripJson(raw: string): string {
  const fenced = raw.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const body = fenced?.[1] ?? raw;
  const start = body.indexOf("{");
  const end = body.lastIndexOf("}");
  return start >= 0 && end > start ? body.slice(start, end + 1) : body.trim();
}

function coerceStudyType(value: unknown, fallback: StudyType): StudyType {
  return typeof value === "string" && VALID_STUDY_TYPES.has(value as StudyType)
    ? (value as StudyType)
    : fallback;
}

function coercePico(value: unknown): Pico {
  if (!value || typeof value !== "object") return {};
  const v = value as Record<string, unknown>;
  const pico: Pico = {};
  for (const key of ["population", "intervention", "comparison", "outcome"] as const) {
    if (typeof v[key] === "string" && v[key]) pico[key] = v[key] as string;
  }
  return pico;
}

function coerceStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((x): x is string => typeof x === "string" && x.length > 0);
}

function keywordFallback(article: NcbiArticle, warning: string): DeepGradeOutput {
  const grade = keywordGrade(article);
  const pico: Pico = grade.population ? { population: grade.population } : {};
  return {
    pmid: article.pmid,
    correctedStudyType: grade.studyType,
    correctedScore: grade.evidenceScore,
    pico,
    redFlags: [],
    gradingReasoning: "LLM deep grading was unavailable; returning the keyword-based grade instead.",
    gradingMethod: "llm",
    fallback: true,
    warning,
  };
}

export interface GradeOptions {
  llm?: LlmConfig | null;
  client?: NcbiClient;
}

/**
 * Deep-grade a single article. Fetches the abstract if not supplied, calls the
 * LLM, and caches the result. Falls back to keyword grading on any LLM failure.
 */
export async function gradeArticle(
  input: DeepGradeInput,
  cache: Cache = new LRUBackend(),
  options: GradeOptions = {},
): Promise<DeepGradeOutput> {
  const cached = cache.getLLMGrade(input.pmid);
  if (cached) return cached;

  const client = options.client ?? new NcbiClient();

  // Assemble the article: metadata (summary) + abstract, cache-first.
  let summary = cache.getSummary(input.pmid);
  if (!summary) {
    const fetched = await client.esummary([input.pmid]);
    summary = fetched.get(input.pmid) ?? null;
    if (summary) cache.setSummary(input.pmid, summary);
  }
  if (!summary) {
    // No metadata at all — build a minimal article so we can still return something.
    summary = {
      pmid: input.pmid,
      title: "",
      authors: [],
      journal: "",
      pubDate: "",
      publicationTypes: [],
    };
  }

  let abstract = input.abstract ?? cache.getAbstract(input.pmid) ?? undefined;
  if (!abstract) {
    try {
      const fetched = await client.efetch([input.pmid]);
      const data = fetched.get(input.pmid);
      if (data?.abstract) {
        abstract = data.abstract;
        cache.setAbstract(input.pmid, data.abstract);
      }
      if (data && data.publicationTypes.length > 0 && summary.publicationTypes.length === 0) {
        summary.publicationTypes = data.publicationTypes;
      }
    } catch {
      // Grade from title only.
    }
  }

  const article: NcbiArticle = abstract ? { ...summary, abstract } : summary;
  const keyword = keywordGrade(article);

  const llmConfig = options.llm !== undefined ? options.llm : llmConfigFromEnv();
  if (!isLlmUsable(llmConfig)) {
    return keywordFallback(article, "No LLM provider configured (set PUBMED_LLM_PROVIDER and PUBMED_LLM_API_KEY).");
  }

  let raw: string;
  try {
    raw = await callLlm(llmConfig, SYSTEM_PROMPT, buildUserPrompt(article, keyword.studyType));
  } catch (err) {
    const warning = isPubMedError(err) ? err.userMessage : "LLM request failed.";
    return keywordFallback(article, warning);
  }

  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(stripJson(raw)) as Record<string, unknown>;
  } catch {
    return keywordFallback(article, "The LLM response could not be parsed as JSON.");
  }

  const correctedStudyType = coerceStudyType(parsed.correctedStudyType, keyword.studyType);
  const rawScore = Number(parsed.correctedScore);
  const correctedScore = Number.isFinite(rawScore)
    ? Math.max(0, Math.min(5, Math.round(rawScore)))
    : SCORE_BY_TYPE[correctedStudyType];

  const output: DeepGradeOutput = {
    pmid: input.pmid,
    correctedStudyType,
    correctedScore,
    pico: coercePico(parsed.pico),
    redFlags: coerceStringArray(parsed.redFlags),
    gradingReasoning:
      typeof parsed.gradingReasoning === "string" ? parsed.gradingReasoning : "No reasoning provided.",
    gradingMethod: "llm",
  };
  if (Number.isFinite(Number(parsed.sampleSize))) output.sampleSize = Number(parsed.sampleSize);
  if (typeof parsed.effectSize === "string" && parsed.effectSize) output.effectSize = parsed.effectSize;
  if (typeof parsed.fundingSource === "string" && parsed.fundingSource) {
    output.fundingSource = parsed.fundingSource;
  }

  cache.setLLMGrade(input.pmid, output);
  return output;
}
