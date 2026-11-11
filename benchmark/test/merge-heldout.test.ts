/**
 * The merge of staged beyond-PubMed queries into the held-out set: what it validates, how it numbers,
 * and that it can be run again. Everything runs on a synthetic sample file and data file in a temporary
 * directory; nothing here reads the repository's draw.
 */

import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import {
  BEGIN_MARK,
  CITE_RECORD,
  END_MARK,
  assignIds,
  formatQuery,
  formatRegion,
  idTail,
  mentionsId,
  mergeInto,
  namedAuthors,
  plan,
  questionOf,
  replaceRegion,
  surnames,
  validateAgainstCandidate,
  validateQuery,
  validateStaged,
  type CandidateText,
  type MergedQuery,
  type StagedFile,
  type StagedQuery,
} from "../scripts/merge-heldout.js";
import {
  ESTABLISHED_JOURNALS,
  ESTABLISHED_YEARS,
  FULLTEXT_YEARS,
  HISTORY,
  PREPRINT_WINDOW,
  RECENT_WINDOW,
  SEED,
  readSample,
  stratumFile,
  type DrawnStratum,
  type SampleFile,
} from "../scripts/sample-heldout.js";

const TAIL = "Finish your reply with one line in EXACTLY this format and nothing else on that line:";

const PPR_ABSTRACT = "Background: Frailty is common. Methods: 60 patients were randomized to supervised exercise or usual care. Results: 14 of 30 patients in the exercise group had an event.";
/** A different question for each record, so that two queries never share a prompt. */
const FLAVOR: Record<string, string> = {
  PPR1305370: "supervised",
  PPR1282579: "home-based",
  PPR1261422: "group",
  "CBA:633654": "aerobic",
  "CBA:618117": "walking",
  "chinaxiv-202304.00908": "resistance",
};
const preprint = (over: Partial<StagedQuery> = {}, id = "PPR1305370"): StagedQuery => ({
  category: "preprint",
  topics: ["exercise", "frailty"],
  prompt: `A 2026 preprint reports a randomized trial of ${FLAVOR[id] ?? "balance"} exercise against usual care in frail older adults. How many participants were randomized, and how many in the exercise arm had an event? ${CITE_RECORD} ${TAIL}\n\`ANSWER — record: <id> | randomized: <number> | events in exercise arm: <number>\``,
  answerKey: {
    kind: "values",
    expected: [`record: ${id}`, "randomized: 60", "events in exercise arm: 14"],
    source: { database: "europepmc", id, quote: "60 patients were randomized to supervised exercise or usual care. … 14 of 30 patients in the exercise group had an event." },
  },
  retrievalOnly: true,
  beyondPubmed: true,
  verified: true,
  ...over,
});

const FT_ABSTRACT = "Methods: In this pragmatic trial 1200 adults were randomized to a text-message programme or usual care. Results: Quit rates were higher with the programme.";
const fulltext = (over: Partial<StagedQuery> = {}): StagedQuery => ({
  category: "fulltext",
  topics: ["smoking", "text message"],
  prompt: `A pragmatic randomized trial in a general medical journal tested a text-message programme for smoking cessation against usual care. How many adults were randomized, and for how many months was the median follow-up in the programme arm? Cite the PMID. ${TAIL}\n\`ANSWER — PMID: <number> | randomized: <number> | follow-up months: <number>\``,
  answerKey: {
    kind: "values",
    expected: ["pmid: 34728476", "randomized: 1200", "follow-up months: 18"],
    source: {
      database: "pubmed",
      id: "34728476",
      quote: "1200 adults were randomized to a text-message programme or usual care.",
      fullTextQuote: "The median follow-up was 18 months in the programme arm.",
    },
  },
  retrievalOnly: false,
  beyondPubmed: true,
  verified: true,
  ...over,
});

const withKey = (q: StagedQuery, key: Partial<StagedQuery["answerKey"]>): StagedQuery => ({ ...q, answerKey: { ...q.answerKey, ...key } });
/** The same query with other source fields; an id field of the key follows the source id. */
const withSource = (q: StagedQuery, source: Partial<StagedQuery["answerKey"]["source"]>): StagedQuery => {
  const expected = q.answerKey.expected[0]?.startsWith("record:") && source.id !== undefined ? [`record: ${source.id}`, ...q.answerKey.expected.slice(1)] : q.answerKey.expected;
  return withKey(q, { expected, source: { ...q.answerKey.source, ...source } });
};
const errorsOf = (q: unknown, frame: "preprint" | "regional" | "fulltext" = "preprint", database = "europepmc", id = "PPR1305370"): string => validateQuery(q, frame, database, id).join(" | ");

