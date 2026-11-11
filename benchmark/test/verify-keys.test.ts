import { describe, expect, it } from "vitest";
import {
  checkAll,
  checkQuery,
  exitCodeFor,
  expectedPmids,
  normalizeFullText,
  promptPmids,
  quoteParts,
  readWithRetry,
  type Lookups,
  type PmidInfo,
} from "../scripts/verify-keys.js";
import { QUERIES } from "../lib/queries.js";
import type { BenchmarkQuery, KeySource } from "../lib/types.js";

/** Stub lookups: `pmids` maps id -> info (absent = does not exist). */
function stub(pmids: Record<string, PmidInfo>, hits: { pmid: string; title: string }[] = [], regional: Record<string, PmidInfo> = {}): Lookups {
  return {
    fetchPmids: async (ids) => new Map(ids.map((p) => [p, pmids[p] ?? { exists: false }])),
    fetchRegional: async (source) => regional[source.id] ?? { exists: false },
    searchPubmed: async () => hits,
  };
}

const values = (prompt: string, expected: string[]): BenchmarkQuery => ({
  id: "v1",
  category: "factual",
  prompt,
  answerKey: { kind: "values", expected },
  verified: true,
});

const reject = (prompt: string, probe?: string): BenchmarkQuery => ({
  id: "r1",
  category: "bullshit",
  prompt,
  answerKey: { kind: "reject", fabricated: "x", ...(probe ? { probe } : {}) },
  verified: true,
});

const rct: PmidInfo = { exists: true, studyType: "randomized-controlled-trial", designTier: 4, title: "T" };

describe("extraction", () => {
  it("finds PMIDs in prompts and expected tokens", () => {
    expect(promptPmids("Classify PMID 23439798; also PMID: 123456")).toEqual(["23439798", "123456"]);
    expect(expectedPmids(["pmid: 28202713", "hazard ratio: 0.74"])).toEqual(["28202713"]);
  });
});

describe("values keys", () => {
  const q = values("Classify the study behind PMID 111111.", ["study type: randomized-controlled-trial", "evidence score: 4/5"]);

  it("type and score match; without a source the key is reported as unchecked against a record", async () => {
    const r = await checkQuery(q, stub({ "111111": rct }));
    expect(r.status).toBe("NO_SOURCE");
    expect(r.messages).toEqual(["no source: the expected values are not checked against a record"]);
  });

  it("MISMATCH with actual vs expected on wrong type / tier", async () => {
    const r = await checkQuery(q, stub({ "111111": { ...rct, studyType: "cohort", designTier: 3 } }));
    expect(r.status).toBe("MISMATCH");
    expect(r.messages.join("\n")).toContain('expected "randomized-controlled-trial", actual "cohort"');
    expect(r.messages.join("\n")).toContain("expected 4/5, actual 3/5");
  });

  it("WARN, not MISMATCH, when the record has no design metadata", async () => {
    const r = await checkQuery(q, stub({ "111111": { exists: true, studyType: "unknown", designTier: null, title: "T" } }));
    expect(r.status).toBe("WARN");
    expect(r.messages.join("\n")).toContain("no design metadata");
  });

  it("MISMATCH when a retraction zeroes the live tier", async () => {
    const r = await checkQuery(q, stub({ "111111": { ...rct, designTier: 0 } }));
    expect(r.status).toBe("MISMATCH");
    expect(r.messages.join("\n")).toContain("expected 4/5, actual 0/5");
  });

  it("MISMATCH when the expected score disagrees with DESIGN_TIER for the expected type", async () => {
    const bad = values("Classify PMID 111111.", ["study type: randomized-controlled-trial", "evidence score: 5/5"]);
    const r = await checkQuery(bad, stub({ "111111": { exists: true, studyType: "unknown", designTier: null } }));
    expect(r.status).toBe("MISMATCH");
    expect(r.messages.join("\n")).toContain('DESIGN_TIER["randomized-controlled-trial"] = 4');
  });

  it("MISMATCH when a PMID does not resolve, including expected pmid tokens", async () => {
    expect((await checkQuery(q, stub({}))).status).toBe("MISMATCH");
    const r = await checkQuery(values("Find it.", ["pmid: 222222"]), stub({}));
    expect(r.status).toBe("MISMATCH");
  });

  it("ERROR when lookups throw", async () => {
    const boom: Lookups = { fetchPmids: async () => { throw new Error("net down"); }, searchPubmed: async () => [] };
    const r = await checkQuery(q, boom);
    expect(r.status).toBe("ERROR");
    expect(r.messages[0]).toContain("net down");
  });
});

