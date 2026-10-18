import { describe, expect, it } from "vitest";
import {
  abstractNumbers,
  checkAttribution,
  claimedDesign,
  claimedNumbers,
  sentenceRanges,
} from "../lib/scoring/attribution.js";
import { valueMatches } from "../lib/scoring/accuracy.js";
import type { PmidFacts } from "../lib/scoring/verify.js";

const record = (over: Partial<PmidFacts> = {}): PmidFacts => ({
  pmid: "42765482",
  exists: true,
  designTier: 5,
  studyType: "meta-analysis",
  title: "Resistance training combined with creatine supplementation: a three-level meta-analysis",
  abstract: "Sixty-three studies (n = 1489) were included. Upper-body strength (g = 0.54, p < 0.001).",
  authors: ["Wang Y", "Wang Z", "Xin L"],
  pubYear: 2026,
  publicationTypes: ["Journal Article", "Meta-Analysis"],
  ...over,
});

const audit = (text: string, f: PmidFacts = record(), topics: string[] = ["creatine"]) =>
  checkAttribution(text, [f], [f.pmid], topics);

describe("checkAttribution", () => {
  it("passes a citation whose year, author, design and numbers match the record", () => {
    const r = audit("Wang et al. (2026) pooled 63 studies with 1,489 participants in a meta-analysis (PMID 42765482).");
    expect(r).toEqual({ checked: 1, misattributed: 0, issues: [] });
  });

  it("flags a real PMID that points at an unrelated paper", () => {
    const off = record({ title: "Coffee and mortality", abstract: "A cohort of 400,000 adults drank coffee." });
    const r = audit("Creatine improves strength (PMID 42765482).", off);
    expect(r.misattributed).toBe(1);
    expect(r.issues).toEqual([{ id: "42765482", check: "topic", claimed: "query topic: creatine", actual: "Coffee and mortality" }]);
  });

  it("flags a wrong year, a wrong author and a wrong design", () => {
    expect(audit("A 2019 meta-analysis found gains (PMID 42765482).").issues.map((i) => i.check)).toEqual(["year"]);
    expect(audit("Smith et al. reported larger gains (PMID 42765482).").issues.map((i) => i.check)).toEqual(["author"]);
    const rct = record({ studyType: "randomized-controlled-trial", publicationTypes: ["Randomized Controlled Trial"] });
    expect(audit("A large meta-analysis showed this (PMID 42765482).", rct).issues.map((i) => i.check)).toEqual(["design"]);
  });

  it("flags figures that appear nowhere in the abstract, but only when two or more are stated", () => {
    expect(audit("It gave 5 g/day for 12 weeks (PMID 42765482).").issues.map((i) => i.check)).toEqual(["numbers"]);
    expect(audit("It gave 5 g/day (PMID 42765482).").misattributed).toBe(0); // one figure: could be full-text only
    expect(audit("Across 63 studies over 8 weeks (PMID 42765482).").misattributed).toBe(0); // one of two found
  });

  it("stays silent when unsure", () => {
    // Two years, a year range, grouped citations, approximate figures, no abstract.
    expect(audit("Trials from 2010 and 2015 (PMID 42765482).").misattributed).toBe(0);
    expect(audit("Searches through 2025 (PMID 42765482).").misattributed).toBe(0);
    const two = checkAttribution("A 2019 RCT gave 5 g for 12 weeks (PMIDs 42765482, 11111111).", [record()], ["42765482", "11111111"], ["creatine"]);
    expect(two.misattributed).toBe(0);
    expect(audit("About 200 people for roughly 10 weeks (PMID 42765482).").misattributed).toBe(0);
    const { pubYear: _year, ...bare } = record({ abstract: "", title: "Coffee", authors: [] });
    expect(audit("Smith et al. 2019 (PMID 42765482).", bare)).toEqual({
      checked: 0,
      misattributed: 0,
      issues: [],
    });
  });

  it("pins each claim on its own citation when a sentence cites several papers", () => {
    const other = record({ pmid: "36615805", title: "Caffeine and creatine in runners", authors: ["Smith J"], pubYear: 2019, studyType: "randomized-controlled-trial", publicationTypes: [] });
    const r = checkAttribution(
      "Wang et al. 2026 pooled 63 studies (PMID 42765482), while Smith et al. 2019 ran an RCT (PMID 36615805).",
      [record(), other],
      ["42765482", "36615805"],
      ["creatine"],
    );
    expect(r).toEqual({ checked: 2, misattributed: 0, issues: [] });
  });

  it("reads a citation that opens its line from the text after it, and handles regional ids", () => {
    const cba = record({ pmid: "CBA:521529", title: "Yishen Zhuanggu Tongbi Decoction for rheumatoid arthritis", abstract: "Fortyfour cases were randomized; group A (n=24).", authors: ["Chen Zuhong"], pubYear: 2005, studyType: "randomized-controlled-trial", publicationTypes: [] });
    const ok = checkAttribution("- CBA:521529 — Chen et al. 2005 randomized 44 patients (24 treated).", [cba], ["CBA:521529"], ["rheumatoid"]);
    expect(ok).toEqual({ checked: 1, misattributed: 0, issues: [] });
    const bad = checkAttribution("- CBA:521529 — Li et al. 2012 randomized 120 patients for 12 weeks.", [cba], ["CBA:521529"], ["rheumatoid"]);
    expect(bad.issues.map((i) => i.check).sort()).toEqual(["author", "numbers", "year"]);
  });
});

