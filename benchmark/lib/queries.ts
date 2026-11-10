/**
 * The benchmark's queries: the development set (`benchmark/queries.data.ts`)
 * and the held-out set (`benchmark/queries.heldout.data.ts`), both typed data
 * so tuning them doesn't require editing this module. This file validates the
 * sets (unique ids), applies the defaults (split, answer-key version), and
 * exposes `QUERIES` plus a `queryById` lookup.
 *
 * See the headers of the two data files for what `verified` means, how the
 * held-out queries were drawn, and why the two sets must stay apart.
 */

import type { BenchmarkQuery, Split } from "./types.js";
import { QUERIES as DEV_QUERIES } from "../queries.data.js";
import { HELDOUT_QUERIES } from "../queries.heldout.data.js";

/** Validate a query set and apply per-query defaults. */
function finalize(queries: BenchmarkQuery[], split: Split, seen: Set<string>): BenchmarkQuery[] {
  for (const q of queries) {
    if (seen.has(q.id)) throw new Error(`Duplicate query id: "${q.id}"`);
    seen.add(q.id);
    // Each data file holds one split; a query can't opt out of its file's.
    if (q.split !== undefined && q.split !== split) throw new Error(`Query "${q.id}" is in the ${split} file but declares split "${q.split}"`);
    q.split = split;
    // Default answer-key version applied to every query that does not declare one.
    q.answerKeyVersion ??= 1;
  }
  return queries;
}

const seen = new Set<string>();

/** Every query, development set first. Edit the data files to tune queries. */
export const QUERIES: BenchmarkQuery[] = [...finalize(DEV_QUERIES, "dev", seen), ...finalize(HELDOUT_QUERIES, "test", seen)];

/** The queries of one split, or of both. */
export function queriesOf(split: Split | "all"): BenchmarkQuery[] {
  return split === "all" ? QUERIES : QUERIES.filter((q) => q.split === split);
}

/** Look up a query by id (used by `--queries`). */
export function queryById(id: string): BenchmarkQuery | undefined {
  return QUERIES.find((q) => q.id === id);
}
