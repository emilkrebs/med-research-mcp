import { expect, test } from "vitest";
import { isPmidRecord } from "../src/core/index.js";
import type { Article, Correction, FulltextOutput, GradedArticle, NcbiArticle, SearchOutput } from "../src/core/index.js";

/**
 * The names a library consumer is told to import from `med-research-mcp/core`,
 * as listed in docs/library.md, plus the deprecated `NcbiArticle`. The file
 * only has to compile, and vitest doesn't type-check, so `npm run typecheck`
 * checks it through tsconfig.public-types.json: if one of the names stops
 * being exported by the public entry, the typecheck fails.
 */
export const _typecheck = {
  a: {} as Article,
  n: {} as NcbiArticle,
  g: {} as GradedArticle,
  s: {} as SearchOutput,
  f: {} as FulltextOutput,
  c: {} as Correction,
  p: isPmidRecord,
};

test("public entry exports the documented types", () => {
  expect(_typecheck.p).toBeTypeOf("function");
});
