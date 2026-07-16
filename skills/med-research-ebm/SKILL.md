---
name: med-research-ebm
description: Load ONLY when critically appraising a study or deciding whether a paper is trustworthy enough to drive a real decision — risk of bias (Cochrane RoB 2 / ROBINS-I), AMSTAR-2 / ROBIS for reviews, effect sizes / confidence intervals / NNT, heterogeneity (I²) and funnel-plot bias, Bradford Hill causation, applicability/external validity, funding and conflicts of interest, selective publication. Not needed for simple lookups or searches; load the `med-research` workflow skill for query patterns and the 0–5 grade scale.
---

# EBM critical appraisal — the `med-research-ebm` reference

The `evidenceScore` orients you; evidence-based medicine tells you what to actually
trust. Run a pivotal paper through these lenses **only when it is about to drive a
real decision** (a dose, a "should I take X", a clinical claim). For routine
searches and lookups, stay in the lean `med-research` workflow — don't load this.

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

Roughly, in descending trust: meta-analysis of RCTs > single large multi-center RCT >
small RCT > prospective cohort > case-control > case series > bench/animal > expert
opinion. The `evidenceScore` encodes this, but a meta-analysis of flawed small
trials still ranks low — hierarchy is where you start, not where you finish.

## Critical appraisal by study type

Match the appraisal tool to the design rather than applying one checklist to everything:

- **RCTs** — Cochrane **RoB 2** (sequence generation, allocation concealment, blinding, missing-outcome data, deviations from protocol, selective reporting). Check **CONSORT** reporting adherence.
- **Non-randomized (cohort/case-control)** — **ROBINS-I** (confounding, selection, intervention classification, deviations, missing data, outcome measurement, selective reporting).
- **Systematic reviews / meta-analyses** — **AMSTAR-2** (or **ROBIS**); also **PRISMA** for reporting completeness and the flow diagram.
- **Diagnostic accuracy** — **QUADAS-2**.
- **Prognosis** — **QUIPS**.
- **Case reports** — **CARE**.

Generic red flags across all designs: lack of randomization, unblinded subjective
outcomes, post-hoc subgroup "discoveries", per-protocol instead of intention-to-treat
analysis, and outcome switching versus the registered protocol.

## Statistics: effect size and clinical significance

- Prefer **effect sizes with 95% confidence intervals** over bare p-values. A p<0.05 on a tiny effect is meaningless; a CI that crosses the null is inconclusive no matter the p.
- **RRR vs ARR vs NNT**: relative risk reduction inflates apparent benefit; absolute risk reduction grounds it. NNT = 1/ARR — the patients you must treat to prevent one event.
- Know the **MCID** (minimum clinically important difference) for the outcome. A statistically significant 0.3-point gain on a 100-point scale is rarely worth a drug's harms and cost.
- **SMD / Cohen's d** for continuous outcomes: 0.2 small, 0.5 medium, 0.8 large — but always translate back to the outcome's native units.
- **Surrogate endpoints** (biomarker, lab value, imaging) are weaker than **patient-important outcomes** (mortality, function, quality of life). A drug lowering HbA1c or LDL does not automatically mean fewer heart attacks or longer life — confirm the hard endpoints.
- **Non-inferiority** trials answer a different question than superiority; always check the non-inferiority margin, which is easily gamed.
- Watch for **multiplicity**: many tested outcomes/subgroups guarantee some p<0.05 by chance; demand a pre-specified primary endpoint and correction.

## Meta-analysis-specific checks

