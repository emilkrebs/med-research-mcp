#!/usr/bin/env -S npx tsx
/**
 * Draw the records that the held-out queries that are looked up are written from.
 *
 *   npx tsx benchmark/scripts/sample-heldout.ts --abstracts <file.json> [--cand-dir <dir>]   # draw every stratum anew into heldout.sample.json.new
 *   npx tsx benchmark/scripts/sample-heldout.ts --check                                      # re-run the searches and report how each stratum has changed
 *   npx tsx benchmark/scripts/sample-heldout.ts --extend <stratum> (--abstracts <file.json> | --cand-dir <dir>)   # continue a stratum whose candidates ran out
 *   npx tsx benchmark/scripts/sample-heldout.ts --apply-keep-rule                            # version 2: retire every lookup past KEEP_PER_STRATUM
 *   npx tsx benchmark/scripts/sample-heldout.ts --add-frames --cand-dir <dir>                # version 2: draw the strata the file lacks, append them
 *   npx tsx benchmark/scripts/sample-heldout.ts --candidates <stratum> --cand-dir <dir>      # write one stratum's candidate texts again
 *
 * A benchmark whose author chooses the papers ends up testing what the author's
 * tool is good at. So the records of the held-out set are drawn, not chosen.
 *
 * ── Frames and strata ────────────────────────────────────────────────────────────────
 *
 * `lookup` (version 1; PubMed). Frame: records tagged "Randomized Controlled Trial", in English,
 *   with an abstract, whose MeSH major topic falls in one of SPECIALTIES. Strata: specialty × period.
 *     established — published 2015–2022 in NEJM, The Lancet, JAMA or The BMJ: trials a model
 *                   may have met in training;
 *     recent      — added to PubMed in RECENT_WINDOW, after the benchmarked models were
 *                   trained, in any journal: only retrieval can answer.
 *   Every answer is in a PubMed abstract.
 *
 * Version 2 keeps one lookup per stratum (KEEP_PER_STRATUM, below) and adds three frames whose
 * answers are NOT in any PubMed abstract (`beyondPubmed`):
 *
 *   `preprint` — one stratum, `preprint/europepmc`: Europe PMC preprints (`SRC:PPR`) whose title or
 *     abstract says "randomized/randomised controlled/clinical trial" or "randomized/randomised
 *     trial", with an abstract, first posted PREPRINT_WINDOW, without a published version in
 *     Europe PMC (`HAS_PUBLISHED_VERSION:n`). The query writer reports two numbers from the
 *     preprint's abstract. A preprint that has a PubMed record the frame does not know of is
 *     passed over (`in-pubmed`).
 *   `regional` — two strata. `regional/cba`: Chinese Biological Abstracts records (`SRC:CBA`) with
 *     an abstract whose title or abstract says "randomized" or "randomised". `regional/chinaxiv`:
 *     ChinaXiv preprints found through the server's ChinaRxiv adapter
 *     (`src/core/adapters/chinarxiv.ts`) with the query "randomized patients" (the adapter returns
 *     the records that contain every word), of which only the records with an abstract that the
 *     source wrote are kept (`abstract_source` other than machine_generated: a machine-generated
 *     abstract is no ground truth). RussiaRxiv is never used.
 *   `fulltext` — four strata, one per journal, `fulltext/bmj`, `fulltext/plos-medicine`,
 *     `fulltext/jama-network-open`, `fulltext/bmc-medicine`: PubMed records tagged "Randomized
 *     Controlled Trial", in English, with an abstract and free full text, published
 *     FULLTEXT_YEARS in that journal. The query asks how many were randomized (stated in the
 *     abstract) and one figure that the full text states in running prose and the abstract does
 *     not state at all.
 *
 * ── The draw ─────────────────────────────────────────────────────────────────────────
 *
 *   Every record id a stratum's search matches is listed and sorted (numerically, group of digits
 *   by group of digits: PMIDs, `PPR1352132`, `CBA:521529`, `chinaxiv-202608.00133`), then shuffled
 *   with a generator seeded from SEED and the stratum's name. The first `candidates` of
 *   FRAME_RULES are its candidates, in that order. A record drawn for an earlier stratum (in any
 *   frame) is passed over.
 *
 * ── Writing rule ─────────────────────────────────────────────────────────────────────
 *
 *   Take a stratum's candidates in order and write a query for each until the stratum has its
 *   `quota` queries (FRAME_RULES). A candidate may be passed over only for one of SKIP_REASONS (and
 *   only for a reason that applies to the frame, SKIP_APPLIES), and the reason is recorded next to
 *   it in `heldout.sample.json`; `test/heldout.test.ts` checks that the queries were written from the
 *   draw, in order. Nobody decides which record is "interesting".
 *
 * ── Keep rule (version 2) ────────────────────────────────────────────────────────────
 *
 *   The first run showed that the plain PubMed tools answered every lookup as well as the server,
 *   because every lookup can be answered from a PubMed abstract. In each of the 24 lookup strata
 *   only the FIRST lookup in draw order is kept (KEEP_PER_STRATUM); the later ones are retired:
 *   their candidate's `used` becomes `retired` (the id stays, so the stored run can be read), and
 *   the query leaves `queries.heldout.data.ts`. The rule looks at draw order only, never at a
 *   result. `--apply-keep-rule` applies it (idempotent); controls and fabricated twins are untouched.
 *
 * ── Extension rule ───────────────────────────────────────────────────────────────────
 *
 *   A stratum whose first `candidates` give fewer than `quota` queries (every one has a
 *   disposition, fewer than `quota` were written or retired as queries) is extended by
 *   `candidates` down the same shuffled order, and it is extended again only while it has fewer than
 *   `minQueries` (FRAME_RULES). `--extend` re-runs the stratum's search, computes `drawOrder` of the
 *   records it matches today, removes every candidate already stored (in any stratum), and appends
 *   the next `candidates`. Nothing is chosen by hand. The stored candidates need not be a prefix of
 *   today's order, because a stratum's membership can drift; the command reports whether they still
 *   are. The stratum then carries `extended: { at, matched, added }` (`added` counts all candidates
 *   appended so far, `at` and `matched` describe the latest extension). The script refuses to extend
 *   a stratum that has an undecided candidate, that already has `quota` queries, or that was already
 *   extended and has `minQueries` queries.
 *
 * ── Staging and merging (version 2) ──────────────────────────────────────────────────
 *
 *   The queries of the new frames are written into one staged file per stratum, outside the
 *   repository, from the candidate texts this script writes (`--cand-dir`). `scripts/merge-heldout.ts`
 *   validates them and writes `queries.heldout.data.ts` and `heldout.sample.json`.
 *
 * The draw is reproducible for as long as the databases return the same set for a stratum's
 * search. They change (records are added, re-indexed, retracted), so the draw that was used is kept
 * in `heldout.sample.json` with its date and the size of each stratum; `--check` shows the drift.
 *
 * To refresh the held-out set (once models have been trained on RECENT_WINDOW, or if the set has
 * been tuned against): move the windows forward, change SEED, draw again, and write new queries.
 * Abstracts and full texts are not kept in the repository.
 */