describe("attribution helpers", () => {
  it("splits sentences but not at abbreviations or author initials", () => {
    const text = "Smith J. et al. found gains, e.g. in strength. A second trial agreed.";
    expect(sentenceRanges(text).map(([a, b]) => text.slice(a, b).trim())).toEqual([
      "Smith J. et al. found gains, e.g. in strength.",
      "A second trial agreed.",
    ]);
  });

  it("reads the design a clause claims", () => {
    expect(claimedDesign("a meta-analysis of randomized trials")).toBe("synthesis");
    expect(claimedDesign("a double-blind RCT")).toBe("rct");
    expect(claimedDesign("a non-randomized cohort")).toBe("observational");
    expect(claimedDesign("unlike RCTs, this cohort")).toBeUndefined();
  });

  it("extracts stated figures and spelled-out abstract numbers", () => {
    expect(claimedNumbers("300 mg/day for 8 weeks in n = 1,200 adults (HR 0.74), about 5%").sort()).toEqual(["0.74", "1200", "300", "8"]);
    const n = abstractNumbers("Sixty-three studies; Fortyfour cases; One hundred and one patients; hazard ratio −1.30; n = 1 489");
    for (const x of ["63", "44", "101", "1.3"]) expect(n.has(x)).toBe(true);
  });
});

describe("valueMatches", () => {
  it("compares purely numeric expected values as numbers", () => {
    expect(valueMatches("0.6", "0.60")).toBe(true);
    expect(valueMatches("1,489", "1489")).toBe(true);
    expect(valueMatches("37.3%", "37.3")).toBe(true);
    expect(valueMatches("-1.3 points", "-1.30")).toBe(true);
    expect(valueMatches("0.64", "0.6")).toBe(false);
    expect(valueMatches("no", "no")).toBe(true);
    expect(valueMatches("not sure", "no")).toBe(false);
  });
});

describe("clause attribution between citations", () => {
  const f = (pmid: string, over: Partial<PmidFacts>): PmidFacts => record({ pmid, ...over });

  it("gives a citation's own parenthetical to it, not to the next citation", () => {
    const a = f("37068054", { authors: ["Freeberg KA"], pubYear: 2023, title: "Dietary creatine and NAD", abstract: "creatine" });
    const b = f("35235774", { authors: ["Brakedal B"], pubYear: 2022, title: "Nicotinamide riboside and creatine in Parkinson", abstract: "creatine trial" });
    const r = checkAttribution(
      "This returned reviews (for example PMID 37068054, Freeberg et al. 2023, on NAD) and the NADPARK trial (PMID 35235774).",
      [a, b],
      [a.pmid, b.pmid],
      ["creatine"],
    );
    expect(r).toEqual({ checked: 2, misattributed: 0, issues: [] });
  });

  it("gives a trailing descriptor to the citation it follows", () => {
    const a = f("19445780", { pubYear: 2008 });
    const b = f("24780537", { pubYear: 2014 });
    const r = checkAttribution("Clinical Evidence (PMID 19445780 for 2008 and PMID 24780537 for 2014).", [a, b], [a.pmid, b.pmid], ["creatine"]);
    expect(r.misattributed).toBe(0);
  });

  it("keeps figures inside one citation's parentheses away from the next", () => {
    const a = f("41824889", { abstract: "creatine; 126 completers over 60 days" });
    const b = f("41815853", { abstract: "creatine; 141 adults for 8 weeks", authors: ["West S"] });
    const r = checkAttribution(
      "Examples include Thanawala et al. (PMID 41824889, n = 126 completers, 60 days) and West et al. (PMID 41815853, n = 141, 8 weeks).",
      [a, b],
      [a.pmid, b.pmid],
      ["creatine"],
    );
    expect(r.issues).toEqual([{ id: "41824889", check: "author", claimed: "Thanawala et al.", actual: "Wang Y, Wang Z, Xin L" }]);
  });

  it("reads 'Surname INITIALS et al.' as the surname", () => {
    expect(audit("Wilkinson MJ et al. reported this (PMID 42765482).").issues).toEqual([
      { id: "42765482", check: "author", claimed: "Wilkinson et al.", actual: "Wang Y, Wang Z, Xin L" },
    ]);
  });
});
