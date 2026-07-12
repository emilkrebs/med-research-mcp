import { describe, it, expect } from "vitest";
import { gradeText, keywordGrade, SCORE_BY_TYPE } from "../src/core/grader";
import type { NcbiArticle } from "../src/core/types";

describe("gradeText — publication type primary signal", () => {
  it("trusts a Meta-Analysis publication type", () => {
    const g = gradeText("Creatine and cognition", "A meta-analysis of 20 randomized trials.", [
      "Meta-Analysis",
      "Journal Article",
    ]);
    expect(g.studyType).toBe("meta-analysis");
    expect(g.evidenceScore).toBe(5);
    // Corroborated by a keyword hit → very high confidence.
    expect(g.confidence).toBeGreaterThanOrEqual(0.9);
  });

  it("maps Systematic Review to meta-analysis tier", () => {
    const g = gradeText("Nootropics", "abstract", ["Systematic Review"]);
    expect(g.studyType).toBe("meta-analysis");
    expect(g.evidenceScore).toBe(5);
  });

  it("maps a Review publication type", () => {
    const g = gradeText("Overview", "A general overview.", ["Review"]);
    expect(g.studyType).toBe("review");
    expect(g.evidenceScore).toBe(3);
  });

  it("maps Observational Study to cohort even when the abstract mentions randomized trials", () => {
    // Real failure: an EHR cohort whose abstract compares itself to prior RCTs
    // ("shown to reduce weight in randomized clinical trials") was misgraded as
    // an RCT. The curated Observational Study tag must win.
    const g = gradeText(
      "Semaglutide vs Tirzepatide for Weight Loss",
      "Although these drugs were shown to reduce weight in randomized clinical trials, in this cohort study of propensity-matched adults...",
      ["Journal Article", "Observational Study", "Comparative Study"],
    );
    expect(g.studyType).toBe("cohort");
    expect(g.evidenceScore).toBe(3);
  });
});

describe("gradeText — keyword fallback and confidence formula", () => {
  it("classifies an RCT from keywords with capped confidence", () => {
    const g = gradeText(
      "Creatine and memory",
      "In this double-blind, placebo-controlled randomized trial, 40 participants were enrolled.",
      [],
    );
    expect(g.studyType).toBe("randomized-controlled-trial");
    expect(g.evidenceScore).toBe(4);
    // 3 positive hits → 0.2 + 1.2 = 1.4, capped at 1.
    expect(g.confidence).toBe(1);
  });

  it("applies positiveHits * 0.4 + 0.2 for a single hit", () => {
    const g = gradeText("A case report", "We present a case report of a rare reaction.", []);
    expect(g.studyType).toBe("case-report");
    expect(g.evidenceScore).toBe(1);
    expect(g.confidence).toBeCloseTo(0.6, 5);
  });

  it("routes systematic review to meta-analysis, not plain review", () => {
    const g = gradeText("Title", "We conducted a systematic review of trials.", []);
    expect(g.studyType).toBe("meta-analysis");
  });

  it("classifies a prospective cohort", () => {
    const g = gradeText("Diet study", "A prospective cohort study with 10-year follow-up.", []);
    expect(g.studyType).toBe("cohort");
    expect(g.evidenceScore).toBe(3);
  });

  it("returns unknown when nothing matches", () => {
    const g = gradeText("Some title", "An abstract with no study-design cues at all.", []);
    expect(g.studyType).toBe("unknown");
    expect(g.evidenceScore).toBe(0);
  });
});

describe("gradeText — known weaknesses are damped", () => {
  it("downgrades animal keywords when human terms are present", () => {
    const g = gradeText(
      "Translational work",
      "A murine model in mice informs treatment of human patients.",
      [],
    );
    expect(g.studyType).not.toBe("animal-study");
  });

  it("keeps animal-study when no human terms appear", () => {
    const g = gradeText("Obesity", "Effects in a murine model; mice were used.", []);
    expect(g.studyType).toBe("animal-study");
    expect(g.evidenceScore).toBe(0);
  });

  it("recognizes singular 'mouse' as an animal study", () => {
    // "mouse oocytes" was slipping through to unknown because only \bmice\b matched.
    const g = gradeText("Epitalon and aging", "Epitalon protects mouse oocytes in vitro.", []);
    expect(g.studyType).toBe("animal-study");
    expect(g.evidenceScore).toBe(0);
  });

  it("halves confidence and flags protocol papers", () => {
    const g = gradeText(
      "Study protocol for a randomized trial",
      "We will randomize 100 patients to two arms.",
      [],
    );
    expect(g.studyType).toBe("randomized-controlled-trial");
    // base 0.6 (one hit) halved by negative keywords → 0.3.
    expect(g.confidence).toBeLessThanOrEqual(0.3);
    expect(g.limitations?.some((l) => /protocol|future-tense/i.test(l))).toBe(true);
  });
});

describe("gradeText — extraction and title-only", () => {
  it("caps confidence and flags a title-only grade", () => {
    const g = gradeText("A randomized controlled trial of creatine", undefined, []);
    expect(g.studyType).toBe("randomized-controlled-trial");
    expect(g.confidence).toBeLessThanOrEqual(0.5);
    expect(g.limitations?.some((l) => /title only/i.test(l))).toBe(true);
  });

  it("extracts a dosage when present", () => {
    const g = gradeText("Dose study", "Participants took 5 g of creatine daily.", ["Review"]);
    expect(g.dosage).toMatch(/5\s?g/i);
  });
});

describe("keywordGrade — article integration", () => {
  it("merges grade fields and marks the method", () => {
    const article: NcbiArticle = {
      pmid: "123",
      title: "Creatine RCT",
      abstract: "A randomized controlled trial in adults.",
      authors: ["Doe J"],
      journal: "J Test",
      pubDate: "2021",
      publicationTypes: ["Randomized Controlled Trial"],
    };
    const graded = keywordGrade(article);
    expect(graded.pmid).toBe("123");
    expect(graded.studyType).toBe("randomized-controlled-trial");
    expect(graded.evidenceScore).toBe(SCORE_BY_TYPE["randomized-controlled-trial"]);
    expect(graded.gradingMethod).toBe("keyword");
  });
});
