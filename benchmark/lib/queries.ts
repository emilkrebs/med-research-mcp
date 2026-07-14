/**
 * The 24-query benchmark set is defined as typed data in `benchmark/queries.data.ts`
 * so tuning the queries doesn't require editing this module. This file just
 * validates the set (unique ids), applies the default answer-key version, and
 * exposes `QUERIES` plus a `queryById` lookup.
 *
 * See the header of `queries.data.ts` for what `verified` means and why some
 * keys stay `false` until a human confirms them.
 */

import type { BenchmarkQuery } from "./types.js";
import { QUERIES as DEFINED_QUERIES } from "../queries.data.js";

/** Validate the query set and apply per-query defaults. */
function finalize(queries: BenchmarkQuery[]): BenchmarkQuery[] {
  const seen = new Set<string>();
  for (const q of queries) {
    if (seen.has(q.id)) throw new Error(`Duplicate query id in queries.data.ts: "${q.id}"`);
    seen.add(q.id);
    // Default answer-key version applied to every query that does not declare one.
    q.answerKeyVersion ??= 1;
  }
  return queries;
}

/** Query set defined in `benchmark/queries.data.ts`. Edit that file to tune queries. */
export const QUERIES: BenchmarkQuery[] = finalize(DEFINED_QUERIES);

/** Look up a query by id (used by `--queries`). */
export function queryById(id: string): BenchmarkQuery | undefined {
  return QUERIES.find((q) => q.id === id);
}
