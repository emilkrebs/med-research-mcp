/**
 * Condition B tools: `web_search` backed by the Brave Search API (free tier)
 * plus `web_fetch` to open a result page. Together they are the
 * standalone-web baseline the MCP is measured against; without `web_fetch` the
 * baseline would see only snippets while the MCP condition gets abstracts and
 * full text.
 *
 * `web_fetch` reuses the core's own page extraction (`htmlToMarkdown`,
 * `pdfToText` from `src/core/fulltext.ts`, via the `../core.js` seam), so a page
 * reads the same whether the MCP's `literature_fulltext` or the web baseline
 * fetched it.
 */

import { tool } from "ai";
import { z } from "zod";
import { DEFAULTS } from "../config.js";
import { htmlToMarkdown, pdfToText } from "../core.js";

const FETCH_TIMEOUT_MS = 15_000;
const MAX_BYTES = 2 * 1024 * 1024;
const MAX_CHARS = 20_000;
const FETCH_USER_AGENT = "med-research-benchmark/0.1 (web_fetch baseline)";

const BRAVE_ENDPOINT = "https://api.search.brave.com/res/v1/web/search";

interface BraveResult {
  title?: string;
  url?: string;
  description?: string;
}

interface BraveResponse {
  web?: { results?: BraveResult[] };
}

/** Read a response body, stopping at `MAX_BYTES`. */
async function readCapped(res: Response): Promise<{ bytes: Buffer; truncatedBytes: boolean }> {
  if (!res.body) return { bytes: Buffer.from(await res.arrayBuffer()), truncatedBytes: false };
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  let truncatedBytes = false;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    total += value.byteLength;
    if (total > MAX_BYTES) {
      truncatedBytes = true;
      await reader.cancel().catch(() => undefined);
      break;
    }
  }
  return { bytes: Buffer.concat(chunks).subarray(0, MAX_BYTES), truncatedBytes };
}

/** Fetch a page and return its main content as markdown. Failures are returned, never thrown. */
export async function webFetch(rawUrl: string): Promise<Record<string, unknown>> {
  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    return { error: `Invalid URL: ${rawUrl}` };
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    return { error: `Only http(s) URLs are supported, got ${parsed.protocol}` };
  }
  try {
    const res = await fetch(parsed.href, {
      headers: { "User-Agent": FETCH_USER_AGENT, Accept: "text/html,application/xhtml+xml,application/pdf,text/plain;q=0.9,*/*;q=0.5" },
      redirect: "follow",
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
    if (!res.ok) return { error: `HTTP ${res.status} fetching ${parsed.href}`, url: parsed.href };
    const contentType = res.headers.get("content-type") ?? "";
    const { bytes, truncatedBytes } = await readCapped(res);
    const isPdf = /application\/pdf/i.test(contentType) || bytes.subarray(0, 5).toString("latin1") === "%PDF-";
    let content: string;
    if (isPdf) {
      // A size-capped PDF is cut mid-file and won't parse; say so rather than return garbage.
      if (truncatedBytes) return { url: parsed.href, error: `PDF larger than ${MAX_BYTES} bytes; not fetched.` };
      content = (await pdfToText(new Uint8Array(bytes))).trim();
    } else {
      const text = bytes.toString("utf-8");
      const isHtml = /html|xml/i.test(contentType) || /^\s*<(!doctype|html)/i.test(text);
      content = isHtml ? await htmlToMarkdown(text, res.url || parsed.href) : text.trim();
    }
    let truncated = truncatedBytes;
    if (content.length > MAX_CHARS) {
      content = content.slice(0, MAX_CHARS);
      truncated = true;
    }
    if (truncated) content += `\n\n[... content truncated (limit ${MAX_CHARS} characters / ${MAX_BYTES} bytes) ...]`;
    return { url: res.url || parsed.href, content, truncated };
  } catch (err) {
    return { error: `Failed to fetch ${parsed.href}: ${err instanceof Error ? err.message : String(err)}` };
  }
}

/** Build the condition-B toolset. Requires `BRAVE_API_KEY`. */
export function webSearchTools(count = DEFAULTS.webResults) {
  const apiKey = process.env.BRAVE_API_KEY;
  if (!apiKey) throw new Error("Missing BRAVE_API_KEY — required for the web-search condition (B).");

  return {
    web_search: tool({
      description:
        "Search the web and return the top results (title, url, snippet). Use it to find and cite up-to-date sources. " +
        "Snippets are short: open a promising result page with web_fetch to read its content.",
      inputSchema: z.object({
        query: z.string().describe("The web search query."),
      }),
      execute: async ({ query }) => {
        const url = `${BRAVE_ENDPOINT}?${new URLSearchParams({ q: query, count: String(count) }).toString()}`;
        const res = await fetch(url, {
          headers: { Accept: "application/json", "X-Subscription-Token": apiKey },
        });
        if (!res.ok) {
          return { error: `Brave Search returned HTTP ${res.status}`, results: [] };
        }
        const data = (await res.json()) as BraveResponse;
        const results = (data.web?.results ?? []).slice(0, count).map((r) => ({
          title: r.title ?? "",
          url: r.url ?? "",
          snippet: r.description ?? "",
        }));
        return { results };
      },
    }),

    web_fetch: tool({
      description:
        "Open a web page (http/https URL, e.g. from web_search results) and return its main content as markdown, " +
        "truncated to about 20,000 characters. PDFs (up to 2 MB) are returned as extracted text.",
      inputSchema: z.object({
        url: z.string().describe("The http(s) URL to open."),
      }),
      execute: async ({ url }) => webFetch(url),
    }),
  };
}
