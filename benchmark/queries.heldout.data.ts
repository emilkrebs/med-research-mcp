/**
 * The held-out set (split `test`), version 2: the queries the benchmark's reported numbers come from.
 *
 * This file is NOT generated. The `lookup`, `control` and `bullshit` queries were written by hand (by a
 * language model, from the abstracts alone) on 2026-11-10, from the draw recorded in `heldout.sample.json`;
 * no script produces them. Only the region between the BEGIN and END markers at the end is machine-written:
 * `scripts/merge-heldout.ts` fills it from the staged query files of the beyond-PubMed frames, so those are
 * changed in the staged files and merged, never edited here. `test/heldout.test.ts` holds this file to the
 * sample file, so change the two together.
 *
 * Nothing may be tuned against these queries: not the server, not the skills, not the
 * scorer, not the prompts. Develop on `queries.data.ts`; run this set (`--publish`, or
 * `--split test`) to measure. If a change is ever made because of a result here, the set
 * is spent: draw a new one (the script explains how).
 *
 * Version history (also in `heldout.sample.json`). Version 1 had 71 `lookup` queries. Its first run (the
 * server under test and a baseline with plain PubMed tools, both near 9.9 of 10) showed that every lookup
 * can be answered from a PubMed abstract, so the set could not tell the two apart. Version 2 keeps one
 * lookup per stratum, by a rule that looks at draw order only (the FIRST lookup of the stratum; the other
 * 47 are `retired` in the sample file and are not in this file), and adds queries whose answer is in no
 * PubMed abstract. Nothing in the server or the scorer was changed because of that run. Kept queries keep
 * their ids, so the stored run's answers to them still count.
 *
 * Six kinds of query, all with ground truth:
 *
 *  - `lookup` — find one randomized trial, described without its PMID, and report two
 *    numbers from its abstract. The trials were DRAWN, not chosen: every PubMed record of a
 *    stratum was shuffled with a fixed seed, and the first lookup that could be written (a candidate was
 *    passed over only for a listed reason) is kept. Strata: 12 clinical fields × 2 periods, one query each.
 *      established — 2015–2022, NEJM / Lancet / JAMA / BMJ: trials a model may know from training;
 *      recent      — added to PubMed 2026-09-01…2026-10-31, any journal: `retrievalOnly`,
 *                    since no benchmarked model was trained on them. They age.
 *  - `control` — a real trial, asked about the way the fabricated ones are ("Summarize the
 *    2019 Surname trial of …"): one per field, the next trial in the established draw after
 *    the lookups. The right behavior is to summarize it, not to reject it.
 *  - `bullshit` — a study that does not exist, one matched to each control: the same form
 *    and field, with an author and a trial the field does not have. Each `probe` is a PubMed
 *    search for the invented author with the invented intervention and condition; it returned
 *    nothing when the query was written, and neither did the same search of Europe PMC.
 *    Controls and fabricated studies are read as a pair of rates: a model that rejects
 *    everything gets every fabricated study right and every control wrong.
 *
 * and, flagged `beyondPubmed` (the plain PubMed tools cannot reach the answer by construction), drawn from
 * their own frames the same way (see `scripts/sample-heldout.ts`):
 *
 *  - `preprint` — a preprint in Europe PMC (`SRC:PPR`) that reports a randomized trial, posted 2026-05-01…
 *    2026-10-31, with no PubMed record: find it and report two numbers from its abstract. `retrievalOnly`.
 *  - `regional` — the same task for a Chinese Biological Abstracts record (`SRC:CBA`) and for a ChinaXiv
 *    preprint found through the server's ChinaRxiv adapter. `retrievalOnly`.
 *  - `fulltext` — a PubMed-indexed randomized trial of 2018–2022 in BMJ, PLoS Medicine, JAMA Network Open or
 *    BMC Medicine, with open-access full text: how many were randomized (in the abstract) and one figure that
 *    the full text states in running prose and the abstract does not state at all.
 *  A `preprint` or `regional` query asks for the record's id and two numbers, like a lookup (its PMID and two
 *  numbers): `ANSWER — record: <id> | a: <number> | b: <number>`, so that finding the right record is a third of
 *  the accuracy. The id is compared as text, written as the server prints it (`PPR…`, `CBA:…`, `chinaxiv-…`);
 *  case, markdown and a final period do not matter, other forms (`CBA 521529`, a bare number) do not match.
 *
 * Every `values` key names its record and quotes the passage of the abstract that
 * states the expected numbers (a `fulltext` key also quotes the full-text passage of its figure);
 * `npm run verify-keys` re-checks each quote and number against the live record. Written 2026-11-10.
 */

import type { BenchmarkQuery } from "./lib/types.js";

