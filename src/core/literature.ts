/**
 * Multi-database dispatch layer.
 *
 * `searchLiterature` fans a query out to one or more {@link DatabaseAdapter}s,
 * classifies every result's design from its metadata, merges the lists,
 * de-duplicates by DOI or PMID (keeping the better-classified copy, with any retraction
 * or link to a newer version found on another copy), filters, and sorts by design tier, or with `sort: "date"`
 * newest first. `fetchLiterature` fetches specific ids from one database and classifies them the same way.
 *
 * A page is merged, de-duplicated and sorted on its own, not with the pages before it.
 *
 * Databases without NLM publication types (ChinaXiv, RussiaRxiv) always come
 * back `unknown`: the calling model reads the design from the abstract. A design
 * filter (studyTypes, minDesignTier) is passed down to the databases that have
 * the metadata, which narrow their queries to the publication types it can keep (for `unknown`
 * and the trial designs below the RCT, also away from the types that give another design),
 * and skips the others, which it would empty. What the classifier still drops from a page is
 * counted by `total` and `nextPage`, and a warning says how many it kept.
 *
 * Input a caller can correct (an unknown database, an empty query or one with no search term, a bad page, a date
 * that doesn't exist) raises INVALID_INPUT rather than returning an empty result.
 *
 * A page-1 search of 2 to 5 plain words that every database answers with nothing is probed: the query
 * is searched again without each word, for the count only, so that the warning can name the word that
 * blocks it (see {@link probeZeroResult}). Models otherwise drop words one tool call at a time.
 */

import { adaptersFor, getAdapter, unknownDatabase, type DatabaseAdapter } from "./adapters/registry.js";
import { chinaxivHeaders } from "./adapters/chinarxiv.js";
import type { EmptyReason } from "./adapters/types.js";
import { doiKey, firstPublished, isoDateBound, isPmidRecord, MAX_PAGED_RECORDS, pageWindow } from "./adapters/util.js";
import { LRUBackend, type Cache } from "./cache.js";
import { errors, isMedResearchError } from "./errors.js";
import { withDeadline } from "./request.js";
import { classifyArticle, designPublicationTypes, filteredPageWarning, filterWarnings, mergeDuplicate, noAnimalStudiesWarning, rankKey } from "./grader.js";
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

/**
 * Whether the query holds a term to search for: a letter or digit left once the bracketed field tags (`[tiab]`) and the
 * operators AND, OR and NOT standing alone (upper case, between spaces or parentheses; `"AND"` in quotes is a word) are
 * set aside. `tirzepatide NOT mice` and `"sleep apnea"[tiab]` have one, `NOT`, `AND OR` and `[tiab]` have none.
 */
function hasSearchTerm(query: string): boolean {
  const terms = query.replace(/\[[^\]]*\]/g, " ").replace(/(?<![^\s()])(?:AND|OR|NOT)(?![^\s()])/g, " ");
  return /[\p{L}\p{N}]/u.test(terms);
}

/**
 * Throws INVALID_INPUT for an empty query, one with no search term, an unreachable page, a bad abstract limit, or a date
 * range PubMed would silently ignore.
 */
