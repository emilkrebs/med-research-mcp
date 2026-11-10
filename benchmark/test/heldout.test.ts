/**
 * The held-out set: its queries are well-formed, and they were written from the
 * draw in `heldout.sample.json`, in order. (Whether each key matches its live
 * record is `npm run verify-keys`, which needs the network.)
 */

import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { QUERIES, queriesOf } from "../lib/queries.js";
import { abstractNumbers } from "../lib/scoring/attribution.js";
import { findAnswerLine, parseAnswerFields } from "../lib/scoring/accuracy.js";
import { scoreAccuracy } from "../lib/scoring/accuracy.js";
import { hasRejectionLanguage } from "../lib/scoring/bullshit.js";
import {
  CANDIDATES_PER_STRATUM,
  QUOTA,
  SAMPLE_PATH,
  SEED,
  SKIP_REASONS,
  SPECIALTIES,
  drawOrder,
  strata,
  stratumName,
  stratumSeed,
  type SampleFile,
} from "../scripts/sample-heldout.js";
import { quoteParts } from "../scripts/verify-keys.js";
import type { BenchmarkQuery } from "../lib/types.js";

const heldOut = queriesOf("test");
const lookups = heldOut.filter((q) => q.category === "lookup");
const controls = heldOut.filter((q) => q.category === "control");
const fabricated = heldOut.filter((q) => q.category === "bullshit");
const sample = JSON.parse(readFileSync(SAMPLE_PATH, "utf-8")) as SampleFile;

const valuesKey = (q: BenchmarkQuery) => {
  if (q.answerKey.kind !== "values") throw new Error(`${q.id} is not a values query`);
  return q.answerKey;
};

/** The question a prompt asks, without the appended answer-format instructions. */
const questionOf = (q: BenchmarkQuery): string => q.prompt.split(" Cite the PMID. Finish your reply")[0]!;

describe("the draw", () => {
  it("is a deterministic permutation that does not depend on the order PubMed returned", () => {
    const pmids = Array.from({ length: 200 }, (_, i) => String(30000000 + i * 7));
    const a = drawOrder(pmids, "cardiology/established");
    expect(drawOrder([...pmids].reverse(), "cardiology/established")).toEqual(a);
    expect([...a].sort()).toEqual([...pmids].sort());
    expect(a.slice(0, 20)).not.toEqual(pmids.slice(0, 20));
    // Each stratum, and each seed, has its own order.
    expect(drawOrder(pmids, "cardiology/recent")).not.toEqual(a);
    expect(drawOrder(pmids, "cardiology/established", SEED + 1)).not.toEqual(a);
    expect(stratumSeed("a")).not.toBe(stratumSeed("b"));
  });

  it("covers every specialty in both periods with the searches the script builds today", () => {
    expect(sample.seed).toBe(SEED);
    expect(sample.strata.map(stratumName)).toEqual(strata().map(stratumName));
    expect(sample.strata.map((s) => s.query)).toEqual(strata().map((s) => s.query));
    expect(sample.strata).toHaveLength(SPECIALTIES.length * 2);
    for (const s of sample.strata) {
      expect(s.candidates.length, stratumName(s)).toBeLessThanOrEqual(CANDIDATES_PER_STRATUM);
      expect(s.matched, stratumName(s)).toBeGreaterThanOrEqual(s.candidates.length);
    }
    const all = sample.strata.flatMap((s) => s.candidates.map((c) => c.pmid));
    expect(new Set(all).size).toBe(all.length);
  });
});

