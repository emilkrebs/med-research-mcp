---
name: med-research
description: Use when researching biomedical, supplement, peptide, or biohacking evidence with the med-research-mcp MCP server (tools literature_search, literature_fetch, literature_fulltext). Covers writing precise PubMed queries with field tags, reading the evidence grades (0-5 scores, study types, confidence), choosing between search/fetch/fulltext, and multi-database searches. Trigger on questions about what the research/evidence says for a compound, dose, intervention, or biomarker.
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
