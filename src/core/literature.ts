/**
 * Multi-database dispatch layer.
 *
 * `searchLiterature` fans a query out to one or more {@link DatabaseAdapter}s,
 * grades every result with the same keyword grader, merges the
 * lists, de-duplicates by DOI (keeping the higher-scored copy), and sorts by
 * evidence score. `fetchLiterature` fetches specific ids from one database.
 *
 * Non-PubMed articles lack NLM PublicationType tags, so they are graded
 * keyword-only: their *confidence* is lower, but the score scale is the same —
 * source and language never lower a score by themselves.
 */

import { getAdapter, getAdapters, type DatabaseAdapter } from "./adapters/registry.js";
import { doiKey } from "./adapters/util.js";
import { LRUBackend, type Cache } from "./cache.js";
import { keywordGrade, unclassifiedDroppedWarning } from "./grader.js";
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

/** Keep one article per DOI (higher evidence score wins); DOI-less articles all pass through. */
function dedupeByDoi(articles: GradedArticle[]): GradedArticle[] {
  const byKey = new Map<string, GradedArticle>();
  // `slots` preserves first-seen order; a string entry is a DOI key placeholder.
  const slots: (GradedArticle | string)[] = [];
  for (const article of articles) {
    const key = doiKey(article.doi);
    if (!key) {
      slots.push(article);
      continue;
    }
    const existing = byKey.get(key);
    if (!existing) {
      byKey.set(key, article);
      slots.push(key);
    } else if (article.evidenceScore > existing.evidenceScore) {
      byKey.set(key, article);
    }
  }
  return slots.map((slot) => (typeof slot === "string" ? byKey.get(slot)! : slot));
}

/**
 * Search one or more databases and return graded, merged, de-duplicated results.
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
  const perAdapter = await Promise.all(
    selected.map(async (adapter) => {
      try {
        const { count, ids } = await adapter.search(input);
        const articles = await adapter.fetch(ids.slice(0, maxResults), cache);
        return { count, articles };
      } catch (err) {
        warnings.push(`${adapter.name} search failed: ${err instanceof Error ? err.message : String(err)}`);
        return { count: 0, articles: [] as Article[] };
      }
    }),
  );

  const minScore = input.minEvidenceScore ?? 0;
  const typeFilter = input.studyTypes ? new Set(input.studyTypes) : null;

  let total = 0;
  let droppedUnclassified = 0;
  const graded: GradedArticle[] = [];
  for (const { count, articles } of perAdapter) {
    total += count;
    for (const article of articles) {
      const g = keywordGrade(article);
      if (g.evidenceScore < minScore) {
        if (g.studyType === "unknown") droppedUnclassified += 1;
        continue;
      }
      if (typeFilter && !typeFilter.has(g.studyType)) continue;
      graded.push(g);
    }
  }
  if (droppedUnclassified > 0) warnings.push(unclassifiedDroppedWarning(droppedUnclassified));

  const merged = dedupeByDoi(graded);
  // Stable sort by evidence score (then confidence) — equal-score items keep
  // their per-adapter relevance order.
  merged.sort((a, b) => b.evidenceScore - a.evidenceScore || b.confidence - a.confidence);

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
      warnings: [`Unknown database: ${input.database}. Known: pubmed, scielo, europepmc, chinaxiv, russiarxiv.`],
    };
  }

  const articles = resolved.fetchFull ? await resolved.fetchFull(input.ids, cache) : await resolved.fetch(input.ids, cache);
  // Case-insensitive: adapters return canonical ids ("PPR123456") for any input case.
  const found = new Set(articles.map((a) => a.pmid.toUpperCase()));
  const missing = input.ids.filter((id) => !found.has(id.toUpperCase()));

  return {
    articles,
    missing,
    ...(missing.length > 0
      ? { warnings: [`${missing.length} id(s) could not be fetched from ${resolved.name}.`] }
      : {}),
  };
}
