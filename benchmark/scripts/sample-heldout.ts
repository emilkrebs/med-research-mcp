#!/usr/bin/env -S npx tsx
/**
 * Draw the PubMed records that the held-out `lookup` queries are written from.
 *
 *   npx tsx benchmark/scripts/sample-heldout.ts --abstracts <file.json>   # draw, and write the candidates' abstracts for the query writer
 *   npx tsx benchmark/scripts/sample-heldout.ts --check                   # re-run the searches and report how each stratum has changed
 *
 * A benchmark whose author chooses the papers ends up testing what the author's
 * tool is good at. So the papers of the held-out set are drawn, not chosen:
 *
 *   frame    PubMed records tagged "Randomized Controlled Trial", in English, with an
 *            abstract, whose MeSH major topic falls in one of SPECIALTIES;
 *   strata   specialty × period:
 *              established — published 2015–2022 in NEJM, The Lancet, JAMA or The BMJ:
 *                            trials a model may have met in training;
 *              recent      — added to PubMed in RECENT_WINDOW, after the benchmarked
 *                            models were trained, in any journal: only retrieval can answer;
 *   draw     every PMID of a stratum is fetched and sorted numerically, then shuffled
 *            with a generator seeded from SEED and the stratum's name. The first
 *            CANDIDATES_PER_STRATUM are its candidates, in that order. A record drawn
 *            for an earlier stratum is passed over.
 *
 * Writing rule. Take a stratum's candidates in order and write a query for each
 * until the stratum has QUOTA queries. A candidate may be passed over only for
 * one of SKIP_REASONS, and the reason is recorded next to it in
 * `heldout.sample.json`; `test/heldout.test.ts` checks that the queries were
 * written from the draw, in order. Nobody decides which trial is "interesting".
 *
 * The draw is reproducible for as long as PubMed returns the same set for a
 * stratum's search. PubMed changes (records are added, re-indexed, retracted), so
 * the draw that was used is kept in `heldout.sample.json` with its date and the
 * size of each stratum; `--check` shows the drift.
 *
 * To refresh the held-out set (once models have been trained on RECENT_WINDOW, or
 * if the set has been tuned against): move RECENT_WINDOW forward, change SEED,
 * draw again, and write new queries. Abstracts are not kept in the repository.
 */

import "../lib/loadenv.js";
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { fetchPubMed, NcbiClient, NullCache } from "../lib/core.js";
import { seededRandom } from "../lib/stats.js";

/** Changing the seed changes every draw: do it only to refresh the whole set. */
export const SEED = 20261110;

/** Date added to PubMed (`[edat]`) of the `recent` strata. */
export const RECENT_WINDOW = { from: "2026/09/01", to: "2026/10/31" } as const;
/** Publication years of the `established` strata. */
export const ESTABLISHED_YEARS = { from: 2015, to: 2022 } as const;
export const ESTABLISHED_JOURNALS = ["N Engl J Med", "Lancet", "JAMA", "BMJ"] as const;

export const CANDIDATES_PER_STRATUM = 8;
/** Queries written per stratum. */
export const QUOTA = 3;

/** Clinical fields, as MeSH major topics (the disease trees of MeSH category C). */
export const SPECIALTIES: { id: string; mesh: string }[] = [
  { id: "cardiology", mesh: '"Cardiovascular Diseases"[majr]' },
  { id: "oncology", mesh: '"Neoplasms"[majr]' },
  { id: "infectious-disease", mesh: '"Infections"[majr]' },
  { id: "neurology", mesh: '"Nervous System Diseases"[majr]' },
  { id: "psychiatry", mesh: '"Mental Disorders"[majr]' },
  { id: "endocrinology", mesh: '("Endocrine System Diseases"[majr] OR "Nutritional and Metabolic Diseases"[majr])' },
  { id: "pulmonology", mesh: '"Respiratory Tract Diseases"[majr]' },
  { id: "gastroenterology", mesh: '"Digestive System Diseases"[majr]' },
  { id: "nephrology-urology", mesh: '"Urologic Diseases"[majr]' },
  { id: "musculoskeletal", mesh: '"Musculoskeletal Diseases"[majr]' },
  { id: "obstetrics", mesh: '"Pregnancy Complications"[majr]' },
  { id: "ophthalmology", mesh: '"Eye Diseases"[majr]' },
];

