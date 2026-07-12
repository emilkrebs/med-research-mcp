---
name: pubmed-research
description: Use when researching biomedical, supplement, peptide, or biohacking evidence with the pubmed-bio MCP server (tools pubmed_search and pubmed_grade). Covers writing precise PubMed queries with field tags, reading the evidence grades (0-5 scores, study types, confidence), and when to escalate from the cheap keyword grade to LLM deep-grading. Trigger on questions about what the research/evidence says for a compound, dose, intervention, or biomarker.
---

# Using the pubmed-bio MCP

Two tools, a cheap-first workflow. **Always start with `pubmed_search`** (free, keyword-graded). **Escalate to `pubmed_grade`** (LLM, costs tokens) only for the few papers where the stakes justify it.

## Decision flow

1. Turn the question into a precise PubMed query (see below) and call `pubmed_search`.
2. Read the graded results: sort your attention by `evidenceScore`, but check `confidence` and `limitations` before trusting a grade.
3. Escalate a specific `pmid` to `pubmed_grade` when **any** of these hold:
   - A single paper is about to drive a real decision (a dose, a "should I take X").
   - The keyword grade looks suspicious: high score but low `confidence`, or `limitations` flags a protocol/animal/false-positive.
   - Results contradict each other and you need to know which study is actually stronger.
   - You need extracted specifics the keyword path can't give: sample size, effect size, PICO, funding/conflicts.
4. Never escalate the whole result set — that burns tokens. Grade 1–3 pivotal papers at most.

## Writing good queries (`pubmed_search`)

Bare keywords match tens of thousands of papers and bury the signal. Use field tags and boolean operators.

- `[tiab]` — title/abstract (most useful for precision): `creatine AND cognition[tiab]`
- `[mesh]` — controlled MeSH vocabulary: `"Creatine"[mesh] AND "Cognition"[mesh]`
- `[au]` — author: `Kreider R[au]`
- Combine: `(ashwagandha[tiab]) AND (cortisol[tiab] OR stress[tiab]) AND humans[mesh]`
- Restrict to strong designs by adding terms: `AND (randomized controlled trial[pt] OR meta-analysis[pt])` — `[pt]` is publication type.
- Prefer narrow first. If you get `QUERY_TOO_BROAD` or a "matched N articles" warning, add a `[tiab]` term or an `AND` clause.

Parameters worth setting:
- `maxResults` (default 10, max 50) — 5–10 is usually enough for a first pass.
- `minEvidenceScore` — set to `4` to see only RCTs and meta-analyses, `3` to include cohorts/reviews.
- `studyTypes` — e.g. `["meta-analysis","randomized-controlled-trial"]` to filter.
- `dateRange` `{from,to}` (YYYY-MM-DD) — for "recent evidence" questions.
- `sort` — `"relevance"` (default) or `"date"`.

## Reading the grades

Each result is a `GradedArticle`. Evidence scale (higher = stronger):

| Score | Study type | Reading |
|-------|-----------|---------|
| 5 | meta-analysis / systematic review | strongest; but a meta-analysis of weak studies is still weak — verify with `pubmed_grade` if it's pivotal |
| 4 | randomized-controlled-trial | strong causal evidence |
| 3 | cohort **or** review | observational or narrative; useful, not causal |
| 2 | case-control | hypothesis-generating |
| 1 | case-report | anecdote; one patient |
| 0 | animal-study / unknown | not directly applicable to humans |

Also read:
- `confidence` (0–1): how sure the classifier is. **Low confidence on a high score = escalate.** Values below ~0.5, or a title-only grade, mean treat the study type as tentative.
- `limitations[]`: surfaces protocol papers, animal-with-human-mentions, small-sample/underpowered cues, and title-only grades.
- `gradingMethod`: `"keyword"` from search; `"llm"` after `pubmed_grade`.
- `dosage` / `population`: best-effort extraction — handy for biohacking, but confirm against the abstract for anything actionable.

## Deep grading (`pubmed_grade`)

Pass a `pmid` (and the `abstract` if you already have it, to skip a fetch). Returns a `DeepGradeOutput`:
- `correctedStudyType` / `correctedScore` — the LLM's verified classification (it catches protocol-papers-read-as-RCTs, meta-analyses of junk, animal studies misread as human).
- `pico` — population, intervention, comparison, outcome.
- `sampleSize`, `effectSize`, `fundingSource`.
- `redFlags[]` — conflicts of interest, n < 20, preprint, retracted, no full text. **Always report red flags to the user.**
- `gradingReasoning` — cite this when explaining why a grade changed.
- `fallback: true` + `warning` — the LLM was unavailable/timed out and this is the keyword grade instead. Say so; don't present it as a deep grade.

## Rate limits & parallel calls

The server shares one NCBI client across all tool calls and serializes its requests to stay under NCBI's limit (3 req/s anonymous, 10 with `NCBI_API_KEY`). So firing several `pubmed_search`/`pubmed_grade` calls at once is **safe** — they queue rather than fail — but they don't run faster, and a big fan-out adds latency. Prefer a few precise queries over many broad ones. If you still see `RATE_LIMIT`, the client is shared PubMed traffic; back off per `retryAfter`.

## Errors (returned as typed `PubMedError`)

- `QUERY_TOO_BROAD` (recoverable) — narrow with `[tiab]`/`[mesh]`/`AND`, then retry.
- `RATE_LIMIT` (recoverable, `retryAfter`) — wait the given seconds; back off.
- `NETWORK_ERROR` / `PARSE_FAILURE` — retry once; if it persists, tell the user PubMed is unreachable.
- `LLM_UNAVAILABLE` / `LLM_TIMEOUT` — deep grading isn't configured or timed out; you'll get a keyword `fallback` — proceed with it and note the limitation.

## Reporting to the user

- Lead with the strongest evidence and its score/type; summarize the consensus, then note contradictions.
- Cite PMIDs so claims are checkable.
- Quote `dosage`/`population` when the user asked something actionable, and flag when a result is animal-only, tiny, or title-only.
- Surface `redFlags` and funding/conflicts.
- This is a research tool, not medical advice. For dosing or clinical decisions, add that caveat and encourage professional consultation.
