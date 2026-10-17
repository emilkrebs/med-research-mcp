---
name: med-research-ebm
description: Load ONLY when critically appraising a study or deciding whether a paper is trustworthy enough to drive a real decision — risk of bias (Cochrane RoB 2 / ROBINS-I / ROBINS-E), AMSTAR 2 / ROBIS for reviews, effect sizes / confidence intervals / NNT, heterogeneity (I²), prediction intervals and funnel-plot bias, Bradford Hill causation, applicability/external validity, funding and conflicts of interest, selective publication. Not needed for simple lookups or searches; load the `med-research` workflow skill for query patterns, the 0–5 design tiers and the ground rules of evidence.
---

# EBM critical appraisal — the `med-research-ebm` reference

The `designTier` orients you; evidence-based medicine tells you what to actually
trust. Run a pivotal paper through these lenses **only when it is about to drive a
real decision** (a dose, a "should I take X", a clinical claim). For routine
searches and lookups, stay in the lean `med-research` workflow — don't load this.
Numbers in brackets refer to the references at the end.

## Frame the question with PICO(S)

Before appraising, state the question explicitly:

- **P**opulation — who (age, condition, stage, comorbidity)?
- **I**ntervention — what exposure, drug, dose, formulation, protocol?
- **C**omparator — placebo, standard care, alternative?
- **O**utcome — what patient-important endpoint (mortality, function, symptom score, QoL)?
- **(S)tudy design** — what would the ideal study be (RCT, cohort, n-of-1)?

A question you cannot state in PICO form is too vague to answer with literature.
Reuse the same PICO to decide whether a returned paper actually answers *your*
question, not some adjacent one.

## Hierarchy of evidence (a prior, not a verdict)

The best design depends on the question. The OCEBM 2011 levels [1], level 1 first:

| Question | Level 1 | Level 2 | Level 3 | Level 4 |
|---|---|---|---|---|
| Does this intervention help? | systematic review of randomized trials or n-of-1 trials | randomized trial, or observational study with dramatic effect | non-randomized controlled cohort/follow-up study | case series, case-control or historically controlled studies |
| What are the harms? | systematic review of randomized trials, or n-of-1 trial (common harms also: systematic review of nested case-control studies, or observational study with dramatic effect) | randomized trial, or (exceptionally) observational study with dramatic effect | non-randomized controlled cohort/follow-up (post-marketing surveillance), with enough numbers and follow-up | case series, case-control or historically controlled studies |
| Prognosis (what happens without treatment)? | systematic review of inception cohorts | inception cohort | cohort study or control arm of a randomized trial | case series, case-control, or poor-quality cohort |
| Is this test accurate? | systematic review of cross-sectional studies with a consistent reference standard and blinding | individual such cross-sectional study | non-consecutive studies, or no consistent reference standard | case-control studies, or a poor or non-independent reference standard |

Level 5 is mechanism-based reasoning (none is listed for prognosis). The tool's
`designTier` follows the first row. A systematic review ranks with the studies it
pooled: a meta-analysis of cohort studies sits at the cohort level, not level 1.
OCEBM grades a level down for poor quality, imprecision, indirectness,
inconsistency or a very small absolute effect, and up for a large effect [1].
GRADE starts randomized evidence at high certainty and observational evidence at
low, then rates down or up [2]. Hierarchy is where you start, not where you finish.

## Critical appraisal by study type

Match the appraisal tool to the design rather than applying one checklist to everything:

- **RCTs** — Cochrane **RoB 2** [3], five domains: bias arising from the randomization process, from deviations from intended interventions, from missing outcome data, in measurement of the outcome, and in selection of the reported result [4]. Check **CONSORT 2025** reporting [5].
- **Non-randomized studies of interventions** — **ROBINS-I** [6], seven domains (confounding, selection of participants, classification of interventions, deviations from intended interventions, missing data, measurement of outcomes, selection of the reported result). **Non-randomized follow-up studies of exposures** (e.g. diet, pollutants) — **ROBINS-E** [7].
- **Systematic reviews / meta-analyses** — **AMSTAR 2** [8] or **ROBIS** [9]; **PRISMA 2020** for reporting completeness and the flow diagram [10].
- **Diagnostic accuracy** — **QUADAS-2** [11].
- **Prognostic factors** — **QUIPS** [12].
- **Case reports** — the **CARE** reporting guideline [13].

