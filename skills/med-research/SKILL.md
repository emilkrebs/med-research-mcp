---
name: med-research
description: Use when researching biomedical, supplement, peptide, or longevity evidence with the med-research-mcp MCP server (tools literature_search, literature_fetch, literature_fulltext). Covers writing precise PubMed queries with field tags, reading study designs (studyType, 0-5 designTier, flags), classifying unlabeled papers from the abstract, the ground rules of weighing evidence, choosing between search/fetch/fulltext, multi-database searches, and how to report findings. Three few-shot patterns (lookup, synthesis, bullshit) show the exact workflow. Trigger on questions about what the research/evidence says for a compound, dose, intervention, or biomarker.
---

# Using the med-research-mcp MCP

Three tools, a triage-first workflow. **Always start with `literature_search`** (free, designs labeled from NLM metadata), drill into papers with `literature_fetch`, and use `literature_fulltext` only when the abstract isn't enough.

## Decision flow

1. Turn the question into a query (below) and call `literature_search`. Default database is `"pubmed"`; for broader coverage use `["pubmed","europepmc"]`, `["pubmed","chinaxiv"]`, or `"all"`. For a preprint or a paper outside MEDLINE search `"europepmc"` alone (`SRC:PPR` keeps preprints only; PubMed reads it as words and has the NIH-supported ones). `"russiarxiv"` is Soviet-era papers, mostly mathematics, physics and chemistry, almost no medicine: a zero there is not "no Russian research exists".
2. Read `warnings` and `flags` first. Then **read the abstract of every result whose `designTier` is `null`**: unclassified records and most meta-analyses/systematic reviews. Null means unrated, not weak.
3. `literature_fetch` the ids you care about (with their `database`) to read whole abstracts.
4. `literature_fulltext` **only** when the abstract isn't enough: dosage, sample sizes, methods, statistical flaws.
5. Europe PMC records indexed in MEDLINE carry the same NLM labels as PubMed. Its preprints (`PPR…`) and `CBA:…` records have no design tag, so they are `unknown`, like all ChinaXiv/RussiaRxiv records — you classify them. ChinaXiv/RussiaRxiv come through ChinaRxiv, a third-party service; ChinaXiv records are preprints.

## Writing good queries (`literature_search`)

2–5 keywords, never a sentence: every word must match, so each extra word narrows the result. On 0 results the warning names the word that blocks a query of plain words (no quotes, tags or operators), or says no single word does (use fewer, more general words); with tags, drop one clause at a time. `PubMed ignored "word"` means no record contains it: check the spelling. `PubMed has no phrase "…"` means PubMed found no such phrase and searched its words separately, anywhere in a record. Tags and booleans add precision on PubMed and Europe PMC; `chinaxiv`/`russiarxiv` ignore them.

- `[tiab]` — title/abstract (most precise): `zinc[tiab] AND ("common cold"[tiab] OR rhinovirus[tiab])`. Quote a phrase before its tag or tag each word: Europe PMC drops the tag of `common cold[tiab]`.
- `[mesh]` — controlled MeSH, PubMed only: `"Zinc"[mesh] AND "Common Cold"[mesh]`
- `[au]` — author: `Hemilä H[au]`
- `[pt]` — publication type, for strong designs: `AND (meta-analysis[pt] OR "randomized controlled trial"[pt])`
- Europe PMC reads `[tiab] [ti] [au] [pt] [ta] [la] [dp] [pmid]` and drops other tags, so their words match full text.
- `chinaxiv`/`russiarxiv` return only records containing **every** word, and read `OR` as a word: give them one or two key words.

Params (the tool descriptions have the rest):

- `maxResults` (default 10, max 50) counts **per database and page**: two databases return up to 20.
- `abstractMaxChars` cuts abstracts to that many characters (0 leaves them out). Ten whole abstracts run 20,000–30,000 characters: with several databases or many results set one (600 halves it). `abstractTruncated: true` (also on ChinaXiv/RussiaRxiv previews, cut at 500 characters) means `literature_fetch` the record for the whole abstract.
- `page`: pass a result's `nextPage` with the same `maxResults` to read on. Each page is sorted on its own.
- `studyTypes` (e.g. `["meta-analysis","systematic-review","randomized-controlled-trial"]`): **use this to keep reviews and trials**. `cohort`, `case-control`, `cross-sectional` and `in-vitro` never match.
- `minDesignTier` (4 = RCTs): drops every `null` tier, including most meta-analyses; read the warning.

## Reading the design labels (`GradedArticle`)

