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
  /** MeSH headings assigned by NLM indexers. */
  meshHeadings?: string[];
  /** PMIDs cited by this article. */
  references?: string[];
}

/** An article with keyword-based evidence classification. */
export interface GradedArticle extends NcbiArticle {
  studyType: StudyType;
  /** 0–5. Higher is stronger evidence. */
  evidenceScore: number;
  /** 0–1 confidence in the assigned study type. */
  confidence: number;
  dosage?: string;
  population?: string;
  limitations?: string[];
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

export interface FetchInput {
  /** One or more PMIDs to fetch. */
  pmids: string[];
}

export interface FetchOutput {
  articles: NcbiArticle[];
  /** PMIDs that could not be found or fetched. */
  missing: string[];
  warnings?: string[];
}

/** How a full text was obtained. `none` means only the abstract (or nothing) is available. */
export type FulltextSource = "unpaywall" | "proxy" | "direct" | "none";

export interface FulltextInput {
  /** PubMed ID. */
  pmid: string;
  /** DOI — if provided, skips the PMID→DOI lookup. */
  doi?: string;
}

export interface FulltextOutput {
  pmid: string;
  doi?: string;
  source: FulltextSource;
  /** Extracted full text (markdown) or, on the fallback path, the abstract. Absent if nothing was available. */
  fulltext?: string;
  format: "markdown" | "pdf";
  /** True if the text was capped at the character limit. */
  truncated: boolean;
  /** Set when the full text couldn't be retrieved, explaining why and what to do. */
  warning?: string;
}

/** What the cache stores for a resolved full text. The stored text is never truncated. */
export interface FulltextData {
  source: string;
  fulltext: string;
  format: "markdown" | "pdf";
  /** Unix epoch millis when this was resolved. Used to expire stale entries (URLs rot). */
  fetchedAt: number;
}