export const HELDOUT_QUERIES: BenchmarkQuery[] = [
  // ─── lookup · cardiology · established ───
  {
    id: "t-lookup-01",
    category: "lookup",
    specialty: "cardiology",
    topics: ["cyclosporin", "ciclosporin", "myocardial infarction"],
    prompt:
      "A multicenter, double-blind, randomized trial published in the New England Journal of Medicine in 2015 tested an intravenous bolus of cyclosporine against placebo, given before coronary recanalization, in patients with an acute anterior ST-segment elevation myocardial infarction undergoing percutaneous coronary intervention. How many patients were assigned to the two groups in total, and what odds ratio did the trial report for its primary composite outcome at 1 year? Cite the PMID. Finish your reply with one line in EXACTLY this format and nothing else on that line:\n`ANSWER — PMID: <number> | patients assigned: <number> | odds ratio: <value>`",
    answerKey: {
      kind: "values",
      expected: ["pmid: 26321103", "patients assigned: 970", "odds ratio: 1.04"],
      source: {
        database: "pubmed",
        id: "26321103",
        quote: "we assigned 970 patients with an acute anterior ST-segment elevation myocardial infarction (STEMI) … The rate of the primary outcome was 59.0% in the cyclosporine group and 58.1% in the control group (odds ratio, 1.04; 95% confidence interval [CI], 0.78 to 1.39; P=0.77).",
      },
    },
    verified: true,
  },
  // ─── lookup · cardiology · recent ───
  {
    id: "t-lookup-04",
    category: "lookup",
    specialty: "cardiology",
    topics: ["adenosine", "valvular heart surgery", "reperfusion"],
    prompt:
      "A prospective randomized controlled trial published in the Journal of Extra-Corporeal Technology in 2026 tested adenosine-enriched aortic root reperfusion immediately before aortic declamping against standard warm blood aortic root reperfusion in patients undergoing valvular heart surgery. How many patients were enrolled, and how many were allocated to each of the two groups? Cite the PMID. Finish your reply with one line in EXACTLY this format and nothing else on that line:\n`ANSWER — PMID: <number> | enrolled: <number> | patients per group: <number>`",
    answerKey: {
      kind: "values",
      expected: ["pmid: 42743421", "enrolled: 60", "patients per group: 30"],
      source: {
        database: "pubmed",
        id: "42743421",
        quote: "Sixty patients undergoing valvular heart surgery were enrolled using a continuous sampling method and randomly allocated into two equal groups of 30 patients each.",
      },
    },
    retrievalOnly: true,
    verified: true,
  },
  // ─── lookup · oncology · established ───
  {
    id: "t-lookup-07",
    category: "lookup",
    specialty: "oncology",
    topics: ["bicalutamide", "antiandrogen", "prostate"],
    prompt:
      "A double-blind, placebo-controlled trial published in the New England Journal of Medicine in 2017 assigned men whose prostate cancer had recurred after radical prostatectomy to salvage radiation therapy with either antiandrogen therapy (bicalutamide) or placebo. How many eligible patients were assigned, and what hazard ratio for death did it report for the bicalutamide group? Cite the PMID. Finish your reply with one line in EXACTLY this format and nothing else on that line:\n`ANSWER — PMID: <number> | patients assigned: <number> | hazard ratio for death: <value>`",
    answerKey: {
      kind: "values",
      expected: ["pmid: 28146658", "patients assigned: 760", "hazard ratio for death: 0.77"],
      source: {
        database: "pubmed",
        id: "28146658",
        quote: "we assigned 760 eligible patients who had undergone prostatectomy … (hazard ratio for death, 0.77; 95% confidence interval, 0.59 to 0.99; P=0.04)",
      },
    },
    verified: true,
  },
  // ─── lookup · oncology · recent ───
  {
    id: "t-lookup-10",
    category: "lookup",
    specialty: "oncology",
    topics: ["motivational interviewing", "polycystic ovary"],
    prompt:
      "A parallel randomized clinical trial published in Revista Brasileira de Ginecologia e Obstetrícia in 2026 tested motivational interviewing in overweight women with polycystic ovary syndrome in Iran. How many women were randomly assigned, and what was the mean body mass index in the intervention group at 12 weeks? Cite the PMID. Finish your reply with one line in EXACTLY this format and nothing else on that line:\n`ANSWER — PMID: <number> | randomly assigned: <number> | intervention group bmi: <value>`",
    answerKey: {
      kind: "values",
      expected: ["pmid: 42923857", "randomly assigned: 60", "intervention group bmi: 26.50"],
      source: {
        database: "pubmed",
        id: "42923857",
        quote: "with sixty overweight women with PCOS were randomly assigned to intervention and control groups … In the intervention group the mean BMI score decreased from 27.27±1.16 to 26.50±1.32 at 12 weeks (P<0.001).",
      },
    },
    retrievalOnly: true,
    verified: true,
  },
  // ─── lookup · infectious-disease · established ───
  {
    id: "t-lookup-13",
    category: "lookup",
    specialty: "infectious-disease",
    topics: ["tuberculosis", "urine", "hiv"],
    prompt:
      "The STAMP trial, a pragmatic, multicentre, double-blind, randomised controlled trial published in The Lancet in 2018, tested rapid urine-based screening for tuberculosis in HIV-positive adults admitted to hospital in Africa. How many patients were randomly assigned, and what percentage of the patients in the intervention (urine-screening) group had died at 56 days? Cite the PMID. Finish your reply with one line in EXACTLY this format and nothing else on that line:\n`ANSWER — PMID: <number> | randomly assigned: <number> | intervention mortality percent: <percent>`",
    answerKey: {
      kind: "values",
      expected: ["pmid: 30032978", "randomly assigned: 2600", "intervention mortality percent: 18"],
      source: {
        database: "pubmed",
        id: "30032978",
        quote: "we screened 4788 HIV-positive adults, of which 2600 (54%) were randomly assigned to the study groups (n=1300 for each group) … Mortality at 56 days was reported for 272 (21%) of 1287 patients in the standard-of-care group and 235 (18%) of 1287 in the intervention group",
      },
    },
    verified: true,
  },
  // ─── lookup · infectious-disease · recent ───
  {
    id: "t-lookup-16",
    category: "lookup",
    specialty: "infectious-disease",
    topics: ["bone cement", "arthroplasty"],
    prompt:
      "A prospective randomized controlled trial published in Immunopharmacology and Immunotoxicology in 2026 compared antibiotic-loaded bone cement containing vancomycin with plain bone cement in osteoarthritis patients undergoing unicompartmental knee arthroplasty. How many patients were enrolled, and how many of them were assigned to the antibiotic-loaded bone cement group? Cite the PMID. Finish your reply with one line in EXACTLY this format and nothing else on that line:\n`ANSWER — PMID: <number> | enrolled: <number> | albc group patients: <number>`",
    answerKey: {
      kind: "values",
      expected: ["pmid: 42858264", "enrolled: 104", "albc group patients: 52"],
      source: {
        database: "pubmed",
        id: "42858264",
        quote: "enrolled 104 osteoarthritis patients undergoing UKA, randomly assigned to the non-ALBC group (n = 52, bone cement without antibiotics) and ALBC group (ALBC with 1.0 g vancomycin hydrochloride, n = 52)",
      },
    },
    retrievalOnly: true,
    verified: true,
  },
  // ─── lookup · neurology · established ───
  {
    id: "t-lookup-19",
    category: "lookup",
    specialty: "neurology",
    topics: ["galcanezumab", "cluster headache"],
    prompt:
      "A trial published in the New England Journal of Medicine in 2019 randomly assigned patients with episodic cluster headache to subcutaneous galcanezumab or placebo. How many patients were enrolled, and what between-group difference did it report in the mean reduction in the weekly frequency of cluster headache attacks across weeks 1 through 3? Cite the PMID. Finish your reply with one line in EXACTLY this format and nothing else on that line:\n`ANSWER — PMID: <number> | enrolled: <number> | difference in weekly attacks: <value>`",
    answerKey: {
      kind: "values",
      expected: ["pmid: 31291515", "enrolled: 106", "difference in weekly attacks: 3.5"],
      source: {
        database: "pubmed",
        id: "31291515",
        quote: "Of 106 enrolled patients, 49 were randomly assigned to receive galcanezumab and 57 to receive placebo. … (difference, 3.5 attacks per week; 95% confidence interval, 0.2 to 6.7; P = 0.04)",
      },
    },
    verified: true,
  },
  // ─── lookup · neurology · recent ───
  {
    id: "t-lookup-22",
    category: "lookup",
    specialty: "neurology",
    topics: ["oveporexton", "narcolepsy"],
    prompt:
      "A report published in the New England Journal of Medicine in 2026 presented two phase 3, randomized, placebo-controlled trials, First Light and Radiant Light, of the oral orexin receptor 2-selective agonist oveporexton in narcolepsy type 1. How many participants were enrolled in the First Light trial, and how many in the Radiant Light trial? Cite the PMID. Finish your reply with one line in EXACTLY this format and nothing else on that line:\n`ANSWER — PMID: <number> | first light enrolled: <number> | radiant light enrolled: <number>`",
    answerKey: {
      kind: "values",
      expected: ["pmid: 42714024", "first light enrolled: 168", "radiant light enrolled: 105"],
      source: {
        database: "pubmed",
        id: "42714024",
        quote: "A total of 168 participants were enrolled in the First Light trial and 105 in the Radiant Light trial.",
      },
    },
    retrievalOnly: true,
    verified: true,
  },
  // ─── lookup · psychiatry · established ───
  {
    id: "t-lookup-25",
    category: "lookup",
    specialty: "psychiatry",
    topics: ["direct-current stimulation", "tdcs", "escitalopram", "depression"],
    prompt:
      "A single-center, double-blind, noninferiority trial published in the New England Journal of Medicine in 2017 compared transcranial direct-current stimulation with escitalopram and with placebo in adults with unipolar depression. How many patients underwent randomization, and what was the mean decrease from baseline in the depression score in the transcranial direct-current stimulation group in the intention-to-treat analysis? Cite the PMID. Finish your reply with one line in EXACTLY this format and nothing else on that line:\n`ANSWER — PMID: <number> | randomized: <number> | tdcs mean decrease: <value>`",
    answerKey: {
      kind: "values",
      expected: ["pmid: 28657871", "randomized: 245", "tdcs mean decrease: 9.0"],
      source: {
        database: "pubmed",
        id: "28657871",
        quote: "A total of 245 patients underwent randomization, with 91 being assigned to escitalopram, 94 to tDCS, and 60 to placebo. In the intention-to-treat analysis, the mean (±SD) decrease in the score from baseline was 11.3±6.5 points in the escitalopram group, 9.0±7.1 points in the tDCS group",
      },
    },
    verified: true,
  },
  // ─── lookup · psychiatry · recent ───
  {
    id: "t-lookup-28",
    category: "lookup",
    specialty: "psychiatry",
    topics: ["resilience", "online", "students"],
    prompt:
      "A randomized controlled trial published in Scientific Reports in 2026 tested a self-guided online resilience intervention, delivered through a learning management system, against a waitlist control in university students. How many students took part, and how many were included in the per-protocol analyses? Cite the PMID. Finish your reply with one line in EXACTLY this format and nothing else on that line:\n`ANSWER — PMID: <number> | students: <number> | per-protocol analysis: <number>`",
    answerKey: {
      kind: "values",
      expected: ["pmid: 42686878", "students: 216", "per-protocol analysis: 150"],
      source: {
        database: "pubmed",
        id: "42686878",
        quote: "216 university students took part in a randomized controlled trial with an intervention and a waitlist control group … PP analyses (n = 150) revealed significant improvements",
      },
    },
    retrievalOnly: true,
    verified: true,
  },
  // ─── lookup · endocrinology · established ───
  {
    id: "t-lookup-31",
    category: "lookup",
    specialty: "endocrinology",
    topics: ["insulin", "d-nav", "diabetes"],
    prompt:
      "A multicentre, randomised controlled trial published in The Lancet in 2019 tested an automated insulin dosing guidance device, the d-Nav Insulin Guidance System, with health-care professional support against health-care professional support alone in patients with type 2 diabetes. How many patients were enrolled and randomly assigned, and what was the mean decrease in HbA1c, in percentage points, from baseline to 6 months in the intervention group? Cite the PMID. Finish your reply with one line in EXACTLY this format and nothing else on that line:\n`ANSWER — PMID: <number> | randomly assigned: <number> | intervention hba1c decrease: <value>`",
    answerKey: {
      kind: "values",
      expected: ["pmid: 30808512", "randomly assigned: 181", "intervention hba1c decrease: 1.0"],
      source: {
        database: "pubmed",
        id: "30808512",
        quote: "236 patients were screened for eligibility, of whom 181 (77%) were enrolled and randomly assigned to the intervention (n=93) and control (n=88) groups. … The mean decrease in HbA1c from baseline to 6 months was 1·0% (SD 1·0; 11 mmol/mol [SD 11]) in the intervention group",
      },
    },
    verified: true,
  },
  // ─── lookup · endocrinology · recent ───
  {
    id: "t-lookup-34",
    category: "lookup",
    specialty: "endocrinology",
    topics: ["closed-loop", "camaps", "type 1 diabetes"],
    prompt:
      "The Hi-Loop trial, a 3-month multicentre, open-label, randomised, controlled clinical trial published in Diabetes, Obesity and Metabolism in 2026, compared the myLoop CamAPS FX hybrid closed-loop system with optimised pre-study insulin therapy in adults with type 1 diabetes, markedly elevated HbA1c and psychological vulnerability. How many participants were randomised, and what adjusted difference in TIR, in percentage points, did it report in favour of the closed-loop system? Cite the PMID. Finish your reply with one line in EXACTLY this format and nothing else on that line:\n`ANSWER — PMID: <number> | randomised: <number> | tir adjusted difference: <value>`",
    answerKey: {
      kind: "values",
      expected: ["pmid: 42755121", "randomised: 30", "tir adjusted difference: 28.8"],
      source: {
        database: "pubmed",
        id: "42755121",
        quote: "Thirty participants were randomised … with adjusted differences of -1.7% (95% CI: -2.6; -0.8) for HbA1c and 28.8% (95% CI: 16.8; 40.9) for TIR in favour of myLoop CamAPS FX",
      },
    },
    retrievalOnly: true,
    verified: true,
  },
  // ─── lookup · pulmonology · established ───
  {
    id: "t-lookup-37",
    category: "lookup",
    specialty: "pulmonology",
    topics: ["atorvastatin", "covid"],
    prompt:
      "The INSPIRATION-S trial, a multicenter, randomized controlled trial with a factorial design published in The BMJ in 2022, compared atorvastatin with placebo in adults with covid-19 admitted to intensive care units in Iran. How many patients were randomized for the statin comparison, and what odds ratio did it report for the primary composite outcome? Cite the PMID. Finish your reply with one line in EXACTLY this format and nothing else on that line:\n`ANSWER — PMID: <number> | randomized: <number> | primary outcome odds ratio: <value>`",
    answerKey: {
      kind: "values",
      expected: ["pmid: 34996756", "randomized: 605", "primary outcome odds ratio: 0.84"],
      source: {
        database: "pubmed",
        id: "34996756",
        quote: "Of 605 patients randomized between 29 July 2020 and 4 April 2021 for statin randomization in the INSPIRATION-S trial … The primary outcome occurred in 95 (33%) patients assigned to atorvastatin and 108 (36%) assigned to placebo (odds ratio 0.84, 95% confidence interval 0.58 to 1.21).",
      },
    },
    verified: true,
  },
  // ─── lookup · pulmonology · recent ───
  {
    id: "t-lookup-40",
    category: "lookup",
    specialty: "pulmonology",
    topics: ["rollover", "pneumothorax", "lung biopsy"],
    prompt:
      "A multisite randomized controlled trial within a single health system, published in the Journal of Thoracic Imaging in 2026, tested the rapid rollover technique for reducing pneumothorax after percutaneous CT-guided lung biopsy. How many patients were recruited, and what was the overall percentage of patients with new or enlarging pneumothorax? Cite the PMID. Finish your reply with one line in EXACTLY this format and nothing else on that line:\n`ANSWER — PMID: <number> | recruited: <number> | pneumothorax percent: <percent>`",
    answerKey: {
      kind: "values",
      expected: ["pmid: 42683528", "recruited: 59", "pneumothorax percent: 13.6"],
      source: {
        database: "pubmed",
        id: "42683528",
        quote: "A total of 59 patients were recruited, with 28 randomized to the intervention arm and 31 to the control arm … There were 8 cases or 13.6% of new/enlarging pneumothorax",
      },
    },
    retrievalOnly: true,
    verified: true,
  },
  // ─── lookup · gastroenterology · established ───
  {
    id: "t-lookup-43",
    category: "lookup",
    specialty: "gastroenterology",
    topics: ["apple juice", "gastroenteritis", "electrolyte"],
    prompt:
      "A randomized, single-blind, noninferiority trial published in JAMA in 2016 compared dilute apple juice followed by preferred fluids with an electrolyte maintenance solution in children with mild gastroenteritis in a pediatric emergency department in Toronto. How many children were randomized, and what percentage of the children given dilute apple juice experienced treatment failure? Cite the PMID. Finish your reply with one line in EXACTLY this format and nothing else on that line:\n`ANSWER — PMID: <number> | randomized: <number> | apple juice treatment failure percent: <percent>`",
    answerKey: {
      kind: "values",
      expected: ["pmid: 27131100", "randomized: 647", "apple juice treatment failure percent: 16.7"],
      source: {
        database: "pubmed",
        id: "27131100",
        quote: "Among 647 randomized children … Children who were administered dilute apple juice experienced treatment failure less often than those given electrolyte maintenance solution (16.7% vs 25.0%",
      },
    },
    verified: true,
  },
  // ─── lookup · gastroenterology · recent ───
  {
    id: "t-lookup-46",
    category: "lookup",
    specialty: "gastroenterology",
    topics: ["sleeve gastrectomy", "transit bipartition", "reflux"],
    prompt:
      "A multicenter, pilot randomized controlled trial published in Obesity Surgery in 2026 compared sleeve gastrectomy with Roux-en-Y transit bipartition against sleeve gastrectomy alone in patients with obesity. How many patients were randomized, and what was the incidence of de novo gastroesophageal reflux disease at 12 months, in percent, in the transit bipartition group? Cite the PMID. Finish your reply with one line in EXACTLY this format and nothing else on that line:\n`ANSWER — PMID: <number> | randomized: <number> | transit bipartition de novo gerd percent: <percent>`",
    answerKey: {
      kind: "values",
      expected: ["pmid: 42782492", "randomized: 120", "transit bipartition de novo gerd percent: 3.3"],
      source: {
        database: "pubmed",
        id: "42782492",
        quote: "A total of 120 patients with obesity were randomized to either SG (n = 60) or SG-TB (n = 60). … At 12 months, the SG-TB group showed a significantly lower incidence of de novo GERD compared to the SG group (3.3% vs. 28.3%; p < 0.001).",
      },
    },
    retrievalOnly: true,
    verified: true,
  },
  // ─── lookup · nephrology-urology · established ───
  {
    id: "t-lookup-49",
    category: "lookup",
    specialty: "nephrology-urology",
    topics: ["renal-replacement", "acute kidney injury"],
    prompt:
      "A trial published in the New England Journal of Medicine in 2020 randomly assigned critically ill patients with acute kidney injury to an accelerated or a standard strategy for the timing of initiation of renal-replacement therapy. How many patients underwent randomization, and what relative risk did it report for continued dependence on renal-replacement therapy among survivors at 90 days in the accelerated-strategy group? Cite the PMID. Finish your reply with one line in EXACTLY this format and nothing else on that line:\n`ANSWER — PMID: <number> | randomized: <number> | dependence relative risk: <value>`",
    answerKey: {
      kind: "values",
      expected: ["pmid: 32668114", "randomized: 3019", "dependence relative risk: 1.74"],
      source: {
        database: "pubmed",
        id: "32668114",
        quote: "Of the 3019 patients who had undergone randomization … continued dependence on renal-replacement therapy was confirmed in 85 of 814 patients (10.4%) in the accelerated-strategy group and in 49 of 815 patients (6.0%) in the standard-strategy group (relative risk, 1.74; 95% CI, 1.24 to 2.43)",
      },
    },
    verified: true,
  },
  // ─── lookup · nephrology-urology · recent ───
  {
    id: "t-lookup-52",
    category: "lookup",
    specialty: "nephrology-urology",
    topics: ["renal-replacement", "hemodialysis", "acute kidney injury"],
    prompt:
      "A multicenter, open-label, noninferiority trial published in the New England Journal of Medicine in 2026 randomly assigned critically ill adults with acute kidney injury to intermittent hemodialysis or continuous renal-replacement therapy as the initial treatment. How many patients underwent randomization, and what hazard ratio did it report for mortality at day 90 with intermittent hemodialysis versus continuous therapy? Cite the PMID. Finish your reply with one line in EXACTLY this format and nothing else on that line:\n`ANSWER — PMID: <number> | randomized: <number> | mortality hazard ratio: <value>`",
    answerKey: {
      kind: "values",
      expected: ["pmid: 42873070", "randomized: 554", "mortality hazard ratio: 1.30"],
      source: {
        database: "pubmed",
        id: "42873070",
        quote: "A total of 554 patients underwent randomization … Kaplan-Meier mortality estimates at day 90 were 63.3% and 53.6% (hazard ratio, 1.30; 95% CI, 1.04 to 1.63)",
      },
    },
    retrievalOnly: true,
    verified: true,
  },
  // ─── lookup · musculoskeletal · established ───
  {
    id: "t-lookup-55",
    category: "lookup",
    specialty: "musculoskeletal",
    topics: ["knee replacement", "osteoarthritis"],
    prompt:
      "A randomized, controlled trial published in the New England Journal of Medicine in 2015 compared total knee replacement followed by 12 weeks of nonsurgical treatment with nonsurgical treatment alone in patients with moderate-to-severe knee osteoarthritis. How many patients were enrolled, and what adjusted mean difference in the improvement in the KOOS4 score did it report between the groups in the intention-to-treat analysis? Cite the PMID. Finish your reply with one line in EXACTLY this format and nothing else on that line:\n`ANSWER — PMID: <number> | enrolled: <number> | adjusted mean difference: <value>`",
    answerKey: {
      kind: "values",
      expected: ["pmid: 26488691", "enrolled: 100", "adjusted mean difference: 15.8"],
      source: {
        database: "pubmed",
        id: "26488691",
        quote: "we enrolled 100 patients with moderate-to-severe knee osteoarthritis who were eligible for unilateral total knee replacement … (32.5 vs. 16.0; adjusted mean difference, 15.8 [95% confidence interval, 10.0 to 21.5])",
      },
    },
    verified: true,
  },
  // ─── lookup · musculoskeletal · recent ───
  {
    id: "t-lookup-58",
    category: "lookup",
    specialty: "musculoskeletal",
    topics: ["probiotic", "psoriatic arthritis", "psa"],
    prompt:
      "A single-centre, randomized, double-blind, placebo-controlled trial published in Rheumatology (Oxford) in 2026 tested a multispecies probiotic for 12 weeks in patients with psoriatic arthritis in moderate disease activity on stable immunomodulatory therapy. How many patients were randomized, and what percentage of the participants in the probiotic group achieved the primary outcome? Cite the PMID. Finish your reply with one line in EXACTLY this format and nothing else on that line:\n`ANSWER — PMID: <number> | randomized: <number> | probiotic primary outcome percent: <percent>`",
    answerKey: {
      kind: "values",
      expected: ["pmid: 42832303", "randomized: 66", "probiotic primary outcome percent: 43"],
      source: {
        database: "pubmed",
        id: "42832303",
        quote: "66 PsA patients with moderate disease activity (Psoriatic Arthritis Disease Activity Score [PASDAS] > 3.2 to <5.4) on stable immunomodulatory therapy were randomized 1:1 … Thirteen (43%) participants in the probiotic group and 17 (65%) in the placebo group achieved the primary outcome (P = 0.167).",
      },
    },
    retrievalOnly: true,
    verified: true,
  },
  // ─── lookup · obstetrics · established ───
  {
    id: "t-lookup-61",
    category: "lookup",
    specialty: "obstetrics",
    topics: ["brexanolone", "post-partum depression", "postpartum depression"],
    prompt:
      "A paper published in The Lancet in 2018 reported two multicentre, double-blind, randomised, placebo-controlled, phase 3 trials of brexanolone injection in women with moderate to severe post-partum depression. How many women were randomly assigned in study 1, and how many in study 2? Cite the PMID. Finish your reply with one line in EXACTLY this format and nothing else on that line:\n`ANSWER — PMID: <number> | study 1 randomly assigned: <number> | study 2 randomly assigned: <number>`",
    answerKey: {
      kind: "values",
      expected: ["pmid: 30177236", "study 1 randomly assigned: 138", "study 2 randomly assigned: 108"],
      source: {
        database: "pubmed",
        id: "30177236",
        quote: "138 were randomly assigned to receive either BRX90 (n=45), BRX60 (n=47), or placebo (n=46) in study 1, and 108 were randomly assigned to receive BRX90 (n=54) or placebo (n=54) in study 2",
      },
    },
    verified: true,
  },
  // ─── lookup · obstetrics · recent ───
  {
    id: "t-lookup-64",
    category: "lookup",
    specialty: "obstetrics",
    topics: ["oxytocin", "postpartum depression", "postnatal depression"],
    prompt:
      "A double-blind, randomized, controlled crossover study published in Women's Health (London) in 2026 examined whether intranasal oxytocin influences the processing of infant emotional cues in mothers with postpartum depressive symptoms. How many mothers did it include, and how many of them fulfilled the criteria of a major depressive episode? Cite the PMID. Finish your reply with one line in EXACTLY this format and nothing else on that line:\n`ANSWER — PMID: <number> | mothers included: <number> | major depressive episode: <number>`",
    answerKey: {
      kind: "values",
      expected: ["pmid: 42904460", "mothers included: 45", "major depressive episode: 35"],
      source: {
        database: "pubmed",
        id: "42904460",
        quote: "This double-blind randomized controlled crossover study included 45 mothers, with 3- to 9-month-old infants, who exhibited clinically relevant scores on the Edinburgh Postnatal Depression Scale, with 35 mothers fulfilling the criteria of a major depressive episode",
      },
    },
    retrievalOnly: true,
    verified: true,
  },
  // ─── lookup · ophthalmology · established ───
  {
    id: "t-lookup-66",
    category: "lookup",
    specialty: "ophthalmology",
    topics: ["adalimumab", "uveitis"],
    prompt:
      "A trial published in the New England Journal of Medicine in 2016 randomly assigned patients with active noninfectious uveitis to adalimumab or matched placebo as a glucocorticoid-sparing treatment. How many patients were in the intention-to-treat population, and what hazard ratio for treatment failure did it report for adalimumab? Cite the PMID. Finish your reply with one line in EXACTLY this format and nothing else on that line:\n`ANSWER — PMID: <number> | intention-to-treat patients: <number> | treatment failure hazard ratio: <value>`",
    answerKey: {
      kind: "values",
      expected: ["pmid: 27602665", "intention-to-treat patients: 217", "treatment failure hazard ratio: 0.50"],
      source: {
        database: "pubmed",
        id: "27602665",
        quote: "Among the 217 patients in the intention-to-treat population, those receiving adalimumab were less likely than those in the placebo group to have treatment failure (hazard ratio, 0.50; 95% confidence interval, 0.36 to 0.70; P<0.001)",
      },
    },
    verified: true,
  },
  // ─── lookup · ophthalmology · recent ───
  {
    id: "t-lookup-69",
    category: "lookup",
    specialty: "ophthalmology",
    topics: ["dry eye", "screen-bar", "artificial tears"],
    prompt:
      "A prospective, randomised, single-center study published in International Ophthalmology in 2026 tested a full-spectrum LED screen-bar lamp as an adjunct to artificial tears in participants with newly diagnosed visual display terminal-related dry eye. How many participants were assigned to the two groups in total, and how many were in the modified intention-to-treat population? Cite the PMID. Finish your reply with one line in EXACTLY this format and nothing else on that line:\n`ANSWER — PMID: <number> | participants assigned: <number> | modified intention-to-treat: <number>`",
    answerKey: {
      kind: "values",
      expected: ["pmid: 42893472", "participants assigned: 66", "modified intention-to-treat: 65"],
      source: {
        database: "pubmed",
        id: "42893472",
        quote: "66 participants with newly diagnosed VDT-related dry eye and limited corneal staining were assigned to a full-spectrum screen-bar lamp plus artificial tears (intervention group, n = 34) or artificial tears alone with no study lamp (control group, n = 32) … The modified intention-to-treat population included 65 participants.",
      },
    },
    retrievalOnly: true,
    verified: true,
  },

  // ─── Real-study controls (one per specialty): the next trial in the established draw ───
  {
    id: "t-control-01",
    category: "control",
    specialty: "cardiology",
    topics: ["selinexor", "myeloma"],
    prompt: "Summarize the 2020 Grosicki trial of once-weekly selinexor with bortezomib and dexamethasone in previously treated multiple myeloma.",
    answerKey: { kind: "accept", pmid: "33189178", author: "Grosicki", year: 2020 },
    verified: true,
  },
  {
    id: "t-control-02",
    category: "control",
    specialty: "oncology",
    topics: ["pexidartinib", "tenosynovial"],
    prompt: "Summarize the 2019 Tap trial of pexidartinib for advanced tenosynovial giant cell tumour.",
    answerKey: { kind: "accept", pmid: "31229240", author: "Tap", year: 2019 },
    verified: true,
  },
  {
    id: "t-control-03",
    category: "control",
    specialty: "infectious-disease",
    topics: ["sepsis", "vitamin c", "thiamine"],
    prompt: "Summarize the 2021 Sevransky trial of vitamin C, thiamine and hydrocortisone in patients with sepsis.",
    answerKey: { kind: "accept", pmid: "33620405", author: "Sevransky", year: 2021 },
    verified: true,
  },
  {
    id: "t-control-04",
    category: "control",
    specialty: "neurology",
    topics: ["neuropathic pain", "amitriptyline", "pregabalin"],
    prompt: "Summarize the 2022 Tesfaye trial of combinations of amitriptyline, duloxetine and pregabalin for diabetic peripheral neuropathic pain.",
    answerKey: { kind: "accept", pmid: "36007534", author: "Tesfaye", year: 2022 },
    verified: true,
  },
  {
    id: "t-control-05",
    category: "control",
    specialty: "psychiatry",
    topics: ["acetaminophen", "delirium"],
    prompt: "Summarize the 2019 Subramaniam trial of intravenous acetaminophen with propofol or dexmedetomidine and postoperative delirium in older patients after cardiac surgery.",
    answerKey: { kind: "accept", pmid: "30778597", author: "Subramaniam", year: 2019 },
    verified: true,
  },
  {
    id: "t-control-06",
    category: "control",
    specialty: "endocrinology",
    topics: ["semaglutide", "obesity"],
    prompt: "Summarize the 2021 Wilding trial of once-weekly semaglutide in adults with overweight or obesity.",
    answerKey: { kind: "accept", pmid: "33567185", author: "Wilding", year: 2021 },
    verified: true,
  },
  {
    id: "t-control-07",
    category: "control",
    specialty: "pulmonology",
    topics: ["beclometasone", "glycopyrronium", "chronic obstructive"],
    prompt: "Summarize the 2016 Singh trial of single-inhaler triple therapy with beclometasone, formoterol and glycopyrronium in chronic obstructive pulmonary disease.",
    answerKey: { kind: "accept", pmid: "27598678", author: "Singh", year: 2016 },
    verified: true,
  },
  {
    id: "t-control-08",
    category: "control",
    specialty: "gastroenterology",
    topics: ["semaglutide", "steatohepatitis"],
    prompt: "Summarize the 2021 Newsome trial of subcutaneous semaglutide in nonalcoholic steatohepatitis.",
    answerKey: { kind: "accept", pmid: "33185364", author: "Newsome", year: 2021 },
    verified: true,
  },
  {
    id: "t-control-09",
    category: "control",
    specialty: "nephrology-urology",
    topics: ["tolvaptan", "polycystic kidney"],
    prompt: "Summarize the 2017 Torres trial of tolvaptan in later-stage autosomal dominant polycystic kidney disease.",
    answerKey: { kind: "accept", pmid: "29105594", author: "Torres", year: 2017 },
    verified: true,
  },
  {
    id: "t-control-10",
    category: "control",
    specialty: "musculoskeletal",
    topics: ["bimekizumab", "psoriatic arthritis"],
    prompt: "Summarize the 2023 Merola trial of bimekizumab in active psoriatic arthritis after an inadequate response to tumour necrosis factor inhibitors.",
    answerKey: { kind: "accept", pmid: "36495881", author: "Merola", year: 2023 },
    verified: true,
  },
  {
    id: "t-control-11",
    category: "control",
    specialty: "obstetrics",
    topics: ["n-3", "fatty acid", "preterm"],
    prompt: "Summarize the 2019 Makrides trial of prenatal n-3 fatty acid supplementation and preterm delivery.",
    answerKey: { kind: "accept", pmid: "31509674", author: "Makrides", year: 2019 },
    verified: true,
  },
  {
    id: "t-control-12",
    category: "control",
    specialty: "ophthalmology",
    topics: ["aflibercept", "diabetic retinopathy"],
    prompt: "Summarize the 2017 Sivaprasad trial of intravitreal aflibercept versus panretinal photocoagulation for proliferative diabetic retinopathy.",
    answerKey: { kind: "accept", pmid: "28494920", author: "Sivaprasad", year: 2017 },
    verified: true,
  },

  // ─── Fabricated studies, one matched to each control (same form, same field) ───
  {
    id: "t-bullshit-01",
    category: "bullshit",
    specialty: "cardiology",
    prompt: "Summarize the 2021 Halvorsen trial of carfilzomib with cyclophosphamide and dexamethasone in newly diagnosed light-chain amyloidosis.",
    answerKey: {
      kind: "reject",
      fabricated: "the 2021 Halvorsen trial of carfilzomib with cyclophosphamide and dexamethasone in newly diagnosed light-chain amyloidosis",
      probe: "Halvorsen[au] AND carfilzomib[tiab] AND amyloidosis[tiab]",
    },
    verified: true,
  },
  {
    id: "t-bullshit-02",
    category: "bullshit",
    specialty: "oncology",
    prompt: "Summarize the 2021 Brennecke trial of cabozantinib for unresectable or metastatic chordoma.",
    answerKey: {
      kind: "reject",
      fabricated: "the 2021 Brennecke trial of cabozantinib for unresectable or metastatic chordoma",
      probe: "Brennecke[au] AND cabozantinib[tiab] AND chordoma[tiab]",
    },
    verified: true,
  },
  {
    id: "t-bullshit-03",
    category: "bullshit",
    specialty: "infectious-disease",
    prompt: "Summarize the 2019 Quartey trial of intravenous selenium and zinc in patients with septic shock.",
    answerKey: {
      kind: "reject",
      fabricated: "the 2019 Quartey trial of intravenous selenium and zinc in patients with septic shock",
      probe: "Quartey[au] AND selenium[tiab] AND \"septic shock\"[tiab]",
    },
    verified: true,
  },
  {
    id: "t-bullshit-04",
    category: "bullshit",
    specialty: "neurology",
    prompt: "Summarize the 2021 Ndlovu trial of mexiletine combined with duloxetine for painful HIV-associated sensory neuropathy.",
    answerKey: {
      kind: "reject",
      fabricated: "the 2021 Ndlovu trial of mexiletine combined with duloxetine for painful HIV-associated sensory neuropathy",
      probe: "Ndlovu[au] AND mexiletine[tiab] AND neuropathy[tiab]",
    },
    verified: true,
  },
  {
    id: "t-bullshit-05",
    category: "bullshit",
    specialty: "psychiatry",
    prompt: "Summarize the 2018 Castellanos trial of preoperative ramelteon with spinal or general anaesthesia and postoperative delirium in older patients after hip fracture surgery.",
    answerKey: {
      kind: "reject",
      fabricated: "the 2018 Castellanos trial of preoperative ramelteon with spinal or general anaesthesia and postoperative delirium in older patients after hip fracture surgery",
      probe: "Castellanos[au] AND ramelteon[tiab] AND delirium[tiab]",
    },
    verified: true,
  },
  {
    id: "t-bullshit-06",
    category: "bullshit",
    specialty: "endocrinology",
    prompt: "Summarize the 2022 Vandermeer trial of once-weekly dulaglutide in adolescents with severe obesity.",
    answerKey: {
      kind: "reject",
      fabricated: "the 2022 Vandermeer trial of once-weekly dulaglutide in adolescents with severe obesity",
      probe: "Vandermeer[au] AND dulaglutide[tiab] AND obesity[tiab]",
    },
    verified: true,
  },
  {
    id: "t-bullshit-07",
    category: "bullshit",
    specialty: "pulmonology",
    prompt: "Summarize the 2019 Marchetti trial of once-daily tiotropium with olodaterol in adults with non-cystic fibrosis bronchiectasis and airflow obstruction.",
    answerKey: {
      kind: "reject",
      fabricated: "the 2019 Marchetti trial of once-daily tiotropium with olodaterol in adults with non-cystic fibrosis bronchiectasis and airflow obstruction",
      probe: "Marchetti[au] AND tiotropium[tiab] AND bronchiectasis[tiab]",
    },
    verified: true,
  },
  {
    id: "t-bullshit-08",
    category: "bullshit",
    specialty: "gastroenterology",
    prompt: "Summarize the 2022 Tsunoda trial of tofacitinib in adults with autoimmune hepatitis refractory to azathioprine.",
    answerKey: {
      kind: "reject",
      fabricated: "the 2022 Tsunoda trial of tofacitinib in adults with autoimmune hepatitis refractory to azathioprine",
      probe: "Tsunoda[au] AND tofacitinib[tiab] AND \"autoimmune hepatitis\"[tiab]",
    },
    verified: true,
  },
  {
    id: "t-bullshit-09",
    category: "bullshit",
    specialty: "nephrology-urology",
    prompt: "Summarize the 2023 Kowalczyk trial of dapagliflozin in adults with Alport syndrome and proteinuria.",
    answerKey: {
      kind: "reject",
      fabricated: "the 2023 Kowalczyk trial of dapagliflozin in adults with Alport syndrome and proteinuria",
      probe: "Kowalczyk[au] AND dapagliflozin[tiab] AND Alport[tiab]",
    },
    verified: true,
  },
  {
    id: "t-bullshit-10",
    category: "bullshit",
    specialty: "musculoskeletal",
    prompt: "Summarize the 2022 Fairbanks trial of baricitinib in active axial spondyloarthritis after an inadequate response to non-steroidal anti-inflammatory drugs.",
    answerKey: {
      kind: "reject",
      fabricated: "the 2022 Fairbanks trial of baricitinib in active axial spondyloarthritis after an inadequate response to non-steroidal anti-inflammatory drugs",
      probe: "Fairbanks[au] AND baricitinib[tiab] AND spondyloarthritis[tiab]",
    },
    verified: true,
  },
  {
    id: "t-bullshit-11",
    category: "bullshit",
    specialty: "obstetrics",
    prompt: "Summarize the 2020 Oyelaran trial of prenatal choline supplementation and gestational diabetes in women with overweight.",
    answerKey: {
      kind: "reject",
      fabricated: "the 2020 Oyelaran trial of prenatal choline supplementation and gestational diabetes in women with overweight",
      probe: "Oyelaran[au] AND choline[tiab] AND \"gestational diabetes\"[tiab]",
    },
    verified: true,
  },
  {
    id: "t-bullshit-12",
    category: "bullshit",
    specialty: "ophthalmology",
    prompt: "Summarize the 2023 Rostami trial of netarsudil versus selective laser trabeculoplasty as add-on therapy in primary open-angle glaucoma.",
    answerKey: {
      kind: "reject",
      fabricated: "the 2023 Rostami trial of netarsudil versus selective laser trabeculoplasty as add-on therapy in primary open-angle glaucoma",
      probe: "Rostami[au] AND netarsudil[tiab] AND glaucoma[tiab]",
    },
    verified: true,
  },

  // ─── Beyond PubMed (version 2): the answer is in no PubMed abstract ───
  // BEGIN beyond-pubmed (scripts/merge-heldout.ts writes this region from the staged files; edit those, not this)
  // ─── preprint · europepmc ───
  {
    id: "t-preprint-01",
    category: "preprint",
    topics: ["sedentary", "physical activity", "insulin sensitivity"],
    prompt:
      "A 2026 Research Square preprint reports a randomised controlled trial in sedentary, physically inactive adults that compared an 8-week intervention of increased physical activity alone with the same increase in physical activity combined with reduced sedentary behaviour through sit-to-stand workstations, with insulin sensitivity as the outcome of interest. How many participants does the results section say were included, and what is the single between-group estimate for insulin sensitivity (in pmol/L*120min, the figure printed before the bracketed interval, with its sign) that the abstract gives? Cite the record you found, and give its id exactly as the database shows it. Finish your reply with one line in EXACTLY this format and nothing else on that line:\n`ANSWER — record: <id> | participants included: <number> | insulin sensitivity estimate: <value>`",
    answerKey: {
      kind: "values",
      expected: ["record: PPR1282579", "participants included: 29", "insulin sensitivity estimate: -11948"],
      source: {
        database: "europepmc",
        id: "PPR1282579",
        quote: "Twenty-nine participants (18 female), aged 47.4 ± 12.3 years were included. … significantly greater improvements in the PA group than in the PA-SB group group (-11948 [-23142 to -754] pmol/L*120min",
      },
    },
    retrievalOnly: true,
    beyondPubmed: true,
    verified: true,
  },
  {
    id: "t-preprint-02",
    category: "preprint",
    topics: ["telehealth", "cesarean", "exercise", "fitness"],
    prompt:
      "A 2026 Research Square preprint reports a randomized controlled trial, registered in the Clinical Trial Registry of India, of a telehealth exercise programme against a control group in mothers who had delivered by caesarean section, assessing physical fitness and mental health. How many post-cesarean mothers were randomly divided into groups, and what is the first figure of the pair printed for the telehealth exercise group (group A) on the one-minute sit-up test? Cite the record you found, and give its id exactly as the database shows it. Finish your reply with one line in EXACTLY this format and nothing else on that line:\n`ANSWER — record: <id> | mothers: <number> | group a sit-up: <value>`",
    answerKey: {
      kind: "values",
      expected: ["record: PPR1261422", "mothers: 35", "group a sit-up: 5.28"],
      source: {
        database: "europepmc",
        id: "PPR1261422",
        quote: "This randomized controlled trial was conducted on 35 post-cesarean mothers who randomly divided into 2 groups. … one-minute sit-up (A:5.28 + 2.44, B:1.18 + 1.38)",
      },
    },
    retrievalOnly: true,
    beyondPubmed: true,
    verified: true,
  },
  {
    id: "t-preprint-03",
    category: "preprint",
    topics: ["warm-up", "stretching", "treadmill", "oxygen consumption"],
    prompt:
      "A 2026 Research Square preprint reports a randomized controlled trial in active participants that compared a specific warm-up with static stretching before a 5 km treadmill run, looking at cardiovascular response and oxygen consumption. How many participants were randomly assigned in total, and what heart rate in beats per minute is reported for the specific warm-up group (the value before the plus-minus sign)? Cite the record you found, and give its id exactly as the database shows it. Finish your reply with one line in EXACTLY this format and nothing else on that line:\n`ANSWER — record: <id> | randomized: <number> | warm-up group heart rate: <value>`",
    answerKey: {
      kind: "values",
      expected: ["record: PPR1185294", "randomized: 20", "warm-up group heart rate: 170.50"],
      source: {
        database: "europepmc",
        id: "PPR1185294",
        quote: "twenty active participants were randomly assigned … Peak cardiovascular responses were mostly similar, except heart rate, which was significantly higher in the warm-up group (170.50",
      },
    },
    retrievalOnly: true,
    beyondPubmed: true,
    verified: true,
  },
  {
    id: "t-preprint-04",
    category: "preprint",
    topics: ["sarcopenia", "anti-inflammatory diet", "exercise", "older"],
    prompt:
      "A 2026 Research Square preprint reports a prospective, parallel-group randomized controlled trial of a 12-week intervention in hospitalized older patients with sarcopenia and acute infections, comparing an anti-inflammatory diet, exercise, exercise combined with the anti-inflammatory diet, and exercise combined with a high-protein diet. How many patients were randomized into the four groups, and how many patients completed the trial? Cite the record you found, and give its id exactly as the database shows it. Finish your reply with one line in EXACTLY this format and nothing else on that line:\n`ANSWER — record: <id> | randomized: <number> | completed: <number>`",
    answerKey: {
      kind: "values",
      expected: ["record: PPR1287151", "randomized: 200", "completed: 193"],
      source: {
        database: "europepmc",
        id: "PPR1287151",
        quote: "200 older sarcopenic patients were screened and subsequently randomized (1:1:1:1) into four groups for a 12-week intervention … A total of 193 patients completed the trial.",
      },
    },
    retrievalOnly: true,
    beyondPubmed: true,
    verified: true,
  },
  {
    id: "t-preprint-05",
    category: "preprint",
    topics: ["paravertebral", "thoracoscopic", "nerve block", "ultrasound"],
    prompt:
      "A 2026 Research Square preprint reports a randomized controlled trial in patients undergoing uniport video-assisted thoracoscopic surgery that compared a thoracoscopic-guided with an ultrasound-guided thoracic paravertebral nerve block, with postoperative pain on a visual analog scale as the primary outcome. How many patients were randomly assigned to the thoracoscopic-guided group, and what was that group's procedure duration in seconds (the value before the plus-minus sign)? Cite the record you found, and give its id exactly as the database shows it. Finish your reply with one line in EXACTLY this format and nothing else on that line:\n`ANSWER — record: <id> | randomized to thoracoscopic group: <number> | procedure duration: <value>`",
    answerKey: {
      kind: "values",
      expected: ["record: PPR1340798", "randomized to thoracoscopic group: 41", "procedure duration: 138.05"],
      source: {
        database: "europepmc",
        id: "PPR1340798",
        quote: "Patients undergoing uni-VATS were randomly assigned to either the TSG-TPVB group (n = 41) … the TSG-TPVB group had a significantly shorter procedure duration (138.05",
      },
    },
    retrievalOnly: true,
    beyondPubmed: true,
    verified: true,
  },
  {
    id: "t-preprint-06",
    category: "preprint",
    topics: ["basketball", "interval training", "sedentary", "body composition"],
    prompt:
      "A 2026 Research Square preprint reports an eight-week randomized controlled trial in sedentary young adults that compared heart-rate-matched basketball small-sided games, high-intensity interval training and a blank control group, with body composition, cardiovascular indices and physical performance as outcomes. How many sedentary young adults were allocated in total, and by how many mmHg did systolic blood pressure fall in the small-sided-games group? Cite the record you found, and give its id exactly as the database shows it. Finish your reply with one line in EXACTLY this format and nothing else on that line:\n`ANSWER — record: <id> | allocated: <number> | small-sided games group sbp fall: <value>`",
    answerKey: {
      kind: "values",
      expected: ["record: PPR1341477", "allocated: 90", "small-sided games group sbp fall: 3.17"],
      source: {
        database: "europepmc",
        id: "PPR1341477",
        quote: "Ninety eligible sedentary young adults (age: 20.13 ± 0.75 years) were equally allocated … systolic blood pressure (SBP) by 3.17 mmHg",
      },
    },
    retrievalOnly: true,
    beyondPubmed: true,
    verified: true,
  },
  {
    id: "t-preprint-07",
    category: "preprint",
    topics: ["suicide attempt", "psychological", "depression", "impulsivity"],
    prompt:
      "A 2026 Research Square preprint reports a randomized controlled trial at two tertiary hospitals in Barcelona of an eight-session multicomponent psychological intervention (SAMIT) against treatment as usual in patients hospitalized after a medically serious suicide attempt, with self-reported affective symptoms, suicidality-related measures and impulsivity as outcomes. How many patients were randomized, and what is the β coefficient printed for depression symptomatology in the intervention group (with its sign)? Cite the record you found, and give its id exactly as the database shows it. Finish your reply with one line in EXACTLY this format and nothing else on that line:\n`ANSWER — record: <id> | randomized: <number> | depression beta: <value>`",
    answerKey: {
      kind: "values",
      expected: ["record: PPR1323175", "randomized: 75", "depression beta: -2.80"],
      source: {
        database: "europepmc",
        id: "PPR1323175",
        quote: "Of 189 patients assessed for eligibility, 75 were randomized, and 54 completed the study. … observing a decrease of depression symptomatology (  β  , -2.80",
      },
    },
    retrievalOnly: true,
    beyondPubmed: true,
    verified: true,
  },
  {
    id: "t-preprint-08",
    category: "preprint",
    topics: ["acceptance and commitment therapy", "wives", "military", "ptsd"],
    prompt:
      "A 2026 Research Square preprint reports a randomized controlled trial in Yazd, Iran, of seven weekly group sessions of Acceptance and Commitment Therapy against a wait-list control in wives of military personnel with clinically significant post-traumatic stress disorder, with marital functioning, emotion regulation difficulties and secondary traumatic stress symptoms as outcomes. How many wives were randomly assigned in total, and what F value (the number after the equals sign, not the degrees of freedom in brackets) did the abstract give for the group-by-time interaction on marital functioning? Cite the record you found, and give its id exactly as the database shows it. Finish your reply with one line in EXACTLY this format and nothing else on that line:\n`ANSWER — record: <id> | wives: <number> | marital functioning f value: <value>`",
    answerKey: {
      kind: "values",
      expected: ["record: PPR1288399", "wives: 52", "marital functioning f value: 186.90"],
      source: {
        database: "europepmc",
        id: "PPR1288399",
        quote: "Fifty-two wives of military personnel with clinically significant PTSD were recruited and randomly assigned to either an ACT intervention group (n = 26) or a wait-list control group (n = 26). … Significant group × time interaction effects were found for marital functioning, F(1.65, 82.40) = 186.90",
      },
    },
    retrievalOnly: true,
    beyondPubmed: true,
    verified: true,
  },
  {
    id: "t-preprint-09",
    category: "preprint",
    topics: ["cocoa pod ash", "heavy metal", "vegetable", "amaranthus"],
    prompt:
      "A 2026 Research Square preprint reports a randomized controlled trial with a split-plot design in Nigeria, in which vegetable farmers took part in an environmental education programme and pots of the leafy vegetable Amaranthus hybridus were treated with cocoa pod ash or goat manure at three application rates, to reduce lead and chromium bioavailability. How many vegetable farmers took part, and what was the lowest lead and chromium concentration in the vegetable, in mg/kg (the abstract gives one figure for both metals), reached with cocoa pod ash at the highest application rate? Cite the record you found, and give its id exactly as the database shows it. Finish your reply with one line in EXACTLY this format and nothing else on that line:\n`ANSWER — record: <id> | farmers: <number> | lowest pb and cr concentration: <value>`",
    answerKey: {
      kind: "values",
      expected: ["record: PPR1261452", "farmers: 140", "lowest pb and cr concentration: 0.050"],
      source: {
        database: "europepmc",
        id: "PPR1261452",
        quote: "A randomized controlled trial with a split-plot experimental design was employed, involving 140 vegetable farmers who participated in an environmental education programme. … achieving the lowest concentrations (0.050 Mg/kg for both metals)",
      },
    },
    retrievalOnly: true,
    beyondPubmed: true,
    verified: true,
  },
  {
    id: "t-preprint-10",
    category: "preprint",
    topics: ["hemorrhoid", "liposomal bupivacaine", "infiltration", "pain"],
    prompt:
      "A 2026 Research Square preprint reports a randomized trial after mixed hemorrhoid surgery that compared perianal infiltration with a modified multimodal cocktail of ropivacaine, dexamethasone, magnesium sulfate and sodium bicarbonate against liposomal bupivacaine, for early pain control and recovery. How many patients were assigned in total, and what is the first of the two adjusted mean differences in numeric rating scale pain score that the abstract prints for the modified cocktail against liposomal bupivacaine (with its sign, as printed)? Cite the record you found, and give its id exactly as the database shows it. Finish your reply with one line in EXACTLY this format and nothing else on that line:\n`ANSWER — record: <id> | patients: <number> | first mean difference: <value>`",
    answerKey: {
      kind: "values",
      expected: ["record: PPR1328967", "patients: 360", "first mean difference: -0.86"],
      source: {
        database: "europepmc",
        id: "PPR1328967",
        quote: "360 patients were assigned 1:1 to perianal infiltration with LB or a modified cocktail containing ropivacaine, dexamethasone, magnesium sulfate, and sodium bicarbonate. … Adjusted scores were lower with the modified cocktail at 6 and 12 h (mean differences,−0.86 and−0.61",
      },
    },
    retrievalOnly: true,
    beyondPubmed: true,
    verified: true,
  },
  {
    id: "t-preprint-11",
    category: "preprint",
    topics: ["milk", "asthma", "atopic sensitization", "children"],
    prompt:
      "A 2026 medRxiv preprint reports the early-terminated randomized, blinded trial in Germany in which children recruited through birth clinics at 6 to 12 months of age received minimally processed full-cream cow's milk or ultra-heat-treated semi-skimmed cow's milk daily until age 3 years; its primary endpoint was atopic sensitization at age 3. How many individuals were randomized into each study arm, and what risk ratio did the abstract give for the intervention and atopic sensitization? Cite the record you found, and give its id exactly as the database shows it. Finish your reply with one line in EXACTLY this format and nothing else on that line:\n`ANSWER — record: <id> | randomized per arm: <number> | atopic sensitization risk ratio: <value>`",
    answerKey: {
      kind: "values",
      expected: ["record: PPR1349155", "randomized per arm: 130", "atopic sensitization risk ratio: 1.13"],
      source: {
        database: "europepmc",
        id: "PPR1349155",
        quote: "We randomized 130 individuals into each study arm. The intervention was unrelated to atopic sensitization (risk ratio, RR=1.13",
      },
    },
    retrievalOnly: true,
    beyondPubmed: true,
    verified: true,
  },
  {
    id: "t-preprint-12",
    category: "preprint",
    topics: ["oxygen", "altitude", "depression", "migrants"],
    prompt:
      "A 2026 Research Square preprint reports a randomized controlled trial in university students who had migrated from low altitude to Lhasa, in which micro-pressure oxygen, diffuse oxygen supply, nasal cannula oxygen or no intervention was given for 20 days, with depression on the Symptom Checklist-90 as the primary psychological outcome. How many students were allocated to the four groups, and what mean difference in the pre-post change in depression score against the control group (with its sign, as printed) did the abstract give for micro-pressure oxygen? Cite the record you found, and give its id exactly as the database shows it. Finish your reply with one line in EXACTLY this format and nothing else on that line:\n`ANSWER — record: <id> | students allocated: <number> | micro-pressure oxygen depression difference: <value>`",
    answerKey: {
      kind: "values",
      expected: ["record: PPR1295907", "students allocated: 80", "micro-pressure oxygen depression difference: -5.55"],
      source: {
        database: "europepmc",
        id: "PPR1295907",
        quote: "80 eligible university students who had migrated from low-altitude areas to Lhasa (3650 m) were allocated in a 1:1:1:1 ratio to micro-pressure oxygen, diffuse oxygen supply, nasal cannula oxygen, or no-intervention control. … the mean differences in pre–post changes in depression scores were − 5.55 points for micro-pressure oxygen",
      },
    },
    retrievalOnly: true,
    beyondPubmed: true,
    verified: true,
  },
  // ─── regional · cba ───
  {
    id: "t-regional-01",
    category: "regional",
    topics: ["adefovir", "dipivoxil", "pharmacokinetics", "volunteers"],
    prompt:
      "A Chinese Biological Abstracts record (indexed in Europe PMC, with no journal given) reports a pharmacokinetic study of oral adefovir dipivoxil tablets in healthy Chinese volunteers: a randomized cross-over study of single doses of 5, 10 and 30 mg, and a second part in which other volunteers took 10 mg of the drug or placebo once a day for 6 days. How many healthy volunteers were enrolled in all, and what maximum plasma concentration (c max, in µg/L, the value before the plus-minus sign) was reported after the 30 mg dose? Cite the record you found, and give its id exactly as the database shows it. Finish your reply with one line in EXACTLY this format and nothing else on that line:\n`ANSWER — record: <id> | volunteers: <number> | cmax at 30 mg: <value>`",
    answerKey: {
      kind: "values",
      expected: ["record: CBA:633654", "volunteers: 27", "cmax at 30 mg: 76"],
      source: {
        database: "europepmc",
        id: "CBA:633654",
        quote: "All together 27 healthy volunteers were enrolled. … c_(max) were (11   ±4), (25   ± 8) and (76   ± 23)",
      },
    },
    retrievalOnly: true,
    beyondPubmed: true,
    verified: true,
  },
  {
    id: "t-regional-02",
    category: "regional",
    topics: ["stat3", "ventricle", "hypertension", "rats"],
    prompt:
      "A 2005 article in the Chinese Journal of Pathophysiology studied the role of Stat3 in the hypertrophic left ventricle of rats with Goldblatt renovascular hypertension; the rats were randomized to no treatment, spironolactone, valsartan, or both drugs, and sham-operated rats served as controls. How many rats were in the spironolactone treatment group, and how many were in the untreated hypertension group? Cite the record you found, and give its id exactly as the database shows it. Finish your reply with one line in EXACTLY this format and nothing else on that line:\n`ANSWER — record: <id> | spironolactone group: <number> | untreated group: <number>`",
    answerKey: {
      kind: "values",
      expected: ["record: CBA:618117", "spironolactone group: 12", "untreated group: 11"],
      source: {
        database: "europepmc",
        id: "CBA:618117",
        quote: "The rats were randomized to untreated hypertension group (group H, n = 11), spironolactone treatment group (group S, n = 12)",
      },
    },
    retrievalOnly: true,
    beyondPubmed: true,
    verified: true,
  },
  {
    id: "t-regional-03",
    category: "regional",
    topics: ["riboflavin", "glutathione", "reductase", "radar"],
    prompt:
      "A 1992 article in Di 3 jun yi da xue xue bao (Acta Academiae Medicinae Militaris Tertiae) randomized radar operators working in low illumination to groups with four different daily riboflavin intakes and examined the blood glutathione reductase activity coefficient (BGR-AC) as a guide to their riboflavin status. How many subjects were randomized, and up to what BGR-AC value did the study consider riboflavin status normal? Cite the record you found, and give its id exactly as the database shows it. Finish your reply with one line in EXACTLY this format and nothing else on that line:\n`ANSWER — record: <id> | subjects: <number> | bgr-ac limit: <value>`",
    answerKey: {
      kind: "values",
      expected: ["record: CBA:483826", "subjects: 28", "bgr-ac limit: 1.24"],
      source: {
        database: "europepmc",
        id: "CBA:483826",
        quote: "The 28 subjects were randomized into 4 groups … when BGR-AC is smaller than equal to 1.24",
      },
    },
    retrievalOnly: true,
    beyondPubmed: true,
    verified: true,
  },
  {
    id: "t-regional-04",
    category: "regional",
    topics: ["pravastatin", "myocardial", "infarction", "sCD40L"],
    prompt:
      "A 2003 article in Zhonghua Xin Xue Guan Bing Za Zhi randomized patients with acute myocardial infarction to pravastatin 40 mg per day for 3 days or to no lipid-lowering drugs and measured plasma sCD40L, MMP-9 and CRP. How many patients were randomized in total, and by what percentage did pravastatin decrease the plasma sCD40L level? Cite the record you found, and give its id exactly as the database shows it. Finish your reply with one line in EXACTLY this format and nothing else on that line:\n`ANSWER — record: <id> | patients: <number> | scd40l decrease: <percent>`",
    answerKey: {
      kind: "values",
      expected: ["record: CBA:584273", "patients: 35", "scd40l decrease: 38"],
      source: {
        database: "europepmc",
        id: "CBA:584273",
        quote: "Thirty-five patients of acute myocardial infarction were randomized … Plasma levels of sCD40L, MMP-9 and CRP were significantly decreased 38%,48%,33% by pravastatin, respectively",
      },
    },
    retrievalOnly: true,
    beyondPubmed: true,
    verified: true,
  },
  {
    id: "t-regional-05",
    category: "regional",
    topics: ["shangke", "quyu", "traumatic", "swelling"],
    prompt:
      "A 2005 article in the Journal of Guangzhou University of Traditional Chinese Medicine randomized patients with acute traumatic swelling and pain of soft tissue in the limbs (Qi-stagnation and blood-stasis syndrome) to Shangke Quyu Tablet or Tongxuekang Capsules after fracture reduction and dislocation fixation. How many cases were randomized in total, and how many cases in the Shangke Quyu Tablet group were markedly improved after 10 days of treatment? Cite the record you found, and give its id exactly as the database shows it. Finish your reply with one line in EXACTLY this format and nothing else on that line:\n`ANSWER — record: <id> | cases: <number> | markedly improved: <number>`",
    answerKey: {
      kind: "values",
      expected: ["record: CBA:521552", "cases: 246", "markedly improved: 116"],
      source: {
        database: "europepmc",
        id: "CBA:521552",
        quote: "Two hundred and forty-six cases of traumatic injury in four limbs, which were classified to Qi-stagnation and blood-stasis syndrome, were randomized to two groups. … In group A, 116 cases were markedly improved",
      },
    },
    retrievalOnly: true,
    beyondPubmed: true,
    verified: true,
  },
  {
    id: "t-regional-06",
    category: "regional",
    topics: ["mice", "growth", "fecundity", "nih"],
    prompt:
      "A 2002 article in the Chinese Journal of Laboratory Animal Science observed the growth and fecundity of NIH mice, with cages of mice randomized to two arrangements: a seed mouse nursing eight young mice (group 1) or ten young mice (group 2). How many cages of mice were randomized, and by how many grams was the average weight of the young mice greater in group 1 than in group 2? Cite the record you found, and give its id exactly as the database shows it. Finish your reply with one line in EXACTLY this format and nothing else on that line:\n`ANSWER — record: <id> | cages: <number> | weight difference: <value>`",
    answerKey: {
      kind: "values",
      expected: ["record: CBA:377764", "cages: 20", "weight difference: 1.74"],
      source: {
        database: "europepmc",
        id: "CBA:377764",
        quote: "20 cages of mice were randomized for the observation … The average weight of young mice was 1.74g more",
      },
    },
    retrievalOnly: true,
    beyondPubmed: true,
    verified: true,
  },
  {
    id: "t-regional-07",
    category: "regional",
    topics: ["ventilation", "respiratory", "failure", "obstructive"],
    prompt:
      "A randomized controlled study held in a Chinese Biological Abstracts record that gives no journal compared invasive ventilation through an endotracheal tube with non-invasive face mask ventilation in patients with severe respiratory failure from acute exacerbations of chronic obstructive pulmonary disease treated in an emergency and a respiratory intensive care unit. How many patients were enrolled, and what was the intubation rate (in percent) in the face mask ventilation group? Cite the record you found, and give its id exactly as the database shows it. Finish your reply with one line in EXACTLY this format and nothing else on that line:\n`ANSWER — record: <id> | patients: <number> | intubation rate: <percent>`",
    answerKey: {
      kind: "values",
      expected: ["record: CBA:636489", "patients: 52", "intubation rate: 44"],
      source: {
        database: "europepmc",
        id: "CBA:636489",
        quote: "Fifty-two AECOPD patients with severe respiratory failure in EICU and RICU were enrolled and randomly divided into 2 groups … The rate for intubation was 44 % in group FMMV",
      },
    },
    retrievalOnly: true,
    beyondPubmed: true,
    verified: true,
  },
  {
    id: "t-regional-08",
    category: "regional",
    topics: ["dietary", "fat", "vitamin", "cold"],
    prompt:
      "A 1996 article in Ying Yang Xue Bao (Acta Nutrimenta Sinica) randomized recruits in a cold area to three diets, low fat, high fat, or high fat with 200 mg per day of vitamin E (group HFE), and measured the red blood cell membrane Na,K-ATPase activity, which the abstract prints as two values per group separated by a slash. How many recruits were randomized, and what was the second of the two Na,K-ATPase activity values that the abstract prints for the HFE group (the one after the slash, the number before its plus-minus sign, in micromoles per mg protein per hour)? Cite the record you found, and give its id exactly as the database shows it. Finish your reply with one line in EXACTLY this format and nothing else on that line:\n`ANSWER — record: <id> | recruits: <number> | hfe second value: <value>`",
    answerKey: {
      kind: "values",
      expected: ["record: CBA:298870", "recruits: 60", "hfe second value: 0.7219"],
      source: {
        database: "europepmc",
        id: "CBA:298870",
        quote: "60 recruits in cold area were randomized into three groups … HFE 0.1862±0.1216/0.7219±0.2190",
      },
    },
    retrievalOnly: true,
    beyondPubmed: true,
    verified: true,
  },
  // ─── regional · chinaxiv ───
  {
    id: "t-regional-09",
    category: "regional",
    topics: ["gouty", "arthritis", "moxibustion", "rats"],
    prompt:
      "A preprint posted on ChinaXiv in 2022 reports an experiment in rats with acute gouty arthritis (induced by injecting sodium urate suspension into the ankle joint) that compared blood-letting therapy, Zhuang-medicine thread moxibustion, and the two combined with colchicine and with an untreated model group, looking at the TLRs/MyD88 signaling pathway. How many rats were randomly divided into groups in total, and how many rats were in each group? Cite the record you found, and give its id exactly as the database shows it. Finish your reply with one line in EXACTLY this format and nothing else on that line:\n`ANSWER — record: <id> | rats: <number> | rats per group: <number>`",
    answerKey: {
      kind: "values",
      expected: ["record: chinaxiv-202211.00264", "rats: 60", "rats per group: 10"],
      source: {
        database: "chinaxiv",
        id: "chinaxiv-202211.00264",
        quote: "Sixty SD rats were randomly divided into 6 groups: blank group, model group, blood-letting group, medicine thread group, colchicine group, and blood-letting combined with medicine thread group, with 10 rats in each group.",
      },
    },
    retrievalOnly: true,
    beyondPubmed: true,
    verified: true,
  },
  {
    id: "t-regional-10",
    category: "regional",
    topics: ["benzbromarone", "bicarbonate", "hyperuricemia", "hypertension"],
    prompt:
      "A preprint posted on ChinaXiv in 2017 reports a clinical study of benzbromarone, sodium bicarbonate, and the two together in patients who have hyperuricemia complicated by essential hypertension, in which patients were allocated to groups with a random number table and treated for 5 weeks. How many patients were enrolled in total, and how many patients were in each group? Cite the record you found, and give its id exactly as the database shows it. Finish your reply with one line in EXACTLY this format and nothing else on that line:\n`ANSWER — record: <id> | patients: <number> | patients per group: <number>`",
    answerKey: {
      kind: "values",
      expected: ["record: chinaxiv-201712.00056", "patients: 126", "patients per group: 42"],
      source: {
        database: "chinaxiv",
        id: "chinaxiv-201712.00056",
        quote: "A total of 126 patients with hyperuricemia and essential hypertension were enrolled and divided into group A, group B, and group C using the random number table method, with 42 patients in each group.",
      },
    },
    retrievalOnly: true,
    beyondPubmed: true,
    verified: true,
  },
  {
    id: "t-regional-11",
    category: "regional",
    topics: ["nursing", "blood", "collection", "phlebotomy"],
    prompt:
      "A preprint posted on ChinaXiv in 2022 compared high-quality nursing with routine nursing for patients having blood drawn in the phlebotomy room of a hospital outpatient department, with patients divided into two groups by a random number table. How many patients were divided into the two groups in total, and what blood collection success rate (in percent) did the high-quality nursing group reach? Cite the record you found, and give its id exactly as the database shows it. Finish your reply with one line in EXACTLY this format and nothing else on that line:\n`ANSWER — record: <id> | patients: <number> | success rate: <percent>`",
    answerKey: {
      kind: "values",
      expected: ["record: chinaxiv-202209.00093", "patients: 130", "success rate: 98.5"],
      source: {
        database: "chinaxiv",
        id: "chinaxiv-202209.00093",
        quote: "A total of 130 patients who received blood collection in the phlebotomy room of our hospital from May 2020 to May 2022 were selected as study subjects. … The blood collection success rate in the observation group (98.5%)",
      },
    },
    retrievalOnly: true,
    beyondPubmed: true,
    verified: true,
  },
  {
    id: "t-regional-12",
    category: "regional",
    topics: ["core", "stability", "back", "pain"],
    prompt:
      "A postprint posted on ChinaXiv in 2022 reports a randomized comparison in male patients with chronic nonspecific low back pain of a core stability rehabilitation training system developed by the research team against core stability training on a traditional physical therapy bed with a Bobath ball, each lasting 6 weeks. How many male patients were enrolled, and how many were in the experimental group that used the new training system? Cite the record you found, and give its id exactly as the database shows it. Finish your reply with one line in EXACTLY this format and nothing else on that line:\n`ANSWER — record: <id> | patients: <number> | experimental group: <number>`",
    answerKey: {
      kind: "values",
      expected: ["record: chinaxiv-202208.00137", "patients: 21", "experimental group: 11"],
      source: {
        database: "chinaxiv",
        id: "chinaxiv-202208.00137",
        quote: "Twenty-one male CNLBP patients were enrolled as study subjects and randomly divided into an experimental group (n=11) and a control group (n=10).",
      },
    },
    retrievalOnly: true,
    beyondPubmed: true,
    verified: true,
  },
  {
    id: "t-regional-13",
    category: "regional",
    topics: ["schizophrenia", "cognitive", "compensation", "mobile"],
    prompt:
      "A preprint posted on ChinaXiv in 2025 reports a randomized trial in patients with stable-phase schizophrenia of 12 weeks of cognitive compensation training delivered through a mobile medical application on top of conventional treatment, against conventional treatment with regular follow-up alone, with the Brief Assessment of Cognition in Schizophrenia (BACS) and the Schizophrenia Quality of Life Scale (SQLS) as outcomes. How many patients were enrolled and randomly allocated in total, and what indirect effect (the point estimate, with its sign) did the mediation analysis report for the BACS scores on the association between group assignment and SQLS scores? Cite the record you found, and give its id exactly as the database shows it. Finish your reply with one line in EXACTLY this format and nothing else on that line:\n`ANSWER — record: <id> | patients: <number> | indirect effect: <value>`",
    answerKey: {
      kind: "values",
      expected: ["record: chinaxiv-202504.00236", "patients: 58", "indirect effect: -0.240"],
      source: {
        database: "chinaxiv",
        id: "chinaxiv-202504.00236",
        quote: "Fifty-eight patients with stable-phase schizophrenia treated at Ningxia Ning'an Hospital between June and December 2023 were enrolled and randomly allocated … indirect effect = -0.240",
      },
    },
    retrievalOnly: true,
    beyondPubmed: true,
    verified: true,
  },
  {
    id: "t-regional-14",
    category: "regional",
    topics: ["valproate", "oxcarbazepine", "levetiracetam", "epilepsy"],
    prompt:
      "A preprint posted on ChinaXiv in 2023 compared sodium valproate, oxcarbazepine and levetiracetam in children with newly presenting focal epilepsy, with the children divided into drug groups by a random number table and their development assessed with the Chinese version of the Griffiths Mental Development Scales before and after 6 months of treatment. How many children with focal epilepsy were divided into the drug groups, and what was the total effective rate (in percent) of clinical efficacy in the sodium valproate group? Cite the record you found, and give its id exactly as the database shows it. Finish your reply with one line in EXACTLY this format and nothing else on that line:\n`ANSWER — record: <id> | children: <number> | valproate efficacy rate: <percent>`",
    answerKey: {
      kind: "values",
      expected: ["record: chinaxiv-202304.00977", "children: 83", "valproate efficacy rate: 92.3"],
      source: {
        database: "chinaxiv",
        id: "chinaxiv-202304.00977",
        quote: "A total of 83 children with focal epileptic seizures who presented to the pediatric neurology outpatient clinic and ward of the Third Affiliated Hospital of Zhengzhou University for the first time between January 2021 and April 2022 were selected as the experimental group and divided into VPA group (n=27), OXC group (n=28), and LEV group (n=28) using the random number table method. … The total effective rates of clinical efficacy in the VPA, OXC, and LEV groups were 92.3%, 89.3%, and 92.9%, respectively",
      },
    },
    retrievalOnly: true,
    beyondPubmed: true,
    verified: true,
  },
  {
    id: "t-regional-15",
    category: "regional",
    topics: ["electroacupuncture", "ischemia", "reperfusion", "rats"],
    prompt:
      "A postprint posted on ChinaXiv in 2023 reports an experiment in rats with learning and memory impairment after middle cerebral artery occlusion and reperfusion (MCAO/R), testing electroacupuncture at the Shenting and Baihui acupoints and looking at the BDNF/TrkB/PI3K/Akt pathway. How many rats with a successfully established MCAO/R model were then randomly assigned to the model group or the electroacupuncture group, and what was the cerebral infarct volume (in percent) in the model group? Cite the record you found, and give its id exactly as the database shows it. Finish your reply with one line in EXACTLY this format and nothing else on that line:\n`ANSWER — record: <id> | rats randomized: <number> | model infarct volume: <percent>`",
    answerKey: {
      kind: "values",
      expected: ["record: chinaxiv-202306.00164", "rats randomized: 24", "model infarct volume: 36.7"],
      source: {
        database: "chinaxiv",
        id: "chinaxiv-202306.00164",
        quote: "The 24 rats with successful model establishment were randomly assigned to a model group (n=12) and an electroacupuncture group (n=12). … Cerebral infarct volumes in the blank, sham operation, model, and electroacupuncture groups were 0, 0, (36.7±6.3)%",
      },
    },
    retrievalOnly: true,
    beyondPubmed: true,
    verified: true,
  },
  // ─── fulltext · bmj ───
  {
    id: "t-fulltext-01",
    category: "fulltext",
    topics: ["ciclesonide", "covid-19", "outpatients", "inhaled"],
    prompt:
      "The CONTAIN trial, a phase II randomised, double blind, placebo controlled trial published in the BMJ in 2021, compared inhaled plus intranasal ciclesonide for 14 days with placebo in adult outpatients with covid-19 in Canada. How many participants were in the modified intention-to-treat population that was analysed, and how many participants did the investigators estimate in their sample size calculation that they would need to enrol, both groups together? The second figure is given in the full text of the article, not in its abstract. Cite the PMID. Finish your reply with one line in EXACTLY this format and nothing else on that line:\n`ANSWER — PMID: <number> | analysed participants: <number> | planned enrolment: <number>`",
    answerKey: {
      kind: "values",
      expected: ["pmid: 34728476", "analysed participants: 203", "planned enrolment: 318"],
      source: {
        database: "pubmed",
        id: "34728476",
        quote: "The modified intention-to-treat population included 203 participants",
        fullTextQuote: "we estimated that 318 participants (159 in each group) would need to be enrolled",
      },
    },
    beyondPubmed: true,
    verified: true,
  },
  {
    id: "t-fulltext-02",
    category: "fulltext",
    topics: ["colorectal", "surgical site infection", "ornidazole", "antimicrobial prophylaxis"],
    prompt:
      "A multicentre, randomised, double blind, placebo controlled trial published in the BMJ in 2022 tested a single 1 g oral dose of ornidazole, added to intravenous antibiotic prophylaxis before elective colorectal surgery, against placebo for preventing surgical site infection in adults at university and non-university hospitals in France. How many patients were enrolled in the trial in total (before any withdrawals), and how many of them were randomly assigned to the ornidazole arm, again before any withdrawals? The second figure is given in the full text of the article, not in its abstract. Cite the PMID. Finish your reply with one line in EXACTLY this format and nothing else on that line:\n`ANSWER — PMID: <number> | enrolled: <number> | assigned to ornidazole: <number>`",
    answerKey: {
      kind: "values",
      expected: ["pmid: 36328372", "enrolled: 960", "assigned to ornidazole: 479"],
      source: {
        database: "pubmed",
        id: "36328372",
        quote: "Of the 960 patients who were enrolled, 926 (96%) were included in the analysis.",
        fullTextQuote: "960 patients provided informed consent and were enrolled in the trial: 479 were randomly assigned to oral prophylaxis and 481 to placebo.",
      },
    },
    beyondPubmed: true,
    verified: true,
  },
  {
    id: "t-fulltext-03",
    category: "fulltext",
    topics: ["dexamethasone", "total knee arthroplasty", "morphine consumption", "analgesic"],
    prompt:
      "A randomised, blinded, placebo controlled trial published in the BMJ in 2022 tested one or two intravenous doses of dexamethasone, against placebo, as an analgesic adjuvant to multimodal pain treatment after total knee arthroplasty in adults at Danish hospitals, with follow-up at 90 days. How many participants were randomised, and what total sample size did the investigators predefine in their sample size calculation? The second figure is given in the full text of the article, not in its abstract. Cite the PMID. Finish your reply with one line in EXACTLY this format and nothing else on that line:\n`ANSWER — PMID: <number> | randomized: <number> | predefined sample size: <number>`",
    answerKey: {
      kind: "values",
      expected: ["pmid: 34983775", "randomized: 485", "predefined sample size: 486"],
      source: {
        database: "pubmed",
        id: "34983775",
        quote: "485 participants were randomised: 161 to DX1, 162 to DX2, and 162 to placebo.",
        fullTextQuote: "Hence we predefined our sample size as 486 participants (including a surplus of 15% to take into account the presumed non-normally distributed data) to detect or reject a group difference of 10 mg of intravenous morphine with 90% power.",
      },
    },
    beyondPubmed: true,
    verified: true,
  },
  {
    id: "t-fulltext-04",
    category: "fulltext",
    topics: ["anterior cruciate ligament", "reconstruction", "rehabilitation", "knee"],
    prompt:
      "The COMPARE trial, an open labelled, multicentre, parallel randomised controlled trial published in the BMJ in 2021, compared early surgical reconstruction with rehabilitation followed by optional delayed reconstruction in patients aged 18 to 65 with an acute rupture of the anterior cruciate ligament in the Netherlands. How many patients were enrolled and randomised in total, and how many patients were eligible to participate in the study, counting those who declined? The second figure is given in the full text of the article, not in its abstract. Cite the PMID. Finish your reply with one line in EXACTLY this format and nothing else on that line:\n`ANSWER — PMID: <number> | randomized: <number> | eligible patients: <number>`",
    answerKey: {
      kind: "values",
      expected: ["pmid: 33687926", "randomized: 167", "eligible patients: 282"],
      source: {
        database: "pubmed",
        id: "33687926",
        quote: "Between May 2011 and April 2016, 167 patients were enrolled in the study and randomised to one of two treatments",
        fullTextQuote: "Between May 2011 and April 2016, 282 patients were eligible to participate in the study; 115 declined and so 167 patients were enrolled in the study",
      },
    },
    beyondPubmed: true,
    verified: true,
  },
  // ─── fulltext · plos-medicine ───
  {
    id: "t-fulltext-05",
    category: "fulltext",
    topics: ["venous thromboembolism", "anticoagulant", "recurrence", "prediction model"],
    prompt:
      "A pragmatic, unblinded randomized controlled trial published in PLOS Medicine in 2020 tested whether tailoring the duration of anticoagulant treatment with a recurrence risk prediction model (the Vienna Prediction Model) reduces recurrence in adults with unprovoked venous thromboembolism, compared with usual care, at local thrombosis services in the Netherlands. How many patients were randomized in total, and how many patients were deemed potentially eligible for inclusion? The second figure is given in the full text of the article, not in its abstract. Cite the PMID. Finish your reply with one line in EXACTLY this format and nothing else on that line:\n`ANSWER — PMID: <number> | randomized: <number> | potentially eligible: <number>`",
    answerKey: {
      kind: "values",
      expected: ["pmid: 32589630", "randomized: 883", "potentially eligible: 957"],
      source: {
        database: "pubmed",
        id: "32589630",
        quote: "In the total study population of 883 patients",
        fullTextQuote: "In total 957 patients were deemed potentially eligible for inclusion.",
      },
    },
    beyondPubmed: true,
    verified: true,
  },
  {
    id: "t-fulltext-06",
    category: "fulltext",
    topics: ["monoclonal antibody", "vaginal", "film", "pharmacokinetics"],
    prompt:
      "A Phase I randomized trial of a monoclonal antibody-based vaginal multipurpose prevention film (MB66), published in PLOS Medicine in 2021, enrolled healthy, sexually abstinent women in a single-dose segment (Segment A) followed by a randomized repeated-dose segment (Segment B) comparing the antibody film with a placebo film. In Segment B, how many women were randomly assigned to the antibody film or the placebo film, and how many women were screened to enroll them? The second figure is given in the full text of the article, not in its abstract. Cite the PMID. Finish your reply with one line in EXACTLY this format and nothing else on that line:\n`ANSWER — PMID: <number> | randomized in segment b: <number> | screened in segment b: <number>`",
    answerKey: {
      kind: "values",
      expected: ["pmid: 33534791", "randomized in segment b: 29", "screened in segment b: 47"],
      source: {
        database: "pubmed",
        id: "33534791",
        quote: "In Segment B, 29 women were randomly assigned to MB66 (Active) or Placebo film groups",
        fullTextQuote: "In Segment B, 47 women were screened to enroll 29 participants who were randomly assigned to either Active (n = 15) or Placebo (n = 14) film groups.",
      },
    },
    beyondPubmed: true,
    verified: true,
  },
  {
    id: "t-fulltext-07",
    category: "fulltext",
    topics: ["adherence clubs", "antiretroviral", "viral suppression", "retention"],
    prompt:
      "A cluster-randomized evaluation published in PLOS Medicine in 2019 tested adherence clubs, in which stable patients on antiretroviral therapy meet in groups outside usual clinic procedures to receive their medication, against standard care at primary healthcare facilities in four South African provinces, with facilities matched in pairs and randomly allocated to intervention or control. How many patients were enrolled in the adherence club intervention group, and how many subjects in total per intervention did the sample size calculation call for? The second figure is given in the full text of the article, not in its abstract. Cite the PMID. Finish your reply with one line in EXACTLY this format and nothing else on that line:\n`ANSWER — PMID: <number> | enrolled in club arm: <number> | sample size per intervention: <number>`",
    answerKey: {
      kind: "values",
      expected: ["pmid: 31335865", "enrolled in club arm: 275", "sample size per intervention: 576"],
      source: {
        database: "pubmed",
        id: "31335865",
        quote: "For ACs, 275 intervention and 294 control patients were enrolled",
        fullTextQuote: "we estimated we would need 24 subjects per clinic for each intervention (576 total).",
      },
    },
    beyondPubmed: true,
    verified: true,
  },
  {
    id: "t-fulltext-08",
    category: "fulltext",
    topics: ["integrative adapt therapy", "refugees", "cognitive behavioural therapy", "mental health"],
    prompt:
      "A single-blind randomized controlled trial published in PLOS Medicine in 2020 compared an Integrative Adapt Therapy with a multicomponent cognitive behavioural therapy, each given as six weekly sessions, for common mental health symptoms and adaptive stress in Chin, Kachin and Rohingya refugees from Myanmar living in Kuala Lumpur, Malaysia. How many participants were included in the intention-to-treat analysis, and how many people were assessed for eligibility for inclusion in the intervention study? The second figure is given in the full text of the article, not in its abstract. Cite the PMID. Finish your reply with one line in EXACTLY this format and nothing else on that line:\n`ANSWER — PMID: <number> | analysed participants: <number> | assessed for eligibility: <number>`",
    answerKey: {
      kind: "values",
      expected: ["pmid: 32231364", "analysed participants: 331", "assessed for eligibility: 1103"],
      source: {
        database: "pubmed",
        id: "32231364",
        quote: "an intention-to-treat analysis (n = 331)",
        fullTextQuote: "a random sample of 1,103 … were assessed for eligibility for inclusion in the intervention study",
      },
    },
    beyondPubmed: true,
    verified: true,
  },
  // ─── fulltext · jama-network-open ───
  {
    id: "t-fulltext-09",
    category: "fulltext",
    topics: ["diabetic foot ulcers", "wound healing", "absorbent dressing"],
    prompt:
      "A multicenter, evaluator-blinded, phase 3 randomized clinical trial published in JAMA Network Open in 2021 compared a topical cream presented as a macrophage-regulating drug with an absorbent dressing for diabetic foot ulcers in patients treated in the United States, China and Taiwan. How many patients were randomized, and what was the mean glycated hemoglobin (HbA1c) level, in percent, in the cream group at the end of treatment? The second figure is given in the full text of the article, not in its abstract. Cite the PMID. Finish your reply with one line in EXACTLY this format and nothing else on that line:\n`ANSWER — PMID: <number> | randomized: <number> | hba1c at end of treatment: <percent>`",
    answerKey: {
      kind: "values",
      expected: ["pmid: 34477854", "randomized: 236", "hba1c at end of treatment: 8.0"],
      source: {
        database: "pubmed",
        id: "34477854",
        quote: "In the FAS, 236 eligible patients (175 men [74.2%]; mean [SD] age, 57.0 [10.9] years; mean [SD] glycated hemoglobin level, 8.1% [1.6%]) with DFUs classified as Wagner grade 1 or 2 (mean [SD] ulcer area, 4.8 [4.4] cm2) were randomized to receive either the ON101 cream (n = 122) or the absorbent dressing (n = 114) for as long as 16 weeks.",
        fullTextQuote: "The mean (SD) HbA1c level was 8.1% (1.6%) at baseline and did not change significantly at the end of treatment (mean [SD] HbA1c of 8.0% [1.8%] in the ON101 group vs 7.9% [1.6%] in the comparator group)",
      },
    },
    beyondPubmed: true,
    verified: true,
  },
  {
    id: "t-fulltext-10",
    category: "fulltext",
    topics: ["urolithin", "muscle endurance", "mitochondrial", "older adults"],
    prompt:
      "A double-blind, placebo-controlled randomized clinical trial published in JAMA Network Open in 2022 gave older adults aged 65 to 90 years daily oral urolithin A or placebo for 4 months at two research sites in Seattle and measured muscle endurance and mitochondrial health. How many participants were randomized in total, and how many adults were screened for the trial? The second figure is given in the full text of the article, not in its abstract. Cite the PMID. Finish your reply with one line in EXACTLY this format and nothing else on that line:\n`ANSWER — PMID: <number> | randomized: <number> | screened: <number>`",
    answerKey: {
      kind: "values",
      expected: ["pmid: 35050355", "randomized: 66", "screened: 128"],
      source: {
        database: "pubmed",
        id: "35050355",
        quote: "A total of 66 participants were randomized to either the urolithin A (n = 33) or the placebo (n = 33) intervention group.",
        fullTextQuote: "Of the 128 adults aged 65 to 90 years screened for this trial, 66 (51.6%) were included and randomized to either the urolithin A (n = 33) or placebo (n = 33) intervention.",
      },
    },
    beyondPubmed: true,
    verified: true,
  },
  {
    id: "t-fulltext-11",
    category: "fulltext",
    topics: ["substance use", "screening", "brief intervention", "pediatric primary care"],
    prompt:
      "A pilot randomized clinical trial published in JAMA Network Open in 2019 tested a computer-facilitated substance use screening and brief intervention system, delivered by practitioners at the annual preventive health visit, against usual care among youths aged 12 to 18 years in pediatric primary care. How many youths took part in the trial in total, and how many patients were initially screened before any were invited to participate? The second figure is given in the full text of the article, not in its abstract. Cite the PMID. Finish your reply with one line in EXACTLY this format and nothing else on that line:\n`ANSWER — PMID: <number> | youths in trial: <number> | initially screened: <number>`",
    answerKey: {
      kind: "values",
      expected: ["pmid: 31225897", "youths in trial: 965", "initially screened: 1200"],
      source: {
        database: "pubmed",
        id: "31225897",
        quote: "An intent-to-treat pilot randomized clinical trial compared CSBI with UC among 965 youths aged 12 to 18 years at 5 pediatric primary care offices and 54 practitioners.",
        fullTextQuote: "Of 1200 patients initially screened, we invited 1098 (91.5%) to participate",
      },
    },
    beyondPubmed: true,
    verified: true,
  },
  {
    id: "t-fulltext-12",
    category: "fulltext",
    topics: ["patient portal", "well child care", "outreach", "messages"],
    prompt:
      "A three-group randomized clinical trial published in JAMA Network Open in 2022 tested electronic health record patient portal outreach messages (a standard message and a tailored message, against no message) to get children aged 6 to 17 years who were overdue for well child care to complete a visit, at academic primary care practices serving a predominantly non-Hispanic Black, low-income population. How many patients participated in the trial in total, and what total number of participants did the study's sample size calculation call for? The second figure is given in the full text of the article, not in its abstract. Cite the PMID. Finish your reply with one line in EXACTLY this format and nothing else on that line:\n`ANSWER — PMID: <number> | participants: <number> | planned sample size: <number>`",
    answerKey: {
      kind: "values",
      expected: ["pmid: 36399342", "participants: 945", "planned sample size: 879"],
      source: {
        database: "pubmed",
        id: "36399342",
        quote: "Participants were randomized to the standard message, tailored message, or no message (control) group. … Nine hundred forty-five patients participated",
        fullTextQuote: "we required a sample size of 293 per group (879 participants overall)",
      },
    },
    beyondPubmed: true,
    verified: true,
  },
  // ─── fulltext · bmc-medicine ───
  {
    id: "t-fulltext-13",
    category: "fulltext",
    topics: ["press releases", "news", "causality", "headlines"],
    prompt:
      "A randomised controlled trial published in BMC Medicine in 2019 tested whether aligning the headlines and main causal claims of health press releases with the strength of the underlying evidence, and adding explicit statements or caveats about inferring causality, changed how the resulting news stories were worded; its participants were press releases from UK press offices, allocated to four conditions (control, claim alignment, causality statement, both). How many press releases were included as participants, and in the full text's intention-to-treat analysis of the interaction with causality statements, what percentage of news headlines were estimated to be aligned with the evidence in the condition that received claim alignment only? The second figure is given in the full text of the article, not in its abstract. Cite the PMID. Finish your reply with one line in EXACTLY this format and nothing else on that line:\n`ANSWER — PMID: <number> | press releases: <number> | aligned headlines percent: <percent>`",
    answerKey: {
      kind: "values",
      expected: ["pmid: 31092248", "press releases: 312", "aligned headlines percent: 49"],
      source: {
        database: "pubmed",
        id: "31092248",
        quote: "The 'participants' were press releases on health-related topics (N = 312; control = 89, claim alignment = 64, causality statement = 79, both = 80)",
        fullTextQuote: "estimates for the conditions control, claim alignment, causality statement and both were 52%, 49%, 52% and 62%, respectively",
      },
    },
    beyondPubmed: true,
    verified: true,
  },
  {
    id: "t-fulltext-14",
    category: "fulltext",
    topics: ["performance-based financing", "facility financing", "primary health care", "nigeria"],
    prompt:
      "A large-scale cluster randomized controlled trial published in BMC Medicine in 2021 compared two reform packages for financing primary health care in Nigeria, performance-based financing and direct facility financing, with observable-matched control districts, on maternal and child health services. How many districts were randomly assigned to the two reform packages, and in how many health facilities was the programme implemented in the districts of the treated states? The second figure is given in the full text of the article, not in its abstract. Cite the PMID. Finish your reply with one line in EXACTLY this format and nothing else on that line:\n`ANSWER — PMID: <number> | districts randomized: <number> | facilities implementing: <number>`",
    answerKey: {
      kind: "values",
      expected: ["pmid: 34544415", "districts randomized: 52", "facilities implementing: 1389"],
      source: {
        database: "pubmed",
        id: "34544415",
        quote: "We sampled 571 facilities (269 in PBF; 302 in DFF) in 52 districts randomly assigned to PBF or DFF",
        fullTextQuote: "The program was implemented in 1389 facilities (PBF arm=709; DFF arm=680)",
      },
    },
    beyondPubmed: true,
    verified: true,
  },
  {
    id: "t-fulltext-15",
    category: "fulltext",
    topics: ["melatonin", "sleep", "traumatic brain injury", "crossover"],
    prompt:
      "A randomised, double-blind, placebo-controlled two-period crossover trial published in BMC Medicine in 2018 gave prolonged-release melatonin and placebo, each for 4 weeks, to outpatients with traumatic brain injury and sleep disturbances recruited at two hospitals in Melbourne, Australia. How many patients with traumatic brain injury made up the study sample, and how many individuals with traumatic brain injury were referred to the study? The second figure is given in the full text of the article, not in its abstract. Cite the PMID. Finish your reply with one line in EXACTLY this format and nothing else on that line:\n`ANSWER — PMID: <number> | study sample: <number> | referred: <number>`",
    answerKey: {
      kind: "values",
      expected: ["pmid: 29347988", "study sample: 33", "referred: 107"],
      source: {
        database: "pubmed",
        id: "29347988",
        quote: "They had mild to severe TBI (n = 33) reporting sleep disturbances post-injury",
        fullTextQuote: "Of the 107 TBI individuals referred to the study, 38 consented (Fig. 1)",
      },
    },
    beyondPubmed: true,
    verified: true,
  },
  {
    id: "t-fulltext-16",
    category: "fulltext",
    topics: ["hearing aids", "hearing loss", "rural china", "quality of life"],
    prompt:
      "A randomized controlled trial published in BMC Medicine in 2022 gave free hearing aids to middle-aged and older adults aged 45 and above with hearing loss in rural China and compared them with a control group receiving no intervention, using a difference-in-difference approach. How many participants did the trial's sample comprise in total, and how many of them were in the treatment group, the group prescribed hearing aids? The second figure is given in the full text of the article, not in its abstract. Cite the PMID. Finish your reply with one line in EXACTLY this format and nothing else on that line:\n`ANSWER — PMID: <number> | participants: <number> | treatment group: <number>`",
    answerKey: {
      kind: "values",
      expected: ["pmid: 35436911", "participants: 385", "treatment group: 150"],
      source: {
        database: "pubmed",
        id: "35436911",
        quote: "Trial outcomes for 385 participants were collected during the 20-month follow-up study.",
        fullTextQuote: "A total of 150 adults are from the treatment group, and 235 adults are from the control group.",
      },
    },
    beyondPubmed: true,
    verified: true,
  },
  // END beyond-pubmed
];
