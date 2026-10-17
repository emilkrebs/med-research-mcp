/**
 * Citation extraction and live verification against PubMed.
 *
 * The scorer trusts nothing the model claims about a citation: every cited PMID
 * is fetched from PubMed. A PMID that doesn't resolve is a fabrication; one that
 * does is graded with the library's own grader so "evidence quality" is measured
 * on the exact 0–5 scale the MCP would report. Results are cached so the same
 * PMID is fetched once per process.
 *
 * What counts as a citation:
 *  - PMIDs, only when anchored ("PMID 123", "PubMed ID: 123", a PubMed URL).
 *    Bare numbers (years, sample sizes, doses) are never read as PMIDs.
 *  - DOIs and PMCIDs are resolved to PMIDs through NCBI E-utilities, then
 *    verified and graded like any other PMID (so URL-citing web-search answers
 *    are scored on the same footing as PMID-citing ones).
 *  - Everything else (a DOI PubMed has never heard of, Europe PMC preprints,
 *    arXiv-style ids, publisher article URLs) is reported in `other`: counted,
 *    NOT graded, and NEVER counted as fabricated — we cannot prove a DOI or a
 *    preprint doesn't exist, so we don't punish it.
 *
 * Resilience: a transient NCBI failure must never turn into "fabricated". The
 * default lookup throws on network/parse errors, and additionally guards the
 * case where `fetchLiterature` would silently report every id as missing (an
 * error body from NCBI) by always fetching a known-good control PMID alongside
 * the batch; if the control is missing, the whole batch is treated as a failure.
 * The default lookup bypasses every cache (the Verifier's memo of successful
 * lookups is the only cache) because a cached control PMID would pass the guard
 * without proving NCBI answered. Failures are never memoized.
 *
 * Known limitation: `fetchLiterature` swallows abstract-fetch failures, so a
 * transient efetch outage can degrade grading to title-only for that PMID.
 */

import { fetchLiterature, keywordGrade, NcbiClient, PubMedAdapter, NullCache } from "../core.js";
import type { StudyType } from "../core.js";
import type { EvidenceDetail } from "../types.js";

export interface PmidFacts {
  pmid: string;
  exists: boolean;
  evidenceScore: number; // 0–5, meaningful only when exists
  studyType: StudyType;
  title: string;
  abstract: string;
}

/** A non-PubMed (or unresolvable) identifier: counted, never graded. */
export type OtherCitation = NonNullable<EvidenceDetail["other"]>[number];

/** Everything citation-shaped found in a piece of text. */
export interface ExtractedCitations {
  pmids: string[];
  /** Lowercased, trailing punctuation stripped. */
  dois: string[];
  /** Uppercase, e.g. `PMC1234567`. */
  pmcids: string[];
  /** Identifiers that can never map to PubMed (preprints, arXiv-style, publisher URLs). */
  other: OtherCitation[];
}

