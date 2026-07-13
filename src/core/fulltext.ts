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
 */

import type { Cache } from "./cache.js";
import { LRUBackend } from "./cache.js";
import { errors } from "./errors.js";
import { NcbiClient } from "./pubmed.js";
import type { FulltextInput, FulltextOutput, FulltextSource, NcbiArticle } from "./types.js";
import { UnpaywallClient } from "./unpaywall.js";
import type { UnpaywallResult } from "./unpaywall.js";

const DEFAULT_MAX_CHARS = 50_000;
const DEFAULT_TIMEOUT_MS = 20_000;
/** Extracted text shorter than this is treated as a paywall stub / failed extraction. */
const MIN_FULLTEXT_CHARS = 500;
const FULLTEXT_USER_AGENT = "pubmed-bio/0.2.0 (https://github.com/emilkrebs/pubmed-bio)";

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
  /** Institutional proxy prefix. Defaults to $PUBMED_PROXY_PREFIX. */
  proxyPrefix?: string;
  /** Character cap on the returned text. Defaults to $PUBMED_FULLTEXT_MAX_CHARS, then 50000. */
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
  const pmid = String(input.pmid ?? "").trim();
  // A numeric PMID or a supplied DOI is enough to proceed. Non-PubMed ids
  // (SciELO "S0102-…", ChinaXiv, …) aren't numeric but arrive with a DOI, and
  // DOI-based resolution is database-agnostic — so `literature_fulltext` works
  // for them. Without either, there's nothing to resolve.
  if (!/^\d+$/.test(pmid) && !normalizeDoi(input.doi)) {
    throw errors.notFound(String(input.pmid ?? ""));
  }

  const maxChars = deps.maxChars ?? envMaxChars() ?? DEFAULT_MAX_CHARS;
  const now = deps.now ?? Date.now;

  // 1. Cache hit — return immediately, re-clamped to the current limit.
  const cached = cache.getFulltext(pmid);
  if (cached) {
    const { text, truncated } = clamp(cached.fulltext, maxChars);
    const knownDoi = normalizeDoi(input.doi) ?? normalizeDoi(cache.getSummary(pmid)?.doi);
    return {
      pmid,
      ...(knownDoi ? { doi: knownDoi } : {}),
      source: cached.source as FulltextSource,
      fulltext: text,
      format: cached.format,
      truncated,
    };
  }

  // 2. Resolve a DOI (from the argument, a cached summary, or a fresh esummary).
  let article = cache.getSummary(pmid);
  let doi = normalizeDoi(input.doi) ?? normalizeDoi(article?.doi);
  if (!doi) {
    if (!article) {
      const summaries = await client.esummary([pmid]);
      article = summaries.get(pmid) ?? null;
      if (article) cache.setSummary(pmid, article);
    }
    doi = normalizeDoi(article?.doi);
  }

  const proxyPrefix = (deps.proxyPrefix ?? process.env.PUBMED_PROXY_PREFIX)?.trim() || undefined;
  const timeoutMs = deps.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const fetchUrl = deps.fetchUrl ?? defaultFetchUrl;
  const htmlToMarkdown = deps.htmlToMarkdown ?? defaultHtmlToMarkdown;
  const pdfToText = deps.pdfToText ?? defaultPdfToText;

  // No DOI → nothing to hand to a publisher/OA lookup. Degrade to the abstract.
  if (!doi) {
    if (!article) throw errors.notFound(pmid);
    const abstract = await resolveAbstract(pmid, article, cache, client);
    return noneResult(
      pmid,
      undefined,
      abstract,
      "Could not resolve a DOI for this PMID, so no full-text source could be tried. Returned the abstract only.",
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
      cache.setFulltext(pmid, {
        source: attempt.source,
        fulltext: resolved.fulltext,
        format: resolved.format,
        fetchedAt: now(),
      });
      const { text, truncated } = clamp(resolved.fulltext, maxChars);
      return {
        pmid,
        doi,
        source: attempt.source,
        fulltext: text,
        format: resolved.format,
        truncated,
      };
    }
  }

  // 4. Fallback — nothing resolved. Return the abstract with actionable guidance.
  const abstract = await resolveAbstract(pmid, article, cache, client);
  return noneResult(pmid, doi, abstract, paywallWarning(Boolean(proxyPrefix)));
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
  pmid: string,
  article: NcbiArticle | null,
  cache: Cache,
  client: NcbiClient,
): Promise<string | undefined> {
  const cached = cache.getAbstract(pmid);
  if (cached) return cached;
  if (article?.abstract) return article.abstract;
  try {
    const fetched = await client.efetch([pmid]);
    const abstract = fetched.get(pmid)?.abstract;
    if (abstract) {
      cache.setAbstract(pmid, abstract);
      return abstract;
    }
  } catch {
    /* best-effort — the fallback is allowed to have no text at all */
  }
  return undefined;
}

function noneResult(
  pmid: string,
  doi: string | undefined,
  abstract: string | undefined,
  warning: string,
): FulltextOutput {
  return {
    pmid,
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
    : "Full text unavailable — paywalled. Consider adding an institutional proxy via PUBMED_PROXY_PREFIX. Returned the abstract only.";
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
  const raw = process.env.PUBMED_FULLTEXT_MAX_CHARS;
  if (!raw) return undefined;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : undefined;
}

// ─── Default (network + library) implementations ────────────────

async function defaultFetchUrl(url: string, timeoutMs: number): Promise<FetchedResource> {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      signal: ac.signal,
      redirect: "follow",
      headers: {
        "User-Agent": FULLTEXT_USER_AGENT,
        Accept: "text/html,application/xhtml+xml,application/pdf,*/*",
      },
    });
    const contentType = (res.headers.get("content-type") ?? "").toLowerCase();
    const finalUrl = res.url || url;
    // Content-type wins over the URL extension: publishers routinely serve an
    // HTML paywall/anti-bot page from a `…/pdf` URL, and feeding that to the PDF
    // parser only produces garbage. Only fall back to the extension when the
    // server didn't declare HTML.
    const isHtml = contentType.includes("text/html") || contentType.includes("application/xhtml");
    const isPdf = contentType.includes("application/pdf") || (!isHtml && /\.pdf($|\?)/i.test(finalUrl));
    if (isPdf) {
      const bytes = new Uint8Array(await res.arrayBuffer());
      return { ok: res.ok, status: res.status, contentType, finalUrl, bytes };
    }
    const text = await res.text();
    return { ok: res.ok, status: res.status, contentType, finalUrl, text };
  } finally {
    clearTimeout(timer);
  }
}

async function defaultHtmlToMarkdown(html: string, url: string): Promise<string> {
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

async function defaultPdfToText(bytes: Uint8Array): Promise<string> {
  // Import the lib entry directly. pdf-parse's package index runs a debug block
  // that reads a bundled sample PDF when `module.parent` is falsy (i.e. under
  // ESM or a bundler) and throws; the lib entry has no such side effect. The
  // computed specifier also keeps bundlers from trying to resolve it at build.
  const specifier = "pdf-parse/lib/pdf-parse.js";
  const mod = (await import(specifier)) as {
    default?: (data: Buffer) => Promise<{ text: string }>;
  };
  const pdfParse = mod.default ?? (mod as unknown as (data: Buffer) => Promise<{ text: string }>);
  const result = await pdfParse(Buffer.from(bytes));
  return (result.text ?? "").trim();
}
