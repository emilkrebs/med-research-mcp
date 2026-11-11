/**
 * The pure parts of the beyond-PubMed draw: listing a search's records, drawing strata with the ids already taken
 * passed over, the candidate texts' shape, the sample file's canonical form. Nothing here touches the network.
 */

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import type { ChinaRXivAdapter } from "../lib/core.js";
import {
  CHINAXIV_QUERY,
  FRAME_RULES,
  FULLTEXT_JOURNALS,
  PREPRINT_PHRASES,
  PREPRINT_WINDOW,
  HISTORY,
  beyondStrata,
  canonicalSample,
  chinaxivIds,
  chinaxivRow,
  drawOrder,
  drawStrata,
  epmcAbstract,
  epmcId,
  epmcIds,
  epmcRecords,
  epmcRow,
  lookupStrata,
  readSample,
  splitAuthorString,
  strata,
  stratumFile,
  stratumName,
  type DrawnStratum,
  type Enumerators,
  type SampleFile,
} from "../scripts/sample-heldout.js";

const dir = mkdtempSync(join(tmpdir(), "sample-frames-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

describe("the strata", () => {
  it("states each frame's search, and names every stratum the way its candidate and staged files are named", () => {
    expect(strata().map(stratumName)).toHaveLength(31);
    const [preprint, cba, chinaxiv, ...fulltext] = beyondStrata();
    expect(stratumName(preprint!)).toBe("preprint/europepmc");
    expect(preprint!.query).toBe(
      `SRC:PPR AND HAS_ABSTRACT:y AND HAS_PUBLISHED_VERSION:n AND FIRST_PDATE:[${PREPRINT_WINDOW.from} TO ${PREPRINT_WINDOW.to}] AND (${PREPRINT_PHRASES.map((p) => `TITLE_ABS:"${p}"`).join(" OR ")})`,
    );
    expect(PREPRINT_WINDOW).toEqual({ from: "2026-05-01", to: "2026-10-31" });
    expect(cba!.query).toBe("SRC:CBA AND HAS_ABSTRACT:y AND (TITLE_ABS:randomized OR TITLE_ABS:randomised)");
    expect([cba, chinaxiv].map((s) => s!.database)).toEqual(["europepmc", "chinaxiv"]);
    expect(chinaxiv!.query).toBe(CHINAXIV_QUERY);
    expect(chinaxiv!.filter).toMatch(/never RussiaRxiv/);
    expect(fulltext.map(stratumName)).toEqual(FULLTEXT_JOURNALS.map((j) => `fulltext/${j.part}`));
    for (const [i, s] of fulltext.entries()) {
      expect(s.database).toBe("pubmed");
      expect(s.query).toBe(
        `"Randomized Controlled Trial"[pt] AND hasabstract AND english[la] AND "${FULLTEXT_JOURNALS[i]!.ta}"[ta] AND 2018:2022[dp] AND free full text[sb]`,
      );
    }
    expect(stratumFile("preprint/europepmc")).toBe("preprint-europepmc.json");
    expect(stratumFile("fulltext/jama-network-open")).toBe("fulltext-jama-network-open.json");
    // The lookup strata are as they were in version 1.
    expect(lookupStrata()).toHaveLength(24);
    expect(lookupStrata()[0]!.query).toBe(
      '"Randomized Controlled Trial"[pt] AND hasabstract AND english[la] AND ("N Engl J Med"[ta] OR "Lancet"[ta] OR "JAMA"[ta] OR "BMJ"[ta]) AND "Cardiovascular Diseases"[majr] AND 2015:2022[dp]',
    );
  });

  it("gives the frames the quotas the design names: 16 preprints, 16 regional (8 + 8), 16 full-text (4 each)", () => {
    expect(FRAME_RULES.preprint).toMatchObject({ category: "preprint", candidates: 16, quota: 16, beyondPubmed: true, retrievalOnly: true });
    expect(FRAME_RULES.regional).toMatchObject({ category: "regional", candidates: 16, quota: 8, beyondPubmed: true });
    expect(FRAME_RULES.fulltext).toMatchObject({ category: "fulltext", candidates: 16, quota: 4, beyondPubmed: true, retrievalOnly: false });
    expect(FRAME_RULES.lookup).toMatchObject({ candidates: 8, quota: 3, beyondPubmed: false });
  });
});

describe("listing a search's records", () => {
  it("keys a Europe PMC record the way the library does", () => {
    expect(epmcId("PPR", "PPR1352132")).toBe("PPR1352132");
    expect(epmcId("CBA", "521529")).toBe("CBA:521529");
    expect(epmcId("MED", "123")).toBe("123");
  });

  it("walks every page with the cursor and checks the count", async () => {
    const urls: string[] = [];
    const pages: Record<string, unknown> = {
      "*": { hitCount: 3, nextCursorMark: "c2", resultList: { result: [{ id: "PPR1", source: "PPR" }, { id: "PPR2", source: "PPR" }] } },
      c2: { hitCount: 3, nextCursorMark: "c3", resultList: { result: [{ id: "PPR3", source: "PPR" }] } },
      c3: { hitCount: 3, nextCursorMark: "c3", resultList: { result: [] } },
    };
    const fetchJson = async (url: string) => {
      urls.push(url);
      return pages[new URL(url).searchParams.get("cursorMark")!];
    };
    expect(await epmcIds("SRC:PPR AND x", fetchJson)).toEqual({ ids: ["PPR1", "PPR2", "PPR3"], matched: 3 });
    expect(urls).toHaveLength(3);
    expect(new URL(urls[0]!).searchParams.get("query")).toBe("SRC:PPR AND x");
    expect(new URL(urls[0]!).searchParams.get("pageSize")).toBe("1000");
    const cba = async () => ({ hitCount: 2, nextCursorMark: "*", resultList: { result: [{ id: "10", source: "CBA" }, { id: "9", source: "CBA" }] } });
    expect((await epmcIds("SRC:CBA", cba)).ids).toEqual(["CBA:10", "CBA:9"]);
    // A walk that finds fewer records than the search reports is an error, not a short stratum.
    const short = async () => ({ hitCount: 5, resultList: { result: [{ id: "PPR1", source: "PPR" }] } });
    await expect(epmcIds("q", short)).rejects.toThrow(/says 5 records match, the walk found 1/);
  });

  it("fetches the core records of up to twenty ids per request, by library id", async () => {
    const urls: string[] = [];
    const fetchJson = async (url: string) => {
      urls.push(url);
      const q = new URL(url).searchParams.get("query")!;
      const ids = [...q.matchAll(/EXT_ID:(\w+)/g)].map((m) => m[1]!);
      return { resultList: { result: ids.map((id) => ({ id, source: q.startsWith("SRC:CBA") ? "CBA" : "PPR", title: `T${id}` })) } };
    };
    const ids = Array.from({ length: 45 }, (_, i) => `CBA:${100 + i}`);
    const records = await epmcRecords("CBA", ids, fetchJson);
    expect(urls).toHaveLength(3);
    expect(new URL(urls[0]!).searchParams.get("query")).toMatch(/^SRC:CBA AND \(EXT_ID:100 OR EXT_ID:101/);
    expect(records.get("CBA:144")).toMatchObject({ title: "T144" });
    expect(records.size).toBe(45);
  });

  it("lists ChinaXiv records through the adapter, keeping the ones whose abstract the source wrote", async () => {
    const records = new Map(
      [
        ["chinaxiv-1", { abstract: "A.", machineGeneratedAbstract: undefined }],
        ["chinaxiv-2", { abstract: "B.", machineGeneratedAbstract: true }],
        ["chinaxiv-3", { abstract: undefined, machineGeneratedAbstract: undefined }],
        ["chinaxiv-4", { abstract: "D.", machineGeneratedAbstract: undefined }],
      ].map(([id, rest]) => [id as string, { pmid: id as string, ...(rest as object) }] as const),
    );
    const searched: { page?: number; maxResults?: number; query: string }[] = [];
    const adapter = {
      async search(input: { query: string; page?: number; maxResults?: number }) {
        searched.push(input);
        const all = [...records.keys()];
        const size = input.maxResults ?? 10;
        return { count: all.length, ids: all.slice(((input.page ?? 1) - 1) * size, (input.page ?? 1) * size) };
      },
      async fetch(ids: string[]) {
        return ids.map((id) => records.get(id)!);
      },
    } as unknown as ChinaRXivAdapter;
    const result = await chinaxivIds("randomized patients", adapter);
    expect(result).toEqual({ ids: ["chinaxiv-1", "chinaxiv-4"], matched: 2 });
    expect(searched.every((s) => s.query === "randomized patients")).toBe(true);
    expect(searched[0]).toMatchObject({ page: 1, maxResults: 50 });
  });
});

describe("drawing strata", () => {
  const ids = (prefix: string, n: number): string[] => Array.from({ length: n }, (_, i) => `${prefix}${1000 + i * 3}`);
  const enumerators = (over: Partial<Record<keyof Enumerators, string[]>> = {}): Enumerators => ({
    pubmed: async () => ({ ids: over.pubmed ?? ids("", 120), matched: (over.pubmed ?? ids("", 120)).length }),
    europepmc: async (q) => {
      const list = over.europepmc ?? (q.startsWith("SRC:PPR") ? ids("PPR", 200) : ids("CBA:", 60).map((x) => x));
      return { ids: list, matched: list.length };
    },
    chinaxiv: async () => ({ ids: over.chinaxiv ?? ids("chinaxiv-202608.", 20).map((x) => `${x}`), matched: 20 }),
  });

  it("draws each stratum's own order from its records, 16 candidates for a new frame, the right kind of id", async () => {
    const drawn = await drawStrata(beyondStrata(), enumerators(), new Set());
    expect(drawn.map(stratumName)).toEqual(beyondStrata().map(stratumName));
    for (const s of drawn) expect(s.candidates).toHaveLength(16);
    const pre = drawn.find((s) => s.frame === "preprint")!;
    expect(pre.candidates.map((c) => c.id)).toEqual(drawOrder(ids("PPR", 200), "preprint/europepmc").slice(0, 16));
    expect(pre.candidates.every((c) => c.pmid === undefined)).toBe(true);
    expect(pre.matched).toBe(200);
    const bmj = drawn.find((s) => stratumName(s) === "fulltext/bmj")!;
    expect(bmj.candidates.every((c) => c.pmid !== undefined && c.id === undefined)).toBe(true);
    // Another seed (another stratum name) gives another order of the same records.
    expect(drawn.find((s) => stratumName(s) === "fulltext/plos-medicine")!.candidates.map((c) => c.pmid)).not.toEqual(bmj.candidates.map((c) => c.pmid));
    // The order does not depend on the order the database returns them in.
    const reversed = await drawStrata(beyondStrata(), enumerators({ europepmc: ids("PPR", 200).reverse() }), new Set());
    expect(reversed.find((s) => s.frame === "preprint")!.candidates).toEqual(pre.candidates);
  });

  it("passes over a record drawn for an earlier stratum, or already stored, and takes the next one", async () => {
    const first = await drawStrata(beyondStrata().slice(3), enumerators(), new Set());
    const taken = new Set(first.flatMap((s) => s.candidates.map((c) => c.pmid!)));
    // The four fulltext strata draw from one list of PMIDs here: no record is a candidate twice.
    expect(taken.size).toBe(64);
    // A stored record is skipped and the order goes on, as an extension does.
    const stored = new Set([first[0]!.candidates[0]!.pmid!]);
    const expected = drawOrder(ids("", 120), "fulltext/bmj")
      .filter((p) => !stored.has(p))
      .slice(0, 16);
    const again = await drawStrata(beyondStrata().slice(3, 4), enumerators(), stored);
    expect(again[0]!.candidates.map((c) => c.pmid)).toEqual(expected);
    // The set of taken ids grows by what was drawn, so that the next stratum passes those over.
    expect(stored.size).toBe(17);
  });
});

describe("candidate texts", () => {
  it("reads a Europe PMC abstract as the server does: real markup removed, a bare less-than sign kept", () => {
    // The server's htmlToText (src/core/text.ts): a heading starts a line as "Heading: ", inline tags keep their text.
    expect(epmcAbstract({ abstractText: "<h4>Background</h4><p>We randomized <i>60</i> patients.</p>" })).toBe("Background: We randomized 60 patients.");
    // A tag stripper that deleted from every "<" to the next ">" would have turned this into "P  0.5" (the benchmark's own reading before scorer 9).
    const text = "<p>Pain fell (P < 0.001) and the effect sizes were large, all > 0.5.</p>";
    expect(epmcAbstract({ abstractText: text })).toBe("Pain fell (P < 0.001) and the effect sizes were large, all > 0.5.");
    expect(epmcAbstract({ abstractText: "Mean age 47 (SD < 10); 12 of 30 > 40 years" })).toBe("Mean age 47 (SD < 10); 12 of 30 > 40 years");
    expect(epmcAbstract({})).toBe("");
    expect(splitAuthorString("Su Haifang, Zou Rong; Li Xie.")).toEqual(["Su Haifang", "Zou Rong", "Li Xie"]);
  });

  it("shapes a preprint, a CBA record and a ChinaXiv record into rows with id, title, journal or server, dates, authors and abstract", () => {
    const ppr = epmcRow("preprint/europepmc", 2, "PPR1", {
      title: "A trial.",
      authorString: "Nakamura T, Okafor B.",
      pubYear: "2026",
      firstPublicationDate: "2026-08-18",
      doi: "10.1101/x",
      abstractText: "<p>Sixty patients.</p>",
      bookOrReportDetails: { publisher: "medRxiv" },
    });
    expect(ppr).toMatchObject({ stratum: "preprint/europepmc", order: 2, id: "PPR1", title: "A trial", server: "medRxiv", firstPublicationDate: "2026-08-18", authors: ["Nakamura T", "Okafor B"], abstract: "Sixty patients." });
    const cba = epmcRow("regional/cba", 1, "CBA:5", { title: "Study", authorString: "Su Haifang, Zou Rong.", journalInfo: { journal: { title: "Chin Arch TCM" }, dateOfPublication: "2005 " }, abstractText: "43 patients." });
    expect(cba).toMatchObject({ id: "CBA:5", journal: "Chin Arch TCM", dateOfPublication: "2005", authors: ["Su Haifang", "Zou Rong"] });
    const cx = chinaxivRow("regional/chinaxiv", 3, "chinaxiv-1", { id: "chinaxiv-1", title: "T", authors: ["LI Jianwei, WANG Fang"], date: "2017-12-21", source_language: "zh", abstract_source: "source", abstract: "Objective: x." });
    expect(cx).toMatchObject({ id: "chinaxiv-1", server: "ChinaXiv", date: "2017-12-21", sourceLanguage: "zh", authors: ["LI Jianwei", "WANG Fang"], abstract: "Objective: x." });
    for (const missing of [epmcRow("s", 1, "PPR9", undefined), chinaxivRow("s", 1, "chinaxiv-9", null), chinaxivRow("s", 1, "chinaxiv-9", { id: "chinaxiv-other" })]) {
      expect(missing).toMatchObject({ title: "(not found)", abstract: "" });
    }
  });
});

describe("the sample file", () => {
  const sample = (strata: DrawnStratum[]): SampleFile => ({
    version: 2,
    history: HISTORY,
    seed: 1,
    drawn_at: "2026-11-10",
    recent_window: { from: "2026/09/01", to: "2026/10/31" },
    established_years: { from: 2015, to: 2022 },
    established_journals: ["BMJ"],
    strata,
  });

  it("is written with its keys in a fixed order, so that a rewrite changes only what changed", () => {
    const messy: DrawnStratum = {
      candidates: [{ note: "n", skipped: "not-primary", id: "PPR1" }],
      matched: 5,
      query: "q",
      database: "europepmc",
      part: "europepmc",
      frame: "preprint",
    };
    const canon = canonicalSample(sample([messy]));
    expect(Object.keys(canon.strata[0]!)).toEqual(["frame", "part", "database", "query", "matched", "candidates"]);
    expect(Object.keys(canon.strata[0]!.candidates[0]!)).toEqual(["id", "skipped", "note"]);
    expect(Object.keys(canon)).toEqual(["version", "history", "seed", "drawn_at", "recent_window", "established_years", "established_journals", "strata"]);
  });

  it("reads a version-1 file (no frame, no database) as PubMed lookup strata", () => {
    const v1 = {
      seed: 1,
      drawn_at: "2026-11-10",
      recent_window: { from: "a", to: "b" },
      established_years: { from: 1, to: 2 },
      established_journals: [],
      strata: [{ specialty: "cardiology", period: "recent", query: "q", matched: 1, candidates: [{ pmid: "1", used: "t-lookup-01" }] }],
    };
    const path = join(dir, "v1.json");
    writeFileSync(path, JSON.stringify(v1));
    const read = readSample(path);
    expect(read.version).toBe(1);
    expect(read.history).toEqual([]);
    expect(read.strata[0]).toMatchObject({ frame: "lookup", database: "pubmed", specialty: "cardiology" });
    expect(stratumName(read.strata[0]!)).toBe("cardiology/recent");
  });
});
