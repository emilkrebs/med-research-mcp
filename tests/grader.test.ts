import { describe, it, expect } from "vitest";
import { classifyArticle, classifyDesign, DESIGN_TIER, mergeDuplicate, rankKey } from "../src/core/grader";
import { STUDY_TYPES } from "../src/core/types";
import type { Correction, NcbiArticle } from "../src/core/types";

const pt = (...publicationTypes: string[]) => classifyDesign({ title: "", publicationTypes });

describe("classifyDesign — syntheses rank with what they pooled", () => {
  it("ranks a network meta-analysis 5: NLM defines it as a meta-analysis of randomized trials", () => {
    expect(pt("Network Meta-Analysis", "Systematic Review")).toMatchObject({ studyType: "meta-analysis", designTier: 5 });
  });

  it("leaves a meta-analysis unrated: its pooled designs are not indexed", () => {
    // Even with the RCT MeSH heading (absent on most RCT syntheses, so not used).
    const c = classifyDesign({
      title: "",
      publicationTypes: ["Meta-Analysis", "Systematic Review", "Journal Article"],
      meshHeadings: ["Humans", "Randomized Controlled Trials as Topic"],
    });
    expect(c).toMatchObject({ studyType: "meta-analysis", designTier: null, flags: [] });
  });

  it("leaves a systematic review unrated", () => {
    expect(pt("Systematic Review")).toMatchObject({ studyType: "systematic-review", designTier: null });
  });

  it("classifies a synthesis as such even when it carries the designs it pooled", () => {
    expect(pt("Review", "Systematic Review", "Meta-Analysis", "Randomized Controlled Trial").studyType).toBe("meta-analysis");
  });
});

describe("classifyDesign — primary designs from publication types", () => {
  it("ranks a randomized controlled trial 4", () => {
    expect(pt("Randomized Controlled Trial", "Journal Article")).toMatchObject({
      studyType: "randomized-controlled-trial",
      designTier: 4,
    });
  });

  it("matches tags case-insensitively", () => {
    expect(pt("randomized controlled trial").studyType).toBe("randomized-controlled-trial");
  });

  it("treats an equivalence trial as an RCT (it sits under RCT in the MeSH tree)", () => {
    expect(pt("Equivalence Trial").studyType).toBe("randomized-controlled-trial");
  });

  it("does not assume a pragmatic trial is randomized (MeSH 2026 moved it under Clinical Trial)", () => {
    expect(pt("Pragmatic Clinical Trial")).toMatchObject({ studyType: "clinical-trial", designTier: 2 });
    expect(pt("Pragmatic Clinical Trial", "Randomized Controlled Trial").studyType).toBe("randomized-controlled-trial");
  });

  it("ranks a controlled clinical trial 2: NLM's definition allows historical controls", () => {
    expect(pt("Controlled Clinical Trial")).toMatchObject({ studyType: "non-randomized-trial", designTier: 2 });
  });

  it("labels generic and phase trial tags clinical-trial: randomization and control are not indexed", () => {
    expect(pt("Clinical Trial")).toMatchObject({ studyType: "clinical-trial", designTier: 2 });
    expect(pt("Clinical Trial, Phase I").studyType).toBe("clinical-trial");
  });

  it("lets the most specific trial tag win over its MeSH-tree parents and phases", () => {
    expect(pt("Clinical Trial, Phase III", "Clinical Trial", "Randomized Controlled Trial").studyType).toBe(
      "randomized-controlled-trial",
    );
    expect(pt("Clinical Trial", "Controlled Clinical Trial").studyType).toBe("non-randomized-trial");
  });

  it("labels an Observational Study tag observational, ranked at its lower bound", () => {
    expect(pt("Observational Study")).toMatchObject({ studyType: "observational", designTier: 2 });
  });

  it("takes the lower design when trial and observational tags conflict", () => {
    // Mostly observational analyses of trial cohorts.
    expect(pt("Randomized Controlled Trial", "Observational Study").studyType).toBe("observational");
  });

  it("keeps a case report with a literature review a case report", () => {
    expect(pt("Case Reports", "Review")).toMatchObject({ studyType: "case-report", designTier: 1 });
  });

  it("ranks review articles 1: NLM's Review tag covers narrative and untagged systematic reviews alike", () => {
    expect(pt("Review")).toMatchObject({ studyType: "review", designTier: 1 });
    expect(pt("Scoping Review").studyType).toBe("review");
  });

  it("treats veterinary trial and observational tags as animal studies", () => {
    expect(pt("Randomized Controlled Trial, Veterinary")).toMatchObject({ studyType: "animal-study", designTier: 0 });
    expect(pt("Observational Study, Veterinary").studyType).toBe("animal-study");
  });
});

