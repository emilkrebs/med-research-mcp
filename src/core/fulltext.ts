/**
 * Full-text resolution + extraction.
 *
 * Given a PMID (and optionally a DOI), try — in order — the machine's available
 * legal access paths, and return the article body as markdown:
 *
 *   1. Unpaywall      — free, aggregates every open-access copy of a DOI
 *   2. Proxy          — an institutional EZproxy prefix, if configured
 *   3. Direct DOI     — https://doi.org/{DOI} (works on IP-authed networks / OA)
 *   4. Fallback       — the abstract, with `source: "none"` and a warning
 *
 * HTML is reduced to the article body with mozilla/readability, then converted
 * to markdown with turndown. PDFs are extracted with pdf-parse. The heavy
 * extraction libraries are imported lazily so importing this module stays cheap,
 * and every extraction dependency is injectable for testing.
 *
 * Pages are fetched with `fetchPublic` (./public-fetch.ts), which refuses
 * loopback, private and link-local addresses at every redirect and caps the
 * body size: the URLs come from Unpaywall and DOI registrants, not from us.
 */

import type { Cache } from "./cache.js";
import { LRUBackend } from "./cache.js";
import { errors } from "./errors.js";
import { fetchPublic } from "./public-fetch.js";
import { NcbiClient } from "./pubmed.js";
import type { FulltextInput, FulltextOutput, FulltextSource, Article } from "./types.js";
import { UnpaywallClient } from "./unpaywall.js";
import type { UnpaywallResult } from "./unpaywall.js";
import { USER_AGENT } from "./version.js";

const DEFAULT_MAX_CHARS = 50_000;
const DEFAULT_TIMEOUT_MS = 20_000;
/** Extracted text shorter than this is treated as a paywall stub / failed extraction. */
const MIN_FULLTEXT_CHARS = 500;
const isPmid = (id: string): boolean => /^\d+$/.test(id);

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

/**
 * Resolve and return the full text of a PubMed article.
 *
 * @param cache reused across calls; caches resolved full texts for 30 days.
 * @param client injectable NCBI client, used to look up the DOI and abstract.
 * @param deps injectable fetch/extraction seams; defaults hit the network.
 */
