---
name: med-research
description: Use when researching biomedical, supplement, peptide, or biohacking evidence with the med-research-mcp MCP server (tools literature_search, literature_fetch, literature_fulltext). Covers writing precise PubMed queries with field tags, reading the evidence grades (0-5 scores, study types, confidence), choosing between search/fetch/fulltext, multi-database searches, and evidence-based-medicine best practices (PICO framing, critical appraisal by study type, effect-size/CI interpretation, risk-of-bias, meta-analysis checks, causation, applicability, conflicts of interest). Trigger on questions about what the research/evidence says for a compound, dose, intervention, or biomarker.
---

# Using the med-research-mcp MCP

Three tools, a triage-first workflow. **Always start with `literature_search`** (free, keyword-graded). **Drill into specific papers with `literature_fetch`** (full metadata + abstracts). **Use `literature_fulltext`** only when you need more than the abstract (methods, sample sizes, dosage details).

## Decision flow

1. Turn the question into a precise query and call `literature_search`.
   - Default database is `"pubmed"`; for broader coverage use `database: ["pubmed", "europepmc"]`, `["pubmed", "chinaxiv"]`, or `"all"`.
   - Tip: PubMed field tags (`[tiab]`, `[mesh]`, `[au]`) **only work on the pubmed database**; other databases receive bare keywords.
2. Read the graded results: sort your attention by `evidenceScore`, but check `confidence` and `limitations` before trusting a grade.
3. For papers you want to drill into, call `literature_fetch` with the specific ids to get full abstracts and MeSH terms.
4. Call `literature_fulltext` **only** when you need more than the abstract — to verify dosage, check sample sizes, read methods, or detect statistical flaws.
5. For multi-database searches, understand that **PubMed results benefit from NLM `PublicationType` tags** (high confidence grading); **non-PubMed results are graded keyword-only and score lower** — treat their scores as less reliable.

## Writing good queries (`literature_search`)

Bare keywords match tens of thousands of papers and bury the signal. Use field tags and boolean operators.

- `[tiab]` — title/abstract (most useful for precision): `creatine AND cognition[tiab]`
- `[mesh]` — controlled MeSH vocabulary: `"Creatine"[mesh] AND "Cognition"[mesh]`
- `[au]` — author: `Kreider R[au]`
- Combine: `(ashwagandha[tiab]) AND (cortisol[tiab] OR stress[tiab]) AND humans[mesh]`
- Restrict to strong designs by adding terms: `AND (randomized controlled trial[pt] OR meta-analysis[pt])` — `[pt]` is publication type.
- Prefer narrow first. If you get `QUERY_TOO_BROAD` or a "matched N articles" warning, add a `[tiab]` term or an `AND` clause.

Parameters worth setting:
- `database` — `"pubmed"` (default), `"europepmc"`, `"chinaxiv"`, `"russiarxiv"`, or `"all"` to search all four. PubMed-specific field tags only work on `pubmed`; other databases receive bare keywords.
- `maxResults` (default 10, max 50) — 5–10 is usually enough for a first pass. Note: per-database, so `database: ["pubmed", "europepmc"], maxResults: 10` returns ~20 results total.
- `minEvidenceScore` — set to `4` to see only RCTs and meta-analyses, `3` to include cohorts/reviews. Non-PubMed results score lower (keyword-only), so this filter is most reliable on PubMed.
- `studyTypes` — e.g. `["meta-analysis","randomized-controlled-trial"]` to filter. Narrows quickly.
- `dateRange` `{from,to}` (YYYY-MM-DD) — for "recent evidence" questions.
- `sort` — `"relevance"` (default) or `"date"`.
- `language` — ISO 639-1 (e.g. `"es"` for Spanish, `"pt"` for Portuguese). Some databases (SciELO, CyberLeninka) respect this hint; PubMed ignores it.

## Reading the grades

Each result from `literature_search` is a `GradedArticle`. Evidence scale (higher = stronger):

| Score | Study type | Reading |
|-------|-----------|---------|
| 5 | meta-analysis / systematic review | strongest; but a meta-analysis of weak studies is still weak — fetch the full text and read the methods if it’s pivotal |
| 4 | randomized-controlled-trial | strong causal evidence |
| 3 | cohort **or** review | observational or narrative; useful, not causal |
| 2 | case-control | hypothesis-generating |
| 1 | case-report | anecdote; one patient |
| 0 | animal-study / unknown | not directly applicable to humans |

## Best practices of medical evaluation

The grade orients you; evidence-based medicine (EBM) tells you what to actually trust. Run every pivotal paper through these lenses before letting it drive a decision.

### Frame the question with PICO(S)

Before searching, state the question explicitly:
- **P**opulation — who (age, condition, stage, comorbidity)?
- **I**ntervention — what exposure, drug, dose, formulation, protocol?
- **C**omparator — placebo, standard care, alternative?
- **O**utcome — what patient-important endpoint (mortality, function, symptom score, QoL)?
- **(S)tudy design** — what would the ideal study be (RCT, cohort, n-of-1)?

