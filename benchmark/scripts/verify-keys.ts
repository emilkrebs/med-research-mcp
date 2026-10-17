#!/usr/bin/env -S npx tsx
/**
 * Live pre-publish check of every `verified: true` answer key against PubMed.
 *
 *   npx tsx benchmark/scripts/verify-keys.ts
 *
 *  - `values` keys: every PMID in the prompt and every `pmid: N` in `expected`
 *    must resolve; when `expected` names a `study type:` / `evidence score:`
 *    and the prompt names a subject PMID, the live `keywordGrade` must agree.
 *  - `reject` keys: the optional `probe` PubMed search should return nothing
 *    (hits are WARNINGS with titles, for a human to judge whether the "fake"
 *    study exists); any PMID in the prompt must NOT resolve.
 *
 * Exit code 1 on any MISMATCH (including a resolving fake PMID) or ERROR (a
 * key that could not be checked is not verified); probe hits and missing
 * probes do not fail the run. The checking logic
 * takes injected lookups so it is testable offline.
 */

import "../lib/loadenv.js";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { searchLiterature, NcbiClient, PubMedAdapter } from "../lib/core.js";
import { defaultFetch } from "../lib/scoring/verify.js";
import { QUERIES } from "../lib/queries.js";
import type { BenchmarkQuery } from "../lib/types.js";

/** What a PMID lookup yields. `exists: false` means PubMed returned nothing for it. */
export interface PmidInfo {
  exists: boolean;
  studyType?: string;
  evidenceScore?: number;
  title?: string;
}

export interface Lookups {
  /** Resolve PMIDs. Must throw (not return `exists: false`) when PubMed is unreachable. */
  fetchPmids(pmids: string[]): Promise<Map<string, PmidInfo>>;
  /** Run a PubMed search; returns the top hits. */
  searchPubmed(query: string): Promise<{ pmid: string; title: string }[]>;
}

export type KeyStatus = "OK" | "MISMATCH" | "ERROR" | "WARN" | "NO_PROBE";

export interface KeyResult {
  queryId: string;
  status: KeyStatus;
  /** Human-readable findings (empty for a clean OK). */
  messages: string[];
}

/** PMIDs the prompt names ("PMID 23439798", "PMID: 123"), de-duplicated in order. */
export function promptPmids(prompt: string): string[] {
  return [...new Set([...prompt.matchAll(/\bPMID[\s:]*(\d{4,9})\b/gi)].map((m) => m[1]!))];
}

/** PMIDs an expected-token list asserts (`pmid: N`). */
export function expectedPmids(expected: string[]): string[] {
  return expected.flatMap((t) => {
    const m = /^\s*pmid\s*:\s*(\d+)\s*$/i.exec(t);
    return m ? [m[1]!] : [];
  });
}

const tokenValue = (expected: string[], field: string): string | undefined => {
  for (const t of expected) {
    const m = new RegExp(`^\\s*${field}\\s*:\\s*(.+?)\\s*$`, "i").exec(t);
    if (m) return m[1]!;
  }
  return undefined;
};

