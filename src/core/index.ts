/**
 * med-research-mcp core — pure TypeScript library, no MCP dependency.
 *
 * Consumed directly via `import { ... } from "med-research-mcp/core"`,
 * and re-exported through the thin MCP adapter in ../mcp.
 */

export { searchPubMed, fetchPubMed, NcbiClient } from "./pubmed.js";
export { PROJECT_CONTACT_EMAIL } from "./version.js";
export type { NcbiConfig } from "./pubmed.js";

export { searchLiterature, fetchLiterature } from "./literature.js";

export { ADAPTERS, adaptersFor, getAdapters, getAdapter } from "./adapters/registry.js";
export type { DatabaseAdapter } from "./adapters/types.js";
export { PubMedAdapter } from "./adapters/pubmed.js";
export { EuropePmcAdapter, parseEuropePmc } from "./adapters/europepmc.js";
export { ChinaRXivAdapter, parsePapers as parseChinaRXiv } from "./adapters/chinarxiv.js";
export { SovietRxivAdapter } from "./adapters/russiarxiv.js";
export { defaultHttp } from "./adapters/http.js";
export type { AdapterHttp, HttpOptions } from "./adapters/http.js";

export { classifyArticle, classifyDesign, designPublicationTypes, DESIGN_TIER } from "./grader.js";
export type { Classification } from "./grader.js";

export { fetchFulltext } from "./fulltext.js";
export type { FulltextDeps, FetchedResource } from "./fulltext.js";

export { UnpaywallClient } from "./unpaywall.js";
export type { UnpaywallConfig, UnpaywallLookup, UnpaywallResult } from "./unpaywall.js";

export { createCache, LRUBackend, NullCache, SQLiteBackend, CACHE_FORMAT_VERSION, FULLTEXT_TTL_MS, SUMMARY_TTL_MS } from "./cache.js";
export type { Cache, CacheBackend, CacheOptions } from "./cache.js";

export { ResearchApiException, isMedResearchError, errors } from "./errors.js";
export type { ResearchError, ResearchErrorCode } from "./errors.js";

export { STUDY_TYPES, RECORD_FLAGS, CORRECTION_TYPES } from "./types.js";
export type {
  StudyType,
  RecordFlag,
  Correction,
  CorrectionType,
  Article as NcbiArticle,
  GradedArticle,
  DateRange,
  SearchInput,
  SearchOutput,
  FetchInput,
  FetchOutput,
  LiteratureFetchInput,
  FulltextInput,
  FulltextOutput,
  FulltextData,
  FulltextSource,
} from "./types.js";
