/**
 * Multi-database dispatch layer.
 *
 * `searchLiterature` fans a query out to one or more {@link DatabaseAdapter}s,
 * classifies every result's design from its metadata, merges the lists,
 * de-duplicates by DOI (keeping the better-classified copy, with any retraction
 * found on another copy), filters, and sorts by design tier, or with `sort: "date"`
 * newest first. `fetchLiterature` fetches specific ids from one database.
 *
 * Databases without NLM publication types (ChinaXiv, RussiaRxiv) always come
 * back `unknown`: the calling model reads the design from the abstract. A design
 * filter (studyTypes, minDesignTier) is passed down to the databases that have
 * the metadata, which narrow their queries to the publication types it can keep,
 * and skips the others, which it would empty.
 *
 * Input a caller can correct (an unknown database, an empty query, a date that
 * doesn't exist) raises INVALID_INPUT rather than returning an empty result.
 */

import { adaptersFor, getAdapter, unknownDatabase, type DatabaseAdapter } from "./adapters/registry.js";
import { dateKey, doiKey, isoDateBound } from "./adapters/util.js";
import { LRUBackend, type Cache } from "./cache.js";
import { errors, isMedResearchError } from "./errors.js";
import {
  classifyArticle,
  designPublicationTypes,
  mergeDuplicate,
  noAnimalStudiesWarning,
  rankKey,
  unassignedStudyTypes,
  unratedExcludedWarning,
} from "./grader.js";
import type {
  FetchOutput,
  GradedArticle,
  LiteratureFetchInput,
  Article,
  SearchInput,
  SearchOutput,
} from "./types.js";

const MAX_RESULTS_CAP = 50;

/** Throws INVALID_INPUT for an empty query or a date range PubMed would silently ignore. */
function validateSearch(input: SearchInput): void {
  if (!input.query?.trim()) throw errors.invalidInput("The query is empty.");
  const { from, to } = input.dateRange ?? {};
  const start = from ? isoDateBound(from, "from") : undefined;
  const end = to ? isoDateBound(to, "to") : undefined;
  for (const [value, parsed] of [
    [from, start],
    [to, end],
  ] as const) {
    if (value && !parsed) throw errors.invalidInput(`${JSON.stringify(value)} is not a date. Use YYYY-MM-DD, YYYY-MM or YYYY.`);
  }
  if (start && end && start > end) throw errors.invalidInput(`dateRange.from (${from}) is after dateRange.to (${to}).`);
}

/**
 * The earlier of a record's issue and electronic publication dates, as a {@link dateKey}; -1 without
 * either. PubMed sorts by date this way ("Citations with more than one publication date, such as
 * electronic and print, are sorted by their earliest publication date", PubMed Help, checked
 * 2026-10-22), and both PubMed's and Europe PMC's date filters match it.
 */
function firstPublished(article: Article): number {
  const dates = [dateKey(article.pubDate), dateKey(article.epubDate)].filter((d) => d !== undefined);
  return dates.length > 0 ? Math.min(...dates) : -1;
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
 * Search one or more databases and return classified, merged, de-duplicated results,
 * sorted by design tier, or with `sort: "date"` by first publication date, newest first.
 * Throws INVALID_INPUT for an unknown database, an empty query or an invalid date,
 * and the first database's error when every database searched failed.
 *
 * @param cache reused across calls; scoped per-database inside each adapter.
 * @param adapters explicit adapter list; defaults to those named in `input.database`.
 */
export async function searchLiterature(
  input: SearchInput,
  cache: Cache = new LRUBackend(),
  adapters?: DatabaseAdapter[],
): Promise<SearchOutput> {
  validateSearch(input);
  const selected = adapters ?? adaptersFor(input.database);
  if (selected.length === 0) throw errors.invalidInput("No database to search.");
  const warnings: string[] = [];

  const unassigned = unassignedStudyTypes(input.studyTypes);
  if (unassigned.length > 0) {
    warnings.push(
      `No record is ever labeled ${unassigned.join(", ")}: metadata doesn't assign ${unassigned.length > 1 ? "these designs" : "this design"}. ` +
        `Search without ${unassigned.length > 1 ? "them" : "it"} and judge the design from the abstract.`,
    );
  }
  // A design filter keeps only records carrying one of these publication types (null: no such filter).
  const designTypes = designPublicationTypes(input.studyTypes, input.minDesignTier);
  if (designTypes?.length === 0) {
    if (unassigned.length < (input.studyTypes?.length ?? 0)) {
      warnings.push(
        `No study type in studyTypes can reach minDesignTier ${input.minDesignTier}: meta-analyses and systematic reviews ` +
          `are mostly unrated (designTier null), and minDesignTier drops unrated records. Filter with studyTypes alone.`,
      );
    }
    return { articles: [], total: 0, query: input.query, warnings };
  }
  const searched = designTypes ? selected.filter((a) => a.designMetadata !== false) : selected;
  const skipped = selected.filter((a) => !searched.includes(a));
  if (skipped.length > 0) {
    warnings.push(
      `${skipped.map((a) => a.name).join(" and ")} not searched: ${skipped.length > 1 ? "their" : "its"} records carry no ` +
        `design metadata, so the studyTypes/minDesignTier filter would keep none. Search without the filter and read the abstracts.`,
    );
  }
  if (searched.length === 0) return { articles: [], total: 0, query: input.query, warnings };
  const unrated = unratedExcludedWarning(input.studyTypes, input.minDesignTier);
  if (unrated) warnings.push(unrated);

  const maxResults = Math.min(Math.max(input.maxResults ?? 10, 1), MAX_RESULTS_CAP);

  // Fan out. One adapter failing must not sink the others — it degrades to a warning.
  const failures: unknown[] = [];
  const perAdapter = await Promise.all(
    searched.map(async (adapter) => {
      try {
        const { count, ids, warning } = await adapter.search(input);
        if (warning) warnings.push(warning);
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
  if (failures.length === searched.length) throw failures[0];

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
  const typeFilter = input.studyTypes?.length ? new Set(input.studyTypes) : null;
  const merged = dedupeByDoi(graded).filter(
    (a) => (a.designTier ?? 0) >= minTier && (!typeFilter || typeFilter.has(a.studyType)),
  );
  if (typeFilter?.has("animal-study") && !merged.some((a) => a.studyType === "animal-study")) {
    warnings.push(noAnimalStudiesWarning());
  }
  // Stable sorts: equal items keep their database's order, databases in the order requested.
  if (input.sort === "date") {
    merged.sort((a, b) => firstPublished(b) - firstPublished(a));
  } else {
    merged.sort((a, b) => rankKey(b) - rankKey(a));
  }

  return {
    articles: merged,
    total,
    query: input.query,
    ...(warnings.length > 0 ? { warnings } : {}),
  };
}

/**
 * Fetch full metadata for specific ids from a single database.
 * Pure data — no grading. Throws INVALID_INPUT for an unknown database.
 *
 * @param adapter explicit adapter; defaults to the one named by `input.database`.
 */
export async function fetchLiterature(
  input: LiteratureFetchInput,
  cache: Cache = new LRUBackend(),
  adapter?: DatabaseAdapter,
): Promise<FetchOutput> {
  const resolved = adapter ?? getAdapter(input.database);
  if (!resolved) throw unknownDatabase([input.database]);

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
