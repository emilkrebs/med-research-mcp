/**
 * Multi-database dispatch layer.
 *
 * `searchLiterature` fans a query out to one or more {@link DatabaseAdapter}s,
 * classifies every result's design from its metadata, merges the lists,
 * de-duplicates by DOI (keeping the better-classified copy, with any retraction
 * or link to a newer version found on another copy), filters, and sorts by design tier, or with `sort: "date"`
 * newest first. `fetchLiterature` fetches specific ids from one database and classifies them the same way.
 *
 * A page is merged, de-duplicated and sorted on its own, not with the pages before it.
 *
 * Databases without NLM publication types (ChinaXiv, RussiaRxiv) always come
 * back `unknown`: the calling model reads the design from the abstract. A design
 * filter (studyTypes, minDesignTier) is passed down to the databases that have
 * the metadata, which narrow their queries to the publication types it can keep,
 * and skips the others, which it would empty.
 *
 * Input a caller can correct (an unknown database, an empty query, a bad page, a date that
 * doesn't exist) raises INVALID_INPUT rather than returning an empty result.
 */

import { adaptersFor, getAdapter, unknownDatabase, type DatabaseAdapter } from "./adapters/registry.js";
import type { EmptyReason } from "./adapters/types.js";
import { doiKey, firstPublished, isoDateBound, MAX_PAGED_RECORDS, pageWindow } from "./adapters/util.js";
import { LRUBackend, type Cache } from "./cache.js";
import { errors, isMedResearchError } from "./errors.js";
import { classifyArticle, designPublicationTypes, filterWarnings, mergeDuplicate, noAnimalStudiesWarning, rankKey } from "./grader.js";
import type {
  Article,
  DateRange,
  FetchOutput,
  GradedArticle,
  LiteratureFetchInput,
  SearchFilters,
  SearchInput,
  SearchOutput,
} from "./types.js";

