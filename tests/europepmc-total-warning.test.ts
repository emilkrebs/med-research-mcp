import { describe, it, expect } from "vitest";
import { searchLiterature } from "../src/core/literature";
import { errors } from "../src/core/errors";
import { LRUBackend } from "../src/core/cache";
import type { DatabaseAdapter } from "../src/core/adapters/types";

/** A database that finds `count` records and fetches none: the totals are what the warning reads. */
function totals(id: string, count: number | Error): DatabaseAdapter {
  return {
    id,
    name: id === "pubmed" ? "PubMed / NCBI" : id === "europepmc" ? "Europe PMC" : id,
    search: async () => {
      if (count instanceof Error) throw count;
      return { count, ids: [] };
    },
    fetch: async () => [],
  };
}

const search = (query: string, pubmed: number | Error, europepmc: number | Error, extra: { page?: number } = {}) =>
  searchLiterature({ query, ...extra }, new LRUBackend(), [totals("pubmed", pubmed), totals("europepmc", europepmc)]);

/** The warning of an unquoted name, or undefined: the only one a search of these totals can have. */
const warningOf = async (query: string, pubmed: number | Error, europepmc: number | Error, extra: { page?: number } = {}) => {
  const out = await search(query, pubmed, europepmc, extra);
  return out.warnings?.find((w) => w.includes("not quoted"));
};

