/**
 * The 24-query benchmark set: 6 categories, matching the spec's counts.
 * Edit this array to add/remove/tune queries. It's plain TypeScript, so `tsc`
 * checks every `category`, answer-key `kind`, and field against the types in
 * `lib/types.ts` — a typo fails the build instead of at run time.
 *
 * On `verified`: it is `true` only when the answer key can be graded against a
 * checked-against-reality ground truth, not a subjective judgment call —
 *   - the four bullshit queries (the studies are fabricated *by us*, so "does
 *     not exist" is ground truth), and
 *   - the deterministic `values` keys, where the query forces the model to end
 *     its answer in a fixed one-line format and the scorer checks the exact
 *     tokens it emitted against the correct ones. Each such key's expected
 *     tokens were confirmed on 2026-07-14 against live PubMed and the library's
 *     own grader (`keywordGrade`): the study type + 0–5 score are what the tool
 *     assigns, and every pinned PMID resolves.
 * The open-ended `rubric` keys (synthesis, edge-case, compound, and the
 * find-it-yourself drill-downs) still assert real-world facts that take human
 * judgment to weigh, so they stay `verified: false`: they run and score
 * automatically (a provisional citation-quality proxy, not correctness — see
 * `grade.ts`), but the harness refuses to treat them as publishable until a
 * human grades them with `npx tsx benchmark/grade.ts <results-dir>`, which
 * writes accuracy into that run's `overrides.json` for `--rescore` to apply.
 * Fill in / review the `false` ones before quoting results.
 *
 * Response contract: the deterministic factual queries tell the model to finish
 * with one line in an exact format (`ANSWER — …`). The scorer (lib/scoring/
 * accuracy.ts, `values`) lowercases and collapses whitespace, then checks that
 * each expected token is present — so a model that follows the format and gets
 * the facts right scores full marks, and one that gets the design/score/PMID
 * wrong (or ignores the format) does not. All three conditions face the same
 * contract, so it stays fair across closed-book / web / MCP.
 */

import type { BenchmarkQuery } from "./lib/types.js";

export const QUERIES: BenchmarkQuery[] = [
  // ─── Factual lookup (4) ───────────────────────────────────────────
  // Deterministic `values` keys: the model must end with the ANSWER line and
  // the tokens are matched literally. Study type must be one of the library's
  // taxonomy labels: meta-analysis, randomized-controlled-trial, cohort,
  // review, case-control, case-report, animal-study.
  {
    id: "factual-01",
    category: "factual",
    prompt:
      "Classify the study behind PMID 36615805 and give the 0–5 evidence score an evidence-grading tool would assign its design. Finish your reply with one line in EXACTLY this format and nothing else on that line:\n`ANSWER — study type: <type> | evidence score: <n>/5`\nwhere <type> is exactly one of: meta-analysis, randomized-controlled-trial, cohort, review, case-control, case-report, animal-study; and <n> is the integer 0–5 for that design (meta-analysis or systematic review = 5, randomized-controlled-trial = 4, cohort or review = 3, case-control = 2, case-report = 1, animal or non-clinical = 0).",
    answerKey: {
      kind: "values",
      expected: ["study type: meta-analysis", "evidence score: 5/5"],
      note: "PMID 36615805 = caffeine/endurance-running systematic review & meta-analysis (NLM PublicationType 'Meta-Analysis'); keywordGrade → meta-analysis, score 5. Verified 2026-07-14.",
    },
    verified: true,
    answerKeyVersion: 2,
  },
  {
    id: "factual-02",
    category: "factual",
    prompt:
      "Classify the study behind PMID 23439798 and give the 0–5 evidence score an evidence-grading tool would assign its design. Finish your reply with one line in EXACTLY this format and nothing else on that line:\n`ANSWER — study type: <type> | evidence score: <n>/5`\nwhere <type> is exactly one of: meta-analysis, randomized-controlled-trial, cohort, review, case-control, case-report, animal-study; and <n> is the integer 0–5 for that design (meta-analysis or systematic review = 5, randomized-controlled-trial = 4, cohort or review = 3, case-control = 2, case-report = 1, animal or non-clinical = 0).",
    answerKey: {
      kind: "values",
      expected: ["study type: randomized-controlled-trial", "evidence score: 4/5"],
      note: "PMID 23439798 = Chandrasekhar 2012 ashwagandha stress/anxiety RCT (prospective, randomized, double-blind, placebo-controlled); keywordGrade → randomized-controlled-trial, score 4. Verified 2026-07-14.",
    },
    verified: true,
    answerKeyVersion: 2,
  },
  {
    id: "factual-03",
    category: "factual",
    prompt:
      "Is PMID 22591295 a randomized controlled trial? Determine its actual study design. Finish your reply with one line in EXACTLY this format and nothing else on that line:\n`ANSWER — rct: <yes|no> | study type: <type>`\nwhere <type> is exactly one of: meta-analysis, randomized-controlled-trial, cohort, review, case-control, case-report, animal-study.",
    answerKey: {
      kind: "values",
      expected: ["rct: no", "study type: cohort"],
      note: "PMID 22591295 = Freedman 2012 NEJM 'Association of coffee drinking with total and cause-specific mortality', a prospective cohort of the NIH-AARP study — not an RCT; keywordGrade → cohort, score 3. Verified 2026-07-14.",
    },
    verified: true,
    answerKeyVersion: 2,
  },
  {
    id: "factual-04",
    category: "factual",
    prompt:
      "Identify the landmark 2017 BMJ meta-analysis of individual participant data by Martineau and colleagues on vitamin D supplementation to prevent acute respiratory tract infections, and give its PMID. Finish your reply with one line in EXACTLY this format and nothing else on that line:\n`ANSWER — PMID: <number>`",
    answerKey: {
      kind: "values",
      expected: ["pmid: 28202713"],
      note: "PMID 28202713 = Martineau et al. 2017 BMJ IPD meta-analysis of vitamin D and acute respiratory tract infection (NLM 'Meta-Analysis'); keywordGrade → meta-analysis, score 5. This is the one accepted answer. Verified 2026-07-14.",
    },
    verified: true,
    answerKeyVersion: 2,
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
    // Deterministic: SUSTAIN-6 is a single named trial, so the endpoint, effect
    // size and PMID are fixed facts rather than "whatever you can find".
    prompt:
      "The SUSTAIN-6 semaglutide cardiovascular outcomes trial: what was its primary composite endpoint, and what hazard ratio did it report for that endpoint? Cite the PMID. Finish your reply with one line in EXACTLY this format and nothing else on that line:\n`ANSWER — PMID: <number> | hazard ratio: <value>`",
    answerKey: {
      kind: "values",
      expected: ["pmid: 27633186", "hazard ratio: 0.74"],
      note: "PMID 27633186 = Marso et al. 2016 NEJM SUSTAIN-6. Primary composite outcome: cardiovascular death, nonfatal myocardial infarction, or nonfatal stroke; hazard ratio 0.74 (95% CI 0.58–0.95). Confirmed from the abstract 2026-07-14.",
    },
    verified: true,
    answerKeyVersion: 2,
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
