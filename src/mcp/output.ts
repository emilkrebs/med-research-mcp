/**
 * How the literature tools print an article.
 *
 * The library keeps an article's own id, whatever its database, in `Article.pmid` (see types.ts), and library users and
 * the benchmark scorer read it there. A model reading `pmid: "PPR1244531"` cites it as a PMID, so the tools print the id as
 * `id` instead, first in the article, and `pmid` right after it only for a record whose id is a PMID. Every other key keeps its
 * name and place.
 *
 * Only the printing is changed, here, and only for `literature_search` and `literature_fetch`: `literature_fulltext`
 * already returns `id`.
 */

import type { Article } from "../core/types.js";

/**
 * Whether the id of an article is a PMID: all digits, in PubMed or Europe PMC. Europe PMC's adapter gives bare digits
 * only to MEDLINE records and writes any other source's number as `SRC:id` (`toEpmcId`, adapters/europepmc.ts); ChinaXiv and
 * RussiaRxiv ids are `chinaxiv-…` and `ru-…`. A record without a database is PubMed's, as everywhere in the library.
 */
export function isPmidRecord(article: Pick<Article, "pmid" | "database">): boolean {
  const database = article.database ?? "pubmed";
  return (database === "pubmed" || database === "europepmc") && /^\d+$/.test(article.pmid);
}

/** An article as the tools print it: the database's own id as `id`, and `pmid` (the same) only when it is a PMID. */
export type PrintedArticle<A extends Article = Article> = { id: string; pmid?: string } & Omit<A, "pmid">;

/** The article with `id` as its first key, `pmid` directly after it when the id is a PMID, and the other keys as they were. */
export function printedArticle<A extends Article>(article: A): PrintedArticle<A> {
  const { pmid: id, ...rest } = article;
  return { id, ...(isPmidRecord(article) ? { pmid: id } : {}), ...rest } as PrintedArticle<A>;
}

/** A search or fetch result with each of its articles printed so; its other keys are untouched. */
export function printedResult<R extends { articles: Article[] }>(result: R): Omit<R, "articles"> & { articles: PrintedArticle<R["articles"][number]>[] } {
  return { ...result, articles: result.articles.map((a) => printedArticle(a)) };
}
