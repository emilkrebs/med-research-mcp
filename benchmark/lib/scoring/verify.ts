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
 *  - Regional records — Europe PMC ids outside PubMed (`CBA:521529`, `PPR123`,
 *    europepmc.org/article/SRC/ID links) and ChinaXiv ids (`chinaxiv-202608.00133`)
 *    — are looked up in their own database and, when found, graded with the same
 *    grader and counted like a valid PMID. Not found stays in `other`.
 *  - Everything else (a DOI PubMed has never heard of, arXiv-style ids,
 *    publisher article URLs, regional ids that don't resolve) is reported in
 *    `other`: counted, NOT graded, and NEVER counted as fabricated — we cannot
 *    prove a DOI or a preprint doesn't exist, so we don't punish it.
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
 * `fetchLiterature` treats abstracts as best-effort and only warns when efetch
 * fails; the default lookup turns that warning — or a control PMID that came
 * back without its abstract — into a failure too, because both the evidence
 * grade and the attribution audit read the abstract: a silently title-only
 * record would change scores depending on NCBI's rate limits.
 */

import { fetchLiterature, keywordGrade, NcbiClient, PubMedAdapter, NullCache } from "../core.js";
import type { StudyType } from "../core.js";
import type { EvidenceDetail } from "../types.js";

export interface PmidFacts {
  /** PMID, or the regional id for a non-PubMed record (`CBA:521529`, `chinaxiv-…`). */
  pmid: string;
  exists: boolean;
  evidenceScore: number; // 0–5, meaningful only when exists
  studyType: StudyType;
  title: string;
  abstract: string;
  /** Set for non-PubMed records ("europepmc", "chinaxiv"); absent means PubMed. */
  database?: string;
  /** Author names as the database lists them ("Wang X", "Chen Zuhong"). Read by the attribution check. */
  authors?: string[];
  pubYear?: number;
  /** NLM publication types (PubMed only). */
  publicationTypes?: string[];
  meshHeadings?: string[];
}

/** First plausible year in a free-form date ("2026 Sep 21", "2026-08-26", "2005"). */
export function yearOf(date: string | undefined): number | undefined {
  const m = /\b(1[89]\d\d|20\d\d)\b/.exec(date ?? "");
  return m ? Number(m[1]) : undefined;
}

/** A citation to a record outside PubMed that can still be looked up. */
export interface RegionalId {
  database: "europepmc" | "chinaxiv";
  /** `CBA:521529` / `PPR123456` for Europe PMC, `chinaxiv-202608.00133` for ChinaXiv. */
  id: string;
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
  /** Europe PMC (non-PubMed) and ChinaXiv records, looked up in their own database. */
  regional: RegionalId[];
  /** Identifiers that can never map to PubMed (preprints, arXiv-style, publisher URLs). */
  other: OtherCitation[];
}

/**
 * Real PMIDs have 1–9 digits; lists after the first anchored id need ≥6 to avoid years etc.
 * The first id may be short, but not a 19xx/20xx year or the start of a decimal or DOI
 * ("PMID: 10.1001/jama…" must not read as PMID 10).
 */
const PMID_ANCHOR = /(?:pmids?|pubmed\s*(?:ids?|identifiers?|uids?))[)\]]?\s*[:#=]?\s*/gi;
const PMID_FIRST = /\(?\s*(?!(?:19|20)\d\d(?!\d))(\d{1,9})(?!\.?\d)\)?\s*(?:[,;&/]|and)?\s*/y;
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

/** Europe PMC sources whose numeric ids collide with PMIDs, so they are cited `SRC:id`. */
const EPMC_PREFIXED_RE = /\b(CBA|AGR|CTX|ETH|HIR|PAT)\s*[:#]\s*(\d{3,12})\b/g;
const EPMC_URL_RE = /europepmc\.org\/(?:abstract|article)\/(MED|PMC|PPR|CBA|AGR|CTX|ETH|HIR|PAT)\/(\w+)/gi;
const CHINAXIV_ID_RE = /\bchinaxiv[-:](\d{6}\.\d{4,6})\b/gi;
const DOI_RE = /\b10\.\d{4,9}\/[^\s<>"'`]+/gi;
const PMCID_RE = /\bPMC\d{4,9}\b/gi;
const EUROPEPMC_RE = /\bPPR\d{3,}\b/g;
const ARXIV_RE = /\b(?:arxiv\s*:\s*\d{4}\.\d{4,5}(?:v\d+)?|chinaxiv[-:\s]*[\w.]+\d|russiarxiv[-:\s]*[\w.]+\d)/gi;
/** Publisher / repository article URLs that carry no DOI or PMID in the URL itself. */
const ARTICLE_URL_RE =
  /https?:\/\/(?:[\w-]+\.)*(?:nature\.com\/articles|sciencedirect\.com\/science\/article|link\.springer\.com\/article|jamanetwork\.com\/journals|thelancet\.com\/journals|bmj\.com\/content|nejm\.org\/doi|cochranelibrary\.com\/cdsr|mdpi\.com\/\d|frontiersin\.org\/articles|journals\.plos\.org|europepmc\.org\/article|researchgate\.net\/publication|semanticscholar\.org\/paper|scholar\.archive\.org)\/[^\s<>"'`]*/gi;

/** Find every citation-shaped identifier in `text`. */
export function extractCitations(text: string): ExtractedCitations {
  const pmids = new Set(extractPmids(text));
  const dois = new Set<string>();
  for (const m of text.matchAll(DOI_RE)) {
    const d = trimTrailing(m[0]).toLowerCase();
    if (/^10\.\d{4,9}\/\S+/.test(d)) dois.add(d);
  }
  const pmcids = new Set<string>();
  for (const m of text.matchAll(PMCID_RE)) pmcids.add(m[0].toUpperCase());

  const regional = new Map<string, RegionalId>();
  const addRegional = (database: RegionalId["database"], id: string): void => {
    regional.set(`${database}:${id}`, { database, id });
  };
  for (const m of text.matchAll(EPMC_PREFIXED_RE)) addRegional("europepmc", `${m[1]}:${m[2]}`);
  for (const m of text.matchAll(EUROPEPMC_RE)) addRegional("europepmc", m[0]);
  for (const m of text.matchAll(EPMC_URL_RE)) {
    const src = m[1]!.toUpperCase();
    const id = m[2]!;
    if (src === "MED" && /^\d{1,9}$/.test(id)) pmids.add(id);
    else if (src === "PMC") pmcids.add(id.toUpperCase().startsWith("PMC") ? id.toUpperCase() : `PMC${id}`);
    else if (src === "PPR") addRegional("europepmc", id.toUpperCase());
    else if (/^\d+$/.test(id)) addRegional("europepmc", `${src}:${id}`);
  }
  for (const m of text.matchAll(CHINAXIV_ID_RE)) addRegional("chinaxiv", `chinaxiv-${m[1]}`);

  const other = new Map<string, OtherCitation>();
  for (const m of text.matchAll(ARXIV_RE)) {
    const id = trimTrailing(m[0]).toLowerCase().replace(/\s+/g, "");
    if (/^chinaxiv[-:]\d{6}\.\d{4,6}$/.test(id)) continue; // a ChinaXiv id, handled above
    other.set(id, { id, kind: "arxiv-like" });
  }
  for (const m of text.matchAll(ARTICLE_URL_RE)) {
    const url = trimTrailing(m[0]);
    // A URL that embeds a DOI is already captured as a DOI; a Europe PMC record link above.
    if (/\b10\.\d{4,9}\//.test(url) || new RegExp(EPMC_URL_RE.source, "i").test(url)) continue;
    other.set(url.toLowerCase(), { id: url, kind: "url" });
  }
  return { pmids: [...pmids], dois: [...dois], pmcids: [...pmcids], regional: [...regional.values()], other: [...other.values()] };
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
  /**
   * Look up and grade a regional record. Return `null` when the database answered
   * and has no such record; MUST throw on transient failure. Defaults to live
   * Europe PMC / ChinaXiv lookups only when `fetchArticles` is also the default,
   * so an injected (offline) verifier never touches the network.
   */
  lookupRegional?: (item: RegionalId) => Promise<PmidFacts | null>;
}

/** PMID known to exist (pinned factual-01 subject); fetched with each batch to detect silent NCBI failures. */
const CONTROL_PMID = "36615805";

/** Fetches and grades PMIDs against live PubMed, memoized for the process. */
export class Verifier {
  private readonly memo = new Map<string, PmidFacts>();
  private readonly resolveMemo = new Map<string, string | null>();
  private readonly fetchArticles: (pmids: string[]) => Promise<FetchResult>;
  private readonly resolveId: (item: IdToResolve) => Promise<string | null>;
  private readonly regionalMemo = new Map<string, PmidFacts | null>();
  private readonly lookupRegional: (item: RegionalId) => Promise<PmidFacts | null>;

  constructor(options: VerifierOptions = {}) {
    const ncbi = options.ncbi ?? new NcbiClient();
    this.fetchArticles = options.fetchArticles ?? ((pmids) => defaultFetch(pmids, ncbi));
    this.resolveId = options.resolveId ?? ((item) => defaultResolve(item, ncbi));
    this.lookupRegional = options.lookupRegional ?? (options.fetchArticles ? async () => null : defaultRegionalLookup);
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

  /** Look up regional records (`null` = not in that database). Answers are memoized; failures throw. */
  async verifyRegional(items: RegionalId[]): Promise<Map<string, PmidFacts | null>> {
    const out = new Map<string, PmidFacts | null>();
    for (const item of items) {
      const key = `${item.database}:${item.id}`;
      if (!this.regionalMemo.has(key)) this.regionalMemo.set(key, await this.lookupRegional(item));
      out.set(key, this.regionalMemo.get(key) ?? null);
    }
    return out;
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
  const { articles, missing, warnings } = await fetcher({ ids: withControl, database: "pubmed" }, new NullCache(), new PubMedAdapter(ncbi));
  if (missing.includes(CONTROL_PMID) || !articles.some((a) => a.pmid === CONTROL_PMID)) {
    throw new Error("NCBI lookup returned no data for the control PMID; treating the batch as a transient failure");
  }
  // efetch can also fail silently (an error body with HTTP 200 parses as "no articles");
  // the control PMID always has an abstract, so a missing one means the batch's abstracts are gone.
  const control = articles.find((a) => a.pmid === CONTROL_PMID);
  if (warnings?.some((w) => /abstracts could not be fetched/i.test(w)) || !control?.abstract) {
    throw new Error("NCBI efetch returned no abstracts; treating the batch as a transient failure");
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
      authors: article.authors,
      ...(yearOf(article.pubDate) !== undefined ? { pubYear: yearOf(article.pubDate) } : {}),
      publicationTypes: article.publicationTypes,
      ...(article.meshHeadings ? { meshHeadings: article.meshHeadings } : {}),
    });
  }
  return { found, missing: missing.filter((p) => p !== CONTROL_PMID) };
}

const EPMC_SEARCH = "https://www.ebi.ac.uk/europepmc/webservices/rest/search";
const CHINAXIV_PAPERS = "https://chinarxiv.org/api/v1/papers";

/** Grade a regional record exactly like a PubMed one (same keyword grader, no NLM publication types). */
function regionalFacts(id: string, database: string, a: { title: string; abstract: string; authors: string[]; pubDate: string; journal: string }): PmidFacts {
  const graded = keywordGrade({ pmid: id, title: a.title, abstract: a.abstract, authors: a.authors, journal: a.journal, pubDate: a.pubDate, publicationTypes: [] });
  return {
    pmid: id,
    exists: true,
    evidenceScore: graded.evidenceScore,
    studyType: graded.studyType,
    title: a.title,
    abstract: a.abstract,
    database,
    authors: a.authors,
    ...(yearOf(a.pubDate) !== undefined ? { pubYear: yearOf(a.pubDate) } : {}),
  };
}

async function getJson(url: string): Promise<{ status: number; body: unknown }> {
  const res = await fetch(url, { signal: AbortSignal.timeout(20_000), headers: { accept: "application/json" } });
  if (res.status === 404) return { status: 404, body: null };
  if (!res.ok) throw new Error(`${url} answered HTTP ${res.status}`);
  return { status: res.status, body: await res.json() };
}

/**
 * Default regional lookup: Europe PMC by EXT_ID + SRC (an exact match, unlike a
 * bare-id query), ChinaXiv by its `/papers/{id}` endpoint. Throws on network errors.
 */
export async function defaultRegionalLookup(item: RegionalId): Promise<PmidFacts | null> {
  if (item.database === "chinaxiv") {
    const { status, body } = await getJson(`${CHINAXIV_PAPERS}/${encodeURIComponent(item.id)}`);
    const r = body as Record<string, unknown> | null;
    if (status === 404 || !r || r.id !== item.id) return null;
    const str = (v: unknown): string => (typeof v === "string" ? v : "");
    const authors = (Array.isArray(r.authors) ? r.authors : []).flatMap((x) => String(x).split(/[;,]/)).map((x) => x.trim()).filter(Boolean);
    return regionalFacts(item.id, "chinaxiv", {
      title: str(r.title_en) || str(r.title),
      abstract: str(r.abstract_en) || str(r.abstract),
      authors,
      pubDate: str(r.date) || str(r.pub_date) || str(r.year),
      journal: str(r.publication) || "ChinaXiv",
    });
  }
  const prefixed = /^([A-Z]{3}):(\d+)$/.exec(item.id);
  const [src, extId] = prefixed ? [prefixed[1]!, prefixed[2]!] : ["PPR", item.id];
  const params = new URLSearchParams({ query: `EXT_ID:${extId} AND SRC:${src}`, format: "json", resultType: "core", pageSize: "1" });
  const { body } = await getJson(`${EPMC_SEARCH}?${params.toString()}`);
  const r = (body as { resultList?: { result?: Record<string, unknown>[] } } | null)?.resultList?.result?.[0];
  if (!r || String(r.id) !== extId) return null;
  const str = (v: unknown): string => (typeof v === "string" ? v : "");
  return regionalFacts(item.id, "europepmc", {
    title: str(r.title).replace(/\.$/, ""),
    abstract: str(r.abstractText).replace(/<[^>]+>/g, ""),
    authors: str(r.authorString).split(/[;,]/).map((x) => x.trim().replace(/\.$/, "")).filter(Boolean),
    pubDate: str(r.pubYear) || str(r.firstPublicationDate),
    journal: str(r.journalTitle),
  });
}

/** Default DOI/PMCID resolution via PubMed esearch (`<doi>[doi]`, `PMC123[pmcid]`). Exactly one hit resolves. */
async function defaultResolve(item: IdToResolve, ncbi: NcbiClient): Promise<string | null> {
  const query = item.kind === "doi" ? `"${item.id}"[doi]` : `${item.id}[pmcid]`;
  const { pmids } = await ncbi.esearch({ query, maxResults: 2 });
  return pmids.length === 1 ? pmids[0]! : null;
}

/** Summary of a response's citations after verification. */
export interface CitationAudit {
  /** PMIDs cited (directly or via a resolved DOI/PMCID) plus resolved regional ids, excluding those echoed from the prompt. */
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

  // Regional records count like PMIDs when their database has them; otherwise they
  // stay in `other` (never fabricated: absence from a regional index proves little).
  const regional = await verifier.verifyRegional(extracted.regional);
  for (const item of extracted.regional) {
    const f = regional.get(`${item.database}:${item.id}`);
    if (f) {
      counted.push(f.pmid);
      valid.push(f);
    } else {
      other.set(item.id.toLowerCase(), { id: item.id, kind: item.database === "chinaxiv" ? "arxiv-like" : "europepmc" });
    }
  }
  const evidenceQuality = valid.length > 0 ? valid.reduce((s, f) => s + f.evidenceScore, 0) / valid.length : 0;
  return { cited: counted, valid, fabricated, evidenceQuality, other: [...other.values()], echoedFromPrompt };
}
