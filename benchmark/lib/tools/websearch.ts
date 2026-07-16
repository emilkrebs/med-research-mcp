/**
 * Condition B tool: a single `web_search` backed by the Brave Search API
 * (free tier). Returns a compact list of top results the model can reason over —
 * the standalone-web-search baseline the MCP is measured against.
 */

import { tool } from "ai";
import { z } from "zod";
import { DEFAULTS } from "../config.js";

const BRAVE_ENDPOINT = "https://api.search.brave.com/res/v1/web/search";

interface BraveResult {
  title?: string;
  url?: string;
  description?: string;
}

interface BraveResponse {
  web?: { results?: BraveResult[] };
}

/** Build the condition-B toolset. Requires `BRAVE_API_KEY`. */
export function webSearchTools(count = DEFAULTS.webResults) {
  const apiKey = process.env.BRAVE_API_KEY;
  if (!apiKey) throw new Error("Missing BRAVE_API_KEY — required for the web-search condition (B).");

  return {
    web_search: tool({
      description: "Search the web and return the top results (title, url, snippet). Use it to find and cite up-to-date sources.",
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
  };
}
