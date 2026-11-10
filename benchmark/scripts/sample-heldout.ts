#!/usr/bin/env -S npx tsx
/**
 * Draw the PubMed records that the held-out `lookup` queries are written from.
 *
 *   npx tsx benchmark/scripts/sample-heldout.ts --abstracts <file.json>   # draw, and write the candidates' abstracts for the query writer
 *   npx tsx benchmark/scripts/sample-heldout.ts --check                   # re-run the searches and report how each stratum has changed
 *   npx tsx benchmark/scripts/sample-heldout.ts --extend <specialty/period> --abstracts <file.json>   # continue a stratum whose candidates ran out
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
 * Extension rule. A stratum whose first CANDIDATES_PER_STRATUM candidates give fewer
 * than QUOTA queries (every one has a disposition, fewer than QUOTA became lookups) is
 * extended by CANDIDATES_PER_STRATUM down the same shuffled order, and it is extended
 * again only while it has fewer than MIN_QUERIES (two) queries. `--extend` re-runs the
 * stratum's search, computes `drawOrder` of the records it matches today, removes every
 * candidate already stored (in any stratum), and appends the next
 * CANDIDATES_PER_STRATUM. Nothing is chosen by hand. The stored candidates need not be a
 * prefix of today's order, because the stratum's membership can drift (recent records are
 * still being indexed with MeSH); the command reports whether they still are. The stratum
 * then carries `extended: { at, matched, added }` (`added` counts all candidates appended
 * so far, `at` and `matched` describe the latest extension). The script refuses to extend
 * a stratum that has an undecided candidate, that already has QUOTA lookups, or that was
 * already extended and has MIN_QUERIES lookups.
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
/**
 * A stratum that has already been extended once is extended again only while it has fewer
 * than this many queries (the first extension needs only fewer than QUOTA).
 */
export const MIN_QUERIES = 2;

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
  "no-numbers":
    "the abstract does not state two unambiguous numbers to ask for: how many took part, and either a result or a second count (a group's size, the number analysed or screened)",
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
  /**
   * Present only on a stratum whose first CANDIDATES_PER_STRATUM candidates gave fewer than QUOTA
   * queries, so that the draw was continued down the same order (`--extend`; a further extension
   * only while the stratum has fewer than MIN_QUERIES): when the latest extension was made, how
   * many records the search matched then, and how many candidates all extensions together appended.
   */
  extended?: { at: string; matched: number; added: number };
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

const isLookup = (c: Candidate): boolean => c.used?.startsWith("t-lookup-") === true;

/** Why a stratum may not be extended, or undefined when it may. */
export function extensionRefusal(s: DrawnStratum): string | undefined {
  const undecided = s.candidates.filter((c) => c.used === undefined && c.skipped === undefined);
  if (undecided.length > 0) return `${undecided.length} stored candidate(s) have no disposition yet: ${undecided.map((c) => c.pmid).join(", ")}`;
  const lookups = s.candidates.filter(isLookup).length;
  if (lookups >= QUOTA) return `it already has ${lookups} lookups (quota ${QUOTA})`;
  if (s.extended && lookups >= MIN_QUERIES) return `it was already extended and has ${lookups} lookups (a further extension only while it has fewer than ${MIN_QUERIES})`;
  return undefined;
}

/**
 * The candidates an extension appends: the next CANDIDATES_PER_STRATUM of today's draw
 * order for the stratum, once every PMID already stored in the file (in any stratum) is removed.
 */
export function extensionCandidates(todayPmids: string[], name: string, stored: Iterable<string>): string[] {
  const have = new Set(stored);
  return drawOrder(todayPmids, name)
    .filter((p) => !have.has(p))
    .slice(0, CANDIDATES_PER_STRATUM);
}

/**
 * Are the stratum's stored candidates still the first of today's draw order? Records
 * drawn for earlier strata are passed over, as they were when the stratum was drawn.
 */
export function storedPrefix(todayPmids: string[], name: string, stored: string[], earlier: Iterable<string>): { prefix: boolean; firstDifference?: number } {
  const skip = new Set(earlier);
  const order = drawOrder(todayPmids, name).filter((p) => !skip.has(p));
  const at = stored.findIndex((p, i) => order[i] !== p);
  return at < 0 ? { prefix: true } : { prefix: false, firstDifference: at + 1 };
}

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

/** Title, journal, dates and abstract of the given candidates of one stratum, for the query writer. Never committed. */
async function abstractRows(ncbi: NcbiClient, name: string, pmids: string[], firstOrder = 1): Promise<unknown[]> {
  const { articles } = await fetchPubMed({ ids: pmids }, new NullCache(), ncbi);
  const byId = new Map(articles.map((a) => [a.pmid, a] as const));
  return pmids.map((pmid, i) => {
    const a = byId.get(pmid);
    return {
      stratum: name,
      order: firstOrder + i,
      pmid,
      title: a?.title ?? "(not found)",
      journal: a?.journal,
      pubDate: a?.pubDate,
      epubDate: a?.epubDate,
      authors: a?.authors?.slice(0, 3),
      publicationTypes: a?.publicationTypes,
      abstract: a?.abstract ?? "",
    };
  });
}