import "../lib/loadenv.js";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { ChinaRXivAdapter, fetchPubMed, htmlToText, NcbiClient, NullCache } from "../lib/core.js";
import { readFulltext } from "../lib/fulltext.js";
import { seededRandom } from "../lib/stats.js";
import type { Category } from "../lib/types.js";

/** Changing the seed changes every draw: do it only to refresh the whole set. */
export const SEED = 20261110;

/** Version of the held-out set `heldout.sample.json` describes. 1: 71 lookups; 2: one lookup per stratum, plus the beyond-PubMed frames. */
export const SAMPLE_VERSION = 2;

/** Date added to PubMed (`[edat]`) of the `recent` strata. */
export const RECENT_WINDOW = { from: "2026/09/01", to: "2026/10/31" } as const;
/** Publication years of the `established` strata. */
export const ESTABLISHED_YEARS = { from: 2015, to: 2022 } as const;
export const ESTABLISHED_JOURNALS = ["N Engl J Med", "Lancet", "JAMA", "BMJ"] as const;

/** First posting date (Europe PMC `FIRST_PDATE`) of the `preprint` stratum. */
export const PREPRINT_WINDOW = { from: "2026-05-01", to: "2026-10-31" } as const;
/** Publication years of the `fulltext` strata. */
export const FULLTEXT_YEARS = { from: 2018, to: 2022 } as const;
/** The open-access general medical journals of the `fulltext` strata: stratum part, PubMed journal abbreviation. */
export const FULLTEXT_JOURNALS: { part: string; ta: string }[] = [
  { part: "bmj", ta: "BMJ" },
  { part: "plos-medicine", ta: "PLoS Med" },
  { part: "jama-network-open", ta: "JAMA Netw Open" },
  { part: "bmc-medicine", ta: "BMC Med" },
];
/** The phrases of the `preprint` frame: a title or abstract that says one of them reports a randomized trial. */
export const PREPRINT_PHRASES = [
  "randomized controlled trial",
  "randomised controlled trial",
  "randomized clinical trial",
  "randomised clinical trial",
  "randomized trial",
  "randomised trial",
] as const;
/** The ChinaXiv query: the adapter returns the records that contain every word (the other words of a trial's report would be "trial" or "controlled", which non-medical papers use too). */
export const CHINAXIV_QUERY = "randomized patients";

/** The legacy lookup constants: every lookup stratum was drawn with them (version 1). */
export const CANDIDATES_PER_STRATUM = 8;
/** Lookups written per stratum in version 1. */
export const QUOTA = 3;
/**
 * A stratum that has already been extended once is extended again only while it has fewer
 * than this many queries (the first extension needs only fewer than the quota).
 */
export const MIN_QUERIES = 2;
/** Version 2: lookups kept per lookup stratum, the first in draw order; the others are retired. */
export const KEEP_PER_STRATUM = 1;

export type Frame = "lookup" | "preprint" | "regional" | "fulltext";
export const FRAMES: Frame[] = ["lookup", "preprint", "regional", "fulltext"];
export type Database = "pubmed" | "europepmc" | "chinaxiv";

/** How a frame is drawn and written. */
export interface FrameRule {
  /** Category of its queries; their ids are `t-<category>-NN`. */
  category: Category;
  /** Candidates stored per stratum, and appended by each extension. */
  candidates: number;
  /** Queries written per stratum, unless its candidates run out. */
  quota: number;
  /** A stratum already extended once is extended again only while it has fewer queries than this. */
  minQueries: number;
  /** The answer is in no PubMed abstract: the queries are flagged `beyondPubmed`. */
  beyondPubmed: boolean;
  /** The queries are flagged `retrievalOnly`: no benchmarked model can know the answer (lookups: recent strata only). */
  retrievalOnly: boolean;
}

export const FRAME_RULES: Record<Frame, FrameRule> = {
  lookup: { category: "lookup", candidates: CANDIDATES_PER_STRATUM, quota: QUOTA, minQueries: MIN_QUERIES, beyondPubmed: false, retrievalOnly: false },
  preprint: { category: "preprint", candidates: 16, quota: 16, minQueries: 8, beyondPubmed: true, retrievalOnly: true },
  regional: { category: "regional", candidates: 16, quota: 8, minQueries: 4, beyondPubmed: true, retrievalOnly: true },
  fulltext: { category: "fulltext", candidates: 16, quota: 4, minQueries: 2, beyondPubmed: true, retrievalOnly: false },
};

/** The id prefix of a frame's queries: `t-preprint-`. */
export const queryPrefix = (frame: Frame): string => `t-${FRAME_RULES[frame].category}-`;

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
  "in-pubmed": "the record, or a published version of it, has a PubMed record whose abstract states the same figures",
  "no-fulltext-figure": "the full text gives no figure in running prose that the abstract lacks (a figure only in a table, a legend or the abstract does not count)",
  "no-fulltext": "the server's full-text function (literature_fulltext, src/core/fulltext.ts) returns no body for the record",
} as const;

export type SkipReason = keyof typeof SKIP_REASONS;

/**
 * Where each reason applies. For the `fulltext` frame `no-numbers` means the abstract does not
 * state how many were randomized, and `not-identifiable` that the trial cannot be described
 * without its PMID in a way that tells it from a sibling report.
 */
