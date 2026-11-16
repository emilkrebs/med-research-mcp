/**
 * How the literature tools print an article.
 *
 * The library keeps an article's own id, whatever its database, in `Article.id` (see types.ts). A model reading
 * `pmid: "PPR1244531"` would cite it as a PMID, so the tools print `id` first in the article and add `pmid` right
 * after it only for a record whose id is a PMID (`isPmidRecord`). Every other key keeps its name and place.
 *
 * Only the printing is changed, here, and only for `literature_search` and `literature_fetch`: `literature_fulltext`
 * already returns `id`.
 */

import { isPmidRecord } from "../core/adapters/util.js";
import type { Article } from "../core/types.js";

/** An article as the tools print it: `id` first, and `pmid` (the same) only when the id is a PMID. */
export type PrintedArticle<A extends Article = Article> = { id: string; pmid?: string } & A;

/** The article with `id` as its first key, `pmid` directly after it when the id is a PMID, and the other keys as they were. */
export function printedArticle<A extends Article>(article: A): PrintedArticle<A> {
  const { id, ...rest } = article;
  return { id, ...(isPmidRecord(article) ? { pmid: id } : {}), ...rest } as PrintedArticle<A>;
}

/** A search or fetch result with each of its articles printed so; its other keys are untouched. */
export function printedResult<R extends { articles: Article[] }>(result: R): Omit<R, "articles"> & { articles: PrintedArticle<R["articles"][number]>[] } {
  return { ...result, articles: result.articles.map((a) => printedArticle(a)) };
}
