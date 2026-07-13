/**
 * CyberLeninka adapter (Russia / CIS).
 *
 * CyberLeninka is open access but exposes no clean REST API, so search results
 * are scraped from the HTML results page. Articles are Russian (often with an
 * English abstract); each is tagged `language: "ru"` so the agent knows to
 * expect Cyrillic — the existing HTML→markdown full-text pipeline already
 * handles it. Full texts are freely downloadable and resolved via the shared
 * pipeline using the article URL.
 *
 * Scraping is inherently brittle: the parser keys off the stable
 * `/article/n/{id}/{slug}` link shape and best-effort-extracts authors,
 * abstract, and year from the surrounding markup. `fetchOne` returns null (no
 * by-id endpoint); standalone `literature_fetch` for CyberLeninka therefore
 * relies on a cache/memo warmed by a prior `search`.
 */

import { defaultHttp, type AdapterHttp } from "./http.js";
import { RestAdapter } from "./base.js";
import { stripHtml } from "./util.js";
import type { NcbiArticle, SearchInput } from "../types.js";

const BASE = "https://cyberleninka.ru/search";
const MAX_RESULTS_CAP = 50;

const LINK_RE = /<a\s+[^>]*href="(\/article\/n\/(\d+)\/[^"]*)"[^>]*>([\s\S]*?)<\/a>/gi;

function extractAuthors(segment: string): string[] {
  const m = segment.match(/class="authors"[^>]*>([\s\S]*?)<\/(?:span|div|p)>/i);
  if (!m?.[1]) return [];
  return stripHtml(m[1])
    .split(/[;,]/)
    .map((s) => s.trim())
    .filter(Boolean);
}

function extractAnnotation(segment: string): string | undefined {
  const m =
    segment.match(/class="(?:snippet|annotation)"[^>]*>([\s\S]*?)<\/(?:p|div|span)>/i) ??
    segment.match(/<p[^>]*>([\s\S]*?)<\/p>/i);
  const text = m?.[1] ? stripHtml(m[1]) : "";
  return text.length > 0 ? text : undefined;
}

function extractYear(segment: string): string | undefined {
  const m = segment.match(/\b(?:19|20)\d{2}\b/);
  return m ? m[0] : undefined;
}

/** Pure parser over the search-results HTML — exposed for testing without the network. */
export function parseCyberLeninkaHtml(html: string): { count: number; articles: NcbiArticle[] } {
  const matches = [...html.matchAll(LINK_RE)];
  const articles: NcbiArticle[] = [];
  const seen = new Set<string>();

  for (let i = 0; i < matches.length; i++) {
    const m = matches[i]!;
    const path = m[1]!;
    const id = m[2]!;
    if (seen.has(id)) continue; // the same article can be linked more than once
    seen.add(id);
    const title = stripHtml(m[3] ?? "");
    if (!title) continue;

    const segStart = (m.index ?? 0) + m[0].length;
    const segEnd = i + 1 < matches.length ? matches[i + 1]!.index ?? html.length : html.length;
    const segment = html.slice(segStart, segEnd);

    const article: NcbiArticle = {
      pmid: id,
      title,
      authors: extractAuthors(segment),
      journal: "CyberLeninka",
      pubDate: extractYear(segment) ?? "",
      publicationTypes: [],
      database: "cyberleninka",
      url: `https://cyberleninka.ru${path}`,
      language: "ru",
    };
    const abstract = extractAnnotation(segment);
    if (abstract) article.abstract = abstract;
    articles.push(article);
  }

  const found = html.match(/Найдено[^0-9]*([\d\s]+)/);
  const count = found?.[1] ? Number(found[1].replace(/\s/g, "")) || articles.length : articles.length;
  return { count, articles };
}

export class CyberLeninkaAdapter extends RestAdapter {
  readonly id = "cyberleninka";
  readonly name = "CyberLeninka";

  constructor(http: AdapterHttp = defaultHttp()) {
    super(http);
  }

  async search(input: SearchInput): Promise<{ count: number; ids: string[] }> {
    const max = Math.min(Math.max(input.maxResults ?? 10, 1), MAX_RESULTS_CAP);
    const params = new URLSearchParams({ q: input.query });
    const html = await this.http.text(`${BASE}?${params.toString()}`);
    const parsed = parseCyberLeninkaHtml(html);
    const limited = parsed.articles.slice(0, max);
    this.remember(limited);
    return { count: parsed.count, ids: limited.map((a) => a.pmid) };
  }

  protected async fetchOne(): Promise<NcbiArticle | null> {
    return null;
  }
}