function validateSearch(input: SearchInput): void {
  if (!input.query?.trim()) throw errors.invalidInput("The query is empty.");
  // esearch fails on `()` and on a lone `"` with "temporarily unavailable", which no retry clears. With a design filter it
  // matched a query of no term against every record of the filter's publication types: `()` 1,065,791 for Clinical Trial,
  // `NOT` and `[tiab]` 1,287,132 at minDesignTier 2 (2026-11-27, 2026-11-28). `*`, `-` and `[` found nothing. None is a search.
  if (!hasSearchTerm(input.query)) {
    throw errors.invalidInput(
      `The query has no search term, so there is nothing to search for: punctuation, the operators AND, OR and NOT, and ` +
        `field tags such as [tiab] are not terms. Send words or a quoted phrase, e.g. sleep apnea or "sleep apnea"[tiab] AND tirzepatide.`,
    );
  }
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
 * The keys under which a record is merged with its other copies: its DOI and, when its id is a PMID, that PMID
 * (PubMed and Europe PMC's MEDLINE records of one paper share it, DOI or not, and one copy may lack the DOI the other
 * has). Any other id counts only for the same database, and only without a DOI, so a DOI-less record that a database
 * returned twice (the chinaxiv adapter with language "ru" and the russiarxiv adapter search the same corpus) is one.
 */
function mergeKeys(article: GradedArticle): string[] {
  const doi = doiKey(article.doi);
  const pmid = isPmidRecord(article);
  const keys: string[] = [];
  if (doi) keys.push(`doi:${doi}`);
  if (pmid) keys.push(`pmid:${article.id}`);
  if (!doi && !pmid) keys.push(`id:${article.database ?? "pubmed"}:${article.id}`);
  return keys;
}

/**
 * Keep one article per paper: copies that share a DOI or a PMID are one, also through a third copy that has both (see
 * {@link mergeKeys}, and {@link mergeDuplicate}: the flags and links of the other copies are kept with the one that
 * is). The merged copy takes the place of the first. A preprint and its journal article have different DOIs and PMIDs
 * and stay two records, linked by their `corrections`. Records of different databases whose ids are not PMIDs are
 * never merged without a DOI.
 */
function dedupeRecords(articles: GradedArticle[]): GradedArticle[] {
  // Union-find over positions, the lower one the root, so that a group sits where its first copy was.
  const root = articles.map((_, i) => i);
  const find = (i: number): number => (root[i] === i ? i : (root[i] = find(root[i]!)));
  const owner = new Map<string, number>();
  articles.forEach((article, i) => {
    for (const key of mergeKeys(article)) {
      const seen = owner.get(key);
      if (seen === undefined) owner.set(key, i);
      else root[Math.max(find(seen), find(i))] = Math.min(find(seen), find(i));
    }
  });
  // Map iteration keeps first-seen order: a group's first copy is its root, so the group takes its place.
  const byRoot = new Map<number, GradedArticle>();
  articles.forEach((article, i) => {
    const existing = byRoot.get(find(i));
    byRoot.set(find(i), existing ? mergeDuplicate(existing, article) : article);
  });
  return [...byRoot.values()];
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

/** The most words a query may have to be probed: a probe costs a request per word and database. */
const PROBE_MAX_WORDS = 5;
/** The time all the probes of one search get: they are an extra, and a slow database must not hold the answer back. */
const PROBE_TIME_MS = 10_000;
/** The share of a database's request allowance that probes may use, so that the caller's own searches keep the rest. */
const PROBE_SHARE = 1 / 3;
const MINUTE_MS = 60_000;

/**
 * The request allowance of a database whose adapter doesn't pace its own requests (the NCBI client does: pubmed.ts),
 * with the group of adapters that share it, or undefined when none is known. ChinaXiv and RussiaRxiv are two
 * corpora of one API, which allows 30 requests a minute anonymously and 300 with an X-API-Email header (its OpenAPI
 * spec, https://chinarxiv.org/api/openapi.json, checked 2026-11-16); a 429 with a Retry-After over 5 s is not waited
 * out (request.ts), so a request over the limit fails, and so would the caller's next search. Europe PMC sends no
 * rate-limit header, and its documentation (europepmc.org/RestfulWebService) answered 403 from here: no limit is known,
 * and its adapter paces nothing; a search sends at most {@link PROBE_MAX_WORDS} probes to it, and PubMed's client queues its own.
 */
function requestAllowance(adapterId: string): { group: string; perMinute: number } | undefined {
  if (adapterId !== "chinaxiv" && adapterId !== "russiarxiv") return undefined;
  return { group: "chinarxiv", perMinute: chinaxivHeaders()["X-API-Email"] ? 300 : 30 };
}

/** When the probes of each allowance group were sent, within the last minute. */
const probesSent = new Map<string, number[]>();

/** Take `count` probe requests from a group's allowance for this minute; false, taking none, when it doesn't hold that many. */
function takeProbes(group: string, perMinute: number, count: number): boolean {
  const now = Date.now();
  const recent = (probesSent.get(group) ?? []).filter((sentAt) => now - sentAt < MINUTE_MS);
  const taken = recent.length + count <= Math.floor(perMinute * PROBE_SHARE);
  probesSent.set(group, taken ? [...recent, ...Array<number>(count).fill(now)] : recent);
  return taken;
}

/** Forget the probes sent so far; for tests, which share one process (and so one allowance) with the others. */
export function resetProbeAllowance(): void {
  probesSent.clear();
}

const BOOLEAN_OPERATORS: ReadonlySet<string> = new Set(["AND", "OR", "NOT"]);

/**
 * The words of a query worth probing: 2 to 5 plain words, without quotes, parentheses, brackets (field
 * tags), colons or the operators AND, OR and NOT, a word once however often it is repeated (ignoring case);
 * undefined for any other query, which can't be told apart word by word, or has no word to leave out.
 */
function probeWords(query: string): string[] | undefined {
  const text = query.trim();
  if (/["()[\]:]/.test(text)) return undefined;
  const words = text.split(/\s+/);
  if (words.length < 2 || words.length > PROBE_MAX_WORDS || words.some((w) => BOOLEAN_OPERATORS.has(w))) return undefined;
  const distinct = words.filter((w, i) => words.findIndex((v) => v.toLowerCase() === w.toLowerCase()) === i);
  return distinct.length >= 2 ? distinct : undefined;
}

/** What a probe of one database found: the count of the query without each word, undefined where no answer came. */
interface ProbeOutcome {
  adapter: DatabaseAdapter;
  counts: (number | undefined)[];
}

/**
 * Search each database again without each of `words` in turn, for the count: `maxResults: 1`, page 1, the filters
 * of the search and no sort, through the adapter's own `search` (so its pacing and caches apply), one request
 * on each (PubMed's takes up to 500 ids with it, in the one request). The databases go side by side, within
 * {@link PROBE_TIME_MS}. One with a request allowance (see {@link requestAllowance}) gets its probes one at a time,
 * and no more when it refuses one with a rate limit; the others all at once, as a broad query can take Europe PMC
 * 7 s (2026-11-16), and probes in turn would not fit the time (PubMed's client queues its requests itself). A probe
 * that fails leaves its count undefined and is never an error (a query too broad for a PubMed client with a `broadThreshold`
 * is the exception: its count, which the error carries, is the probe's). A database whose allowance can't take {@link PROBE_SHARE}
 * of its minute for all its probes more is left out of the result, so that probes never use more than that share.
 */
async function probeZeroResult(input: SearchInput, adapters: DatabaseAdapter[], words: string[]): Promise<ProbeOutcome[]> {
  const probeInput = (query: string): SearchInput => ({
    query,
    maxResults: 1,
    page: 1,
    ...(input.dateRange ? { dateRange: input.dateRange } : {}),
    ...(input.studyTypes ? { studyTypes: input.studyTypes } : {}),
    ...(input.minDesignTier !== undefined ? { minDesignTier: input.minDesignTier } : {}),
    ...(input.language ? { language: input.language } : {}),
  });
  // Taken before any request is sent, so that two searches at once can't both spend the same share.
  const probed = adapters.filter((adapter) => {
    const allowance = requestAllowance(adapter.id);
    return !allowance || takeProbes(allowance.group, allowance.perMinute, words.length);
  });
  /** The count without `word`; undefined for a failed probe, "refused" for one the database or the time refused. */
  const ask = async (adapter: DatabaseAdapter, word: string): Promise<number | undefined | "refused"> => {
    try {
      return (await adapter.search(probeInput(words.filter((w) => w !== word).join(" ")))).count;
    } catch (err) {
      if (!isMedResearchError(err)) return undefined;
      // A PubMed client set to refuse a query over a `broadThreshold` says how many hits there are: the word left out blocks the rest.
      if (err.code === "QUERY_TOO_BROAD") return Number(/\d+/.exec(err.message)?.[0]) || undefined;
      return err.code === "RATE_LIMIT" || err.code === "TIMEOUT" ? "refused" : undefined;
    }
  };
  const counted = (answer: number | undefined | "refused"): number | undefined => (typeof answer === "number" ? answer : undefined);
  return withDeadline(PROBE_TIME_MS, () =>
    Promise.all(
      probed.map(async (adapter): Promise<ProbeOutcome> => {
        if (!requestAllowance(adapter.id)) return { adapter, counts: (await Promise.all(words.map((w) => ask(adapter, w)))).map(counted) };
        const counts: (number | undefined)[] = [];
        let refused = false;
        for (const word of words) {
          const answer: number | undefined | "refused" = refused ? undefined : await ask(adapter, word);
          refused = refused || answer === "refused";
          counts.push(counted(answer));
        }
        return { adapter, counts };
      }),
    ),
  );
}

/** "PubMed / NCBI" → "PubMed", "ChinaXiv (via ChinaRxiv)" → "ChinaXiv": a database as a warning names it. */
function shortName(name: string): string {
  return name.replace(/\s*[(/].*$/, "");
}

/**
 * The one warning a zero-result search gets from its probes, or undefined when they found nothing to say:
 * per word whose removal gives hits, the count and the databases; or, when removing any single word still gives none in
 * every database probed, that two or more words are too specific together. That claim needs an answer for every probe
 * of every database probed (a probe that failed leaves it unsaid), and a search without a design filter, which would
 * explain the zero by itself (see the generic warning below). A dateRange or design filter applies to the counts.
 */
function describeProbes(words: string[], outcomes: ProbeOutcome[], input: SearchInput): string | undefined {
  const records = (count: number, first: boolean, name: string): string =>
    `${count.toLocaleString("en-US")}${first ? ` record${count === 1 ? "" : "s"}` : ""} in ${shortName(name)}`;
  const findings = words
    .map((word, i) => ({
      word,
      hits: outcomes.flatMap(({ adapter, counts }) => ((counts[i] ?? 0) > 0 ? [{ adapter, count: counts[i]! }] : [])),
    }))
    .filter((f) => f.hits.length > 0);
  const { dateRange } = input;
  const designFilter = Boolean(input.studyTypes?.length || input.minDesignTier);
  const within = [
    ...(dateRange?.from || dateRange?.to ? [`dateRange ${describeRange(dateRange)}`] : []),
    ...(designFilter ? ["the studyTypes/minDesignTier filter"] : []),
  ];
  const inLimits = within.length > 0 ? ` within ${nameList(within)}` : "";

  if (findings.length > 0) {
    const clauses = findings.map(({ word, hits }, i) => {
      const where = nameList(hits.map((h, j) => records(h.count, i === 0 && j === 0, h.adapter.name)));
      return i === 0 ? `Without "${word}" the query matches ${where}` : `without "${word}", ${where}`;
    });
    return `${clauses.join("; ")}${inLimits}.`;
  }
  if (designFilter || outcomes.length === 0 || outcomes.some(({ counts }) => counts.some((c) => c === undefined))) return undefined;
  const ranged = Boolean(dateRange?.from || dateRange?.to);
  return (
    `Leaving out any one word still matches nothing in ${nameList(outcomes.map((o) => shortName(o.adapter.name)))}${inLimits}, ` +
    `so two or more words are too specific together${ranged ? ", or the dateRange is too narrow" : ""}. ` +
    `This is not evidence of absence: try fewer, more general keywords${ranged ? ", or no dateRange" : ""}.`
  );
}

/**
 * Search one or more databases and return classified, merged, de-duplicated results,
 * sorted by design tier, or with `sort: "date"` by first publication date, newest first.
 * Throws INVALID_INPUT for an unknown database, an empty query (or one with no search term), a bad page or an invalid date,
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
  // Raise the error instead, with its code (RATE_LIMIT, NETWORK_ERROR, … and QUERY_TOO_BROAD, from a PubMed client with a
  // `broadThreshold`) and retry hint.
  if (failures.length === searched.length) throw failures[0];

  const total = perAdapter.reduce((sum, { count }) => sum + count, 0);
  // Nothing found anywhere, on the first page, for a query of a few plain words: ask which word blocks it. What the probes
  // say stands in for the warnings that say less (the databases' own empty reasons below, and the generic one further down).
  const zero = total === 0 && failures.length === 0;
  const words = zero && page === 1 ? probeWords(input.query) : undefined;
  const probeWarning = words ? describeProbes(words, await probeZeroResult(input, searched, words), input) : undefined;

  // Databases that found nothing for the same reason say so once, naming them all, in the order requested.
  const byReason = new Map<EmptyReason, { name: string; warning: string }[]>();
  for (const { adapter, reported } of probeWarning ? [] : perAdapter) {
    if (!reported) continue;
    byReason.set(reported.reason, [...(byReason.get(reported.reason) ?? []), { name: adapter.name, warning: reported.warning }]);
  }
  for (const [reason, group] of byReason) {
    warnings.push(group.length > 1 ? SHARED_EMPTY_WARNING[reason](group.map((g) => g.name)) : group[0]!.warning);
  }

  const graded: GradedArticle[] = [];
  for (const { articles } of perAdapter) {
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
  const deduped = dedupeRecords(graded);
  const merged = deduped.filter((a) => (a.designTier ?? 0) >= minTier && (!typeFilter || typeFilter.has(a.studyType)));
  // The databases count what this filter drops (total, nextPage): say so, as the page can come back short.
  const cut = filteredPageWarning(merged.length, deduped.length);
  if (cut) warnings.push(cut);
  const noAnimals = noAnimalStudiesWarning(input.studyTypes, input.minDesignTier, merged);
  if (noAnimals) warnings.push(noAnimals);
  // A bare 0 reads as "no evidence exists". A failure explains a zero itself, and so does a design filter
  // (studyTypes, minDesignTier) with the warnings above; a date range does not, and a zero under one was read
  // as the range being ignored.
  if (zero) {
    const oneWord = !/\s/.test(input.query.trim());
    const { dateRange } = input;
    if (probeWarning) {
      warnings.push(probeWarning);
    } else if (dateRange?.from || dateRange?.to) {
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
 * Ids are trimmed, and each is fetched once however often and however it is spelled ("PMID:9500320",
 * "00009500320" and " 9500320 " are one PubMed id, see {@link DatabaseAdapter.normalizeId}), so a record comes
 * back once, in the order of its first id. Ids are fetched as the adapter writes them, case included: ChinaRxiv
 * answers `CHINAXIV-202401.00027` with a 404, so only an adapter whose database ignores case folds it. `missing`
 * lists the ids as the caller sent them (trimmed), each spelling once, so that the caller can match them up, and
 * its warning counts the ids behind them; an empty id asks for nothing and is missing.
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
  const sent = [...new Set(input.ids.map((id) => id.trim()))];
  const canonical = (id: string): string => resolved.normalizeId?.(id) ?? id;
  // Exact, not case-folded: "ru-196201.58177" and "RU-196201.58177" are two lookups at ChinaRxiv, and only the first finds the record.
  const wanted = new Set<string>();
  for (const id of sent) wanted.add(canonical(id));
  wanted.delete("");
  const ids = [...wanted];
  const fetched =
    ids.length === 0
      ? []
      : resolved.fetchFull
        ? await resolved.fetchFull(ids, cache)
        : await resolved.fetch(ids, cache, (w) => warnings.push(w));
  // A PMCID and the PMID of its record are two ids, and Europe PMC returns that record for each.
  const articles = [...new Map(fetched.map((a) => [a.id, a])).values()];
  // Case-insensitive: adapters return canonical ids ("PPR123456") for any input case, so a record found for
  // one spelling of an id also covers a spelling of other case sent beside it. A PMCID
  // fetched from Europe PMC comes back under its PMID, so it counts as found through `pmcid`.
  const found = new Set(
    articles.flatMap((a) => [a.id, a.pmcid]).filter((id): id is string => !!id).map((id) => id.toUpperCase()),
  );
  const missing = sent.filter((id) => !found.has(canonical(id).toUpperCase()));
  // Spellings of one id are one id that could not be fetched.
  const unfetched = new Set(missing.map(canonical)).size;
  if (unfetched > 0) warnings.push(`${unfetched} id(s) could not be fetched from ${resolved.name}.`);

  return { articles: articles.map((a) => classifyArticle(a)), missing, ...(warnings.length > 0 ? { warnings } : {}) };
}
