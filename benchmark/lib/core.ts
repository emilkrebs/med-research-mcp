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
  searchPubMed,
  fetchPubMed,
  fetchFulltext,
  classifyArticle,
  DESIGN_TIER,
  parseEuropePmc,
  parseChinaRXiv,
  STUDY_TYPES,
  NcbiClient,
  PubMedAdapter,
  ChinaRXivAdapter,
  LRUBackend,
  NullCache,
  createCache,
} from "../../src/core/index.js";

export { envSetting } from "../../src/core/version.js";

// The server's own reading of the markup in a Europe PMC title and abstract, so that the scorer and the
// candidate writer see the text exactly as the server shows it to a model.
export { htmlToText } from "../../src/core/text.js";

export { createServer } from "../../src/mcp/server.js";

// An article as the server's tools print it (`id` first, `pmid` only for a PMID), so that a test names the id a model is shown.
export { printedArticle } from "../../src/mcp/output.js";

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
