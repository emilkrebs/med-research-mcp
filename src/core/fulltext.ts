/**
 * Full-text resolution + extraction.
 *
 * Given a PMID (and optionally a DOI), a PMCID or a Europe PMC preprint id, try —
 * in order — the machine's access paths, and return the article body as markdown:
 *
 *   1. Europe PMC     — its full-text API, when the record has a PMCID (or is a
 *                       PMCID or preprint id): open access, with tables
 *   2. Unpaywall      — free, aggregates every open-access copy of a DOI; PMC and
 *                       Europe PMC copies come from Europe PMC's full-text API
 *   3. Proxy          — an institutional EZproxy prefix, if configured
 *   4. Direct DOI     — https://doi.org/{DOI} (works on IP-authed networks / OA)
 *   5. Fallback       — the abstract, with `source: "none"` and a warning that
 *                       says what each location answered
 *
 * Only open-access (Europe PMC, Unpaywall) texts are cached; a proxy or direct
 * text may be licensed to the user alone.
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

import type { Cache } from "./cache.js";
import { LRUBackend } from "./cache.js";
import { errors } from "./errors.js";
import { BlockedUrlError, fetchPublic } from "./public-fetch.js";
import { NcbiClient } from "./pubmed.js";
import type { FulltextInput, FulltextOutput, FulltextSource, Article } from "./types.js";
import { UnpaywallClient } from "./unpaywall.js";
import type { UnpaywallResult } from "./unpaywall.js";
import { USER_AGENT } from "./version.js";

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
/** Sources whose texts are open access, and so may be cached. */
const OPEN_ACCESS_SOURCES: ReadonlySet<string> = new Set(["europepmc", "unpaywall"]);

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

/** Injectable seams. Defaults hit the network and load the extraction libraries. */
export interface FulltextDeps {
  /** Unpaywall client. Defaults to one configured from env. */
  unpaywall?: UnpaywallClient;
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
  /** Character cap on the returned text. Defaults to $MED_RESEARCH_FULLTEXT_MAX_CHARS, then 50000. */
  maxChars?: number;
  /** Per-fetch timeout in ms. Default 20000. */
  timeoutMs?: number;
  /** Clock, injectable for tests. Defaults to Date.now. */
  now?: () => number;
}

interface Extracted {
  fulltext: string;
  format: "markdown" | "pdf";
}