async function abstracts(sample: SampleFile): Promise<unknown[]> {
  const ncbi = new NcbiClient();
  const rows: unknown[] = [];
  for (const s of sample.strata) rows.push(...(await abstractRows(ncbi, stratumName(s), s.candidates.map((c) => c.pmid))));
  return rows;
}

/** Continue one stratum down its draw order (see "Extension rule" above). */
async function extend(name: string, abstractsPath: string): Promise<void> {
  const sample = JSON.parse(readFileSync(SAMPLE_PATH, "utf-8")) as SampleFile;
  const index = sample.strata.findIndex((s) => stratumName(s) === name);
  const stratum = sample.strata[index];
  if (!stratum) throw new Error(`No stratum "${name}". Strata: ${sample.strata.map(stratumName).join(", ")}`);
  const refusal = extensionRefusal(stratum);
  if (refusal) throw new Error(`Refusing to extend ${name}: ${refusal}.`);
  const today = strata().find((s) => stratumName(s) === name);
  if (!today || today.query !== stratum.query) throw new Error(`${name}: the stored search differs from the one this script builds today; refusing to extend.`);

  const ncbi = new NcbiClient();
  const { pmids, matched } = await allPmids(ncbi, stratum.query);
  const stored = sample.strata.flatMap((s) => s.candidates.map((c) => c.pmid));
  const earlier = sample.strata.slice(0, index).flatMap((s) => s.candidates.map((c) => c.pmid));
  const fresh = extensionCandidates(pmids, name, stored);
  if (fresh.length === 0) throw new Error(`${name}: the search matches ${matched} records and none is left to draw.`);

  const now = new Set(pmids);
  const gone = stratum.candidates.filter((c) => !now.has(c.pmid)).map((c) => c.pmid);
  const { prefix, firstDifference } = storedPrefix(pmids, name, stratum.candidates.map((c) => c.pmid), earlier);
  console.log(`${name}: matched ${stratum.matched} when drawn, ${matched} now${gone.length ? `; no longer in the stratum: ${gone.join(", ")}` : ""}`);
  console.log(`  stored ${stratum.candidates.length} candidates ${prefix ? "are still the first of today's draw order" : `are NOT a prefix of today's draw order (first difference at #${firstDifference})`}`);
  console.log(`  appending ${fresh.length}: ${fresh.join(", ")}`);

  // Fetch first, so a failed request leaves the sample file as it was.
  const rows = await abstractRows(ncbi, name, fresh, stratum.candidates.length + 1);
  stratum.candidates.push(...fresh.map((pmid) => ({ pmid })));
  stratum.extended = { at: new Date().toISOString().slice(0, 10), matched, added: (stratum.extended?.added ?? 0) + fresh.length };
  writeFileSync(SAMPLE_PATH, `${JSON.stringify(sample, null, 2)}\n`);
  writeFileSync(resolve(abstractsPath), `${JSON.stringify(rows, null, 2)}\n`);
  console.log(`\nAppended to ${SAMPLE_PATH}; abstracts of the new candidates in ${resolve(abstractsPath)}`);
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const flag = (name: string): string | undefined => {
    const i = args.indexOf(name);
    return i >= 0 ? args[i + 1] : undefined;
  };
  if (args.includes("--check")) {
    const stored = JSON.parse(readFileSync(SAMPLE_PATH, "utf-8")) as SampleFile;
    const ncbi = new NcbiClient();
    for (const s of stored.strata) {
      const { pmids, matched } = await allPmids(ncbi, s.query);
      const now = new Set(pmids);
      const gone = s.candidates.filter((c) => !now.has(c.pmid)).map((c) => c.pmid);
      const ext = s.extended ? `; extended ${s.extended.at} (+${s.extended.added})` : "";
      console.log(`${stratumName(s).padEnd(34)} matched ${s.matched} → ${matched}${gone.length ? `; no longer in the stratum: ${gone.join(", ")}` : ""}${ext}`);
    }
    return;
  }
  const abstractsPath = flag("--abstracts");
  const extendName = flag("--extend");
  if (args.includes("--extend") && (!extendName || !abstractsPath)) {
    console.error("Usage: npx tsx benchmark/scripts/sample-heldout.ts --extend <specialty/period> --abstracts <file.json>");
    process.exitCode = 2;
    return;
  }
  if (extendName && abstractsPath) {
    await extend(extendName, abstractsPath);
    return;
  }
  if (!abstractsPath) {
    console.error("Usage: npx tsx benchmark/scripts/sample-heldout.ts --abstracts <file.json> | --check | --extend <specialty/period> --abstracts <file.json>");
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
