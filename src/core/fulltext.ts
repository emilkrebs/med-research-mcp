/**
 * Full-text resolution + extraction.
 *
 * Given a PMID (and optionally a DOI), try — in order — the machine's access
 * paths, and return the article body as markdown:
 *
 *   1. Unpaywall      — free, aggregates every open-access copy of a DOI; PMC and
 *                       Europe PMC copies come from Europe PMC's full-text API
 *   2. Proxy          — an institutional EZproxy prefix, if configured
 *   3. Direct DOI     — https://doi.org/{DOI} (works on IP-authed networks / OA)
 *   4. Fallback       — the abstract, with `source: "none"` and a warning
 *
 * Only open-access (Unpaywall) texts are cached; a proxy or direct text may be
 * licensed to the user alone.
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
/** Europe PMC's REST API; `<PMCID>/fullTextXML` returns an open-access article as JATS XML. */
const EUROPE_PMC_FULLTEXT = "https://www.ebi.ac.uk/europepmc/webservices/rest/";
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

/**
 * Resolve and return the full text of a PubMed article.
 *
 * @param cache reused across calls; caches open-access full texts for 30 days.
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

  // 1. Cache hit — return immediately, re-clamped to the current limit. Only open-access texts
  // count: 0.5.0 also cached proxy and direct texts, which a persistent cache may still hold.
  const cached = cache.getFulltext(id);
  if (cached?.source === "unpaywall") {
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
  const jatsToMarkdown = deps.jatsToMarkdown ?? defaultJatsToMarkdown;
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
  let refusedAddress = false;
  const extract = async (url: string): Promise<Extracted | null> => {
    let res: FetchedResource;
    try {
      res = await fetchUrl(url, timeoutMs);
    } catch (err) {
      if (err instanceof BlockedUrlError && err.reason === "address") refusedAddress = true;
      return null;
    }
    if (!res.ok) return null;
    try {
      if (res.bytes) {
        const text = (await pdfToText(res.bytes)).trim();
        return text.length >= MIN_FULLTEXT_CHARS ? { fulltext: text, format: "pdf" } : null;
      }
      if (res.text != null) {
        const md = (
          url.startsWith(EUROPE_PMC_FULLTEXT) ? await jatsToMarkdown(res.text) : await htmlToMarkdown(res.text, res.finalUrl)
        ).trim();
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
  const oaUrls = oa ? openAccessUrls(oa.urls) : [];
  if (oaUrls.length > 0) attempts.push({ source: "unpaywall", urls: oaUrls });

  if (proxyPrefix) attempts.push({ source: "proxy", urls: [proxyUrl(proxyPrefix, doi)] });

  attempts.push({ source: "direct", urls: [`https://doi.org/${doi}`] });

  for (const attempt of attempts) {
    for (const url of attempt.urls) {
      const resolved = await extract(url);
      if (!resolved) continue;
      // Only open-access texts are cached. A proxy or direct text may be licensed to
      // this user alone, and the cache can outlive the session or serve other callers.
      if (attempt.source === "unpaywall") {
        cache.setFulltext(id, {
          source: attempt.source,
          fulltext: resolved.fulltext,
          format: resolved.format,
          fetchedAt: now(),
        });
      }
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
  return noneResult(id, doi, abstract, paywallWarning(Boolean(proxyPrefix), refusedAddress));
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

function paywallWarning(proxyConfigured: boolean, refusedAddress: boolean): string {
  const warning = proxyConfigured
    ? "Full text unavailable — no open-access copy and the configured proxy did not return the article. Returned the abstract only."
    : "Full text unavailable — paywalled. Consider adding an institutional proxy via MED_RESEARCH_PROXY_PREFIX. Returned the abstract only.";
  if (!refusedAddress) return warning;
  return (
    `${warning} Some locations were refused because their host names resolve to private or reserved network addresses, ` +
    "as they do behind a fake-IP DNS proxy (Clash, Surge or sing-box in TUN mode). On a personal machine, set " +
    "MED_RESEARCH_FULLTEXT_ALLOW_PRIVATE=1 to allow them; never on a shared server."
  );
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