describe("values keys with a source", () => {
  const ABSTRACT =
    "METHODS: We randomly assigned 3297 patients to semaglutide or placebo. RESULTS: The primary outcome occurred in 108 of 1648 patients " +
    "(hazard ratio, 0.74; 95% CI, 0.58 to 0.95). Sixty-three sites took part; the control group received diclofenac sodium.";
  const paper: PmidInfo = { exists: true, studyType: "randomized-controlled-trial", designTier: 4, title: "Semaglutide and outcomes", abstract: ABSTRACT };
  const key = (expected: string[], quote: string, over: Partial<KeySource> = {}, prompt = "Find the trial. Cite the PMID."): BenchmarkQuery => ({
    id: "v2",
    category: "lookup",
    prompt,
    answerKey: { kind: "values", expected, source: { database: "pubmed", id: "27633186", quote, ...over } },
    verified: true,
  });
  const lookups = stub({ "27633186": paper });
  const QUOTE = "We randomly assigned 3297 patients to semaglutide or placebo. … (hazard ratio, 0.74; 95% CI, 0.58 to 0.95)";

  it("OK when the passages are in the abstract and hold every expected number", async () => {
    const r = await checkQuery(key(["pmid: 27633186", "randomized: 3297", "hazard ratio: 0.74"], QUOTE), lookups);
    expect(r).toEqual({ queryId: "v2", status: "OK", messages: [] });
  });

  it("reads spelled-out numbers and tolerates whitespace and typographic dashes in the quote", async () => {
    const r = await checkQuery(key(["sites: 63", "ci upper: 0.95"], "(hazard ratio, 0.74; 95% CI,\n  0.58 to 0.95). Sixty\u2011three sites took part"), lookups);
    expect(r.status).toBe("OK");
  });

  it("ignores private-use font glyphs in the record, which a reader never sees", async () => {
    const glyphs: PmidInfo = { ...paper, abstract: "Forty\uE011four cases of RA were randomized into two groups (n=44 in all); the control group received diclofenac sodium." };
    const r = await checkQuery(key(["patients: 44", "control drug: diclofenac"], "Fortyfour cases of RA were randomized into two groups (n=44 in all); the control group received diclofenac sodium."), stub({ "27633186": glyphs }));
    expect(r.status).toBe("OK");
  });

  it("MISMATCH when an expected number is not in the quoted passage, even if it is elsewhere in the abstract", async () => {
    const r = await checkQuery(key(["randomized: 3297", "events: 108"], "We randomly assigned 3297 patients to semaglutide or placebo."), lookups);
    expect(r.status).toBe("MISMATCH");
    expect(r.messages).toEqual(['expected "events: 108" is not in the quoted passage']);
  });

  it("MISMATCH when the key's number is wrong", async () => {
    const r = await checkQuery(key(["hazard ratio: 0.76"], QUOTE), lookups);
    expect(r.status).toBe("MISMATCH");
    expect(r.messages.join()).toContain('"hazard ratio: 0.76" is not in the quoted passage');
  });

  it("MISMATCH when a quoted passage is not in the record (a paraphrase, or the wrong paper)", async () => {
    const r = await checkQuery(key(["randomized: 3297"], "A total of 3297 patients were randomized."), lookups);
    expect(r.status).toBe("MISMATCH");
    expect(r.messages.join()).toContain("quoted passage is not in the record's title or abstract");
  });

  it("MISMATCH when the source record does not resolve", async () => {
    const r = await checkQuery(key(["randomized: 3297"], QUOTE, { id: "11111111" }), lookups);
    expect(r.status).toBe("MISMATCH");
    expect(r.messages).toEqual(["source record pubmed 11111111 does not resolve"]);
  });

  it("MISMATCH when the expected PMID is another record's, or the prompt gives it away", async () => {
    const other = await checkQuery(key(["pmid: 22222222", "randomized: 3297"], QUOTE), stub({ "27633186": paper, "22222222": rct }));
    expect(other.messages).toContain("expected pmid 22222222 is not the source record (27633186)");
    const leaked = await checkQuery(key(["pmid: 27633186"], QUOTE, {}, "Summarize 27633186 and cite the PMID."), lookups);
    expect(leaked.status).toBe("MISMATCH");
    expect(leaked.messages).toContain("the prompt contains the PMID it asks for (27633186)");
  });

  it("checks a phrase against the passage, and warns about a value it can't check", async () => {
    const drug = await checkQuery(key(["control drug: diclofenac"], "the control group received diclofenac sodium"), lookups);
    expect(drug.status).toBe("OK");
    const design = await checkQuery(key(["blinding: triple-blind"], QUOTE), lookups);
    expect(design.status).toBe("WARN");
    expect(design.messages.join()).toContain("rests on the key's note");
  });

  it("looks regional records up in their own database", async () => {
    const cba: PmidInfo = { exists: true, title: "Clinical observation", abstract: "Fortyfour cases of RA were randomized into two groups." };
    const q = key(["patients: 44"], "Fortyfour cases of RA were randomized", { database: "europepmc", id: "CBA:521529" });
    expect((await checkQuery(q, stub({}, [], { "CBA:521529": cba }))).status).toBe("OK");
    expect((await checkQuery(q, stub({}))).status).toBe("MISMATCH");
  });

  it("splits a quote into its passages", () => {
    expect(quoteParts("first part … second part")).toEqual(["first part", "second part"]);
    expect(quoteParts("only one, with an ellipsis… inside")).toEqual(["only one, with an ellipsis… inside"]);
  });
});