export const SKIP_APPLIES: Record<SkipReason, Frame[]> = {
  "not-primary": ["lookup", "preprint", "regional", "fulltext"],
  "no-numbers": ["lookup", "preprint", "regional", "fulltext"],
  "not-identifiable": ["lookup", "preprint", "regional", "fulltext"],
  "predates-window": ["lookup"],
  "in-development-set": ["lookup", "preprint", "regional", "fulltext"],
  "in-pubmed": ["preprint", "regional"],
  "no-fulltext-figure": ["fulltext"],
  "no-fulltext": ["fulltext"],
};

export interface Stratum {
  frame: Frame;
  /** `lookup` strata: the clinical field and the period. */
  specialty?: string;
  period?: Period;
  /** The other frames: the part of the frame (a journal, a database): `europepmc`, `cba`, `bmj`. */
  part?: string;
  /** Where the records are searched and read. */
  database: Database;
  /** The search that defines the stratum (PubMed, Europe PMC or ChinaRxiv syntax). */
  query: string;
  /** A rule applied to the records the search matches, when the search cannot express it. */
  filter?: string;
}

/** The lookup strata: 12 specialties × 2 periods, version 1. */
export function lookupStrata(): Stratum[] {
  const common = '"Randomized Controlled Trial"[pt] AND hasabstract AND english[la]';
  const journals = ESTABLISHED_JOURNALS.map((j) => `"${j}"[ta]`).join(" OR ");
  return SPECIALTIES.flatMap(({ id, mesh }) =>
    PERIODS.map(
      (period): Stratum => ({
        frame: "lookup",
        specialty: id,
        period,
        database: "pubmed",
        query:
          period === "established"
            ? `${common} AND (${journals}) AND ${mesh} AND ${ESTABLISHED_YEARS.from}:${ESTABLISHED_YEARS.to}[dp]`
            : `${common} AND ${mesh} AND ("${RECENT_WINDOW.from}"[edat] : "${RECENT_WINDOW.to}"[edat])`,
      }),
    ),
  );
}

/** The strata of the beyond-PubMed frames (version 2). */
export function beyondStrata(): Stratum[] {
  const phrases = PREPRINT_PHRASES.map((p) => `TITLE_ABS:"${p}"`).join(" OR ");
  const preprint: Stratum = {
    frame: "preprint",
    part: "europepmc",
    database: "europepmc",
    query: `SRC:PPR AND HAS_ABSTRACT:y AND HAS_PUBLISHED_VERSION:n AND FIRST_PDATE:[${PREPRINT_WINDOW.from} TO ${PREPRINT_WINDOW.to}] AND (${phrases})`,
  };
  const cba: Stratum = {
    frame: "regional",
    part: "cba",
    database: "europepmc",
    query: "SRC:CBA AND HAS_ABSTRACT:y AND (TITLE_ABS:randomized OR TITLE_ABS:randomised)",
  };
  const chinaxiv: Stratum = {
    frame: "regional",
    part: "chinaxiv",
    database: "chinaxiv",
    query: CHINAXIV_QUERY,
    filter: "records with an abstract that the source wrote (abstract_source other than machine_generated); the ChinaXiv corpus only, never RussiaRxiv",
  };
  const fulltext = FULLTEXT_JOURNALS.map(
    ({ part, ta }): Stratum => ({
      frame: "fulltext",
      part,
      database: "pubmed",
      query: `"Randomized Controlled Trial"[pt] AND hasabstract AND english[la] AND "${ta}"[ta] AND ${FULLTEXT_YEARS.from}:${FULLTEXT_YEARS.to}[dp] AND free full text[sb]`,
    }),
  );
  return [preprint, cba, chinaxiv, ...fulltext];
}

/** Every stratum of the set, in file order. */
export function strata(): Stratum[] {
  return [...lookupStrata(), ...beyondStrata()];
}

export const stratumName = (s: Pick<Stratum, "frame" | "specialty" | "period" | "part">): string =>
  s.frame === "lookup" ? `${s.specialty}/${s.period}` : `${s.frame}/${s.part}`;

/** The file a stratum's candidate texts (and its staged items) go in: `preprint/europepmc` → `preprint-europepmc.json`. */
export const stratumFile = (name: string): string => `${name.replace("/", "-")}.json`;

/** A 32-bit seed for one stratum: SEED mixed with the stratum's name (FNV-1a). */
export function stratumSeed(name: string, seed: number = SEED): number {
  let h = (0x811c9dc5 ^ seed) >>> 0;
  for (let i = 0; i < name.length; i++) h = Math.imul(h ^ name.charCodeAt(i), 0x01000193) >>> 0;
  return h;
}

/**
 * A total order on record ids that reads each group of digits as a number: `9` before `10`,
 * `PPR99` before `PPR100`, `chinaxiv-202608.00133` before `chinaxiv-202608.00134`. For ids that are
 * digits only (PMIDs) it is the numeric order.
 */
export function compareIds(a: string, b: string): number {
  const ta = a.match(/\d+|\D+/g) ?? [];
  const tb = b.match(/\d+|\D+/g) ?? [];
  for (let i = 0; i < Math.min(ta.length, tb.length); i++) {
    const x = ta[i]!;
    const y = tb[i]!;
    if (/^\d/.test(x) && /^\d/.test(y)) {
      const d = Number(x) - Number(y);
      if (d !== 0) return d;
    } else if (x !== y) return x < y ? -1 : 1;
  }
  if (ta.length !== tb.length) return ta.length - tb.length;
  return a === b ? 0 : a < b ? -1 : 1;
}

/**
 * The order in which a stratum's records are offered: its ids sorted (so the order doesn't
 * depend on how the database returned them), then Fisher–Yates shuffled with the stratum's seed.
 */
export function drawOrder(ids: string[], name: string, seed: number = SEED): string[] {
  const out = [...new Set(ids)].sort(compareIds);
  const random = seededRandom(stratumSeed(name, seed));
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1));
    [out[i], out[j]] = [out[j]!, out[i]!];
  }
  return out;
}