describe("classifyDesign — what it deliberately does not use", () => {
  it("does not read design from MeSH headings (NEJM coffee cohort, PMID 22591295, stays unknown)", () => {
    const c = classifyDesign({
      title: "Association of coffee drinking with total and cause-specific mortality",
      publicationTypes: ["Journal Article", "Research Support, N.I.H., Intramural"],
      meshHeadings: ["Aged", "Coffee", "Cohort Studies", "Follow-Up Studies", "Humans", "Male"],
    });
    expect(c).toMatchObject({ studyType: "unknown", designTier: null });
  });

  it("does not narrow an Observational Study tag with MeSH design headings", () => {
    const c = classifyDesign({ title: "", publicationTypes: ["Observational Study"], meshHeadings: ["Cohort Studies"] });
    expect(c.studyType).toBe("observational");
  });

  it("ignores design words in the title", () => {
    expect(classifyDesign({ title: "A randomized controlled trial of creatine", publicationTypes: ["Journal Article"] })).toMatchObject({
      studyType: "unknown",
      designTier: null,
    });
  });
});

describe("classifyDesign — integrity flags", () => {
  const title = (t: string, publicationTypes: string[] = []) => classifyDesign({ title: t, publicationTypes });
  const withLinks = (types: Correction["type"][], publicationTypes = ["Randomized Controlled Trial"]) =>
    classifyDesign({ title: "", publicationTypes, corrections: types.map((type) => ({ type, id: "1" })) });

  it("zeroes a retracted publication and keeps its design label", () => {
    expect(pt("Randomized Controlled Trial", "Retracted Publication")).toMatchObject({
      studyType: "randomized-controlled-trial",
      designTier: 0,
      flags: ["retracted"],
    });
  });

  it("zeroes a record linked to a retraction notice even without the tag", () => {
    expect(withLinks(["RetractionIn"])).toMatchObject({ designTier: 0, flags: ["retracted"] });
  });

  it("zeroes a publisher-marked retracted title, but not a retraction notice's title", () => {
    expect(title("RETRACTED: Creatine and cognition").flags).toEqual(["retracted"]);
    expect(title("[Retracted] Knockdown of lncRNA CCEPR suppresses colorectal cancer progression.").flags).toEqual(["retracted"]);
    // PMID 42183850 (Springer prefix), tagged only Journal Article + Review.
    expect(title("RETRACTED ARTICLE: Interventions for Clitoral Adhesions/Phimosis in Adult Women", ["Journal Article", "Review"]))
      .toMatchObject({ studyType: "review", designTier: 0, flags: ["retracted"] });
    expect(title("Retraction notice to: Creatine and cognition").flags).toEqual([]);
  });

  it("does not read a title that merely starts with the word 'retracted' as a retraction", () => {
    // PMID 42218886 and 42312980: neither is retracted.
    expect(title("Retracted evidence and emerging insights: an updated meta-analysis of probiotics supplementation", ["Meta-Analysis"]))
      .toMatchObject({ studyType: "meta-analysis", designTier: null, flags: [] });
    expect(title("Retracted publications in medical journals: a cross-sectional, cross-disciplinary analysis.").flags).toEqual([]);
  });

  it("flags a notice with a 'RETRACTED:' title as a notice only — the notice itself is not retracted", () => {
    // PMID 42886069 (MDPI retraction notice).
    expect(title("RETRACTED: Atta et al. Synthesis of Silver Nanoparticles by Green Method", ["Journal Article", "Retraction Notice"]))
      .toMatchObject({ designTier: 0, flags: ["notice"] });
  });

  it("zeroes notices: retraction notices (current and pre-2025 name), expressions of concern, errata", () => {
    for (const notice of ["Retraction Notice", "Retraction of Publication", "Expression of Concern", "Published Erratum"]) {
      expect(pt(notice, "Journal Article")).toMatchObject({ designTier: 0, flags: ["notice"] });
    }
  });

  it("zeroes a retracted record of unknown design rather than leaving it unrated", () => {
    expect(pt("Retracted Publication", "Journal Article")).toMatchObject({ studyType: "unknown", designTier: 0 });
  });

  it("zeroes trial protocols, editorials and comments", () => {
    expect(pt("Clinical Trial Protocol", "Randomized Controlled Trial")).toMatchObject({ designTier: 0, flags: ["protocol"] });
    expect(pt("Editorial").designTier).toBe(0);
    expect(pt("Comment", "Review").flags).toEqual(["editorial"]);
  });

  it("warns of an expression of concern, an erratum and a newer version without changing the tier", () => {
    expect(withLinks(["ExpressionOfConcernIn", "ErratumIn", "UpdateIn"])).toMatchObject({
      designTier: 4,
      flags: ["expression-of-concern", "corrected", "updated"],
    });
  });

  it("warns of animals-not-humans indexing but keeps the tier: automated indexing drops Humans from human trials", () => {
    const c = classifyDesign({ title: "", publicationTypes: ["Randomized Controlled Trial"], meshHeadings: ["Animals", "Rats"] });
    expect(c).toMatchObject({ studyType: "randomized-controlled-trial", designTier: 4, flags: ["animals-not-humans"] });
  });

  it("never labels a record an animal study from MeSH alone", () => {
    const c = classifyDesign({ title: "", publicationTypes: [], meshHeadings: ["Animals", "Mice"] });
    expect(c).toMatchObject({ studyType: "unknown", designTier: null, flags: ["animals-not-humans"] });
  });

  it("does not warn when Humans is indexed too, or when a veterinary tag already says animal", () => {
    expect(classifyDesign({ title: "", publicationTypes: ["Clinical Trial"], meshHeadings: ["Animals", "Humans"] }).flags).toEqual([]);
    expect(
      classifyDesign({ title: "", publicationTypes: ["Clinical Trial, Veterinary"], meshHeadings: ["Animals", "Dogs"] }).flags,
    ).toEqual([]);
  });

  it("notes preprints and letters without changing the tier", () => {
    expect(pt("Preprint")).toMatchObject({ designTier: null, flags: ["preprint"] });
    expect(pt("Letter", "Randomized Controlled Trial")).toMatchObject({ designTier: 4, flags: ["letter"] });
  });

  it("warns of machine-translated text and machine-written abstracts (ChinaRxiv records) without a tier", () => {
    const record = { title: "T", publicationTypes: [], machineTranslated: true, machineGeneratedAbstract: true };
    expect(classifyDesign(record)).toEqual({
      studyType: "unknown",
      designTier: null,
      flags: ["machine-translated", "machine-generated-abstract"],
    });
  });
});

