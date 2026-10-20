/**
 * Multi-database dispatch layer.
 *
 * `searchLiterature` fans a query out to one or more {@link DatabaseAdapter}s,
 * classifies every result's design from its metadata, merges the lists,
 * de-duplicates by DOI (keeping the better-classified copy, with any retraction
 * found on another copy), filters, and sorts by design tier. `fetchLiterature`
 * fetches specific ids from one database.
 *
 * Databases without NLM publication types (ChinaXiv, RussiaRxiv) always come
 * back `unknown`: the calling model reads the design from the abstract.
 */

import { ADAPTERS, getAdapter, getAdapters, type DatabaseAdapter } from "./adapters/registry.js";
import { doiKey } from "./adapters/util.js";
import { LRUBackend, type Cache } from "./cache.js";
import { isMedResearchError } from "./errors.js";
import { classifyArticle, mergeDuplicate, rankKey, unclassifiedDroppedWarning } from "./grader.js";
import type {
  FetchOutput,
  GradedArticle,
  LiteratureFetchInput,
  Article,
  SearchInput,
  SearchOutput,
} from "./types.js";

const MAX_RESULTS_CAP = 50;

/** Database omitted → defaults to pubmed. Explicit "all" (handled by getAdapters) fans out. */
function toIdList(database: SearchInput["database"]): string[] {
  if (database == null) return ["pubmed"];
  const list = Array.isArray(database) ? database : [database];
  return list.length > 0 ? list : ["pubmed"];
}

/**
 * Keep one article per DOI (see {@link mergeDuplicate}). DOI-less articles are merged only
 * when the same database returned the same id twice (the chinaxiv adapter with language
 * "ru" and the russiarxiv adapter search the same corpus).
 */
function dedupeByDoi(articles: GradedArticle[]): GradedArticle[] {
  // Map iteration keeps first-seen order: a merged copy takes the place of the first one.
  const byKey = new Map<string, GradedArticle>();
  for (const article of articles) {
    const key = doiKey(article.doi) ?? `id:${article.database ?? "pubmed"}:${article.pmid}`;
    const existing = byKey.get(key);
    byKey.set(key, existing ? mergeDuplicate(existing, article) : article);
  }
  return [...byKey.values()];
}

/**
 * Search one or more databases and return classified, merged, de-duplicated results.
 *
 * @param cache reused across calls; scoped per-database inside each adapter.
 * @param adapters explicit adapter list; defaults to those named in `input.database`.
 */
export async function searchLiterature(
  input: SearchInput,
  cache: Cache = new LRUBackend(),
  adapters?: DatabaseAdapter[],
): Promise<SearchOutput> {
  const selected = adapters ?? getAdapters(toIdList(input.database));
  const warnings: string[] = [];

  if (selected.length === 0) {
    return {
      articles: [],
      total: 0,
      query: input.query,
      warnings: [`No known database adapter(s) for: ${JSON.stringify(input.database)}.`],
    };
  }

  const maxResults = Math.min(Math.max(input.maxResults ?? 10, 1), MAX_RESULTS_CAP);

  // Fan out. One adapter failing must not sink the others — it degrades to a warning.
  const failures: unknown[] = [];
  const perAdapter = await Promise.all(
    selected.map(async (adapter) => {
      try {
        const { count, ids } = await adapter.search(input);
        const articles = await adapter.fetch(ids.slice(0, maxResults), cache);
        return { count, articles };
      } catch (err) {
        failures.push(err);
        const reason = isMedResearchError(err) ? err.userMessage : err instanceof Error ? err.message : String(err);
        warnings.push(`${adapter.name} search failed: ${reason}`);
        return { count: 0, articles: [] as Article[] };
      }
    }),
  );
  // When nothing was searched successfully, an empty result would read as "no studies exist".
  // Raise the error instead, with its code (RATE_LIMIT, QUERY_TOO_BROAD, …) and retry hint.
  if (failures.length === selected.length) throw failures[0];

  let total = 0;
  const graded: GradedArticle[] = [];
  for (const { count, articles } of perAdapter) {
    total += count;
    for (const article of articles) {
      // MeSH feeds the classification; search results leave it to literature_fetch to stay compact.
      const { meshHeadings: _mesh, ...g } = classifyArticle(article);
      graded.push(g);
    }
  }

  // Filter after de-duplicating: a retracted copy (tier 0) that the filter would
  // drop must first pass its flag on to the copy that is kept.
  const minTier = input.minDesignTier ?? 0;
  const typeFilter = input.studyTypes ? new Set(input.studyTypes) : null;
  let droppedUnclassified = 0;
  const merged = dedupeByDoi(graded).filter((a) => {
    if ((a.designTier ?? 0) < minTier) {
      if (a.designTier == null) droppedUnclassified += 1;
      return false;
    }
    return !typeFilter || typeFilter.has(a.studyType);
  });
  if (droppedUnclassified > 0) warnings.push(unclassifiedDroppedWarning(droppedUnclassified));
  // Stable sort — equal-rank items keep their per-adapter relevance order.
  merged.sort((a, b) => rankKey(b) - rankKey(a));

  return {
    articles: merged,
    total,
    query: input.query,
    ...(warnings.length > 0 ? { warnings } : {}),
  };
}

/**
 * Fetch full metadata for specific ids from a single database.
 * Pure data — no grading.
 *
 * @param adapter explicit adapter; defaults to the one named by `input.database`.
 */
export async function fetchLiterature(
  input: LiteratureFetchInput,
  cache: Cache = new LRUBackend(),
  adapter?: DatabaseAdapter,
): Promise<FetchOutput> {
  const resolved = adapter ?? getAdapter(input.database);
  if (!resolved) {
    return {
      articles: [],
      missing: input.ids,
      warnings: [`Unknown database: ${input.database}. Known: ${Object.keys(ADAPTERS).join(", ")}.`],
    };
  }

  const articles = resolved.fetchFull ? await resolved.fetchFull(input.ids, cache) : await resolved.fetch(input.ids, cache);
  // Case-insensitive: adapters return canonical ids ("PPR123456") for any input case. A PMCID
  // fetched from Europe PMC comes back under its PMID, so it counts as found through `pmcid`.
  const found = new Set(articles.flatMap((a) => [a.pmid, a.pmcid ?? ""]).map((id) => id.toUpperCase()));
  const missing = input.ids.filter((id) => !found.has(id.toUpperCase()));

  return {
    articles,
    missing,
    ...(missing.length > 0
      ? { warnings: [`${missing.length} id(s) could not be fetched from ${resolved.name}.`] }
      : {}),
  };
}