/** What `heldout.sample.json` records for one drawn candidate. */
export interface Candidate {
  /** The record's PMID (PubMed strata). */
  pmid?: string;
  /** The record's id outside PubMed: `PPR1352132`, `CBA:521529`, `chinaxiv-202608.00133`. */
  id?: string;
  /** The held-out query written from it (the stratum's quota was not met before it), a `SkipReason`, or absent when the quota was met before it. */
  used?: string;
  /** Version 2: the id of a lookup query that was cut by the keep rule. The query is not in the catalog any more; stored runs may still hold it. */
  retired?: string;
  skipped?: SkipReason;
  /** One line on why, for a skipped candidate. */
  note?: string;
}

/** The id of a candidate's record, whichever database it is in. */
export const candidateId = (c: Candidate): string => {
  const id = c.pmid ?? c.id;
  if (id === undefined) throw new Error(`candidate without a record id: ${JSON.stringify(c)}`);
  return id;
};

export interface DrawnStratum extends Stratum {
  /** Records the search matched when the draw was made. */
  matched: number;
  /**
   * Present only on a stratum whose first candidates gave fewer queries than its quota, so that the
   * draw was continued down the same order (`--extend`; a further extension only while the stratum
   * has fewer than `minQueries`): when the latest extension was made, how many records the search
   * matched then, and how many candidates all extensions together appended.
   */
  extended?: { at: string; matched: number; added: number };
  candidates: Candidate[];
}

export interface HistoryEntry {
  version: number;
  date: string;
  note: string;
}

export interface SampleFile {
  /** 2: one lookup per stratum, plus the beyond-PubMed frames. */
  version: number;
  history: HistoryEntry[];
  seed: number;
  drawn_at: string;
  recent_window: typeof RECENT_WINDOW;
  established_years: typeof ESTABLISHED_YEARS;
  established_journals: readonly string[];
  preprint_window?: typeof PREPRINT_WINDOW;
  fulltext_years?: typeof FULLTEXT_YEARS;
  fulltext_journals?: readonly string[];
  strata: DrawnStratum[];
}

export const SAMPLE_PATH = fileURLToPath(new URL("../heldout.sample.json", import.meta.url));

export const HISTORY: HistoryEntry[] = [
  { version: 1, date: "2026-11-10", note: "drawn: 24 lookup strata (12 specialties x established/recent), up to 3 lookups each, 71 lookups, 12 controls, 12 fabricated twins" },
  {
    version: 2,
    date: "2026-11-10",
    note:
      "cut to one lookup per stratum after the first run showed both tool conditions at the ceiling, and beyond-PubMed frames added (preprint, regional, fulltext); " +
      "nothing in the server or the scorer was changed because of that run",
  },
];

/** Is this candidate a query (or a retired one) of its frame: a lookup, a preprint question, ...? */
export function isWritten(c: Candidate, frame: Frame): boolean {
  return (c.used ?? c.retired)?.startsWith(queryPrefix(frame)) === true;
}

/** Why a stratum may not be extended, or undefined when it may. */
export function extensionRefusal(s: DrawnStratum): string | undefined {
  const rule = FRAME_RULES[s.frame];
  const undecided = s.candidates.filter((c) => c.used === undefined && c.retired === undefined && c.skipped === undefined);
  if (undecided.length > 0) return `${undecided.length} stored candidate(s) have no disposition yet: ${undecided.map(candidateId).join(", ")}`;
  const written = s.candidates.filter((c) => isWritten(c, s.frame)).length;
  const what = s.frame === "lookup" ? "lookups" : "queries";
  if (written >= rule.quota) return `it already has ${written} ${what} (quota ${rule.quota})`;
  if (s.extended && written >= rule.minQueries) {
    return `it was already extended and has ${written} ${what} (a further extension only while it has fewer than ${rule.minQueries})`;
  }
  return undefined;
}

/**
 * The candidates an extension appends: the next `count` of today's draw order for the stratum,
 * once every id already stored in the file (in any stratum) is removed.
 */
export function extensionCandidates(todayIds: string[], name: string, stored: Iterable<string>, count: number = CANDIDATES_PER_STRATUM): string[] {
  const have = new Set(stored);
  return drawOrder(todayIds, name)
    .filter((p) => !have.has(p))
    .slice(0, count);
}

/**
 * Are the stratum's stored candidates still the first of today's draw order? Records
 * drawn for earlier strata are passed over, as they were when the stratum was drawn.
 */
export function storedPrefix(todayIds: string[], name: string, stored: string[], earlier: Iterable<string>): { prefix: boolean; firstDifference?: number } {
  const skip = new Set(earlier);
  const order = drawOrder(todayIds, name).filter((p) => !skip.has(p));
  const at = stored.findIndex((p, i) => order[i] !== p);
  return at < 0 ? { prefix: true } : { prefix: false, firstDifference: at + 1 };
}

/**
 * The keep rule: in each lookup stratum the first `keep` lookups in draw order stay, every later
 * one is retired (`used` → `retired`). Looks at draw order only. Idempotent; mutates `strata`.
 * Returns the ids of the queries kept and of those retired (by this call or before it).
 */
export function applyKeepRule(strata: DrawnStratum[], keep: number = KEEP_PER_STRATUM): { kept: string[]; retired: string[] } {
  const kept: string[] = [];
  const retired: string[] = [];
  for (const s of strata) {
    if (s.frame !== "lookup") continue;
    let seen = 0;
    for (const c of s.candidates) {
      if (!isWritten(c, "lookup")) continue;
      seen++;
      if (c.used !== undefined) {
        if (seen <= keep) {
          kept.push(c.used);
          continue;
        }
        c.retired = c.used;
        delete c.used;
      }
      retired.push(c.retired!);
    }
  }
  return { kept, retired };
}