describe("fulltext keys: a figure that only the full text states", () => {
  const ABSTRACT = "Methods: In this pragmatic trial 1200 adults were randomized to a text-message programme or usual care. Results: Quit rates were higher with the programme.";
  const FULL = "# Results\n\nThe median follow-up was 18 months in\nthe programme arm. Adverse events were rare.";
  const paper: PmidInfo = { exists: true, title: "Text messages for smoking cessation", abstract: ABSTRACT };
  const fullTextQuote = "The median follow-up was 18 months in the programme arm.";
  const query = (over: Partial<KeySource> = {}, expected = ["pmid: 34728476", "randomized: 1200", "follow-up months: 18"], category: BenchmarkQuery["category"] = "fulltext"): BenchmarkQuery => ({
    id: "t-fulltext-01",
    category,
    prompt: "A pragmatic trial tested a text-message programme. How many were randomized and how long was the median follow-up? Cite the PMID.",
    answerKey: {
      kind: "values",
      expected,
      source: { database: "pubmed", id: "34728476", quote: "1200 adults were randomized to a text-message programme or usual care.", fullTextQuote, ...over },
    },
    beyondPubmed: true,
    verified: true,
  });
  const lookups = (text: string | null = FULL, record: PmidInfo = paper, extra: Partial<Lookups> = {}): Lookups & { asked: string[] } => {
    const asked: string[] = [];
    return {
      ...stub({ "34728476": record }),
      fetchFulltext: async (id) => {
        asked.push(id);
        return text === null ? { source: "none", warning: "Europe PMC has the abstract only" } : { text, source: "europepmc" };
      },
      ...extra,
      asked,
    };
  };

  it("OK when the full text holds the passage and the figure, and the abstract does not hold the figure", async () => {
    const l = lookups();
    expect(await checkQuery(query(), l)).toEqual({ queryId: "t-fulltext-01", status: "OK", messages: [] });
    expect(l.asked).toEqual(["34728476"]);
  });

  it("MISMATCH when the passage is not in the full text (a paraphrase, or the wrong paper)", async () => {
    const r = await checkQuery(query({ fullTextQuote: "The median follow-up was 18 months in the control arm." }), lookups());
    expect(r.status).toBe("MISMATCH");
    expect(r.messages.join()).toContain("passage is not in the full text (europepmc)");
  });

  it("MISMATCH when the figure is also a number of the abstract, or of the title", async () => {
    const inAbstract = await checkQuery(query(), lookups(FULL, { ...paper, abstract: `${ABSTRACT} Follow-up lasted 18 months.` }));
    expect(inAbstract.status).toBe("MISMATCH");
    expect(inAbstract.messages.join()).toContain("full-text figure 18 is also a number in the record's title or abstract");
    const inTitle = await checkQuery(query(), lookups(FULL, { ...paper, title: "An 18 month trial" }));
    expect(inTitle.status).toBe("MISMATCH");
    // A figure spelled out in the abstract is the same figure.
    const spelled = await checkQuery(query(), lookups(FULL, { ...paper, abstract: `${ABSTRACT} Eighteen sites took part.` }));
    expect(spelled.messages.join()).toContain("also a number in");
  });

  it("MISMATCH when the full-text function returns no body, with what it said", async () => {
    const r = await checkQuery(query(), lookups(null));
    expect(r.status).toBe("MISMATCH");
    expect(r.messages.join()).toContain("returns no body for 34728476 (Europe PMC has the abstract only)");
  });

  it("ERROR, not a verdict on the key, when the full text cannot be fetched; WARN when this check has no way to", async () => {
    const down = lookups(FULL, paper, {
      fetchFulltext: async () => {
        throw new Error("fetch failed");
      },
    });
    expect((await checkQuery(query(), down)).status).toBe("ERROR");
    const noFetch = { ...stub({ "34728476": paper }) };
    const r = await checkQuery(query(), noFetch);
    expect(r.status).toBe("WARN");
    expect(r.messages.join()).toContain("fullTextQuote is not checked");
  });

  it("holds every expected number to the abstract quote or the full-text passage, and needs one only the full text states", async () => {
    const neither = await checkQuery(query({}, ["pmid: 34728476", "randomized: 1200", "follow-up months: 19"]), lookups());
    expect(neither.status).toBe("MISMATCH");
    expect(neither.messages.join()).toContain('"follow-up months: 19" is not in the quoted passage or in the full-text passage');
    const none = await checkQuery(query({}, ["pmid: 34728476", "randomized: 1200"]), lookups());
    expect(none.status).toBe("MISMATCH");
    expect(none.messages.join()).toContain("no figure that only the full text states");
  });

  it("MISMATCH for a fulltext query that has no fullTextQuote, and for a source that gives an empty one", async () => {
    const without = query();
    delete (without.answerKey as { source?: KeySource }).source!.fullTextQuote;
    const r = await checkQuery(without, lookups());
    expect(r.status).toBe("MISMATCH");
    expect(r.messages.join()).toContain("needs a fullTextQuote");
    expect((await checkQuery(query({ fullTextQuote: "" }), lookups())).messages.join()).toContain("empty fullTextQuote");
  });

  it("reads a passage through line-break hyphenation, thousands separators and typographic marks: the source the library returns can differ between runs", async () => {
    // An Unpaywall PDF breaks lines inside words ("partici-\npants", "Ada-\nmawa"); Europe PMC's markdown does not.
    const pdf = "a random sample of 1,103 partici-\npants were assessed for eligibility for the\nintervention study; it was imple-\nmented in the districts of Ada-\nmawa, Nasarawa, and Ondo";
    const markdown = "a random sample of 1103 participants were assessed for eligibility for the intervention study; it was implemented in the districts of Adamawa, Nasarawa, and Ondo";
    const passages = [
      "a random sample of 1,103 partici- pants were assessed for eligibility for the intervention study", // copied from the PDF text
      "a random sample of 1,103 participants were assessed for eligibility for the intervention study", // copied from the markdown
      "a random sample of 1103 participants were assessed for eligibility for the intervention study",
      "it was implemented in the districts of Adamawa, Nasarawa, and Ondo",
      "it was imple- mented in the districts of Ada- mawa, Nasarawa, and Ondo",
    ];
    for (const text of [pdf, markdown]) {
      for (const fullTextQuote of passages) {
        const r = await checkQuery(query({ fullTextQuote }, ["pmid: 34728476", "randomized: 1200", "assessed: 1103"]), lookups(text));
        expect(r.messages.join()).not.toContain("passage is not in the full text");
        // A passage without the figure fails on that, never on the text.
        if (/1,?103/.test(fullTextQuote)) expect(r.status).toBe("OK");
      }
    }
    // A real hyphen across a line break matches the compound written with its hyphen, and a typographic dash or quote matches a plain one.
    expect((await checkQuery(query({ fullTextQuote: "The median follow-up was 18 months" }), lookups("The median follow-\nup was 18 months in the programme arm."))).status).toBe("OK");
    expect((await checkQuery(query({ fullTextQuote: "The median follow-up was 18 months" }), lookups("The median follow\u2011up was 18 months in the programme arm."))).status).toBe("OK");
  });

  it("stays strict about words and numbers: a different word, number or digit group does not match", async () => {
    const text = "In 1,103 participants, 618 did not meet the criteria; 5-10 were lost, and 1 103 more were seen.";
    const wrong = [
      "In 1,104 participants", // another number
      "In 1,103 participants, 681 did not meet", // digits transposed
      "were lost, and 1103 more", // "1 103" is two numbers, not 1103
      "5 10 were lost", // a range is not two numbers
      "In 1,103 patients", // another word
    ];
    for (const fullTextQuote of wrong) {
      const r = await checkQuery(query({ fullTextQuote }, ["pmid: 34728476", "randomized: 1200", "follow-up months: 18"]), lookups(text));
      expect(r.messages.join()).toContain("passage is not in the full text");
      expect(r.status).toBe("MISMATCH");
    }
  });

  it("does not loosen the abstract check: a hyphenated or separated number in a quote of the abstract is still compared as it is", async () => {
    const strict = await checkQuery(query({ quote: "1,200 adults were randomized to a text-message programme or usual care." }), lookups());
    expect(strict.status).toBe("MISMATCH");
    expect(strict.messages.join()).toContain("quoted passage is not in the record's title or abstract");
    const hyphen = await checkQuery(query({ quote: "1200 adults were randomized to a text- message programme or usual care." }), lookups());
    expect(hyphen.status).toBe("MISMATCH");
  });

  it("normalizeFullText folds only what does not change a word or a number", () => {
    expect(normalizeFullText("Partici-\n pants  were “screened” – 1,103 of them")).toBe(normalizeFullText("participants were \"screened\" - 1103 of them"));
    expect(normalizeFullText("long-\nterm follow\u00ADup")).toBe(normalizeFullText("long-term followup"));
    expect(normalizeFullText("10-20 and -3.12 and 1 103")).toBe("10-20 and -3.12 and 1 103");
    expect(normalizeFullText("a,b 1,23 4,5678")).toBe("a,b 1,23 4,5678");
  });

  it("splits a full-text quote into passages like an abstract quote", async () => {
    const r = await checkQuery(query({ fullTextQuote: "The median follow-up was 18 months … Adverse events were rare." }), lookups());
    expect(r.status).toBe("OK");
  });
});

