import { describe, expect, it } from "vitest";
import {
  checkAll,
  checkQuery,
  exitCodeFor,
  expectedPmids,
  promptPmids,
  quoteParts,
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