`studyType` comes **only** from NLM PublicationType tags — no text guessing. NLM now assigns them by automated indexing, with human review of only some records, so treat them as a strong prior: confirm in the abstract when it matters. † marks what only you assign, from the abstract: the tool never returns tier 3, gives 5 only to a Network Meta-Analysis tag, and never names `cohort`, `case-control`, `cross-sectional` or `in-vitro` (tagged observational studies come back as `observational`). `designTier` ranks the design for "does this intervention help?" by the OCEBM 2011 levels [1] — a prior, **not an appraisal**.

| designTier | studyType | Reading |
|-----------|-----------|---------|
| 5 | meta-analysis / systematic-review **of randomized trials** † | most reliable design for treatment effects; a review of weak trials is still weak |
| 4 | randomized-controlled-trial | randomized comparison. NLM also tags secondary/post-hoc analyses of trials this way — check that the comparison you cite is the randomized one |
| 3 | cohort † | observational with a comparison group; confounding likely |
| 2 | non-randomized-trial · clinical-trial · observational · case-control † · cross-sectional † | controlled but not randomized (historical controls possible) · a trial whose randomization and control aren't indexed (may be single-arm) · an observational study of unindexed design · hypothesis-generating designs |
| 1 | case-report · review | anecdote · review article not indexed as systematic (16% of 2023 papers titled "systematic review" carry only this tag — check) |
| 0 | animal-study · in-vitro †, or any record flagged `retracted` / `notice` / `protocol` / `editorial` | not usable as evidence for human benefit |
| `null` | meta-analysis / systematic-review | **what it pooled isn't in the metadata** — read the abstract: of RCTs → tier 5; of observational studies → the tier of those studies |
| `null` | unknown | **no design metadata, not weak** — recent, non-MEDLINE or regional record; classify it yourself |