export async function fetchFulltext(
  input: FulltextInput,
  cache: Cache = new LRUBackend(),
  client: NcbiClient = new NcbiClient(),
  deps: FulltextDeps = {},
): Promise<FulltextOutput> {
  const id = String(input.id ?? "").trim();
  // A numeric PMID or a supplied DOI is enough to proceed. Non-PubMed ids
  // (Europe PMC "CBA:…" / "PPR…") aren't numeric but can arrive with a DOI, and
  // DOI-based resolution is database-agnostic. Without either (ChinaXiv and
  // RussiaRxiv records have no DOI), there's nothing to resolve.
  if (!isPmid(id) && !normalizeDoi(input.doi)) {
    throw errors.noDoi(String(input.id ?? ""));
  }

  const maxChars = deps.maxChars ?? envMaxChars() ?? DEFAULT_MAX_CHARS;
  const now = deps.now ?? Date.now;

  // 1. Cache hit — return immediately, re-clamped to the current limit.
  const cached = cache.getFulltext(id);
  if (cached) {
    const { text, truncated } = clamp(cached.fulltext, maxChars);
    const knownDoi = normalizeDoi(input.doi) ?? normalizeDoi(cache.getSummary(id)?.doi);
    return {
      id,
      ...(knownDoi ? { doi: knownDoi } : {}),
      source: cached.source as FulltextSource,
      fulltext: text,
      format: cached.format,
      truncated,
    };
  }

  // 2. Resolve a DOI (from the argument, a cached summary, or a fresh esummary).
  let article = cache.getSummary(id);
  let doi = normalizeDoi(input.doi) ?? normalizeDoi(article?.doi);
  if (!doi) {
    if (!article) {
      const summaries = await client.esummary([id]);
      article = summaries.get(id) ?? null;
      if (article) cache.setSummary(id, article);
    }
    doi = normalizeDoi(article?.doi);
  }

  const proxyPrefix = (deps.proxyPrefix ?? process.env.MED_RESEARCH_PROXY_PREFIX)?.trim() || undefined;
  const timeoutMs = deps.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const fetchUrl = deps.fetchUrl ?? defaultFetchUrl;
  const htmlToMarkdown = deps.htmlToMarkdown ?? defaultHtmlToMarkdown;
  const pdfToText = deps.pdfToText ?? defaultPdfToText;

  // No DOI → nothing to hand to a publisher/OA lookup. Degrade to the abstract.
  if (!doi) {
    if (!article) throw errors.notFound(id);
    const abstract = await resolveAbstract(id, article, cache, client);
    return noneResult(
      id,
      undefined,
      abstract,
      "Could not resolve a DOI for this id, so no full-text source could be tried. Returned the abstract only.",
    );
  }

  // Fetch a URL and turn its body into text; null means "didn't yield usable full text".
  const extract = async (url: string): Promise<Extracted | null> => {
    let res: FetchedResource;
    try {
      res = await fetchUrl(url, timeoutMs);
    } catch {
      return null;
    }
    if (!res.ok) return null;
    try {
      if (res.bytes) {
        const text = (await pdfToText(res.bytes)).trim();
        return text.length >= MIN_FULLTEXT_CHARS ? { fulltext: text, format: "pdf" } : null;
      }
      if (res.text != null) {
        const md = (await htmlToMarkdown(res.text, res.finalUrl)).trim();
        return md.length >= MIN_FULLTEXT_CHARS ? { fulltext: md, format: "markdown" } : null;
      }
    } catch {
      return null;
    }
    return null;
  };

  // 3. Build the ordered list of URLs to try, grouped by source.
  const attempts: { source: Exclude<FulltextSource, "none">; urls: string[] }[] = [];

  const unpaywall = deps.unpaywall ?? new UnpaywallClient();
  const oa = await safeUnpaywall(unpaywall, doi);
  if (oa && oa.urls.length > 0) attempts.push({ source: "unpaywall", urls: oa.urls });

  if (proxyPrefix) attempts.push({ source: "proxy", urls: [proxyUrl(proxyPrefix, doi)] });

  attempts.push({ source: "direct", urls: [`https://doi.org/${doi}`] });

  for (const attempt of attempts) {
    for (const url of attempt.urls) {
      const resolved = await extract(url);
      if (!resolved) continue;
      cache.setFulltext(id, {
        source: attempt.source,
        fulltext: resolved.fulltext,
        format: resolved.format,
        fetchedAt: now(),
      });
      const { text, truncated } = clamp(resolved.fulltext, maxChars);
      return {
        id,
        doi,
        source: attempt.source,
        fulltext: text,
        format: resolved.format,
        truncated,
      };
    }
  }

  // 4. Fallback — nothing resolved. Return the abstract with actionable guidance.
  const abstract = await resolveAbstract(id, article, cache, client);
  return noneResult(id, doi, abstract, paywallWarning(Boolean(proxyPrefix)));
}

// ─── Resolution helpers ─────────────────────────────────────────

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

function paywallWarning(proxyConfigured: boolean): string {
  return proxyConfigured
    ? "Full text unavailable — no open-access copy and the configured proxy did not return the article. Returned the abstract only."
    : "Full text unavailable — paywalled. Consider adding an institutional proxy via MED_RESEARCH_PROXY_PREFIX. Returned the abstract only.";
}

function clamp(text: string, maxChars: number): { text: string; truncated: boolean } {
  if (text.length <= maxChars) return { text, truncated: false };
  return { text: text.slice(0, maxChars), truncated: true };
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

async function defaultFetchUrl(url: string, timeoutMs: number): Promise<FetchedResource> {
  const res = await fetchPublic(url, {
    timeoutMs,
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

/** Extract plain text from PDF bytes. Exported for the benchmark's web baseline, like `defaultHtmlToMarkdown`. */
export async function defaultPdfToText(bytes: Uint8Array): Promise<string> {
  const { PDFParse } = await import("pdf-parse");
  const parser = new PDFParse({ data: bytes });
  const result = await parser.getText();
  await parser.destroy();
  return (result.text ?? "").trim();
}
