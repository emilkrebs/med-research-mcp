/**
 * Adapter registry.
 *
 * Adding a database is one new file in this directory plus one line here — no
 * env vars, no dynamic discovery. The map is explicit, auditable, and
 * tree-shakeable. Instances are long-lived (one per process) so each adapter's
 * per-instance memo carries search results into the following `fetch`.
 */

import type { DatabaseAdapter } from "./types.js";
import { PubMedAdapter } from "./pubmed.js";
import { SciELOAdapter } from "./scielo.js";
import { CyberLeninkaAdapter } from "./cyberleninka.js";
import { EuropePmcAdapter } from "./europepmc.js";
import { ChinaXivAdapter } from "./chinaxiv.js";
import { JStageAdapter } from "./jstage.js";

export const ADAPTERS: Record<string, DatabaseAdapter> = {
  pubmed: new PubMedAdapter(),
  scielo: new SciELOAdapter(),
  cyberleninka: new CyberLeninkaAdapter(),
  europepmc: new EuropePmcAdapter(),
  chinaxiv: new ChinaXivAdapter(),
  jstage: new JStageAdapter(),
};

/**
 * Resolve database ids to adapters. Empty/omitted or a list containing "all"
 * returns every adapter (the fan-out case); unknown ids are dropped.
 */
export function getAdapters(ids?: string[]): DatabaseAdapter[] {
  if (!ids || ids.length === 0 || ids.includes("all")) return Object.values(ADAPTERS);
  return ids.map((id) => ADAPTERS[id]).filter((a): a is DatabaseAdapter => Boolean(a));
}

/** Resolve a single adapter by id, or undefined if unknown. */
export function getAdapter(id: string): DatabaseAdapter | undefined {
  return ADAPTERS[id];
}

export type { DatabaseAdapter };
