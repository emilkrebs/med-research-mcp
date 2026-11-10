/**
 * The held-out set (split `test`): the queries the benchmark's reported numbers come from.
 *
 * GENERATED from the draw and the query writer's notes; see `scripts/sample-heldout.ts`
 * for how the trials were drawn and `heldout.sample.json` for what became of each candidate.
 *
 * Nothing may be tuned against these queries: not the server, not the skills, not the
 * scorer, not the prompts. Develop on `queries.data.ts`; run this set (`--publish`, or
 * `--split test`) to measure. If a change is ever made because of a result here, the set
 * is spent: draw a new one (the script explains how).
 *
 * Three kinds of query, all with ground truth:
 *
 *  - `lookup` — find one randomized trial, described without its PMID, and report two
 *    numbers from its abstract. The trials were DRAWN, not chosen: every PubMed record of a
 *    stratum was shuffled with a fixed seed, and a query was written for each candidate in
 *    that order, passing one over only for a listed reason. `test/heldout.test.ts` checks
 *    the queries against the draw. Strata: 12 clinical fields × 2 periods, three queries
 *    each where the candidates allowed.
 *      established — 2015–2022, NEJM / Lancet / JAMA / BMJ: trials a model may know from training;
 *      recent      — added to PubMed 2026-09-01…2026-10-31, any journal: `retrievalOnly`,
 *                    since no benchmarked model was trained on them. They age.
 *  - `control` — a real trial, asked about the way the fabricated ones are ("Summarize the
 *    2019 Surname trial of …"): one per field, the next trial in the established draw after
 *    the lookups. The right behavior is to summarize it, not to reject it.
 *  - `bullshit` — a study that does not exist, one matched to each control: the same form
 *    and field, with an author and a trial the field does not have. Each `probe` is a PubMed
 *    search that returned nothing when the query was written.
 *    Controls and fabricated studies are read as a pair of rates: a model that rejects
 *    everything gets every fabricated study right and every control wrong.
 *
 * Every `values` key names its PubMed record and quotes the passage of the abstract that
 * states the expected numbers; `npm run verify-keys` re-checks each quote and number
 * against the live record. Written 2026-11-10 from the abstracts alone.
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
  {
    id: "t-lookup-02",
    category: "lookup",
    specialty: "cardiology",
    topics: ["ferric carboxymaltose", "iron", "heart failure"],
    prompt:
      "The AFFIRM-AHF trial, published in The Lancet in 2020, randomized patients with iron deficiency who had been stabilised after an episode of acute heart failure to intravenous ferric carboxymaltose or placebo. How many patients were randomly assigned, and what rate ratio did it report for the primary composite of total hospitalisations for heart failure and cardiovascular death? Cite the PMID. Finish your reply with one line in EXACTLY this format and nothing else on that line:\n`ANSWER — PMID: <number> | randomly assigned: <number> | rate ratio: <value>`",
    answerKey: {
      kind: "values",
      expected: ["pmid: 33197395", "randomly assigned: 1132", "rate ratio: 0.79"],
      source: {
        database: "pubmed",
        id: "33197395",
        quote: "1132 patients were randomly assigned to study groups … 293 primary events (57·2 per 100 patient-years) occurred in the ferric carboxymaltose group and 372 (72·5 per 100 patient-years) occurred in the placebo group (rate ratio [RR] 0·79, 95% CI 0·62-1·01, p=0·059).",
      },
    },
    verified: true,
  },
  {
    id: "t-lookup-03",
    category: "lookup",
    specialty: "cardiology",
    topics: ["ertugliflozin", "diabetes"],
    prompt:
      "A multicenter, double-blind trial published in the New England Journal of Medicine in 2020 randomized patients with type 2 diabetes and atherosclerotic cardiovascular disease to ertugliflozin or placebo. How many patients underwent randomization, and what hazard ratio did it report for major adverse cardiovascular events? Cite the PMID. Finish your reply with one line in EXACTLY this format and nothing else on that line:\n`ANSWER — PMID: <number> | randomized: <number> | hazard ratio: <value>`",
    answerKey: {
      kind: "values",
      expected: ["pmid: 32966714", "randomized: 8246", "hazard ratio: 0.97"],
      source: {
        database: "pubmed",
        id: "32966714",
        quote: "A total of 8246 patients underwent randomization and were followed for a mean of 3.5 years. … (hazard ratio, 0.97; 95.6% confidence interval [CI], 0.85 to 1.11; P<0.001 for noninferiority).",
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
  {
    id: "t-lookup-05",
    category: "lookup",
    specialty: "cardiology",
    topics: ["ultrafiltration", "hemofiltration", "cardiopulmonary bypass"],
    prompt:
      "A randomized, outcome-assessor-blinded clinical trial published in the Journal of Extra-Corporeal Technology in 2026 compared conventional ultrafiltration with subzero balanced ultrafiltration combined with simple modified ultrafiltration (SBUF-SMUF) during cardiopulmonary bypass in children with congenital heart disease. How many patients were allocated in total, and what was the post-bypass hematocrit, in percent, in the SBUF-SMUF group? Cite the PMID. Finish your reply with one line in EXACTLY this format and nothing else on that line:\n`ANSWER — PMID: <number> | patients allocated: <number> | sbuf-smuf hematocrit percent: <percent>`",
    answerKey: {
      kind: "values",
      expected: ["pmid: 42743423", "patients allocated: 80", "sbuf-smuf hematocrit percent: 31.2"],
      source: {
        database: "pubmed",
        id: "42743423",
        quote: "80 pediatric patients with congenital heart disease were allocated to either CUF (n = 40) or SBUF-SMUF (n = 40) during CPB … Post-bypass hematocrit levels were higher (31.2% vs. 27.3%, p = 0.001) and extubation occurred earlier in the SBUF-SMUF group",
      },
    },
    retrievalOnly: true,
    verified: true,
  },
  {
    id: "t-lookup-06",
    category: "lookup",
    specialty: "cardiology",
    topics: ["cryoballoon", "atrial fibrillation"],
    prompt:
      "The CEPAF trial, a multicentre, randomized, open-label trial published in Europace in 2026, compared cryoballoon ablation with antiarrhythmic drug therapy as initial treatment for treatment-naive persistent atrial fibrillation. How many patients were assigned, and in what percentage of the patients assigned to cryoballoon ablation did recurrence occur between days 91 and 365 in the intention-to-treat population? Cite the PMID. Finish your reply with one line in EXACTLY this format and nothing else on that line:\n`ANSWER — PMID: <number> | patients assigned: <number> | cryoballoon recurrence percent: <percent>`",
    answerKey: {
      kind: "values",
      expected: ["pmid: 42677894", "patients assigned: 320", "cryoballoon recurrence percent: 18.8"],
      source: {
        database: "pubmed",
        id: "42677894",
        quote: "assigned 320 symptomatic, treatment-naive patients with PersAF (1:1) to CBA or AAD therapy … recurrence during days 91-365 occurred in 30/160 (18.8%) patients assigned to CBA",
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
  {
    id: "t-lookup-08",
    category: "lookup",
    specialty: "oncology",
    topics: ["myeloma", "transplantation", "lenalidomide"],
    prompt:
      "A phase 3 trial published in the New England Journal of Medicine in 2022 randomly assigned adults with newly diagnosed multiple myeloma to lenalidomide, bortezomib and dexamethasone (RVD) alone or to RVD plus high-dose melphalan and autologous stem-cell transplantation, each followed by lenalidomide maintenance until disease progression. How many patients were in the RVD-alone group, and what hazard ratio for disease progression or death did it report for the RVD-alone group compared with the transplantation group? Cite the PMID. Finish your reply with one line in EXACTLY this format and nothing else on that line:\n`ANSWER — PMID: <number> | rvd-alone group patients: <number> | hazard ratio: <value>`",
    answerKey: {
      kind: "values",
      expected: ["pmid: 35660812", "rvd-alone group patients: 357", "hazard ratio: 1.53"],
      source: {
        database: "pubmed",
        id: "35660812",
        quote: "Among 357 patients in the RVD-alone group and 365 in the transplantation group, at a median follow-up of 76.0 months, 328 events of disease progression or death occurred; the risk was 53% higher in the RVD-alone group than in the transplantation group (hazard ratio, 1.53; 95% confidence interval [CI], 1.23 to 1.91; P<0.001)",
      },
    },
    verified: true,
  },
  {
    id: "t-lookup-09",
    category: "lookup",
    specialty: "oncology",
    topics: ["colorectal", "follow-up"],
    prompt:
      "The COLOFOL randomized clinical trial, published in JAMA in 2018, compared more frequent with less frequent follow-up testing with computed tomography and carcinoembryonic antigen after curative surgery for stage II or III colorectal cancer. How many patients were randomized, and what was the 5-year overall mortality rate, in percent, in the high-frequency follow-up group? Cite the PMID. Finish your reply with one line in EXACTLY this format and nothing else on that line:\n`ANSWER — PMID: <number> | randomized: <number> | high-frequency mortality percent: <percent>`",
    answerKey: {
      kind: "values",
      expected: ["pmid: 29800179", "randomized: 2555", "high-frequency mortality percent: 13.0"],
      source: {
        database: "pubmed",
        id: "29800179",
        quote: "Among 2555 patients who were randomized, 2509 were included in the intention-to-treat analysis … The 5-year overall patient mortality rate in the high-frequency group was 13.0% (161/1253)",
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
  {
    id: "t-lookup-11",
    category: "lookup",
    specialty: "oncology",
    topics: ["remimazolam", "radiofrequency ablation"],
    prompt:
      "A randomized controlled trial published in Drug Design, Development and Therapy in 2026 compared remimazolam with propofol, each combined with remifentanil, for anesthesia in patients with liver cancer undergoing ultrasound-guided percutaneous radiofrequency ablation. How many participants were randomly assigned, and what was the incidence of apnea, in percent, in the remimazolam group? Cite the PMID. Finish your reply with one line in EXACTLY this format and nothing else on that line:\n`ANSWER — PMID: <number> | randomly assigned: <number> | remimazolam apnea percent: <percent>`",
    answerKey: {
      kind: "values",
      expected: ["pmid: 42801141", "randomly assigned: 82", "remimazolam apnea percent: 17.1"],
      source: {
        database: "pubmed",
        id: "42801141",
        quote: "Eighty-two participants were randomly assigned to receive either propofol (Group P, n = 41) or remimazolam (Group R, n = 41) … Group R had higher respiratory rate (p = 0.015), lower apnea incidence (17.1% vs 36.6%, p = 0.038)",
      },
    },
    retrievalOnly: true,
    verified: true,
  },
  {
    id: "t-lookup-12",
    category: "lookup",
    specialty: "oncology",
    topics: ["quadratus lumborum", "esketamine"],
    prompt:
      "A single-centre, randomized, placebo-controlled trial published in Drug Design, Development and Therapy in 2026 tested an anterior quadratus lumborum block at the lateral supra-arcuate ligament, low-dose esketamine, or both in elderly patients having laparoscopic radical surgery for colorectal cancer. How many patients were assigned, and what adjusted difference in the QoR-40 total score on day 3 did it report between the combined group and the esketamine-alone group? Cite the PMID. Finish your reply with one line in EXACTLY this format and nothing else on that line:\n`ANSWER — PMID: <number> | patients assigned: <number> | qor-40 difference day 3: <value>`",
    answerKey: {
      kind: "values",
      expected: ["pmid: 42871149", "patients assigned: 90", "qor-40 difference day 3: 8.30"],
      source: {
        database: "pubmed",
        id: "42871149",
        quote: "90 patients aged ≥60 years were assigned to QLB-LSAL with a saline infusion (Group Q), esketamine alone (Group E), or QLB-LSAL with esketamine (Group QE) … On day 3 the QoR-40 total score was higher in Group QE than in Group E (adjusted difference 8.30, 95% CI 4.37-12.23, Tukey P<0.001)",
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
  {
    id: "t-lookup-14",
    category: "lookup",
    specialty: "infectious-disease",
    topics: ["diclofenac", "norfloxacin", "urinary tract infection"],
    prompt:
      "A randomised, double blind, non-inferiority trial published in The BMJ in 2017 compared symptomatic treatment with the NSAID diclofenac against the antibiotic norfloxacin in women with uncomplicated lower urinary tract infection in Swiss general practices. How many women were randomly assigned, and what percentage of the women assigned to diclofenac had symptom resolution at day 3? Cite the PMID. Finish your reply with one line in EXACTLY this format and nothing else on that line:\n`ANSWER — PMID: <number> | randomly assigned: <number> | diclofenac resolution percent: <percent>`",
    answerKey: {
      kind: "values",
      expected: ["pmid: 29113968", "randomly assigned: 253", "diclofenac resolution percent: 54"],
      source: {
        database: "pubmed",
        id: "29113968",
        quote: "253 women with uncomplicated lower UTI were randomly assigned 1:1 … 72/133 (54%) women assigned to diclofenac and 96/120 (80%) assigned to norfloxacin experienced symptom resolution at day 3",
      },
    },
    verified: true,
  },
  {
    id: "t-lookup-15",
    category: "lookup",
    specialty: "infectious-disease",
    topics: ["poliovirus", "polio"],
    prompt:
      "A paper published in The Lancet in 2021 reported two randomised studies done in Belgium on the safety and immunogenicity of two novel type 2 oral poliovirus vaccine candidates (novel OPV2-c1 and novel OPV2-c2) compared with a monovalent type 2 oral poliovirus vaccine in healthy adults. How many volunteers were enrolled and randomly assigned in the historical control study of the monovalent vaccine, and what percentage of the previously OPV-vaccinated recipients of novel OPV2-c1 reported solicited systemic adverse events after first doses? Cite the PMID. Finish your reply with one line in EXACTLY this format and nothing else on that line:\n`ANSWER — PMID: <number> | historical control volunteers: <number> | opv2-c1 adverse events percent: <percent>`",
    answerKey: {
      kind: "values",
      expected: ["pmid: 33308429", "historical control volunteers: 100", "opv2-c1 adverse events percent: 71"],
      source: {
        database: "pubmed",
        id: "33308429",
        quote: "100 volunteers were enrolled and randomly assigned to receive one or two doses of monovalent OPV2 (n=50 in each group) … 71 (71%) of 100 recipients of novel OPV2-c1",
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
      "A prospective randomized controlled trial published in Immunopharmacology and Immunotoxicology in 2026 compared antibiotic-loaded bone cement containing vancomycin with plain bone cement in osteoarthritis patients undergoing unicompartmental knee arthroplasty. How many patients were enrolled, and what mean postoperative IL-6 level did it report for the antibiotic-loaded bone cement group? Cite the PMID. Finish your reply with one line in EXACTLY this format and nothing else on that line:\n`ANSWER — PMID: <number> | enrolled: <number> | albc il-6: <value>`",
    answerKey: {
      kind: "values",
      expected: ["pmid: 42858264", "enrolled: 104", "albc il-6: 17.05"],
      source: {
        database: "pubmed",
        id: "42858264",
        quote: "enrolled 104 osteoarthritis patients undergoing UKA … IL-6 (17.05 ± 3.72 vs 22.05 ± 4.38, Cohen's d = 1.230)",
      },
    },
    retrievalOnly: true,
    verified: true,
  },
  {
    id: "t-lookup-17",
    category: "lookup",
    specialty: "infectious-disease",
    topics: ["lidocaine", "rabies immunoglobulin"],
    prompt:
      "A single-center, double-blind, randomized, placebo-controlled trial published in Vaccine in 2026 tested lidocaine spray for reducing pain during rabies immunoglobulin infiltration in adults at a university hospital in Bangkok. How many participants were randomized, and what median pain score during needle penetration did it report for the lidocaine group? Cite the PMID. Finish your reply with one line in EXACTLY this format and nothing else on that line:\n`ANSWER — PMID: <number> | randomized: <number> | lidocaine needle pain median: <value>`",
    answerKey: {
      kind: "values",
      expected: ["pmid: 42731309", "randomized: 76", "lidocaine needle pain median: 25.0"],
      source: {
        database: "pubmed",
        id: "42731309",
        quote: "A total of 76 participants were randomized to the lidocaine or placebo group (n = 38 each). … the lidocaine group reported significantly lower median pain during needle penetration (25.0 (IQR: 17.0, 42.0) vs 56.5 (IQR: 45.0, 75.0)",
      },
    },
    retrievalOnly: true,
    verified: true,
  },
  {
    id: "t-lookup-18",
    category: "lookup",
    specialty: "infectious-disease",
    topics: ["tanreqing", "influenza"],
    prompt:
      "A multicenter, randomized, double-blind, double-dummy trial published in the Journal of Traditional Chinese Medicine in 2026 compared Tanreqing capsule with oseltamivir in patients with uncomplicated influenza in the Beijing-Tianjin area. How many patients were randomly divided between the two groups, and what percentage of the Tanreqing group reached a normal temperature within 1 day? Cite the PMID. Finish your reply with one line in EXACTLY this format and nothing else on that line:\n`ANSWER — PMID: <number> | randomly divided: <number> | tanreqing normal temperature percent: <percent>`",
    answerKey: {
      kind: "values",
      expected: ["pmid: 42958676", "randomly divided: 122", "tanreqing normal temperature percent: 72.88"],
      source: {
        database: "pubmed",
        id: "42958676",
        quote: "A total of 122 patients with uncomplicated influenza in the Beijing-Tianjin area were randomly divided into an observation group and a control group. … The number of patients in TRQC group achieved normal temperature within 1 d was significantly more than oseltamivir group (72.88% vs50.80%, P < 0.05).",
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
  {
    id: "t-lookup-20",
    category: "lookup",
    specialty: "neurology",
    topics: ["epidural steroid", "gabapentin", "radicul"],
    prompt:
      "A multicenter, randomized, double blind comparative efficacy study published in The BMJ in 2015 compared epidural steroid injections with gabapentin for lumbosacral radicular pain in military, Veterans Administration and civilian hospitals. How many people took part, and what adjusted difference in average leg pain score between the two groups did it report at one month? Cite the PMID. Finish your reply with one line in EXACTLY this format and nothing else on that line:\n`ANSWER — PMID: <number> | participants: <number> | adjusted difference at one month: <value>`",
    answerKey: {
      kind: "values",
      expected: ["pmid: 25883095", "participants: 145", "adjusted difference at one month: 0.4"],
      source: {
        database: "pubmed",
        id: "25883095",
        quote: "145 people with lumbosacral radicular pain secondary to herniated disc or spinal stenosis … adjusted difference 0.4, 95% confidence interval -0.3 to 1.2; P=0.25",
      },
    },
    verified: true,
  },
  {
    id: "t-lookup-21",
    category: "lookup",
    specialty: "neurology",
    topics: ["asundexian", "stroke"],
    prompt:
      "The PACIFIC-Stroke trial, an international, randomised, double-blind, placebo-controlled, phase 2b dose-finding trial published in The Lancet in 2022, tested the oral factor XIa inhibitor asundexian after acute non-cardioembolic ischaemic stroke. How many participants were randomly assigned, and what hazard ratio did it report for the primary safety outcome with all asundexian doses pooled versus placebo? Cite the PMID. Finish your reply with one line in EXACTLY this format and nothing else on that line:\n`ANSWER — PMID: <number> | randomly assigned: <number> | pooled safety hazard ratio: <value>`",
    answerKey: {
      kind: "values",
      expected: ["pmid: 36063821", "randomly assigned: 1808", "pooled safety hazard ratio: 1.57"],
      source: {
        database: "pubmed",
        id: "36063821",
        quote: "1880 patients were screened and 1808 participants were randomly assigned … (all asundexian doses pooled vs placebo hazard ratio 1·57 [90% CI 0·91-2·71])",
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
  {
    id: "t-lookup-23",
    category: "lookup",
    specialty: "neurology",
    topics: ["adipose-derived stem cells", "parkinson"],
    prompt:
      "The REPOSE study, a pilot phase IIa randomized, double-blind, placebo-controlled trial published in Cell Transplantation in 2026, tested intravenous human pluripotent adipose-derived stem cells in Parkinson's disease. How many participants were randomized, and across how many infusions in total did it report that no treatment-related adverse event was observed? Cite the PMID. Finish your reply with one line in EXACTLY this format and nothing else on that line:\n`ANSWER — PMID: <number> | randomized: <number> | infusions: <number>`",
    answerKey: {
      kind: "values",
      expected: ["pmid: 42775498", "randomized: 40", "infusions: 60"],
      source: {
        database: "pubmed",
        id: "42775498",
        quote: "Forty participants with Hoehn and Yahr stages I-III PD were randomized 1:1 … No treatment-related adverse events of any grade were observed across 60 infusions.",
      },
    },
    retrievalOnly: true,
    verified: true,
  },
  {
    id: "t-lookup-24",
    category: "lookup",
    specialty: "neurology",
    topics: ["laser", "mirror therapy", "complex regional pain"],
    prompt:
      "A randomised controlled trial published in Physiotherapy Research International in 2026 compared low-level laser therapy with mirror therapy, each added to kinesiotherapy, for complex regional pain syndrome type I after stroke. With how many patients was the study initially conducted, and how many cases were analysed after dropouts? Cite the PMID. Finish your reply with one line in EXACTLY this format and nothing else on that line:\n`ANSWER — PMID: <number> | patients initially: <number> | cases analysed: <number>`",
    answerKey: {
      kind: "values",
      expected: ["pmid: 42751984", "patients initially: 47", "cases analysed: 44"],
      source: {
        database: "pubmed",
        id: "42751984",
        quote: "initially conducted with 47 patients with post-stroke CRPS-I … A total of 44 cases (22 in each group) were analysed, as there were 3 dropouts on subsequent follow-ups.",
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
  {
    id: "t-lookup-26",
    category: "lookup",
    specialty: "psychiatry",
    topics: ["e-cigarette", "smoking cessation"],
    prompt:
      "A randomized clinical trial published in JAMA in 2020 compared nicotine e-cigarettes plus counseling, nonnicotine e-cigarettes plus counseling, and counseling alone for smoking cessation in adults at Canadian sites. How many participants were randomized, and what was the point prevalence abstinence at 12 weeks, in percent, in the nicotine e-cigarette group? Cite the PMID. Finish your reply with one line in EXACTLY this format and nothing else on that line:\n`ANSWER — PMID: <number> | randomized: <number> | nicotine e-cigarette abstinence percent: <percent>`",
    answerKey: {
      kind: "values",
      expected: ["pmid: 33170240", "randomized: 376", "nicotine e-cigarette abstinence percent: 21.9"],
      source: {
        database: "pubmed",
        id: "33170240",
        quote: "Among 376 randomized participants … Point prevalence abstinence was significantly greater for nicotine e-cigarettes plus counseling vs counseling alone at 12 weeks (21.9% vs 9.1%",
      },
    },
    verified: true,
  },
  {
    id: "t-lookup-27",
    category: "lookup",
    specialty: "psychiatry",
    topics: ["body dysmorphic", "cognitive behavio"],
    prompt:
      "A single blind, parallel group randomised controlled trial published in The BMJ in 2016 compared a therapist guided internet based cognitive behavioural therapy programme for body dysmorphic disorder (BDD-NET) with online supportive therapy. How many adult outpatients took part, and what percentage of those receiving BDD-NET were classed as responders at follow-up? Cite the PMID. Finish your reply with one line in EXACTLY this format and nothing else on that line:\n`ANSWER — PMID: <number> | participants: <number> | bdd-net responders percent: <percent>`",
    answerKey: {
      kind: "values",
      expected: ["pmid: 26837684", "participants: 94", "bdd-net responders percent: 56"],
      source: {
        database: "pubmed",
        id: "26837684",
        quote: "94 self referred adult outpatients with a diagnosis of body dysmorphic disorder … At follow-up, 56% of those receiving BDD-NET were classed as responders, compared with 13% receiving supportive therapy.",
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
  {
    id: "t-lookup-29",
    category: "lookup",
    specialty: "psychiatry",
    topics: ["cognitive bias modification", "depressi"],
    prompt:
      "A single-blind, randomised, controlled, two-centre trial published in EBioMedicine in 2026 tested a tablet-based attentional cognitive bias modification training for positive emotion processing in outpatients with major depressive disorder and in healthy controls. How many participants were included, and what between-treatment difference, in microvolts, did it report for the EPN to positive high arousal stimuli in the patients with depression? Cite the PMID. Finish your reply with one line in EXACTLY this format and nothing else on that line:\n`ANSWER — PMID: <number> | participants: <number> | between-treatment difference: <value>`",
    answerKey: {
      kind: "values",
      expected: ["pmid: 42679601", "participants: 240", "between-treatment difference: 1.65"],
      source: {
        database: "pubmed",
        id: "42679601",
        quote: "240 participants were included (119 MDD; 121 HCS) … The between-treatment difference was 1.65 μV, 95% CI [0.19, 3.11].",
      },
    },
    retrievalOnly: true,
    verified: true,
  },
  {
    id: "t-lookup-30",
    category: "lookup",
    specialty: "psychiatry",
    topics: ["genome sequencing", "developmental disorder"],
    prompt:
      "A nationwide prospective randomized trial published in Genome Medicine in 2026, involving all Belgian human genetics centers, compared genome sequencing with the standard of care for diagnosing unexplained developmental disorders. How many individuals did it involve, and what diagnostic yield, in percent, did it report for genome sequencing? Cite the PMID. Finish your reply with one line in EXACTLY this format and nothing else on that line:\n`ANSWER — PMID: <number> | individuals: <number> | genome sequencing yield percent: <percent>`",
    answerKey: {
      kind: "values",
      expected: ["pmid: 42830293", "individuals: 567", "genome sequencing yield percent: 39.8"],
      source: {
        database: "pubmed",
        id: "42830293",
        quote: "with GS for 567 individuals with unexplained DD … The diagnostic yield of GS was 39.8% (113/284) vs. 30% for SoC (85/283) (p = 0.015)",
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
  {
    id: "t-lookup-32",
    category: "lookup",
    specialty: "endocrinology",
    topics: ["veverimer", "metabolic acidosis"],
    prompt:
      "A multicentre, randomised, double-blind, placebo-controlled, phase 3 trial published in The Lancet in 2019 tested veverimer in patients with metabolic acidosis associated with chronic kidney disease. How many participants were randomly assigned to veverimer, and what percentage of the patients in the veverimer group met the composite primary endpoint? Cite the PMID. Finish your reply with one line in EXACTLY this format and nothing else on that line:\n`ANSWER — PMID: <number> | assigned to veverimer: <number> | veverimer primary endpoint percent: <percent>`",
    answerKey: {
      kind: "values",
      expected: ["pmid: 30857647", "assigned to veverimer: 124", "veverimer primary endpoint percent: 59"],
      source: {
        database: "pubmed",
        id: "30857647",
        quote: "we randomly assigned 124 participants to veverimer and 93 to placebo. The composite primary endpoint was met by 71 (59%) of 120 patients in the veverimer group",
      },
    },
    verified: true,
  },
  {
    id: "t-lookup-33",
    category: "lookup",
    specialty: "endocrinology",
    topics: ["lipoprotein(a)", "sln360", "short interfering rna"],
    prompt:
      "A single ascending dose study published in JAMA in 2022 tested SLN360, a short interfering RNA targeting hepatic production of apolipoprotein(a), against placebo in adults with elevated plasma lipoprotein(a) and no known clinically overt cardiovascular disease. How many participants were randomized and received the study intervention, and what was the median baseline lipoprotein(a) concentration, in nmol/L, in the placebo group? Cite the PMID. Finish your reply with one line in EXACTLY this format and nothing else on that line:\n`ANSWER — PMID: <number> | randomized: <number> | placebo baseline lipoprotein-a: <value>`",
    answerKey: {
      kind: "values",
      expected: ["pmid: 35368052", "randomized: 32", "placebo baseline lipoprotein-a: 238"],
      source: {
        database: "pubmed",
        id: "35368052",
        quote: "Among 32 participants who were randomized and received the study intervention … Median baseline Lp(a) concentrations were as follows: placebo, 238 (IQR, 203-308) nmol/L",
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
  {
    id: "t-lookup-35",
    category: "lookup",
    specialty: "endocrinology",
    topics: ["canagliflozin", "podocyte", "diabetic kidney"],
    prompt:
      "A randomised controlled study published in the Annals of the Academy of Medicine, Singapore in 2026 tested canagliflozin added to standard therapy against placebo in patients with diabetic kidney disease, looking at a podocyte protection mechanism. How many patients were assigned to the canagliflozin (experimental) group, and what geometric mean ratio did it report for the urinary podocyte count compared with the control group? Cite the PMID. Finish your reply with one line in EXACTLY this format and nothing else on that line:\n`ANSWER — PMID: <number> | experimental group patients: <number> | podocyte count ratio: <value>`",
    answerKey: {
      kind: "values",
      expected: ["pmid: 42745596", "experimental group patients: 87", "podocyte count ratio: 0.48"],
      source: {
        database: "pubmed",
        id: "42745596",
        quote: "DKD patients were randomly assigned to the experimental group (87 patients: standard therapy plus cangliflozin 100 mg/day) and the control group (85 patients: standard therapy plus placebo tablets) … urinary podocyte count (geometric mean ratio 0.48, 95% CI 0.43 to 0.54)",
      },
    },
    retrievalOnly: true,
    verified: true,
  },
  {
    id: "t-lookup-36",
    category: "lookup",
    specialty: "endocrinology",
    topics: ["community health worker", "prediabetes", "diabetes"],
    prompt:
      "A pragmatic, cluster-randomized controlled trial published in PLoS One in 2026 tested a 12-month community health worker program against usual care for preventing type 2 diabetes in adults with prediabetes at primary care clinics in New York City. In what percentage of intervention patients did incident diabetes occur, and in what percentage of controls? Cite the PMID. Finish your reply with one line in EXACTLY this format and nothing else on that line:\n`ANSWER — PMID: <number> | intervention incident diabetes percent: <percent> | control incident diabetes percent: <percent>`",
    answerKey: {
      kind: "values",
      expected: ["pmid: 42961875", "intervention incident diabetes percent: 5.9", "control incident diabetes percent: 4.3"],
      source: {
        database: "pubmed",
        id: "42961875",
        quote: "Incident diabetes occurred in 5.9% of intervention patients versus 4.3% of controls",
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
  {
    id: "t-lookup-38",
    category: "lookup",
    specialty: "pulmonology",
    topics: ["thoracic radiotherapy", "small-cell lung cancer"],
    prompt:
      "A phase 3 randomised controlled trial published in The Lancet in 2015 tested thoracic radiotherapy in patients with extensive stage small-cell lung cancer who had responded to chemotherapy. How many patients were randomly assigned, and what hazard ratio for overall survival did it report for thoracic radiotherapy versus control? Cite the PMID. Finish your reply with one line in EXACTLY this format and nothing else on that line:\n`ANSWER — PMID: <number> | randomly assigned: <number> | overall survival hazard ratio: <value>`",
    answerKey: {
      kind: "values",
      expected: ["pmid: 25230595", "randomly assigned: 498", "overall survival hazard ratio: 0.84"],
      source: {
        database: "pubmed",
        id: "25230595",
        quote: "We randomly assigned 498 patients between Feb 18, 2009, and Dec 21, 2012. … (hazard ratio [HR] 0.84, 95% CI 0.69-1.01; p=0.066)",
      },
    },
    verified: true,
  },
  {
    id: "t-lookup-39",
    category: "lookup",
    specialty: "pulmonology",
    topics: ["influenza vaccine", "cardiovascular"],
    prompt:
      "A pragmatic, multicenter, double-blind, randomized clinical trial published in JAMA in 2021 compared high-dose trivalent with standard-dose quadrivalent inactivated influenza vaccine in patients with high-risk cardiovascular disease. How many participants were randomized, and what hazard ratio did it report for the primary outcome of death from any cause or hospitalization for cardiovascular or pulmonary causes? Cite the PMID. Finish your reply with one line in EXACTLY this format and nothing else on that line:\n`ANSWER — PMID: <number> | randomized: <number> | hazard ratio: <value>`",
    answerKey: {
      kind: "values",
      expected: ["pmid: 33275134", "randomized: 5260", "hazard ratio: 1.06"],
      source: {
        database: "pubmed",
        id: "33275134",
        quote: "Among 5260 randomized participants … (hazard ratio, 1.06 [95% CI, 0.97-1.17]; P = .21)",
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
  {
    id: "t-lookup-41",
    category: "lookup",
    specialty: "pulmonology",
    topics: ["deep learning", "ct angiography", "ctpa"],
    prompt:
      "A study published in the European Journal of Radiology in 2026 randomised patients undergoing pulmonary CT angiography to a conventional protocol or to an \"ultra triple-low\" protocol at 60 kVp combined with a deep learning-based reconstruction algorithm. How many patients were randomised, and by what percentage did the ultra triple-low protocol group reduce the effective dose? Cite the PMID. Finish your reply with one line in EXACTLY this format and nothing else on that line:\n`ANSWER — PMID: <number> | randomised: <number> | effective dose reduction percent: <percent>`",
    answerKey: {
      kind: "values",
      expected: ["pmid: 42822118", "randomised: 70", "effective dose reduction percent: 84.93"],
      source: {
        database: "pubmed",
        id: "42822118",
        quote: "Seventy patients (body mass index (BMI) < 28 kg/m²) were randomised to Group A … Group B reduced effective dose by 84.93 % (0.71 ± 0.09 vs. 4.71 ± 1.13 mSv, P < 0.001)",
      },
    },
    retrievalOnly: true,
    verified: true,
  },
  {
    id: "t-lookup-42",
    category: "lookup",
    specialty: "pulmonology",
    topics: ["high-frequency oscillatory", "nitric oxide", "pulmonary hypertension"],
    prompt:
      "A single-center, three-arm, open-label, randomized clinical trial published in the Canadian Respiratory Journal in 2026 compared high-frequency oscillatory ventilation combined with inhaled nitric oxide, conventional mechanical ventilation with inhaled nitric oxide, and high-frequency oscillatory ventilation alone in newborns with persistent pulmonary hypertension. How many neonates were randomized, and what risk ratio for death or ECMO did it report for high-frequency oscillatory ventilation plus inhaled nitric oxide versus conventional mechanical ventilation plus inhaled nitric oxide? Cite the PMID. Finish your reply with one line in EXACTLY this format and nothing else on that line:\n`ANSWER — PMID: <number> | randomized: <number> | risk ratio: <value>`",
    answerKey: {
      kind: "values",
      expected: ["pmid: 42803181", "randomized: 138", "risk ratio: 0.27"],
      source: {
        database: "pubmed",
        id: "42803181",
        quote: "138 neonates born at 34 weeks of gestation or later with echocardiographically confirmed PPHN and an oxygenation index of 25 or greater were randomized 1:1:1 … For HFOV + iNO versus CMV + iNO, the risk ratio was 0.27 (95% CI, 0.08-0.91)",
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
  {
    id: "t-lookup-44",
    category: "lookup",
    specialty: "gastroenterology",
    topics: ["resmetirom", "steatohepatitis"],
    prompt:
      "A multicentre, randomised, double-blind, placebo-controlled, phase 2 trial published in The Lancet in 2019 tested resmetirom (MGL-3196), a selective thyroid hormone receptor-β agonist, in patients with non-alcoholic steatohepatitis. How many patients were screened, and how many were randomly assigned to resmetirom? Cite the PMID. Finish your reply with one line in EXACTLY this format and nothing else on that line:\n`ANSWER — PMID: <number> | screened: <number> | assigned to resmetirom: <number>`",
    answerKey: {
      kind: "values",
      expected: ["pmid: 31727409", "screened: 348", "assigned to resmetirom: 84"],
      source: {
        database: "pubmed",
        id: "31727409",
        quote: "348 patients were screened and 84 were randomly assigned to resmetirom and 41 to placebo at 18 sites in the USA.",
      },
    },
    verified: true,
  },
  {
    id: "t-lookup-45",
    category: "lookup",
    specialty: "gastroenterology",
    topics: ["gastrectomy", "gastric cancer"],
    prompt:
      "The CLASS-01 trial, a noninferiority, open-label, randomized clinical trial at centers in China published in JAMA in 2019, compared laparoscopic with open distal gastrectomy in patients with locally advanced gastric cancer. How many eligible patients were enrolled, and what was the 3-year disease-free survival rate, in percent, in the laparoscopic distal gastrectomy group? Cite the PMID. Finish your reply with one line in EXACTLY this format and nothing else on that line:\n`ANSWER — PMID: <number> | enrolled: <number> | laparoscopic disease-free survival percent: <percent>`",
    answerKey: {
      kind: "values",
      expected: ["pmid: 31135850", "enrolled: 1056", "laparoscopic disease-free survival percent: 76.5"],
      source: {
        database: "pubmed",
        id: "31135850",
        quote: "A total of 1056 eligible patients with clinical stage T2, T3, or T4a gastric cancer without bulky nodes or distant metastases were enrolled … Three-year disease-free survival rate was 76.5% in the laparoscopic distal gastrectomy group",
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
  {
    id: "t-lookup-47",
    category: "lookup",
    specialty: "gastroenterology",
    topics: ["rectus sheath", "transversus abdominis", "colorectal"],
    prompt:
      "A single-centre, three-arm randomized clinical trial at a Japanese cancer centre, published in the British Journal of Surgery in 2026, tested a surgeon-performed surgical rectus sheath block or a laparoscopic bilateral dual transversus abdominis plane block added to intravenous patient-controlled analgesia after minimally invasive colorectal cancer surgery. How many patients were randomized, and what adjusted mean difference in the 24-hour QoR-15 score did it report for the transversus abdominis plane block compared with control? Cite the PMID. Finish your reply with one line in EXACTLY this format and nothing else on that line:\n`ANSWER — PMID: <number> | randomized: <number> | tap block adjusted mean difference: <value>`",
    answerKey: {
      kind: "values",
      expected: ["pmid: 42685302", "randomized: 320", "tap block adjusted mean difference: 10.44"],
      source: {
        database: "pubmed",
        id: "42685302",
        quote: "320 patients were randomized (control, 110; SRSB, 107; and BD-TAP block, 103) … Compared with control, BD-TAP block resulted in a higher 24-h QoR-15 score (adjusted mean difference 10.44 (95% c.i. 3.06 to 17.83) points",
      },
    },
    retrievalOnly: true,
    verified: true,
  },
  {
    id: "t-lookup-48",
    category: "lookup",
    specialty: "gastroenterology",
    topics: ["regorafenib", "colorectal"],
    prompt:
      "REVERCE II, a randomized phase II trial published in The Oncologist in 2026, compared regorafenib followed by anti-EGFR therapy with the reverse sequence in refractory RAS/BRAF wild-type metastatic colorectal cancer. How many patients were enrolled, and what was the median overall survival, in months, in the group that received regorafenib first? Cite the PMID. Finish your reply with one line in EXACTLY this format and nothing else on that line:\n`ANSWER — PMID: <number> | enrolled: <number> | regorafenib-first median overall survival: <value>`",
    answerKey: {
      kind: "values",
      expected: ["pmid: 42830449", "enrolled: 22", "regorafenib-first median overall survival: 21.9"],
      source: {
        database: "pubmed",
        id: "42830449",
        quote: "Twenty-two patients were enrolled (R-E: n = 12; E-R: n = 10) … Median OS for R-E and E-R was 21.9 and 13.3 months, respectively",
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
  {
    id: "t-lookup-50",
    category: "lookup",
    specialty: "nephrology-urology",
    topics: ["sunitinib", "sorafenib", "renal-cell carcinoma"],
    prompt:
      "The ECOG-ACRIN E2805 trial, a double-blind, placebo-controlled, randomised, phase 3 trial published in The Lancet in 2016, tested adjuvant sunitinib or sorafenib in patients with resected, high-risk, non-metastatic renal-cell carcinoma. How many patients were randomly assigned, and what hazard ratio for disease-free survival did it report for sunitinib versus placebo? Cite the PMID. Finish your reply with one line in EXACTLY this format and nothing else on that line:\n`ANSWER — PMID: <number> | randomly assigned: <number> | sunitinib hazard ratio: <value>`",
    answerKey: {
      kind: "values",
      expected: ["pmid: 26969090", "randomly assigned: 1943", "sunitinib hazard ratio: 1.02"],
      source: {
        database: "pubmed",
        id: "26969090",
        quote: "1943 patients from the National Clinical Trials Network were randomly assigned to sunitinib (n=647), sorafenib (n=649), or placebo (n=647) … Median disease-free survival was 5·8 years (IQR 1·6-8·2) for sunitinib (hazard ratio [HR] 1·02, 97·5% CI 0·85-1·23, p=0·8038)",
      },
    },
    verified: true,
  },
  {
    id: "t-lookup-51",
    category: "lookup",
    specialty: "nephrology-urology",
    topics: ["finerenone", "albuminuria"],
    prompt:
      "A randomized, double-blind, placebo-controlled, parallel-group study published in JAMA in 2015 tested different oral doses of the nonsteroidal mineralocorticoid receptor antagonist finerenone, given for 90 days, in patients with diabetes and high or very high albuminuria. What placebo-corrected mean ratio of the urinary albumin-creatinine ratio at day 90 relative to baseline did it report for the 7.5 mg/d group, and what ratio for the 20 mg/d group? Cite the PMID. Finish your reply with one line in EXACTLY this format and nothing else on that line:\n`ANSWER — PMID: <number> | lowest dose ratio: <value> | highest dose ratio: <value>`",
    answerKey: {
      kind: "values",
      expected: ["pmid: 26325557", "lowest dose ratio: 0.79", "highest dose ratio: 0.62"],
      source: {
        database: "pubmed",
        id: "26325557",
        quote: "(for 7.5 mg/d, 0.79 [90% CI, 0.68-0.91; P = .004]; for 10 mg/d, 0.76 [90% CI, 0.65-0.88; P = .001]; for 15 mg/d, 0.67 [90% CI, 0.58-0.77; P<.001]; for 20 mg/d, 0.62 [90% CI, 0.54-0.72; P < .001])",
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
  {
    id: "t-lookup-53",
    category: "lookup",
    specialty: "nephrology-urology",
    topics: ["exercise", "chronic kidney disease", "skeletal muscle"],
    prompt:
      "A randomized controlled trial published in the American Journal of Physiology-Renal Physiology in 2026 studied skeletal muscle adaptation to a 12-week home-based, personalized exercise program versus usual care in patients with stages 3-5 chronic kidney disease. How many patients took part, and how many of them were in the exercise group? Cite the PMID. Finish your reply with one line in EXACTLY this format and nothing else on that line:\n`ANSWER — PMID: <number> | patients: <number> | exercisers: <number>`",
    answerKey: {
      kind: "values",
      expected: ["pmid: 42932910", "patients: 25", "exercisers: 19"],
      source: {
        database: "pubmed",
        id: "42932910",
        quote: "Twenty-five patients (19 exercisers and 6 usual care) with stages 3-5 CKD underwent a randomized controlled trial",
      },
    },
    retrievalOnly: true,
    verified: true,
  },
  {
    id: "t-lookup-54",
    category: "lookup",
    specialty: "nephrology-urology",
    topics: ["pomalidomide", "myeloma", "renal impairment"],
    prompt:
      "POM-MM-003, an open-label, randomized, phase II study at centers in China published in Med in 2026, compared pomalidomide plus bortezomib and dexamethasone with bortezomib and dexamethasone alone in newly diagnosed multiple myeloma with renal impairment. How many patients were randomized, and what renal response rate, in percent, did it report for the pomalidomide group after four cycles of induction? Cite the PMID. Finish your reply with one line in EXACTLY this format and nothing else on that line:\n`ANSWER — PMID: <number> | randomized: <number> | pomalidomide renal response percent: <percent>`",
    answerKey: {
      kind: "values",
      expected: ["pmid: 42716009", "randomized: 82", "pomalidomide renal response percent: 75.9"],
      source: {
        database: "pubmed",
        id: "42716009",
        quote: "82 patients were randomized to PVd (n = 58) and Vd (n = 24) groups … renal response rate (75.9% [44/58; 95% CI: 62.8-86.1] vs. 45.8% [11/24; 95% CI: 25.6-67.2]; p = 0.009)",
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
  {
    id: "t-lookup-56",
    category: "lookup",
    specialty: "musculoskeletal",
    topics: ["hand exercise", "rheumatoid arthritis"],
    prompt:
      "The SARAH trial, a pragmatic, multicentre, parallel-group, randomised controlled trial published in The Lancet in 2015, tested a tailored strengthening and stretching hand exercise programme added to usual care in adults with rheumatoid arthritis of the hand. How many adults were randomly assigned, and what mean difference between groups in the improvement in overall hand function did it report? Cite the PMID. Finish your reply with one line in EXACTLY this format and nothing else on that line:\n`ANSWER — PMID: <number> | randomly assigned: <number> | mean difference: <value>`",
    answerKey: {
      kind: "values",
      expected: ["pmid: 25308290", "randomly assigned: 490", "mean difference: 4.3"],
      source: {
        database: "pubmed",
        id: "25308290",
        quote: "we screened 1606 people, of whom 490 were randomly assigned to usual care (n=244) or tailored exercises (n=246) … (mean difference between groups 4·3, 95% CI 1·5-7·1; p=0·0028)",
      },
    },
    verified: true,
  },
  {
    id: "t-lookup-57",
    category: "lookup",
    specialty: "musculoskeletal",
    topics: ["sirukumab", "rheumatoid arthritis"],
    prompt:
      "SIRROUND-T, a randomised, double-blind, placebo-controlled, phase 3 study published in The Lancet in 2017, tested sirukumab in patients with active rheumatoid arthritis refractory to anti-TNF therapy. How many patients were randomly assigned, and what percentage of the patients given 100 mg sirukumab every 2 weeks achieved an ACR20 response at week 16? Cite the PMID. Finish your reply with one line in EXACTLY this format and nothing else on that line:\n`ANSWER — PMID: <number> | randomly assigned: <number> | acr20 response percent: <percent>`",
    answerKey: {
      kind: "values",
      expected: ["pmid: 28215362", "randomly assigned: 878", "acr20 response percent: 45"],
      source: {
        database: "pubmed",
        id: "28215362",
        quote: "we randomly assigned 878 patients to treatment … 132 (45%) of 292 with 100 mg sirukumab every 2 weeks",
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
  {
    id: "t-lookup-59",
    category: "lookup",
    specialty: "musculoskeletal",
    topics: ["chondroitin", "knee osteoarthritis", "knee oa"],
    prompt:
      "A 12-week, randomized, double-blind, placebo-controlled trial published in Nutrients in 2026 tested chondroitin sulfate supplementation for joint symptoms and physical function in adults with mild knee osteoarthritis. How many adults were randomly assigned, and how many of them received chondroitin sulfate? Cite the PMID. Finish your reply with one line in EXACTLY this format and nothing else on that line:\n`ANSWER — PMID: <number> | randomly assigned: <number> | chondroitin group: <number>`",
    answerKey: {
      kind: "values",
      expected: ["pmid: 42942962", "randomly assigned: 100", "chondroitin group: 50"],
      source: {
        database: "pubmed",
        id: "42942962",
        quote: "100 adults with mild knee OA were randomly assigned to receive CS (1200 mg/day; n = 50) or placebo (n = 50)",
      },
    },
    retrievalOnly: true,
    verified: true,
  },
  {
    id: "t-lookup-60",
    category: "lookup",
    specialty: "musculoskeletal",
    topics: ["neural mobilization", "adhesive capsulitis", "proprioceptive neuromuscular"],
    prompt:
      "A randomized controlled trial published in Physiotherapy Research International in 2026 tested adding neural mobilization techniques to proprioceptive neuromuscular facilitation and conventional physical therapy in patients with adhesive capsulitis of the shoulder. How many patients were randomly assigned, and what adjusted between-group difference in passive shoulder abduction, in degrees, did it report? Cite the PMID. Finish your reply with one line in EXACTLY this format and nothing else on that line:\n`ANSWER — PMID: <number> | randomly assigned: <number> | abduction difference degrees: <value>`",
    answerKey: {
      kind: "values",
      expected: ["pmid: 42750164", "randomly assigned: 56", "abduction difference degrees: 14.08"],
      source: {
        database: "pubmed",
        id: "42750164",
        quote: "Fifty-six patients with AC of both genders were randomly assigned to two groups of equal size. … abduction 14.08° (11.22, 16.94; p < 0.001, η² = 0.647)",
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
  {
    id: "t-lookup-62",
    category: "lookup",
    specialty: "obstetrics",
    topics: ["nifedipine", "labetalol", "methyldopa", "hypertension"],
    prompt:
      "An open-label, randomised controlled trial published in The Lancet in 2019 compared oral nifedipine retard, labetalol and methyldopa for the management of severe hypertension in pregnancy. How many women were randomly assigned to a treatment group, and in what percentage of the women in the nifedipine group did the primary outcome occur? Cite the PMID. Finish your reply with one line in EXACTLY this format and nothing else on that line:\n`ANSWER — PMID: <number> | randomly assigned: <number> | nifedipine primary outcome percent: <percent>`",
    answerKey: {
      kind: "values",
      expected: ["pmid: 31378394", "randomly assigned: 894", "nifedipine primary outcome percent: 84"],
      source: {
        database: "pubmed",
        id: "31378394",
        quote: "894 (39%) women were randomly assigned to a treatment group and were included in the intention-to-treat analysis … (249 [84%] women vs 230 [76%] women; p=0·03)",
      },
    },
    verified: true,
  },
  {
    id: "t-lookup-63",
    category: "lookup",
    specialty: "obstetrics",
    topics: ["negative pressure wound therapy", "caesarean", "cesarean"],
    prompt:
      "A multicentre, pragmatic, parallel group, randomised controlled trial published in The BMJ in 2021 compared closed incision negative pressure wound therapy with standard dressings in obese women undergoing caesarean section. How many women were randomised, and what risk ratio for surgical site infection did it report in the primary intention to treat analysis? Cite the PMID. Finish your reply with one line in EXACTLY this format and nothing else on that line:\n`ANSWER — PMID: <number> | randomised: <number> | risk ratio: <value>`",
    answerKey: {
      kind: "values",
      expected: ["pmid: 33952438", "randomised: 2035", "risk ratio: 0.76"],
      source: {
        database: "pubmed",
        id: "33952438",
        quote: "2035 consenting women were randomised before the caesarean procedure to closed incision NPWT (n=1017) or standard dressing (n=1018) … (risk ratio 0.76, 95% confidence interval 0.57 to 1.01; P=0.06)",
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
    id: "t-lookup-65",
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
  {
    id: "t-lookup-66",
    category: "lookup",
    specialty: "ophthalmology",
    topics: ["teprotumumab", "thyroid eye disease"],
    prompt:
      "A randomized, double-masked, placebo-controlled, phase 3 multicenter trial published in the New England Journal of Medicine in 2020 tested the IGF-IR inhibitor teprotumumab in patients with active thyroid eye disease. How many patients were assigned to the teprotumumab group, and what percentage of them had a proptosis response at week 24? Cite the PMID. Finish your reply with one line in EXACTLY this format and nothing else on that line:\n`ANSWER — PMID: <number> | teprotumumab group patients: <number> | proptosis response percent: <percent>`",
    answerKey: {
      kind: "values",
      expected: ["pmid: 31971679", "teprotumumab group patients: 41", "proptosis response percent: 83"],
      source: {
        database: "pubmed",
        id: "31971679",
        quote: "A total of 41 patients were assigned to the teprotumumab group and 42 to the placebo group. At week 24, the percentage of patients with a proptosis response was higher with teprotumumab than with placebo (83% [34 patients] vs. 10% [4 patients], P<0.001)",
      },
    },
    verified: true,
  },
  {
    id: "t-lookup-67",
    category: "lookup",
    specialty: "ophthalmology",
    topics: ["voretigene", "retinal dystrophy", "rpe65"],
    prompt:
      "A randomised, controlled, open-label, phase 3 trial published in The Lancet in 2017 tested the gene therapy voretigene neparvovec in patients with RPE65-mediated inherited retinal dystrophy. How many individuals were enrolled and randomly assigned, and what difference between the intervention and control groups in the mean bilateral multi-luminance mobility testing change score did it report at 1 year? Cite the PMID. Finish your reply with one line in EXACTLY this format and nothing else on that line:\n`ANSWER — PMID: <number> | randomly assigned: <number> | mobility test difference: <value>`",
    answerKey: {
      kind: "values",
      expected: ["pmid: 28712537", "randomly assigned: 31", "mobility test difference: 1.6"],
      source: {
        database: "pubmed",
        id: "28712537",
        quote: "31 individuals were enrolled and randomly assigned to intervention (n=21) or control (n=10) … (difference of 1·6, 95% CI 0·72-2·41, p=0·0013)",
      },
    },
    verified: true,
  },
  // ─── lookup · ophthalmology · recent ───
  {
    id: "t-lookup-68",
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
  {
    id: "t-lookup-69",
    category: "lookup",
    specialty: "ophthalmology",
    topics: ["myopia", "defocus", "spectacle lenses"],
    prompt:
      "A one-year interim analysis of an ongoing non-inferiority randomized controlled trial, published in Translational Vision Science & Technology in 2026, compared partition multipoint defocus optics technology (PMDOT) spectacle lenses with lenses with highly aspherical lenslets for myopia control in children. How many children were randomized, and how many were in the PMDOT group? Cite the PMID. Finish your reply with one line in EXACTLY this format and nothing else on that line:\n`ANSWER — PMID: <number> | randomized: <number> | pmdot group children: <number>`",
    answerKey: {
      kind: "values",
      expected: ["pmid: 42867309", "randomized: 194", "pmdot group children: 102"],
      source: {
        database: "pubmed",
        id: "42867309",
        quote: "194 children ages 8 to 13 years with spherical equivalent refraction (SER) of -0.75 to -4.5 diopters (D) were randomized to either the PMDOT or HAL group … The study included 102 children in the PMDOT group and 92 in the HAL group.",
      },
    },
    retrievalOnly: true,
    verified: true,
  },
  {
    id: "t-lookup-70",
    category: "lookup",
    specialty: "ophthalmology",
    topics: ["choroidal thickness", "defocus", "distant-image"],
    prompt:
      "A prospective, randomized, controlled, crossover pilot trial published in Frontiers in Public Health in 2026 examined short-term changes in choroidal thickness in children with myopia in response to a distant-image screen device and defocus-incorporated multiple segments (DIMS) lenses. How many children were recruited and randomized, and what choroidal thickness thickening at region C, in micrometres, did it report for the DIMS group compared with the single-vision lens group among participants using a tablet computer? Cite the PMID. Finish your reply with one line in EXACTLY this format and nothing else on that line:\n`ANSWER — PMID: <number> | children: <number> | dims thickening at c: <value>`",
    answerKey: {
      kind: "values",
      expected: ["pmid: 42761589", "children: 40", "dims thickening at c: 9.54"],
      source: {
        database: "pubmed",
        id: "42761589",
        quote: "A total of 40 children (8-13 years of age) with spherical equivalent refraction (SER) ranging from -0.50 to -6.00 diopters (D) were recruited and randomized into 4 groups … For participants using TC, the DIMS group showed greater ChT thickening at C (9.54 ± 3.19 μm, p = 0.005)",
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
];