Generic red flags across all designs: lack of randomization, unblinded subjective
outcomes (placebo responses are real for patient-reported outcomes such as pain
and nausea [14]), post-hoc subgroup "discoveries", per-protocol instead of
intention-to-treat analysis, and outcome switching versus the registered protocol.

## Statistics: effect size and clinical significance

- Prefer **effect sizes with 95% confidence intervals** over bare p-values. A tiny effect can reach p<0.05 in a large sample and still be clinically irrelevant [1]. A CI that spans both benefit and harm means the effect is uncertain — not that there is none [15].
- **RRR vs ARR vs NNT**: a relative risk reduction sounds large even when the absolute benefit is small; the absolute risk reduction grounds it. NNT = 1/ARR — the number of patients you must treat to prevent one event.
- Know the **MCID** (minimal clinically important difference) for the outcome [16]. A statistically significant 0.3-point gain on a 100-point scale is rarely worth a drug's harms and cost.
- **SMD / Cohen's d** for continuous outcomes: Cohen's conventions are 0.2 small, 0.5 medium, 0.8 large [17] — rough guides; always translate back to the outcome's native units.
- **Surrogate endpoints** (biomarker, lab value, imaging) are indirect evidence for **patient-important outcomes** (mortality, function, quality of life) [26], and trials using surrogates report larger treatment effects than trials using patient-relevant outcomes (pooled odds ratio 0.51 vs 0.76) [18]. Confirm the hard endpoints.
- **Non-inferiority** trials answer a different question than superiority; always check the non-inferiority margin, which is easily set too wide.
- Watch for **multiplicity**: many tested outcomes or subgroups make some p<0.05 by chance likely; demand a pre-specified primary endpoint and correction.

## Meta-analysis-specific checks