/** Throws INVALID_INPUT for an empty query, an unreachable page, a bad abstract limit, or a date range PubMed would silently ignore. */
function validateSearch(input: SearchInput): void {
  if (!input.query?.trim()) throw errors.invalidInput("The query is empty.");
  const { abstractMaxChars } = input;
  if (abstractMaxChars !== undefined && (!Number.isInteger(abstractMaxChars) || abstractMaxChars < 0)) {
    throw errors.invalidInput("abstractMaxChars must be a whole number, 0 or more.");
  }
  if (input.page !== undefined) {
    if (!Number.isInteger(input.page) || input.page < 1) throw errors.invalidInput("page must be a whole number, 1 or more.");
    const { offset } = pageWindow(input);
    if (offset >= MAX_PAGED_RECORDS) {
      throw errors.invalidInput(
        `Page ${input.page} starts at record ${(offset + 1).toLocaleString("en-US")}, but paging reaches only the first ` +
          `${MAX_PAGED_RECORDS.toLocaleString("en-US")} records of a search. Narrow the query instead: more specific terms, ` +
          `a dateRange or studyTypes.`,
      );
    }
  }
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
 * Keep one article per DOI (see {@link mergeDuplicate}: the flags and links of the other copies are kept
 * with it). A preprint and its journal article have different DOIs and stay two records, linked by their
 * `corrections`. DOI-less articles are merged only
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

/** The filters a caller gave, for the result to echo; undefined when there are none (an empty dateRange or studyTypes is none). */
function suppliedFilters(input: SearchInput): SearchFilters | undefined {
  const { from, to } = input.dateRange ?? {};
  const filters: SearchFilters = {
    ...(from || to ? { dateRange: { ...(from ? { from } : {}), ...(to ? { to } : {}) } } : {}),
    ...(input.studyTypes?.length ? { studyTypes: input.studyTypes } : {}),
    ...(input.minDesignTier !== undefined ? { minDesignTier: input.minDesignTier } : {}),
  };
  return Object.keys(filters).length > 0 ? filters : undefined;
}

/** "2020 to 2021", "from 2020" or "up to 2021": the range as the caller gave it. */
function describeRange({ from, to }: DateRange): string {
  return from && to ? `${from} to ${to}` : from ? `from ${from}` : `up to ${to}`;
}

/** "A", "A and B", "A, B and C". */
function nameList(names: string[]): string {
  return names.length < 2 ? names.join("") : `${names.slice(0, -1).join(", ")} and ${names.at(-1)}`;
}

/** One warning for several databases that report the same empty-result reason (see {@link EmptyReason}). */
const SHARED_EMPTY_WARNING: Record<EmptyReason, (names: string[]) => string> = {
  "every-word": (names) =>
    `${nameList(names)} matched nothing: they return only records containing every word of the query and treat ` +
    `AND/OR as words. Try one or two key words.`,
};

/** The text up to `budget` characters, ended at the last word boundary within it (cut where it stands if there is none). */
function cutAtWord(text: string, budget: number): string {
  if (budget <= 0) return "";
  const head = text.slice(0, budget);
  // Between words already when the next character is a space; otherwise back up to the last space in the head.
  const boundary = /\s/.test(text[budget]!) ? budget : head.search(/\s\S*$/);
  // A single word longer than the budget has no boundary: cut it, but not through a surrogate pair.
  const cut = boundary > 0 ? head.slice(0, boundary) : head.replace(/[\uD800-\uDBFF]$/, "");
  return cut.trimEnd();
}

/**
 * The article with its abstract cut to at most `max` characters, the "…" that ends it included, and
 * `abstractTruncated` set. An abstract that fits is left alone, and so is an `abstractTruncated` the adapter
 * set: it is never cleared. `max` 0 leaves the abstract out; the flag still says the article had one.
 */
function capAbstract(article: GradedArticle, max: number): GradedArticle {
  if (!article.abstract || article.abstract.length <= max) return article;
  const kept = cutAtWord(article.abstract, max - 1);
  const capped: GradedArticle = { ...article, abstractTruncated: true };
  if (kept) capped.abstract = `${kept}…`;
  else delete capped.abstract;
  return capped;
}

/**
 * Search one or more databases and return classified, merged, de-duplicated results,
 * sorted by design tier, or with `sort: "date"` by first publication date, newest first.
 * Throws INVALID_INPUT for an unknown database, an empty query, a bad page or an invalid date,
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
  const warnings = filterWarnings(input.studyTypes, input.minDesignTier);
  const page = input.page ?? 1;
  const { offset, size } = pageWindow(input);
  const filters = suppliedFilters(input);
  // Nothing is searched on these early returns, so no database is listed.
  const empty: SearchOutput = {
    articles: [],
    total: 0,
    query: input.query,
    databases: [],
    ...(filters ? { filters } : {}),
    page,
    maxResults: size,
    warnings,
  };
  // A design filter keeps only records carrying one of these publication types (null: no such filter).
  const designTypes = designPublicationTypes(input.studyTypes, input.minDesignTier);
  if (designTypes?.length === 0) return empty;
  const searched = designTypes ? selected.filter((a) => a.designMetadata !== false) : selected;
  const skipped = selected.filter((a) => !searched.includes(a));
  if (skipped.length > 0) {
    warnings.push(
      `${skipped.map((a) => a.name).join(" and ")} not searched: ${skipped.length > 1 ? "their" : "its"} records carry no ` +
        `design metadata, so the studyTypes/minDesignTier filter would keep none. Search without the filter and read the abstracts.`,
    );
  }
  if (searched.length === 0) return empty;

  const hasNextPage = offset + size < MAX_PAGED_RECORDS;

  // Fan out. One adapter failing must not sink the others — it degrades to a warning.
  const failures: unknown[] = [];
  let more = false;
  const perAdapter = await Promise.all(
    searched.map(async (adapter) => {
      try {
        const { count, ids, warning, emptyReason, more: served } = await adapter.search(input);
        // A warning with a reason is held back, to be shared with the databases that give the same one.
        const reported = warning && emptyReason ? { reason: emptyReason, warning } : undefined;
        if (warning && !reported) warnings.push(warning);
        if (served ?? count > offset + size) more = true;
        const articles = await adapter.fetch(ids.slice(0, size), cache, (w) => warnings.push(`${adapter.name}: ${w}`));
        return { adapter, count, articles, reported, failed: false };
      } catch (err) {
        failures.push(err);
        const reason = isMedResearchError(err) ? err.userMessage : err instanceof Error ? err.message : String(err);
        warnings.push(`${adapter.name} search failed: ${reason}`);
        return { adapter, count: 0, articles: [] as Article[], reported: undefined, failed: true };
      }
    }),
  );
  // When nothing was searched successfully, an empty result would read as "no studies exist".
  // Raise the error instead, with its code (RATE_LIMIT, QUERY_TOO_BROAD, …) and retry hint.
  if (failures.length === searched.length) throw failures[0];

  // Databases that found nothing for the same reason say so once, naming them all, in the order requested.
  const byReason = new Map<EmptyReason, { name: string; warning: string }[]>();
  for (const { adapter, reported } of perAdapter) {
    if (!reported) continue;
    byReason.set(reported.reason, [...(byReason.get(reported.reason) ?? []), { name: adapter.name, warning: reported.warning }]);
  }
  for (const [reason, group] of byReason) {
    warnings.push(group.length > 1 ? SHARED_EMPTY_WARNING[reason](group.map((g) => g.name)) : group[0]!.warning);
  }

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
  const noAnimals = noAnimalStudiesWarning(input.studyTypes, input.minDesignTier, merged);
  if (noAnimals) warnings.push(noAnimals);
  // A bare 0 reads as "no evidence exists". A failure explains a zero itself, and so does a design filter
  // (studyTypes, minDesignTier) with the warnings above; a date range does not, and a zero under one was read
  // as the range being ignored.
  if (total === 0 && failures.length === 0) {
    const oneWord = !/\s/.test(input.query.trim());
    const { dateRange } = input;
    if (dateRange?.from || dateRange?.to) {
      warnings.push(
        `No record matched the query "${input.query}" within dateRange ${describeRange(dateRange)}. This is not evidence ` +
          `of absence: retry without the dateRange, or ${oneWord ? "with a synonym" : "with fewer keywords"}.`,
      );
    } else if (!input.studyTypes?.length && !input.minDesignTier) {
      warnings.push(
        oneWord
          ? `No record matched the query "${input.query}". This is not evidence of absence: try a synonym or another ` +
              `spelling${searched.length === 1 ? ", or another database" : ""}.`
          : `No record matched every term of the query "${input.query}". This is not evidence of absence: ` +
              `retry with fewer, more general keywords.`,
      );
    }
  }
  // Failed databases count 0: the page is past the end of those that answered.
  if (page > 1 && total > 0 && perAdapter.every(({ count }) => count <= offset)) {
    const databases = failures.length > 0 ? "databases that answered" : "databases searched";
    warnings.push(`Page ${page} is past the last result: the ${databases} have no more records for this query.`);
  }
  // Stable sorts: equal items keep their database's order, databases in the order requested.
  if (input.sort === "date") {
    const published = new Map(merged.map((a) => [a, firstPublished(a)]));
    merged.sort((a, b) => published.get(b)! - published.get(a)!);
  } else {
    merged.sort((a, b) => rankKey(b) - rankKey(a));
  }

  // Last: de-duplication and the sort read the whole abstracts, and the sort keys by article.
  const { abstractMaxChars } = input;
  return {
    articles: abstractMaxChars === undefined ? merged : merged.map((a) => capAbstract(a, abstractMaxChars)),
    total,
    // A database that failed is left out: its 0 would read as a count.
    ...(searched.length > 1
      ? { totalByDatabase: Object.fromEntries(perAdapter.filter((r) => !r.failed).map((r) => [r.adapter.id, r.count])) }
      : {}),
    query: input.query,
    databases: searched.map((a) => a.id),
    ...(filters ? { filters } : {}),
    page,
    maxResults: size,
    ...(more && hasNextPage ? { nextPage: page + 1 } : {}),
    ...(warnings.length > 0 ? { warnings } : {}),
  };
}

/**
 * Fetch full metadata and the whole abstract for specific ids from a single database, graded like search
 * results (studyType, designTier, flags) and with the MeSH headings that search leaves out.
 * Throws INVALID_INPUT for an unknown database.
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

  const warnings: string[] = [];
  const articles = resolved.fetchFull
    ? await resolved.fetchFull(input.ids, cache)
    : await resolved.fetch(input.ids, cache, (w) => warnings.push(w));
  // Case-insensitive: adapters return canonical ids ("PPR123456") for any input case. A PMCID
  // fetched from Europe PMC comes back under its PMID, so it counts as found through `pmcid`.
  const found = new Set(articles.flatMap((a) => [a.pmid, a.pmcid ?? ""]).map((id) => id.toUpperCase()));
  const missing = input.ids.filter((id) => !found.has(id.toUpperCase()));
  if (missing.length > 0) warnings.push(`${missing.length} id(s) could not be fetched from ${resolved.name}.`);

  return { articles: articles.map((a) => classifyArticle(a)), missing, ...(warnings.length > 0 ? { warnings } : {}) };
}
