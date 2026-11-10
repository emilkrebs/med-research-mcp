#!/usr/bin/env -S npx tsx
/**
 * Live pre-publish check of every `verified: true` answer key against its
 * primary source.
 *
 *   npx tsx benchmark/scripts/verify-keys.ts          # verified keys
 *   npx tsx benchmark/scripts/verify-keys.ts --all    # unverified keyed queries too (while writing them)
 *
 *  - `values` keys: every PMID in the prompt and every `pmid: N` in `expected`
 *    must resolve. With a `source`, the record is fetched from its database and
 *    the key is checked against it: every quoted passage must be in the
 *    record's title or abstract, every expected number must be in the quoted
 *    passage, an expected `pmid:` must be the source record's, and a prompt that
 *    asks for the PMID must not contain it. A value that is neither a number
 *    nor a word of the passage (a study type read from the abstract) can't be
 *    checked this way and is a WARNING. A key without a `source` is reported
 *    (NO_SOURCE): its numbers were checked by a person once, not here.
 *    When `expected` names a `study type:` and the prompt names a subject PMID,
 *    the design classified from the record's live NLM metadata must agree; a
 *    record without design metadata (`unknown`) can't confirm the key, which
 *    then rests on the quoted abstract — a WARNING. An `evidence score:` must
 *    equal `DESIGN_TIER` for the expected type and, when the record is
 *    classified, its live design tier.
 *  - `reject` keys: the optional `probe` PubMed search should return nothing
 *    (hits are WARNINGS with titles, for a human to judge whether the "fake"
 *    study exists); any PMID in the prompt must NOT resolve.
 *  - `accept` keys: the PMID must resolve, the named author must be one of the
 *    record's authors, the named year must be within one of the record's, and
 *    the prompt must name that author and year without giving the PMID.
 *
 * Exit code 1 on any MISMATCH (including a resolving fake PMID) or ERROR (a
 * key that could not be checked is not verified); warnings and missing probes
 * or sources do not fail the run. PubMed records are fetched in batches of 40
 * for the whole set, so the check stays at a few dozen requests however many
 * keys there are. The checking logic takes injected lookups so it is testable
 * offline.
 */

import "../lib/loadenv.js";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { DESIGN_TIER, searchLiterature, NcbiClient, PubMedAdapter } from "../lib/core.js";
import { defaultFetch, defaultRegionalLookup } from "../lib/scoring/verify.js";
import { abstractNumbers } from "../lib/scoring/attribution.js";
import { QUERIES } from "../lib/queries.js";
import type { BenchmarkQuery, KeySource } from "../lib/types.js";

/** What a record lookup yields. `exists: false` means the database returned nothing for it. */
export interface PmidInfo {
  exists: boolean;
  studyType?: string;
  /** Live design tier; null when the record has no design metadata. */
  designTier?: number | null;
  title?: string;
  abstract?: string;
  authors?: string[];
  pubYear?: number;
}

export interface Lookups {
  /** Resolve PMIDs. Must throw (not return `exists: false`) when PubMed is unreachable. */
  fetchPmids(pmids: string[]): Promise<Map<string, PmidInfo>>;
  /** Look up a record outside PubMed (Europe PMC, ChinaXiv). Must throw when the database is unreachable. */
  fetchRegional?(source: Pick<KeySource, "database" | "id">): Promise<PmidInfo>;
  /** Run a PubMed search; returns the top hits. */
  searchPubmed(query: string): Promise<{ pmid: string; title: string }[]>;
}

export type KeyStatus = "OK" | "MISMATCH" | "ERROR" | "WARN" | "NO_PROBE" | "NO_SOURCE";

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

/**
 * Collapse whitespace and typographic variants so a quote matches the text it was copied from.
 * Private-use code points are dropped: Europe PMC's record CBA:521529 carries a font glyph
 * for a hyphen as U+E011 ("Forty\uE011four"), which a reader never sees.
 */
