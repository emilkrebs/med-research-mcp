/**
 * Adapter registry.
 *
 * Adding a database is one new file in this directory plus one line here — no
 * env vars, no dynamic discovery. The map is explicit, auditable, and
 * tree-shakeable. Instances are long-lived (one per process) so each adapter's
 * per-instance memo carries search results into the following `fetch`.
 */

import { errors, type ResearchApiException } from "../errors.js";
import type { DatabaseAdapter } from "./types.js";
import { PubMedAdapter } from "./pubmed.js";
import { EuropePmcAdapter } from "./europepmc.js";
import { ChinaRXivAdapter } from "./chinarxiv.js";
import { SovietRxivAdapter } from "./russiarxiv.js";

export const ADAPTERS: Record<string, DatabaseAdapter> = {
  pubmed: new PubMedAdapter(),
  europepmc: new EuropePmcAdapter(),
  chinaxiv: new ChinaRXivAdapter(),
  russiarxiv: new SovietRxivAdapter(),
};

const normalize = (id: string): string => id.trim().toLowerCase();

/**
 * Resolve database ids to adapters, ignoring case. Empty/omitted or a list
 * containing "all" returns every adapter (the fan-out case); unknown ids are
 * dropped. Use {@link adaptersFor} to reject them instead.
 */
export function getAdapters(ids?: string[]): DatabaseAdapter[] {
  const wanted = (ids ?? []).map(normalize);
  if (wanted.length === 0 || wanted.includes("all")) return Object.values(ADAPTERS);
  return wanted.map((id) => ADAPTERS[id]).filter((a): a is DatabaseAdapter => Boolean(a));
}

/** Resolve a single adapter by id, ignoring case, or undefined if unknown. */
export function getAdapter(id: string): DatabaseAdapter | undefined {
  return ADAPTERS[normalize(id)];
}

/**
 * The adapters a search's `database` names: one id, a list, or "all", ignoring
 * case; pubmed when omitted. Throws INVALID_INPUT for an unknown id, so a typo can't pass for a search that found nothing,
 * and for an empty list, which names nothing: it used to be searched as pubmed, which hid that the caller's list was empty.
 */
export function adaptersFor(database: string | string[] | undefined): DatabaseAdapter[] {
  if (database == null) return [ADAPTERS.pubmed!];
  const ids = (Array.isArray(database) ? database : [database]).map(normalize);
  if (ids.length === 0) throw emptyDatabaseList();
  const unknown = ids.filter((id) => id !== "all" && !ADAPTERS[id]);
  if (unknown.length > 0) throw unknownDatabase(unknown);
  if (ids.includes("all")) return Object.values(ADAPTERS);
  return [...new Set(ids)].map((id) => ADAPTERS[id]!);
}

/** INVALID_INPUT for a `database` list with no entry, saying what to send. */
export function emptyDatabaseList(): ResearchApiException {
  return errors.invalidInput(
    `database is an empty list, so there is nothing to search. Send one id or a list of them (${Object.keys(ADAPTERS).join(", ")}), ` +
      `or "all"; leave database out to search pubmed.`,
  );
}

/** INVALID_INPUT naming the unknown ids and the known ones. */
export function unknownDatabase(ids: string[]): ResearchApiException {
  return errors.invalidInput(
    `Unknown database ${ids.map((id) => JSON.stringify(id)).join(", ")}. Use ${Object.keys(ADAPTERS).join(", ")}, or "all".`,
  );
}

export type { DatabaseAdapter };