describe("queries were written from the draw, in order", () => {
  it.each(sample.strata.map((s) => [stratumName(s), s] as const))("%s", (_name, s) => {
    // Considered candidates form a prefix: nobody skipped ahead to a nicer trial.
    const considered = s.candidates.map((c) => c.used !== undefined || c.skipped !== undefined);
    const firstUnconsidered = considered.indexOf(false);
    if (firstUnconsidered >= 0) expect(considered.slice(firstUnconsidered).some(Boolean)).toBe(false);

    for (const c of s.candidates) {
      expect(c.used !== undefined && c.skipped !== undefined, c.pmid).toBe(false);
      if (c.skipped !== undefined) {
        expect(Object.keys(SKIP_REASONS), c.pmid).toContain(c.skipped);
        expect((c.note ?? "").length, c.pmid).toBeGreaterThan(5);
      }
    }
    const used = s.candidates.filter((c) => c.used?.startsWith("t-lookup-"));
    // The quota, unless the stratum's candidates ran out first.
    if (firstUnconsidered >= 0) expect(used).toHaveLength(QUOTA);
    else expect(used.length).toBeLessThanOrEqual(QUOTA);
    // The control (established strata) comes after the lookups in the draw.
    const control = s.candidates.findIndex((c) => c.used?.startsWith("t-control-"));
    if (s.period === "recent") expect(control).toBe(-1);
    else if (control >= 0) expect(control).toBeGreaterThan(s.candidates.findLastIndex((c) => c.used?.startsWith("t-lookup-")));

    for (const c of s.candidates.filter((x) => x.used)) {
      const q = heldOut.find((x) => x.id === c.used);
      expect(q, `${c.used} named in the sample`).toBeDefined();
      expect(q!.specialty).toBe(s.specialty);
      const pmid = q!.answerKey.kind === "values" ? q!.answerKey.source?.id : q!.answerKey.kind === "accept" ? q!.answerKey.pmid : undefined;
      expect(pmid).toBe(c.pmid);
      if (q!.category === "lookup") expect(Boolean(q!.retrievalOnly)).toBe(s.period === "recent");
    }
  });

  it("every lookup and control query is in the draw exactly once", () => {
    const usedIds = sample.strata.flatMap((s) => s.candidates.flatMap((c) => (c.used ? [c.used] : [])));
    expect([...usedIds].sort()).toEqual([...lookups, ...controls].map((q) => q.id).sort());
  });
});

describe("lookup queries", () => {
  it("there are enough of them, spread evenly over specialties and periods", () => {
    expect(lookups.length).toBeGreaterThanOrEqual(60);
    for (const { id } of SPECIALTIES) {
      const of = lookups.filter((q) => q.specialty === id);
      expect(of.filter((q) => q.retrievalOnly).length, `${id} recent`).toBeGreaterThanOrEqual(2);
      expect(of.filter((q) => !q.retrievalOnly).length, `${id} established`).toBeGreaterThanOrEqual(2);
    }
  });

  it.each(lookups.map((q) => [q.id, q] as const))("%s is well-formed", (_id, q) => {
    const key = valuesKey(q);
    expect(q.verified).toBe(true);
    expect(key.source?.database).toBe("pubmed");
    const pmid = key.source!.id;
    expect(key.expected[0]).toBe(`pmid: ${pmid}`);
    expect(key.expected).toHaveLength(3);
    expect(q.topics?.length ?? 0).toBeGreaterThan(0);

    // The prompt asks for exactly the expected fields, in order, and gives nothing away.
    const format = q.prompt.split("\n").at(-1)!;
    const names = key.expected.map((e) => e.slice(0, e.indexOf(":")));
    expect(format).toMatch(/^`ANSWER — PMID: <number> \| .+: <(number|value|percent)> \| .+: <(number|value|percent)>`$/);
    expect([...parseAnswerFields(format).keys()]).toEqual(names);
    expect(q.prompt).not.toContain(pmid);
    const asked = questionOf(q);
    expect(asked).not.toMatch(/PMID|doi/i);
    const quote = quoteParts(key.source!.quote).join(" ").replace(/[‐-―]/g, "-");
    const numbers = abstractNumbers(quote);
    for (const token of key.expected.slice(1)) {
      const value = token.slice(token.indexOf(":") + 1).trim();
      expect(value, token).toMatch(/^-?\d+(\.\d+)?$/);
      expect(numbers.has(String(Math.abs(Number(value)))), `${token} in the quote`).toBe(true);
      expect(new RegExp(`(?<![\\d.])${value.replace(/^-/, "").replace(".", "\\.")}(?![\\d]|\\.\\d)`).test(asked), `${token} given away by the question`).toBe(false);
    }

    // An answer in the requested format with the key's values scores 10; a wrong number loses its field.
    const answer = (values: string[]) => `Found it.\nANSWER — ${names.map((n, i) => `${n}: ${values[i]}`).join(" | ")}`;
    const right = key.expected.map((e) => e.slice(e.indexOf(":") + 1).trim());
    expect(findAnswerLine(answer(right))).toBeDefined();
    expect(scoreAccuracy(q, answer(right)).score).toBe(10);
    expect(scoreAccuracy(q, answer([right[0]!, right[1]!, "999999"])).score).toBeCloseTo(6.67, 2);
    expect(scoreAccuracy(q, answer(["1", right[1]!, right[2]!])).score).toBeCloseTo(6.67, 2);
  });
});

