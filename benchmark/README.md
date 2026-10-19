# med-research-mcp benchmark

This harness benchmarks the **med-research-mcp** itself: how well does the MCP
give an AI accurate, well-cited, evidence-graded biomedical answers? The default
run exercises only the MCP condition; optional baselines (closed-book and
web-search) are available when you want to compare the MCP against general AI
performance.

| Condition | Tools | What it measures |
|---|---|---|
| **MCP** (default) | `literature_search`, `literature_fetch`, `literature_fulltext` | the real MCP server (`createServer()` from `../src/mcp/server.ts`), driven in-process over an MCP in-memory transport |
| **closed-book** | none | the model from training data alone (optional baseline) |
| **web-search** | `web_search` (Brave), `web_fetch` | a standalone web baseline: search plus opening result pages (optional baseline) |
| **mcp-skill** (`--conditions D`) | same as MCP | MCP plus the shipped [`med-research` skill](../skills/med-research/SKILL.md) appended to the system prompt: a Claude Code session with the skill loaded. MCP vs mcp-skill measures the skill. Always-on injection is the skill-loaded best case; in Claude Code the model loads a skill only when its description matches |

32 queries across 7 categories (factual, drill-down, synthesis, edge-case,
compound, recent, bullshit) × MCP-only by default × N models × R runs. Every
response is scored on accuracy, evidence quality, fabrication, speed, and token
cost, combined into a 0–10 composite, plus a citation **misattribution** rate
reported next to it. Paired significance tests against the baselines are
generated only when baselines are included.

