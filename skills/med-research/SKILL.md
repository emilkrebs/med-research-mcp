---
name: med-research
description: Use when researching biomedical, supplement, peptide, or biohacking evidence with the med-research-mcp MCP server (tools literature_search, literature_fetch, literature_fulltext). Covers writing precise PubMed queries with field tags, reading the evidence grades (0-5 scores, study types, confidence), choosing between search/fetch/fulltext, and multi-database searches. Trigger on questions about what the research/evidence says for a compound, dose, intervention, or biomarker.
---

# Using the med-research-mcp MCP

Three tools, a triage-first workflow. **Always start with `literature_search`** (free, keyword-graded). **Drill into specific papers with `literature_fetch`** (full metadata + abstracts). **Use `literature_fulltext`** only when you need more than the abstract (methods, sample sizes, dosage details).

## Decision flow

1. Turn the question into a precise query and call `literature_search` (default database: `pubmed`).
2. Read the graded results: sort your attention by `evidenceScore`, but check `confidence` and `limitations` before trusting a grade.
3. For papers you want to drill into, call `literature_fetch` with the specific ids to get full abstracts and MeSH terms.
4. Call `literature_fulltext` **only** when you need more than the abstract — to verify dosage, check sample sizes, read methods, or detect statistical flaws.
5. For broader coverage, rerun with `database: ["pubmed", "europepmc"]` or `database: "all"`. Non-PubMed results are graded keyword-only (lower confidence — treat their scores as less reliable).

## Writing good queries (`literature_search`)

Bare keywords match tens of thousands of papers and bury the signal. Use field tags and boolean operators.

- `[tiab]` — title/abstract (most useful for precision): `creatine AND cognition[tiab]`
- `[mesh]` — controlled MeSH vocabulary: `"Creatine"[mesh] AND "Cognition"[mesh]`
- `[au]` — author: `Kreider R[au]`
- Combine: `(ashwagandha[tiab]) AND (cortisol[tiab] OR stress[tiab]) AND humans[mesh]`
- Restrict to strong designs by adding terms: `AND (randomized controlled trial[pt] OR meta-analysis[pt])` — `[pt]` is publication type.
- Prefer narrow first. If you get `QUERY_TOO_BROAD` or a "matched N articles" warning, add a `[tiab]` term or an `AND` clause.

Parameters worth setting:
- `database` — default `"pubmed"`. Use `["pubmed", "europepmc"]` or `"all"` for broader coverage.
- `maxResults` (default 10, max 50) — 5–10 is usually enough for a first pass.
- `minEvidenceScore` — set to `4` to see only RCTs and meta-analyses, `3` to include cohorts/reviews.
- `studyTypes` — e.g. `["meta-analysis","randomized-controlled-trial"]` to filter.
- `dateRange` `{from,to}` (YYYY-MM-DD) — for "recent evidence" questions.
- `sort` — `"relevance"` (default) or `"date"`.

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

Also read:
- `confidence` (0–1): how sure the classifier is. **Low confidence on a high score = fetch the abstract and read it.** Values below ~0.5, or a title-only grade, mean treat the study type as tentative.
- `limitations[]`: surfaces protocol papers, animal-with-human-mentions, small-sample/underpowered cues, and title-only grades.
- `gradingMethod`: `"keyword"` from search.
- `database`, `url`, `language`: present on non-PubMed results — treat non-PubMed keyword grades as lower confidence.
- `dosage` / `population`: best-effort extraction — handy for biohacking, but confirm against the abstract for anything actionable.

## Fetching details (`literature_fetch`)

Pass one or more `ids` and a `database` string. Returns raw article objects with full abstracts, MeSH headings, and references — no grading. Use after `literature_search` to drill into specific papers.

```
literature_fetch({ ids: ["39123456", "38987654"], database: "pubmed" })
```

## Full text (`literature_fulltext`)

Pass a `pmid` (or non-PubMed id) and optionally a `doi` (required for non-numeric ids). Returns the article body as markdown via Unpaywall → institutional proxy → direct DOI; falls back to abstract-only if paywalled. Use this when you need to verify dosage, read methods, or detect statistical flaws that aren't visible in the abstract.

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
- Surface `redFlags` and funding/conflicts.
- This is a research tool, not medical advice. For dosing or clinical decisions, add that caveat and encourage professional consultation.