describe("fabricated studies and their controls", () => {
  it("come in pairs: one real and one fabricated study per specialty, asked in the same form", () => {
    expect(controls.length).toBeGreaterThanOrEqual(10);
    expect(fabricated).toHaveLength(controls.length);
    for (const control of controls) {
      const n = control.id.replace("t-control-", "");
      const twin = fabricated.find((q) => q.id === `t-bullshit-${n}`);
      expect(twin, control.id).toBeDefined();
      expect(twin!.specialty).toBe(control.specialty);
      // Same shape of request, so the form does not tell them apart.
      const shape = /^Summarize the \d{4} [\p{L}' -]+ trial of .+\.$/u;
      expect(control.prompt, control.id).toMatch(shape);
      expect(twin!.prompt, twin!.id).toMatch(shape);
      expect(Math.abs(control.prompt.length - twin!.prompt.length), control.id).toBeLessThan(80);
    }
  });

  it.each(controls.map((q) => [q.id, q] as const))("%s names its author and year and gives no PMID", (_id, q) => {
    expect(q.answerKey.kind).toBe("accept");
    if (q.answerKey.kind !== "accept") return;
    expect(q.prompt).toContain(String(q.answerKey.year));
    expect(q.prompt).toContain(q.answerKey.author);
    expect(q.prompt).not.toContain(q.answerKey.pmid);
    expect(q.prompt).not.toMatch(/\d{5,}/);
    expect(q.topics?.length ?? 0).toBeGreaterThan(0);
    expect(hasRejectionLanguage(q.prompt)).toBe(false);
  });

  it.each(fabricated.map((q) => [q.id, q] as const))("%s has a probe and no topics", (_id, q) => {
    expect(q.answerKey.kind).toBe("reject");
    if (q.answerKey.kind !== "reject") return;
    expect((q.answerKey.probe ?? "").length).toBeGreaterThan(10);
    expect(q.answerKey.probe).toMatch(/\[au\]/);
    expect(q.topics).toBeUndefined();
    expect(q.verified).toBe(true);
  });

  it("no fabricated author is a real control's author, and no two fabricated studies share one", () => {
    const real = new Set(controls.flatMap((q) => (q.answerKey.kind === "accept" ? [q.answerKey.author.toLowerCase()] : [])));
    const fake = fabricated.map((q) => /^Summarize the \d{4} ([\p{L}' -]+) trial of/u.exec(q.prompt)![1]!.toLowerCase());
    expect(new Set(fake).size).toBe(fake.length);
    for (const name of fake) expect(real.has(name), name).toBe(false);
  });
});

describe("the two sets", () => {
  it("share no record: nothing in the held-out set was a development query", () => {
    const ids = (qs: BenchmarkQuery[]): string[] =>
      qs.flatMap((q) => (q.answerKey.kind === "values" && q.answerKey.source ? [q.answerKey.source.id] : q.answerKey.kind === "accept" ? [q.answerKey.pmid] : []));
    const dev = new Set(ids(queriesOf("dev")));
    for (const id of ids(heldOut)) expect(dev.has(id), id).toBe(false);
    expect(new Set(ids(heldOut)).size).toBe(ids(heldOut).length);
  });

  it("every held-out query has ground truth, and together the keyed queries pass a hundred", () => {
    expect(heldOut.every((q) => q.answerKey.kind !== "rubric")).toBe(true);
    expect(heldOut.every((q) => /^t-(lookup|control|bullshit)-\d{2}$/.test(q.id))).toBe(true);
    expect(heldOut.length).toBeGreaterThanOrEqual(84);
    expect(QUERIES.filter((q) => q.answerKey.kind !== "rubric").length).toBeGreaterThanOrEqual(100);
  });
});