function normalizeText(s: string): string {
  return s
    .replace(/[\uE000-\uF8FF]/g, "")
    .replace(/[‐-―−]/g, "-")
    .replace(/[‘’]/g, "'")
    .replace(/[“”]/g, '"')
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

/** The passages of a quote: ` … ` joins passages that are apart in the abstract. */
export function quoteParts(quote: string): string[] {
  return quote
    .split(/\s+…\s+/)
    .map((p) => p.trim())
    .filter(Boolean);
}

const NUMERIC = /^-?\d[\d,]*(?:\.\d+)?$/;
/** Fields checked elsewhere (against NLM metadata or DESIGN_TIER) or not a fact of the passage. */
const NOT_IN_PASSAGE = new Set(["study type", "evidence score", "rct"]);

/** Canonical form of a number, as lib/scoring/attribution.ts compares them: no separators, no sign, no trailing zeros. */
const canon = (raw: string): string => String(Math.abs(Number(raw.replace(/,/g, ""))));

/** Lowercase, accents stripped, letters only: "Muñoz-García" → "munozgarcia". */
const foldName = (s: string): string => s.normalize("NFKD").replace(/[̀-ͯ]/g, "").toLowerCase().replace(/[^a-z]/g, "");

/** Whether `surname` is the family name of one of `authors` ("Wang Z", "Chen Zuhong", "Del Coso J"). */
function namesAuthor(authors: string[], surname: string): boolean {
  const want = foldName(surname);
  return want !== "" && authors.some((a) => foldName(a).startsWith(want) || a.split(/[\s,]+/).some((token) => foldName(token) === want));
}

/** Check a values key against the record it names. Returns the findings; `bump` records their severity. */
async function checkSource(
  q: BenchmarkQuery,
  expected: string[],
  source: KeySource,
  lookups: Lookups,
  bump: (s: KeyStatus) => void,
): Promise<string[]> {
  const messages: string[] = [];
  let record: PmidInfo | undefined;
  if (source.database === "pubmed") record = (await lookups.fetchPmids([source.id])).get(source.id);
  else if (lookups.fetchRegional) record = await lookups.fetchRegional(source);
  else {
    bump("WARN");
    return [`source ${source.database} ${source.id} can't be looked up here`];
  }
  if (!record?.exists) {
    bump("MISMATCH");
    return [`source record ${source.database} ${source.id} does not resolve`];
  }

  const text = normalizeText(`${record.title ?? ""} ${record.abstract ?? ""}`);
  const parts = quoteParts(source.quote);
  if (parts.length === 0) {
    messages.push("source has an empty quote");
    bump("MISMATCH");
  }
  for (const part of parts) {
    if (!text.includes(normalizeText(part))) {
      messages.push(`quoted passage is not in the record's title or abstract: "${part.slice(0, 90)}${part.length > 90 ? "…" : ""}"`);
      bump("MISMATCH");
    }
  }

  const passage = parts.join(" ");
  // Typographic hyphens ("Sixty‑three") would hide a spelled-out number from the parser.
  const numbers = abstractNumbers(passage.replace(/[\u2010-\u2015]/g, "-"));
  const words = normalizeText(passage);
  for (const token of expected) {
    const idx = token.indexOf(":");
    if (idx < 0) continue;
    const field = token.slice(0, idx).trim().toLowerCase();
    const value = token.slice(idx + 1).trim();
    if (field === "pmid") {
      if (source.database === "pubmed" && value !== source.id) {
        messages.push(`expected pmid ${value} is not the source record (${source.id})`);
        bump("MISMATCH");
      }
      if (new RegExp(`(?<!\\d)${value}(?!\\d)`).test(q.prompt)) {
        messages.push(`the prompt contains the PMID it asks for (${value})`);
        bump("MISMATCH");
      }
      continue;
    }
    if (NOT_IN_PASSAGE.has(field)) continue;
    if (NUMERIC.test(value)) {
      if (!numbers.has(canon(value))) {
        messages.push(`expected "${token}" is not in the quoted passage`);
        bump("MISMATCH");
      }
    } else if (!words.includes(normalizeText(value))) {
      messages.push(`expected "${token}" is not a number or a phrase of the quoted passage; it rests on the key's note`);
      bump("WARN");
    }
  }
  return messages;
}

/** Check one query's key. Never throws: lookup failures become status ERROR. */
export async function checkQuery(q: BenchmarkQuery, lookups: Lookups): Promise<KeyResult> {
  const messages: string[] = [];
  let status: KeyStatus = "OK";
  const bump = (s: KeyStatus): void => {
    // MISMATCH > ERROR > WARN > NO_PROBE/NO_SOURCE > OK
    const rank: Record<KeyStatus, number> = { OK: 0, NO_PROBE: 1, NO_SOURCE: 1, WARN: 2, ERROR: 3, MISMATCH: 4 };
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
        const unclassified = subjectInfo.studyType === "unknown";
        if (wantType !== undefined && unclassified) {
          messages.push(`PMID ${subject} has no design metadata; "${wantType}" rests on the abstract (see the key's note)`);
          bump("WARN");
        } else if (wantType !== undefined && subjectInfo.studyType !== wantType) {
          messages.push(`PMID ${subject} study type: expected "${wantType}", actual "${subjectInfo.studyType}"`);
          bump("MISMATCH");
        }
        const wantScore = tokenValue(key.expected, "evidence score");
        const wantN = wantScore ? /^(\d+)\s*\/\s*5$/.exec(wantScore)?.[1] : undefined;
        if (wantN !== undefined) {
          const scale = wantType !== undefined ? DESIGN_TIER[wantType as keyof typeof DESIGN_TIER] : undefined;
          if (scale !== undefined && scale !== Number(wantN)) {
            messages.push(`expected evidence score ${wantN}/5 does not match DESIGN_TIER["${wantType}"] = ${scale}`);
            bump("MISMATCH");
          }
          if (subjectInfo.designTier != null && subjectInfo.designTier !== Number(wantN)) {
            messages.push(`PMID ${subject} design tier: expected ${wantN}/5, actual ${subjectInfo.designTier}/5`);
            bump("MISMATCH");
          }
        }
      }

      if (key.source) messages.push(...(await checkSource(q, key.expected, key.source, lookups, bump)));
      else {
        messages.push("no source: the expected values are not checked against a record");
        bump("NO_SOURCE");
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
    } else if (key.kind === "accept") {
      const record = (await lookups.fetchPmids([key.pmid])).get(key.pmid);
      if (!record?.exists) {
        messages.push(`PMID ${key.pmid} does not resolve`);
        bump("MISMATCH");
      } else {
        if (!namesAuthor(record.authors ?? [], key.author)) {
          messages.push(`"${key.author}" is not an author of PMID ${key.pmid} (${(record.authors ?? []).slice(0, 4).join(", ") || "no authors listed"})`);
          bump("MISMATCH");
        }
        if (record.pubYear === undefined || Math.abs(record.pubYear - key.year) > 1) {
          messages.push(`PMID ${key.pmid} was published in ${record.pubYear ?? "an unknown year"}, the key says ${key.year}`);
          bump("MISMATCH");
        }
      }
      if (!foldName(q.prompt).includes(foldName(key.author)) || !q.prompt.includes(String(key.year))) {
        messages.push(`the prompt does not name the key's author and year (${key.author}, ${key.year})`);
        bump("MISMATCH");
      }
      if (new RegExp(`(?<!\\d)${key.pmid}(?!\\d)`).test(q.prompt)) {
        messages.push(`the prompt contains the study's PMID (${key.pmid})`);
        bump("MISMATCH");
      }
    }
  } catch (err) {
    messages.push(`lookup failed: ${err instanceof Error ? err.message : String(err)}`);
    bump("ERROR");
  }
  return { queryId: q.id, status, messages };
}

