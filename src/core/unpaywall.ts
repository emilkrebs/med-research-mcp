/**
 * Unpaywall API client — resolves a DOI to the best legal open-access copy.
 *
 * Unpaywall (https://unpaywall.org) aggregates OA copies from preprint servers
 * (arXiv, bioRxiv), institutional repositories, PubMed Central, and publisher-
 * hosted OA. It's free and needs no key, but "requests must include your email"
 * and it asks users to "limit use to 100,000 calls per day"
 * (https://unpaywall.org/products/api, checked 2026-10-19).
 */

import { LRUCache } from "lru-cache";
import { contactEmail, envSetting, PROJECT_CONTACT_EMAIL, PROJECT_TOOL, USER_AGENT } from "./version.js";

const UNPAYWALL_BASE = "https://api.unpaywall.org/v2";
/** How long an answer is reused: a DOI's open-access copies change over weeks, not minutes. */
const DEFAULT_ANSWER_TTL_MS = 24 * 60 * 60 * 1000;

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

/** What Unpaywall answered for a DOI. */
export type UnpaywallLookup =
  | { status: "found"; result: UnpaywallResult }
  /** Unpaywall knows no open-access copy, or no record of the DOI (HTTP 404). */
  | { status: "none" }
  /** Not asked: Unpaywall is turned off, or there is no email to send. */
  | { status: "off" }
  /** No answer: a network error, a timeout, an unreadable body, or an HTTP error (`httpStatus`). */
  | { status: "failed"; httpStatus?: number };

export interface UnpaywallConfig {
  /**
   * Contact email required by Unpaywall. Defaults to $MED_RESEARCH_UNPAYWALL_EMAIL, then
   * $NCBI_EMAIL, then, with the default `tool`, PROJECT_CONTACT_EMAIL. A blank email turns the
   * lookups off, as does MED_RESEARCH_UNPAYWALL=0 when no email is passed.
   */
  email?: string;
  /**
   * The software making the requests, as in NcbiConfig. Unpaywall isn't sent it; only the default,
   * "med-research-mcp", falls back to PROJECT_CONTACT_EMAIL. Software built on the library sets its
   * own and passes its own `email`.
   */
  tool?: string;
  /** Per-request timeout in ms. Default 15000. */
  timeoutMs?: number;
  /** How long an answer (copies found, or none) is reused, in ms. Default one day; 0 disables. Failures aren't reused. */
  answerTtlMs?: number;
}

export class UnpaywallClient {
  private readonly email: string | undefined;
  private readonly timeoutMs: number;
  private readonly answers: LRUCache<string, UnpaywallLookup> | null;

  constructor(config: UnpaywallConfig = {}) {
    // MED_RESEARCH_UNPAYWALL=0 turns the lookups off unless code passes an email. An empty variable (a
    // blank .mcpb field, `MED_RESEARCH_UNPAYWALL_EMAIL=` in a .env file) still falls back to
    // NCBI_EMAIL, as chinaxivHeaders does, and then to the project's contact address.
    this.email =
      config.email === undefined && envSetting("MED_RESEARCH_UNPAYWALL") === "0"
        ? undefined
        : contactEmail(config.email, ["MED_RESEARCH_UNPAYWALL_EMAIL", "NCBI_EMAIL"], config.tool ?? PROJECT_TOOL);
    this.timeoutMs = config.timeoutMs ?? 15_000;
    const ttl = config.answerTtlMs ?? DEFAULT_ANSWER_TTL_MS;
    this.answers = ttl > 0 ? new LRUCache({ max: 500, ttl }) : null;
  }

  /** Whether the client makes requests: false when Unpaywall is turned off or there is no email to send. */
  get configured(): boolean {
    return Boolean(this.email);
  }

  /** Whether requests carry PROJECT_CONTACT_EMAIL, shared by every installation without an email of its own. */
  get sharedContact(): boolean {
    return this.email === PROJECT_CONTACT_EMAIL;
  }

  /**
   * Resolve a DOI to its open-access URLs. Returns `null` when Unpaywall has no
   * record or no OA copy, when the client is turned off, and on network, HTTP or
   * parse failures; {@link lookup} tells these apart.
   */
  async resolve(doi: string): Promise<UnpaywallResult | null> {
    const answer = await this.lookup(doi);
    return answer.status === "found" ? answer.result : null;
  }

  /** What Unpaywall answers for a DOI. Never throws. An answer is reused for `answerTtlMs`; a failure is asked again. */
  async lookup(doi: string): Promise<UnpaywallLookup> {
    if (!this.email) return { status: "off" };
    const key = doi.toLowerCase();
    const reused = this.answers?.get(key);
    if (reused) return reused;
    const answer = await this.ask(doi, this.email);
    if (answer.status !== "failed") this.answers?.set(key, answer);
    return answer;
  }

  private async ask(doi: string, email: string): Promise<UnpaywallLookup> {
    const url = `${UNPAYWALL_BASE}/${encodeURIComponent(doi)}?email=${encodeURIComponent(email)}`;
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), this.timeoutMs);
    let res: Response;
    try {
      res = await fetch(url, { signal: ac.signal, headers: { "User-Agent": USER_AGENT } });
    } catch {
      return { status: "failed" };
    } finally {
      clearTimeout(timer);
    }
    if (res.status === 404) return { status: "none" };
    if (!res.ok) return { status: "failed", httpStatus: res.status };

    let data: UnpaywallResponse;
    try {
      data = (await res.json()) as UnpaywallResponse;
    } catch {
      return { status: "failed" };
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
    if (deduped.length === 0) return { status: "none" };

    return { status: "found", result: { doi, isOa: Boolean(data.is_oa), urls: deduped } };
  }
}
