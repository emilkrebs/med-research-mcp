/**
 * RussiaRxiv: the Soviet-era Russian papers of SovietRxiv, via the ChinaRxiv API
 * (`source=russiarxiv`; see chinarxiv.ts, which holds everything but the corpus).
 *
 * Almost every abstract here was written by ChinaRxiv, not the authors: 351 of
 * 357 sampled search results had `abstract_source: "machine_generated"`
 * (2026-10-19), so most records come back with `machineGeneratedAbstract` set.
 */

import { ChinaRxivApiAdapter } from "./chinarxiv.js";

export class SovietRxivAdapter extends ChinaRxivApiAdapter {
  readonly id = "russiarxiv";
  readonly name = "RussiaRxiv (via ChinaRxiv)";
  protected readonly corpus = "russiarxiv";
}