describe("validateQuery", () => {
  it("accepts a well-formed query of each kind", () => {
    expect(validateQuery(preprint(), "preprint", "europepmc", "PPR1305370")).toEqual([]);
    expect(validateQuery(fulltext(), "fulltext", "pubmed", "34728476")).toEqual([]);
    const cba = preprint({ category: "regional" }, "CBA:633654");
    expect(validateQuery(cba, "regional", "europepmc", "CBA:633654")).toEqual([]);
    const chinaxiv = withSource(preprint({ category: "regional" }), { database: "chinaxiv", id: "chinaxiv-202304.00908" });
    expect(validateQuery(chinaxiv, "regional", "chinaxiv", "chinaxiv-202304.00908")).toEqual([]);
  });

  it("holds the category, flags and fields to the frame", () => {
    expect(errorsOf(preprint({ category: "lookup" }))).toContain('category must be "preprint"');
    expect(errorsOf(preprint({ retrievalOnly: false }))).toContain("retrievalOnly must be true");
    expect(errorsOf(fulltext({ retrievalOnly: true }), "fulltext", "pubmed", "34728476")).toContain("retrievalOnly must be false");
    expect(errorsOf({ ...preprint(), beyondPubmed: false })).toContain("beyondPubmed must be true");
    expect(errorsOf(preprint({ verified: false as true }))).toContain("verified must be true");
    expect(errorsOf({ ...preprint(), id: "t-preprint-01" })).toContain('unknown field "id"');
    expect(errorsOf(preprint({ topics: [] }))).toContain("topics must be a non-empty array");
    expect(errorsOf("nope")).toContain("not an object");
  });

  it("holds the source to the stratum's database and the candidate", () => {
    expect(errorsOf(withSource(preprint(), { database: "pubmed" }))).toContain('source.database must be "europepmc"');
    expect(errorsOf(withSource(preprint(), { id: "PPR1" }))).toContain("source.id must be the candidate's id PPR1305370");
    expect(errorsOf(withSource(preprint(), { quote: "" }))).toContain("source.quote");
    expect(errorsOf(withSource(fulltext(), { fullTextQuote: undefined }), "fulltext", "pubmed", "34728476")).toContain("fullTextQuote is required");
    expect(errorsOf(withSource(preprint(), { fullTextQuote: "A passage." }))).toContain("for fulltext queries only");
  });

  it("holds the prompt to the frame's format, and the answer line to the expected fields", () => {
    const only = (prompt: string) => errorsOf(preprint({ prompt }));
    expect(only(preprint().prompt.replace(CITE_RECORD, "Cite the PMID."))).toContain("prompt must be");
    // The sentence that tells the model to give the id as the database shows it is part of the prompt.
    expect(only(preprint().prompt.replace(CITE_RECORD, "Cite the record you found."))).toContain("prompt must be");
    expect(only(preprint().prompt.replace("EXACTLY", "exactly"))).toContain("prompt must be");
    expect(only(preprint().prompt.replace("record: <id> | randomized", "randomized"))).toContain("prompt must be");
    expect(only(preprint().prompt.replace("record: <id>", "id: <id>"))).toContain("prompt must be");
    expect(only(preprint().prompt.replace("record: <id>", "record: <number>"))).toContain("prompt must be");
    expect(only(preprint().prompt.replace("<number> | events", "<number> | PMID: <number> | events"))).toContain("prompt must be");
    expect(only(preprint().prompt.replace("events in exercise arm", "events"))).toContain("must be the expected fields");
    // The record's id is the first field of a preprint or regional key, as the PMID is of a lookup: three fields, like a lookup.
    expect(errorsOf(withKey(preprint(), { expected: ["randomized: 60", "events in exercise arm: 14"] }))).toContain("expected must have 3 fields (record, then two numbers)");
    expect(errorsOf(withKey(preprint(), { expected: ["randomized: 60", "events in exercise arm: 14", "record: PPR1305370"] }))).toContain('first expected field must be "record: PPR1305370"');
    expect(errorsOf(withKey(preprint(), { expected: ["pmid: PPR1305370", "randomized: 60", "events in exercise arm: 14"] }))).toContain('first expected field must be "record: PPR1305370"');
    // The id is written as the database shows it: not another case, not another record.
    expect(errorsOf(withKey(preprint(), { expected: ["record: ppr1305370", "randomized: 60", "events in exercise arm: 14"] }))).toContain('first expected field must be "record: PPR1305370"');
    expect(errorsOf(withKey(preprint(), { expected: ["record: PPR1", "randomized: 60", "events in exercise arm: 14"] }))).toContain('first expected field must be "record: PPR1305370"');
    expect(errorsOf(withKey(preprint(), { expected: ["record: PPR1305370", "Randomized: 60", "events in exercise arm: 14"] }))).toContain("lowercase");
    const cba = preprint({ category: "regional" }, "CBA:633654");
    expect(cba.answerKey.expected[0]).toBe("record: CBA:633654");
    expect(errorsOf(withKey(cba, { expected: ["record: CBA 633654", ...cba.answerKey.expected.slice(1)] }), "regional", "europepmc", "CBA:633654")).toContain('first expected field must be "record: CBA:633654"');
    const chinaxiv = withSource(preprint({ category: "regional" }), { database: "chinaxiv", id: "chinaxiv-202304.00908" });
    expect(chinaxiv.answerKey.expected[0]).toBe("record: chinaxiv-202304.00908");
    expect(errorsOf(withKey(chinaxiv, { expected: ["record: 202304.00908", ...chinaxiv.answerKey.expected.slice(1)] }), "regional", "chinaxiv", "chinaxiv-202304.00908")).toContain('first expected field must be "record: chinaxiv-202304.00908"');
    // fulltext: the PMID first, then two numbers.
    expect(errorsOf(withKey(fulltext(), { expected: ["pmid: 1", "randomized: 1200", "follow-up months: 18"] }), "fulltext", "pubmed", "34728476")).toContain('first expected field must be "pmid: 34728476"');
    expect(errorsOf(fulltext({ prompt: fulltext().prompt.replace("ANSWER — PMID: <number> | ", "ANSWER — ") }), "fulltext", "pubmed", "34728476")).toContain("prompt must be");
  });

  it("requires the expected numbers in the quotes, and none in the question", () => {
    expect(errorsOf(withKey(preprint(), { expected: ["record: PPR1305370", "randomized: 61", "events in exercise arm: 14"] }))).toContain("must be a number of source.quote");
    expect(errorsOf(withKey(preprint(), { expected: ["record: PPR1305370", "randomized: sixty", "events in exercise arm: 14"] }))).toContain("plain number");
    expect(errorsOf(preprint({ prompt: preprint().prompt.replace("older adults", "older adults (60 randomized)") }))).toContain("stated in the question");
    // Not given away by a longer number or a decimal that merely contains it.
    expect(errorsOf(preprint({ prompt: preprint().prompt.replace("older adults", "older adults aged 160 or 6.014") }))).toBe("");
    // fulltext: the first number is the abstract's, the second only the full text's.
    const f = (q: StagedQuery) => errorsOf(q, "fulltext", "pubmed", "34728476");
    expect(f(withKey(fulltext(), { expected: ["pmid: 34728476", "randomized: 1200", "follow-up months: 17"] }))).toContain("must be a number of source.fullTextQuote");
    expect(f(withSource(fulltext(), { quote: "1200 adults were randomized to a text-message programme or usual care for 18 months." }))).toContain("also in source.quote");
    expect(f(withKey(fulltext(), { expected: ["pmid: 34728476", "randomized: 1300", "follow-up months: 18"] }))).toContain("must be a number of source.quote");
  });

  it("keeps the record out of the question: no id, DOI, PMID or authors", () => {
    const ask = (extra: string) => errorsOf(preprint({ prompt: preprint().prompt.replace("frail older adults", `frail older adults ${extra}`) }));
    expect(ask("(PPR1305370)")).toContain("contains a record id");
    expect(ask("(1305370)")).toContain("contains a record id");
    expect(ask("(see PPR123)")).toContain("contains a record id");
    expect(ask("(doi 10.1101/2026.05.01.12345)")).toContain("PMID or a DOI");
    expect(ask("(PMID 34728476)")).toContain("PMID or a DOI");
    expect(ask("by Smith et al")).toContain("names authors");
    expect(ask("")).toBe("");
    const cba = preprint({ category: "regional" }, "CBA:633654");
    expect(errorsOf({ ...cba, prompt: cba.prompt.replace("frail", "frail CBA:633654") }, "regional", "europepmc", "CBA:633654")).toContain("contains a record id");
    expect(errorsOf({ ...cba, prompt: cba.prompt.replace("frail", "frail 633654") }, "regional", "europepmc", "CBA:633654")).toContain("contains a record id");
  });
});