describe("readWithRetry", () => {
  const unreached = { source: "none", warning: "No full text found; returned the abstract only. Europe PMC's full text for PMC1 couldn't be reached." };
  const refused = { source: "none", warning: "Europe PMC has the abstract only. The publisher's site refused access (HTTP 403)." };
  const noSleep = async () => undefined;
  const sequence = (...results: { text?: string; source: string; warning?: string }[]) => {
    let calls = 0;
    return { read: async () => results[Math.min(calls++, results.length - 1)]!, calls: () => calls };
  };

  it("reads again while a source did not answer, and returns the text once there is one", async () => {
    const s = sequence(unreached, unreached, { text: "the body", source: "europepmc" });
    expect(await readWithRetry(s.read, { sleep: noSleep })).toEqual({ text: "the body", source: "europepmc" });
    expect(s.calls()).toBe(3);
  });

  it("gives up after its tries and returns the last answer as it is, so a key without a body still fails", async () => {
    const s = sequence(unreached);
    expect(await readWithRetry(s.read, { tries: 3, sleep: noSleep })).toEqual(unreached);
    expect(s.calls()).toBe(3);
  });

  it("does not repeat a read that says there is no body for another reason, or that has one", async () => {
    const none = sequence(refused);
    expect(await readWithRetry(none.read, { sleep: noSleep })).toEqual(refused);
    expect(none.calls()).toBe(1);
    const ok = sequence({ text: "x", source: "unpaywall" });
    await readWithRetry(ok.read, { sleep: noSleep });
    expect(ok.calls()).toBe(1);
  });
});