/** The sample file as it is written: keys in a fixed order, so a rewrite changes only what changed. */
export function canonicalSample(sample: SampleFile): SampleFile {
  const candidate = (c: Candidate): Candidate => ({
    ...(c.pmid !== undefined ? { pmid: c.pmid } : {}),
    ...(c.id !== undefined ? { id: c.id } : {}),
    ...(c.used !== undefined ? { used: c.used } : {}),
    ...(c.retired !== undefined ? { retired: c.retired } : {}),
    ...(c.skipped !== undefined ? { skipped: c.skipped } : {}),
    ...(c.note !== undefined ? { note: c.note } : {}),
  });
  const stratum = (s: DrawnStratum): DrawnStratum => ({
    frame: s.frame,
    ...(s.specialty !== undefined ? { specialty: s.specialty } : {}),
    ...(s.period !== undefined ? { period: s.period } : {}),
    ...(s.part !== undefined ? { part: s.part } : {}),
    database: s.database,
    query: s.query,
    ...(s.filter !== undefined ? { filter: s.filter } : {}),
    matched: s.matched,
    ...(s.extended !== undefined ? { extended: s.extended } : {}),
    candidates: s.candidates.map(candidate),
  });
  return {
    version: sample.version,
    history: sample.history,
    seed: sample.seed,
    drawn_at: sample.drawn_at,
    recent_window: sample.recent_window,
    established_years: sample.established_years,
    established_journals: sample.established_journals,
    ...(sample.preprint_window ? { preprint_window: sample.preprint_window } : {}),
    ...(sample.fulltext_years ? { fulltext_years: sample.fulltext_years } : {}),
    ...(sample.fulltext_journals ? { fulltext_journals: sample.fulltext_journals } : {}),
    strata: sample.strata.map(stratum),
  };
}

type StoredStratum = Omit<DrawnStratum, "frame" | "database"> & Partial<Pick<DrawnStratum, "frame" | "database">>;

export function readSample(path: string = SAMPLE_PATH): SampleFile {
  const raw = JSON.parse(readFileSync(path, "utf-8")) as Omit<SampleFile, "version" | "history" | "strata"> & {
    version?: number;
    history?: HistoryEntry[];
    strata: StoredStratum[];
  };
  // A version-1 file has no `frame` or `database`: every stratum is a PubMed lookup stratum.
  const strata = raw.strata.map((s): DrawnStratum => ({ ...s, frame: s.frame ?? "lookup", database: s.database ?? "pubmed" }));
  return { ...raw, version: raw.version ?? 1, history: raw.history ?? [], strata };
}

export function writeSample(sample: SampleFile, path: string = SAMPLE_PATH): void {
  writeFileSync(path, `${JSON.stringify(canonicalSample(sample), null, 2)}\n`);
}

// ─── Listing the records a search matches ────────────────────────────────────────────────

/** The records a stratum's search matches, as ids, and how many the search said it matches. */
export interface Matches {
  ids: string[];
  matched: number;
}

/** The three databases' searches, injectable so the draw is testable offline. */
export interface Enumerators {
  pubmed(query: string): Promise<Matches>;
  europepmc(query: string): Promise<Matches>;
  chinaxiv(query: string): Promise<Matches>;
}

const EPMC_SEARCH = "https://www.ebi.ac.uk/europepmc/webservices/rest/search";
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** GET a JSON document; Europe PMC and ChinaRxiv sometimes time out, so each request is tried a few times. */
export async function getJson(url: string, attempts = 4, timeoutMs = 40_000): Promise<unknown> {
  let last: unknown;
  let limited = 0;
  for (let i = 0; i < attempts; i++) {
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(timeoutMs), headers: { accept: "application/json" } });
      if (res.ok) return await res.json();
      last = new Error(`${url} answered HTTP ${res.status}`);
      // A rate limit (ChinaRxiv allows 30 requests a minute) is waited out, a few times, without using up an attempt.
      if (res.status === 429 && limited < 6) {
        limited++;
        i--;
        const after = Number(res.headers.get("retry-after"));
        await sleep(Number.isFinite(after) && after > 0 ? Math.min(after, 65) * 1000 : 21_000);
        continue;
      }
    } catch (err) {
      last = err;
    }
    await sleep(1500 * (i + 1));
  }
  throw new Error(`giving up on ${url}: ${last instanceof Error ? last.message : String(last)}`);
}

/** A Europe PMC record's id as the library keys it: `PPR…` as it is, any other source as `SRC:id` (`CBA:521529`). */
export const epmcId = (source: string, id: string): string => (source === "PPR" || source === "MED" ? id : `${source}:${id}`);

/** Every id a Europe PMC search matches, paging with `cursorMark` (a page is at most 1,000). */
export async function epmcIds(query: string, fetchJson: (url: string) => Promise<unknown> = getJson): Promise<Matches> {
  const ids: string[] = [];
  let matched = 0;
  let cursor = "*";
  for (let page = 0; page < 200; page++) {
    const params = new URLSearchParams({ query, format: "json", resultType: "idlist", pageSize: "1000", cursorMark: cursor });
    const body = (await fetchJson(`${EPMC_SEARCH}?${params.toString()}`)) as {
      hitCount?: number;
      nextCursorMark?: string;
      resultList?: { result?: { id: string; source: string }[] };
    };
    matched = Number(body.hitCount ?? 0);
    const rows = body.resultList?.result ?? [];
    for (const r of rows) ids.push(epmcId(r.source, r.id));
    const next = body.nextCursorMark;
    if (rows.length === 0 || !next || next === cursor) break;
    cursor = next;
  }
  const unique = [...new Set(ids)];
  if (unique.length !== matched) throw new Error(`Europe PMC says ${matched} records match, the walk found ${unique.length}: ${query}`);
  return { ids: unique, matched };
}

/** Every PMID a search matches (up to PubMed's 9,999), paging through the core client. */
export async function allPmids(ncbi: NcbiClient, query: string): Promise<Matches> {
  const pmids: string[] = [];
  let matched = 0;
  for (let page = 1; ; page++) {
    const res = await ncbi.esearch({ query, maxResults: 50, page });
    matched = res.count;
    pmids.push(...res.pmids);
    if (!res.more || res.pmids.length === 0) break;
  }
  return { ids: [...new Set(pmids)], matched };
}

/**
 * Every ChinaXiv record the adapter returns for `query` (it pages with its own cursors), without
 * the records that have no abstract or whose abstract the project generated itself.
 */
