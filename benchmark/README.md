# med-research-mcp benchmark

This harness benchmarks the **med-research-mcp** itself: how well does the MCP
give an AI accurate, well-cited, evidence-graded biomedical answers? The default
run exercises only the MCP condition; optional baselines (closed-book and
web-search) are available when you want to compare the MCP against general AI
performance.

| Condition | Tools | What it measures |
|---|---|---|
| **MCP** (default) | `literature_search`, `literature_fetch`, `literature_fulltext` | the MCP, imported directly from `../src/core` (no stdio) |
| **closed-book** | none | the model from training data alone (optional baseline) |
| **web-search** | `web_search` (Brave) | a standalone web-search baseline (optional baseline) |

24 queries across 6 categories (factual, drill-down, synthesis, edge-case,
compound, bullshit) × MCP-only by default × N models × R runs. Every response is
scored on accuracy, evidence quality, fabrication, speed, and token cost,
combined into a 0–10 composite. Paired significance tests against the baselines are
generated only when baselines are included.

## Setup

```bash
cd benchmark
npm install
cp .env.example .env   # then fill in keys (or export them in your shell)
```

Keys are read from the environment. You only need the providers your selected
models use. `BRAVE_API_KEY` is required only when running the web-search
baseline. `NCBI_EMAIL` is strongly recommended so PubMed doesn't throttle. See
`.env.example`.

Which models run is defined in [`lib/config.ts`](lib/config.ts) (`MODELS`). The
defaults are the spec's DeepSeek examples — **edit them to model ids you can
actually call, and keep them pinned** (`gpt-4o-2024-08-06`, not `gpt-4o`).

## Run

```bash
# Default: MCP-only, all models, 3 runs, all 24 queries
npx tsx benchmark/run.ts

# Smoke test: one run, one model, MCP condition, a couple of queries
npx tsx benchmark/run.ts --runs 1 --models deepseek-v4-pro --queries factual-01,bullshit-01

# Include the optional baselines (closed-book + web-search)
npx tsx benchmark/run.ts --with-baselines

# Plan only — validates the matrix and keys, makes no API calls
npx tsx benchmark/run.ts --dry-run

# Full MCP-only pre-publish run + report
npx tsx benchmark/run.ts --publish

# Full comparison run (MCP + both baselines)
npx tsx benchmark/run.ts --publish --with-baselines
```

Run from the repo root (paths in the output are written relative to it). `--help`
lists every flag. `--conditions` accepts `A|B|C` or the long names; `--queries`
accepts query id and/or category names.

## Output

Each run writes a timestamped tree under `benchmark/results/<timestamp>/`:

```
raw/                       # full, auditable per-response JSON (text, tool calls, tokens, timing)
overrides.json             # human score corrections for THIS run (seeded empty; edit + --rescore)
scores.csv                 # one row per response — load into R / pandas / Excel
summary.json               # means, SDs, fabrication rates, paired significance tests
summary.md                 # the same, as Markdown tables (also printed to the console)
charts/*.svg               # 6 standalone figures
```

`scores.csv` is the source of truth — pivot on `condition`, facet by `category`,
color by `model`. `summary.json`'s `statistical_tests` pairs MCP against each
baseline on matched (query × run) observations, per model, but only when the
corresponding baseline was run.

**Correcting a score.** Each run keeps its own `overrides.json` next to its
`raw/` files, so a correction lives with the run it applies to (not in a global
repo-root file). The seeded file carries an inline `_example` showing the schema:
while auditing a raw response, add an entry to `overrides` keyed by
`queryId`/`condition`/`model`/`run` — the raw filename spells those out, and
`"*"` wildcards a field — set a dimension to a number to replace it or `null` to
drop it from aggregation, give a `reason`, then re-run
`npx tsx benchmark/run.ts --rescore results/<timestamp>` to regenerate the
reports. Point `--overrides <path>` at a shared file to apply the same
corrections across several runs.

## How scoring works

- **Citations are never trusted.** Every `PMID` in a response is fetched from
  live PubMed. One that doesn't resolve is a **fabrication**; one that does is
  graded with the library's own grader, so *evidence quality* is measured on the
  exact 0–5 scale the MCP reports.
- **Accuracy (0–10)** depends on the query's answer key: the deterministic
  factual queries force the model to end in a fixed `ANSWER — …` line and a
  `values` key checks the exact tokens it emitted (study type, 0–5 score, PMID)
  against the correct ones — no judge involved; open-ended synthesis/drill-down
  use an **LLM judge** that is handed the *real abstracts of every cited PMID* so
  it can penalize unsupported claims; bullshit queries score on correct rejection.
- **Bullshit (0–1)** is deterministic: a fabricated-study query is correct only
  if the model signals it can't corroborate the study *and* invents no PMID.
- **Composite (0–10)** = `0.40·accuracy + 0.25·evidence + 0.25·bullshit +
  0.05·speed + 0.05·cost`, each term normalized to [0,1] (speed/cost against the
  references in `config.NORMALIZATION`) then rescaled to 0–10.
- **Significance**: paired t-test when the paired differences look roughly normal,
  Wilcoxon signed-rank otherwise; Cohen's d/rank-biserial effect size and 95% CIs.
  Generated only when both MCP and the relevant baseline are run.

## ⚠️ Answer keys and publishable claims

Nine queries have `verified: true` keys: the four **bullshit** queries (the
studies are fabricated by us), and the five deterministic **`values`** queries
(`factual-01`–`04`, `drill-down-03`), whose expected tokens were checked against
live PubMed and the library grader — the study type + 0–5 score are what
`keywordGrade` assigns, and every pinned PMID resolves. Every remaining key is an
open-ended **`rubric`** that asserts a real-world biomedical fact an LLM judge
must weigh, so it is `verified: false`: it runs and scores, but the harness warns
(and `summary.md` lists them) because those scores are provisional until a human
reviews the key. **Review the unverified keys in
[`queries.data.ts`](queries.data.ts) before quoting numbers in a paper.**

## Extending

- **Models** — add entries to [`models.data.ts`](models.data.ts) (`openai`,
  `anthropic`, `deepseek` providers are wired; add more in
  [`lib/providers.ts`](lib/providers.ts)). `tsc` checks each entry.
- **Queries** — add to [`queries.data.ts`](queries.data.ts); pick the answer-key
  kind that fits and set `verified` honestly. `tsc` checks the category and kind.
- **Weights / normalization** — `WEIGHTS` and `NORMALIZATION` in `config.ts`.