describe("preprint and regional keys: the record is not in PubMed", () => {
  const record: PmidInfo = { exists: true, title: "Supervised exercise in frail older adults: a randomized trial.", abstract: "60 patients were randomized to supervised exercise or usual care." };
  const query = (category: BenchmarkQuery["category"], id = "PPR1305370"): BenchmarkQuery => ({
    id: "t-x-01",
    category,
    prompt: "A 2026 preprint reports a trial of exercise in frail adults. How many were randomized? Cite the record you found.",
    answerKey: { kind: "values", expected: [`record: ${id}`, "randomized: 60"], source: { database: "europepmc", id, quote: "60 patients were randomized to supervised exercise or usual care." } },
    beyondPubmed: true,
    verified: true,
  });
  const searches: string[] = [];
  const lookups = (hits: { pmid: string; title: string }[]): Lookups => ({
    ...stub({}, [], { PPR1305370: record, "CBA:5": record }),
    searchPubmed: async (q) => {
      searches.push(q);
      return hits;
    },
  });

  it("OK when no PubMed record has the title, searching for it as an exact title", async () => {
    searches.length = 0;
    expect((await checkQuery(query("preprint"), lookups([]))).status).toBe("OK");
    expect(searches).toEqual(['"Supervised exercise in frail older adults: a randomized trial."[ti]']);
    expect((await checkQuery(query("regional", "CBA:5"), lookups([{ pmid: "9", title: "A different trial of exercise" }]))).status).toBe("OK");
  });

  it("MISMATCH when a PubMed record has the record's title, whatever the case and the final period", async () => {
    const r = await checkQuery(query("preprint"), lookups([{ pmid: "40123456", title: "Supervised Exercise in Frail Older Adults: A Randomized Trial" }]));
    expect(r.status).toBe("MISMATCH");
    expect(r.messages.join()).toContain("PPR1305370 is in PubMed: PMID 40123456 has its title");
    expect((await checkQuery(query("regional", "CBA:5"), lookups([{ pmid: "7", title: record.title! }]))).status).toBe("MISMATCH");
  });

  it("holds the record field to the source's id, as a lookup's pmid field is held to its PMID", async () => {
    const withExpected = (q: BenchmarkQuery, expected: string[]): BenchmarkQuery => ({ ...q, answerKey: { ...(q.answerKey as { kind: "values"; source?: KeySource }), kind: "values", expected } });
    const ok = await checkQuery(query("preprint"), lookups([]));
    expect(ok).toEqual({ queryId: "t-x-01", status: "OK", messages: [] });
    // Another record's id, another form of the id, a missing field, or the id in the prompt.
    const other = await checkQuery(withExpected(query("preprint"), ["record: PPR1305371", "randomized: 60"]), lookups([]));
    expect(other.status).toBe("MISMATCH");
    expect(other.messages).toContain("expected record PPR1305371 is not the source record (PPR1305370)");
    const cba = await checkQuery(withExpected(query("regional", "CBA:5"), ["record: CBA 5", "randomized: 60"]), lookups([]));
    expect(cba.messages).toContain("expected record CBA 5 is not the source record (CBA:5)");
    const missing = await checkQuery(withExpected(query("preprint"), ["randomized: 60"]), lookups([]));
    expect(missing.status).toBe("MISMATCH");
    expect(missing.messages.join()).toContain('needs "record: PPR1305370" as its first expected field');
    const late = await checkQuery(withExpected(query("regional", "CBA:5"), ["randomized: 60", "record: CBA:5"]), lookups([]));
    expect(late.messages.join()).toContain('needs "record: CBA:5" as its first expected field');
    const given = await checkQuery({ ...query("preprint"), prompt: `${query("preprint").prompt} It is PPR1305370.` }, lookups([]));
    expect(given.status).toBe("MISMATCH");
    expect(given.messages).toContain("the prompt contains the record id it asks for (PPR1305370)");
    // A ChinaXiv id has a dot and a dash: it is matched as text, not as a pattern.
    const cx = { ...query("regional", "chinaxiv-202304.00908"), prompt: "A Chinese preprint about chinaxiv-202304x00908 reports a trial. How many?" };
    const cxKey = cx.answerKey as { source: KeySource };
    const chinaxiv: BenchmarkQuery = { ...cx, answerKey: { kind: "values", expected: ["record: chinaxiv-202304.00908", "randomized: 60"], source: { ...cxKey.source, database: "chinaxiv" } } };
    const cxLookups: Lookups = { ...lookups([]), fetchRegional: async () => record };
    expect((await checkQuery(chinaxiv, cxLookups)).status).toBe("OK");
    expect((await checkQuery({ ...chinaxiv, prompt: "About chinaxiv-202304.00908: how many?" }, cxLookups)).status).toBe("MISMATCH");
  });

  it("is asked of the new kinds only: a development edge case with a regional source is not searched", async () => {
    searches.length = 0;
    expect((await checkQuery(query("edge-case"), lookups([{ pmid: "7", title: record.title! }]))).status).toBe("OK");
    expect(searches).toEqual([]);
  });
});

