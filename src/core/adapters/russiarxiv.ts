/**
 * RussiaRxiv: the Soviet-era Russian papers of SovietRxiv, via the ChinaRxiv API
 * (`source=russiarxiv`; see chinarxiv.ts, which holds everything but the corpus).
 *
 * Almost every abstract here was written by ChinaRxiv, not the authors: 351 of
 * 357 sampled search results had `abstract_source: "machine_generated"`
 * (2026-10-19), so most records come back with `machineGeneratedAbstract` set.
 *
 * Nearly empty for medicine (checked 2026-11-16): of 25,456 records, mostly mathematics,
 * chemistry and physics, `?source=russiarxiv&q=<word>&limit=1` found 0 for "sleep", 0 for
 * "rhodiola", 2 for "rat" and 1,381 for "water", and sovietrxiv.org's subject filter counts
 * 18 records in Medicine & Physiology and 145 in Biology & Life Sciences, against 5,847
 * in Mathematics and 4,600 in Chemistry. A medical question usually finds nothing here.
 * Every record has a text (`/stats`: 25,456 of 25,456), which `literature_fulltext` reads
 * by its id (`ru-YYYYMM.NNNNN`; see chinarxiv.ts).
 */

import { ChinaRxivApiAdapter } from "./chinarxiv.js";

export class SovietRxivAdapter extends ChinaRxivApiAdapter {
  readonly id = "russiarxiv";
  readonly name = "RussiaRxiv (via ChinaRxiv)";
  protected readonly corpus = "russiarxiv";
  /** Every record is a Russian original: the ChinaRxiv API's original_language=ru counts 25,456 of its 25,456 (2026-11-28). */
  readonly languages = ["ru"];
}