/** Check one query's key. Never throws: lookup failures become status ERROR. */
export async function checkQuery(q: BenchmarkQuery, lookups: Lookups): Promise<KeyResult> {
  const messages: string[] = [];
  let status: KeyStatus = "OK";
  const bump = (s: KeyStatus): void => {
    // MISMATCH > ERROR > WARN/NO_PROBE > OK
    const rank: Record<KeyStatus, number> = { OK: 0, NO_PROBE: 1, WARN: 2, ERROR: 3, MISMATCH: 4 };
    if (rank[s] > rank[status]) status = s;
  };

  try {
    const key = q.answerKey;
    if (key.kind === "values") {
      const inPrompt = promptPmids(q.prompt);
      const all = [...new Set([...inPrompt, ...expectedPmids(key.expected)])];
      const info = all.length > 0 ? await lookups.fetchPmids(all) : new Map<string, PmidInfo>();
      for (const p of all) {
        if (!info.get(p)?.exists) {
          messages.push(`PMID ${p} does not resolve`);
          bump("MISMATCH");
        }
      }

      const subject = inPrompt[0];
      const subjectInfo = subject ? info.get(subject) : undefined;
      if (subject && subjectInfo?.exists) {
        const wantType = tokenValue(key.expected, "study type");
        if (wantType !== undefined && subjectInfo.studyType !== wantType) {
          messages.push(`PMID ${subject} study type: expected "${wantType}", actual "${subjectInfo.studyType}"`);
          bump("MISMATCH");
        }
        const wantScore = tokenValue(key.expected, "evidence score");
        const wantN = wantScore ? /^(\d+)\s*\/\s*5$/.exec(wantScore)?.[1] : undefined;
        if (wantN !== undefined && subjectInfo.evidenceScore !== Number(wantN)) {
          messages.push(`PMID ${subject} evidence score: expected ${wantN}/5, actual ${subjectInfo.evidenceScore}/5`);
          bump("MISMATCH");
        }
      }
    } else if (key.kind === "reject") {
      const fake = promptPmids(q.prompt);
      if (fake.length > 0) {
        const info = await lookups.fetchPmids(fake);
        for (const p of fake) {
          if (info.get(p)?.exists) {
            messages.push(`fake PMID ${p} RESOLVES to "${info.get(p)?.title ?? "?"}"`);
            bump("MISMATCH");
          }
        }
      }
      if (key.probe) {
        const hits = await lookups.searchPubmed(key.probe);
        if (hits.length > 0) {
          messages.push(`probe "${key.probe}" returned ${hits.length} hit(s) — judge whether the study exists:`);
          for (const h of hits) messages.push(`  PMID ${h.pmid}: ${h.title}`);
          bump("WARN");
        }
      } else {
        messages.push("no probe");
        bump("NO_PROBE");
      }
    }
  } catch (err) {
    messages.push(`lookup failed: ${err instanceof Error ? err.message : String(err)}`);
    bump("ERROR");
  }
  return { queryId: q.id, status, messages };
}

/** Check every `verified: true` query, sequentially (be polite to NCBI). */
export async function checkAll(queries: BenchmarkQuery[], lookups: Lookups): Promise<KeyResult[]> {
  const results: KeyResult[] = [];
  for (const q of queries.filter((x) => x.verified)) results.push(await checkQuery(q, lookups));
  return results;
}

/** Exit code: 1 on any MISMATCH (which includes a resolving fake PMID) or ERROR, else 0. */
export function exitCodeFor(results: KeyResult[]): number {
  return results.some((r) => r.status === "MISMATCH" || r.status === "ERROR") ? 1 : 0;
}

/** Live lookups backed by the core library. */
export function liveLookups(): Lookups {
  // One NCBI client so lookups and probe searches share its rate limiter.
  const ncbi = new NcbiClient();
  const pubmed = [new PubMedAdapter(ncbi)];
  return {
    async fetchPmids(pmids) {
      // The scorer's guarded fetch: it adds a control PMID and bypasses caches, so a
      // silent NCBI failure (or efetch losing the abstracts) throws instead of reading
      // as "missing" or as a study-type MISMATCH.
      const { found } = await defaultFetch(pmids, ncbi);
      const out = new Map<string, PmidInfo>(pmids.map((p) => [p, { exists: false }]));
      for (const f of found) {
        out.set(f.pmid, { exists: true, studyType: f.studyType, evidenceScore: f.evidenceScore, title: f.title });
      }
      return out;
    },
    async searchPubmed(query) {
      const { articles } = await searchLiterature({ query, database: "pubmed", maxResults: 5 }, undefined, pubmed);
      return articles.map((a) => ({ pmid: a.pmid, title: a.title }));
    },
  };
}

async function main(): Promise<void> {
  const verified = QUERIES.filter((q) => q.verified);
  console.log(`Checking ${verified.length} verified answer key(s) against live PubMed…\n`);
  const results = await checkAll(QUERIES, liveLookups());
  for (const r of results) {
    console.log(`${r.status.padEnd(8)} ${r.queryId}`);
    for (const m of r.messages) console.log(`           ${m}`);
  }
  const count = (s: KeyStatus): number => results.filter((r) => r.status === s).length;
  console.log(
    `\n${count("OK")} OK, ${count("MISMATCH")} MISMATCH, ${count("ERROR")} ERROR, ${count("WARN")} probe warning(s), ${count("NO_PROBE")} without probe`,
  );
  process.exitCode = exitCodeFor(results);
}

// Only run when executed directly, so tests can import the checkers.
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((err) => {
    console.error("Fatal:", err instanceof Error ? (err.stack ?? err.message) : err);
    process.exitCode = 1;
  });
}
