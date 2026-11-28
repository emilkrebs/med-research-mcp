import { describe, it, expect } from "vitest";
import { searchLiterature } from "../src/core/literature";
import { EuropePmcAdapter } from "../src/core/adapters/europepmc";
import { droppedTagWarnings, toEuropePmcQuery, translateForEuropePmc, unquotedHyphenNames, type DropCause } from "../src/core/adapters/util";
import type { AdapterHttp } from "../src/core/adapters/http";
import type { DatabaseAdapter } from "../src/core/adapters/types";
import { LRUBackend } from "../src/core/cache";

/** The causes of the tags a query loses, in order: [tag, cause]. */
const lost = (query: string): [string, DropCause][] => translateForEuropePmc(query).dropped.map((d) => [d.tag, d.cause]);

describe("translateForEuropePmc reports the tags it removes", () => {
  it("keeps the query it always returned, and reports nothing for a tag it translates", () => {
    for (const q of ["tirzepatide[tiab] AND apnea[tiab]", '"sleep apnea"[tiab]', "il-6[tiab]", "Fauci AS[au]", "2024[dp]", "creatine", "TITLE_ABS:melatonin"]) {
      expect(translateForEuropePmc(q)).toEqual({ query: toEuropePmcQuery(q), dropped: [] });
    }
    expect(translateForEuropePmc("aspirin ibuprofen[ti]").query).toBe("aspirin ibuprofen");
  });

  it("names the tag as written, its cause and the term it followed", () => {
    expect(translateForEuropePmc("aspirin ibuprofen[ti]").dropped).toEqual([{ tag: "[ti]", name: "ti", cause: "unquoted-words", term: "aspirin ibuprofen" }]);
    expect(translateForEuropePmc('"Sleep Apnea Syndromes"[MeSH Terms]').dropped).toEqual([
      { tag: "[MeSH Terms]", name: "mesh terms", cause: "no-field", term: '"Sleep Apnea Syndromes"' },
    ]);
  });

  it("gives every path that removes a tag its cause", () => {
    // No Europe PMC field, with or without a modifier on a tag that has one.
    expect(lost("memory[tw] AND humans[mh] AND x[majr]")).toEqual([["[tw]", "no-field"], ["[mh]", "no-field"], ["[majr]", "no-field"]]);
    expect(lost("sleep apnea[tiab:~3] AND review[pt:noexp] AND x[mh:noexp]")).toEqual([["[tiab:~3]", "modifier"], ["[pt:noexp]", "modifier"], ["[mh:noexp]", "no-field"]]);
    // Several unquoted words, for the tags a quoted phrase would translate.
    expect(lost("tirzepatide[tiab] sleep apnea[tiab] AND a b[ti] AND N Engl J Med[ta]")).toEqual([["[tiab]", "unquoted-words"], ["[ti]", "unquoted-words"], ["[ta]", "unquoted-words"]]);
    // Where PubMed ignores the tag, where the text is joined, where nothing is before it.
    expect(lost("(tirzepatide OR semaglutide)[tiab] AND (sleep apnea)[ti]")).toEqual([["[tiab]", "after-group"], ["[ti]", "after-group"]]);
    expect(lost('a[tiab]b AND "x"y[tiab] AND "z"[tiab]"w"')).toEqual([["[tiab]", "joined"], ["[tiab]", "joined"], ["[tiab]", "joined"]]);
    expect(lost("creatine AND [tiab] AND (  [ti] memory) AND a[tiab][ti]")).toEqual([["[tiab]", "no-term"], ["[ti]", "no-term"], ["[ti]", "no-term"]]);
    // Terms it can't read.
    expect(lost('"breast feed*"[tiab]')).toEqual([["[tiab]", "phrase-wildcard"]]);
    expect(lost("ab*[tiab] AND *ation[ti]")).toEqual([["[tiab]", "wildcard"], ["[ti]", "wildcard"]]);
    expect(lost('alzheimer\'s[tiab] AND "-"[tiab] AND TITLE_ABS:sleep[ti]')).toEqual([["[tiab]", "punctuation"], ["[tiab]", "punctuation"], ["[ti]", "punctuation"]]);
    expect(lost('"Kreider R"[au] AND de Souza MA[au] AND "Clinical Trial"[pt] AND spanish[la] AND 2024/03/15[dp] AND PMC1[pmid] AND 0028-0836[ta]')).toEqual(
      ["[au]", "[au]", "[pt]", "[la]", "[dp]", "[pmid]", "[ta]"].map((tag) => [tag, "value"]),
    );
    // A query that can't be parsed loses every tag.
    expect(lost('"sleep apnea[tiab] AND cpap[ti]')).toEqual([["[tiab]", "unparsed"], ["[ti]", "unparsed"]]);
    expect(lost("(creatine[tiab] OR cognition[mh]")).toEqual([["[tiab]", "unparsed"], ["[mh]", "unparsed"]]);
  });

  it("reports a tag only when it is removed from the query: a query left with nothing goes as it was", () => {
    expect(translateForEuropePmc("[tiab]")).toEqual({ query: "[tiab]", dropped: [] });
  });

  it("reads a tag name that is also an object property as an unknown tag", () => {
    expect(lost("memory[constructor] AND x[toString]")).toEqual([["[constructor]", "no-field"], ["[toString]", "no-field"]]);
  });

  it("never throws, and names only tags that are in the query, whatever it is given", () => {
    const pieces = ['"', "(", ")", "[tiab]", "[ti]", "[mh]", "[pt]", "[dp]", "[au]", "[la]", "[ta]", "[pmid]", "[tiab:~3]", " ", "AND", "OR", "a", "sleep", "apnea*", "il-6", "2020", "Smith J", "*"];
    let seed = 11;
    const next = () => (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648;
    for (let i = 0; i < 3000; i++) {
      const q = Array.from({ length: 1 + Math.floor(next() * 10) }, () => pieces[Math.floor(next() * pieces.length)]).join(next() < 0.5 ? "" : " ");
      let dropped: ReturnType<typeof translateForEuropePmc>["dropped"] = [];
      expect(() => (dropped = translateForEuropePmc(q).dropped), q).not.toThrow();
      for (const d of dropped) expect(q.includes(d.tag), `${d.tag} in ${q}`).toBe(true);
      expect(() => droppedTagWarnings(dropped), q).not.toThrow();
      expect(droppedTagWarnings(dropped).length).toBeLessThanOrEqual(6);
    }
  });
});

describe("droppedTagWarnings", () => {
  const warn = (query: string): string[] => droppedTagWarnings(translateForEuropePmc(query).dropped);

  it("says what the issue asks for: the tag, why, and how to write it", () => {
    expect(warn("aspirin ibuprofen[ti]")).toEqual([
      '[ti] was ignored on europepmc: it follows several unquoted words, so "aspirin ibuprofen" matched anywhere in the full text. ' +
        'Write "aspirin ibuprofen"[ti] for the phrase, or aspirin[ti] AND ibuprofen[ti] for each word.',
    ]);
  });

  it("words each warning for its cause", () => {
    expect(warn('"Sleep Apnea Syndromes"[mh]')).toEqual(['[mh] was ignored on europepmc: Europe PMC has no MeSH field, so "Sleep Apnea Syndromes" matched anywhere in the full text.']);
    expect(warn("memory[tw]")).toEqual(['[tw] was ignored on europepmc: Europe PMC has no field for it, so "memory" matched anywhere in the full text.']);
    expect(warn("sleep apnea[tiab:~3]")).toEqual(['[tiab:~3] was ignored on europepmc: Europe PMC has no equivalent of its ":~3" modifier, so "sleep apnea" matched anywhere in the full text.']);
    expect(warn("N Engl J Med[ta]")).toEqual([
      '[ta] was ignored on europepmc: it follows several unquoted words, so "N Engl J Med" matched anywhere in the full text. Write "N Engl J Med"[ta] for the phrase.',
    ]);
    expect(warn("(tirzepatide OR semaglutide)[Title/Abstract]")).toEqual([
      "[Title/Abstract] was ignored on europepmc: it follows a parenthesised group. Tag each term inside the group instead: (tirzepatide[Title/Abstract] OR semaglutide[Title/Abstract]).",
    ]);
    expect(warn("creatine AND [tiab]")).toEqual(["[tiab] was ignored on europepmc: no term stands before it for it to apply to."]);
    expect(warn('"breast feed*"[tiab]')).toEqual([
      '[tiab] was ignored on europepmc: Europe PMC ignores a * inside a quoted phrase, so "breast feed*" matched anywhere in the full text. Write the phrase without the *.',
    ]);
    expect(warn("ab*[ti]")).toEqual(['[ti] was ignored on europepmc: it takes a wildcard only with at least 4 letters or digits before the first *, so "ab*" matched anywhere in the full text.']);
    expect(warn("alzheimer's[tiab]")).toEqual([
      `[tiab] was ignored on europepmc: it does not translate a term with punctuation such as ' or : or with nothing to search for, so "alzheimer's" matched anywhere in the full text. Quote it to tag it: "alzheimer's"[tiab].`,
    ]);
    expect(warn('"sleep apnea[tiab] AND cpap')).toEqual(["[tiab] was ignored on europepmc: the query has an unterminated quote or unbalanced parentheses, so no tag could be read. Close every quote and parenthesis."]);
  });

  it("names what a tag with a closed set of values is read for", () => {
    expect(warn('"Clinical Trial"[pt]')[0]).toMatch(/^\[pt\] was ignored on europepmc: it is read only for the publication types Randomized Controlled Trial, .* and Retracted Publication, so "Clinical Trial" matched anywhere in the full text\.$/);
    expect(warn("spanish[la]")).toEqual(['[la] was ignored on europepmc: it is read only for English, German, French, Chinese, Japanese, Russian and Italian, so "spanish" matched anywhere in the full text.']);
    expect(warn("2024/03/15[dp]")[0]).toContain("use the dateRange parameter for a day");
    expect(warn("de Souza MA[au]")[0]).toContain("a surname with up to two initials");
    expect(warn("0028-0836[ta]")[0]).toContain("not for an ISSN");
    expect(warn("PMC1[pmid]")[0]).toContain("a PMID");
  });

  it("suggests a way to write the tag only where that way is read", () => {
    // A phrase that can't be tagged (a "*") gets no phrase to write, and a long run of words no list of tagged words.
    expect(warn("sleep* apnea[ti]")[0]).toMatch(/Tag each word\.$/);
    expect(warn("one two three four five six[ti]")[0]).toMatch(/for the phrase, or tag each word\.$/);
    expect(warn("a b[tiab]")[0]).toContain("a[tiab] AND b[tiab] for each word");
    // The tag as it was written is the one the advice uses.
    expect(warn("aspirin ibuprofen[Title]")[0]).toContain('Write "aspirin ibuprofen"[Title] for the phrase, or aspirin[Title] AND ibuprofen[Title] for each word.');
    // A quoted phrase or a term with a field prefix is not told to quote itself.
    expect(warn('"-"[tiab]')[0]).not.toContain("Quote it");
    expect(warn("TITLE_ABS:sleep[ti]")[0]).not.toContain("Quote it");
  });

  it("gives one warning for a repeated tag, and at most five of the others followed by a count", () => {
    expect(warn("a b[ti] OR a b[ti]")).toHaveLength(1);
    expect(warn("x[mh] AND x[mh] AND x[mh]")).toHaveLength(1);
    const many = warn("a1[mh] b2[mh] c3[mh] d4[mh] e5[mh] f6[mh] g7[mh] h8[mh]");
    expect(many).toHaveLength(6);
    expect(many.slice(0, 5).every((w) => w.startsWith("[mh] was ignored on europepmc"))).toBe(true);
    expect(many[5]).toBe("3 more tags were ignored on europepmc.");
    expect(warn("a1[mh] b2[mh] c3[mh] d4[mh] e5[mh]")).toHaveLength(5);
  });
});

/** A fake Europe PMC that pages by cursorMark (`c{position}`) over `total` records, ids 1000 + position. */
function cursorHttp(total: number): { http: AdapterHttp; urls: URLSearchParams[] } {
  const urls: URLSearchParams[] = [];
  const http: AdapterHttp = {
    json: async <T>(url: string): Promise<T> => {
      const p = new URL(url).searchParams;
      urls.push(p);
      const cursor = p.get("cursorMark") ?? "*";
      const start = cursor === "*" ? 0 : Number(cursor.slice(1));
      const n = Math.max(0, Math.min(Number(p.get("pageSize")), total - start));
      const result = Array.from({ length: n }, (_, i) => ({ id: String(1000 + start + i), source: "MED" }));
      return { hitCount: total, nextCursorMark: `c${start + n}`, resultList: { result } } as T;
    },
    text: async () => "",
  };
  return { http, urls };
}

const TAG_WARNING =
  '[ti] was ignored on europepmc: it follows several unquoted words, so "aspirin ibuprofen" matched anywhere in the full text. ' +
  'Write "aspirin ibuprofen"[ti] for the phrase, or aspirin[ti] AND ibuprofen[ti] for each word.';

describe("EuropePmcAdapter warns about the tags it removes", () => {
  it("returns a warning for each removed tag, and sends the query it sent before", async () => {
    const { http, urls } = cursorHttp(100);
    const out = await new EuropePmcAdapter(http).search({ query: "aspirin ibuprofen[ti]", maxResults: 10 });
    expect(out.warnings).toEqual([TAG_WARNING]);
    expect(out.count).toBe(100);
    expect(urls[0]!.get("query")).toBe("aspirin ibuprofen");
  });

  it("returns none where nothing was removed, and no key at all", async () => {
    const { http } = cursorHttp(100);
    expect(await new EuropePmcAdapter(http).search({ query: "aspirin[ti] AND ibuprofen[ti]", maxResults: 10 })).not.toHaveProperty("warnings");
    expect(await new EuropePmcAdapter(http).search({ query: "creatine", maxResults: 10 })).not.toHaveProperty("warnings");
  });

  it("returns them on every page: a later one, one past the end, and a cold walk to a deep page", async () => {
    const { http, urls } = cursorHttp(25);
    const adapter = new EuropePmcAdapter(http);
    const query = "aspirin ibuprofen[ti]";
    expect((await adapter.search({ query, maxResults: 10, page: 1 })).warnings).toEqual([TAG_WARNING]);
    expect((await adapter.search({ query, maxResults: 10, page: 2 })).warnings).toEqual([TAG_WARNING]);
    const past = await adapter.search({ query, maxResults: 10, page: 4 });
    expect(past).toEqual({ count: 25, ids: [], warnings: [TAG_WARNING] });
    const before = urls.length;
    expect((await adapter.search({ query, maxResults: 10, page: 5 })).warnings).toEqual([TAG_WARNING]);
    expect(urls).toHaveLength(before);

    const cold = cursorHttp(1500);
    expect(await new EuropePmcAdapter(cold.http).search({ query, maxResults: 50, page: 40 })).toEqual({ count: 1500, ids: [], warnings: [TAG_WARNING] });
    const walked = cursorHttp(4_000_000);
    expect((await new EuropePmcAdapter(walked.http).search({ query, maxResults: 50, page: 100_000 })).warnings).toEqual([TAG_WARNING]);
  });

  it("sends nothing and warns of nothing for a design filter no record can pass", async () => {
    const { http, urls } = cursorHttp(100);
    expect(await new EuropePmcAdapter(http).search({ query: "a b[ti]", studyTypes: ["in-vitro"] })).toEqual({ count: 0, ids: [] });
    expect(urls).toHaveLength(0);
  });
});

/** A database that finds `count` records and fetches none, to put a total beside Europe PMC's. */
function totalOnly(id: string, count: number): DatabaseAdapter {
  return { id, name: id === "pubmed" ? "PubMed / NCBI" : id, search: async () => ({ count, ids: [] }), fetch: async () => [] };
}

describe("searchLiterature puts the tag warnings in the result", () => {
  const search = (query: string, adapters: DatabaseAdapter[], extra: { page?: number } = {}) => searchLiterature({ query, ...extra }, new LRUBackend(), adapters);

  it("adds a warning for the tag europepmc removed, beside the other databases' answers", async () => {
    const out = await search("aspirin ibuprofen[ti]", [totalOnly("pubmed", 5), new EuropePmcAdapter(cursorHttp(40).http)]);
    expect(out.warnings).toEqual([TAG_WARNING]);
    expect(out.totalByDatabase).toEqual({ pubmed: 5, europepmc: 40 });
  });

  it("adds one per removed tag, on every page", async () => {
    const adapter = new EuropePmcAdapter(cursorHttp(40).http);
    const query = '"Sleep Apnea Syndromes"[mh] AND aspirin ibuprofen[ti]';
    for (const page of [1, 2]) {
      const out = await search(query, [adapter], { page });
      expect(out.warnings).toHaveLength(2);
      expect(out.warnings![0]).toMatch(/^\[mh\] was ignored on europepmc: Europe PMC has no MeSH field/);
      expect(out.warnings![1]).toBe(TAG_WARNING);
    }
  });

  it("says nothing when europepmc is not among the databases searched", async () => {
    const out = await search("aspirin ibuprofen[ti] AND x[mh]", [totalOnly("pubmed", 5)]);
    expect(out.warnings).toBeUndefined();
    const chinaxiv = await search("aspirin ibuprofen[ti]", [totalOnly("chinaxiv", 5)]);
    expect(chinaxiv.warnings).toBeUndefined();
  });

  it("says nothing for a query whose tags europepmc reads", async () => {
    const out = await search('"aspirin ibuprofen"[ti] OR aspirin[ti] AND ibuprofen[ti]', [new EuropePmcAdapter(cursorHttp(40).http)]);
    expect(out.warnings).toBeUndefined();
  });

  it("keeps the warning of a europepmc search that found nothing, beside the empty-result warning", async () => {
    const out = await search("aspirin ibuprofen[ti]", [new EuropePmcAdapter(cursorHttp(0).http)]);
    expect(out.total).toBe(0);
    expect(out.warnings).toContain(TAG_WARNING);
    expect(out.warnings!.length).toBeGreaterThan(1);
  });
});

describe("unquotedHyphenNames", () => {
  it("finds the names with a hyphen that Europe PMC reads as words", () => {
    expect(unquotedHyphenNames("TB-500")).toEqual(["TB-500"]);
    expect(unquotedHyphenNames("SS-31 OR MOTS-c OR PT-141")).toEqual(["SS-31", "MOTS-c", "PT-141"]);
    expect(unquotedHyphenNames("5-HT hs-CRP GHK-Cu IL-6 COVID-19 LL-37 BPC-157")).toEqual(["5-HT", "hs-CRP", "GHK-Cu", "IL-6", "COVID-19", "LL-37", "BPC-157"]);
    expect(unquotedHyphenNames("tb-500 TB-500 Tb-500")).toEqual(["tb-500"]);
    expect(unquotedHyphenNames("(TB-500 NOT mice)")).toEqual(["TB-500"]);
    expect(unquotedHyphenNames("COVID-19, MOTS-c.")).toEqual(["COVID-19", "MOTS-c"]);
    expect(unquotedHyphenNames("12-week creatine trial")).toEqual(["12-week"]);
    expect(unquotedHyphenNames("A-B-c")).toEqual(["A-B-c"]);
  });

  it("leaves out a name in quotes or limited to a field, and words with no hyphen", () => {
    expect(unquotedHyphenNames('"TB-500"')).toEqual([]);
    expect(unquotedHyphenNames('"TB-500" OR "SS-31"[tiab]')).toEqual([]);
    expect(unquotedHyphenNames("il-6[tiab] AND covid-19[ti]")).toEqual([]);
    expect(unquotedHyphenNames("TITLE_ABS:il-6 AND SRC:PPR")).toEqual([]);
    // Measured 2026-11-28: found the same quoted and not.
    expect(unquotedHyphenNames("SGLT2 BRCA1 HbA1c KPV TB ALS CoQ10")).toEqual([]);
  });

  it("counts a name whose tag is removed: it stays in the full text", () => {
    expect(unquotedHyphenNames("TB-500[mh]")).toEqual(["TB-500"]);
    expect(unquotedHyphenNames("TB-500 sleep apnea[tiab]")).toEqual(["TB-500"]);
  });

  it("leaves out ordinary hyphenated words, numbers and ranges, wildcards, and a query that can't be parsed", () => {
    expect(unquotedHyphenNames("slow-wave sleep")).toEqual([]);
    expect(unquotedHyphenNames("meta-analysis long-term anti-inflammatory")).toEqual([]);
    expect(unquotedHyphenNames("creatine 2019-2021 10-20")).toEqual([]);
    expect(unquotedHyphenNames("TB-5*")).toEqual([]);
    expect(unquotedHyphenNames("creatine FIRST_PDATE:[2020-01-01 TO 2021-12-31]")).toEqual([]);
    expect(unquotedHyphenNames('"TB-500 AND')).toEqual([]);
    expect(unquotedHyphenNames("(TB-500")).toEqual([]);
    expect(unquotedHyphenNames("")).toEqual([]);
  });
});