A question you cannot state in PICO form is too vague to answer with literature. Reuse the same PICO to decide whether a returned paper actually answers *your* question, not some adjacent one.

### Hierarchy of evidence (a prior, not a verdict)

Roughly, in descending trust: meta-analysis of RCTs > single large multi-center RCT > small RCT > prospective cohort > case-control > case series > bench/animal > expert opinion. The `evidenceScore` encodes this, but a meta-analysis of flawed small trials still ranks low — hierarchy is where you start, not where you finish.

### Critical appraisal by study type

Match the appraisal tool to the design rather than applying one checklist to everything:

- **RCTs** — Cochrane **RoB 2** (sequence generation, allocation concealment, blinding, missing-outcome data, deviations from protocol, selective reporting). Check **CONSORT** reporting adherence.
- **Non-randomized (cohort/case-control)** — **ROBINS-I** (confounding, selection, intervention classification, deviations, missing data, outcome measurement, selective reporting).
- **Systematic reviews / meta-analyses** — **AMSTAR-2** (or **ROBIS**); also **PRISMA** for reporting completeness and the flow diagram.
- **Diagnostic accuracy** — **QUADAS-2**.
- **Prognosis** — **QUIPS**.
- **Case reports** — **CARE**.

Generic red flags across all designs: lack of randomization, unblinded subjective outcomes, post-hoc subgroup "discoveries", per-protocol instead of intention-to-treat analysis, and outcome switching versus the registered protocol.

### Statistics: effect size and clinical significance

- Prefer **effect sizes with 95% confidence intervals** over bare p-values. A p<0.05 on a tiny effect is meaningless; a CI that crosses the null is inconclusive no matter the p.
- **RRR vs ARR vs NNT**: relative risk reduction inflates apparent benefit; absolute risk reduction grounds it. NNT = 1/ARR — the patients you must treat to prevent one event.
- Know the **MCID** (minimum clinically important difference) for the outcome. A statistically significant 0.3-point gain on a 100-point scale is rarely worth a drug's harms and cost.
- **SMD / Cohen's d** for continuous outcomes: 0.2 small, 0.5 medium, 0.8 large — but always translate back to the outcome's native units.
- **Surrogate endpoints** (biomarker, lab value, imaging) are weaker than **patient-important outcomes** (mortality, function, quality of life). A drug lowering HbA1c or LDL does not automatically mean fewer heart attacks or longer life — confirm the hard endpoints.
- **Non-inferiority** trials answer a different question than superiority; always check the non-inferiority margin, which is easily gamed.
- Watch for **multiplicity**: many tested outcomes/subgroups guarantee some p<0.05 by chance; demand a pre-specified primary endpoint and correction.

### Meta-analysis-specific checks