export type Period = "established" | "recent";
export const PERIODS: Period[] = ["established", "recent"];

/** The only grounds on which a query writer may pass over a drawn candidate. */
export const SKIP_REASONS = {
  "not-primary": "not the report of a randomized comparison: a protocol, a secondary, post-hoc or pooled analysis, a long-term follow-up, a cost analysis",
  "no-numbers": "the abstract does not state two unambiguous numbers to ask for (how many were randomized, and one result)",
  "not-identifiable": "the trial cannot be described without its PMID in a way that tells it from a sibling report of the same trial",
  "predates-window": "recent stratum only: the record was published online before 2026-08-01, so a model may have seen it",
  "in-development-set": "the record is the subject of a development query",
} as const;

export type SkipReason = keyof typeof SKIP_REASONS;

export interface Stratum {
  specialty: string;
  period: Period;
  /** The PubMed search that defines the stratum. */
  query: string;
}

export function strata(): Stratum[] {
  const common = '"Randomized Controlled Trial"[pt] AND hasabstract AND english[la]';
  const journals = ESTABLISHED_JOURNALS.map((j) => `"${j}"[ta]`).join(" OR ");
  return SPECIALTIES.flatMap(({ id, mesh }) =>
    PERIODS.map((period) => ({
      specialty: id,
      period,
      query:
        period === "established"
          ? `${common} AND (${journals}) AND ${mesh} AND ${ESTABLISHED_YEARS.from}:${ESTABLISHED_YEARS.to}[dp]`
          : `${common} AND ${mesh} AND ("${RECENT_WINDOW.from}"[edat] : "${RECENT_WINDOW.to}"[edat])`,
    })),
  );
}

export const stratumName = (s: Pick<Stratum, "specialty" | "period">): string => `${s.specialty}/${s.period}`;

/** A 32-bit seed for one stratum: SEED mixed with the stratum's name (FNV-1a). */
export function stratumSeed(name: string, seed: number = SEED): number {
  let h = (0x811c9dc5 ^ seed) >>> 0;
  for (let i = 0; i < name.length; i++) h = Math.imul(h ^ name.charCodeAt(i), 0x01000193) >>> 0;
  return h;
}

/**
 * The order in which a stratum's records are offered: its PMIDs sorted
 * numerically (so the order doesn't depend on how PubMed returned them),
 * then Fisher–Yates shuffled with the stratum's seed.
 */
export function drawOrder(pmids: string[], name: string, seed: number = SEED): string[] {
  const out = [...new Set(pmids)].sort((a, b) => Number(a) - Number(b));
  const random = seededRandom(stratumSeed(name, seed));
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1));
    [out[i], out[j]] = [out[j]!, out[i]!];
  }
  return out;
}

/** What `heldout.sample.json` records for one drawn candidate. */
export interface Candidate {
  pmid: string;
  /** The held-out query written from it, a `SkipReason`, or absent when the stratum's quota was met before it. */
  used?: string;
  skipped?: SkipReason;
  /** One line on why, for a skipped candidate. */
  note?: string;
}

export interface DrawnStratum extends Stratum {
  /** Records the search matched when the draw was made. */
  matched: number;
  candidates: Candidate[];
}

export interface SampleFile {
  seed: number;
  drawn_at: string;
  recent_window: typeof RECENT_WINDOW;
  established_years: typeof ESTABLISHED_YEARS;
  established_journals: readonly string[];
  strata: DrawnStratum[];
}

export const SAMPLE_PATH = fileURLToPath(new URL("../heldout.sample.json", import.meta.url));