describe("classifyDesign — no metadata", () => {
  it("returns unknown with a null tier, not a weak one", () => {
    expect(pt()).toEqual({ studyType: "unknown", designTier: null, flags: [] });
  });
});

describe("classifyArticle / rankKey / DESIGN_TIER", () => {
  const base: NcbiArticle = {
    pmid: "1",
    title: "Creatine and cognition",
    abstract: "A randomized controlled trial in 40 adults.",
    authors: ["Doe J"],
    journal: "J Test",
    pubDate: "2021",
    publicationTypes: ["Randomized Controlled Trial"],
  };

  it("adds the classification and keeps every article field", () => {
    const g = classifyArticle(base);
    expect(g).toMatchObject({ ...base, studyType: "randomized-controlled-trial", designTier: 4 });
    expect(g).not.toHaveProperty("flags");
  });

  it("includes flags only when some apply", () => {
    expect(classifyArticle({ ...base, publicationTypes: ["Preprint"] }).flags).toEqual(["preprint"]);
  });

  it("sorts known tiers 2–5 first, then unknown tiers, then tiers 1 and 0", () => {
    const rank = (publicationTypes: string[]) => rankKey(classifyArticle({ ...base, publicationTypes }));
    expect(rank(["Observational Study"])).toBeGreaterThan(rank(["Meta-Analysis"]));
    expect(rank(["Meta-Analysis"])).toBe(rank([]));
    expect(rank([])).toBeGreaterThan(rank(["Review"]));
    expect(rank(["Review"])).toBeGreaterThan(rank(["Retracted Publication"]));
  });

  describe("mergeDuplicate (two records of one paper)", () => {
    const rct = classifyArticle(base);
    const retracted = classifyArticle({ ...base, publicationTypes: ["Randomized Controlled Trial", "Retracted Publication"] });

    it("keeps the higher-ranked copy, the first on a tie", () => {
      const review = classifyArticle({ ...base, pmid: "2", publicationTypes: ["Review"] });
      expect(mergeDuplicate(review, rct)).toBe(rct);
      expect(mergeDuplicate(rct, { ...rct, pmid: "2" })).toBe(rct);
    });

    it("carries a retraction from either copy over to the kept one and zeroes its tier", () => {
      for (const merged of [mergeDuplicate(rct, retracted), mergeDuplicate(retracted, rct)]) {
        expect(merged).toMatchObject({ studyType: "randomized-controlled-trial", designTier: 0, flags: ["retracted"] });
      }
    });

    it("carries paper-level warnings without touching the tier", () => {
      const concern = classifyArticle({ ...base, corrections: [{ type: "ExpressionOfConcernIn" }, { type: "ErratumIn" }] });
      const unknown = classifyArticle({ ...base, pmid: "C1", publicationTypes: [] });
      expect(mergeDuplicate(unknown, concern)).toMatchObject({
        pmid: "1",
        designTier: 4,
        flags: ["expression-of-concern", "corrected"],
      });
    });

    it("does not carry record-level flags such as preprint", () => {
      const preprint = classifyArticle({ ...base, pmid: "P1", publicationTypes: ["Preprint"] });
      expect(mergeDuplicate(preprint, rct)).toBe(rct);
    });
  });

  it("orders STUDY_TYPES by tier, so 'first type in the list' means 'highest tier'", () => {
    const tiers = STUDY_TYPES.filter((t) => t !== "unknown").map((t) => DESIGN_TIER[t]);
    expect(tiers).toEqual([...tiers].sort((a, b) => b - a));
    for (const tier of tiers) expect(tier >= 0 && tier <= 5).toBe(true);
  });
});
