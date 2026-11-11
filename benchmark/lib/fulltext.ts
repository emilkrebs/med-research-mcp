/**
 * The whole full text of a record, as the library's own full-text function returns it.
 *
 * `literature_fulltext` (`src/core/fulltext.ts`, `fetchFulltext`) returns a long text in parts of at
 * most `maxChars` characters and says where to read on (`nextOffset`). A `fulltext` answer key quotes
 * a passage of the full text, so the benchmark reads every part and joins them, the way a model that
 * keeps calling the tool would. Used by the sampler (to write a candidate's full text for the query
 * writers) and by `scripts/verify-keys.ts` (to check a quote against it), so both see what the tool
 * serves. The fetch is injectable, so the paging is testable offline.
 */

import { fetchFulltext, LRUBackend, NcbiClient } from "./core.js";
import type { Cache, FulltextInput, FulltextOutput } from "./core.js";

/** What reading a record's full text yielded. */
export interface FullTextResult {
  /** The whole body (markdown or PDF text); absent when the function returned none. */
  text?: string;
  /** Where the function got it (`europepmc`, `unpaywall`, `proxy`, `direct`), or `none`. */
  source: string;
  format?: string;
  /** What the function said when it had no body: what each location answered. */
  warning?: string;
}

export type FulltextFetch = (input: FulltextInput) => Promise<FulltextOutput>;

/** A bound on the parts read for one record, so a function that keeps answering "truncated" cannot loop forever. */
const MAX_PARTS = 40;

/**
 * Read every part of a record's full text. `fetch` defaults to the library's `fetchFulltext` with a
 * shared in-memory cache and NCBI client; a call that gets the abstract fallback (`source: "none"`)
 * yields no `text`, only the function's warning.
 */
export async function readFulltext(id: string, fetch: FulltextFetch = defaultFetchFulltext()): Promise<FullTextResult> {
  const parts: string[] = [];
  let offset = 0;
  let first: FulltextOutput | undefined;
  for (let i = 0; i < MAX_PARTS; i++) {
    const out = await fetch({ id, ...(offset > 0 ? { offset } : {}) });
    first ??= out;
    if (out.source === "none" || out.fulltext === undefined) {
      return { source: "none", ...(out.warning ? { warning: out.warning } : {}) };
    }
    parts.push(out.fulltext);
    if (!out.truncated) return { text: parts.join(""), source: first.source, format: first.format };
    if (out.nextOffset === undefined || out.nextOffset <= offset) {
      throw new Error(`fulltext of ${id}: part ${i + 1} is truncated but gives no further offset`);
    }
    offset = out.nextOffset;
  }
  throw new Error(`fulltext of ${id}: more than ${MAX_PARTS} parts`);
}

/** The library's function over one process-wide cache and NCBI client. */
export function defaultFetchFulltext(cache: Cache = new LRUBackend(), ncbi: NcbiClient = new NcbiClient()): FulltextFetch {
  return (input) => fetchFulltext(input, cache, ncbi);
}
