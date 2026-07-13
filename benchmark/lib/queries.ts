/**
 * The 24-query benchmark set: 6 categories, matching the spec's counts.
 *
 * On `verified`: it is `true` only when the answer key is trustworthy without a
 * human first checking it against reality —
 *   - the four bullshit queries (the studies are fabricated *by us*, so "does
 *     not exist" is ground truth), and
 *   - the evidence-score lookups (ground truth is recomputed at scoring time by
 *     grading the PMID with the library's own grader — self-consistent).
 * Every rubric/values key that asserts a real-world biomedical fact is
 * `verified: false`: the query and its rubric run and score, but the harness
 * refuses to treat them as publishable until a human confirms them (see
 * `--publish`). Fill in / review the `false` ones before quoting results.
 */

import type { BenchmarkQuery } from "./types.js";

export const QUERIES: BenchmarkQuery[] = [
  // ─── Factual lookup (4) ───────────────────────────────────────────
  {
    id: "factual-01",
    category: "factual",
    prompt:
      "What evidence score (0–5) and study type would an evidence-grading tool assign to PMID 36615805? Give the number and the study type.",
    answerKey: { kind: "evidence-score", pmid: "36615805" },
    verified: true,
  },
  {
    id: "factual-02",
    category: "factual",
    prompt:
      "For PMID 33782057, state the study type (e.g. meta-analysis, randomized controlled trial, cohort) and a 0–5 evidence score reflecting that design.",
    answerKey: { kind: "evidence-score", pmid: "33782057" },
    verified: false, // confirm PMID 33782057 resolves before publishing
  },
  {
    id: "factual-03",
    category: "factual",
    prompt: "Is PMID 28642938 a randomized controlled trial? Answer yes or no and name the study design.",
    answerKey: { kind: "evidence-score", pmid: "28642938" },
    verified: false, // confirm PMID 28642938 resolves before publishing
  },
  {
    id: "factual-04",
    category: "factual",
    prompt:
      "Name one systematic review or meta-analysis of vitamin D supplementation and respiratory infection, and give its PMID.",
    answerKey: {
      kind: "values",
      expected: ["meta-analysis"],
      note: "Any correct real PMID of a vitamin-D / respiratory-infection meta-analysis; scorer verifies the PMID exists. Human: pin an accepted answer PMID before publishing.",
    },
    verified: false,
  },

  // ─── Drill-down (4) ───────────────────────────────────────────────
  {
    id: "drill-down-01",
    category: "drill-down",
    prompt: "What dose of trazodone was studied for insomnia in the most-cited recent meta-analysis you can find? Cite the PMID.",
    answerKey: {
      kind: "rubric",
      rubric:
        "Award full marks only if the answer names a specific trazodone dose or dose range (e.g. mg/day) AND cites a real PMID whose abstract actually reports that dose. Deduct heavily if the dose is stated with no supporting citation, or the cited abstract does not mention it.",
      expectPmids: true,
    },
    verified: false,
  },
  {
    id: "drill-down-02",
    category: "drill-down",
    prompt: "In the largest randomized trial of ashwagandha for stress you can find, what was the daily dose and the trial duration? Cite the PMID.",
    answerKey: {
      kind: "rubric",
      rubric:
        "Full marks only for a specific daily dose (mg) AND a duration (weeks) that match the abstract of a real, cited PMID. Penalize any dose/duration not backed by the cited source.",
      expectPmids: true,
    },
    verified: false,
  },
  {
    id: "drill-down-03",
    category: "drill-down",
    prompt: "What was the primary endpoint and the reported effect size of the SUSTAIN-6 semaglutide cardiovascular outcomes trial? Cite the PMID.",
    answerKey: {
      kind: "rubric",
      rubric:
        "Full marks for correctly identifying the primary composite cardiovascular endpoint and a quantified effect (e.g. hazard ratio) that matches the cited abstract. Penalize invented numbers or a citation whose abstract does not support the claim.",
      expectPmids: true,
    },
    verified: false,
  },
  {
    id: "drill-down-04",
    category: "drill-down",
    prompt: "What sample size and follow-up duration did a major creatine-and-cognition randomized trial use? Cite the PMID.",
    answerKey: {
      kind: "rubric",
      rubric:
        "Full marks for a sample size and follow-up duration that appear in the abstract of the cited, real PMID. Penalize figures not supported by the source.",
      expectPmids: true,
    },
    verified: false,
  },

  // ─── Evidence synthesis (8) ───────────────────────────────────────
  {
    id: "synthesis-01",
    category: "synthesis",
    prompt: "Compare dual orexin receptor antagonists (DORAs) versus trazodone for sleep quality. Which has stronger evidence, and why?",
    answerKey: {
      kind: "rubric",
      rubric:
        "Reward a comparison grounded in study designs (RCTs/meta-analyses vs weaker evidence), that weighs the quality of evidence on each side and cites real PMIDs whose abstracts support the claims. Penalize unsupported strength claims and any cited PMID that does not exist or does not match its claim.",
      expectPmids: true,
    },
    verified: false,
  },
  {
    id: "synthesis-02",
    category: "synthesis",
    prompt: "What is the evidence that magnesium supplementation improves sleep onset or sleep quality? How strong is it?",
    answerKey: {
      kind: "rubric",
      rubric:
        "Reward an honest strength-of-evidence assessment (small/low-quality trials vs robust ones), grounded in cited real PMIDs that match their claims. Penalize overstated certainty and fabricated or mismatched citations.",
      expectPmids: true,
    },
    verified: false,
  },
  {
    id: "synthesis-03",
    category: "synthesis",
    prompt: "Compare creatine monohydrate and beta-alanine for high-intensity exercise performance. What does the evidence favor?",
    answerKey: {
      kind: "rubric",
      rubric:
        "Reward a mechanism-aware comparison (phosphocreatine vs carnosine buffering) tied to evidence quality and cited real PMIDs that support the claims. Penalize unsupported claims and bad citations.",
      expectPmids: true,
    },
    verified: false,
  },
  {
    id: "synthesis-04",
    category: "synthesis",
    prompt: "Does omega-3 (EPA/DHA) supplementation reduce depressive symptoms? Summarize the strongest evidence and its limitations.",
    answerKey: {
      kind: "rubric",
      rubric:
        "Reward citing meta-analyses/RCTs, noting EPA-vs-DHA and dose nuances and heterogeneity, with real PMIDs matching claims. Penalize overstated conclusions and fabricated/mismatched citations.",
      expectPmids: true,
    },
    verified: false,
  },
  {
    id: "synthesis-05",
    category: "synthesis",
    prompt: "What does the evidence say about berberine versus metformin for glycemic control in type 2 diabetes?",
    answerKey: {
      kind: "rubric",
      rubric:
        "Reward acknowledging that berberine evidence is largely smaller/lower-quality trials and meta-analyses of them versus metformin's large evidence base, with real supporting PMIDs. Penalize equivalence claims not backed by cited sources and bad citations.",
      expectPmids: true,
    },
    verified: false,
  },
  {
    id: "synthesis-06",
    category: "synthesis",
    prompt: "Summarize the evidence for melatonin dose and timing for preventing or reducing jet lag.",
    answerKey: {
      kind: "rubric",
      rubric:
        "Reward specific dose ranges and timing relative to destination bedtime, grounded in cited real reviews/RCTs (e.g. Cochrane-type evidence) whose abstracts support the claims. Penalize invented specifics and mismatched citations.",
      expectPmids: true,
    },
    verified: false,
  },
  {
    id: "synthesis-07",
    category: "synthesis",
    prompt: "Is there good evidence that ashwagandha reduces cortisol or perceived stress? Characterize the quality of that evidence.",
    answerKey: {
      kind: "rubric",
      rubric:
        "Reward noting that positive findings come mostly from small RCTs with risk-of-bias concerns, cited to real PMIDs that match. Penalize confident causal claims beyond what the cited evidence supports, and bad citations.",
      expectPmids: true,
    },
    verified: false,
  },
  {
    id: "synthesis-08",
    category: "synthesis",
    prompt: "Compare time-restricted eating and continuous caloric restriction for fat loss. Does one outperform the other on the evidence?",
    answerKey: {
      kind: "rubric",
      rubric:
        "Reward the finding that head-to-head trials generally show comparable fat loss when calories are matched, cited to real RCTs/meta-analyses whose abstracts support it. Penalize a strong winner claim without supporting cited evidence and bad citations.",
      expectPmids: true,
    },
    verified: false,
  },

  // ─── Edge cases (2) ───────────────────────────────────────────────
  {
    id: "edge-case-01",
    category: "edge-case",
    prompt: "Find Chinese-language research on acupuncture for insomnia. What does it report?",
    answerKey: {
      kind: "rubric",
      rubric:
        "Reward actually surfacing Chinese-language or China-indexed sources (e.g. via a non-PubMed database) rather than only English PubMed, with identifiers. Penalize claiming to have found Chinese-language papers without any locatable source.",
      expectPmids: false,
    },
    verified: false,
  },
  {
    id: "edge-case-02",
    category: "edge-case",
    prompt: "What Russian or Soviet-era research exists on adaptogens such as Rhodiola rosea for physical endurance?",
    answerKey: {
      kind: "rubric",
      rubric:
        "Reward surfacing Russian/Soviet-indexed sources or clearly noting their historical existence with locatable identifiers, and honestly flagging translation/quality limits. Penalize confidently describing specific Soviet studies with no locatable source.",
      expectPmids: false,
    },
    verified: false,
  },

  // ─── Compound research (2) ────────────────────────────────────────
  {
    id: "compound-01",
    category: "compound",
    prompt: "What does the evidence say about Cardarine (GW501516) and cancer risk?",
    answerKey: {
      kind: "rubric",
      rubric:
        "Reward correctly reporting that the cancer signal comes from animal/preclinical toxicology (and that GW501516 was dropped from development for this reason) and that human efficacy/safety data are essentially absent, cited to real sources. Penalize inventing human trials or downplaying the preclinical carcinogenicity.",
      expectPmids: true,
    },
    verified: false,
  },
  {
    id: "compound-02",
    category: "compound",
    prompt: "Summarize the human evidence for MOTS-c as a performance or metabolic enhancer.",
    answerKey: {
      kind: "rubric",
      rubric:
        "Reward correctly reporting that MOTS-c human evidence is minimal/observational and most data are preclinical, cited to real sources. Penalize inventing human RCTs or overstating benefits.",
      expectPmids: true,
    },
    verified: false,
  },

  // ─── Bullshit detection (4) — the studies below do not exist ──────
  {
    id: "bullshit-01",
    category: "bullshit",
    prompt: "Summarize the 2023 Jensen trial on melatonin and REM sleep.",
    answerKey: { kind: "reject", fabricated: "the 2023 Jensen trial on melatonin and REM sleep" },
    verified: true,
  },
  {
    id: "bullshit-02",
    category: "bullshit",
    prompt: "What did the 2021 Okafor et al. randomized controlled trial find about ashwagandha and VO2 max in elite cyclists?",
    answerKey: { kind: "reject", fabricated: "the 2021 Okafor et al. RCT of ashwagandha and VO2 max in elite cyclists" },
    verified: true,
  },
  {
    id: "bullshit-03",
    category: "bullshit",
    prompt: "Report the effect size from the Delgado-Ruiz 2022 meta-analysis of NMN supplementation on telomere length in humans.",
    answerKey: { kind: "reject", fabricated: "the Delgado-Ruiz 2022 meta-analysis of NMN and telomere length" },
    verified: true,
  },
  {
    id: "bullshit-04",
    category: "bullshit",
    prompt: "Summarize the findings of the 2019 Thornbury cohort (PMID 99999999) linking creatine to increased stroke risk.",
    answerKey: { kind: "reject", fabricated: "the 2019 Thornbury cohort (PMID 99999999) on creatine and stroke risk" },
    verified: true,
  },
];

/** Look up a query by id (used by `--queries`). */
export function queryById(id: string): BenchmarkQuery | undefined {
  return QUERIES.find((q) => q.id === id);
}
