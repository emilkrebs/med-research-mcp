import { expect, test } from "vitest";
import { isPmidRecord } from "../src/core/index.js";
import type { Article, Correction, FulltextOutput, GradedArticle, SearchOutput } from "../src/core/index.js";

/**
 * The names a library consumer is told to import from `med-research-mcp/core`,
 * as listed in docs/library.md. The file only has to compile: if one of them
 * stops being exported by the public entry, the type check of this file fails.
 */
export const _typecheck = {
  a: {} as Article,
  g: {} as GradedArticle,
  s: {} as SearchOutput,
  f: {} as FulltextOutput,
  c: {} as Correction,
  p: isPmidRecord,
};

test("public entry exports the documented types", () => {
  expect(_typecheck.p).toBeTypeOf("function");
});