/** Every PMID a search matches (up to PubMed's 9,999), paging through the core client. */
async function allPmids(ncbi: NcbiClient, query: string): Promise<{ pmids: string[]; matched: number }> {
  const pmids: string[] = [];
  let matched = 0;
  for (let page = 1; ; page++) {
    const res = await ncbi.esearch({ query, maxResults: 50, page });
    matched = res.count;
    pmids.push(...res.pmids);
    if (!res.more || res.pmids.length === 0) break;
  }
  return { pmids: [...new Set(pmids)], matched };
}

async function draw(): Promise<SampleFile> {
  const ncbi = new NcbiClient();
  const taken = new Set<string>();
  const out: DrawnStratum[] = [];
  for (const s of strata()) {
    const { pmids, matched } = await allPmids(ncbi, s.query);
    const order = drawOrder(pmids, stratumName(s)).filter((p) => !taken.has(p));
    const candidates = order.slice(0, CANDIDATES_PER_STRATUM);
    for (const p of candidates) taken.add(p);
    out.push({ ...s, matched, candidates: candidates.map((pmid) => ({ pmid })) });
    console.log(`${stratumName(s).padEnd(34)} ${String(matched).padStart(5)} records → ${candidates.join(", ")}`);
  }
  return {
    seed: SEED,
    drawn_at: new Date().toISOString().slice(0, 10),
    recent_window: RECENT_WINDOW,
    established_years: ESTABLISHED_YEARS,
    established_journals: ESTABLISHED_JOURNALS,
    strata: out,
  };
}

/** Title, journal, dates and abstract of every candidate, for the query writer. Never committed. */
async function abstracts(sample: SampleFile): Promise<unknown[]> {
  const ncbi = new NcbiClient();
  const rows: unknown[] = [];
  for (const s of sample.strata) {
    const { articles } = await fetchPubMed({ ids: s.candidates.map((c) => c.pmid) }, new NullCache(), ncbi);
    const byId = new Map(articles.map((a) => [a.pmid, a] as const));
    s.candidates.forEach((c, i) => {
      const a = byId.get(c.pmid);
      rows.push({
        stratum: stratumName(s),
        order: i + 1,
        pmid: c.pmid,
        title: a?.title ?? "(not found)",
        journal: a?.journal,
        pubDate: a?.pubDate,
        epubDate: a?.epubDate,
        authors: a?.authors?.slice(0, 3),
        publicationTypes: a?.publicationTypes,
        abstract: a?.abstract ?? "",
      });
    });
  }
  return rows;
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  if (args.includes("--check")) {
    const stored = JSON.parse(readFileSync(SAMPLE_PATH, "utf-8")) as SampleFile;
    const ncbi = new NcbiClient();
    for (const s of stored.strata) {
      const { pmids, matched } = await allPmids(ncbi, s.query);
      const now = new Set(pmids);
      const gone = s.candidates.filter((c) => !now.has(c.pmid)).map((c) => c.pmid);
      console.log(`${stratumName(s).padEnd(34)} matched ${s.matched} → ${matched}${gone.length ? `; no longer in the stratum: ${gone.join(", ")}` : ""}`);
    }
    return;
  }
  const at = args.indexOf("--abstracts");
  const abstractsPath = at >= 0 ? args[at + 1] : undefined;
  if (!abstractsPath) {
    console.error("Usage: npx tsx benchmark/scripts/sample-heldout.ts --abstracts <file.json> | --check");
    process.exitCode = 2;
    return;
  }
  const sample = await draw();
  writeFileSync(`${SAMPLE_PATH}.new`, `${JSON.stringify(sample, null, 2)}\n`);
  writeFileSync(resolve(abstractsPath), `${JSON.stringify(await abstracts(sample), null, 2)}\n`);
  console.log(`\nDraw written to ${SAMPLE_PATH}.new (rename it to adopt it); abstracts to ${resolve(abstractsPath)}`);
}

// Only run when executed directly, so tests can import the pure parts.
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((err) => {
    console.error("Fatal:", err instanceof Error ? (err.stack ?? err.message) : err);
    process.exitCode = 1;
  });
}
