/**
 * Full-text resolution + extraction.
 *
 * Given a PMID (and optionally a DOI), a PMCID, a Europe PMC preprint id or other
 * Europe PMC id, or a ChinaXiv or RussiaRxiv id, try — in order — the machine's
 * access paths, and return the article body as markdown:
 *
 *   0. ChinaRxiv      — for a ChinaXiv or RussiaRxiv id: its API's translated text
 *   1. Europe PMC     — its full-text API, when the record has a PMCID (or is a
 *                       PMCID or preprint id): open access, with tables
 *   2. Unpaywall      — free, aggregates every open-access copy of a DOI; PMC and
 *                       Europe PMC copies come from Europe PMC's full-text API
 *   3. Proxy          — an institutional EZproxy prefix, if configured
 *   4. Direct DOI     — https://doi.org/{DOI} (works on IP-authed networks / OA)
 *   5. Fallback       — the abstract, with `source: "none"` and a warning that
 *                       says what each location answered
 *
 * The abstract of a PMID comes from PubMed. For any other id (a preprint's, another
 * Europe PMC source's such as CBA:… or IND…, or another database's passed with its
 * DOI) it comes from the record that database's adapter holds, and the DOI of Europe
 * PMC's record opens steps 2 to 4 for a PMCID, preprint or other Europe PMC id passed
 * without one (see {@link lookUpRecord}). An id Europe PMC has no record of, given
 * without a DOI, is NOT_FOUND.
 *
 * The warning opens with the article's standing when a record of it is known and flagged retracted, a notice,
 * or with an expression of concern (see {@link standingNote}), whether or not a text was found. A record is
 * known from the cache (an earlier search or fetch, or this module's own lookups), or from a request made anyway:
 * esummary for a PMID given without a DOI, efetch for its abstract, the Europe PMC or ChinaRxiv record. No request
 * is made for it alone, so a PMID given with its DOI, a PMCID whose record no search left in the cache, and
 * the like are served without the flag. It is read from the records at every call and never stored with a
 * text: a full text cached for 30 days is served with a retraction recorded after it was cached.
 *
 * Only open-access (Europe PMC, Unpaywall) texts are cached; a proxy or direct
 * text may be licensed to the user alone, and a ChinaRxiv text is a translation of
 * a paper whose licence the record may leave blank (none of the 5 ChinaXiv records
 * read on 2026-11-16 stated one, `license` being null or empty; the 3 RussiaRxiv ones
 * said "open-access" or "cc-by"), served and not kept (see chinarxiv.ts).
 * A long text is returned in parts of at most `maxChars` characters; `offset`
 * reads on from where the last part ended. A text that isn't cached and goes on
 * is kept in memory while it is read (see {@link READING_TTL_MS}), so that every
 * part comes from the same text.
 *
 * HTML is reduced to the article body with mozilla/readability, then converted
 * to markdown with turndown. A page counts as full text only if it holds text
 * beyond its abstract and front and back matter (see {@link readPage}): a
 * paywalled article's landing page shows the abstract and is otherwise short.
 * PDFs are extracted with pdf-parse. The heavy extraction libraries are imported
 * lazily so importing this module stays cheap, and every extraction dependency is
 * injectable for testing.
 *
 * Pages are fetched with `fetchPublic` (./public-fetch.ts), which refuses
 * loopback, private and link-local addresses at every redirect and caps the
 * body size: the URLs come from Unpaywall and DOI registrants, not from us.
 */

import { LRUCache } from "lru-cache";
import type { DatabaseAdapter } from "./adapters/types.js";
import type { Cache } from "./cache.js";
import { LRUBackend } from "./cache.js";
import { errors, isMedResearchError } from "./errors.js";
import { classifyDesign } from "./grader.js";
import { BlockedUrlError, fetchPublic } from "./public-fetch.js";
import { NcbiClient } from "./pubmed.js";
import type { Article, CorrectionType, FulltextInput, FulltextOutput, FulltextSource, RecordFlag } from "./types.js";
import { UnpaywallClient } from "./unpaywall.js";
import type { UnpaywallLookup } from "./unpaywall.js";
import { envSetting, USER_AGENT } from "./version.js";

const DEFAULT_MAX_CHARS = 50_000;
const DEFAULT_TIMEOUT_MS = 20_000;
/** Extracted text shorter than this is treated as a paywall stub / failed extraction. */
const MIN_FULLTEXT_CHARS = 500;
/**
 * Text an HTML page must hold besides its abstract, front and back matter to count
 * as full text, about 300 words. arXiv's abstract page for 10.48550/arXiv.1706.03762
 * converted to 2,357 characters, abstract and metadata only, and passed the
 * 500-character check as full text (2026-10-20).
 */
const MIN_BODY_CHARS = 2000;
/** The most of an "Abstract" section taken for the abstract: past it, the page has nested its body under that heading. */
const MAX_ABSTRACT_CHARS = 3000;
/** Europe PMC's REST API; `<PMCID>/fullTextXML` returns an open-access article as JATS XML. */
const EUROPE_PMC_FULLTEXT = "https://www.ebi.ac.uk/europepmc/webservices/rest/";
const isPmid = (id: string): boolean => /^\d+$/.test(id);
/** Ids Europe PMC's full-text API takes as they are: PMCIDs, and preprint ids (for preprints it has the text of). */
const EUROPE_PMC_ID = /^(?:PMC|PPR)\d+$/i;
/**
 * The ids of Europe PMC's other sources, as its search returns them (checked 2026-11-16, each found again by its exact
 * id query): "SRC:digits" for the numeric ids of a source other than MED, which would collide with PMIDs (CBA:644335 of
 * Chinese Biological Abstracts, ETH:836421), and letters then digits for the rest (IND609546324 of AGR, US2012071552
 * and WO2012049332 of PAT, C2201 of CTX, NBK625970). A bare number is a PMID.
 */
const EUROPE_PMC_OTHER_ID = /^(?:[A-Za-z]{3}:\d+|[A-Za-z]{1,5}\d[A-Za-z0-9]*)$/;
/** ChinaRxiv's ids, as its API issues them (2026-11-16): ChinaXiv's `chinaxiv-YYYYMM.NNNNN`, RussiaRxiv's `ru-YYYYMM.NNNNN`. */
const CHINARXIV_ID = /^(chinaxiv|ru)-\d{6}\.\d+$/i;
/** Sources whose texts are open access, and so may be cached. */
const OPEN_ACCESS_SOURCES: ReadonlySet<string> = new Set(["europepmc", "unpaywall"]);
/**
 * How long a proxy or direct text is kept in memory after its last part was read. Each part must
 * come from the same text, and a later call can resolve the article differently: an Unpaywall
 * lookup that failed can answer, a publisher that answered can refuse. Such a text never enters
 * the {@link Cache}, which can outlive the session; this store dies with the process.
 */
const READING_TTL_MS = 30 * 60 * 1000;
/**
 * The most characters of text kept in memory while read, per cache: about 20 MB, a hundred or more
 * articles. The hosted server shares one cache between its users, so a small store would let other
 * readings push one out before its last part.
 */
const READING_MAX_CHARS = 10_000_000;

/** A resource fetched from an arbitrary URL. Either `text` (HTML) or `bytes` (PDF) is set. */
export interface FetchedResource {
  ok: boolean;
  status: number;
  contentType: string;
  /** URL after redirects — used as the base for relative links during HTML extraction. */
  finalUrl: string;
  text?: string;
  bytes?: Uint8Array;
}

/**
 * What `fetchFulltext` asks of the adapter of a database whose ids PubMed doesn't know: a record by id,
 * and from ChinaRxiv's the complete record and the translated text.
 */
export type RecordSource = Pick<DatabaseAdapter, "fetch" | "fetchFull"> & {
  /** The text of a record, or null when there is none; throws when the request fails. */
  fetchText?(id: string): Promise<string | null>;
};