- **Heterogeneity (I²)**: <25% low, 25–50% moderate, >50% substantial. High I² means a single pooled estimate is misleading — read the forest plot and subgroups, don't trust the diamond.
- **Publication bias**: inspect the funnel plot (or Egger's test). Asymmetry suggests suppressed null/negative studies, inflating the pooled effect.
- **Prediction interval** (random-effects) is more honest than the CI — it shows the plausible range of true effects across future settings.
- **PICO consistency**: does pooling apples and oranges actually answer one question? A meta-analysis is only as good as the studies it ingests.

## Causation vs association

Observational studies show association, not causation. For causal claims weigh the
**Bradford Hill criteria**: strength, consistency, specificity, temporality,
biological gradient, plausibility, coherence, experiment, analogy. Temporality
(exposure before outcome) is non-negotiable. **Confounding by indication** and
**reverse causation** are the usual suspects in pharmaco-epidemiology. **Mendelian
randomization** and natural experiments (policy changes, off-season birth cohorts)
strengthen causal inference where RCTs are unethical.

## Applicability / external validity

A trial that is internally perfect but run on the wrong population does not answer
your question. Ask:

- Does the study population match the patient (age, sex, comorbidity, disease severity, setting)?
- Is the intervention realistic (dose, formulation, duration, adherence, setting, cost)?
- Are the outcomes the ones the patient cares about, measured at a meaningful time point?
- Is the comparator current standard of care — or a straw man?

## Bias beyond the single study

- **Funding source & conflicts of interest**: industry-funded trials are more likely to favor the sponsor, through design, analysis choice, and spin in the conclusion. Check the `redFlags` / COI fields and the sponsor.
- **Selective publication & outcome switching**: compare the published outcomes to the registered protocol on **ClinicalTrials.gov**, **ISRCTN**, or **EU-CTR**. Missing or re-labeled outcomes are a red flag.
- **Replication & pre-registration**: a single study, however good, is a hypothesis. Independent replication — ideally pre-registered and by a non-conflicted group — is the real test.
- **Data integrity**: gross inconsistencies, impossible variance, duplicated images, or numbers that fail **GRIM/GRIMMER/SPRITE** checks signal statistical ghosts or fabrication.

## Mechanism is a prior, not proof

Mechanistic plausibility (in vitro, animal, pathway data) lowers the bar for believing
an association, but bench/animal data is not human efficacy. Use mechanism to generate
hypotheses and to sanity-check implausible clinical claims — never as a substitute for
outcomes in actual patients.

## A short trust rule

> A claim is trustworthy enough to act on when it comes from a pre-registered,
> well-powered, low-risk-of-bias study (or better, a consistent, low-heterogeneity
> meta-analysis), in a population matching the patient, with a patient-important
> outcome, a clinically meaningful effect size and tight CI, replicated by an
> independent non-conflicted group, and the benefit outweighs the harms and costs in
> that context. Anything less is a graded hypothesis, not a fact.

## Quality checklist (run when a paper might drive a decision)

1. **Evidence score & confidence.** High score (4–5) + high confidence (>0.85) = strong signal. Low confidence on a high score = red flag. Always fetch the abstract.
2. **Study type vs. confidence mismatch.** A meta-analysis with `confidence: 0.3` is not a meta-analysis (probably a keyword false positive); fetch and read the abstract or full text.
3. **Limitations.** The `limitations[]` array surfaces: `title-only` (no abstract; can't grade reliably); `protocol` ("we will randomize…" misread as an RCT); `animal-study` (only humans/patients mentioned incidentally); `small-sample` (n < 20 in a control group; underpowered).
4. **Population match.** Check `population`. A study on healthy 20-year-olds is not directly applicable to 60-year-olds with hypertension.
5. **Dosage.** Check `dosage`; verify against the abstract — extraction is best-effort.
6. **Database source.** Non-PubMed results (Europe PMC, ChinaRXiv, RussiaRXiv) are graded keyword-only; treat their scores as provisional. If a non-PubMed paper looks pivotal, fetch the full text to verify.
7. **Fetch the abstract.** When in doubt, call `literature_fetch` with the PMID/id. Read the **Methods** and **Results** sections.
8. **Fetch the full text.** For papers about to drive a dose or clinical decision, call `literature_fulltext`. Check methods, sample size, statistical power, effect size, and confounders.