type Source = Exclude<FulltextSource, "none">;

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
  // A numeric PMID, an id Europe PMC's full-text API takes, or a supplied DOI is
  // enough to proceed. Other ids (Europe PMC "CBA:…", ChinaXiv) can arrive with a
  // DOI, and DOI-based resolution is database-agnostic. Without one there's
  // nothing to resolve.
  const europePmcId = EUROPE_PMC_ID.test(id) ? id.toUpperCase() : undefined;
  if (!isPmid(id) && !inputDoi && !europePmcId) {
    throw errors.noDoi(String(input.id ?? ""));
  }

  const maxChars = deps.maxChars ?? envMaxChars() ?? DEFAULT_MAX_CHARS;
  const now = deps.now ?? Date.now;

  // 1. Cache hit — return immediately, re-clamped to the current limit. Only open-access texts
  // count: 0.5.0 also cached proxy and direct texts, which a persistent cache may still hold.
  const cached = cache.getFulltext(id);
  if (cached && OPEN_ACCESS_SOURCES.has(cached.source)) {
    const { text, truncated } = clamp(cached.fulltext, maxChars);
    const knownDoi = inputDoi ?? normalizeDoi(cache.getSummary(id)?.doi);
    return {
      id,
      ...(knownDoi ? { doi: knownDoi } : {}),
      source: cached.source as FulltextSource,
      fulltext: text,
      format: cached.format,
      truncated,
    };
  }

  // 2. Resolve a DOI (from the argument, a cached summary, or a fresh esummary) and a PMCID.
  let article = cache.getSummary(id);
  let doi = inputDoi ?? normalizeDoi(article?.doi);
  if (!doi && !article && isPmid(id)) {
    const summaries = await client.esummary([id]);
    article = summaries.get(id) ?? null;
    if (article) cache.setSummary(id, article);
    doi = normalizeDoi(article?.doi);
  }
  const pmcid = europePmcId ?? (article?.pmcid && EUROPE_PMC_ID.test(article.pmcid) ? article.pmcid.toUpperCase() : undefined);

  // The abstract: the landing-page check needs it, and the fallback returns it. Looked up once, when first needed.
  let abstractLookup: Promise<string | undefined> | undefined;
  const abstract = (): Promise<string | undefined> => (abstractLookup ??= resolveAbstract(id, article, cache, client));

  // No DOI or PMCID → nothing to hand to a publisher/OA lookup. Degrade to the abstract.
  if (!doi && !pmcid) {
    if (!article) throw errors.notFound(id);
    return noneResult(
      id,
      undefined,
      await abstract(),
      "Could not resolve a DOI for this id, so no full-text source could be tried. Returned the abstract only.",
    );
  }

  const proxyPrefix = (deps.proxyPrefix ?? process.env.MED_RESEARCH_PROXY_PREFIX)?.trim() || undefined;
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
      const { text, truncated } = clamp(got.fulltext, maxChars);
      return { id, ...(doi ? { doi } : {}), source, fulltext: text, format: got.format, truncated };
    }
    return null;
  };

  if (pmcid) {
    const out = await attempt("europepmc", [`${EUROPE_PMC_FULLTEXT}${pmcid}/fullTextXML`]);
    if (out) return out;
  }
  const unpaywall = deps.unpaywall ?? new UnpaywallClient();
  let unpaywallState: "unconfigured" | "none" | "found" | "skipped" = "skipped";
  if (doi) {
    if (!unpaywall.configured) {
      unpaywallState = "unconfigured";
    } else {
      const oa = await safeUnpaywall(unpaywall, doi);
      const urls = oa ? openAccessUrls(oa.urls) : [];
      unpaywallState = urls.length > 0 ? "found" : "none";
      const out = await attempt("unpaywall", urls);
      if (out) return out;
    }
    if (proxyPrefix) {
      const out = await attempt("proxy", [proxyUrl(proxyPrefix, doi)]);
      if (out) return out;
    }
    const out = await attempt("direct", [`https://doi.org/${doi}`]);
    if (out) return out;
  }

  // 4. Fallback — nothing resolved. Return the abstract with what each location answered.
  const text = await abstract();
  const doiUnknown = misses.some((m) => m.source === "direct" && m.kind === "status" && (m.status === 404 || m.status === 410) && m.host === "doi.org");
  if (doi && doiUnknown && !text) throw errors.doiNotFound(doi);
  return noneResult(
    id,
    doi,
    text,
    fallbackWarning({ doi, pmcid, abstract: Boolean(text), unpaywall: unpaywallState, proxyConfigured: Boolean(proxyPrefix), misses }),
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

async function safeUnpaywall(client: UnpaywallClient, doi: string): Promise<UnpaywallResult | null> {
  try {
    return await client.resolve(doi);
  } catch {
    return null;
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

async function resolveAbstract(
  id: string,
  article: Article | null,
  cache: Cache,
  client: NcbiClient,
): Promise<string | undefined> {
  const cached = cache.getAbstract(id);
  if (cached) return cached;
  if (article?.abstract) return article.abstract;
  // Only PubMed knows the abstract by this id; other databases' ids mean nothing to efetch.
  if (!isPmid(id)) return undefined;
  try {
    const fetched = await client.efetch([id]);
    const abstract = fetched.get(id)?.abstract;
    if (abstract) {
      cache.setAbstract(id, abstract);
      return abstract;
    }
  } catch {
    /* best-effort — the fallback is allowed to have no text at all */
  }
  return undefined;
}

function noneResult(
  id: string,
  doi: string | undefined,
  abstract: string | undefined,
  warning: string,
): FulltextOutput {
  return {
    id,
    ...(doi ? { doi } : {}),
    source: "none",
    ...(abstract ? { fulltext: abstract } : {}),
    format: "markdown",
    truncated: false,
    warning,
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

/** The fallback's warning: what each source answered, and what the user can do about it. */
function fallbackWarning(ctx: {
  doi: string | undefined;
  pmcid: string | undefined;
  abstract: boolean;
  unpaywall: "unconfigured" | "none" | "found" | "skipped";
  proxyConfigured: boolean;
  misses: Miss[];
}): string {
  const parts = [ctx.abstract ? "No full text found; returned the abstract only." : "No full text found, and no abstract is available."];
  const of = (source: Source): Miss[] => ctx.misses.filter((m) => m.source === source);

  const europePmc = of("europepmc")[0];
  if (europePmc && ctx.pmcid) {
    parts.push(
      europePmc.kind === "status" && europePmc.status !== 429
        ? `Europe PMC has no open-access full text for ${ctx.pmcid}.`
        : `Europe PMC's full text for ${ctx.pmcid} ${describeMiss(europePmc)}.`,
    );
  }
  if (ctx.unpaywall === "unconfigured") {
    parts.push("Open-access copies weren't looked up: set NCBI_EMAIL (or MED_RESEARCH_UNPAYWALL_EMAIL) so Unpaywall can find them.");
  } else if (ctx.unpaywall === "none") {
    parts.push("Unpaywall found no open-access copy.");
  } else if (ctx.unpaywall === "found") {
    const reasons = [...new Set(of("unpaywall").map(describeMiss))];
    parts.push(`None of Unpaywall's open-access copies yielded the text (${reasons.join("; ")}).`);
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
  return parts.join(" ");
}

function clamp(text: string, maxChars: number): { text: string; truncated: boolean } {
  if (text.length <= maxChars) return { text, truncated: false };
  return { text: text.slice(0, maxChars), truncated: true };
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

/** Strip a DOI URL/`doi:` prefix and validate the shape; return undefined if it isn't a DOI. */
function normalizeDoi(doi: string | undefined): string | undefined {
  if (!doi) return undefined;
  const d = doi
    .trim()
    .replace(/^https?:\/\/(dx\.)?doi\.org\//i, "")
    .replace(/^doi:\s*/i, "")
    .trim();
  return /^10\.\d{4,9}\/\S+$/.test(d) ? d : undefined;
}

function envMaxChars(): number | undefined {
  const raw = process.env.MED_RESEARCH_FULLTEXT_MAX_CHARS;
  if (!raw) return undefined;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : undefined;
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
 * captions and scanned-article OCR text. Reference lists are left out.
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
        const heading = child(el, "title");
        if (heading) out.push(`${"#".repeat(Math.min(depth, 6))} ${squash(inline(heading))}`);
        for (const c of el.children) if (c !== heading) render(c, depth + 1, out);
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
