/**
 * pubmed-bio core — pure TypeScript library, no MCP dependency.
 *
 * Consumed directly (e.g. by Biohacking-IDE) via `import { ... } from "pubmed-bio/core"`,
 * and re-exported through the thin MCP adapter in ../mcp.
 */

export { searchPubMed, fetchPubMed, NcbiClient } from "./pubmed.js";
export type { NcbiConfig } from "./pubmed.js";

export { searchLiterature, fetchLiterature } from "./literature.js";

export { ADAPTERS, getAdapters, getAdapter } from "./adapters/registry.js";
export type { DatabaseAdapter } from "./adapters/types.js";
export { PubMedAdapter } from "./adapters/pubmed.js";
export { SciELOAdapter, parseScielo } from "./adapters/scielo.js";
export { EuropePmcAdapter, parseEuropePmc } from "./adapters/europepmc.js";
export { ChinaXivAdapter, parseChinaXiv } from "./adapters/chinaxiv.js";
export { JStageAdapter, parseJStage } from "./adapters/jstage.js";
export { CyberLeninkaAdapter, parseCyberLeninkaHtml } from "./adapters/cyberleninka.js";
export { defaultHttp } from "./adapters/http.js";
export type { AdapterHttp, HttpOptions } from "./adapters/http.js";

export { keywordGrade, gradeText, SCORE_BY_TYPE } from "./grader.js";
export type { GradeResult } from "./grader.js";

export { fetchFulltext } from "./fulltext.js";
export type { FulltextDeps, FetchedResource } from "./fulltext.js";

export { UnpaywallClient } from "./unpaywall.js";
export type { UnpaywallConfig, UnpaywallResult } from "./unpaywall.js";

export { createCache, LRUBackend, NullCache, SQLiteBackend, FULLTEXT_TTL_MS } from "./cache.js";
export type { Cache, CacheBackend, CacheOptions } from "./cache.js";

export { PubMedException, isPubMedError, errors } from "./errors.js";
export type { PubMedError, PubMedErrorCode } from "./errors.js";

export type {
  StudyType,
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