**Read [Validity and limitations](#validity-and-limitations) before citing any number.**

## Setup

The harness imports the MCP from source (`../src/core`, `../src/mcp/server`), so
**both** installs are required:

```bash
npm install            # repo root: the MCP source the harness imports
cd benchmark
npm install
cp .env.example .env   # then fill in keys (or export them in your shell)
```

Keys are read from the environment. You only need the providers your selected
models use (`openai`, `anthropic`, `deepseek`, `ollama`). `BRAVE_API_KEY` is
required only when running the web-search baseline. `NCBI_EMAIL` is strongly
recommended: NCBI's usage policy asks every request to carry a contact email, so
NCBI can reach you before blocking your IP (`NCBI_API_KEY` raises the rate limit
from 3 to 10 requests per second). A full run sends well over 100 NCBI requests,
so NCBI's [policy](https://www.ncbi.nlm.nih.gov/home/about/policies/) asks you to
run it on weekends or between 9 pm and 5 am US Eastern time on weekdays.
`BENCH_TIMEOUT_MS` caps one agent loop (default 300000). See `.env.example`.

**Models** live in [`models.data.ts`](models.data.ts) (not `lib/config.ts`).
Only entries without `enabled: false` run by default; others stay in the
catalog and are selected with `--models <label>`. **Keep model ids pinned**
(`gpt-4o-2024-08-06`, not `gpt-4o`); entries marked `unpinned: true` (moving
aliases such as `:latest`) trigger a warning because results can drift.

**Ollama.** Ollama's default 4096-token context silently truncates
tool-heavy conversations (the model loses the question or earlier tool
results without any error). Start it with `OLLAMA_CONTEXT_LENGTH=32768` or
more, e.g. `OLLAMA_CONTEXT_LENGTH=32768 ollama serve`. The harness also detects
context truncation (input tokens shrinking between steps of one run) and marks
that run `truncated`, so it drops out of the means instead of scoring as a
bad answer.

## Run

```bash
# Default: MCP-only, all enabled models, 3 runs, all 32 queries
npx tsx benchmark/run.ts

# Smoke test: one run, one model, a couple of queries
npx tsx benchmark/run.ts --runs 1 --models deepseek-v4.1-flash --queries factual-01,bullshit-01

# Include the optional baselines (closed-book + web-search)
npx tsx benchmark/run.ts --with-baselines

# Plan only: validates the matrix and keys, makes no API calls
npx tsx benchmark/run.ts --dry-run

# Before a publish run: live check of the answer keys (see below)
npm --prefix benchmark run verify-keys

# Canonical publication run (all enabled models, 3 runs)
npx tsx benchmark/run.ts --publish
npx tsx benchmark/run.ts --publish --with-baselines
```

Run from the repo root (paths in the output are written relative to it). Flags
(`--help` lists them all):

| Flag | Meaning |
|---|---|
| `--runs <n>` | runs per query per model (default 3) |
| `--models <list>` | model labels (default: every enabled model) |
| `--conditions <list>` | `A\|B\|C\|D` or `closed-book\|web-search\|mcp\|mcp-skill` (default `mcp`) |
| `--with-baselines` | add closed-book and web-search |
| `--queries <list>` | query ids and/or category names |
| `--temperature <t>` | default 0 |
| `--max-steps <n>` | tool-call rounds per run (default 16) |
| `--concurrency <n>` | parallel runs (default 1; NCBI rate limits favor 1) |
| `--out <dir>` | output root (default `benchmark/results`) |
| `--resume <dir>` | reuse finished records, run only the rest (see Reproducibility) |
| `--publish` | all enabled models, 3 runs; cannot be combined with `--models`/`--runs`; warns about unpinned models and unverified keys |
| `--dry-run` | plan and preflight only |
| `--rescore <dir>` | regenerate reports from `raw/` + overrides |
| `--overrides <path>` | overrides file for `--rescore` (default `<dir>/overrides.json`) |

npm scripts (in `benchmark/`): `bench`, `smoke`, `smoke-baselines`, `grade`,
`rescore`, `merge`, `verify-keys`, `typecheck`, `test`.

### What the agent loop does

- One `generateText` loop per (query × condition × model × run), identical
  system prompt in every condition; only the toolset differs.
- **MCP condition:** a fresh server, in-memory client pair and cache per run.
  Tool names, descriptions and schemas come from the server itself, so they
  cannot drift from the shipped MCP. One process-wide NCBI client (the rate
  limiter, no data) is shared by all runs and by the scorer so concurrency
  cannot exceed NCBI's request budget. The core's non-PubMed adapters keep
  process-global state and are not run-isolated.
- **Web-search condition:** `web_search` (Brave) and `web_fetch`, which opens a
  page and returns HTML→markdown or PDF→text using the same extraction code as
  the MCP's full-text tool (about 20,000 characters, 2 MB cap), so the baseline
  is not handicapped to snippets.
- **Limits:** a per-run wall-clock timeout (`BENCH_TIMEOUT_MS`, default 300 s);
  the AI SDK's per-call retries (2) are the only retries, no whole-run reruns;
  the final step (`--max-steps`) is forced to answer with tool calls disabled.
- **Recorded in `raw/`:** full tool outputs, per-tool timings, finish reason,
  step count, tokens, wall-clock.

## Output

Each run writes a timestamped tree under `benchmark/results/<timestamp>/`:

```
manifest.json              # provenance: git commit + dirty flag, versions, settings, models, query key versions
raw/                       # full, auditable per-response JSON (text, tool calls and outputs, tokens, timing)
overrides.json             # human score corrections for THIS run (seeded empty; written by grade.ts)
scores.csv                 # one row per response, including failed ones
summary.json               # means, SDs, failure rates, fabrication rates, paired tests, per-category composites
summary.md                 # the same, as Markdown tables (also printed to the console)
charts/*.svg               # 6 standalone figures
```

**Run status.** Every row has a `status`:

| Status | Meaning |
|---|---|
| `ok` | answered and scored |
| `provider-error` | the model call threw or timed out |
| `truncated` | no final answer (empty text, e.g. step limit or timeout mid-tool-call) or context truncation detected |
| `scoring-error` | answered, but scoring failed (e.g. PubMed unreachable); a later `--rescore` retries it |

Only `ok` rows enter means, charts and tests; failure rates per condition are
reported in the summary so a failing condition cannot look better by dropping
out silently.

`scores.csv` is the source of truth. Columns: `query_id, category, condition,
model, run, status, accuracy, accuracy_source, evidence_quality,
bullshit_score, speed_s, input_tokens, output_tokens, total_tokens,
tool_calls, tools_used, pmids_cited, pmids_valid, pmids_fabricated,
other_citations, citations_checked, citations_misattributed, composite`. Unscored values (NaN) are written as empty cells
(NA in R/pandas), not 0. Filter on `status == "ok"` before averaging.
`accuracy_source` is one of `deterministic` (values key), `reject` (bullshit
query), `human` (graded via `grade.ts`), or `proxy` (provisional, see below).

## How scoring works

- **Citations are never trusted.** Recognized citation forms are PMIDs, PubMed
  URLs, and DOIs / PMCIDs (resolved to PMIDs through NCBI). Every PMID is
  fetched from live PubMed. One that doesn't resolve is a **fabrication**; one
  that does has its design classified from NLM metadata (PublicationType tags,
  retraction links) by the library's `classifyArticle`, so *evidence quality*
  is the mean 0–5 design tier the MCP reports. Citations with an unknown tier
  (`designTier: null`: no design metadata, or a meta-analysis/systematic review
  whose pooled designs aren't indexed) are left out of that mean. It is 0 when
  no citation is valid, and NaN (unscored) when valid citations exist but none
  is rated; the composite then drops the evidence term and rescales the other
  weights, and a rubric row's proxy accuracy stays unscored until a human
  grades it.
  Regional records are looked up in their own database: Europe PMC ids outside
  PubMed (`CBA:521529` for Chinese Biological Abstracts, `PPR…` preprints,
  `europepmc.org/article/SRC/ID` links) and ChinaXiv ids (`chinaxiv-…`). Found
  ones are classified and counted like a valid PMID; ones that don't resolve stay
  in `other_citations`, never fabricated. Other identifier types are counted in
  `other_citations` but neither graded nor penalized. PMIDs that already appear
  in the prompt are excluded (echoing the question is not citing). A transient
  NCBI failure (including abstracts that fail to load) yields a
  `scoring-error`, never a "fabricated" verdict or a title-only grade.
- **Misattribution (reported, not in the composite).** A real paper cited for
  something it doesn't say passes the fabrication check, so
  [`lib/scoring/attribution.ts`](lib/scoring/attribution.ts) compares the text
  next to each resolved citation with the record, deterministically (no LLM):
  the paper must mention one of the query's `topics`; a stated year must be
  within ±1; "Surname et al." must name one of its authors; a claimed design
  (meta-analysis, RCT, cohort) must fit its classified type or NLM tags; and of two
  or more stated figures, at least one must appear in the abstract. Each check
  fires only on a clear contradiction and abstains when unsure (several
  citations sharing a clause, two years, no abstract, …), so the rate counts
  contradicted claims, not proven-supported ones. Every flag is stored in the
  raw JSON under `_scoring.attribution.issues` with the claimed and actual
  value, for audit. On the first Haiku 5.5 run (144 answers), all 25 flags were
  checked by hand and all were real (e.g. "Sutton et al. 2018, Cell Metabolism"
  pointing at a review of muscle development).
- **Accuracy (0–10)** depends on the query's answer key:
  - `values` keys (13 deterministic queries: `factual-01`–`04`, `drill-down-03`,
    `edge-case-03`–`06`, `recent-01`–`04`): the model must end with a line like
    `ANSWER — study type: … | score: … | pmid: …`. The scorer parses that final
    line field by field and checks each expected field; numeric values compare
    as numbers (`0.6` = `0.60`, `37.3%` = `37.3`). Accuracy is the fraction
    matched × 10. Fully automated.
  - `reject` keys (4 bullshit queries): see below.
  - `rubric` keys (15 open-ended queries) have no ground-truth string, so they
    are graded by a **human** with [`grade.ts`](grade.ts) (next section), which
    writes into `overrides.json` for `--rescore` to apply. The optional LLM
    judge ([`judge.ts`](judge.ts)) gives a second opinion but never writes
    there. **Until a human grades a rubric response, its accuracy is a
    provisional citation-quality proxy** (mean design tier of the cited,
    valid, rated PMIDs × 2; 0 if citations were expected but none resolved;
    unscored if every valid citation is unrated;
    `lib/scoring/accuracy.ts`). That reflects the *tier* of the sources cited,
    not whether the answer is correct, and must not be quoted as accuracy on
    its own. The summary's "Accuracy (verified)" column excludes proxy rows.
- **Bullshit (0–1)**. For a fabricated-study query, 1 only if the response
  contains rejection language about the study itself (could not find or verify
  the study, no such trial, does not exist, appears fabricated, PMID does not
  correspond) **and** cites no non-existent PMID. Generic hedges ("there is no
  evidence of adverse effects") do not count. For every other query it tracks
  citation integrity: the share of cited PMIDs that resolve.
- **Composite (0–10)** = `10 · (0.40·accuracy/10 + 0.25·evidence/5 +
  0.25·bullshit + 0.05·speed + 0.05·cost)`. Speed and cost are normalized
  against `config.NORMALIZATION` (`BENCH_SPEED_REF_S`, default 60 s;
  `BENCH_TOKEN_REF`, default 20,000 total tokens): 1 = instant/free, 0 = at or
  beyond the reference. **Exception: for bullshit queries the composite is
  `rejection × 10`**; evidence, speed and cost do not apply, since the only
  correct behavior is refusing to corroborate the study.
- **Scorer version.** `SCORER_VERSION` in `lib/scoring/score.ts` is stored in
  every scored record; `--rescore` re-scores stale ones (see Reproducibility).
- **Summary and significance.**
  - Runs are averaged per query before pairing, so **n = number of queries**,
    not queries × runs.
  - Paired t-test when the differences look roughly normal, otherwise Wilcoxon
    signed-rank (exact p for n ≤ 25 without ties, tie-corrected normal
    approximation otherwise).
  - Effect sizes: Cohen's dz (paired t) or matched-pairs rank-biserial r
    (Wilcoxon), with 95% CIs.
  - p-values across all tests in a summary are **Holm-adjusted** as one family
    (`p_value_holm`).
  - `summary.md` also has a per-category composite table.
  - Tests are generated only when MCP and the relevant baseline were both run.

## Grading rubric answers

15 of the 32 queries are open-ended `rubric` keys. `grade.ts` makes human
grading fast and blind:

```bash
npx tsx benchmark/grade.ts <results-dir> --grader alice
# e.g.
npx tsx benchmark/grade.ts benchmark/results/2026-07-14-141739 --grader alice
```

| Option | Meaning |
|---|---|
| `--grader <id>` | grader id, written as `author` (default `$USER`, else `human`) |
| `--seed <n>` | shuffle seed (default derived from the grader id; always printed) |
| `--overrides <path>` | read/write this file instead of `<dir>/overrides.json` |
| `--unblind` | show condition, model, run and proxy score (debugging only) |
| `--agreement` | print inter-rater agreement and exit |

By default grading is **blind and randomized**: the grader sees an opaque item
id, the prompt, the rubric, the full answer, and the cited PMIDs' validity,
study type and design tier (read offline from the run's data), but not the
condition, model, run, or proxy score; items come in a seeded shuffled order.
Enter a 0–10 score (optionally followed by a one-line reason), `s`/Enter to
skip, `q` to save and quit. Each grade is saved immediately, and re-running
resumes where you left off. Afterwards:

```bash
npx tsx benchmark/run.ts --rescore <results-dir>
```

**Known limitation:** the answer text itself can still reveal the condition
("I searched PubMed...", or an ungrounded closed-book style), so blinding is
partial.

**Multiple graders.** Run `grade.ts` once per grader with different `--grader`
ids; grades on the same response are averaged. `--agreement` reports
Krippendorff's α (interval), ICC(2,1), the mean absolute difference, and the
list of items where graders differ by more than 3 points, for adjudication.

**Overrides in general.** `overrides.json` lives next to `raw/`, keyed by
`queryId`/`condition`/`model`/`run` (`"*"` wildcards a field), with a mandatory
`reason`. A human accuracy override **recomputes the composite**; setting a
dimension to `null` drops that dimension (and the recomputed composite) from
aggregation. Rows graded by humans get `accuracy_source = human`. Use
`--overrides <path>` to apply one shared file across runs.

**LLM judge (second opinion, not human grading).**
[`judge.ts`](judge.ts) grades the rubric answers with an LLM, blind to
condition, model and run. The judge sees the same view as `grade.ts` plus the
abstracts of the cited PubMed records:

```bash
npx tsx benchmark/judge.ts <results-dir> [--judge qwen3.8-max] [--conditions mcp,mcp-skill] [--limit n]
```

Grades go to `judge-<model>.json` (resumable) and a report to
`judge-<model>.md`, with judge score, proxy score and a composite recomputed
with the judge's accuracy per condition, plus a paired mcp-skill vs mcp test.
They are never written to `overrides.json`, so they never count as human
grades. An LLM judge can be wrong about medicine and may not know recent
papers: treat its scores as indicative and spot-check a sample by hand. The
default judge, `qwen3.8-max`, runs on Alibaba Cloud Model Studio's Singapore
endpoint and needs `DASHSCOPE_API_KEY`.

## Reproducibility

- **`manifest.json`** records the git commit and whether the tree was dirty,
  MCP and benchmark versions, run settings (temperature, max steps, timeout,
  retries), models (including model ids), and answer-key versions. Prefer
  publishing from a clean tree.
- **`--resume <dir>`** reuses a stored record only when its model id, settings
  (temperature, max steps, timeout), prompt and system prompt all match the
  new run; legacy records without these fields are re-run. The old dir's
  `overrides.json` is copied over.
- **`--rescore <dir>`** re-scores against live PubMed only records with no
  embedded scoring, an older `SCORER_VERSION`, a different answer-key version,
  or a `scoring-error`; the rest reuse their embedded scoring offline. New
  breakdowns are written back to `raw/`.
- **Merging runs.** `npx tsx benchmark/merge.ts [dir ...] [--min-rows <n>]`
  combines results dirs (default: every subdir of `results/` except
  `combined`) into `results/combined/` with one `scores.csv`, summary and
  charts. For a shared (query, condition, model, run) cell the later dir wins,
  but a failed row never replaces an `ok` one. `combined/provenance.json`
  records the source dir of every cell. `--min-rows` skips small dirs (smoke
  runs). It warns when the merged dirs come from different MCP commits,
  scorer versions or answer-key versions, in which case the numbers are not
  strictly comparable.
- **Tests:** `cd benchmark && npm test` (offline; no network or API keys).

## Answer keys and publishable claims

Seventeen queries have `verified: true` keys: the four **bullshit** queries (the
studies are fabricated by us) and the thirteen deterministic **`values`** queries.
Two groups among the latter test what a closed-book model cannot do:

- **Regional records** (`edge-case-03`–`06`): TCM trials that exist only in
  Europe PMC's Chinese Biological Abstracts source, and a ChinaXiv preprint —
  none of them in PubMed — so answering takes a non-PubMed database.
- **Recent literature** (`recent-01`–`04`): papers first published online
  between 2026-08-27 and 2026-10-06, after the benchmarked models' training
  data. These keys age: replace them with newer papers once models are trained
  on that period.
Verification is a **live check, not a one-time claim**: run

```bash
npm --prefix benchmark run verify-keys    # = npx tsx benchmark/scripts/verify-keys.ts
```

before every publish run. For `values` keys it checks that every pinned PMID
resolves, that the design classified from the record's live NLM metadata
matches the expected study type, and that the expected score matches
`DESIGN_TIER` for that type (and the live tier, when the record is classified).
A subject PMID without design metadata can't be confirmed this way: that is
a warning, and the key rests on the abstract quoted in its `note`; for bullshit (`reject`) keys it runs the optional `probe`
PubMed search, which must return no hits (hits are warnings with titles for a
human to judge), and checks that any fabricated PMID in the prompt does not
resolve. It exits 1 on any mismatch or error.

The other 15 keys are open-ended `rubric` queries asserting real-world
biomedical facts. They stay `verified: false`, the harness warns, and
`summary.md` lists them: their accuracy is a provisional proxy until humans
grade them. **Grade them with `grade.ts` and `--rescore`, or otherwise review
the keys in [`queries.data.ts`](queries.data.ts), before quoting accuracy in a
paper.**

## Validity and limitations

- **Evidence quality uses the labels the MCP shows.** The 0–5 design tier
  comes from NLM's own metadata (no heuristics of ours), but the MCP condition
  sees those same labels in its tool results, while the baselines would have
  to find them on PubMed. That is a structural advantage for the MCP condition
  on the evidence term (25% of the composite). It also measures only the
  *design* of what was cited, not how good those studies are, and most
  meta-analyses are unrated (their pooled designs aren't indexed), so the term
  mostly reflects cited primary studies.
- **Rubric accuracy is a provisional proxy** (citation tier) until humans
  grade it. Only the `values` queries and bullshit rejection have automated
  ground truth.
- **Rejection detection is lexical.** Pattern matching can miss unusual
  phrasings (false negatives) and can accept a hedged hybrid that rejects the
  study but still describes findings. Review bullshit rows by hand and use
  overrides where needed.
- **Small query set.** 32 queries, only 4 of them bullshit. Per-category
  numbers rest on 2 to 8 queries and are noisy; tests have n = number of
  queries.
- **Misattribution is lexical and conservative.** It finds contradicted claims
  (wrong paper, year, author, design, or figures absent from the abstract), not
  unsupported ones; figures reported only in the full text are never flagged
  because the numbers check needs two figures with none found.
- **The query set is public**, so future models may have seen it in training
  (contamination), especially the closed-book condition.
- **Blinding is partial** (answer text can reveal the condition) and several
  other limits apply: speed depends on provider load and network, and the
  non-PubMed adapters in the MCP are not run-isolated.

## Extending

- **Models** — add entries to [`models.data.ts`](models.data.ts) (`openai`,
  `anthropic`, `deepseek`, `ollama` providers are wired; add more in
  [`lib/providers.ts`](lib/providers.ts)). `tsc` checks each entry.
- **Queries** — add to [`queries.data.ts`](queries.data.ts); pick the answer-key
  kind that fits and set `verified` honestly (bump `answerKeyVersion` when a key
  changes so `--rescore` refreshes old data). `tsc` checks the category and kind.
  Give it `topics` (terms any on-topic paper mentions) so the misattribution
  check can catch citations to unrelated papers.
- **Weights / normalization** — `WEIGHTS` and `NORMALIZATION` in
  [`lib/config.ts`](lib/config.ts).