export async function chinaxivIds(query: string, adapter: ChinaRXivAdapter = new ChinaRXivAdapter()): Promise<Matches> {
  const ids: string[] = [];
  let count = 0;
  const cache = new NullCache();
  for (let page = 1; page < 400; page++) {
    const res = await adapter.search({ query, maxResults: 50, page });
    count = res.count;
    // The adapter keeps the page's records in memory, so this reads them without another request.
    const articles = new Map((await adapter.fetch(res.ids, cache)).map((a) => [a.pmid, a] as const));
    for (const id of res.ids) {
      const a = articles.get(id);
      if (!a) throw new Error(`ChinaXiv record ${id} is in the search page but could not be read`);
      if (a.abstract && !a.machineGeneratedAbstract) ids.push(id);
    }
    if (res.ids.length === 0 || page * 50 >= res.count) break;
  }
  const unique = [...new Set(ids)];
  return { ids: unique, matched: unique.length === 0 ? count : unique.length };
}

export function liveEnumerators(ncbi: NcbiClient = new NcbiClient()): Enumerators {
  return { pubmed: (q) => allPmids(ncbi, q), europepmc: (q) => epmcIds(q), chinaxiv: (q) => chinaxivIds(q) };
}

export const enumerate = (s: Stratum, e: Enumerators): Promise<Matches> => e[s.database](s.query);

/**
 * Draw `list` in order: each stratum's matches are sorted and shuffled with its seed, the ids
 * already taken (by a stored stratum, or an earlier stratum of this call) are passed over, and the
 * first `candidates` of its frame are kept.
 */
export async function drawStrata(list: Stratum[], e: Enumerators, taken: Set<string>, log: (line: string) => void = () => undefined): Promise<DrawnStratum[]> {
  const out: DrawnStratum[] = [];
  for (const s of list) {
    const name = stratumName(s);
    const { ids, matched } = await enumerate(s, e);
    const order = drawOrder(ids, name).filter((p) => !taken.has(p));
    const chosen = order.slice(0, FRAME_RULES[s.frame].candidates);
    for (const p of chosen) taken.add(p);
    out.push({ ...s, matched, candidates: chosen.map((id) => (s.database === "pubmed" ? { pmid: id } : { id })) });
    log(`${name.padEnd(34)} ${String(matched).padStart(5)} records → ${chosen.join(", ")}`);
  }
  return out;
}

// ─── Candidate texts, for the query writers ──────────────────────────────────────────────

/**
 * A Europe PMC abstract as text, read with the server's own `htmlToText` (src/core/text.ts), the same way the
 * scorer reads it (`defaultRegionalLookup`) and the server shows it to a model. A tag stripper that deletes from
 * every "<" to the next ">" would cut "P < 0.001 … effect sizes > 0.5" down to "P  0.5".
 */
export const epmcAbstract = (r: Record<string, unknown>): string => htmlToText(typeof r.abstractText === "string" ? r.abstractText : "");

const str = (v: unknown): string => (typeof v === "string" ? v : "");

/** The authors of a Europe PMC / ChinaRxiv author string, split the way the scorer splits them. */
export const splitAuthorString = (s: string): string[] =>
  s
    .split(/[;,]/)
    .map((x) => x.trim().replace(/\.$/, ""))
    .filter(Boolean);

/** One Europe PMC `core` record as the row the query writer reads. Pure. */
export function epmcRow(name: string, order: number, id: string, r: Record<string, unknown> | undefined): Record<string, unknown> {
  if (!r) return { stratum: name, order, id, title: "(not found)", abstract: "" };
  const info = (r.journalInfo ?? {}) as { journal?: { title?: string }; dateOfPublication?: string };
  const book = (r.bookOrReportDetails ?? {}) as { publisher?: string };
  return {
    stratum: name,
    order,
    id,
    database: "europepmc",
    title: htmlToText(str(r.title)).replace(/\.$/, ""),
    journal: info.journal?.title || str(r.journalTitle) || undefined,
    server: book.publisher,
    pubYear: str(r.pubYear) || undefined,
    firstPublicationDate: str(r.firstPublicationDate) || undefined,
    dateOfPublication: info.dateOfPublication?.trim() || undefined,
    doi: str(r.doi) || undefined,
    authors: splitAuthorString(str(r.authorString)),
    abstract: epmcAbstract(r),
  };
}

/** The `core` records of Europe PMC ids of one source (`PPR` or `CBA`), in batches, keyed by library id. */
export async function epmcRecords(source: string, ids: string[], fetchJson: (url: string) => Promise<unknown> = getJson): Promise<Map<string, Record<string, unknown>>> {
  const out = new Map<string, Record<string, unknown>>();
  for (let i = 0; i < ids.length; i += 20) {
    const chunk = ids.slice(i, i + 20);
    const ext = chunk.map((id) => `EXT_ID:${id.includes(":") ? id.split(":")[1] : id}`).join(" OR ");
    const params = new URLSearchParams({ query: `SRC:${source} AND (${ext})`, format: "json", resultType: "core", pageSize: "100" });
    const body = (await fetchJson(`${EPMC_SEARCH}?${params.toString()}`)) as { resultList?: { result?: Record<string, unknown>[] } };
    for (const r of body.resultList?.result ?? []) out.set(epmcId(str(r.source), str(r.id)), r);
  }
  return out;
}

/** One ChinaXiv record (`/papers/{id}`) as the row the query writer reads, from the same fields the scorer reads. Pure. */
export function chinaxivRow(name: string, order: number, id: string, r: Record<string, unknown> | null): Record<string, unknown> {
  if (!r || r.id !== id) return { stratum: name, order, id, title: "(not found)", abstract: "" };
  const authors = (Array.isArray(r.authors) ? r.authors : []).flatMap((x) => splitAuthorString(String(x)));
  return {
    stratum: name,
    order,
    id,
    database: "chinaxiv",
    title: str(r.title_en) || str(r.title),
    server: "ChinaXiv",
    date: str(r.date) || undefined,
    sourceLanguage: str(r.source_language) || undefined,
    abstractSource: str(r.abstract_source) || undefined,
    authors,
    abstract: str(r.abstract_en) || str(r.abstract),
  };
}

/** Title, journal, dates and abstract of PubMed candidates, for the query writer. Never committed. */
async function pubmedRows(ncbi: NcbiClient, name: string, pmids: string[], firstOrder = 1, allAuthors = false): Promise<Record<string, unknown>[]> {
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
      authors: allAuthors ? a?.authors : a?.authors?.slice(0, 3),
      publicationTypes: a?.publicationTypes,
      abstract: a?.abstract ?? "",
    };
  });
}

