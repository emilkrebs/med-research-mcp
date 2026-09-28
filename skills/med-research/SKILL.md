---
name: med-research
description: Use when researching biomedical, supplement, peptide, or biohacking evidence with the med-research-mcp MCP server (tools literature_search, literature_fetch, literature_fulltext). Covers writing precise PubMed queries with field tags, reading the evidence grades (0-5 scores, study types, confidence), choosing between search/fetch/fulltext, multi-database searches, and how to report findings. Three few-shot patterns (lookup, synthesis, bullshit) show the exact workflow. Trigger on questions about what the research/evidence says for a compound, dose, intervention, or biomarker.
---

# Using the med-research-mcp MCP

Three tools, a triage-first workflow. **Always start with `literature_search`** (free, keyword-graded). **Drill into specific papers with `literature_fetch`** (full abstracts + metadata). **Use `literature_fulltext`** only when the abstract isn't enough (methods, sample size, dosage).

## Decision flow

1. Turn the question into a precise query and call `literature_search`. Default database is `"pubmed"`; for broader coverage use `database: ["pubmed","europepmc"]`, `["pubmed","chinaxiv"]`, or `"all"`. PubMed field tags (`[tiab]`/`[mesh]`/`[au]`) **only work on pubmed**; other databases get bare keywords.
2. Sort attention by `evidenceScore`, but check `confidence` and `limitations` before trusting a grade.
3. `literature_fetch` the specific ids you care about to read full abstracts.
4. `literature_fulltext` **only** when you need more than the abstract — verify dosage, check sample sizes, read methods, detect statistical flaws.
5. Non-PubMed results are graded keyword-only — same score scale, lower `confidence`. Treat their study types as provisional.

## Writing good queries (`literature_search`)

Bare keywords match tens of thousands of papers and bury the signal. Use field tags and booleans.

- `[tiab]` — title/abstract (most precise): `creatine AND cognition[tiab]`
- `[mesh]` — controlled MeSH: `"Creatine"[mesh] AND "Cognition"[mesh]`
- `[au]` — author: `Kreider R[au]`
- Combine: `(ashwagandha[tiab]) AND (cortisol[tiab] OR stress[tiab]) AND humans[mesh]`
- Restrict to strong designs: `AND (randomized controlled trial[pt] OR meta-analysis[pt])` — `[pt]` is publication type.
- Narrow first. On `QUERY_TOO_BROAD`, add a `[tiab]` term or an `AND` clause.

Params: `database`, `maxResults` (default 10, max 50 — per-database, so two DBs return ~20), `minEvidenceScore` (4 = RCTs+meta-analyses/systematic reviews; 3 = +cohorts/non-randomized trials; unclassified results score 0 and get dropped too — read the warning), `studyTypes` (e.g. `["meta-analysis","randomized-controlled-trial"]`), `dateRange {from,to}`, `sort` ("relevance"|"date"), `language` (ISO 639-1; PubMed ignores it).

## Reading the grades (`GradedArticle`, higher = stronger)

| Score | Study type | Reading |
|-------|-----------|---------|
| 5 | meta-analysis / systematic-review | strongest; but a meta-analysis of weak studies is still weak — verify with fulltext if pivotal |
| 4 | randomized-controlled-trial | strong causal evidence |
| 3 | cohort / non-randomized-trial | observational or unrandomized; useful, confounding likely |
| 2 | case-control / cross-sectional | hypothesis-generating |
| 1 | case-report / review (narrative) | anecdote or unsystematic expert synthesis |
| 0 | animal-study / in-vitro | not directly applicable to humans |
| 0 | unknown | **unclassified, not weak** — fetch the abstract and judge yourself |

Scores start at the design's tier and are only rated **down**; `scoreAdjustments[]` says why (retracted, protocol, editorial, pilot, synthesis of animal/observational studies). Also read: `confidence` (0–1) — low confidence on a high score = escalate; `limitations[]` (`title-only`, `protocol`, `preprint`, `post-hoc`, `small-sample`); `dosage`/`population` (best-effort — confirm against the abstract).

