/**
 * Single seam between the benchmark and the med-research-mcp core library.
 *
 * The benchmark imports the core *directly from source* (`../../src/core`),
 * run through tsx — no stdio, no build step, no MCP round-trip. Condition C
 * exercises exactly the functions the MCP server wraps (`searchLiterature`,
 * `fetchLiterature`, `fetchFulltext`); the scorer uses `NcbiClient` +
 * `keywordGrade` to verify cited PMIDs against live PubMed.
 *
 * Everything that touches the library goes through this one file so a change to
 * the library's layout (or a switch to the built `dist/`) is a one-line edit here.
 */

export {
  searchLiterature,
  fetchLiterature,
  fetchFulltext,
  keywordGrade,
  NcbiClient,
  LRUBackend,
  createCache,
} from "../../src/core/index.js";

export type {
  SearchInput,
  SearchOutput,
  LiteratureFetchInput,
  FetchOutput,
  FulltextInput,
  FulltextOutput,
  GradedArticle,
  NcbiArticle,
  StudyType,
  Cache,
} from "../../src/core/index.js";