/** A PubMed candidate's row with the full text as the library returns it, or the note that none is available. */
async function fulltextRows(ncbi: NcbiClient, name: string, pmids: string[], firstOrder: number): Promise<Record<string, unknown>[]> {
  const rows = await pubmedRows(ncbi, name, pmids, firstOrder, true);
  const out: Record<string, unknown>[] = [];
  for (const base of rows) {
    const pmid = String(base.pmid);
    // `id` as in every other frame's candidate file (here the PMID).
    const row = { id: pmid, ...base };
    try {
      const ft = await readFulltext(pmid);
      out.push(
        ft.text !== undefined
          ? { ...row, fulltextSource: ft.source, fulltextFormat: ft.format, fulltextChars: ft.text.length, fulltext: ft.text }
          : { ...row, fulltextSource: "none", fulltextNote: `no full text available through the library's full-text function${ft.warning ? `: ${ft.warning}` : ""}` },
      );
    } catch (err) {
      out.push({ ...row, fulltextSource: "none", fulltextNote: `the full-text function failed: ${err instanceof Error ? err.message : String(err)}` });
    }
    process.stdout.write(".");
  }
  process.stdout.write("\n");
  return out;
}

/** The candidate texts of the given candidates of one stratum (any frame). */
export async function candidateRows(ncbi: NcbiClient, s: DrawnStratum, ids: string[], firstOrder = 1): Promise<Record<string, unknown>[]> {
  const name = stratumName(s);
  if (s.database === "pubmed") return s.frame === "fulltext" ? fulltextRows(ncbi, name, ids, firstOrder) : pubmedRows(ncbi, name, ids, firstOrder);
  if (s.database === "europepmc") {
    const source = s.frame === "preprint" ? "PPR" : "CBA";
    const records = await epmcRecords(source, ids);
    return ids.map((id, i) => epmcRow(name, firstOrder + i, id, records.get(id)));
  }
  const rows: Record<string, unknown>[] = [];
  for (const [i, id] of ids.entries()) {
    const body = (await getJson(`https://chinarxiv.org/api/v1/papers/${encodeURIComponent(id)}`)) as Record<string, unknown> | null;
    rows.push(chinaxivRow(name, firstOrder + i, id, body));
  }
  return rows;
}

/** Write one stratum's candidate texts (every stored candidate, in draw order) to `<dir>/<stratum>.json`. */
async function writeCandidateFile(ncbi: NcbiClient, s: DrawnStratum, dir: string): Promise<string> {
  const rows = await candidateRows(ncbi, s, s.candidates.map(candidateId));
  mkdirSync(resolve(dir), { recursive: true });
  const file = join(resolve(dir), stratumFile(stratumName(s)));
  writeFileSync(file, `${JSON.stringify(rows, null, 2)}\n`);
  return file;
}

async function lookupAbstracts(sample: SampleFile): Promise<unknown[]> {
  const ncbi = new NcbiClient();
  const rows: unknown[] = [];
  for (const s of sample.strata.filter((x) => x.frame === "lookup")) rows.push(...(await pubmedRows(ncbi, stratumName(s), s.candidates.map(candidateId))));
  return rows;
}

// ─── Commands ────────────────────────────────────────────────────────────────────────────

/** Draw every stratum anew (the whole set is refreshed). */
async function draw(): Promise<SampleFile> {
  const strataDrawn = await drawStrata(strata(), liveEnumerators(), new Set<string>(), console.log);
  return {
    version: SAMPLE_VERSION,
    history: [{ version: SAMPLE_VERSION, date: new Date().toISOString().slice(0, 10), note: "drawn anew" }],
    seed: SEED,
    drawn_at: new Date().toISOString().slice(0, 10),
    recent_window: RECENT_WINDOW,
    established_years: ESTABLISHED_YEARS,
    established_journals: ESTABLISHED_JOURNALS,
    preprint_window: PREPRINT_WINDOW,
    fulltext_years: FULLTEXT_YEARS,
    fulltext_journals: FULLTEXT_JOURNALS.map((j) => j.ta),
    strata: strataDrawn,
  };
}

