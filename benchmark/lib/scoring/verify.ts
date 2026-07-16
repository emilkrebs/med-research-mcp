/**
 * PMID extraction and live verification against PubMed.
 *
 * The scorer trusts nothing the model claims about a citation: every cited PMID
 * is fetched from PubMed. A PMID that doesn't resolve is a fabrication; one that
 * does is graded with the library's own grader so "evidence quality" is measured
 * on the exact 0–5 scale the MCP would report. Results are cached so the same
 * PMID is fetched once per process.
 */

import { fetchLiterature, keywordGrade, NcbiClient, LRUBackend, type Cache } from "../core.js";
import type { StudyType } from "../core.js";

export interface PmidFacts {
  pmid: string;
  exists: boolean;
  evidenceScore: number; // 0–5, meaningful only when exists
  studyType: StudyType;
  title: string;
  abstract: string;
}

/**
 * Pull PMIDs out of free text. Requires a literal "PMID" anchor so bare numbers
 * (years, sample sizes, dosages) aren't mistaken for citations, then reads the
 * contiguous list that follows it ("PMID: 123, 456 and 789").
 */
export function extractPmids(text: string): string[] {
  const out = new Set<string>();
  const anchor = /pmid[s]?\s*[:#]?\s*/gi;
  // Sticky: match "number + optional separator" repeatedly, contiguously.
  const item = /\(?\s*(\d{6,9})\)?\s*(?:[,;&/]|and)?\s*/y;
  let a: RegExpExecArray | null;
  while ((a = anchor.exec(text))) {
    item.lastIndex = anchor.lastIndex;
    // A sticky regex resets lastIndex to 0 on a *failed* match, so track the
    // end of the last successful item explicitly and advance the anchor to it —
    // never to item.lastIndex directly, or the scan restarts from 0 (infinite loop).
    let end = anchor.lastIndex;
    let matched: RegExpExecArray | null;
    while ((matched = item.exec(text))) {
      out.add(matched[1]!);
      end = item.lastIndex;
    }
    anchor.lastIndex = end;
  }
  return [...out];
}

/** Fetches and grades PMIDs against live PubMed, memoized for the process. */
export class Verifier {
  private readonly memo = new Map<string, PmidFacts>();

  constructor(
    private readonly cache: Cache = new LRUBackend(),
    private readonly ncbi: NcbiClient = new NcbiClient(),
  ) {}

  async verify(pmids: string[]): Promise<Map<string, PmidFacts>> {
    const unique = [...new Set(pmids)].filter((p) => /^\d{6,9}$/.test(p));
    const result = new Map<string, PmidFacts>();
    const toFetch: string[] = [];
    for (const pmid of unique) {
      const cached = this.memo.get(pmid);
      if (cached) result.set(pmid, cached);
      else toFetch.push(pmid);
    }

    if (toFetch.length > 0) {
      const { articles, missing } = await fetchLiterature({ ids: toFetch, database: "pubmed" }, this.cache);
      for (const article of articles) {
        const graded = keywordGrade(article);
        const facts: PmidFacts = {
          pmid: article.pmid,
          exists: true,
          evidenceScore: graded.evidenceScore,
          studyType: graded.studyType,
          title: article.title,
          abstract: article.abstract ?? "",
        };
        this.memo.set(article.pmid, facts);
        result.set(article.pmid, facts);
      }
      for (const pmid of missing) {
        const facts: PmidFacts = { pmid, exists: false, evidenceScore: 0, studyType: "unknown", title: "", abstract: "" };
        this.memo.set(pmid, facts);
        result.set(pmid, facts);
      }
    }
    return result;
  }

  /** Verify one PMID (used by evidence-score answer keys). */
  async verifyOne(pmid: string): Promise<PmidFacts> {
    const map = await this.verify([pmid]);
    return (
      map.get(pmid) ?? { pmid, exists: false, evidenceScore: 0, studyType: "unknown", title: "", abstract: "" }
    );
  }
}

/** Summary of a response's citations after verification. */
export interface CitationAudit {
  cited: string[];
  valid: PmidFacts[];
  fabricated: string[];
  /** Mean evidence score over valid citations; 0 when there are none. */
  evidenceQuality: number;
}

export async function auditCitations(text: string, verifier: Verifier): Promise<CitationAudit> {
  const cited = extractPmids(text);
  const facts = await verifier.verify(cited);
  const valid: PmidFacts[] = [];
  const fabricated: string[] = [];
  for (const pmid of cited) {
    const f = facts.get(pmid);
    if (f?.exists) valid.push(f);
    else fabricated.push(pmid);
  }
  const evidenceQuality = valid.length > 0 ? valid.reduce((s, f) => s + f.evidenceScore, 0) / valid.length : 0;
  return { cited, valid, fabricated, evidenceQuality };
}