/** The databases whose records `fetchFulltext` reads for an id PubMed doesn't know. */
export type RecordDatabase = "europepmc" | "chinaxiv" | "russiarxiv";

/** Injectable seams. Defaults hit the network and load the extraction libraries. */
export interface FulltextDeps {
  /** Unpaywall client. Defaults to one configured from env, for the NCBI client's `tool`. */
  unpaywall?: UnpaywallClient;
  /**
   * The adapter holding the records of a database, for an id that isn't a PMID: the abstract, the DOI
   * Europe PMC has for a preprint, and ChinaRxiv's translated text. Defaults to the registry's, so a
   * search's records, which the adapters keep in memory and in the cache, are found without a request.
   * Returns undefined for a database it has no adapter for.
   */
  adapter?: (database: RecordDatabase) => RecordSource | undefined | Promise<RecordSource | undefined>;
  /** Fetch a URL, classifying the body as HTML text or PDF bytes. */
  fetchUrl?: (url: string, timeoutMs: number) => Promise<FetchedResource>;
  /** Reduce an HTML document to the article body and convert it to markdown. */
  htmlToMarkdown?: (html: string, url: string) => Promise<string>;
  /** Convert a JATS XML article (Europe PMC's full-text API) to markdown. */
  jatsToMarkdown?: (xml: string) => Promise<string>;
  /** Extract plain text from a PDF. */
  pdfToText?: (bytes: Uint8Array) => Promise<string>;
  /** Institutional proxy prefix. Defaults to $MED_RESEARCH_PROXY_PREFIX. */
  proxyPrefix?: string;
  /** The most characters returned per call, and the ceiling for `FulltextInput.maxChars`. Defaults to $MED_RESEARCH_FULLTEXT_MAX_CHARS, then 50000. */
  maxChars?: number;
  /** Per-fetch timeout in ms. Default 20000. */
  timeoutMs?: number;
  /** Clock, injectable for tests. Defaults to Date.now. */
  now?: () => number;
}

interface Extracted {
  fulltext: string;
  format: "markdown" | "pdf";
  /** Said with the text: that it is a machine translation. */
  warning?: string;
}

type Source = Exclude<FulltextSource, "none">;

/** A proxy or direct text being read in parts. */
interface Reading extends Extracted {
  source: Source;
  doi: string | undefined;
}

/**
 * The texts being read in parts, per cache: callers that share a cache share what it holds, and
 * keys include the proxy, so a text is only served to a caller who would fetch it the same way.
 * Calls carry no reader's identity, so the latest reading of an article from its start is the one
 * continued: two callers reading the same article at once, one from a proxy or direct text and one
 * from an open-access copy, can get each other's parts.
 */
const readings = new WeakMap<Cache, LRUCache<string, Reading>>();

function readingsOf(cache: Cache): LRUCache<string, Reading> {
  let store = readings.get(cache);
  if (!store) {
    store = new LRUCache({
      maxSize: READING_MAX_CHARS,
      sizeCalculation: (r: Reading) => Math.max(1, r.fulltext.length),
      ttl: READING_TTL_MS,
      updateAgeOnGet: true,
    });
    readings.set(cache, store);
  }
  return store;
}

/** Why a location yielded no full text, for the fallback warning. */
interface Miss {
  source: Source;
  kind: "status" | "refused" | "unreachable" | "abstract-only" | "no-text";
  /** HTTP status, and the host that answered it, for `kind: "status"`. */
  status?: number;
  host?: string;
}

/**
 * Resolve and return the full text of a PubMed article, a PMC article or a Europe
 * PMC preprint, or of any article by its DOI.
 *
 * @param cache reused across calls; caches open-access full texts for 30 days.
 * @param client injectable NCBI client, used to look up the DOI, PMCID and abstract.
 * @param deps injectable fetch/extraction seams; defaults hit the network.
 */
