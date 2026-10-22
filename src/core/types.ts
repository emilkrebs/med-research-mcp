/**
 * Shared types for the med-research-mcp core library.
 * No MCP or runtime dependency — safe to import from anywhere.
 */

/**
 * Study designs, ordered by design tier (see `DESIGN_TIER` in grader.ts).
 *
 * The classifier assigns a label only when NLM metadata establishes it; the
 * generic `clinical-trial` and `observational` labels say as much as the
 * metadata does and no more. `cohort`, `case-control`, `cross-sectional` and
 * `in-vitro` are never assigned from metadata (MeSH design headings proved too
 * imprecise); they exist for designs read from an abstract. `review` is a
 * review article not indexed as systematic. `unknown`: no design metadata —
 * unclassified, not weak.
 */
export const STUDY_TYPES = [
  "meta-analysis",
  "systematic-review",
  "randomized-controlled-trial",
  "cohort",
  "non-randomized-trial",
  "clinical-trial",
  "observational",
  "case-control",
  "cross-sectional",
  "case-report",
  "review",
  "animal-study",
  "in-vitro",
  "unknown",
] as const;

export type StudyType = (typeof STUDY_TYPES)[number];

/**
 * Facts about a record, read from its database metadata. `retracted`, `notice`,
 * `protocol` and `editorial` mean the record is not usable as evidence, so its
 * `designTier` is 0; the rest are warnings that leave the tier alone.
 * `machine-translated` and `machine-generated-abstract` describe the text of a
 * ChinaXiv or RussiaRxiv record, not the study.
 */
export const RECORD_FLAGS = [
  "retracted",
  "notice",
  "protocol",
  "editorial",
  "expression-of-concern",
  "corrected",
  "updated",
  "animals-not-humans",
  "preprint",
  "letter",
  "machine-translated",
  "machine-generated-abstract",
] as const;

export type RecordFlag = (typeof RECORD_FLAGS)[number];

/**
 * Links from a record to notices about it, as PubMed's CommentsCorrections
 * RefType names (Europe PMC's "Retraction in" etc. are mapped to these).
 */
export const CORRECTION_TYPES = ["RetractionIn", "ExpressionOfConcernIn", "ErratumIn", "UpdateIn"] as const;

export type CorrectionType = (typeof CORRECTION_TYPES)[number];

export interface Correction {
  type: CorrectionType;
  /** Id of the notice or newer version in the same database; absent for one-way links. */
  id?: string;
}

/** Raw article metadata as returned by NCBI (esummary + efetch merged). */
export interface Article {
  pmid: string;
  title: string;
  abstract?: string;
  authors: string[];
  journal: string;
  /** Publication date as reported by the source database (e.g. "2021 Mar 15" or "2021"): the issue date when there is one. */
  pubDate: string;
  /**
   * Electronic publication date, when the database reports one (PubMed "2018 Sep 20", Europe PMC
   * "2024-12-16"). A dateRange filter also matches it, so a record published online within the
   * range can show a later pubDate.
   */
  epubDate?: string;
  doi?: string;
  /** NLM PublicationType tags (PubMed, Europe PMC). Empty for databases without them. */
  publicationTypes: string[];
  /** MeSH descriptor names assigned by NLM (PubMed, Europe PMC). Absent until a record is MEDLINE-indexed. */
  meshHeadings?: string[];
  /** Retraction, expression of concern, erratum or newer version linked to this record (PubMed, Europe PMC). */
  corrections?: Correction[];
  /** IDs cited by this article in the source database. */
  references?: string[];

  /**
   * Source database — one of the adapter ids ("pubmed", "europepmc", "chinaxiv",
   * "russiarxiv"). Treated as "pubmed" when absent, so all
   * existing code keeps working without setting it. Non-PubMed adapters
   * always set it. When set, `pmid` holds the database-specific id.
   */
  database?: string;
  /** Direct URL to the article page on the source database. */
  url?: string;
  /** Language of the article (ISO 639-1). Treated as "en" when absent. */
  language?: string;
  /** PubMed Central id, for records that have one (PubMed, Europe PMC). `literature_fulltext` takes it as an id. */
  pmcid?: string;
  /** The record a translated copy was made from (ChinaXiv, Math-Net.Ru, …), for checking the original. */
  originalUrl?: string;
  /** Title and abstract are a machine translation into English (ChinaXiv and RussiaRxiv records). */
  machineTranslated?: boolean;
  /** The abstract was written by the database, not the authors (most RussiaRxiv records). */
  machineGeneratedAbstract?: boolean;
}