describe("what the question must not name", () => {
  it("finds a record id by its text or its number, in any separator", () => {
    expect(idTail("PPR1305370")).toBe("1305370");
    expect(idTail("CBA:633654")).toBe("633654");
    expect(idTail("chinaxiv-202304.00908")).toBe("202304.00908");
    expect(idTail("PPR12")).toBeUndefined();
    expect(mentionsId("see ppr1305370 for details", "PPR1305370")).toBe(true);
    expect(mentionsId("record CBA 633654", "CBA:633654")).toBe(true);
    expect(mentionsId("europepmc.org/article/CBA/633654", "CBA:633654")).toBe(true);
    expect(mentionsId("chinaxiv 202304.00908", "chinaxiv-202304.00908")).toBe(true);
    expect(mentionsId("PPR13053701 and 21305370", "PPR1305370")).toBe(false);
    expect(mentionsId("a cohort of 1,305,370 people", "PPR1305370")).toBe(false);
  });

  it("finds the authors an author list can be written with", () => {
    expect(surnames(["Smith JA", "Del Coso J", "LI Jianwei", "Jarašiūnaite-Fedosejeva G"])).toEqual(["Smith", "Del", "Del Coso", "LI", "Jarašiūnaite-Fedosejeva"]);
    expect(namedAuthors("The trial by Smith and colleagues tested exercise.", ["Smith JA", "Jones B"])).toEqual(["Smith"]);
    expect(namedAuthors("A trial of exercise.", ["Smith JA", "Jones B"])).toEqual([]);
    expect(namedAuthors("The group of Muñoz-García studied it", ["Munoz-Garcia A"])).toEqual(["Munoz-Garcia"]);
    // A short surname is also a word: only "Li et al", "Li's" or "by Li" count.
    expect(namedAuthors("An open trial in adults, with a list of outcomes.", ["An J", "Li Y"])).toEqual([]);
    expect(namedAuthors("The 2026 trial by Li randomized adults.", ["Li Y"])).toEqual(["Li"]);
    expect(namedAuthors("Li et al randomized adults.", ["Li Y"])).toEqual(["Li"]);
    // A long surname that is also a word is a false positive the writer has to rephrase around.
    expect(namedAuthors("Young adults were randomized.", ["Young K"])).toEqual(["Young"]);
  });
});