export async function fetchFulltext(
  input: FulltextInput,
  cache: Cache = new LRUBackend(),
  client: NcbiClient = new NcbiClient(),
  deps: FulltextDeps = {},
): Promise<FulltextOutput> {
  const id = String(input.id ?? "").trim();
  const inputDoi = normalizeDoi(input.doi);
  // A numeric PMID, an id Europe PMC's full-text API takes, a ChinaRxiv id, another id Europe PMC may hold
  // a record of, or a supplied DOI is enough to proceed. Any other id can arrive with a DOI, and DOI-based
  // resolution is database-agnostic. Without one there's nothing to resolve.
  const europePmcId = EUROPE_PMC_ID.test(id) ? id.toUpperCase() : undefined;
  // ChinaXiv and RussiaRxiv ids are lowercase, as the API issues them; the corpus is the id's prefix.
  const chinarxivMatch = CHINARXIV_ID.exec(id);
  const chinarxivId = chinarxivMatch ? id.toLowerCase() : undefined;
  const chinarxivCorpus: RecordDatabase | undefined = chinarxivMatch ? (chinarxivMatch[1]!.toLowerCase() === "ru" ? "russiarxiv" : "chinaxiv") : undefined;
  // An id of Europe PMC's other sources (CBA:…, IND…): looked up there like a preprint's. The checks above come first, so
  // that neither a ChinaRxiv id (it has a hyphen) nor a bare number (a PMID) can reach it.
  const otherId = !isPmid(id) && !europePmcId && !chinarxivId && EUROPE_PMC_OTHER_ID.test(id) ? id.toUpperCase() : undefined;
  if (!isPmid(id) && !inputDoi && !europePmcId && !chinarxivId && !otherId) {
    // A doi that was given but isn't one (a record's url, say) is a mistake to name, not a missing doi.
    if (input.doi?.trim()) throw errors.notADoi(input.doi.trim());
    throw errors.noDoi(String(input.id ?? ""), false);
  }

  const offset = input.offset ?? 0;
  if (!Number.isInteger(offset) || offset < 0) throw errors.invalidInput("offset must be a whole number of characters, 0 or more.");
  if (input.maxChars !== undefined && (!Number.isInteger(input.maxChars) || input.maxChars < 1)) {
    throw errors.invalidInput("maxChars must be a whole number of characters, 1 or more.");
  }
  const limit = deps.maxChars ?? envMaxChars() ?? DEFAULT_MAX_CHARS;
  const maxChars = Math.min(input.maxChars ?? limit, limit);
  const now = deps.now ?? Date.now;
  const proxyPrefix = deps.proxyPrefix === undefined ? envSetting("MED_RESEARCH_PROXY_PREFIX") : deps.proxyPrefix.trim() || undefined;

  // The key records of this id are kept under: the id as Europe PMC and ChinaRxiv write it.
  const recordId = chinarxivId ?? europePmcId ?? otherId ?? id;
  // What the call knows of the article's record. `article` is the summary used to resolve it (below); `looked` holds
  // the records fetched on the way, so that a cache that stores nothing doesn't hide them from the warning.
  let article: Article | null = null;
  const looked: Article[] = [];
  /** The warning's first words: what the records say about the article's standing (see {@link standingNote}). */
  const standing = (...more: (Article | undefined)[]): string | undefined =>
    standingNote([article, ...looked, ...more, ...cachedRecords(cache, recordId)]);

  // The part asked for. A proxy or direct text that goes on is kept for the next part, and any
  // other text replaces it: the next part comes from the text this one came from.
  const reading = readingsOf(cache);
  const readingKey = `${id}\n${proxyPrefix ?? ""}`;
  const serve = (text: Extracted, source: Source, doi: string | undefined): FulltextOutput => {
    // The standing is read from the records at every call, never stored with a text: a text cached for 30 days
    // is served with the warning of a retraction recorded after it was cached.
    const warning = joinNotes(standing(), text.warning);
    const out: FulltextOutput = {
      id,
      ...(doi ? { doi } : {}),
      source,
      ...part(text.fulltext, offset, maxChars),
      format: text.format,
      ...(warning ? { warning } : {}),
    };
    if (out.truncated && !OPEN_ACCESS_SOURCES.has(source)) reading.set(readingKey, { ...text, source, doi });
    else reading.delete(readingKey);
    return out;
  };

  // 1. A text being read in parts, then a cached one: either holds the whole text, so every part is cheap.
  const current = offset > 0 ? reading.get(readingKey) : undefined;
  if (current) return serve(current, current.source, current.doi);
  // Only open-access texts count: 0.5.0 also cached proxy and direct texts, which a persistent cache may still hold.
  const cached = cache.getFulltext(id);
  if (cached && OPEN_ACCESS_SOURCES.has(cached.source)) {
    return serve(cached, cached.source as Source, inputDoi ?? cachedRecords(cache, recordId).map((r) => normalizeDoi(r.doi)).find(Boolean));
  }

  // 2. Resolve a DOI (from the argument, a cached summary, or a fresh esummary) and a PMCID.
  article = cache.getSummary(recordId) ?? cache.getSummary(ownSummaryKey(recordId));
  let doi = inputDoi ?? normalizeDoi(article?.doi);
  if (!doi && !article && isPmid(id)) {
    const summaries = await client.esummary([id]);
    article = summaries.get(id) ?? null;
    // Not under the bare PMID, where search and fetch keep summaries that efetch has completed: esummary's lacks the
    // links and MeSH, and one next to a cached abstract would keep them from asking efetch for them.
    if (article) cache.setSummary(ownSummaryKey(id), article);
    doi = normalizeDoi(article?.doi);
  }

  // The record of an id PubMed doesn't know, from the database that holds it. Looked up once, when first needed.
  const adapterFor = deps.adapter ?? defaultAdapter;
  let recordLookup: Promise<Article | undefined> | undefined;
  const record = (): Promise<Article | undefined> =>
    (recordLookup ??= lookUpRecord(recordId, chinarxivCorpus, cache, adapterFor).then((found) => {
      // ChinaRxiv's is passed to the warning where it is read: its text may be served in parts.
      if (found && !chinarxivId) looked.push(found);
      return found;
    }));

  // The abstract: the landing-page check needs it, and the fallback returns it. Looked up once, when first needed.
  let abstractLookup: Promise<string | undefined> | undefined;
  const abstract = (): Promise<string | undefined> =>
    (abstractLookup ??= resolveAbstract(id, article, cache, client, record, (record) => looked.push(record)));

  // An id of Europe PMC's other sources, given without a DOI, is what Europe PMC's record of it makes it: the abstract,
  // and a DOI when the record has one (a PMCID, as for a preprint, too). No record, nothing to go by.
  if (otherId && !article && !doi) {
    article = (await record()) ?? null;
    if (!article) throw input.doi?.trim() ? errors.notADoi(input.doi.trim()) : errors.noDoi(id, true);
    doi = normalizeDoi(article.doi);
  }
  const pmcid = europePmcId ?? (article?.pmcid && EUROPE_PMC_ID.test(article.pmcid) ? article.pmcid.toUpperCase() : undefined);

  // No DOI, PMCID or ChinaRxiv id → nothing to hand to a text or OA lookup. Degrade to the abstract.
  if (!doi && !pmcid && !chinarxivId) {
    if (!article) throw errors.notFound(id);
    const text = await abstract();
    // The record's url is all there is to go on for an id without a DOI (a patent's page, a Bookshelf book's).
    const reason = isPmid(id)
      ? "Could not resolve a DOI for this id, so no full-text source could be tried."
      : `Europe PMC's record for this id has no DOI, so no full-text source could be tried.${article.url ? ` A browser may open ${article.url}.` : ""}`;
    return noneResult(id, undefined, text, offset, reason, standing());
  }

  const timeoutMs = deps.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const fetchUrl = deps.fetchUrl ?? defaultFetchUrl;
  const htmlToMarkdown = deps.htmlToMarkdown ?? defaultHtmlToMarkdown;
  const jatsToMarkdown = deps.jatsToMarkdown ?? defaultJatsToMarkdown;
  const pdfToText = deps.pdfToText ?? defaultPdfToText;

  // Fetch a URL and turn its body into text, or say why it yielded none.
  const extract = async (url: string, source: Source): Promise<Extracted | Miss> => {
    let res: FetchedResource;
    try {
      res = await fetchUrl(url, timeoutMs);
    } catch (err) {
      return { source, kind: err instanceof BlockedUrlError && err.reason === "address" ? "refused" : "unreachable" };
    }
    if (!res.ok) return { source, kind: "status", status: res.status, host: hostOf(res.finalUrl) ?? hostOf(url) };
    try {
      if (res.bytes) {
        const text = (await pdfToText(res.bytes)).trim();
        return text.length >= MIN_FULLTEXT_CHARS ? { fulltext: text, format: "pdf" } : { source, kind: "no-text" };
      }
      if (res.text != null) {
        if (url.startsWith(EUROPE_PMC_FULLTEXT)) {
          // "" when Europe PMC has the article only as an abstract (see defaultJatsToMarkdown).
          const md = (await jatsToMarkdown(res.text)).trim();
          return md.length >= MIN_FULLTEXT_CHARS ? { fulltext: md, format: "markdown" } : { source, kind: "abstract-only" };
        }
        const page = readPage((await htmlToMarkdown(res.text, res.finalUrl)).trim());
        if (page.markdown.length < MIN_FULLTEXT_CHARS) return { source, kind: "no-text" };
        if (!isArticleBody(page, await abstract())) return { source, kind: "abstract-only" };
        return { fulltext: page.markdown, format: "markdown" };
      }
    } catch {
      /* an extraction library failed on this body */
    }
    return { source, kind: "no-text" };
  };

  // 3. Try each source's URLs in order; the first that yields a full text wins.
  const misses: Miss[] = [];
  const tried = new Set<string>();
  const attempt = async (source: Source, urls: string[]): Promise<FulltextOutput | null> => {
    for (const url of urls) {
      if (tried.has(url)) continue;
      tried.add(url);
      const got = await extract(url, source);
      if ("kind" in got) {
        misses.push(got);
        continue;
      }
      // Only open-access texts are cached. A proxy or direct text may be licensed to
      // this user alone, and the cache can outlive the session or serve other callers.
      if (OPEN_ACCESS_SOURCES.has(source)) {
        cache.setFulltext(id, { source, fulltext: got.fulltext, format: got.format, fetchedAt: now() });
      }
      return serve(got, source, doi);
    }
    return null;
  };

  // ChinaRxiv's API holds the text of a ChinaXiv or RussiaRxiv record, as a machine translation. The request
  // goes to the adapter's own host with its headers and rate limit; the id has been checked against CHINARXIV_ID.
  if (chinarxivId && chinarxivCorpus) {
    const source = "chinarxiv";
    try {
      const adapter = await adapterFor(chinarxivCorpus);
      const text = (await adapter?.fetchText?.(chinarxivId)) ?? "";
      if (text.length >= MIN_FULLTEXT_CHARS) {
        // In the text's own warning, which every part carries: a ChinaRxiv text is read in parts from memory.
        const found = await record();
        const note = joinNotes(standingNote([found]), translationNote(found));
        return serve({ fulltext: text, format: "markdown", ...(note ? { warning: note } : {}) }, source, doi);
      }
      misses.push({ source, kind: "no-text" });
    } catch (err) {
      const rateLimited = isMedResearchError(err) && err.code === "RATE_LIMIT";
      misses.push(rateLimited ? { source, kind: "status", status: 429, host: "chinarxiv.org" } : { source, kind: "unreachable" });
    }
  }
  if (pmcid) {
    const out = await attempt("europepmc", [`${EUROPE_PMC_FULLTEXT}${pmcid}/fullTextXML`]);
    if (out) return out;
  }
  // An id without a DOI is a PMCID or preprint id here (or a ChinaRxiv one): the record may carry the DOI the
  // caller didn't have, which opens the Unpaywall and direct routes (a preprint's copy at medRxiv, say).
  if (!doi && !isPmid(id)) doi = normalizeDoi((await record())?.doi);
  const unpaywall = deps.unpaywall ?? new UnpaywallClient({ tool: client.tool });
  let unpaywallAnswer: UnpaywallLookup | undefined;
  if (doi) {
    unpaywallAnswer = await safeLookup(unpaywall, doi);
    const urls = unpaywallAnswer.status === "found" ? openAccessUrls(unpaywallAnswer.result.urls) : [];
    const unpaywallOut = await attempt("unpaywall", urls);
    if (unpaywallOut) return unpaywallOut;
    if (proxyPrefix) {
      const out = await attempt("proxy", [proxyUrl(proxyPrefix, doi)]);
      if (out) return out;
    }
    const out = await attempt("direct", [`https://doi.org/${doi}`]);
    if (out) return out;
  }

  // 4. Fallback — nothing resolved. Return the abstract with what each location answered.
  const text = await abstract();
  const chinarxivRecord = chinarxivId ? await record() : undefined;
  const doiUnknown = misses.some((m) => m.source === "direct" && m.kind === "status" && (m.status === 404 || m.status === 410) && m.host === "doi.org");
  if (doi && doiUnknown && !text) throw errors.doiNotFound(doi);
  return noneResult(
    id,
    doi,
    text,
    offset,
    fallbackWarning({
      doi,
      pmcid,
      unpaywall: unpaywallAnswer,
      unpaywallSharedContact: unpaywall.sharedContact,
      proxyConfigured: Boolean(proxyPrefix),
      misses,
      abstractNotes: chinarxivId && text ? abstractNotes(chinarxivRecord) : [],
    }),
    standing(chinarxivRecord),
  );
}