describe("accept keys", () => {
  const study: PmidInfo = { exists: true, title: "Ashwagandha in elite cyclists", authors: ["Shenoy S", "Chaskar U", "Del Coso J"], pubYear: 2012 };
  const accept = (over: Partial<{ pmid: string; author: string; year: number }> = {}, prompt = "Summarize the 2012 Shenoy trial of ashwagandha in elite cyclists."): BenchmarkQuery => ({
    id: "c1",
    category: "control",
    prompt,
    answerKey: { kind: "accept", pmid: "23326093", author: "Shenoy", year: 2012, ...over },
    verified: true,
  });
  const lookups = stub({ "23326093": study });

  it("OK when the record exists and matches the author and year the prompt names", async () => {
    expect(await checkQuery(accept(), lookups)).toEqual({ queryId: "c1", status: "OK", messages: [] });
    // Print year one off the online year is still the same paper; a compound surname matches too.
    expect((await checkQuery(accept({ year: 2013 }, "Summarize the 2013 Shenoy trial."), lookups)).status).toBe("OK");
    expect((await checkQuery(accept({ author: "Del Coso" }, "Summarize the 2012 Del Coso trial."), lookups)).status).toBe("OK");
  });

  it("MISMATCH when the study does not exist, or the author or year is not the record's", async () => {
    expect((await checkQuery(accept(), stub({}))).messages).toEqual(["PMID 23326093 does not resolve"]);
    const author = await checkQuery(accept({ author: "Okafor" }, "Summarize the 2012 Okafor trial."), lookups);
    expect(author.status).toBe("MISMATCH");
    expect(author.messages.join()).toContain('"Okafor" is not an author of PMID 23326093');
    const year = await checkQuery(accept({ year: 2021 }, "Summarize the 2021 Shenoy trial."), lookups);
    expect(year.messages.join()).toContain("was published in 2012, the key says 2021");
  });

  it("MISMATCH when prompt and key disagree, or the prompt gives the PMID", async () => {
    const drift = await checkQuery(accept({}, "Summarize the 2014 Sharma trial."), lookups);
    expect(drift.messages).toContain("the prompt does not name the key's author and year (Shenoy, 2012)");
    const leaked = await checkQuery(accept({}, "Summarize the 2012 Shenoy trial (PMID 23326093)."), lookups);
    expect(leaked.messages).toContain("the prompt contains the study's PMID (23326093)");
  });
});