describe("validateAgainstCandidate", () => {
  const text: CandidateText = { id: "PPR1305370", title: "Exercise in frailty", authors: ["Nakamura T", "Okafor B"], abstract: PPR_ABSTRACT };
  it("accepts a quote that is in the title or abstract, whatever the whitespace and dashes", () => {
    expect(validateAgainstCandidate(preprint(), text)).toEqual([]);
    expect(validateAgainstCandidate(withSource(preprint(), { quote: "60 patients were\n  randomized to supervised exercise or usual care." }), text)).toEqual([]);
  });

  it("rejects a quote that is not there, an author in the question, and an unfetched candidate", () => {
    expect(validateAgainstCandidate(withSource(preprint(), { quote: "60 patients were randomized to home exercise or usual care. … 14 of 30 patients in the exercise group had an event." }), text).join()).toContain("not in the candidate's title or abstract");
    expect(validateAgainstCandidate(preprint({ prompt: preprint().prompt.replace("frail older adults", "frail older adults, as Nakamura reported") }), text).join()).toContain("names an author: Nakamura");
    expect(validateAgainstCandidate(preprint(), { ...text, title: "(not found)" }).join()).toContain("could not be fetched");
  });

  it("checks a full-text quote against the full text, and its figure against the abstract", () => {
    const record: CandidateText = {
      pmid: "34728476",
      title: "Text messages for smoking cessation",
      authors: ["Ford M"],
      abstract: FT_ABSTRACT,
      fulltext: "# Results\n\nThe median follow-up was 18 months in\nthe programme arm. In the other arm it was 12 months.",
    };
    expect(validateAgainstCandidate(fulltext(), record)).toEqual([]);
    expect(validateAgainstCandidate(withSource(fulltext(), { fullTextQuote: "The median follow-up was 20 months." }), record).join()).toContain("not in the candidate's full text");
    expect(validateAgainstCandidate(fulltext(), { ...record, fulltext: undefined, fulltextNote: "no full text available" }).join()).toContain("has no full text");
    expect(validateAgainstCandidate(fulltext(), { ...record, abstract: `${FT_ABSTRACT} Follow-up was 18 months.` }).join()).toContain("also a number in the candidate's title or abstract");
  });
});

// ─── The merge, on a synthetic sample file ────────────────────────────────────────────────