- **Heterogeneity (I²)**: <25% low, 25–50% moderate, >50% substantial. High I² means a single pooled estimate is misleading — read the forest plot and subgroups, don't trust the diamond.
- **Publication bias**: inspect the funnel plot (or Egger's test). Asymmetry suggests suppressed null/negative studies, inflating the pooled effect.
- **Prediction interval** (random-effects) is more honest than the CI — it shows the plausible range of true effects across future settings.
- **PICO consistency**: does pooling apples and oranges actually answer one question? A meta-analysis is only as good as the studies it ingests.

### Causation vs association

Observational studies show association, not causation. For causal claims weigh the **Bradford Hill criteria**: strength, consistency, specificity, temporality, biological gradient, plausibility, coherence, experiment, analogy. Temporality (exposure before outcome) is non-negotiable. **Confounding by indication** and **reverse causation** are the usual suspects in pharmaco-epidemiology. **Mendelian randomization** and natural experiments (policy changes, off-season birth cohorts) strengthen causal inference where RCTs are unethical.

### Applicability / external validity

A trial that is internally perfect but run on the wrong population does not answer your question. Ask:
- Does the study population match the patient (age, sex, comorbidity, disease severity, setting)?
- Is the intervention realistic (dose, formulation, duration, adherence, setting, cost)?
- Are the outcomes the ones the patient cares about, measured at a meaningful time point?
- Is the comparator current standard of care — or a straw man?

### Bias beyond the single study

- **Funding source & conflicts of interest**: industry-funded trials are more likely to favor the sponsor, through design, analysis choice, and spin in the conclusion. Check the `redFlags` / COI fields and the sponsor.
- **Selective publication & outcome switching**: compare the published outcomes to the registered protocol on **ClinicalTrials.gov**, **ISRCTN**, or **EU-CTR**. Missing or re-labeled outcomes are a red flag.
- **Replication & pre-registration**: a single study, however good, is a hypothesis. Independent replication — ideally pre-registered and by a non-conflicted group — is the real test.
- **Data integrity**: gross inconsistencies, impossible variance, duplicated images, or numbers that fail **GRIM/GRIMMER/SPRITE** checks signal statistical ghosts or fabrication.

### Mechanism is a prior, not proof

Mechanistic plausibility (in vitro, animal, pathway data) lowers the bar for believing an association, but bench/animal data is not human efficacy. Use mechanism to generate hypotheses and to sanity-check implausible clinical claims — never as a substitute for outcomes in actual patients.

### A short trust rule

> A claim is trustworthy enough to act on when it comes from a pre-registered, well-powered, low-risk-of-bias study (or better, a consistent, low-heterogeneity meta-analysis), in a population matching the patient, with a patient-important outcome, a clinically meaningful effect size and tight CI, replicated by an independent non-conflicted group, and the benefit outweighs the harms and costs in that context. Anything less is a graded hypothesis, not a fact.

## Evaluating quality: the full checklist

Don't just trust the score. Use this checklist when a paper might drive a real decision:

1. **Evidence score & confidence.** High score (4–5) + high confidence (>0.85) = strong signal. Low confidence on a high score = red flag. Always fetch the abstract.
2. **Study type vs. confidence mismatch.** A meta-analysis with `confidence: 0.3` is not a meta-analysis (probably a keyword false positive); fetch and read the abstract or full text.
3. **Limitations.** The `limitations[]` array surfaces:
   - `title-only` — no abstract available; can't grade reliably.
   - `protocol` — "we will randomize..." instead of "we randomized"; misread as RCT.
   - `animal-study` — only humans/patients mentioned incidentally; downgraded but watch out.
   - `small-sample` — n < 20 in a control group; underpowered.
4. **Population match.** Check `population` field. A study on healthy 20-year-olds is not directly applicable to 60-year-olds with hypertension.
5. **Dosage.** Check `dosage` field. Verify against the abstract — extraction is best-effort.
6. **Database source.** Non-PubMed results (Europe PMC, ChinaRXiv, RussiaRXiv) are graded keyword-only; treat their scores as provisional. If a non-PubMed paper looks pivotal, fetch the full text to verify.
7. **Fetch the abstract.** When in doubt, call `literature_fetch` with the PMID/id. Read the **Methods** and **Results** sections.
8. **Fetch the full text.** For papers about to drive a dose or clinical decision, call `literature_fulltext`. Check methods, sample size, statistical power, effect size, and confounders.

## Fetching details (`literature_fetch`)

Use to drill into specific papers after `literature_search`. Pass one or more `ids` (PubMed IDs for pubmed, SciELO ids for scielo, etc.) and the `database` string.

```
literature_fetch({ 
  ids: ["39123456", "38987654"],  // one or more ids, 1–50
  database: "pubmed"                // pubmed, europepmc, chinaxiv, or russiarxiv
})
```

Returns raw article objects with **full abstracts, MeSH headings, references, and metadata** — no grading. Use this to read the abstract before committing to `literature_fulltext`.

## Full text (`literature_fulltext`)

Use to read the paper when the abstract isn't enough (methods, sample size, statistical power, dosage details, conflicts of interest). Database-agnostic via DOI.

```
literature_fulltext({
  pmid: "39123456",              // a PMID, or a non-PubMed id (then require doi below)
  doi: "10.1234/example"         // optional; if you know it, skips id→DOI lookup
})
```

Resolves via **Unpaywall** (open access first), then **institutional proxy** (if configured), then **direct DOI access**. Falls back to abstract-only if paywalled. Returns the article body as markdown.

**When to use:** when the keyword grade is suspicious, when sample size / effect size / methods matter for the decision, or when you need to verify a quoted dosage.

## Rate limits & parallel calls

The server shares one NCBI client across all tool calls and serializes its requests to stay under NCBI's limit (3 req/s anonymous, 10 with `NCBI_API_KEY`). So firing several `literature_search`/`literature_fetch` calls at once is **safe** — they queue rather than fail — but they don't run faster, and a big fan-out adds latency. Prefer a few precise queries over many broad ones. If you still see `RATE_LIMIT`, back off per `retryAfter`.

## Errors (returned as typed `PubMedError`)

- `QUERY_TOO_BROAD` (recoverable) — narrow with `[tiab]`/`[mesh]`/`AND`, then retry.
- `RATE_LIMIT` (recoverable, `retryAfter`) — wait the given seconds; back off.
- `NETWORK_ERROR` / `PARSE_FAILURE` — retry once; if it persists, tell the user the database is unreachable.

## Reporting to the user

- Lead with the strongest evidence and its score/type; summarize the consensus, then note contradictions.
- Cite PMIDs so claims are checkable.
- Quote `dosage`/`population` when the user asked something actionable, and flag when a result is animal-only, tiny, or title-only.
- Surface `redFlags` (conflicts of interest, tiny sample, preprint, retracted) from the abstract when reading one.
- This is a research tool, not medical advice. For dosing or clinical decisions, add a caveat and encourage professional consultation.