/** An article with its study design classified from NLM metadata. */
export interface GradedArticle extends Article {
  /** From NLM PublicationType tags; `unknown` when the record has none that names a design. */
  studyType: StudyType;
  /**
   * 0–5 rank of the design for "does this intervention help?" questions
   * (OCEBM 2011 levels, see grader.ts) — not an appraisal of the study. 0 when a
   * flag marks the record as not usable as evidence. `null` when the rank is
   * unknown: no design metadata, or a systematic review / meta-analysis whose
   * pooled study designs are not indexed.
   */
  designTier: number | null;
  /** Retracted, notice, expression of concern, … — see {@link RECORD_FLAGS}. Absent when none apply. */
  flags?: RecordFlag[];
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
   * "europepmc", "chinaxiv", "russiarxiv"), an array of ids, or "all" to fan
   * out to every adapter. Defaults to "pubmed" when omitted.
   */
  database?: string | string[];
  /** Results to return. Default 10, hard cap 50. */
  maxResults?: number;
  /** Drop results below this design tier (0–5). Results with an unknown tier are dropped too. Default: keep all. Narrows the query like `studyTypes`. */
  minDesignTier?: number;
  /**
   * Keep only these study types. Default (or empty): all. PubMed and Europe PMC are
   * queried for the publication types that can produce them, so `total` counts candidates.
   */
  studyTypes?: StudyType[];
  dateRange?: DateRange;
  /**
   * "relevance" (default): each database's relevance order, re-sorted by design tier when merged.
   * "date": newest first by the earlier of pubDate and epubDate, across databases.
   */
  sort?: "relevance" | "date";
  /**
   * Preferred content language (ISO 639-1). Only the ChinaXiv adapter reads it:
   * "ru" searches the Russian collection. Ignored by the others.
   */
  language?: string;
}

export interface SearchOutput {
  articles: GradedArticle[];
  /** Hits reported by the databases searched, summed, before maxResults truncation (of the narrowed query, with a design filter). */
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
  /** Which database the ids belong to ("pubmed", "europepmc", "chinaxiv", "russiarxiv"). */
  database: string;
}

export interface FetchOutput {
  articles: Article[];
  /** IDs that could not be found or fetched. */
  missing: string[];
  warnings?: string[];
}

/**
 * How a full text was obtained: Europe PMC's full-text API by PMCID, an open-access copy
 * Unpaywall located, the institutional proxy, or the DOI directly. `none` means only the
 * abstract (or nothing) is available.
 */
export type FulltextSource = "europepmc" | "unpaywall" | "proxy" | "direct" | "none";

export interface FulltextInput {
  /** A PMID, a PMCID ("PMC…"), a Europe PMC preprint id ("PPR…"), or another database's id with `doi`. */
  id: string;
  /** DOI — if provided, skips the id→DOI lookup. */
  doi?: string;
  /** Character position in the full text to return it from: a previous call's `nextOffset`. Default 0. */
  offset?: number;
  /** The most characters to return, up to the configured limit (`FulltextDeps.maxChars`). */
  maxChars?: number;
}

export interface FulltextOutput {
  id: string;
  doi?: string;
  source: FulltextSource;
  /** Extracted full text (markdown) or, on the fallback path, the abstract. Absent if nothing was available. */
  fulltext?: string;
  format: "markdown" | "pdf";
  /** True if the text goes on past the part returned; `nextOffset` says where. */
  truncated: boolean;
  /** Length of the whole full text, of which `fulltext` is the part from the requested offset. Absent on the abstract fallback. */
  totalChars?: number;
  /** Set when `truncated`: pass it as `offset` to read on. */
  nextOffset?: number;
  /** Set when the full text couldn't be retrieved: what each location answered, and what to do. */
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
