/**
 * The held-out set (version 2): its queries are well-formed, and they were written from the
 * draw in `heldout.sample.json`, in order. (Whether each key matches its live
 * record is `npm run verify-keys`, which needs the network.)
 *
 * Version 2 keeps one lookup per PubMed stratum and adds three beyond-PubMed frames (`preprint`,
 * `regional`, `fulltext`). Until the query writers have delivered, those strata hold candidates and no
 * dispositions. The assertions that only make sense once a stratum has a disposition (its quota, the
 * totals) are skipped until then and show up as skipped tests: `quota ... (waiting)` per new stratum and
 * `totals of the beyond-PubMed frames (waiting)`.
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
  FRAMES,
  FRAME_RULES,
  KEEP_PER_STRATUM,
  MIN_QUERIES,
  QUOTA,
  SAMPLE_PATH,
  SAMPLE_VERSION,
  SEED,
  SKIP_APPLIES,
  SKIP_REASONS,
  SPECIALTIES,
  applyKeepRule,
  candidateId,
  compareIds,
  drawOrder,
  extensionCandidates,
  extensionRefusal,
  isWritten,
  queryPrefix,
  readSample,
  storedPrefix,
  strata,
  stratumName,
  stratumSeed,
  type Candidate,
  type DrawnStratum,
  type Frame,
} from "../scripts/sample-heldout.js";
import { CITE_RECORD, questionOf, validateQuery, validateSkip } from "../scripts/merge-heldout.js";
import { quoteParts } from "../scripts/verify-keys.js";
import type { BenchmarkQuery } from "../lib/types.js";

const heldOut = queriesOf("test");
const lookups = heldOut.filter((q) => q.category === "lookup");
const controls = heldOut.filter((q) => q.category === "control");
const fabricated = heldOut.filter((q) => q.category === "bullshit");
const beyond = heldOut.filter((q) => q.beyondPubmed);
const sample = readSample(SAMPLE_PATH);
const BEYOND_CATEGORIES = ["preprint", "regional", "fulltext"] as const;

const valuesKey = (q: BenchmarkQuery) => {
  if (q.answerKey.kind !== "values") throw new Error(`${q.id} is not a values query`);
  return q.answerKey;
};

const decided = (c: Candidate): boolean => c.used !== undefined || c.retired !== undefined || c.skipped !== undefined;
const started = (s: DrawnStratum): boolean => s.candidates.some(decided);
const catalogIds = new Set(heldOut.map((q) => q.id));

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

  it("sorts ids of every database numerically before it shuffles, whatever order they come in", () => {
    // PMIDs: the numeric order, as in version 1.
    expect(["30", "4", "200", "1000"].sort(compareIds)).toEqual(["4", "30", "200", "1000"]);
    const pmids = Array.from({ length: 50 }, (_, i) => String(1 + ((i * 7919) % 100003)));
    expect([...pmids].sort(compareIds)).toEqual([...pmids].sort((a, b) => Number(a) - Number(b)));
    // Europe PMC and ChinaXiv ids: group of digits by group of digits.
    expect(["PPR100", "PPR99", "PPR1000"].sort(compareIds)).toEqual(["PPR99", "PPR100", "PPR1000"]);
    expect(["CBA:633654", "CBA:99", "CBA:521529"].sort(compareIds)).toEqual(["CBA:99", "CBA:521529", "CBA:633654"]);
    expect(["chinaxiv-202608.00134", "chinaxiv-202608.00133", "chinaxiv-201712.00238"].sort(compareIds)).toEqual([
      "chinaxiv-201712.00238",
      "chinaxiv-202608.00133",
      "chinaxiv-202608.00134",
    ]);
    const ids = Array.from({ length: 80 }, (_, i) => `PPR${1200000 + i * 13}`);
    expect(drawOrder([...ids].reverse(), "preprint/europepmc")).toEqual(drawOrder(ids, "preprint/europepmc"));
  });

  const stratumOf = (frame: Frame, n: number, lookups: number, extra: Partial<DrawnStratum> = {}): DrawnStratum => ({
    frame,
    ...(frame === "lookup" ? { specialty: "obstetrics", period: "recent" as const } : { part: "europepmc" }),
    database: frame === "lookup" ? "pubmed" : "europepmc",
    query: "q",
    matched: 100,
    candidates: Array.from({ length: n }, (_, i) =>
      i < lookups ? { pmid: String(i), used: `${queryPrefix(frame)}${i}` } : { pmid: String(i), skipped: "not-primary" as const, note: "protocol only" },
    ),
    ...extra,
  });

  it("extends a stratum down the same order, and only when its candidates have run out", () => {
    const pmids = Array.from({ length: 60 }, (_, i) => String(42000000 + i * 3));
    const name = "obstetrics/recent";
    const order = drawOrder(pmids, name);
    const stored = order.slice(0, CANDIDATES_PER_STRATUM);
    // The next eight of the same order, with every stored record (of any stratum) removed.
    expect(extensionCandidates(pmids, name, stored)).toEqual(order.slice(CANDIDATES_PER_STRATUM, 2 * CANDIDATES_PER_STRATUM));
    expect(extensionCandidates(pmids, name, [...stored, order[8]!])).toEqual(order.slice(CANDIDATES_PER_STRATUM + 1, 2 * CANDIDATES_PER_STRATUM + 1));
    // A frame with more candidates per stratum appends that many.
    expect(extensionCandidates(pmids, name, stored, 16)).toEqual(order.slice(CANDIDATES_PER_STRATUM, CANDIDATES_PER_STRATUM + 16));
    // A short stratum yields what is left, however few.
    const short = pmids.slice(0, 10);
    expect(extensionCandidates(short, name, drawOrder(short, name).slice(0, CANDIDATES_PER_STRATUM))).toHaveLength(2);
    expect(storedPrefix(pmids, name, stored, []).prefix).toBe(true);
    // Membership drift reshuffles the whole stratum, so the stored records are rarely a prefix any more; the first difference is reported.
    const drifted = drawOrder([...pmids, "42999999"], name);
    const check = storedPrefix([...pmids, "42999999"], name, stored, []);
    const firstDifference = stored.findIndex((p, i) => drifted[i] !== p) + 1;
    expect(check).toEqual(firstDifference === 0 ? { prefix: true } : { prefix: false, firstDifference });
    // Records drawn for earlier strata are passed over, as at the draw.
    expect(storedPrefix(pmids, name, order.slice(1, CANDIDATES_PER_STRATUM + 1), [order[0]!]).prefix).toBe(true);

    const lookupStratum = (n: number, written: number): DrawnStratum => stratumOf("lookup", n, written);
    // The first extension is allowed while the stratum has fewer than QUOTA lookups ...
    expect(extensionRefusal(lookupStratum(CANDIDATES_PER_STRATUM, 1))).toBeUndefined();
    expect(extensionRefusal(lookupStratum(CANDIDATES_PER_STRATUM, MIN_QUERIES))).toBeUndefined();
    expect(extensionRefusal(lookupStratum(CANDIDATES_PER_STRATUM, QUOTA))).toMatch(/already has/);
    // ... a further one only while it has fewer than MIN_QUERIES.
    expect(MIN_QUERIES).toBe(2);
    const extendedOnce = (written: number): DrawnStratum => ({
      ...lookupStratum(2 * CANDIDATES_PER_STRATUM, written),
      extended: { at: "2026-11-10", matched: 29, added: CANDIDATES_PER_STRATUM },
    });
    expect(extensionRefusal(extendedOnce(MIN_QUERIES - 1))).toBeUndefined();
    expect(extensionRefusal(extendedOnce(MIN_QUERIES))).toMatch(/already extended/);
    expect(extensionRefusal(extendedOnce(QUOTA))).toMatch(/already has/);
    const open = lookupStratum(CANDIDATES_PER_STRATUM, 1);
    open.candidates.push({ pmid: "99" });
    expect(extensionRefusal(open)).toMatch(/no disposition/);
    // A lookup retired by the keep rule still counts as written: the version-1 draw is what the rule describes.
    const kept = lookupStratum(CANDIDATES_PER_STRATUM, 1);
    kept.candidates[1] = { pmid: "1", retired: "t-lookup-1" };
    kept.candidates[2] = { pmid: "2", retired: "t-lookup-2" };
    expect(extensionRefusal(kept)).toMatch(/already has 3 lookups/);

    // The other frames extend by their own count, down to their own quota.
    for (const frame of ["preprint", "regional", "fulltext"] as const) {
      const rule = FRAME_RULES[frame];
      expect(rule.candidates).toBe(16);
      expect(extensionRefusal(stratumOf(frame, rule.candidates, 0))).toBeUndefined();
      expect(extensionRefusal(stratumOf(frame, rule.candidates, rule.quota - 1))).toBeUndefined();
      expect(extensionRefusal(stratumOf(frame, rule.candidates, rule.quota))).toMatch(/already has/);
      const again = (written: number): DrawnStratum => ({ ...stratumOf(frame, 2 * rule.candidates, written), extended: { at: "2026-11-10", matched: 200, added: rule.candidates } });
      expect(extensionRefusal(again(rule.minQueries - 1))).toBeUndefined();
      expect(extensionRefusal(again(rule.minQueries))).toMatch(/already extended/);
    }
    expect([FRAME_RULES.preprint.quota, FRAME_RULES.regional.quota * 2, FRAME_RULES.fulltext.quota * 4]).toEqual([16, 16, 16]);
  });

  it("keeps the first lookup of a stratum in draw order and retires the rest, looking at nothing else", () => {
    expect(KEEP_PER_STRATUM).toBe(1);
    const make = (): DrawnStratum[] => [
      {
        ...stratumOf("lookup", 8, 0),
        candidates: [
          { pmid: "1", skipped: "not-primary", note: "a protocol, not a trial" },
          { pmid: "2", used: "t-lookup-07" },
          { pmid: "3", used: "t-lookup-08" },
          { pmid: "4", skipped: "no-numbers", note: "no figures to ask for" },
          { pmid: "5", used: "t-lookup-09" },
          { pmid: "6", used: "t-control-03" },
          { pmid: "7" },
        ],
      },
      { ...stratumOf("preprint", 3, 3) },
    ];
    const input = make();
    const result = applyKeepRule(input);
    expect(result).toEqual({ kept: ["t-lookup-07"], retired: ["t-lookup-08", "t-lookup-09"] });
    expect(input[0]!.candidates.map((c) => c.used ?? c.retired ?? c.skipped ?? "-")).toEqual(["not-primary", "t-lookup-07", "t-lookup-08", "no-numbers", "t-lookup-09", "t-control-03", "-"]);
    expect(input[0]!.candidates[1]).toEqual({ pmid: "2", used: "t-lookup-07" });
    expect(input[0]!.candidates[2]).toEqual({ pmid: "3", retired: "t-lookup-08" });
    // The control, the undecided candidate and the other frames are not touched.
    expect(input[0]!.candidates[5]).toEqual({ pmid: "6", used: "t-control-03" });
    expect(input[1]).toEqual(make()[1]);
    // Idempotent.
    const again = applyKeepRule(input);
    expect(again).toEqual(result);
    expect(applyKeepRule(input, 2).kept).toEqual(["t-lookup-07"]);
  });

  it("covers every specialty in both periods, and every beyond-PubMed stratum, with the searches the script builds today", () => {
    expect(sample.seed).toBe(SEED);
    expect(sample.version).toBe(SAMPLE_VERSION);
    expect(sample.strata.map(stratumName)).toEqual(strata().map(stratumName));
    expect(sample.strata.map((s) => s.query)).toEqual(strata().map((s) => s.query));
    expect(sample.strata.map((s) => s.database)).toEqual(strata().map((s) => s.database));
    expect(sample.strata.map((s) => s.filter)).toEqual(strata().map((s) => s.filter));
    expect(sample.strata.filter((s) => s.frame === "lookup")).toHaveLength(SPECIALTIES.length * 2);
    expect(sample.strata.map((s) => s.frame).filter((f, i, all) => all.indexOf(f) === i)).toEqual(FRAMES);
    expect(sample.strata.filter((s) => s.frame === "preprint")).toHaveLength(1);
    expect(sample.strata.filter((s) => s.frame === "regional").map(stratumName)).toEqual(["regional/cba", "regional/chinaxiv"]);
    expect(sample.strata.filter((s) => s.frame === "fulltext").map(stratumName)).toEqual([
      "fulltext/bmj",
      "fulltext/plos-medicine",
      "fulltext/jama-network-open",
      "fulltext/bmc-medicine",
    ]);
    for (const s of sample.strata) {
      const rule = FRAME_RULES[s.frame];
      expect(s.candidates.length, stratumName(s)).toBeLessThanOrEqual(rule.candidates + (s.extended?.added ?? 0));
      // A new stratum stores 16 candidates, a lookup stratum 8, unless the search matched fewer.
      expect(s.candidates.length, stratumName(s)).toBeGreaterThanOrEqual(Math.min(rule.candidates, s.matched));
      expect(s.matched, stratumName(s)).toBeGreaterThanOrEqual(s.candidates.length);
      // The id kind matches the database.
      for (const c of s.candidates) {
        expect(s.database === "pubmed" ? c.pmid : c.id, `${stratumName(s)} ${JSON.stringify(c)}`).toMatch(
          s.database === "pubmed" ? /^\d+$/ : s.database === "europepmc" ? /^(PPR\d+|CBA:\d+)$/ : /^chinaxiv-\d{6}\.\d{5}$/,
        );
      }
    }
    const all = sample.strata.flatMap((s) => s.candidates.map(candidateId));
    expect(new Set(all).size).toBe(all.length);
  });

  it("records its versions, and the second says why the set changed", () => {
    expect(SAMPLE_VERSION).toBe(2);
    expect(sample.history.map((h) => h.version)).toEqual([1, 2]);
    for (const h of sample.history) expect(h.date).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(sample.history[0]!.note).toContain("71 lookups");
    expect(sample.history[1]!.note).toContain("one lookup per stratum");
    expect(sample.history[1]!.note).toContain("ceiling");
    expect(sample.history[1]!.note).toContain("nothing in the server or the scorer was changed");
  });

  it("states a reason that applies to each frame, and defines every reason", () => {
    expect(Object.keys(SKIP_APPLIES).sort()).toEqual(Object.keys(SKIP_REASONS).sort());
    for (const [reason, text] of Object.entries(SKIP_REASONS)) expect(text.length, reason).toBeGreaterThan(30);
    for (const reason of ["in-pubmed", "no-fulltext-figure", "no-fulltext", "not-primary", "no-numbers", "not-identifiable"] as const) expect(SKIP_REASONS[reason]).toBeDefined();
    expect(validateSkip("preprint", "in-pubmed", "published as PMID 1, same figures")).toEqual([]);
    expect(validateSkip("fulltext", "in-pubmed", "published as PMID 1, same figures")[0]).toMatch(/does not apply/);
    expect(validateSkip("fulltext", "no-fulltext", "the function returns the abstract only")).toEqual([]);
    expect(validateSkip("lookup", "predates-window", "online 2026-07-02")).toEqual([]);
    expect(validateSkip("regional", "predates-window", "online 2026-07-02")[0]).toMatch(/does not apply/);
    expect(validateSkip("regional", "not-primary", "short")[0]).toMatch(/needs a note/);
    expect(validateSkip("regional", "because", "a long enough note")[0]).toMatch(/must be one of/);
  });
});

describe("queries were written from the draw, in order", () => {
  describe.each(sample.strata.map((s) => [stratumName(s), s] as const))("%s", (_name, s) => {
    const rule = FRAME_RULES[s.frame];

    it("has dispositions that form a prefix of its candidates, each a query, a retired lookup or a listed skip", () => {
      // Considered candidates form a prefix: nobody skipped ahead to a nicer trial.
      const considered = s.candidates.map(decided);
      const firstUnconsidered = considered.indexOf(false);
      if (firstUnconsidered >= 0) expect(considered.slice(firstUnconsidered).some(Boolean)).toBe(false);

      for (const c of s.candidates) {
        expect([c.used, c.retired, c.skipped].filter((x) => x !== undefined).length, candidateId(c)).toBeLessThanOrEqual(1);
        if (c.skipped !== undefined) {
          expect(Object.keys(SKIP_REASONS), candidateId(c)).toContain(c.skipped);
          expect(SKIP_APPLIES[c.skipped], `${candidateId(c)}: ${c.skipped} applies to ${s.frame}`).toContain(s.frame);
          expect((c.note ?? "").length, candidateId(c)).toBeGreaterThan(5);
        } else expect(c.note, candidateId(c)).toBeUndefined();
        // The predates-window reason is a recent-stratum one.
        if (c.skipped === "predates-window") expect(s.period).toBe("recent");
        // Only lookups are retired, and a candidate is a query of its own frame.
        if (c.retired !== undefined) expect(s.frame).toBe("lookup");
        const id = c.used ?? c.retired;
        if (id !== undefined && !(s.frame === "lookup" && id.startsWith("t-control-"))) expect(isWritten(c, s.frame), `${candidateId(c)} → ${id}`).toBe(true);
        expect(id === undefined || /^t-[a-z]+-\d{2}$/.test(id), id).toBe(true);
      }
      // The control (established strata) comes after the lookups in the draw.
      const control = s.candidates.findIndex((c) => c.used?.startsWith("t-control-"));
      if (s.frame !== "lookup" || s.period === "recent") expect(control).toBe(-1);
      else if (control >= 0) {
        const lastLookup = s.candidates.map((c) => isWritten(c, "lookup")).lastIndexOf(true);
        expect(control).toBeGreaterThan(lastLookup);
      }
    });

    it("was extended only because its original candidates ran out short of the quota", () => {
      if (!s.extended) return;
      const original = s.candidates.slice(0, rule.candidates);
      expect(original.every(decided), "the original candidates were all decided").toBe(true);
      expect(original.filter((c) => isWritten(c, s.frame)).length, "and gave fewer queries than the quota").toBeLessThan(rule.quota);
      expect(s.candidates.length, "extended.added is what was appended").toBe(rule.candidates + s.extended.added);
      expect(s.extended.added).toBeGreaterThan(0);
      expect(s.extended.at).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      expect(s.extended.matched).toBeGreaterThanOrEqual(s.candidates.length);
      // Extended more than once: before the latest extension (at most `candidates` of them) it had fewer than the minimum.
      if (s.extended.added > rule.candidates) {
        const before = s.candidates.slice(0, s.candidates.length - rule.candidates);
        expect(before.filter((c) => isWritten(c, s.frame)).length, "a further extension only below the minimum").toBeLessThan(rule.minQueries);
      }
    });

    // The quota, unless the stratum's candidates ran out first. A beyond-PubMed stratum is checked once it has a disposition.
    const waiting = s.frame !== "lookup" && !started(s);
    (waiting ? it.skip : it)(`reaches its quota of ${rule.quota} queries unless its candidates ran out${waiting ? " (waiting for the writers)" : ""}`, () => {
      const written = s.candidates.filter((c) => isWritten(c, s.frame));
      const firstUnconsidered = s.candidates.map(decided).indexOf(false);
      if (firstUnconsidered >= 0) expect(written).toHaveLength(rule.quota);
      else expect(written.length).toBeLessThanOrEqual(rule.quota);
      if (s.frame !== "lookup") expect(s.candidates.filter((c) => c.used !== undefined).length).toBe(written.length);
    });

    if (s.frame === "lookup") {
      it(`keeps ${KEEP_PER_STRATUM} lookup(s), the first in draw order, and retires the others under their old ids`, () => {
        const written = s.candidates.filter((c) => isWritten(c, "lookup"));
        expect(written.length, "version 1 wrote at least the minimum").toBeGreaterThanOrEqual(MIN_QUERIES);
        expect(written.filter((c) => c.used !== undefined)).toHaveLength(KEEP_PER_STRATUM);
        expect(written[0]!.used, "the first lookup in draw order is the one kept").toMatch(/^t-lookup-\d{2}$/);
        for (const c of written.slice(KEEP_PER_STRATUM)) {
          expect(c.used).toBeUndefined();
          expect(c.retired).toMatch(/^t-lookup-\d{2}$/);
          expect(catalogIds.has(c.retired!), `${c.retired} is not in the catalog`).toBe(false);
        }
      });
    }

    it("has queries whose record is its candidate", () => {
      for (const c of s.candidates.filter((x) => x.used)) {
        const q = heldOut.find((x) => x.id === c.used);
        expect(q, `${c.used} named in the sample`).toBeDefined();
        if (s.frame === "lookup") {
          expect(q!.specialty).toBe(s.specialty);
          const pmid = q!.answerKey.kind === "values" ? q!.answerKey.source?.id : q!.answerKey.kind === "accept" ? q!.answerKey.pmid : undefined;
          expect(pmid).toBe(c.pmid);
          if (q!.category === "lookup") expect(Boolean(q!.retrievalOnly)).toBe(s.period === "recent");
          expect(q!.beyondPubmed).toBeUndefined();
        } else {
          expect(q!.category).toBe(rule.category);
          expect(q!.beyondPubmed).toBe(true);
          expect(Boolean(q!.retrievalOnly)).toBe(rule.retrievalOnly);
          const key = valuesKey(q!);
          expect(key.source?.database).toBe(s.database);
          expect(key.source?.id).toBe(c.id ?? c.pmid);
          expect(key.source?.fullTextQuote !== undefined, `${q!.id} fulltext quote`).toBe(s.frame === "fulltext");
        }
      }
    });
  });

  it("every lookup, control and beyond-PubMed query is in the draw exactly once, and every retired id is in none", () => {
    const usedIds = sample.strata.flatMap((s) => s.candidates.flatMap((c) => (c.used ? [c.used] : [])));
    expect([...usedIds].sort()).toEqual([...lookups, ...controls, ...beyond].map((q) => q.id).sort());
    const retired = sample.strata.flatMap((s) => s.candidates.flatMap((c) => (c.retired ? [c.retired] : [])));
    expect(new Set(retired).size).toBe(retired.length);
    for (const id of retired) expect(heldOut.some((q) => q.id === id), id).toBe(false);
    // Version 1 wrote 71 lookups: the ones kept and the ones retired are exactly those, under their old ids.
    const kept = usedIds.filter((id) => id.startsWith("t-lookup-"));
    expect(kept).toHaveLength(SPECIALTIES.length * 2 * KEEP_PER_STRATUM);
    expect([...kept, ...retired].sort()).toEqual(Array.from({ length: 71 }, (_, i) => `t-lookup-${String(i + 1).padStart(2, "0")}`));
  });

  it("beyond-PubMed queries are numbered in stratum order, from 01", () => {
    for (const category of BEYOND_CATEGORIES) {
      const ids = sample.strata.flatMap((s) => s.candidates.flatMap((c) => (c.used?.startsWith(`t-${category}-`) ? [c.used] : [])));
      expect(ids).toEqual(ids.map((_, i) => `t-${category}-${String(i + 1).padStart(2, "0")}`));
    }
  });
});

describe("lookup queries", () => {
  it("there is one per stratum: every specialty, both periods", () => {
    expect(lookups).toHaveLength(SPECIALTIES.length * 2 * KEEP_PER_STRATUM);
    for (const { id } of SPECIALTIES) {
      const of = lookups.filter((q) => q.specialty === id);
      expect(of.filter((q) => q.retrievalOnly), `${id} recent`).toHaveLength(1);
      expect(of.filter((q) => !q.retrievalOnly), `${id} established`).toHaveLength(1);
    }
  });

  it.each(lookups.map((q) => [q.id, q] as const))("%s is well-formed", (_id, q) => {
    const key = valuesKey(q);
    expect(q.verified).toBe(true);
    expect(q.beyondPubmed).toBeUndefined();
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
    const asked = questionOf(q.prompt);
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

describe("beyond-PubMed queries (preprint, regional, fulltext)", () => {
  it("only these three categories are flagged beyondPubmed, and every query of them is", () => {
    for (const q of heldOut) {
      const isBeyondCategory = (BEYOND_CATEGORIES as readonly string[]).includes(q.category);
      expect(q.beyondPubmed === true, q.id).toBe(isBeyondCategory);
      if (!isBeyondCategory) expect(q.beyondPubmed, q.id).toBeUndefined();
    }
    for (const q of beyond) expect(q.id.startsWith(`t-${q.category}-`), q.id).toBe(true);
  });

  it.each(beyond.map((q) => [q.id, q] as const))("%s is well-formed", (_id, q) => {
    const s = sample.strata.find((x) => x.candidates.some((c) => c.used === q.id));
    expect(s, `${q.id} is in the draw`).toBeDefined();
    const key = valuesKey(q);
    expect(q.verified).toBe(true);
    expect(q.category).toBe(FRAME_RULES[s!.frame].category);
    expect(key.source?.database).toBe(s!.database);
    // The merge's own checks, on the merged query: format, fields, flags, source, numbers, nothing given away.
    const { id: _i, split: _s, answerKeyVersion: _v, ...rest } = q;
    // The data file leaves out `retrievalOnly: false`; the staged form states it.
    const staged = { ...rest, retrievalOnly: q.retrievalOnly ?? false };
    expect(validateQuery(staged, s!.frame, s!.database, key.source!.id)).toEqual([]);
    expect(q.topics?.length ?? 0).toBeGreaterThan(0);
    if (q.category === "fulltext") {
      expect(key.source!.database).toBe("pubmed");
      expect(key.expected[0]).toBe(`pmid: ${key.source!.id}`);
      expect(key.expected).toHaveLength(3);
      expect(key.source!.fullTextQuote!.length).toBeGreaterThan(20);
      // The figure of the full text is in its passage, and not in the abstract's quote.
      const figure = key.expected[2]!.split(":")[1]!.trim();
      expect(abstractNumbers(key.source!.fullTextQuote!).has(String(Math.abs(Number(figure))))).toBe(true);
      expect(abstractNumbers(key.source!.quote).has(String(Math.abs(Number(figure))))).toBe(false);
    } else {
      // Like a lookup (the PMID and two numbers): the record's id, exactly as the server prints it, and two numbers.
      expect(key.expected).toHaveLength(3);
      expect(key.expected[0]).toBe(`record: ${key.source!.id}`);
      expect(key.source!.database).toBe("europepmc" === s!.database ? "europepmc" : "chinaxiv");
      expect(key.source!.fullTextQuote).toBeUndefined();
      expect(q.prompt).toContain(CITE_RECORD);
      const format = q.prompt.split("\n").at(-1)!;
      expect(format).toMatch(/^`ANSWER — record: <id> \| .+: <(number|value|percent)> \| .+: <(number|value|percent)>`$/);
      expect([...parseAnswerFields(format).keys()]).toEqual(key.expected.map((e) => e.slice(0, e.indexOf(":"))));
      expect(q.prompt).not.toContain(key.source!.id);
    }
    if (q.category === "preprint") expect(key.source!.id).toMatch(/^PPR\d+$/);
    if (s!.part === "cba") expect(key.source!.id).toMatch(/^CBA:\d+$/);
    if (s!.part === "chinaxiv") expect(key.source!.id).toMatch(/^chinaxiv-\d{6}\.\d{5}$/);

    // A right answer scores 10, a wrong number loses its field.
    const names = key.expected.map((e) => e.slice(0, e.indexOf(":")));
    const right = key.expected.map((e) => e.slice(e.indexOf(":") + 1).trim());
    const answer = (values: string[]) => `Found it.\nANSWER — ${names.map((n, i) => `${n}: ${values[i]}`).join(" | ")}`;
    expect(scoreAccuracy(q, answer(right)).score).toBe(10);
    const wrong = [...right];
    wrong[right.length - 1] = "999999";
    expect(scoreAccuracy(q, answer(wrong)).score).toBeCloseTo(10 - 10 / right.length, 1);
    // The same numbers read from another record lose the id field (a third), for a non-PubMed record as for a PMID.
    const other = [...right];
    other[0] = q.category === "fulltext" ? "1" : "PPR1";
    expect(scoreAccuracy(q, answer(other)).score).toBeCloseTo(10 - 10 / right.length, 1);
    // The id is compared as text the way the server prints it; case, markdown and a final period do not matter.
    if (q.category !== "fulltext") {
      for (const form of [right[0]!.toLowerCase(), `**${right[0]}**`, `${right[0]}.`, `\`${right[0]}\``]) {
        expect(scoreAccuracy(q, answer([form, ...right.slice(1)])).score, form).toBe(10);
      }
    }
  });

  it("no beyond-PubMed record is in the development set or in PubMed's lookups", () => {
    const dev = new Set(queriesOf("dev").flatMap((q) => (q.answerKey.kind === "values" && q.answerKey.source ? [q.answerKey.source.id] : [])));
    for (const q of beyond) expect(dev.has(valuesKey(q).source!.id), q.id).toBe(false);
    const pubmedIds = new Set(sample.strata.filter((s) => s.frame === "lookup").flatMap((s) => s.candidates.map(candidateId)));
    for (const q of beyond) expect(pubmedIds.has(valuesKey(q).source!.id), q.id).toBe(false);
    expect(new Set(beyond.map((q) => valuesKey(q).source!.id)).size).toBe(beyond.length);
    expect(new Set(beyond.map((q) => q.prompt)).size).toBe(beyond.length);
  });

  const anyStarted = sample.strata.some((s) => s.frame !== "lookup" && started(s));
  (anyStarted ? it : it.skip)(`totals of the beyond-PubMed frames${anyStarted ? "" : " (waiting for the writers)"}`, () => {
    for (const frame of ["preprint", "regional", "fulltext"] as const) {
      const rule = FRAME_RULES[frame];
      const ofFrame = sample.strata.filter((s) => s.frame === frame);
      const used = ofFrame.reduce((n, s) => n + s.candidates.filter((c) => c.used !== undefined).length, 0);
      // The catalog holds what the sample says it holds, and no stratum holds more than its quota.
      expect(beyond.filter((q) => q.category === frame), frame).toHaveLength(used);
      for (const s of ofFrame) expect(s.candidates.filter((c) => c.used !== undefined).length, stratumName(s)).toBeLessThanOrEqual(rule.quota);
    }
    // Once every stratum has met its quota or ran out of candidates, the set is complete: 96 queries when every quota is met.
    const done = sample.strata.filter((s) => s.frame !== "lookup").every((s) => s.candidates.filter((c) => c.used !== undefined).length >= FRAME_RULES[s.frame].quota || s.candidates.every(decided));
    if (done) {
      const quotas = sample.strata.filter((s) => s.frame !== "lookup").reduce((n, s) => n + FRAME_RULES[s.frame].quota, 0);
      expect(quotas).toBe(48);
      expect(beyond.length).toBeLessThanOrEqual(quotas);
      expect(heldOut.length).toBeGreaterThanOrEqual(84);
      expect(QUERIES.filter((q) => q.answerKey.kind !== "rubric").length).toBeGreaterThanOrEqual(100);
    }
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

  it("every held-out query has ground truth, and the PubMed part of the set is 24 lookups with their 12 + 12 controls and fabricated twins", () => {
    expect(heldOut.every((q) => q.answerKey.kind !== "rubric")).toBe(true);
    expect(heldOut.every((q) => /^t-(lookup|control|bullshit|preprint|regional|fulltext)-\d{2}$/.test(q.id))).toBe(true);
    expect(lookups).toHaveLength(24);
    expect(controls).toHaveLength(12);
    expect(fabricated).toHaveLength(12);
    expect(heldOut.length).toBe(24 + 12 + 12 + beyond.length);
  });
});