// Totals of one search each, PubMed's and Europe PMC's, measured on 2026-11-28 with the adapters of this repository (page 1, maxResults 1).
describe("the warning for an unquoted name with a hyphen", () => {
  it("fires for the four compounds of issue 20 unquoted", async () => {
    for (const [query, pubmed, europepmc] of [
      ["TB-500", 32, 87_494],
      ["SS-31", 290, 375_947],
      ["PT-141", 123, 59_287],
      ["MOTS-c", 269, 10_803],
    ] as const) {
      expect(await warningOf(query, pubmed, europepmc), query).toBeDefined();
    }
  });

  it("does not fire for them quoted", async () => {
    for (const [query, pubmed, europepmc] of [
      ['"TB-500"', 32, 121],
      ['"SS-31"', 290, 2087],
      ['"PT-141"', 22, 116],
      ['"MOTS-c"', 269, 824],
    ] as const) {
      expect(await warningOf(query, pubmed, europepmc), query).toBeUndefined();
    }
  });

  it("says what was found, why and what to write", async () => {
    expect(await warningOf("TB-500", 32, 87_494)).toBe(
      `Europe PMC found 87,494 records, 2,734 times PubMed's 32, and the query has a name with a hyphen that is not quoted (TB-500). ` +
        `Europe PMC searches the full text and reads the hyphen as a space, so it counts every record holding "TB" and "500", not only those ` +
        `that name TB-500. Quote it to search the name as a phrase: "TB-500".`,
    );
    expect(await warningOf("TB-500 OR SS-31", 100, 200_000)).toBe(
      `Europe PMC found 200,000 records, 2,000 times PubMed's 100, and the query has names with a hyphen that are not quoted (TB-500 and SS-31). ` +
        `Europe PMC searches the full text and reads a hyphen as a space, so it counts every record holding the parts of a name, not only those ` +
        `that name it. Quote them to search the names as phrases: "TB-500" and "SS-31".`,
    );
  });

  it("does not fire for ordinary queries, though three of these reach 20 times PubMed's total on Europe PMC's full text", async () => {
    for (const [query, pubmed, europepmc] of [
      ["creatine cognition", 1521, 7288],
      ["tirzepatide apnea", 177, 1599],
      ["melatonin sleep elderly", 1934, 5745],
      ["metformin cancer prevention", 2019, 21_784],
      ["statin cardiovascular mortality", 7433, 76_069],
      ["ashwagandha anxiety", 142, 885],
      ["probiotics irritable bowel syndrome", 1585, 12_153],
      ["semaglutide obesity", 3223, 14_085],
      ["caffeine exercise performance", 1582, 21_305],
      ["resveratrol longevity", 479, 7135],
      // 207, 32 and 21 times: ordinary words alone, so no name to blame.
      ["zinc common cold", 279, 57_688],
      ["magnesium sleep", 528, 16_811],
      ["intermittent fasting weight loss", 781, 16_647],
    ] as const) {
      expect(await warningOf(query, pubmed, europepmc), query).toBeUndefined();
    }
  });

  it("does not fire for identifiers whose totals stay close to PubMed's", async () => {
    for (const [query, pubmed, europepmc] of [
      ["COVID-19", 525_459, 1_094_491],
      ["IL-6", 236_361, 2_058_303],
      ["BRCA1", 26_367, 96_010],
      ["HbA1c", 95_196, 211_822],
      ["SGLT2", 13_792, 51_726],
      ["BPC-157", 239, 885],
    ] as const) {
      expect(await warningOf(query, pubmed, europepmc), query).toBeUndefined();
    }
  });

  it("fires from 20 times PubMed's total, and not below it", async () => {
    expect(await warningOf("TB-500", 100, 2000)).toBeDefined();
    expect(await warningOf("TB-500", 100, 1999)).toBeUndefined();
    expect(await warningOf("TB-500", 1, 20)).toBeDefined();
    expect(await warningOf("TB-500", 1, 19)).toBeUndefined();
  });

  it("counts a PubMed total of 0 as 1: Europe PMC's alone decides, from 20 records", async () => {
    // Quoted, the same searches found 0, 0, 9, 7, 12 and 19 on Europe PMC (PubMed none).
    for (const [query, europepmc] of [
      ["XQ-4471", 22],
      ["RK-9082", 119],
      ["AB-12345", 825],
      ["QV-58", 3061],
      ["ZZ-31", 38_115],
    ] as const) {
      expect(await warningOf(query, 0, europepmc), query).toMatch(new RegExp(`^Europe PMC found ${europepmc.toLocaleString("en-US")} records where PubMed found none, and the query has a name with a hyphen`));
    }
    expect(await warningOf("KX-7", 0, 19)).toBeUndefined();
    expect(await warningOf('"RK-9082"', 0, 0)).toBeUndefined();
    expect(await warningOf("TB-500", 0, 0)).toBeUndefined();
  });

  it("needs both databases to have answered", async () => {
    const down = errors.network("Europe PMC is down");
    expect((await searchLiterature({ query: "TB-500" }, new LRUBackend(), [totals("europepmc", 87_494)])).warnings).toBeUndefined();
    expect((await searchLiterature({ query: "TB-500" }, new LRUBackend(), [totals("pubmed", 32)])).warnings).toBeUndefined();
    expect(await warningOf("TB-500", down, 87_494)).toBeUndefined();
    expect(await warningOf("TB-500", 32, down)).toBeUndefined();
    // Other databases beside them don't matter.
    const out = await searchLiterature({ query: "TB-500" }, new LRUBackend(), [totals("pubmed", 32), totals("chinaxiv", 5), totals("europepmc", 87_494)]);
    expect(out.warnings?.filter((w) => w.includes("not quoted"))).toHaveLength(1);
  });

  it("warns on every page", async () => {
    for (const page of [1, 2, 7]) {
      expect(await warningOf("TB-500", 32, 87_494, { page }), `page ${page}`).toBeDefined();
    }
  });

  it("looks at the query as europepmc gets it: a name a tag limits to a field is not a name, one whose tag is removed is", async () => {
    expect(await warningOf("il-6[tiab] AND covid-19[ti]", 100, 200_000)).toBeUndefined();
    expect(await warningOf('"TB-500"[tiab] OR SS-31[tiab]', 100, 200_000)).toBeUndefined();
    expect(await warningOf("TB-500[mh]", 100, 200_000)).toContain("(TB-500)");
    expect(await warningOf("ordinary-word slow-wave sleep", 100, 200_000)).toBeUndefined();
  });

  it("names each name once, and leaves out the ones in quotes", async () => {
    expect(await warningOf('TB-500 "SS-31" tb-500 MOTS-c', 100, 200_000)).toContain("(TB-500 and MOTS-c)");
  });
});