- **What was pooled?** Randomized trials, observational studies, or both? The pooled designs set the starting certainty [2].
- **Heterogeneity (I²)**: the Cochrane Handbook gives overlapping, rough ranges — 0–40% might not be important, 30–60% may be moderate, 50–90% may be substantial, 75–100% considerable — and warns that thresholds "can be misleading": weigh the size and direction of the effects too [19]. With high I², read the forest plot and subgroups; don't trust the diamond.
- **Prediction interval** (random effects) shows the spread of true effects across settings, which the CI around the mean hides [20]. It assumes normally distributed effects and needs roughly five or more studies [19].
- **Small-study effects / publication bias**: inspect the funnel plot. Tests for asymmetry (e.g. Egger's [21]) need **at least 10 studies**, and asymmetry is not proof of publication bias — heterogeneity, flawed small studies and chance can cause it [22, 23].
- **PICO consistency**: does pooling apples and oranges actually answer one question? A meta-analysis is only as good as the studies it ingests.

## Causation vs association

Observational studies show association, not causation. For causal claims weigh the
**Bradford Hill considerations** [24]: strength, consistency, specificity,
temporality, biological gradient, plausibility, coherence, experiment, analogy.
Use them to weigh the evidence, not as a checklist to tick off. Temporality
(exposure before outcome) is required by definition. **Confounding by indication** and **reverse
causation** are the usual suspects in pharmaco-epidemiology. **Mendelian
randomization** [25] and natural experiments can strengthen causal inference
where RCTs are unethical or impractical.

## Applicability / external validity

A trial that is internally perfect but run on the wrong population does not answer
your question [26]. Ask:

- Does the study population match the patient (age, sex, comorbidity, disease severity, setting)?
- Is the intervention realistic (dose, formulation, duration, adherence, setting, cost)?
- Are the outcomes the ones the patient cares about, measured at a meaningful time point?
- Is the comparator current standard of care — or a straw man?

## Bias beyond the single study

- **Funding source & conflicts of interest**: manufacturer sponsorship of drug and device studies leads to more favorable efficacy results and conclusions, a bias that standard risk-of-bias tools don't capture [27]. Check the funding and conflict-of-interest statements and the sponsor.
- **Selective publication & outcome switching**: compare the published outcomes to the registered protocol on **ClinicalTrials.gov**, **ISRCTN**, or **EU-CTR**; misreported outcomes are common even in top journals [28]. Missing or re-labeled outcomes are a red flag.
- **Replication & pre-registration**: a single study, however good, is a hypothesis. Small, flexible, single positive studies are often false [29]. Independent replication — ideally pre-registered and by a non-conflicted group — is the real test.
- **Data integrity**: gross inconsistencies, impossible variance, duplicated images, or reported means that are impossible for the sample size (the GRIM test [30]) signal errors or fabrication.

## Mechanism is a prior, not proof

Mechanistic plausibility (in vitro, animal, pathway data) lowers the bar for believing
an association, but bench/animal data is not human efficacy: it is level 5 at best [1]
and indirect in population [26]. Use mechanism to generate hypotheses and to
sanity-check implausible clinical claims — never as a substitute for outcomes in
actual patients.

## A short trust rule

> A claim is trustworthy enough to act on when it comes from a pre-registered,
> well-powered, low-risk-of-bias study (or better, a consistent, low-heterogeneity
> meta-analysis of such studies), in a population matching the patient, with a
> patient-important outcome, a clinically meaningful effect size and tight CI,
> replicated by an independent non-conflicted group, and the benefit outweighs the
> harms and costs in that context. Anything less is a graded hypothesis, not a fact.

## Quality checklist (run when a paper might drive a decision)

1. **Design and flags.** `designTier` 4–5 is a strong *design*, nothing more. A `flags` entry of `retracted`, `notice`, `protocol` or `editorial` ends the appraisal: it is not evidence. `expression-of-concern`: don't rely on it alone. `updated`: appraise the newer version. `corrected`: check the erratum before quoting numbers. `animals-not-humans`: confirm whether humans were studied.
2. **Confirm the design yourself.** `studyType` is NLM's label, often machine-assigned; `unknown` means there is none. `clinical-trial` and `observational` hide the specific design, an `RCT` label can be a secondary analysis, a `review` may be systematic, and an unrated meta-analysis needs its pooled designs read. Check the Methods.
3. **Rate down what the tier can't see.** Pilot/feasibility trials, post-hoc or subgroup analyses, syntheses of observational-only or animal studies, single-centre or tiny samples, surrogate outcomes — each lowers certainty below the design's tier.
4. **Population match.** Read who was studied (age, sex, ancestry, disease, setting) in the abstract. A study on healthy 20-year-olds is not directly applicable to 60-year-olds with hypertension.
5. **Dosage.** Read the dose, formulation and duration from the abstract or full text; confirm units.
6. **Database source.** ChinaXiv/RussiaRxiv and non-MEDLINE records carry no NLM labels. If one looks pivotal, fetch the full text before relying on it.
7. **Fetch the abstract.** When in doubt, call `literature_fetch` with the PMID/id. Read the **Methods** and **Results** sections.
8. **Fetch the full text.** For papers about to drive a dose or clinical decision, call `literature_fulltext`. Check methods, sample size, statistical power, effect size, and confounders.

## References

1. OCEBM Levels of Evidence Working Group. The Oxford 2011 Levels of Evidence, and its Introductory Document. Oxford Centre for Evidence-Based Medicine. https://www.cebm.ox.ac.uk/resources/levels-of-evidence/ocebm-levels-of-evidence
2. Balshem H, et al. GRADE guidelines: 3. Rating the quality of evidence. J Clin Epidemiol 2011;64:401-6. PMID 21208779
3. Sterne JAC, et al. RoB 2: a revised tool for assessing risk of bias in randomised trials. BMJ 2019;366:l4898. PMID 31462531
4. Higgins JPT, et al., eds. Cochrane Handbook for Systematic Reviews of Interventions, version 6.5, 2024, chapter 8. https://www.cochrane.org/authors/handbooks-and-manuals/handbook/current/chapter-08
5. Hopewell S, et al. CONSORT 2025 statement: updated guideline for reporting randomised trials. BMJ 2025;389:e081123. PMID 40228833
6. Sterne JA, et al. ROBINS-I: a tool for assessing risk of bias in non-randomised studies of interventions. BMJ 2016;355:i4919. PMID 27733354
7. Higgins JPT, et al. A tool to assess risk of bias in non-randomized follow-up studies of exposure effects (ROBINS-E). Environ Int 2024;186:108602. PMID 38555664
8. Shea BJ, et al. AMSTAR 2. BMJ 2017;358:j4008. PMID 28935701
9. Whiting P, et al. ROBIS: a new tool to assess risk of bias in systematic reviews was developed. J Clin Epidemiol 2016;69:225-34. PMID 26092286
10. Page MJ, et al. The PRISMA 2020 statement. BMJ 2021;372:n71. PMID 33782057
11. Whiting PF, et al. QUADAS-2. Ann Intern Med 2011;155:529-36. PMID 22007046
12. Hayden JA, et al. Assessing bias in studies of prognostic factors. Ann Intern Med 2013;158:280-6. PMID 23420236
13. Gagnier JJ, et al. The CARE guidelines: consensus-based clinical case report guideline development. J Clin Epidemiol 2014;67:46-51. PMID 24035173
14. Hróbjartsson A, Gøtzsche PC. Placebo interventions for all clinical conditions. Cochrane Database Syst Rev 2010;CD003974. PMID 20091554
15. Altman DG, Bland JM. Absence of evidence is not evidence of absence. BMJ 1995;311:485. PMID 7647644
16. Jaeschke R, Singer J, Guyatt GH. Measurement of health status: ascertaining the minimal clinically important difference. Control Clin Trials 1989;10:407-15. PMID 2691207
17. Cohen J. Statistical Power Analysis for the Behavioral Sciences. 2nd ed. Hillsdale, NJ: Lawrence Erlbaum; 1988
18. Ciani O, et al. Comparison of treatment effect sizes associated with surrogate and final patient relevant outcomes in randomised controlled trials: meta-epidemiological study. BMJ 2013;346:f457. PMID 23360719
19. Deeks JJ, et al. Cochrane Handbook version 6.5, 2024, chapter 10. https://www.cochrane.org/authors/handbooks-and-manuals/handbook/current/chapter-10
20. Riley RD, et al. Interpretation of random effects meta-analyses. BMJ 2011;342:d549. PMID 21310794
21. Egger M, et al. Bias in meta-analysis detected by a simple, graphical test. BMJ 1997;315:629-34. PMID 9310563
22. Sterne JA, et al. Recommendations for examining and interpreting funnel plot asymmetry in meta-analyses of randomised controlled trials. BMJ 2011;343:d4002. PMID 21784880
23. Cochrane Handbook version 6.5, 2024, chapter 13. https://www.cochrane.org/authors/handbooks-and-manuals/handbook/current/chapter-13
24. Hill AB. The environment and disease: association or causation? Proc R Soc Med 1965;58:295-300. PMID 14283879
25. Davey Smith G, Ebrahim S. 'Mendelian randomization': can genetic epidemiology contribute to understanding environmental determinants of disease? Int J Epidemiol 2003;32:1-22. PMID 12689998
26. Guyatt GH, et al. GRADE guidelines: 8. Rating the quality of evidence — indirectness. J Clin Epidemiol 2011;64:1303-10. PMID 21802903
27. Lundh A, et al. Industry sponsorship and research outcome. Cochrane Database Syst Rev 2017;MR000033. PMID 28207928
28. Goldacre B, et al. COMPare: a prospective cohort study correcting and monitoring 58 misreported trials in real time. Trials 2019;20:118. PMID 30760329
29. Ioannidis JPA. Why most published research findings are false. PLoS Med 2005;2:e124. PMID 16060722
30. Brown NJL, Heathers JAJ. The GRIM test. Soc Psychol Personal Sci 2017;8:363-9. doi:10.1177/1948550616673876
