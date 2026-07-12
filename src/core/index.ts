/**
 * pubmed-bio core — pure TypeScript library, no MCP dependency.
 *
 * Consumed directly (e.g. by Biohacking-IDE) via `import { ... } from "pubmed-bio/core"`,
 * and re-exported through the thin MCP adapter in ../mcp.
 */

export { searchPubMed, NcbiClient } from "./pubmed.js";
export type { NcbiConfig } from "./pubmed.js";

export { keywordGrade, gradeText, SCORE_BY_TYPE } from "./grader.js";
export type { GradeResult } from "./grader.js";

export { gradeArticle } from "./llm-grader.js";
export type { GradeOptions } from "./llm-grader.js";

export { callLlm, llmConfigFromEnv, isLlmUsable } from "./llm-providers.js";

export { createCache, LRUBackend, NullCache } from "./cache.js";
export type { Cache, CacheBackend, CacheOptions } from "./cache.js";

export { PubMedException, isPubMedError, errors } from "./errors.js";
export type { PubMedError, PubMedErrorCode } from "./errors.js";

export type {
  StudyType,
  GradingMethod,
  NcbiArticle,
  GradedArticle,
  DateRange,
  SearchInput,
  SearchOutput,
  DeepGradeInput,
  DeepGradeOutput,
  Pico,
  LlmProvider,
  LlmConfig,
} from "./types.js";