/** Every PMID a query's key needs looked up in PubMed. */
function pmidsOf(q: BenchmarkQuery): string[] {
  const key = q.answerKey;
  if (key.kind === "values") {
    return [...promptPmids(q.prompt), ...expectedPmids(key.expected), ...(key.source?.database === "pubmed" ? [key.source.id] : [])];
  }
  if (key.kind === "reject") return promptPmids(q.prompt);
  if (key.kind === "accept") return [key.pmid];
  return [];
}

const BATCH = 40;

/**
 * Lookups that fetch each PMID once. `prefetch` loads a list in batches of
 * `BATCH`, so checking a hundred keys costs a handful of requests; a failed
 * batch is not remembered, and the queries that need it report the error.
 */
function batched(lookups: Lookups): Lookups & { prefetch(pmids: string[]): Promise<void> } {
  const known = new Map<string, PmidInfo>();
  const load = async (pmids: string[]): Promise<void> => {
    const need = [...new Set(pmids)].filter((p) => !known.has(p));
    for (let i = 0; i < need.length; i += BATCH) {
      const chunk = need.slice(i, i + BATCH);
      const got = await lookups.fetchPmids(chunk);
      for (const p of chunk) known.set(p, got.get(p) ?? { exists: false });
    }
  };
  return {
    ...lookups,
    prefetch: async (pmids) => load(pmids).catch(() => undefined),
    fetchPmids: async (pmids) => {
      await load(pmids);
      return new Map(pmids.map((p) => [p, known.get(p) ?? { exists: false }]));
    },
  };
}

