/**
 * Single seam between the benchmark and the med-research-mcp core library.
 *
 * The benchmark imports the core *directly from source* (`../../src/core`),
 * run through tsx — no build step. Condition C talks to the real MCP server
 * (`createServer` from `../../src/mcp/server`, over an in-memory transport, so
 * no stdio and no env warnings); the scorer uses `NcbiClient` + `classifyArticle`
 * to verify cited PMIDs against live PubMed.
 *
 * Everything that touches the library goes through this one file so a change to
 * the library's layout (or a switch to the built `dist/`) is a one-line edit here.
 */

export {
  searchLiterature,
  fetchLiterature,
  fetchFulltext,
  classifyArticle,
  DESIGN_TIER,
  parseEuropePmc,
  STUDY_TYPES,
  NcbiClient,
  PubMedAdapter,
  LRUBackend,
  NullCache,
  createCache,
} from "../../src/core/index.js";

export { envSetting } from "../../src/core/version.js";

export { createServer } from "../../src/mcp/server.js";

// Page extraction shared with the web-search baseline's `web_fetch`, so both
// conditions turn HTML/PDF into text identically. Module exports, not public API.
export { defaultHtmlToMarkdown as htmlToMarkdown, defaultPdfToText as pdfToText } from "../../src/core/fulltext.js";

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
  Correction,
  Cache,
} from "../../src/core/index.js";