`flags` — tier 0: `retracted` (never cite as support), `notice` (a retraction notice, expression of concern or erratum, not a study), `protocol` (planned study, no results), `editorial` (opinion or commentary). Warnings, tier unchanged: `expression-of-concern` (the journal doubts its integrity; don't rely on it alone), `corrected` (an erratum exists — check the numbers you quote), `updated` (a newer version exists: an updated Cochrane review, or a preprint's published article, whose id is in `corrections` — cite that one, fetching it if needed), `animals-not-humans` (MeSH lists animals but not humans; usually an animal study, but automated indexing sometimes drops the Humans tag from real human trials [9] — check the abstract), `preprint` (not peer reviewed), `letter` (may be correspondence or a short research report), `machine-translated` (ChinaXiv/RussiaRxiv text is a machine translation — confirm numbers in `originalUrl`), `machine-generated-abstract` (the abstract is ChinaRxiv's summary, not the authors' — never quote it as the paper's findings). Dosage, population, sample size and limitations are **not extracted** — read them in the abstract.

### Classifying from the abstract

Use the same labels. Do it for `unknown` results, and refine `clinical-trial`, `observational` and unrated syntheses. Classify **the paper's own design**, not designs it mentions ("previous RCTs showed…", "further trials are needed" describe other work). Reporting guidelines ask authors to name the design in the title or abstract [10].

- Pooled studies found by a stated search → `meta-analysis` (pooled numerically) / `systematic-review`, and note **what designs it pooled**. An unsystematic overview → `review`.
- Investigators **assigned** the intervention: randomly → `randomized-controlled-trial`; with a non-random control group → `non-randomized-trial`; single-arm → `clinical-trial` (rank it like a case series).
- Observed only: groups compared over time → `cohort`; cases compared with controls → `case-control`; one time point or a survey → `cross-sectional`; one or a few patients → `case-report`.
- Animals or cells only, no human participants → `animal-study` / `in-vitro`, even if randomized.
- Future tense ("we will randomize"), "protocol" → a protocol, not results. Unsure between two designs → take the lower one.

Say when a design is your reading of the abstract, not a database label.

## Ground rules of evidence

Apply these to every answer, not only pivotal ones.

1. **Design is the starting point, not the verdict.** Certainty drops for risk of bias, imprecision, inconsistency, indirectness and publication bias [2], and can rise for a large effect [1] or a dose–response gradient [3].
2. **The best design depends on the question.** Treatment benefit: randomized trials. Harms: randomized trials too, but rare or long-term harms often show only in large observational follow-up (post-marketing surveillance). Prognosis: inception cohorts. Diagnostic accuracy: cross-sectional studies against a reference standard [1]. The tier assumes a treatment-benefit question.
3. **Association is not causation.** Observational studies show associations that confounding or reverse causation can explain. Weigh causal claims with the Bradford Hill considerations, none of which settles causation on its own [3]; a cause must precede its effect, so always check temporality.
4. **Absence of evidence is not evidence of absence.** No trial found, or a non-significant result with a wide confidence interval, means "unknown", not "doesn't work" [4].
5. **Weigh all the evidence, not the study that agrees.** Search for null and negative results too, and prefer systematic reviews. Small, single, surprising or implausible positive findings are often false [5].
6. **Effect size and relevance over p-values.** Report absolute effects with confidence intervals; a statistically significant change can be clinically irrelevant [1].
7. **Improvement without a control group proves little.** Regression to the mean [6] and placebo effects, which can influence patient-reported outcomes such as pain and nausea [7], make before–after studies and single-arm trials look effective.
8. **Directness.** The population, intervention and dose, comparator and outcome must match the question; surrogate outcomes and animal data are indirect [8].
9. **Newer, larger trials can overturn earlier evidence.** Large RCTs agreed only fairly with earlier meta-analyses (κ = 0.35) [11], and 40% of established practices tested in one major journal over 10 years were reversed [12]. Check dates; prefer the latest systematic review.
10. **State certainty honestly.** Use GRADE's levels [2] and matching wording: "results in" (high), "likely results in" (moderate), "may result in" (low) [13]; for very low certainty say the evidence is very uncertain.

## Tools, limits, errors

- `literature_fetch({ids:["39123456","38987654"], database:"pubmed"})` — 1–50 ids of one database (a result's `id` and `database`): whole abstracts, publication types, MeSH, retraction/correction links, and the same `studyType`/`designTier`/`flags` as search.
- `literature_fulltext({id:"39123456"})` — article body as markdown via Europe PMC (records with a `pmcid`) → Unpaywall → proxy → DOI; otherwise the abstract, and `warning` says why. A result's `id` works alone, with its prefix (`CBA:644599`; a bare number is a PMID); `doi` is only for an id Europe PMC doesn't know; a `url` is not a DOI. `warning` opens with `RETRACTED:`, `NOTICE:` or `EXPRESSION OF CONCERN:` when the record has that flag, even if the text came (say so first); it reads the record as the databases report it at the time, so the flags of search or fetch are the authority. A long text comes in parts: while `truncated` is true, call again with `offset: nextOffset`.
- NCBI is rate-limited: parallel calls are **safe** but don't run faster. Prefer a few precise queries.
- Errors: `QUERY_TOO_BROAD` (narrow: add a `[tiab]` term or an `AND` clause); `RATE_LIMIT` (the server already retried; wait `retryAfter`); `NETWORK_ERROR`/`PARSE_FAILURE` (retry once, then say the DB is unreachable); `TIMEOUT` (retry, then ask for an earlier page or narrow the query); `INVALID_INPUT` and schema errors (fix the parameter named: database ids are lower case, dates must exist). In a multi-database search, a database that fails while others answer shows up only in `warnings` (`<database> search failed: …`): say which is missing, never report it as "no studies found".

## Reporting

Lead with the strongest evidence, its design and how certain it is; summarize consensus, then contradictions. **If a record you rely on is flagged `retracted`, `notice` or `protocol`, the answer's first sentence says so.** Cite the `id` the tool returned, as "PMID …" only when the record has `pmid`, otherwise with its database (`PPR…`, `chinaxiv-…`) or the `doi`/`url`; never type an id from memory. Report doses and populations as what the studies used and found, quoted **from the abstract or the full text you read** (say which), not as recommendations, and call out animal-only, tiny or abstract-less results. Surface the other `flags` (expression of concern, updated, preprint, machine-translated) and what you read yourself (COI, n<20). This is a research summary, not medical advice: say so when the question is about dosing or treatment, and point to a healthcare professional for decisions about a person's care.

## Three patterns (follow these, don't ad-lib)

### 1. Simple lookup — known PMID

> "What study design is PMID 22570464, and how strong is that design?"

One call, no fan-out: `literature_search({query:"22570464[pmid]"})` — it returns `studyType`, `designTier`, `flags` and the abstract. If `flags` has `retracted`/`notice`/`protocol`, say so first. If `designTier` is `null`, read the abstract: for a synthesis, find what it pooled; for `unknown`, classify it (above) and say so. Answer: *"Systematic review and meta-analysis of randomized controlled trials — 82 met the inclusion criteria, 63 were pooled (NLM tag; pooled designs from the abstract): design tier 5 of 5 (PMID 22570464)."* Stop.

### 2. Evidence synthesis — compare X vs Y

> "Compare intranasal corticosteroids vs oral antihistamines for allergic rhinitis symptoms. Which has stronger evidence, and why?"

Frame PICO, then two targeted searches (one per arm, study-type filter): `"intranasal corticosteroid*"[tiab] AND "allergic rhinitis"[tiab] AND (meta-analysis[pt] OR "randomized controlled trial"[pt])`, and `"oral antihistamine*"[tiab] AND "allergic rhinitis"[tiab] AND (...)`. `literature_fetch` the top 2–3 ids per arm; read what each review pooled, effect sizes + CIs, n, I². Judge **which arm's evidence is more certain**, not which effect is bigger: start from design (a meta-analysis of RCTs beats one small RCT), then rate down as in ground rule 1. Name which arm is stronger and why; cite ids; state certainty in GRADE terms. Cap at ~6 calls.

### 3. Bullshit detection — the study doesn't exist

> "Summarize the 2020 Nilsen trial on taurine and slow-wave sleep."

Search author+topic, then title terms, then both databases: `Nilsen[au] AND taurine AND sleep`; `taurine slow-wave sleep 2020`; `taurine slow-wave sleep Nilsen` with `database: ["pubmed","europepmc"]`. **Nothing corroborating after these three queries → STOP** — don't keep reformulating 8–10 times and return empty. Answer plainly, naming the databases searched (`databases` in the result): *"I could not find this trial in PubMed or Europe PMC; it does not appear to exist."* Invent no id, cite no fabricated study. Suggest the user double-check the reference.

## Small-model tips

- **Budget your calls:** 1 for a lookup, ~4–6 for synthesis, three queries (pattern 3) before you say nothing was found. Then stop and say so: never return an empty answer; a caveat beats silence.
- **Lead with the bottom line:** the winner or number first, then design, certainty, citation, flags.

## When to go deeper (EBM)

The `0–5` design tier orients you; it does not appraise a study. When a conclusion will rest on one paper and you need risk-of-bias (RoB 2 / ROBINS-I), AMSTAR 2, effect sizes/CIs/NNT, heterogeneity, Bradford Hill causation, or applicability checks, load the **`med-research-ebm`** reference skill. Don't load it for routine searches — it's heavy.

## References

1. OCEBM Levels of Evidence Working Group. The Oxford 2011 Levels of Evidence, and its Introductory Document. Oxford Centre for Evidence-Based Medicine. https://www.cebm.ox.ac.uk/resources/levels-of-evidence/ocebm-levels-of-evidence
2. Balshem H, et al. GRADE guidelines: 3. Rating the quality of evidence. J Clin Epidemiol 2011;64:401-6. PMID 21208779
3. Hill AB. The environment and disease: association or causation? Proc R Soc Med 1965;58:295-300. PMID 14283879
4. Altman DG, Bland JM. Absence of evidence is not evidence of absence. BMJ 1995;311:485. PMID 7647644
5. Ioannidis JPA. Why most published research findings are false. PLoS Med 2005;2:e124. PMID 16060722
6. Barnett AG, et al. Regression to the mean: what it is and how to deal with it. Int J Epidemiol 2005;34:215-20. PMID 15333621
7. Hróbjartsson A, Gøtzsche PC. Placebo interventions for all clinical conditions. Cochrane Database Syst Rev 2010;CD003974. PMID 20091554
8. Guyatt GH, et al. GRADE guidelines: 8. Rating the quality of evidence — indirectness. J Clin Epidemiol 2011;64:1303-10. PMID 21802903
9. Askin N, et al. Filtering failure: the impact of automated indexing in Medline on retrieval of human studies for knowledge synthesis. J Med Libr Assoc 2025. PMID 39975499
10. Hopewell S, et al. CONSORT 2025 statement. BMJ 2025;389:e081123 (PMID 40228833), item 1a; Vandenbroucke JP, et al. STROBE: explanation and elaboration. PLoS Med 2007;4:e297 (PMID 17941715), item 1a; Page MJ, et al. The PRISMA 2020 statement. BMJ 2021;372:n71 (PMID 33782057), item 1
11. LeLorier J, et al. Discrepancies between meta-analyses and subsequent large randomized, controlled trials. N Engl J Med 1997;337:536-42. PMID 9262498
12. Prasad V, et al. A decade of reversal: an analysis of 146 contradicted medical practices. Mayo Clin Proc 2013;88:790-8. PMID 23871230
13. Santesso N, et al. GRADE guidelines 26: informative statements to communicate the findings of systematic reviews of interventions. J Clin Epidemiol 2020;119:126-135. PMID 31711912