// ─── Resolution helpers ─────────────────────────────────────────

/**
 * Unpaywall's open-access URLs, in its order, with PMC and Europe PMC pages
 * replaced. Both allow automated downloading of articles only through their
 * APIs and bulk services: "Do not use any other automated processes for
 * downloading articles, even if you are only retrieving articles from the PMC
 * Article Datasets" (https://pmc.ncbi.nlm.nih.gov/about/copyright/, checked
 * 2026-10-19), and Europe PMC names its OAI, RESTful, SOAP and bulk services
 * as the only ones for automated downloading (https://europepmc.org/Copyright).
 * So a PMC or Europe PMC page becomes a request to Europe PMC's full-text API
 * for its PMCID, or is dropped when it has none.
 */
function openAccessUrls(urls: string[]): string[] {
  const out: string[] = [];
  for (const url of urls) {
    let parsed: URL;
    try {
      parsed = new URL(url);
    } catch {
      continue;
    }
    const host = parsed.hostname.toLowerCase();
    let target: string | null = url;
    if (host === "pmc.ncbi.nlm.nih.gov" || (/(^|\.)ncbi\.nlm\.nih\.gov$/.test(host) && /^\/pmc\//i.test(parsed.pathname))) {
      // Unpaywall's usual form is ".../pmc/articles/4974751", without the PMC prefix.
      const number = /\/articles\/(?:PMC)?(\d+)/i.exec(parsed.pathname)?.[1] ?? /PMC(\d+)/i.exec(parsed.search)?.[1];
      target = number ? `${EUROPE_PMC_FULLTEXT}PMC${number}/fullTextXML` : null;
    } else if (/(^|\.)europepmc\.org$/.test(host)) {
      // PMC articles and preprints (PPR…) have full text in the API; abstract pages don't.
      const id = /\b(PMC\d+|PPR\d+)\b/i.exec(parsed.pathname + parsed.search)?.[1];
      target = id ? `${EUROPE_PMC_FULLTEXT}${id.toUpperCase()}/fullTextXML` : null;
    }
    if (target && !out.includes(target)) out.push(target);
  }
  return out;
}

/** The client's answer; an injected client that throws counts as a failed lookup. */
async function safeLookup(client: UnpaywallClient, doi: string): Promise<UnpaywallLookup> {
  try {
    return await client.lookup(doi);
  } catch {
    return { status: "failed" };
  }
}

function proxyUrl(prefix: string, doi: string): string {
  return `${prefix.replace(/\/+$/, "")}/${doi}`;
}

function hostOf(url: string): string | undefined {
  try {
    return new URL(url).hostname.toLowerCase();
  } catch {
    return undefined;
  }
}

/**
 * The record behind an id PubMed doesn't know, as its database's adapter has it: ChinaXiv's or RussiaRxiv's
 * for a ChinaRxiv id (`corpus`), Europe PMC's for any other. `fetch` answers from the adapter's memo of search
 * results and from the cache, where it stores each record under "<database>:<id>" ("europepmc:CBA:644599"),
 * before it asks the database for that exact id, so a record a search found costs no request. A Europe PMC
 * record is also kept under the bare id, so that the next call finds its DOI and abstract at once (these ids
 * are never PMIDs, whose summaries are kept apart: see {@link ownSummaryKey}). A ChinaRxiv record comes from
 * `fetchFull`, as complete as the API has it: its search endpoint cuts abstracts. A failed lookup is no
 * record: callers carry on without.
 */
async function lookUpRecord(
  id: string,
  corpus: RecordDatabase | undefined,
  cache: Cache,
  adapterFor: NonNullable<FulltextDeps["adapter"]>,
): Promise<Article | undefined> {
  try {
    const adapter = await adapterFor(corpus ?? "europepmc");
    if (corpus) return (await adapter?.fetchFull?.([id], cache))?.[0];
    const found = (await adapter?.fetch([id], cache))?.[0];
    if (found) cache.setSummary(id, found);
    return found;
  } catch {
    return undefined;
  }
}

/** The adapters of the registry, loaded on first use so that importing this module stays cheap. */
const defaultAdapter: NonNullable<FulltextDeps["adapter"]> = async (database) => (await import("./adapters/registry.js")).getAdapter(database);

/**
 * What to say with ChinaRxiv's text: it is a machine translation, to check against the original. Nothing for
 * a record whose original is English; a record that couldn't be read counts as translated, as in search.
 */
function translationNote(record: Article | undefined): string | undefined {
  if (record && !record.machineTranslated) return undefined;
  const original = record?.originalUrl ? ` at ${record.originalUrl}` : " (its originalUrl is in the record literature_fetch returns)";
  return `Machine translation into English by ChinaRxiv, a third-party service, not the authors' wording: check numbers and claims against the original${original} before relying on them.`;
}

/** What to say with the abstract of a ChinaXiv or RussiaRxiv record returned in place of its text. */
function abstractNotes(record: Article | undefined): string[] {
  const notes = [translationNote(record)];
  if (record?.machineGeneratedAbstract) notes.push("ChinaRxiv wrote this abstract, not the authors.");
  if (record?.abstractTruncated) notes.push("The abstract is cut at 500 characters, as ChinaRxiv's search shows it: its full record couldn't be read.");
  return notes.filter((n): n is string => n !== undefined);
}

// ─── What the records say about the article's standing ──────────

/**
 * Where the summary this module got from esummary is kept. Not the bare PMID, which search and fetch keep
 * summaries under only after efetch has completed them (pubmed.ts: "a summary is cached only once efetch has
 * succeeded for it"): esummary's has the publication types but not the correction links or MeSH (the NcbiClient
 * parses `pubtype`, not `references`), and under that key, next to an abstract cached by an earlier search, it
 * would keep search and fetch from ever asking efetch for them.
 */
const ownSummaryKey = (id: string): string => `fulltext:${id}`;

/**
 * Every record of an id the cache holds, from an earlier search, fetch or lookup. PubMed searches and fetches keep
 * summaries under the bare PMID, with publication types and correction links; Europe PMC's adapter keeps its
 * records under "europepmc:<id>" (whole `core` records, with both) and this module under the bare id (a record it
 * looked up) or {@link ownSummaryKey} (esummary's, publication types only). ChinaXiv and RussiaRxiv records
 * carry neither, and are read where they are fetched.
 */
function cachedRecords(cache: Cache, id: string): Article[] {
  return [cache.getSummary(id), cache.getSummary(`europepmc:${id}`), cache.getSummary(ownSummaryKey(id))].filter((r): r is Article => r !== null);
}

/** The notes that exist, in order, as one text; undefined when there are none. */
function joinNotes(...notes: (string | undefined)[]): string | undefined {
  const present = notes.filter((n): n is string => Boolean(n));
  return present.length > 0 ? present.join(" ") : undefined;
}

/** The notice kinds a notice record's publication types name, with the grader's NOTICE types (grader.ts). */
const NOTICE_KINDS: readonly [RegExp, string][] = [
  [/retraction/i, "a retraction notice"],
  [/expression of concern/i, "an expression of concern"],
  [/erratum/i, "an erratum"],
];

/**
 * What the records of an article say about its standing, to open the warning: retracted, a notice about another
 * paper, or an expression of concern. It is what the records say and no more: the flags are those of
 * literature_search (classifyDesign), so "retracted" is NLM's "Retracted Publication" type, a "Retraction in"
 * link, or a publisher's "RETRACTED:" title marker. A retraction one record has counts for the paper, as in
 * mergeDuplicate. undefined when no record is known or none is flagged.
 *
 * Whether a record shows a flag depends on what the record has. Checked 2026-11-16: PubMed's esummary for
 * PMID 33247380 has the "Retracted Publication" type and a "Retraction in" reference (to PMID 38512453), while
 * for PMID 27578231 it has no type that marks its expression of concern, only an "Expression of concern in"
 * reference (to PMID 42781840), which NcbiClient.esummary doesn't read: from esummary alone the retraction shows
 * (by its type, without the notice's id) and the expression of concern doesn't. Europe PMC's `core` records have
 * "Retracted Publication" in pubTypeList and the link, with the notice's id, in commentCorrectionList.
 */
function standingNote(records: readonly (Article | null | undefined)[]): string | undefined {
  const graded = records.filter((r): r is Article => Boolean(r)).map((record) => ({ record, flags: classifyDesign(record).flags }));
  const having = (flag: RecordFlag): Article[] => graded.filter((g) => g.flags.includes(flag)).map((g) => g.record);
  /** The notices that the records flagged `flag` link to by `type`, named by database and id. */
  const linked = (flag: RecordFlag, type: CorrectionType): string => {
    const ids = having(flag).flatMap((r) => (r.corrections ?? []).filter((c) => c.type === type && c.id).map((c) => `${r.database ?? "pubmed"} ${c.id}`));
    const unique = [...new Set(ids)];
    return unique.length > 0 ? ` Linked notice${unique.length > 1 ? "s" : ""}: ${unique.join(", ")} (literature_fetch).` : "";
  };

  const notes: string[] = [];
  if (having("retracted").length > 0) {
    notes.push(`RETRACTED: this record is flagged "retracted" (as in literature_search): do not use its findings as evidence.${linked("retracted", "RetractionIn")}`);
  }
  const notices = having("notice");
  if (notices.length > 0) {
    const kinds = NOTICE_KINDS.filter(([kind]) => notices.some((r) => r.publicationTypes.some((t) => kind.test(t)))).map(([, name]) => name);
    notes.push(`NOTICE: this record is ${kinds.length > 0 ? kinds.join(" and ") : "a notice"} (flag "notice"), not a study: its text is no evidence for a claim.`);
  }
  if (having("expression-of-concern").length > 0) {
    notes.push(`EXPRESSION OF CONCERN: one is linked to this record (flag "expression-of-concern"): read the notice before relying on its findings.${linked("expression-of-concern", "ExpressionOfConcernIn")}`);
  }
  return joinNotes(...notes);
}

/** What efetch returns for a PMID (see NcbiClient.efetch). */
type Efetched = Awaited<ReturnType<NcbiClient["efetch"]>> extends Map<string, infer D> ? D : never;

/**
 * The summary with what efetch adds, as pubmed.ts applies it: efetch is the only source of the correction links (a
 * retraction notice's id, an expression of concern) and MeSH, and is at least as fresh as a summary, so its values
 * replace the summary's.
 */
function withEfetch(article: Article, data: Efetched): Article {
  const { meshHeadings: _mesh, corrections: _corrections, ...rest } = article;
  return {
    ...rest,
    ...(data.publicationTypes?.length ? { publicationTypes: data.publicationTypes } : {}),
    ...(data.meshHeadings?.length ? { meshHeadings: data.meshHeadings } : {}),
    ...(data.corrections?.length ? { corrections: data.corrections } : {}),
  };
}

/**
 * The abstract of `id`, from the cache, the summary, another database's record, or PubMed's efetch. Efetch also
 * names the record's publication types and correction links: `learn` gets the record they complete, which the
 * warning reads, and the summary is cached with them under the bare PMID, where search and fetch keep theirs.
 */
async function resolveAbstract(
  id: string,
  article: Article | null,
  cache: Cache,
  client: NcbiClient,
  record: () => Promise<Article | undefined>,
  learn: (record: Article) => void,
): Promise<string | undefined> {
  const cached = cache.getAbstract(id);
  if (cached) return cached;
  if (article?.abstract) return article.abstract;
  // PubMed's efetch knows only PMIDs. Any other id is a record of another database, asked there.
  if (!isPmid(id)) return (await record())?.abstract;
  try {
    const data = (await client.efetch([id])).get(id);
    if (data) {
      // Without a summary (a DOI was given with the PMID) the record is only what efetch says of it, and isn't cached.
      const completed = withEfetch(article ?? { pmid: id, title: "", authors: [], journal: "", pubDate: "", publicationTypes: [] }, data);
      if (article) cache.setSummary(id, completed);
      learn(completed);
    }
    const abstract = data?.abstract;
    if (abstract) {
      cache.setAbstract(id, abstract);
      return abstract;
    }
  } catch {
    /* best-effort — the fallback is allowed to have no text at all */
  }
  return undefined;
}

/**
 * The fallback: the abstract, and why there is no full text, after the article's `standing` when its records
 * give one. A caller reading on from an offset gets no text, since it would take the abstract for the next
 * part of the full text it was reading.
 */
function noneResult(
  id: string,
  doi: string | undefined,
  abstract: string | undefined,
  offset: number,
  reason: string,
  standing: string | undefined,
): FulltextOutput {
  const returned =
    offset > 0
      ? `No full text found, so there is no part from offset ${offset}; call without offset for the abstract.`
      : abstract
        ? "No full text found; returned the abstract only."
        : "No full text found, and no abstract is available.";
  return {
    id,
    ...(doi ? { doi } : {}),
    source: "none",
    ...(abstract && offset === 0 ? { fulltext: abstract } : {}),
    format: "markdown",
    truncated: false,
    warning: joinNotes(standing, reason ? `${returned} ${reason}` : returned)!,
  };
}

/** What a location's answer means, completing "<location> …". */
function describeMiss(miss: Miss): string {
  switch (miss.kind) {
    case "status":
      if (miss.status === 401 || miss.status === 402 || miss.status === 403) {
        return `refused access (HTTP ${miss.status}): the article is paywalled, or the site blocks automated clients`;
      }
      if (miss.status === 404 || miss.status === 410) return `has no such page (HTTP ${miss.status})`;
      if (miss.status === 429) return "rate-limited the request (HTTP 429)";
      return `answered HTTP ${miss.status}`;
    case "abstract-only":
      return "showed little beyond the abstract: a paywalled landing page, or a very short article";
    case "no-text":
      return "had no article text to extract";
    case "unreachable":
      return "couldn't be reached";
    case "refused":
      return "was refused for its network address";
  }
}

/** Paywalled, or a landing page: what an institutional proxy can get past. */
const looksPaywalled = (miss: Miss): boolean =>
  miss.kind === "abstract-only" || (miss.kind === "status" && [401, 402, 403].includes(miss.status ?? 0));

/** The fallback's reason: what each source answered, and what the user can do about it. */
function fallbackWarning(ctx: {
  doi: string | undefined;
  pmcid: string | undefined;
  /** What Unpaywall answered; undefined when there was no DOI to ask about. */
  unpaywall: UnpaywallLookup | undefined;
  /** Whether Unpaywall requests carry the project's shared contact address. */
  unpaywallSharedContact: boolean;
  proxyConfigured: boolean;
  misses: Miss[];
  /** What to say about the abstract being returned (a machine translation, a cut preview), at the end. */
  abstractNotes: string[];
}): string {
  const parts: string[] = [];
  const of = (source: Source): Miss[] => ctx.misses.filter((m) => m.source === source);

  const chinarxiv = of("chinarxiv")[0];
  if (chinarxiv) parts.push(chinarxiv.kind === "no-text" ? "ChinaRxiv has no text for this record." : `ChinaRxiv ${describeMiss(chinarxiv)}.`);

  const europePmc = of("europepmc")[0];
  if (europePmc && ctx.pmcid) {
    parts.push(
      europePmc.kind === "status" && europePmc.status !== 429
        ? `Europe PMC has no open-access full text for ${ctx.pmcid}.`
        : `Europe PMC's full text for ${ctx.pmcid} ${describeMiss(europePmc)}.`,
    );
  }
  const unpaywall = ctx.unpaywall;
  if (unpaywall?.status === "off") {
    parts.push("Open-access copies weren't looked up: Unpaywall is turned off (MED_RESEARCH_UNPAYWALL=0) or has no contact email.");
  } else if (unpaywall?.status === "failed") {
    const status = unpaywall.httpStatus;
    const answer = status === undefined ? "couldn't be reached" : status === 429 ? "rate-limited the lookup (HTTP 429)" : `answered HTTP ${status}`;
    parts.push(`Unpaywall ${answer}, so open-access copies weren't looked up.`);
    // A client error may be about the address, which every installation without its own shares.
    if (ctx.unpaywallSharedContact && status !== undefined && status >= 400 && status < 500) {
      parts.push("The lookup carried the project's shared contact address: set your own in NCBI_EMAIL or MED_RESEARCH_UNPAYWALL_EMAIL.");
    }
  } else if (unpaywall) {
    const reasons = [...new Set(of("unpaywall").map(describeMiss))];
    if (reasons.length > 0) {
      parts.push(`None of Unpaywall's open-access copies yielded the text (${reasons.join("; ")}).`);
    } else {
      // "found" with nothing tried: its only copies were PMC's or Europe PMC's, already tried by PMCID or not fetchable.
      parts.push(unpaywall.status === "found" && ctx.pmcid ? "Unpaywall lists no other open-access copy." : "Unpaywall found no open-access copy.");
    }
  }
  const proxy = of("proxy")[0];
  if (proxy) parts.push(`The proxy ${describeMiss(proxy)}; it works only if it lets this machine in without a login.`);
  const direct = of("direct")[0];
  if (direct) {
    if (direct.kind === "status" && direct.host === "doi.org" && (direct.status === 404 || direct.status === 410)) {
      parts.push(`doi.org has no record of DOI ${ctx.doi}: check it.`);
    } else {
      const site = direct.kind === "status" && direct.host && direct.host !== "doi.org" ? `The publisher's site (${direct.host})` : `The publisher's site`;
      parts.push(`${site} ${describeMiss(direct)}.`);
      if (!ctx.proxyConfigured && looksPaywalled(direct)) {
        parts.push("If your institution licenses the journal, MED_RESEARCH_PROXY_PREFIX can reach it through the institution's proxy.");
      }
      parts.push(`A browser may still open https://doi.org/${ctx.doi}.`);
    }
  }
  if (ctx.misses.some((m) => m.kind === "refused")) {
    parts.push(
      "Some locations were refused because their host names resolve to private or reserved network addresses, " +
        "as they do behind a fake-IP DNS proxy (Clash, Surge or sing-box in TUN mode). On a personal machine, set " +
        "MED_RESEARCH_FULLTEXT_ALLOW_PRIVATE=1 to allow them; never on a shared server.",
    );
  }
  parts.push(...ctx.abstractNotes);
  return parts.join(" ");
}

/**
 * The part of a full text from `offset`, at most `maxChars` long. When the text goes on, the part
 * ends after the last paragraph break, line break or space in its final fifth, if there is one, so
 * that it doesn't stop mid-word, and never between the two halves of a surrogate pair; `nextOffset`
 * is where the next part starts. Parts join up to the whole text. Throws INVALID_INPUT for an offset
 * past the end.
 */
function part(
  text: string,
  offset: number,
  maxChars: number,
): Pick<FulltextOutput, "fulltext" | "truncated" | "totalChars" | "nextOffset"> {
  if (offset > 0 && offset >= text.length) {
    throw errors.invalidInput(`offset ${offset} is past the end of the text, which has ${text.length} characters.`);
  }
  const end = offset + maxChars;
  const rest = { fulltext: text.slice(offset), truncated: false, totalChars: text.length };
  if (end >= text.length) return rest;
  const floor = end - Math.floor(maxChars / 5);
  let cut = end;
  for (const breakAt of ["\n\n", "\n", " "]) {
    const at = text.lastIndexOf(breakAt, end - breakAt.length);
    if (at >= floor && at > offset) {
      cut = at + breakAt.length;
      break;
    }
  }
  // A character outside the BMP (𝛼, an emoji) is two code units: keep them in one part.
  if (isHighSurrogate(text.charCodeAt(cut - 1))) cut += cut - 1 > offset ? -1 : 1;
  if (cut >= text.length) return rest;
  return { fulltext: text.slice(offset, cut), truncated: true, totalChars: text.length, nextOffset: cut };
}

// ─── Telling an article from its landing page ───────────────────

/** Sections a publisher's page adds that are never the article: dropped from the text. */
const UNRELATED_SECTION =
  /^(?:similar (?:content|articles)|related (?:content|articles)|recommended articles|more like this|you may also like|people also read|cited by|citing articles)\b/i;
/** Front and back matter: kept in the text, not counted as article body. */
const NOT_BODY_SECTION =
  /^(?:references?|bibliography|literature cited|key ?words?|highlights|metrics|about this article|cite this article|rights and permissions|author information|additional information|ethics declarations|supplementary (?:information|material|data)|footnotes?)\b/i;
const ABSTRACT_SECTION = /^(?:abstract|summary)\b/i;
/** An abstract as a paragraph of its own: "Abstract: …", arXiv's "> Abstract:…", "**Abstract.** …". */
const ABSTRACT_PARAGRAPH = /^(?:>\s*)?(?:\*\*|__)?(?:abstract|summary)(?:\*\*|__)?\s*[:.]/i;

/** A page converted to markdown, and how much of it is article body. */
interface PageText {
  /** The markdown without the unrelated sections. */
  markdown: string;
  /** Visible characters outside the abstract, front and back matter. */
  body: number;
  /** Visible characters of the abstract the page labels, or null when it labels none. */
  abstract: number | null;
}

/** Text as a reader sees it: no link targets, images, emphasis, quote or list markers. */
function visibleText(markdown: string): string {
  return markdown
    .replace(/!\[[^\]]*\]\([^)]*\)/g, "")
    .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/^\s*(?:>\s*)+/, "")
    .replace(/^\s*(?:[-*+]|\d+\.)\s+/, "")
    .replace(/[*_`|]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Split a page's markdown into article body, abstract, and front and back matter
 * (references, keywords, author information, …) by its headings, dropping sections
 * that aren't the article at all (similar or recommended articles, citing articles).
 * A section runs to the next heading of the same or a higher level.
 */
function readPage(markdown: string): PageText {
  const kept: string[] = [];
  let body = 0;
  let abstract: number | null = null;
  /** Level of the unrelated section being dropped. */
  let dropping: number | null = null;
  /** The abstract or front/back-matter section being read. */
  let region: { kind: "abstract" | "matter"; level: number } | null = null;
  for (const line of markdown.split("\n")) {
    const heading = /^(#{1,6})\s+(.*)$/.exec(line);
    if (heading) {
      const level = heading[1]!.length;
      const title = visibleText(heading[2]!).replace(/^[\d.]+\s+/, "");
      if (dropping !== null && level <= dropping) dropping = null;
      if (region && level <= region.level) region = null;
      if (dropping === null && UNRELATED_SECTION.test(title)) {
        dropping = level;
      } else if (!region && ABSTRACT_SECTION.test(title)) {
        region = { kind: "abstract", level };
        abstract ??= 0;
      } else if (!region && NOT_BODY_SECTION.test(title)) {
        region = { kind: "matter", level };
      }
      if (dropping === null) kept.push(line);
      continue;
    }
    if (dropping !== null) continue;
    kept.push(line);
    const chars = visibleText(line).length;
    if (region?.kind === "abstract") abstract = (abstract ?? 0) + chars;
    else if (region) continue;
    else if (abstract === null && ABSTRACT_PARAGRAPH.test(line.trim())) abstract = chars;
    else body += chars;
  }
  return { markdown: kept.join("\n").replace(/\n{3,}/g, "\n\n").trim(), body, abstract };
}

/**
 * Whether a page holds the article rather than its landing page: at least
 * {@link MIN_BODY_CHARS} of text besides the abstract and front and back matter.
 * When the page labels no abstract, the known abstract's length is taken off the
 * body; an "Abstract" section longer than any abstract counts as body past
 * {@link MAX_ABSTRACT_CHARS}.
 */
function isArticleBody(page: PageText, knownAbstract: string | undefined): boolean {
  const spill = Math.max(0, (page.abstract ?? 0) - MAX_ABSTRACT_CHARS);
  const unlabeled = page.abstract === null ? (knownAbstract?.length ?? 0) : 0;
  return page.body + spill - unlabeled >= MIN_BODY_CHARS;
}

/**
 * Strip a DOI URL/`doi:` prefix and validate the shape; return undefined if it isn't a DOI. Any other URL (a
 * record's `url` or `originalUrl`, which a model once passed as `doi`) is no DOI and is not altered into one:
 * it yields undefined, and {@link fetchFulltext} names it when the id can't be resolved without it.
 */
function normalizeDoi(doi: string | undefined): string | undefined {
  if (!doi) return undefined;
  const d = doi
    .trim()
    .replace(/^https?:\/\/(?:dx\.|www\.)?doi\.org\//i, "")
    .replace(/^doi:\s*/i, "")
    .trim();
  return /^10\.\d{4,9}\/\S+$/.test(d) ? d : undefined;
}

const isHighSurrogate = (code: number): boolean => code >= 0xd800 && code <= 0xdbff;

/** $MED_RESEARCH_FULLTEXT_MAX_CHARS, a whole number of characters, 1 or more; undefined for anything else. */
function envMaxChars(): number | undefined {
  const raw = process.env.MED_RESEARCH_FULLTEXT_MAX_CHARS?.trim();
  if (!raw) return undefined;
  const n = Number(raw);
  return Number.isInteger(n) && n >= 1 ? n : undefined;
}

// ─── Default (network + library) implementations ────────────────

/** Kept as one function so fetchPublic reuses a single agent for it. */
const allowAnyAddress = (): boolean => true;

async function defaultFetchUrl(url: string, timeoutMs: number): Promise<FetchedResource> {
  const res = await fetchPublic(url, {
    timeoutMs,
    // Personal machines behind fake-IP DNS proxies or split-horizon DNS may opt out of the address check.
    ...(process.env.MED_RESEARCH_FULLTEXT_ALLOW_PRIVATE === "1" ? { isAllowedAddress: allowAnyAddress } : {}),
    headers: {
      "User-Agent": USER_AGENT,
      Accept: "text/html,application/xhtml+xml,application/pdf,*/*",
    },
  });
  const { ok, status, contentType, finalUrl } = res;
  // Content-type wins over the URL extension: publishers routinely serve an
  // HTML paywall/anti-bot page from a `…/pdf` URL, and feeding that to the PDF
  // parser only produces garbage. Only fall back to the extension when the
  // server didn't declare HTML.
  const isHtml = contentType.includes("text/html") || contentType.includes("application/xhtml");
  const isPdf = contentType.includes("application/pdf") || (!isHtml && /\.pdf($|\?)/i.test(finalUrl));
  if (isPdf) return { ok, status, contentType, finalUrl, bytes: res.body };
  // UTF-8, as Response.text() decodes.
  return { ok, status, contentType, finalUrl, text: new TextDecoder().decode(res.body) };
}

/**
 * Reduce an HTML page to its main content as markdown (Readability → turndown).
 * Exported for the benchmark's web baseline so both conditions extract pages
 * the same way; not part of the package's public `core` API.
 */
export async function defaultHtmlToMarkdown(html: string, url: string): Promise<string> {
  const { JSDOM } = await import("jsdom");
  const { Readability } = await import("@mozilla/readability");
  const Turndown = (await import("turndown")).default;

  const dom = new JSDOM(html, { url });
  let contentHtml: string;
  try {
    const article = new Readability(dom.window.document).parse();
    contentHtml = article?.content ?? dom.window.document.body?.innerHTML ?? html;
  } catch {
    // Readability throws on some malformed documents — fall back to the raw body.
    contentHtml = dom.window.document.body?.innerHTML ?? html;
  }
  const turndown = new Turndown({ headingStyle: "atx", codeBlockStyle: "fenced" });
  return turndown.turndown(contentHtml).trim();
}

/**
 * Convert a JATS XML article (as Europe PMC's full-text API returns it) to
 * markdown: title, abstract, then the body's sections as headings, paragraphs,
 * lists, tables (row by row), formulas (one readable form each), figure
 * captions and scanned-article OCR text. Reference lists are left out, and so
 * are sections that would print nothing but their heading.
 *
 * Returns "" when the body holds less than {@link MIN_FULLTEXT_CHARS}: an
 * article Europe PMC has only as an abstract must not pass for full text.
 */
export async function defaultJatsToMarkdown(xml: string): Promise<string> {
  const { JSDOM } = await import("jsdom");
  const doc = new JSDOM(xml, { contentType: "text/xml" }).window.document;
  const squash = (text: string): string => text.replace(/\s+/g, " ").trim();
  const child = (el: Element, name: string): Element | undefined => [...el.children].find((c) => c.localName === name);

  /** TeX source without the LaTeX document wrapper PMC puts around it. */
  const tex = (el: Element): string => {
    const source = el.textContent ?? "";
    return (/\\begin\{document\}([\s\S]*?)\\end\{document\}/.exec(source)?.[1] ?? source).trim();
  };
  /** Text of inline content, with each formula in one form (TeX if present, else MathML text). */
  const inline = (node: Node): string => {
    if (node.nodeType === 3) return node.nodeValue ?? "";
    if (node.nodeType !== 1) return "";
    const el = node as Element;
    switch (el.localName) {
      case "alternatives": {
        const preferred = child(el, "tex-math") ?? child(el, "math");
        return preferred ? inline(preferred) : "";
      }
      case "tex-math":
        return ` ${tex(el)} `;
      case "graphic":
      case "inline-graphic":
        return "";
      default:
        return [...el.childNodes].map(inline).join("");
    }
  };
  /** "*Table 1. Caption*", without doubling a label's own period. */
  const caption = (el: Element): string => {
    const label = child(el, "label");
    const text = child(el, "caption");
    const parts = [label ? squash(inline(label)).replace(/[.:]$/, "") : "", text ? squash(inline(text)) : ""].filter(Boolean);
    return parts.length > 0 ? `*${parts.join(". ")}*` : "";
  };

  /** Block-level elements: a paragraph that contains one is split around it. */
  const BLOCKS = new Set(["sec", "p", "list", "table-wrap", "fig", "disp-formula", "preformat", "boxed-text", "disp-quote"]);
  const render = (el: Element, depth: number, out: string[]): void => {
    switch (el.localName) {
      case "sec": {
        // Europe PMC wraps the reference list in a section of its own, titled "References".
        if (el.getAttribute("sec-type") === "ref-list") return;
        const heading = child(el, "title");
        const content: string[] = [];
        for (const c of el.children) if (c !== heading) render(c, depth + 1, content);
        // A heading over nothing, such as "Supplementary Materials" over files, is left out.
        if (content.length === 0) return;
        if (heading) out.push(`${"#".repeat(Math.min(depth, 6))} ${squash(inline(heading))}`);
        out.push(...content);
        return;
      }
      case "title":
      case "label":
      case "caption":
        return; // printed by their parent
      case "p": {
        let buffer = "";
        const flush = (): void => {
          if (squash(buffer)) out.push(squash(buffer));
          buffer = "";
        };
        for (const node of el.childNodes) {
          if (node.nodeType === 1 && BLOCKS.has((node as Element).localName)) {
            flush();
            render(node as Element, depth, out);
          } else {
            buffer += inline(node);
          }
        }
        flush();
        return;
      }
      case "list":
        for (const item of el.children) if (item.localName === "list-item") out.push(`- ${squash(inline(item))}`);
        return;
      case "table-wrap": {
        const head = caption(el);
        if (head) out.push(head);
        for (const table of el.querySelectorAll("table")) {
          const rows = [...table.querySelectorAll("tr")].map((tr) =>
            [...tr.children].filter((c) => c.localName === "td" || c.localName === "th").map((c) => squash(inline(c)).replace(/\|/g, "\\|")),
          );
          if (rows.length === 0) continue;
          const lines = rows.map((cells) => `| ${cells.join(" | ")} |`);
          lines.splice(1, 0, `|${" --- |".repeat(Math.max(1, rows[0]!.length))}`);
          out.push(lines.join("\n"));
        }
        const foot = child(el, "table-wrap-foot");
        if (foot && squash(inline(foot))) out.push(squash(inline(foot)));
        return;
      }
      case "fig": {
        const head = caption(el);
        if (head) out.push(head);
        return;
      }
      case "disp-formula":
        if (squash(inline(el))) out.push(squash(inline(el)));
        return;
      case "preformat": {
        // Scanned articles carry their OCR text here (preformat-type="pmc-ocr-text").
        const text = (el.textContent ?? "").replace(/[ \t]+/g, " ").replace(/\n{3,}/g, "\n\n").trim();
        if (text) out.push(text);
        return;
      }
      default:
        for (const c of el.children) render(c, depth, out);
    }
  };

  const front: string[] = [];
  const title = doc.querySelector("article-meta article-title");
  if (title) front.push(`# ${squash(inline(title))}`);
  for (const abstract of doc.querySelectorAll("article-meta abstract")) {
    front.push("## Abstract");
    const before = front.length;
    for (const c of abstract.children) render(c, 3, front);
    if (front.length === before && squash(inline(abstract))) front.push(squash(inline(abstract)));
  }

  const body: string[] = [];
  const bodyEl = doc.querySelector("body");
  if (bodyEl) render(bodyEl, 2, body);
  if (body.join("\n\n").length < MIN_FULLTEXT_CHARS) return "";
  return [...front, ...body].filter(Boolean).join("\n\n");
}

/**
 * pdf.js's worker as a data URL, inlined by the .mcpb build (scripts/build-mcpb.mjs) only. A bundle
 * can't load the worker from its own file, nor the native @napi-rs/canvas that pdf-parse uses to
 * provide DOMMatrix, which pdf.js needs even to extract text.
 */
declare const __MED_RESEARCH_PDF_WORKER__: string | undefined;

/** The 2D subset of DOMMatrix that pdf.js's text extraction touches. */
function installDomMatrix(): void {
  if (typeof (globalThis as { DOMMatrix?: unknown }).DOMMatrix !== "undefined") return;
  class DOMMatrix {
    a = 1;
    b = 0;
    c = 0;
    d = 1;
    e = 0;
    f = 0;
    constructor(init?: number[]) {
      if (Array.isArray(init) && init.length === 6) [this.a, this.b, this.c, this.d, this.e, this.f] = init as [number, number, number, number, number, number];
    }
    multiplySelf(o: DOMMatrix): this {
      const { a, b, c, d, e, f } = this;
      [this.a, this.b, this.c, this.d] = [a * o.a + c * o.b, b * o.a + d * o.b, a * o.c + c * o.d, b * o.c + d * o.d];
      [this.e, this.f] = [a * o.e + c * o.f + e, b * o.e + d * o.f + f];
      return this;
    }
    preMultiplySelf(o: DOMMatrix): this {
      const product = new DOMMatrix([o.a, o.b, o.c, o.d, o.e, o.f]).multiplySelf(this);
      [this.a, this.b, this.c, this.d, this.e, this.f] = [product.a, product.b, product.c, product.d, product.e, product.f];
      return this;
    }
    translate(x = 0, y = 0): DOMMatrix {
      return new DOMMatrix([this.a, this.b, this.c, this.d, this.e, this.f]).multiplySelf(new DOMMatrix([1, 0, 0, 1, x, y]));
    }
    scale(x = 1, y = x): DOMMatrix {
      return new DOMMatrix([this.a, this.b, this.c, this.d, this.e, this.f]).multiplySelf(new DOMMatrix([x, 0, 0, y, 0, 0]));
    }
    invertSelf(): this {
      const { a, b, c, d, e, f } = this;
      const det = a * d - b * c;
      [this.a, this.b, this.c, this.d] = [d / det, -b / det, -c / det, a / det];
      [this.e, this.f] = [(c * f - d * e) / det, (b * e - a * f) / det];
      return this;
    }
  }
  (globalThis as { DOMMatrix?: unknown }).DOMMatrix = DOMMatrix;
}

/** Extract plain text from PDF bytes. Exported for the benchmark's web baseline, like `defaultHtmlToMarkdown`. */
export async function defaultPdfToText(bytes: Uint8Array): Promise<string> {
  const bundledWorker = typeof __MED_RESEARCH_PDF_WORKER__ !== "undefined" ? __MED_RESEARCH_PDF_WORKER__ : undefined;
  if (bundledWorker) installDomMatrix();
  const { PDFParse } = await import("pdf-parse");
  if (bundledWorker) PDFParse.setWorker(bundledWorker);
  const parser = new PDFParse({ data: bytes });
  const result = await parser.getText();
  await parser.destroy();
  return (result.text ?? "").trim();
}
