/**
 * Shared types for the med-research-mcp core library.
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
export interface Article {
  pmid: string;
  title: string;
  abstract?: string;
  authors: string[];
  journal: string;
  /** Publication date as reported by the source database (e.g. "2021 Mar 15" or "2021"). */
  pubDate: string;
  doi?: string;
  /** Source database's structured publication-type tags (NLM tags for PubMed, keyword-detected for others). */
  publicationTypes: string[];
  /** MeSH headings assigned by NLM indexers (PubMed only). */
  meshHeadings?: string[];
  /** IDs cited by this article in the source database. */
  references?: string[];

  /**
   * Source database — one of the adapter ids ("pubmed", "scielo", "cyberleninka",
   * "europepmc", "chinaxiv", "jstage"). Treated as "pubmed" when absent, so all
   * existing code keeps working without setting it. Non-PubMed adapters
   * always set it. When set, `pmid` holds the database-specific id.
   */
  database?: string;
  /** Direct URL to the article page on the source database. */
  url?: string;
  /** Language of the article (ISO 639-1). Treated as "en" when absent. */
  language?: string;
}

/**
 * Who the intervention was actually tested on — the range of people behind a
 * result. Used to judge external validity (generalizability): a finding in 20
 * healthy young men doesn't automatically transfer to elderly women. Every
 * field is best-effort, extracted from the abstract, and absent when the study
 * didn't report it. This is NOT a quality score — a narrow but well-run trial
 * is still narrow.
 */
export interface PopulationDiversity {
  /** Total participants when a sample size is stated (e.g. "n = 240" → 240). */
  sampleSize?: number;
  /** Reported age span or central value (e.g. "18–65 years", "mean ~42 years"). */
  age?: string;
  /** Sex composition (e.g. "male only", "men and women (48% female)"). */
  sex?: string;
  /** Ancestry / geographic-origin cues when stated (e.g. "Japanese", "multi-ethnic"). */
  ancestry?: string;
  /** Health status of the group (e.g. "healthy", "patients with type 2 diabetes"). */
  healthStatus?: string;
  /**
   * 0–1 rough breadth of the tested population — how many demographic axes were
   * reported and how broad each is. A generalizability hint, not a quality
   * score. Absent when no demographic signal could be extracted.
   */
  breadth?: number;
  /** Why breadth is limited (single-sex, small n, one ancestry group, …). */
  notes?: string[];
}

/** An article with keyword-based evidence classification. */
export interface GradedArticle extends Article {
  studyType: StudyType;
  /** 0–5. Higher is stronger evidence. */
  evidenceScore: number;
  /** 0–1 confidence in the assigned study type. */
  confidence: number;
  dosage?: string;
  population?: string;
  /** Structured breakdown of the tested population — see {@link PopulationDiversity}. */
  diversity?: PopulationDiversity;
  limitations?: string[];
}

export interface DateRange {
  /** YYYY-MM-DD */
  from?: string;
  /** YYYY-MM-DD */
  to?: string;
}

export interface SearchInput {
  /** Search query, supports PubMed field tags like `[tiab]`, `[mesh]`, `[au]` on the pubmed database. */
  query: string;
  /**
   * Source database(s) for {@link searchLiterature}. A single id ("pubmed",
   * "scielo", "cyberleninka", "europepmc", "chinaxiv", "jstage"), an array of
   * ids, or "all" to fan out to every adapter. Defaults to "pubmed" when omitted.
   */
  database?: string | string[];
  /** Results to return. Default 10, hard cap 50. */
  maxResults?: number;
  /** Drop results below this evidence score (0–5). Default 0. */
  minEvidenceScore?: number;
  /** Keep only these study types. Default: all. */
  studyTypes?: StudyType[];
  dateRange?: DateRange;
  /** "relevance" (default) or "date". */
  sort?: "relevance" | "date";
  /**
   * Preferred content language (ISO 639-1) — a hint for adapters that can filter
   * by language (e.g. SciELO). Ignored by adapters that don't support it.
   */
  language?: string;
}

export interface SearchOutput {
  articles: GradedArticle[];
  /** Total hits reported by esearch (before maxResults truncation). */
  total: number;
  query: string;
  warnings?: string[];
}

export interface FetchInput {
  /** One or more database-specific ids to fetch. */
  ids: string[];
}

export interface LiteratureFetchInput {
  /** One or more database-specific ids to fetch. */
  ids: string[];
  /** Which database the ids belong to ("pubmed", "scielo", "europepmc", …). */
  database: string;
}

export interface FetchOutput {
  articles: Article[];
  /** IDs that could not be found or fetched. */
  missing: string[];
  warnings?: string[];
}

/** How a full text was obtained. `none` means only the abstract (or nothing) is available. */
export type FulltextSource = "unpaywall" | "proxy" | "direct" | "none";

export interface FulltextInput {
  /** Article identifier from the source database. */
  id: string;
  /** DOI — if provided, skips the id→DOI lookup. */
  doi?: string;
}

export interface FulltextOutput {
  id: string;
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
