/**
 * SovietRxiv / Russian paper adapter via the unified ChinaRxiv API.
 *
 * API: GET https://chinaxiv.org/api/v1/papers?source=russiarxiv
 *
 * Searches the Soviet-era Russian corpus. Same API as ChinaRXiv, different source.
 */

import { defaultHttp, type AdapterHttp } from "./http.js";
import { RestAdapter } from "./base.js";
import { cleanDoi, first, strArray } from "./util.js";
import { parsePapers } from "./chinaxiv.js";
import type { PaperResponse } from "./chinaxiv.js";
import type { Article, SearchInput } from "../types.js";

const BASE = "https://chinaxiv.org/api/v1/papers";
const MAX_RESULTS_CAP = 50;

export class SovietRxivAdapter extends RestAdapter {
  readonly id = "russiarxiv";
  readonly name = "SovietRxiv";

  constructor(http: AdapterHttp = defaultHttp()) {
    super(http);
  }

  async search(input: SearchInput): Promise<{ count: number; ids: string[] }> {
    const limit = Math.min(Math.max(input.maxResults ?? 10, 1), MAX_RESULTS_CAP);
    const params = new URLSearchParams({
      q: input.query,
      limit: String(limit),
      page: "1",
      source: "russiarxiv",
    });

    const data = await this.http.json<PaperResponse>(`${BASE}?${params.toString()}`);
    const parsed = parsePapers(data);
    this.remember(parsed.articles);
    return { count: parsed.count, ids: parsed.articles.map((a) => a.pmid) };
  }

  protected async fetchOne(id: string): Promise<Article | null> {
    const params = new URLSearchParams({ q: id, limit: "1", page: "1", source: "russiarxiv" });
    const data = await this.http.json<PaperResponse>(`${BASE}?${params.toString()}`);
    return parsePapers(data).articles[0] ?? null;
  }
}