describe("reject keys", () => {
  it("OK when probe is empty and fake PMID does not resolve", async () => {
    expect((await checkQuery(reject("Summarize Thornbury (PMID 99999999).", "Thornbury[au]"), stub({}))).status).toBe("OK");
  });

  it("MISMATCH when the fake PMID resolves", async () => {
    const r = await checkQuery(reject("Summarize PMID 99999999.", "p"), stub({ "99999999": { exists: true, title: "Real paper" } }));
    expect(r.status).toBe("MISMATCH");
    expect(r.messages.join("\n")).toContain("RESOLVES");
  });

  it("WARN with titles on probe hits", async () => {
    const r = await checkQuery(reject("Summarize Jensen 2023.", "Jensen[au]"), stub({}, [{ pmid: "5", title: "Jensen melatonin" }]));
    expect(r.status).toBe("WARN");
    expect(r.messages.join("\n")).toContain("Jensen melatonin");
  });

  it("reports no probe", async () => {
    const r = await checkQuery(reject("Summarize Jensen 2023."), stub({}));
    expect(r.status).toBe("NO_PROBE");
    expect(r.messages).toContain("no probe");
  });
});

describe("checkAll / exit code", () => {
  it("skips unverified keys and fails only on MISMATCH/ERROR", async () => {
    const unverified = { ...values("PMID 1111", ["pmid: 1111"]), verified: false };
    const results = await checkAll([unverified, reject("Jensen.", "q")], stub({}, [{ pmid: "5", title: "t" }]));
    expect(results).toHaveLength(1);
    expect(exitCodeFor(results)).toBe(0); // probe hit is only a warning
    expect(exitCodeFor([{ queryId: "x", status: "MISMATCH", messages: [] }])).toBe(1);
    expect(exitCodeFor([{ queryId: "x", status: "NO_SOURCE", messages: [] }])).toBe(0);
  });

  it("with `all`, checks unverified keyed queries too, but never rubric ones", async () => {
    const unverified = { ...values("PMID 1111", ["pmid: 1111"]), verified: false };
    const rubric: BenchmarkQuery = { id: "r", category: "synthesis", prompt: "p", answerKey: { kind: "rubric", rubric: "r" }, verified: false };
    const results = await checkAll([unverified, rubric], stub({}), { all: true });
    expect(results.map((r) => r.queryId)).toEqual(["v1"]);
  });

  it("fetches each PMID once, in batches, however many keys name it", async () => {
    const calls: string[][] = [];
    const counting: Lookups = {
      fetchPmids: async (ids) => {
        calls.push(ids);
        return new Map(ids.map((p) => [p, { exists: true, studyType: "unknown", designTier: null }]));
      },
      searchPubmed: async () => [],
    };
    const many = Array.from({ length: 90 }, (_, i) => ({ ...values(`Find it.`, [`pmid: ${100000 + i}`]), id: `v${i}` }));
    const results = await checkAll([...many, ...many.slice(0, 5).map((q) => ({ ...q, id: `${q.id}-again` }))], counting);
    expect(results).toHaveLength(95);
    expect(calls.map((c) => c.length)).toEqual([40, 40, 10]);
  });

  it("a failed batch is not remembered as missing: the keys that need it report the error", async () => {
    let fail = true;
    const flaky: Lookups = {
      fetchPmids: async (ids) => {
        if (fail) throw new Error("net down");
        return new Map(ids.map((p) => [p, { exists: true }]));
      },
      searchPubmed: async () => [],
    };
    const q = values("Find it.", ["pmid: 222222"]);
    expect((await checkAll([q], flaky))[0]!.status).toBe("ERROR");
    fail = false;
    expect((await checkAll([q], flaky))[0]!.status).not.toBe("ERROR");
  });
});

describe("the catalog", () => {
  it("every values key names its source record and quotes the passage with its numbers", () => {
    for (const q of QUERIES) {
      if (q.answerKey.kind !== "values") continue;
      expect(q.answerKey.source, q.id).toBeDefined();
      expect(quoteParts(q.answerKey.source!.quote).length, q.id).toBeGreaterThan(0);
    }
  });
});
