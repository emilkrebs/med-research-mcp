/**
 * Unpaywall API client — resolves a DOI to the best legal open-access copy.
 *
 * Unpaywall (https://unpaywall.org) aggregates OA copies from preprint servers
 * (arXiv, bioRxiv), institutional repositories, PubMed Central, and publisher-
 * hosted OA. It's free and needs no key, but "requests must include your email"
 * and it asks users to "limit use to 100,000 calls per day"
 * (https://unpaywall.org/products/api, checked 2026-10-19).
 */

import { PROJECT_CONTACT_EMAIL, USER_AGENT } from "./version.js";

const UNPAYWALL_BASE = "https://api.unpaywall.org/v2";

/** A single open-access location as reported by Unpaywall. */
interface OaLocation {
  /** Landing/reading URL — may be HTML or a direct PDF. */
  url?: string;
  /** Direct PDF URL when the host exposes one. */
  url_for_pdf?: string | null;
  host_type?: string;
  version?: string;
}

interface UnpaywallResponse {
  doi?: string;
  is_oa?: boolean;
  best_oa_location?: OaLocation | null;
  oa_locations?: OaLocation[];
}

/** The URLs worth trying for a DOI, best first. */
export interface UnpaywallResult {
  doi: string;
  isOa: boolean;
  /** Candidate URLs to fetch, ordered best-first. May contain HTML pages and/or PDFs. */
  urls: string[];
}

export interface UnpaywallConfig {
  /**
   * Contact email required by Unpaywall. Defaults to $MED_RESEARCH_UNPAYWALL_EMAIL, then
   * $NCBI_EMAIL, then PROJECT_CONTACT_EMAIL.
   */
  email?: string;
  /** Per-request timeout in ms. Default 15000. */
  timeoutMs?: number;
}

export class UnpaywallClient {
  private readonly email: string;
  private readonly timeoutMs: number;

  constructor(config: UnpaywallConfig = {}) {
    // `||`, not `??`: an empty variable (a blank .mcpb field, `MED_RESEARCH_UNPAYWALL_EMAIL=` in a
    // .env file) must still fall back to NCBI_EMAIL, as chinaxivHeaders does, and then to the
    // project's contact address, so every request carries the email Unpaywall requires.
    this.email =
      config.email?.trim() ||
      process.env.MED_RESEARCH_UNPAYWALL_EMAIL?.trim() ||
      process.env.NCBI_EMAIL?.trim() ||
      PROJECT_CONTACT_EMAIL;
    this.timeoutMs = config.timeoutMs ?? 15_000;
  }

  /**
   * Resolve a DOI to its open-access URLs. Returns `null` when Unpaywall has no
   * record or no OA copy. Network/parse failures also return `null` — the caller
   * falls through to the next strategy.
   */
  async resolve(doi: string): Promise<UnpaywallResult | null> {
    const url = `${UNPAYWALL_BASE}/${encodeURIComponent(doi)}?email=${encodeURIComponent(this.email)}`;
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), this.timeoutMs);
    let res: Response;
    try {
      res = await fetch(url, { signal: ac.signal, headers: { "User-Agent": USER_AGENT } });
    } catch {
      return null;
    } finally {
      clearTimeout(timer);
    }
    if (!res.ok) return null;

    let data: UnpaywallResponse;
    try {
      data = (await res.json()) as UnpaywallResponse;
    } catch {
      return null;
    }

    const locations: OaLocation[] = [];
    if (data.best_oa_location) locations.push(data.best_oa_location);
    for (const loc of data.oa_locations ?? []) {
      if (loc !== data.best_oa_location) locations.push(loc);
    }

    // For each location prefer the direct PDF, then the landing/reading URL.
    const urls: string[] = [];
    for (const loc of locations) {
      if (loc.url_for_pdf) urls.push(loc.url_for_pdf);
      if (loc.url) urls.push(loc.url);
    }

    const deduped = [...new Set(urls.filter(Boolean))];
    if (deduped.length === 0) return null;

    return { doi, isOa: Boolean(data.is_oa), urls: deduped };
  }
}