const dir = mkdtempSync(join(tmpdir(), "merge-heldout-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

function stratum(frame: DrawnStratum["frame"], part: string, database: DrawnStratum["database"], ids: string[], extra: Partial<DrawnStratum> = {}): DrawnStratum {
  return {
    frame,
    part,
    database,
    query: `${frame}-${part} search`,
    matched: 100,
    candidates: ids.map((id) => (database === "pubmed" ? { pmid: id } : { id })),
    ...extra,
  };
}

const synthetic = (): SampleFile => ({
  version: 2,
  history: HISTORY,
  seed: SEED,
  drawn_at: "2026-11-10",
  recent_window: RECENT_WINDOW,
  established_years: ESTABLISHED_YEARS,
  established_journals: ESTABLISHED_JOURNALS,
  preprint_window: PREPRINT_WINDOW,
  fulltext_years: FULLTEXT_YEARS,
  strata: [
    {
      frame: "lookup",
      specialty: "cardiology",
      period: "recent",
      database: "pubmed",
      query: "lookup search",
      matched: 10,
      candidates: [{ pmid: "1", used: "t-lookup-01" }, { pmid: "2", retired: "t-lookup-02" }],
    },
    stratum("preprint", "europepmc", "europepmc", ["PPR1305370", "PPR1282579", "PPR1261422", "PPR1238912", "PPR1264846"]),
    stratum("regional", "cba", "europepmc", ["CBA:633654", "CBA:618117", "CBA:535012"]),
    stratum("regional", "chinaxiv", "chinaxiv", ["chinaxiv-202304.00908", "chinaxiv-202211.00264"]),
    stratum("fulltext", "bmj", "pubmed", ["34728476", "36328372", "34983775"]),
  ],
});

const candText = (id: string, over: Partial<CandidateText> = {}): CandidateText => ({ id, title: `Record ${id}`, authors: ["Nakamura T"], abstract: PPR_ABSTRACT, ...over });

/** A working directory with a sample file, a data file with markers, a candidate directory and an items directory. */
function workspace(name: string): { samplePath: string; dataPath: string; items: string; cand: string; write: (stratumName: string, file: unknown, where?: "items" | "cand") => void } {
  const root = join(dir, name);
  const items = join(root, "items");
  const cand = join(root, "cand");
  mkdirSync(items, { recursive: true });
  mkdirSync(cand, { recursive: true });
  const samplePath = join(root, "heldout.sample.json");
  const dataPath = join(root, "queries.heldout.data.ts");
  const sample = synthetic();
  writeFileSync(samplePath, `${JSON.stringify(sample, null, 2)}\n`);
  writeFileSync(dataPath, `export const HELDOUT_QUERIES = [\n  { id: "t-lookup-01" },\n\n  ${BEGIN_MARK}\n  ${END_MARK}\n];\n`);
  for (const s of sample.strata.filter((x) => x.frame !== "lookup")) {
    const texts = s.candidates.map((c) => {
      const id = (c.pmid ?? c.id)!;
      if (s.frame === "fulltext") return candText(id, { pmid: id, id, abstract: FT_ABSTRACT, fulltext: "The median follow-up was 18 months in the programme arm." });
      return candText(id);
    });
    writeFileSync(join(cand, stratumFile(`${s.frame}/${s.part}`)), JSON.stringify(texts));
  }
  return {
    samplePath,
    dataPath,
    items,
    cand,
    write: (stratumName, file, where = "items") => writeFileSync(join(where === "items" ? items : cand, stratumFile(stratumName)), JSON.stringify(file)),
  };
}

const staged = (stratum: string, dispositions: StagedFile["dispositions"]): StagedFile => ({ stratum, dispositions });
const skip = (id: string, reason = "not-primary", note = "a protocol, no results"): StagedFile["dispositions"][number] => ({ id, skipped: reason as "not-primary", note });

describe("assigning ids", () => {
  it("numbers each category through its strata in the sample's order, and draw order within a stratum", () => {
    const sample = synthetic();
    const files = new Map<string, StagedFile>([
      ["preprint/europepmc", staged("preprint/europepmc", [skip("PPR1305370"), { id: "PPR1282579", used: preprint({}, "PPR1282579") }, { id: "PPR1261422", used: preprint({}, "PPR1261422") }])],
      ["regional/cba", staged("regional/cba", [{ id: "CBA:633654", used: preprint({ category: "regional" }, "CBA:633654") }])],
      ["regional/chinaxiv", staged("regional/chinaxiv", [{ id: "chinaxiv-202304.00908", used: withSource(preprint({ category: "regional" }), { database: "chinaxiv", id: "chinaxiv-202304.00908" }) }])],
    ]);
    const { queries, strata } = assignIds(sample.strata, files);
    expect(queries.map((q) => [q.id, q.answerKey.source.id])).toEqual([
      ["t-preprint-01", "PPR1282579"],
      ["t-preprint-02", "PPR1261422"],
      ["t-regional-01", "CBA:633654"],
      ["t-regional-02", "chinaxiv-202304.00908"],
    ]);
    const pre = strata.find((s) => s.part === "europepmc")!;
    expect(pre.candidates.map((c) => c.used ?? c.skipped ?? "-")).toEqual(["not-primary", "t-preprint-01", "t-preprint-02", "-", "-"]);
    expect(pre.candidates[0]).toEqual({ id: "PPR1305370", skipped: "not-primary", note: "a protocol, no results" });
    // Strata without a staged file (and lookups) are as they were.
    expect(strata.find((s) => s.frame === "lookup")).toEqual(sample.strata[0]);
    expect(strata.find((s) => s.part === "bmj")).toEqual(sample.strata.find((s) => s.part === "bmj"));
  });
});

describe("validateStaged", () => {
  const s = synthetic().strata[1]!;
  const texts = new Map(s.candidates.map((c) => [c.id!, candText(c.id!)] as const));
  const check = (dispositions: unknown[], stratumName = "preprint/europepmc") => validateStaged({ stratum: stratumName, dispositions }, s, texts).join(" | ");

  it("accepts dispositions that are a prefix of the candidates, in order", () => {
    expect(check([])).toBe("");
    expect(check([skip("PPR1305370"), { id: "PPR1282579", used: preprint({}, "PPR1282579") }])).toBe("");
  });

  it("rejects skipping ahead, a wrong id, too many dispositions, and a wrong stratum", () => {
    expect(check([{ id: "PPR1282579", used: preprint({}, "PPR1282579") }])).toContain("must be a prefix of the stored candidates in draw order; candidate #1 is PPR1305370");
    expect(check([skip("PPR1305370"), skip("PPR9999999")])).toContain("candidate #2 is PPR1282579");
    expect(check(s.candidates.map((c) => skip(c.id!)).concat(skip("PPR1")))).toContain("6 dispositions for 5 stored candidates");
    expect(check([], "preprint/other")).toContain('"stratum" must be "preprint/europepmc"');
    expect(validateStaged({ stratum: "preprint/europepmc" }, s, texts).join()).toContain('"dispositions" must be an array');
  });

  it("holds a skip to a reason that applies to the frame, with a note", () => {
    expect(check([skip("PPR1305370", "no-fulltext")])).toContain('"no-fulltext" does not apply to a preprint stratum');
    expect(check([skip("PPR1305370", "in-pubmed", "short")])).toContain("needs a note");
    expect(check([skip("PPR1305370", "in-pubmed", "published as PMID 1 with the same figures")])).toBe("");
    expect(check([{ id: "PPR1305370", skipped: "not-primary", note: "a protocol, no results", used: preprint() }])).toContain('exactly one of "used" and "skipped"');
    expect(check([{ id: "PPR1305370" }])).toContain('exactly one of "used" and "skipped"');
  });

  it("checks a query against its record's text, and reports a missing candidate text", () => {
    const elsewhere = withSource(preprint(), { quote: "60 patients were randomized to home exercise or usual care. … 14 of 30 patients in the exercise group had an event." });
    expect(check([{ id: "PPR1305370", used: elsewhere }])).toContain("not in the candidate's title or abstract");
    expect(validateStaged({ stratum: "preprint/europepmc", dispositions: [{ id: "PPR1305370", used: preprint() }] }, s, new Map()).join()).toContain("no candidate text for PPR1305370");
  });

  it("allows no disposition after the stratum's quota, and no more than the quota of queries", () => {
    const tiny: DrawnStratum = { ...synthetic().strata[3]!, candidates: [{ id: "chinaxiv-202304.00908" }, { id: "chinaxiv-202211.00264" }] };
    const text = new Map(tiny.candidates.map((c) => [c.id!, candText(c.id!)] as const));
    const queryFor = (id: string) => withSource(preprint({ category: "regional" }), { database: "chinaxiv", id });
    // Quota of a regional stratum is 8: two queries are fine, a ninth would not be.
    const two = [{ id: "chinaxiv-202304.00908", used: queryFor("chinaxiv-202304.00908") }, { id: "chinaxiv-202211.00264", used: queryFor("chinaxiv-202211.00264") }];
    expect(validateStaged({ stratum: "regional/chinaxiv", dispositions: two }, tiny, text)).toEqual([]);
    const many: DrawnStratum = { ...tiny, candidates: Array.from({ length: 9 }, (_, i) => ({ id: `chinaxiv-202304.${String(i + 1).padStart(5, "0")}` })) };
    const manyTexts = new Map(many.candidates.map((c) => [c.id!, candText(c.id!)] as const));
    const nine = many.candidates.map((c) => ({ id: c.id!, used: queryFor(c.id!) }));
    expect(validateStaged({ stratum: "regional/chinaxiv", dispositions: nine }, many, manyTexts).join()).toContain("the quota of 8 queries was met before this candidate");
  });
});

describe("writing the merged files", () => {
  const query = (id: string) => preprint({}, id);
  const itemsFor = (w: ReturnType<typeof workspace>) => {
    w.write("preprint/europepmc", staged("preprint/europepmc", [skip("PPR1305370"), { id: "PPR1282579", used: query("PPR1282579") }, { id: "PPR1261422", used: query("PPR1261422") }]));
    w.write("regional/cba", staged("regional/cba", [{ id: "CBA:633654", used: preprint({ category: "regional" }, "CBA:633654") }]));
    w.write("fulltext/bmj", staged("fulltext/bmj", [skip("34728476", "no-fulltext-figure", "the full text states no figure the abstract lacks"), { id: "36328372", used: withSource(fulltext(), { id: "36328372" }) as StagedQuery }]));
  };
  // The fulltext fixture's PMID differs from the candidate's: the second one names its own record.
  const fix = (w: ReturnType<typeof workspace>) => {
    itemsFor(w);
    w.write("fulltext/bmj", staged("fulltext/bmj", [skip("34728476", "no-fulltext-figure", "the full text states no figure the abstract lacks"), { id: "36328372", used: { ...withKey(fulltext(), { expected: ["pmid: 36328372", "randomized: 1200", "follow-up months: 18"] }), answerKey: { ...fulltext().answerKey, expected: ["pmid: 36328372", "randomized: 1200", "follow-up months: 18"], source: { ...fulltext().answerKey.source, id: "36328372" } } } }]));
  };

  it("validates, writes the dispositions and the queries, and says what is left to write", () => {
    const w = workspace("merge-1");
    fix(w);
    const result = mergeInto(w.items, w.cand, { samplePath: w.samplePath, dataPath: w.dataPath });
    expect(result.errors).toEqual([]);
    expect(result.queries.map((q) => q.id)).toEqual(["t-preprint-01", "t-preprint-02", "t-regional-01", "t-fulltext-01"]);
    const sample = readSample(w.samplePath);
    const pre = sample.strata.find((s) => s.part === "europepmc")!;
    expect(pre.candidates.map((c) => c.used ?? c.skipped ?? "-")).toEqual(["not-primary", "t-preprint-01", "t-preprint-02", "-", "-"]);
    expect(sample.strata.find((s) => s.part === "bmj")!.candidates.map((c) => c.used ?? c.skipped ?? "-")).toEqual(["no-fulltext-figure", "t-fulltext-01", "-"]);
    // The lookup stratum, with its retired lookup, is untouched.
    expect(sample.strata[0]!.candidates).toEqual([{ pmid: "1", used: "t-lookup-01" }, { pmid: "2", retired: "t-lookup-02" }]);
    expect(result.report.join("\n")).toContain("preprint/europepmc");
    expect(result.report.join("\n")).toContain("2/16 queries, 1 skipped; 14 to write, 2 candidates left");
    expect(result.report.join("\n")).toContain("regional/chinaxiv            no staged file");

    // The data file's region holds objects that are the staged queries with their ids.
    const data = readFileSync(w.dataPath, "utf-8");
    expect(data).toContain('{ id: "t-lookup-01" }');
    const region = data.slice(data.indexOf(BEGIN_MARK) + BEGIN_MARK.length, data.indexOf(END_MARK));
    const objects = new Function(`return [${region.replace(/^\s*\/\/.*$/gm, "")}]`)() as MergedQuery[];
    expect(objects.map((o) => o.id)).toEqual(["t-preprint-01", "t-preprint-02", "t-regional-01", "t-fulltext-01"]);
    expect(objects[0]).toEqual({ id: "t-preprint-01", ...query("PPR1282579") });
    expect(objects[3]!.answerKey.source.fullTextQuote).toBe("The median follow-up was 18 months in the programme arm.");
    expect("retrievalOnly" in objects[3]!).toBe(false);
    expect(region).toContain("// ─── preprint · europepmc ───");
  });

  it("can be run again: the same files give the same output, an edited file replaces what was written", () => {
    const w = workspace("merge-2");
    fix(w);
    mergeInto(w.items, w.cand, { samplePath: w.samplePath, dataPath: w.dataPath });
    const first = [readFileSync(w.samplePath, "utf-8"), readFileSync(w.dataPath, "utf-8")];
    mergeInto(w.items, w.cand, { samplePath: w.samplePath, dataPath: w.dataPath });
    expect([readFileSync(w.samplePath, "utf-8"), readFileSync(w.dataPath, "utf-8")]).toEqual(first);

    // The writer drops the second query: its id goes, and the ids after it shift.
    w.write("preprint/europepmc", staged("preprint/europepmc", [skip("PPR1305370"), skip("PPR1282579", "not-identifiable", "the same trial as PPR1305370"), { id: "PPR1261422", used: query("PPR1261422") }]));
    const again = mergeInto(w.items, w.cand, { samplePath: w.samplePath, dataPath: w.dataPath });
    expect(again.queries.map((q) => [q.id, q.answerKey.source.id])).toEqual([
      ["t-preprint-01", "PPR1261422"],
      ["t-regional-01", "CBA:633654"],
      ["t-fulltext-01", "36328372"],
    ]);
    const data = readFileSync(w.dataPath, "utf-8");
    expect(data).not.toContain("PPR1282579");
    expect(data.match(/BEGIN beyond-pubmed/g)).toHaveLength(1);
    expect(data).toContain('{ id: "t-lookup-01" }');
    expect(readSample(w.samplePath).strata.find((s) => s.part === "europepmc")!.candidates.map((c) => c.used ?? c.skipped ?? "-")).toEqual(["not-primary", "not-identifiable", "t-preprint-01", "-", "-"]);
  });

  it("writes nothing when any staged file is invalid, or on a dry run", () => {
    const w = workspace("merge-3");
    fix(w);
    const before = [readFileSync(w.samplePath, "utf-8"), readFileSync(w.dataPath, "utf-8")];
    mergeInto(w.items, w.cand, { samplePath: w.samplePath, dataPath: w.dataPath, dryRun: true });
    expect([readFileSync(w.samplePath, "utf-8"), readFileSync(w.dataPath, "utf-8")]).toEqual(before);

    w.write("regional/cba", staged("regional/cba", [{ id: "CBA:618117", used: preprint({ category: "regional" }, "CBA:618117") }]));
    const bad = mergeInto(w.items, w.cand, { samplePath: w.samplePath, dataPath: w.dataPath });
    expect(bad.errors.join()).toContain("prefix of the stored candidates");
    expect([readFileSync(w.samplePath, "utf-8"), readFileSync(w.dataPath, "utf-8")]).toEqual(before);
  });

  it("will not forget a stratum: dispositions in the sample file need their staged file", () => {
    const w = workspace("merge-4");
    fix(w);
    mergeInto(w.items, w.cand, { samplePath: w.samplePath, dataPath: w.dataPath });
    rmSync(join(w.items, stratumFile("regional/cba")));
    const result = plan(readSample(w.samplePath), w.items, w.cand);
    expect(result.errors.join()).toContain("regional/cba: the sample file has dispositions but");
  });

  it("reports a missing candidate file, and a candidate text that lacks a stored candidate", () => {
    const w = workspace("merge-5");
    fix(w);
    rmSync(join(w.cand, stratumFile("preprint/europepmc")));
    expect(plan(readSample(w.samplePath), w.items, w.cand).errors.join()).toContain("no candidate texts in");
    w.write("preprint/europepmc", [candText("PPR1305370")], "cand");
    expect(plan(readSample(w.samplePath), w.items, w.cand).errors.join()).toContain("the candidate file lacks PPR1282579");
  });

  it("refuses two queries with one prompt", () => {
    const w = workspace("merge-6");
    const shared = preprint({}, "PPR1305370").prompt;
    w.write("preprint/europepmc", staged("preprint/europepmc", [{ id: "PPR1305370", used: query("PPR1305370") }, { id: "PPR1282579", used: { ...query("PPR1282579"), prompt: shared } }]));
    expect(plan(readSample(w.samplePath), w.items, w.cand).errors.join()).toContain("t-preprint-02: the same prompt is used twice");
  });
});

describe("the data file's region", () => {
  const source = `export const X = [\n  { id: "a" },\n\n  ${BEGIN_MARK}\n  ${END_MARK}\n];\n`;
  const q = (id: string): MergedQuery => ({ id, stratum: "preprint/europepmc", ...preprint({}, `PPR${id.length}`) });

  it("is replaced, not appended to, and empty when there is nothing to put in it", () => {
    const one = replaceRegion(source, [q("t-preprint-01")]);
    expect(one).toContain('id: "t-preprint-01"');
    expect(replaceRegion(one, [q("t-preprint-01")])).toBe(one);
    expect(replaceRegion(one, [q("t-preprint-02")])).not.toContain("t-preprint-01");
    expect(replaceRegion(one, [])).toBe(source);
    expect(one.startsWith('export const X = [\n  { id: "a" },')).toBe(true);
    expect(one.endsWith("];\n")).toBe(true);
    expect(() => replaceRegion("export const X = [];\n", [])).toThrow(/markers/);
  });

  it("formats a query as an object literal in the data file's style", () => {
    const text = formatQuery(q("t-preprint-01"));
    expect(text).toContain('    id: "t-preprint-01",');
    expect(text).toContain('    topics: ["exercise", "frailty"],');
    expect(text).toContain("    prompt:\n      \"A 2026 preprint");
    expect(text).toContain("    retrievalOnly: true,\n    beyondPubmed: true,\n    verified: true,\n  },");
    expect(formatRegion([])).toBe(`  ${BEGIN_MARK}\n  ${END_MARK}`);
    expect(questionOf(preprint().prompt)).toBe("A 2026 preprint reports a randomized trial of supervised exercise against usual care in frail older adults. How many participants were randomized, and how many in the exercise arm had an event?");
  });
});
