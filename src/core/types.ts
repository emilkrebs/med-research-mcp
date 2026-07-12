/**
 * Shared types for the pubmed-bio core library.
 * No MCP or runtime dependency — safe to import from anywhere.
 */

/** Evidence tiers, highest-quality first. `unknown` when nothing matches. */
export type StudyType =
  | "meta-analysis"
  | "randomized-controlled-trial"
  | "cohort"
  | "review"
  | "case-control"
  | "case-report"
  | "animal-study"
  | "unknown";

export type GradingMethod = "keyword" | "llm";

/** Raw article metadata as returned by NCBI (esummary + efetch merged). */
export interface NcbiArticle {
  pmid: string;
  title: string;
  abstract?: string;
  authors: string[];
  journal: string;
  /** Publication date as reported by PubMed (e.g. "2021 Mar 15" or "2021"). */
  pubDate: string;
  doi?: string;
  /** PubMed's own structured publication-type tags, e.g. ["Randomized Controlled Trial", "Journal Article"]. */
  publicationTypes: string[];
}

/** An article plus its evidence grade. */
export interface GradedArticle extends NcbiArticle {
  studyType: StudyType;
  /** 0–5. Higher is stronger evidence. */
  evidenceScore: number;
  /** 0–1 confidence in the assigned study type. */
  confidence: number;
  dosage?: string;
  population?: string;
  limitations?: string[];
  gradingMethod: GradingMethod;
}

export interface DateRange {
  /** YYYY-MM-DD */
  from?: string;
  /** YYYY-MM-DD */
  to?: string;
}

export interface SearchInput {
  /** PubMed query, supports field tags like `[tiab]`, `[mesh]`, `[au]`. */
  query: string;
  /** Results to return. Default 10, hard cap 50. */
  maxResults?: number;
  /** Drop results below this evidence score (0–5). Default 0. */
  minEvidenceScore?: number;
  /** Keep only these study types. Default: all. */
  studyTypes?: StudyType[];
  dateRange?: DateRange;
  /** "relevance" (default) or "date". */
  sort?: "relevance" | "date";
}

export interface SearchOutput {
  articles: GradedArticle[];
  /** Total hits reported by esearch (before maxResults truncation). */
  total: number;
  query: string;
  warnings?: string[];
}

export interface DeepGradeInput {
  pmid: string;
  /** If the abstract is already in hand, pass it to skip a network round-trip. */
  abstract?: string;
}

export interface Pico {
  population?: string;
  intervention?: string;
  comparison?: string;
  outcome?: string;
}

export interface DeepGradeOutput {
  pmid: string;
  correctedStudyType: StudyType;
  /** LLM-adjusted evidence score (0–5). */
  correctedScore: number;
  pico: Pico;
  sampleSize?: number;
  effectSize?: string;
  fundingSource?: string;
  /** Conflicts of interest, tiny sample, preprint, retracted, etc. */
  redFlags: string[];
  gradingReasoning: string;
  gradingMethod: "llm";
  /** True when the LLM path failed and this is a keyword-derived fallback. */
  fallback?: boolean;
  /** Present on fallback: why the LLM grade was unavailable. */
  warning?: string;
}

/** Supported LLM providers for the deep-grade path. */
export type LlmProvider = "openai" | "anthropic" | "local";

export interface LlmConfig {
  provider: LlmProvider;
  apiKey?: string;
  /** Model id; each provider has a sensible default. */
  model?: string;
  /** Base URL override — required for `local`, optional elsewhere. */
  baseUrl?: string;
  /** Request timeout in milliseconds. Default 15000. */
  timeoutMs?: number;
}