/** Check every `verified: true` query (or, with `all`, every keyed query), sequentially (be polite to NCBI). */
export async function checkAll(queries: BenchmarkQuery[], lookups: Lookups, opts: { all?: boolean } = {}): Promise<KeyResult[]> {
  const selected = queries.filter((q) => (opts.all ? q.answerKey.kind !== "rubric" : q.verified));
  const shared = batched(lookups);
  await shared.prefetch(selected.flatMap(pmidsOf));
  const results: KeyResult[] = [];
  for (const q of selected) results.push(await checkQuery(q, shared));
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
        out.set(f.pmid, {
          exists: true,
          studyType: f.studyType,
          designTier: f.designTier,
          title: f.title,
          abstract: f.abstract,
          ...(f.authors ? { authors: f.authors } : {}),
          ...(f.pubYear !== undefined ? { pubYear: f.pubYear } : {}),
        });
      }
      return out;
    },
    async fetchRegional(source) {
      if (source.database === "pubmed") throw new Error("fetchRegional is for records outside PubMed");
      const f = await defaultRegionalLookup({ database: source.database, id: source.id });
      return f ? { exists: true, studyType: f.studyType, designTier: f.designTier, title: f.title, abstract: f.abstract } : { exists: false };
    },
    async searchPubmed(query) {
      const { articles } = await searchLiterature({ query, database: "pubmed", maxResults: 5 }, undefined, pubmed);
      return articles.map((a) => ({ pmid: a.pmid, title: a.title }));
    },
  };
}

async function main(): Promise<void> {
  const all = process.argv.includes("--all");
  const selected = QUERIES.filter((q) => (all ? q.answerKey.kind !== "rubric" : q.verified));
  console.log(`Checking ${selected.length} ${all ? "keyed" : "verified"} answer key(s) against their live records…\n`);
  const results = await checkAll(QUERIES, liveLookups(), { all });
  for (const r of results) {
    console.log(`${r.status.padEnd(9)} ${r.queryId}`);
    for (const m of r.messages) console.log(`            ${m}`);
  }
  const count = (s: KeyStatus): number => results.filter((r) => r.status === s).length;
  console.log(
    `\n${count("OK")} OK, ${count("MISMATCH")} MISMATCH, ${count("ERROR")} ERROR, ${count("WARN")} warning(s), ` +
      `${count("NO_PROBE")} without probe, ${count("NO_SOURCE")} without source`,
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