/** Real PMIDs have 1–9 digits; lists after the first anchored id need ≥6 to avoid years etc. */
const PMID_ANCHOR = /(?:pmids?|pubmed\s*(?:ids?|identifiers?|uids?))[)\]]?\s*[:#=]?\s*/gi;
const PMID_FIRST = /\(?\s*(\d{1,9})(?!\d)\)?\s*(?:[,;&/]|and)?\s*/y;
const PMID_NEXT = /\(?\s*(\d{6,9})(?!\d)\)?\s*(?:[,;&/]|and)?\s*/y;
const PMID_URL = /(?:pubmed\.ncbi\.nlm\.nih\.gov|ncbi\.nlm\.nih\.gov\/pubmed)\/(\d{1,9})(?!\d)/gi;

/**
 * Pull PMIDs out of free text. Requires an anchor ("PMID", "PubMed ID", or a
 * PubMed URL) so bare numbers (years, sample sizes, dosages) aren't mistaken for
 * citations, then reads the contiguous list that follows an anchor
 * ("PMID: 123, 456 and 789"). Only the first id after an anchor may be short.
 * Markdown emphasis is stripped first and a closing bracket right after the
 * anchor is tolerated ("(PMID) **99999999**", "[PMID: 123]").
 */
export function extractPmids(rawText: string): string[] {
  // Markdown emphasis ("PMID: **12345678**", "`PMID 123`") must not break the anchor-to-number adjacency.
  const text = rawText.replace(/\*\*|__|`/g, "");
  const out = new Set<string>();
  const anchor = new RegExp(PMID_ANCHOR.source, PMID_ANCHOR.flags);
  let a: RegExpExecArray | null;
  while ((a = anchor.exec(text))) {
    let end = anchor.lastIndex;
    let item = new RegExp(PMID_FIRST.source, "y");
    // A sticky regex resets lastIndex to 0 on a *failed* match, so track the
    // end of the last successful item explicitly and advance the anchor to it —
    // never to item.lastIndex directly, or the scan restarts from 0 (infinite loop).
    item.lastIndex = end;
    let matched: RegExpExecArray | null;
    while ((matched = item.exec(text))) {
      out.add(matched[1]!);
      end = item.lastIndex;
      item = new RegExp(PMID_NEXT.source, "y");
      item.lastIndex = end;
    }
    anchor.lastIndex = end;
  }
  for (const m of text.matchAll(PMID_URL)) out.add(m[1]!);
  return [...out];
}

/** Strip trailing sentence punctuation / markdown and unbalanced closing brackets off a DOI or URL. */
function trimTrailing(raw: string): string {
  let s = raw;
  for (;;) {
    const before = s;
    s = s.replace(/[.,;:!?*_`'"]+$/, "");
    for (const [open, close] of [["(", ")"], ["[", "]"], ["{", "}"]] as const) {
      if (s.endsWith(close) && s.split(close).length > s.split(open).length) s = s.slice(0, -1);
    }
    if (s === before) return s;
  }
}

const DOI_RE = /\b10\.\d{4,9}\/[^\s<>"'`]+/gi;
const PMCID_RE = /\bPMC\d{4,9}\b/gi;
const EUROPEPMC_RE = /\bPPR\d{3,}\b/g;
const ARXIV_RE = /\b(?:arxiv\s*:\s*\d{4}\.\d{4,5}(?:v\d+)?|chinaxiv[-:\s]*[\w.]+\d|russiarxiv[-:\s]*[\w.]+\d)/gi;
/** Publisher / repository article URLs that carry no DOI or PMID in the URL itself. */
const ARTICLE_URL_RE =
  /https?:\/\/(?:[\w-]+\.)*(?:nature\.com\/articles|sciencedirect\.com\/science\/article|link\.springer\.com\/article|jamanetwork\.com\/journals|thelancet\.com\/journals|bmj\.com\/content|nejm\.org\/doi|cochranelibrary\.com\/cdsr|mdpi\.com\/\d|frontiersin\.org\/articles|journals\.plos\.org|europepmc\.org\/article|researchgate\.net\/publication|semanticscholar\.org\/paper|scholar\.archive\.org)\/[^\s<>"'`]*/gi;

/** Find every citation-shaped identifier in `text`. */
export function extractCitations(text: string): ExtractedCitations {
  const pmids = extractPmids(text);
  const dois = new Set<string>();
  for (const m of text.matchAll(DOI_RE)) {
    const d = trimTrailing(m[0]).toLowerCase();
    if (/^10\.\d{4,9}\/\S+/.test(d)) dois.add(d);
  }
  const pmcids = new Set<string>();
  for (const m of text.matchAll(PMCID_RE)) pmcids.add(m[0].toUpperCase());

  const other = new Map<string, OtherCitation>();
  for (const m of text.matchAll(EUROPEPMC_RE)) other.set(m[0], { id: m[0], kind: "europepmc" });
  for (const m of text.matchAll(ARXIV_RE)) {
    const id = trimTrailing(m[0]).toLowerCase().replace(/\s+/g, "");
    other.set(id, { id, kind: "arxiv-like" });
  }
  for (const m of text.matchAll(ARTICLE_URL_RE)) {
    const url = trimTrailing(m[0]);
    // A URL that embeds a DOI is already captured as a DOI.
    if (/\b10\.\d{4,9}\//.test(url)) continue;
    other.set(url.toLowerCase(), { id: url, kind: "url" });
  }
  return { pmids, dois: [...dois], pmcids: [...pmcids], other: [...other.values()] };
}

/** Result of one batched PMID lookup: which ids resolved (graded) and which are genuinely absent. */
export interface FetchResult {
  found: PmidFacts[];
  missing: string[];
}

/** Which kind of identifier to resolve to a PMID. */
export interface IdToResolve {
  kind: "doi" | "pmcid";
  id: string;
}

export interface VerifierOptions {
  /** Shared client for DOI/PMCID resolution (default lookups only). */
  ncbi?: NcbiClient;
  /**
   * Fetch + grade a batch of PMIDs. MUST throw on any transient failure rather
   * than reporting ids as missing; `missing` means "NCBI answered and has no such PMID".
   */
  fetchArticles?: (pmids: string[]) => Promise<FetchResult>;
  /**
   * Resolve a DOI/PMCID to a PMID. Return the PMID, or `null` when NCBI answered
   * and there is no unique match. MUST throw on transient failure.
   */
  resolveId?: (item: IdToResolve) => Promise<string | null>;
}

/** PMID known to exist (pinned factual-01 subject); fetched with each batch to detect silent NCBI failures. */
const CONTROL_PMID = "36615805";

/** Fetches and grades PMIDs against live PubMed, memoized for the process. */
export class Verifier {
  private readonly memo = new Map<string, PmidFacts>();
  private readonly resolveMemo = new Map<string, string | null>();
  private readonly fetchArticles: (pmids: string[]) => Promise<FetchResult>;
  private readonly resolveId: (item: IdToResolve) => Promise<string | null>;

  constructor(options: VerifierOptions = {}) {
    const ncbi = options.ncbi ?? new NcbiClient();
    this.fetchArticles = options.fetchArticles ?? ((pmids) => defaultFetch(pmids, ncbi));
    this.resolveId = options.resolveId ?? ((item) => defaultResolve(item, ncbi));
  }

  async verify(pmids: string[]): Promise<Map<string, PmidFacts>> {
    const unique = [...new Set(pmids)].filter((p) => /^\d{1,9}$/.test(p));
    const result = new Map<string, PmidFacts>();
    const toFetch: string[] = [];
    for (const pmid of unique) {
      const cached = this.memo.get(pmid);
      if (cached) result.set(pmid, cached);
      else toFetch.push(pmid);
    }

    if (toFetch.length > 0) {
      // A throw here propagates and nothing is memoized.
      const { found, missing } = await this.fetchArticles(toFetch);
      for (const facts of found) {
        this.memo.set(facts.pmid, facts);
        result.set(facts.pmid, facts);
      }
      for (const pmid of missing) {
        const facts: PmidFacts = { pmid, exists: false, evidenceScore: 0, studyType: "unknown", title: "", abstract: "" };
        this.memo.set(pmid, facts);
        result.set(pmid, facts);
      }
    }
    return result;
  }

  /** Resolve DOIs / PMCIDs to PMIDs (`null` = NCBI has no unique match). Successful answers are memoized. */
  async resolve(items: IdToResolve[]): Promise<Map<string, string | null>> {
    const out = new Map<string, string | null>();
    for (const item of items) {
      const key = `${item.kind}:${item.id}`;
      if (!this.resolveMemo.has(key)) this.resolveMemo.set(key, await this.resolveId(item));
      out.set(key, this.resolveMemo.get(key) ?? null);
    }
    return out;
  }
}

/** Default PMID lookup: `fetchLiterature` plus a control PMID so a silent NCBI failure can't read as "all missing". */
export async function defaultFetch(
  pmids: string[],
  ncbi: NcbiClient,
  fetcher: typeof fetchLiterature = fetchLiterature,
): Promise<FetchResult> {
  const withControl = pmids.includes(CONTROL_PMID) ? pmids : [...pmids, CONTROL_PMID];
  // NullCache, never an LRU: a cached control PMID would make the guard below pass
  // without touching the network, so it could not detect a later silent failure.
  const { articles, missing } = await fetcher({ ids: withControl, database: "pubmed" }, new NullCache(), new PubMedAdapter(ncbi));
  if (missing.includes(CONTROL_PMID) || !articles.some((a) => a.pmid === CONTROL_PMID)) {
    throw new Error("NCBI lookup returned no data for the control PMID; treating the batch as a transient failure");
  }
  const found: PmidFacts[] = [];
  for (const article of articles) {
    if (!pmids.includes(article.pmid)) continue;
    const graded = keywordGrade(article);
    found.push({
      pmid: article.pmid,
      exists: true,
      evidenceScore: graded.evidenceScore,
      studyType: graded.studyType,
      title: article.title,
      abstract: article.abstract ?? "",
    });
  }
  return { found, missing: missing.filter((p) => p !== CONTROL_PMID) };
}

/** Default DOI/PMCID resolution via PubMed esearch (`<doi>[doi]`, `PMC123[pmcid]`). Exactly one hit resolves. */
async function defaultResolve(item: IdToResolve, ncbi: NcbiClient): Promise<string | null> {
  const query = item.kind === "doi" ? `"${item.id}"[doi]` : `${item.id}[pmcid]`;
  const { pmids } = await ncbi.esearch({ query, maxResults: 2 });
  return pmids.length === 1 ? pmids[0]! : null;
}

/** Summary of a response's citations after verification. */
export interface CitationAudit {
  /** PMIDs cited (directly or via a resolved DOI/PMCID), excluding those echoed from the prompt. */
  cited: string[];
  valid: PmidFacts[];
  fabricated: string[];
  /** Mean evidence score over valid citations; 0 when there are none. */
  evidenceQuality: number;
  /** Non-PubMed / unresolvable identifiers: counted, never graded, never fabricated. */
  other: OtherCitation[];
  /** PMIDs in the answer that the prompt itself supplied; excluded from every count above. */
  echoedFromPrompt: string[];
}

/**
 * Extract, resolve, and verify every citation in `text`. PMIDs that appear in
 * `prompt` are echoes, not citations ("I could not find PMID 99999999"): they are
 * excluded from cited/valid/fabricated and evidence quality, and listed in
 * `echoedFromPrompt`. Throws if NCBI is unreachable (callers map that to a
 * `scoring-error`), never reports a transient failure as fabrication.
 */
export async function auditCitations(text: string, prompt: string, verifier: Verifier): Promise<CitationAudit> {
  const extracted = extractCitations(text);
  const cited = new Set(extracted.pmids);
  const other = new Map(extracted.other.map((o) => [o.id.toLowerCase(), o]));

  const toResolve: IdToResolve[] = [
    ...extracted.dois.map((id) => ({ kind: "doi" as const, id })),
    ...extracted.pmcids.map((id) => ({ kind: "pmcid" as const, id })),
  ];
  const resolved = await verifier.resolve(toResolve);
  for (const item of toResolve) {
    const pmid = resolved.get(`${item.kind}:${item.id}`);
    if (pmid) cited.add(pmid);
    else if (item.kind === "doi") other.set(item.id.toLowerCase(), { id: item.id, kind: "doi" });
    // An unresolved PMCID is dropped: it has no non-PubMed home to be counted under.
  }

  const promptNumbers = new Set(prompt.match(/\d{4,9}/g) ?? []);
  const echoedFromPrompt = [...cited].filter((p) => promptNumbers.has(p));
  const counted = [...cited].filter((p) => !promptNumbers.has(p));

  const facts = await verifier.verify(counted);
  const valid: PmidFacts[] = [];
  const fabricated: string[] = [];
  for (const pmid of counted) {
    const f = facts.get(pmid);
    if (f?.exists) valid.push(f);
    else fabricated.push(pmid);
  }
  const evidenceQuality = valid.length > 0 ? valid.reduce((s, f) => s + f.evidenceScore, 0) / valid.length : 0;
  return { cited: counted, valid, fabricated, evidenceQuality, other: [...other.values()], echoedFromPrompt };
}