/** Continue one stratum down its draw order (see "Extension rule" above). */
async function extend(name: string, abstractsPath: string | undefined, candDir: string | undefined): Promise<void> {
  const sample = readSample();
  const index = sample.strata.findIndex((s) => stratumName(s) === name);
  const stratum = sample.strata[index];
  if (!stratum) throw new Error(`No stratum "${name}". Strata: ${sample.strata.map(stratumName).join(", ")}`);
  const refusal = extensionRefusal(stratum);
  if (refusal) throw new Error(`Refusing to extend ${name}: ${refusal}.`);
  const today = strata().find((s) => stratumName(s) === name);
  if (!today || today.query !== stratum.query) throw new Error(`${name}: the stored search differs from the one this script builds today; refusing to extend.`);

  const ncbi = new NcbiClient();
  const { ids, matched } = await enumerate(stratum, liveEnumerators(ncbi));
  const stored = sample.strata.flatMap((s) => s.candidates.map(candidateId));
  const earlier = sample.strata.slice(0, index).flatMap((s) => s.candidates.map(candidateId));
  const fresh = extensionCandidates(ids, name, stored, FRAME_RULES[stratum.frame].candidates);
  if (fresh.length === 0) throw new Error(`${name}: the search matches ${matched} records and none is left to draw.`);

  const now = new Set(ids);
  const storedIds = stratum.candidates.map(candidateId);
  const gone = storedIds.filter((p) => !now.has(p));
  const { prefix, firstDifference } = storedPrefix(ids, name, storedIds, earlier);
  console.log(`${name}: matched ${stratum.matched} when drawn, ${matched} now${gone.length ? `; no longer in the stratum: ${gone.join(", ")}` : ""}`);
  console.log(`  stored ${stratum.candidates.length} candidates ${prefix ? "are still the first of today's draw order" : `are NOT a prefix of today's draw order (first difference at #${firstDifference})`}`);
  console.log(`  appending ${fresh.length}: ${fresh.join(", ")}`);

  // Fetch first, so a failed request leaves the sample file as it was.
  const rows = await candidateRows(ncbi, stratum, fresh, stratum.candidates.length + 1);
  stratum.candidates.push(...fresh.map((id) => (stratum.database === "pubmed" ? { pmid: id } : { id })));
  stratum.extended = { at: new Date().toISOString().slice(0, 10), matched, added: (stratum.extended?.added ?? 0) + fresh.length };
  writeSample(sample);
  if (abstractsPath) writeFileSync(resolve(abstractsPath), `${JSON.stringify(rows, null, 2)}\n`);
  console.log(`\nAppended to ${SAMPLE_PATH}${abstractsPath ? `; texts of the new candidates in ${resolve(abstractsPath)}` : ""}`);
  if (candDir) console.log(`Candidate file rewritten: ${await writeCandidateFile(ncbi, stratum, candDir)}`);
}

/** Version 2: apply the keep rule and record the version and its history (idempotent). */
function applyKeep(): void {
  const sample = readSample();
  const { kept, retired } = applyKeepRule(sample.strata);
  sample.version = SAMPLE_VERSION;
  sample.history = HISTORY;
  writeSample(sample);
  console.log(`Keep rule (${KEEP_PER_STRATUM} per stratum): ${kept.length} lookups kept, ${retired.length} retired. ${SAMPLE_PATH}`);
}

/** Version 2: draw the strata the file lacks (the beyond-PubMed frames), append them, write their candidate texts. */
async function addFrames(candDir: string): Promise<void> {
  const sample = readSample();
  const have = new Set(sample.strata.map(stratumName));
  const missing = strata().filter((s) => !have.has(stratumName(s)));
  if (missing.length === 0) throw new Error("The sample file already holds every stratum.");
  const ncbi = new NcbiClient();
  const taken = new Set(sample.strata.flatMap((s) => s.candidates.map(candidateId)));
  const drawn = await drawStrata(missing, liveEnumerators(ncbi), taken, console.log);
  // Texts first: a failed request leaves the sample file as it was.
  const files: string[] = [];
  for (const s of drawn) files.push(await writeCandidateFile(ncbi, s, candDir));
  sample.strata.push(...drawn);
  sample.version = SAMPLE_VERSION;
  sample.history = HISTORY;
  sample.preprint_window = PREPRINT_WINDOW;
  sample.fulltext_years = FULLTEXT_YEARS;
  sample.fulltext_journals = FULLTEXT_JOURNALS.map((j) => j.ta);
  writeSample(sample);
  console.log(`\nAppended ${drawn.length} strata to ${SAMPLE_PATH}; candidate texts:\n  ${files.join("\n  ")}`);
}

async function check(): Promise<void> {
  const stored = readSample();
  const enumerators = liveEnumerators();
  for (const s of stored.strata) {
    const { ids, matched } = await enumerate(s, enumerators);
    const now = new Set(ids);
    const gone = s.candidates.map(candidateId).filter((c) => !now.has(c));
    const ext = s.extended ? `; extended ${s.extended.at} (+${s.extended.added})` : "";
    console.log(`${stratumName(s).padEnd(34)} matched ${s.matched} → ${matched}${gone.length ? `; no longer in the stratum: ${gone.join(", ")}` : ""}${ext}`);
  }
}

const USAGE = [
  "Usage: npx tsx benchmark/scripts/sample-heldout.ts",
  "  --abstracts <file.json> [--cand-dir <dir>]    draw every stratum anew (writes heldout.sample.json.new)",
  "  --check                                       re-run the searches and report the drift",
  "  --extend <stratum> (--abstracts <file.json> | --cand-dir <dir>)",
  "  --apply-keep-rule                             version 2: retire every lookup past KEEP_PER_STRATUM",
  "  --add-frames --cand-dir <dir>                 version 2: draw the strata the file lacks and append them",
  "  --candidates <stratum> --cand-dir <dir>       write one stratum's candidate texts again",
].join("\n");

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const flag = (name: string): string | undefined => {
    const i = args.indexOf(name);
    return i >= 0 ? args[i + 1] : undefined;
  };
  const abstractsPath = flag("--abstracts");
  const candDir = flag("--cand-dir");
  const extendName = flag("--extend");
  const candidatesName = flag("--candidates");
  if (args.includes("--check")) return check();
  if (args.includes("--apply-keep-rule")) return applyKeep();
  if (args.includes("--add-frames")) {
    if (!candDir) {
      console.error(USAGE);
      process.exitCode = 2;
      return;
    }
    return addFrames(candDir);
  }
  if (args.includes("--candidates")) {
    if (!candidatesName || !candDir) {
      console.error(USAGE);
      process.exitCode = 2;
      return;
    }
    const s = readSample().strata.find((x) => stratumName(x) === candidatesName);
    if (!s) throw new Error(`No stratum "${candidatesName}".`);
    console.log(`Candidate file: ${await writeCandidateFile(new NcbiClient(), s, candDir)}`);
    return;
  }
  if (args.includes("--extend")) {
    if (!extendName || (!abstractsPath && !candDir)) {
      console.error(USAGE);
      process.exitCode = 2;
      return;
    }
    return extend(extendName, abstractsPath, candDir);
  }
  if (!abstractsPath) {
    console.error(USAGE);
    process.exitCode = 2;
    return;
  }
  const sample = await draw();
  writeSample(sample, `${SAMPLE_PATH}.new`);
  writeFileSync(resolve(abstractsPath), `${JSON.stringify(await lookupAbstracts(sample), null, 2)}\n`);
  if (candDir) {
    const ncbi = new NcbiClient();
    for (const s of sample.strata.filter((x) => x.frame !== "lookup")) console.log(`Candidate file: ${await writeCandidateFile(ncbi, s, candDir)}`);
  }
  console.log(`\nDraw written to ${SAMPLE_PATH}.new (rename it to adopt it); lookup abstracts to ${resolve(abstractsPath)}${candDir ? `; candidate texts to ${resolve(candDir)}` : ""}`);
}

// Only run when executed directly, so tests can import the pure parts.
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((err) => {
    console.error("Fatal:", err instanceof Error ? (err.stack ?? err.message) : err);
    process.exitCode = 1;
  });
}
