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

  it("maps Systematic Review to its own top-tier type", () => {
    const g = gradeText("Nootropics", "abstract", ["Systematic Review"]);
    expect(g.studyType).toBe("systematic-review");
    expect(g.evidenceScore).toBe(5);
  });

  it("scores a narrative Review with expert opinion, not with cohorts", () => {
    const g = gradeText("Overview", "A general overview.", ["Review"]);
    expect(g.studyType).toBe("review");
    expect(g.evidenceScore).toBe(1);
  });

  it("refines a pre-2019 'Review' tag to systematic review when the abstract says so", () => {
    const g = gradeText(
      "Vitamin D and falls: a systematic review",
      "We systematically searched MEDLINE and pooled 14 randomized trials in adults.",
      ["Journal Article", "Review"],
    );
    expect(g.studyType).toBe("systematic-review");
    expect(g.evidenceScore).toBe(5);
    expect(g.confidence).toBeCloseTo(0.8, 5);
  });

  it("prefers the most specific tag regardless of tag order", () => {
    const g = gradeText("X", "A systematic review and meta-analysis.", ["Review", "Systematic Review", "Meta-Analysis"]);
    expect(g.studyType).toBe("meta-analysis");
  });

  it("treats a veterinary RCT tag as an animal study", () => {
    const g = gradeText("Dogs", "Dogs were randomized to two diets.", ["Randomized Controlled Trial, Veterinary"]);
    expect(g.studyType).toBe("animal-study");
    expect(g.evidenceScore).toBe(0);
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

describe("gradeText — keyword fallback and confidence", () => {
  it("classifies an RCT from keywords with confidence capped below curated tags", () => {
    const g = gradeText(
      "Creatine and memory",
      "In this double-blind, placebo-controlled randomized trial, 40 participants were enrolled.",
      [],
    );
    expect(g.studyType).toBe("randomized-controlled-trial");
    expect(g.evidenceScore).toBe(4);
    expect(g.confidence).toBeCloseTo(0.8, 5);
  });

  it("gives a single weak cue low confidence", () => {
    const g = gradeText("Outcomes after surgery", "A retrospective analysis of outcomes.", []);
    expect(g.studyType).toBe("cohort");
    expect(g.confidence).toBeLessThan(0.5);
  });

  it("classifies a case report", () => {
    const g = gradeText("A case report", "We present a case report of a rare reaction.", []);
    expect(g.studyType).toBe("case-report");
    expect(g.evidenceScore).toBe(1);
  });

  it("routes systematic review to its own type, not plain review", () => {
    const g = gradeText("Title", "We conducted a systematic review of trials.", []);
    expect(g.studyType).toBe("systematic-review");
  });

  it("keeps a systematic review without pooling out of the meta-analysis type", () => {
    const g = gradeText("Title", "A systematic review; meta-analysis was not possible due to heterogeneity.", []);
    expect(g.studyType).toBe("systematic-review");
  });

  it("classifies a prospective cohort", () => {
    const g = gradeText("Diet study", "A prospective cohort study with 10-year follow-up.", []);
    expect(g.studyType).toBe("cohort");
    expect(g.evidenceScore).toBe(3);
  });

  it("classifies a cross-sectional study", () => {
    const g = gradeText("Vitamin D status", "This cross-sectional study used NHANES data from 5000 adults.", []);
    expect(g.studyType).toBe("cross-sectional");
    expect(g.evidenceScore).toBe(2);
  });

  it("returns unknown when nothing matches and says it is unclassified, not weak", () => {
    const g = gradeText("Some title", "An abstract with no study-design cues at all.", []);
    expect(g.studyType).toBe("unknown");
    expect(g.evidenceScore).toBe(0);
    expect(g.limitations?.some((l) => /unclassified/i.test(l))).toBe(true);
  });
});

describe("gradeText — no optimistic bias from other studies' designs", () => {
  it("honours 'non-randomized'", () => {
    const g = gradeText("Ketones and cognition", "In this non-randomized controlled trial, 30 adults received ketone esters.", []);
    expect(g.studyType).toBe("non-randomized-trial");
    expect(g.evidenceScore).toBe(3);
  });

  it("honours non-English negated randomization", () => {
    const g = gradeText("Estudo", "Ensaio clínico não randomizado com 40 pacientes.", [], "pt");
    expect(g.studyType).toBe("non-randomized-trial");
  });

  it("ignores 'further RCTs are needed' in a cohort abstract", () => {
    const g = gradeText(
      "Coffee and mortality",
      "We followed 10 000 adults in a prospective cohort. Coffee intake was associated with lower mortality. Further randomized controlled trials are needed.",
      [],
    );
    expect(g.studyType).toBe("cohort");
  });

  it("ignores meta-analyses cited in the background of an RCT", () => {
    const g = gradeText(
      "Magnesium and sleep",
      "Previous meta-analyses have shown mixed results. We randomly assigned 80 adults to magnesium or placebo.",
      [],
    );
    expect(g.studyType).toBe("randomized-controlled-trial");
  });

  it("does not read an institutional review board as a review", () => {
    const g = gradeText(
      "Sleep outcomes",
      "The institutional review board approved this prospective cohort study of 200 patients.",
      [],
    );
    expect(g.studyType).toBe("cohort");
  });

  it("classifies a narrative review of meta-analyses as a review", () => {
    const g = gradeText(
      "Creatine: a narrative review",
      "In this narrative review we summarize meta-analyses and RCTs on creatine.",
      [],
    );
    expect(g.studyType).toBe("review");
    expect(g.evidenceScore).toBe(1);
  });

  it("resolves equal keyword evidence to the lower tier", () => {
    // One weak cross-sectional cue ("survey") vs one weak cohort cue ("longitudinal").
    const g = gradeText("Diet", "A longitudinal survey of diet.", []);
    expect(g.studyType).toBe("cross-sectional");
  });

  it("keeps an Observational Study tag even when the abstract says randomized", () => {
    const g = gradeText("Secondary data", "Data came from a randomized controlled trial.", ["Observational Study"]);
    expect(g.studyType).toBe("cohort");
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

  it("classifies a randomized mouse experiment as an animal study", () => {
    const g = gradeText("NMN and endurance", "Mice were randomized to NMN or vehicle for 8 weeks.", []);
    expect(g.studyType).toBe("animal-study");
    expect(g.evidenceScore).toBe(0);
  });

  it("classifies work on human cell lines as in vitro", () => {
    const g = gradeText("Berberine", "Human hepatoma cell lines were treated with berberine in vitro.", []);
    expect(g.studyType).toBe("in-vitro");
  });

  it("does not treat 'topical' as Italian for mice", () => {
    const g = gradeText("Crema", "Applicazione topical di una crema.", [], "it");
    expect(g.studyType).not.toBe("animal-study");
  });
});

describe("gradeText — rating down (never up)", () => {
  it("zeroes a protocol and flags it", () => {
    const g = gradeText(
      "Study protocol for a randomized trial",
      "We will randomize 100 patients to two arms.",
      [],
    );
    expect(g.studyType).toBe("randomized-controlled-trial");
    expect(g.evidenceScore).toBe(0);
    expect(g.scoreAdjustments?.[0]?.reason).toMatch(/protocol/i);
    expect(g.confidence).toBeLessThanOrEqual(0.4);
    expect(g.limitations?.some((l) => /protocol|future-tense/i.test(l))).toBe(true);
  });

  it("does not treat 'the study protocol was approved' in a completed trial as a protocol", () => {
    const g = gradeText(
      "Zinc and colds",
      "The study protocol was approved by the ethics committee. Adults were randomly assigned to zinc or placebo.",
      ["Randomized Controlled Trial"],
    );
    expect(g.evidenceScore).toBe(4);
    expect(g.scoreAdjustments).toBeUndefined();
  });

  it("zeroes a retracted publication", () => {
    const g = gradeText("Creatine RCT", "A randomized trial.", ["Randomized Controlled Trial", "Retracted Publication"]);
    expect(g.evidenceScore).toBe(0);
    expect(g.scoreAdjustments?.[0]?.delta).toBe(-4);
  });

  it("zeroes editorials and comments", () => {
    const g = gradeText("On the new RCT", "This randomized trial is important.", ["Comment"]);
    expect(g.evidenceScore).toBe(0);
  });

  it("rates down a pilot trial by one step", () => {
    const g = gradeText("A pilot randomized controlled trial of ashwagandha", "Adults were randomly assigned.", []);
    expect(g.studyType).toBe("randomized-controlled-trial");
    expect(g.evidenceScore).toBe(3);
    expect(g.scoreAdjustments?.[0]?.reason).toMatch(/pilot/i);
  });

  it("does not rate down a full trial that merely cites an earlier pilot", () => {
    const g = gradeText("Ashwagandha and stress", "A previous pilot study informed this trial. Adults were randomly assigned.", []);
    expect(g.evidenceScore).toBe(4);
  });

  it("rates down a meta-analysis of observational studies only", () => {
    const g = gradeText(
      "Coffee and diabetes: a meta-analysis",
      "We pooled 30 prospective cohort studies including 1.1 million participants.",
      ["Meta-Analysis"],
    );
    expect(g.studyType).toBe("meta-analysis");
    expect(g.evidenceScore).toBe(4);
  });

  it("zeroes a meta-analysis of animal studies", () => {
    const g = gradeText("Rapamycin lifespan: a meta-analysis", "We pooled 29 studies in mice and rats.", ["Meta-Analysis"]);
    expect(g.evidenceScore).toBe(0);
  });

  it("never changes the score for a non-English source", () => {
    const en = gradeText("A randomized controlled trial", "Adults were randomly assigned.", []);
    const es = gradeText("Ensayo clínico aleatorizado", "Los pacientes fueron asignados de forma aleatorizada.", [], "es");
    expect(es.evidenceScore).toBe(en.evidenceScore);
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
  });
});