## Tools, limits, errors

- `literature_fetch({ids:["39123456","38987654"], database:"pubmed"})` — full abstracts + MeSH + metadata, no grading (1–50 ids).
- `literature_fulltext({id:"39123456", doi:"10.1234/x"})` — article body as markdown via Unpaywall → proxy → DOI; abstract-only if paywalled.
- NCBI client is shared and serialized (3 req/s anonymous, 10 with `NCBI_API_KEY`): parallel calls are **safe** but don't run faster. Prefer a few precise queries.
- Errors: `QUERY_TOO_BROAD` (narrow + retry); `RATE_LIMIT` (wait `retryAfter`); `NETWORK_ERROR`/`PARSE_FAILURE` (retry once, then say the DB is unreachable).

## Reporting

Lead with the strongest evidence + its score/type; summarize consensus, then contradictions. Cite PMIDs so claims are checkable. Quote `dosage`/`population` for actionable questions and flag animal-only, tiny, or title-only results. Surface `redFlags` (COI, n<20, preprint, retracted). This is a research tool, not medical advice — add that caveat for dosing/clinical decisions.

## Three patterns (follow these, don't ad-lib)

### 1. Simple lookup — known PMID

> "What evidence score and study type does PMID 36615805 get?"

One call, no fan-out: `literature_fetch({ids:["36615805"], database:"pubmed"})` (or `literature_search({query:"36615805[pmid]"})`). Read `evidenceScore` + `studyType` + `confidence`. If `confidence` is low or `limitations` flags `protocol`/`title-only`, fetch fulltext first. Answer: *"Score 5, meta-analysis (PMID 36615805), confidence 0.9."* Stop.

### 2. Evidence synthesis — compare X vs Y

> "Compare DORAs vs trazodone for sleep quality. Which has stronger evidence, and why?"

Frame PICO, then two targeted searches (one per arm, study-type filter): `suvorexant OR lemborexant OR daridorexant AND sleep quality[tiab] AND (meta-analysis[pt] OR randomized controlled trial[pt])`, and `trazodone AND sleep quality[tiab] AND (...)`. `literature_fetch` the top 2–3 PMIDs per arm; read effect sizes + CIs, n, I². Decide the winner **by evidence tier** (a meta-analysis of RCTs beats one small RCT), not raw effect size. Name which arm is stronger and why; cite PMIDs; flag heterogeneity/COI/GRADE. Cap at ~6 calls.

### 3. Bullshit detection — the study doesn't exist

> "Summarize the 2023 Jensen trial on melatonin and REM sleep."

Search author+topic then title terms: `Jensen[au] AND melatonin AND REM sleep`, then `Jensen melatonin REM sleep 2023`. **Zero corroborating results after 2–3 distinct queries → STOP** — don't keep reformulating 8–10 times and return empty. Answer plainly: *"I could not find this trial in PubMed; it does not appear to exist."* Invent no PMID, cite no fabricated study. Suggest the user double-check the reference. (This corrects the real failure mode: empty final text after exhausting the step budget.)

## Small-model tips

- **Patterns beat rules.** Follow the three examples above; don't improvise a new strategy per query.
- **Budget your calls:** 1 for a lookup, ~4–6 for synthesis, ≤3 before rejecting a phantom study.
- **Zero results after 2 reformulations → stop and say so.** Never return an empty answer; a caveat beats silence.
- **Every claim gets a PMID you got from a tool call.** Never type a PMID from memory — it's fabrication.
- **Lead with the bottom line, then the evidence.** State the winner/number first; back it with the grade + citation + redFlags.

## When to go deeper (EBM)

The `0–5` score orients you; it does not appraise a study. When a paper is about to drive a real decision and you need risk-of-bias (RoB 2 / ROBINS-I), AMSTAR-2, effect sizes/CIs/NNT, heterogeneity, Bradford Hill causation, or applicability checks, load the **`med-research-ebm`** reference skill. Don't load it for routine searches — it's heavy.
