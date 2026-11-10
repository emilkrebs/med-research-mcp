# med-research-mcp benchmark

This benchmark measures whether the **med-research-mcp** server helps a model answer biomedical questions correctly and cite real papers. It runs each query under up to five conditions, checks every answer against ground truth and live PubMed, and reports several measures side by side. **There is no single score.** It is for developers and researchers: using the server does not involve it, and it is not part of the published package.

**Read [Validity and limitations](#validity-and-limitations) before citing any number.**

| Condition | Letter | Tools the model gets |
| --- | --- | --- |
| `closed-book` | A | none |
| `web-search` | B | `web_search` (Brave) and `web_fetch`, which opens a page and returns HTML or PDF as text (about 20,000 characters, 2 MB cap) |
| `mcp` (default) | C | the real server's `literature_search`, `literature_fetch`, `literature_fulltext`, run in-process over an MCP in-memory transport |
| `mcp-skill` | D | the same, plus the shipped [`med-research` skill](../skills/med-research/SKILL.md) appended to the system prompt. Always injecting it is the skill-loaded best case: Claude Code loads a skill only when its description matches |
| `pubmed` | E | `pubmed_search` and `pubmed_fetch`: PubMed's records as PubMed serves them (publication types and MeSH included), in PubMed's order, with date range, sort and paging. Without the server's study-type, design-tier and flag labels, design sorting and filtering, other databases and full text. It shows what the server adds over raw PubMed access |

The system prompt is the same in every condition except D. `--with-baselines` adds A, B and E to C; D is selected with `--conditions`.

## What is reported

A **keyed query** is one with ground truth: an answer key of kind `values`, `reject` or `accept` (see [How an answer is scored](#how-an-answer-is-scored)). Every measure is reported per model and condition, separately for the held-out and the development set.

| Measure | What it is |
| --- | --- |
| Accuracy on keyed queries | 0 to 10, the mean over keyed queries (runs are averaged per query first). A run with no answer counts 0 |
| Fabricated studies rejected | share of fabricated-study queries where the answer rejects the study and cites no fabricated record |
| Real studies accepted | share of real-study control queries where the answer does not reject the study, or cites its record |
| Fabricated-citation rate | cited records that do not exist, or exist but mention none of the query's `topics` (a short word list kept with each query), divided by all cited records |
| Misattribution rate | of the valid citations with a checkable claim next to them, the share where a stated year, author, design or figure contradicts the record (the summary calls these "contradicted claims") |
| Failed and missing runs | the share of runs per status |
| Median tokens, median time | tokens over the runs that returned; time over scored runs, a timed-out run counting at the timeout |
| Mean design tier | 0 to 5, of the cited records. Descriptive: it says what was cited, not whether the answer is right |
| Rubric accuracy | only from human grades; kept out of everything above |

The rejection and acceptance rates are a pair. A model that rejects everything gets every fabricated study right and every real one wrong; neither number means anything alone. Accuracy on keyed queries pools the three key kinds, so look at the pair as well.

An earlier version combined accuracy, evidence, fabrication, speed and cost into one 0 to 10 composite. It was removed after the validity review of 2026-11-09: failed runs dropped out of its means, citing any record that exists earned credit, and open-ended accuracy was a proxy from the cited papers' design tier.

## The two query sets

| | Development set | Held-out set |
| --- | --- | --- |
| File | [`queries.data.ts`](queries.data.ts) | [`queries.heldout.data.ts`](queries.heldout.data.ts) |
| Split name | `dev` | `test` |
| Queries | 32 | 95: 71 `lookup`, 12 `control`, 12 `bullshit` |
| Use | build and tune against it freely | measure. Nothing may be tuned against it |
| Answer keys | 13 `values`, 4 `reject`, 15 `rubric` | all keyed: `values`, `accept`, `reject` |
| How to run | the default, or `--split dev` | `--split test`, or `--publish` for the whole set |

`--split dev|test|all` picks the set. Numbers from the development set are development numbers: the server, the skill and the scorer were built against them. The held-out numbers are the ones to report. Nothing may be tuned against a held-out query: not the server, the skills, the scorer or the prompts. The set is spent as soon as anything is (see [drawing a new set](#drawing-a-new-held-out-set)). `test/leak.test.ts` fails if the system prompt, a shipped skill, the server's tool names, descriptions and schemas or the plain-PubMed tool descriptions contain a query of either set, the id of its answer record, or a worked example that closely paraphrases a query.

### Development set

32 queries in seven categories: factual 4, drill-down 4, synthesis 8, edge-case 6, compound 2, recent 4, bullshit 4. The 4 `reject` and 13 `values` keys have ground truth and are `verified`. The 15 open-ended `rubric` queries have none, so they have no accuracy until people grade them. Eight queries are `retrievalOnly`: the answer is out of reach of training data (a paper newer than the models, or a record only a regional database holds), so a closed-book baseline scores 0 on them by construction. The `recent` keys age: replace them once models are trained on that period.

### Held-out set

| Category | The query | Ground truth |
| --- | --- | --- |
| `lookup` | find a randomized trial described without its PMID, and report its PMID and two numbers from its abstract | `values`: three fields, each a third of the accuracy |
| `control` | a real trial asked about in the form used for fabricated ones: "Summarize the *year* *Surname* trial of ..." | `accept` |
| `bullshit` | the fabricated twin of a control: same form and field, an author and trial the field does not have | `reject` |

**How the trials were drawn.** The frame is PubMed records tagged "Randomized Controlled Trial", in English, with an abstract, whose MeSH major topic falls in one of 12 clinical fields. Each field has two periods, so there are 24 strata:

- `established`: published 2015 to 2022 in NEJM, The Lancet, JAMA or The BMJ. A model may know these from training.
- `recent`: added to PubMed from 2026-09-01 to 2026-10-31, any journal. Marked `retrievalOnly`: no benchmarked model was trained on them.

Each stratum's PMIDs are sorted numerically and shuffled with a generator seeded from the seed (20261110) and the stratum's name; the first eight are its candidates (a record already drawn for an earlier stratum is skipped). Queries are written in that order, up to three lookups per stratum. A candidate may be passed over only for a reason in `SKIP_REASONS` ([`scripts/sample-heldout.ts`](scripts/sample-heldout.ts)):

| Reason | Meaning |
| --- | --- |
| `not-primary` | not the report of a randomized comparison: a protocol, a secondary, post-hoc or pooled analysis, a long-term follow-up, a cost analysis |
| `no-numbers` | the abstract does not state two unambiguous numbers to ask for: how many took part, and a result or a second count |
| `not-identifiable` | the trial cannot be described without its PMID in a way that tells it from a sibling report |
| `predates-window` | `recent` only: published online before 2026-08-01, so a model may have seen it |
| `in-development-set` | the record is the subject of a development query |

Every disposition is recorded in [`heldout.sample.json`](heldout.sample.json) (with the draw date and each stratum's size when drawn), and `test/heldout.test.ts` checks that the queries were written from the draw, in order. The draw reproduces only while PubMed returns the same records for a stratum's search, so the file keeps the draw that was used. Each field's `control` is taken from the established draw after its lookups, and its `bullshit` twin is written to match it.

**Extension.** A stratum whose eight candidates give fewer than three lookups can be extended: `npm run sample-heldout -- --extend <specialty/period> --abstracts <file>` re-runs its search and appends the next eight records of the same shuffled order. The script refuses while a stored candidate has no disposition, once the stratum has three lookups, and for a stratum that was already extended unless it still has fewer than two; the tests require at least two lookups per field and period. One stratum, obstetrics/recent, was extended once and ended with two lookups, which is why there are 71 lookups and not 72.

**Answer keys.** Every `values` key names its source record and quotes the passage of the abstract that states its numbers. `npm run verify-keys` checks every `verified` key of both sets against the live records (`npm run verify-keys -- --all` also checks unverified keyed ones):

| Key | What is checked |
| --- | --- |
| `values` | the record exists; each quoted passage is in its title or abstract; each expected number is in the quote; an expected PMID is the source's and is not in the prompt. A study type read from an abstract cannot be checked this way and is a warning. Development keys that name a study type and evidence score are also checked against the record's live NLM design and `DESIGN_TIER` |
| `reject` | a PMID in the prompt does not resolve; the `probe` PubMed search returns no hit (a hit is a warning, listed with its title) |
| `accept` | the PMID resolves; the named author is one of its authors; the named year is within one of its year; the prompt names both and not the PMID |

It exits 1 on any mismatch or error; warnings do not fail it. It does not check that a number answers the question as asked.

## Setup

The harness imports the server from source (`../src/core`, `../src/mcp/server`), so **both** installs are needed. The Node versions are in `package.json` (`engines`).

```bash
npm install            # repo root
cd benchmark
npm install
cp .env.example .env   # then fill in keys, or export them in your shell
```

- **Model keys.** Each model in [`models.data.ts`](models.data.ts) names its key variable. The default models use `DASHSCOPE_API_KEY` and `DASHSCOPE_BASE_URL` (Alibaba Cloud Model Studio, Singapore endpoint), except `gemma4-4b` (Ollama, no key). `claude-haiku-5-5` is in the catalog but disabled by default; naming it with `--models` selects it. It needs `ANTHROPIC_API_KEY` and runs at the provider's default sampling.
- **`BRAVE_API_KEY`** only for the web-search condition.
- **`NCBI_EMAIL`** is strongly recommended: NCBI asks every request to carry a contact email so it can reach you before blocking your IP. Without one, requests carry the project's contact address. `NCBI_API_KEY` raises the limit from 3 to 10 requests per second.
- **`BENCH_TIMEOUT_MS`** caps one agent loop (default 300000). See `.env.example`.
- **Models** run by default unless marked `enabled: false`. **Keep ids pinned**; entries marked `unpinned: true` (moving aliases such as `:latest`) trigger a warning because results can drift.
- **Ollama** truncates tool-heavy conversations at its default 4096-token context without an error. Start it with `OLLAMA_CONTEXT_LENGTH=32768 ollama serve` or more. The harness detects the truncation (input tokens falling between steps of one run) and marks the run `invalid`.

**NCBI etiquette.** NCBI's [policy](https://www.ncbi.nlm.nih.gov/home/about/policies/) asks that retrieval scripts run "on weekends or between 9 pm and 5 am Eastern Time weekdays for any series of more than 100 requests". [`docs/compliance.md`](../docs/compliance.md) notes that interactive use doesn't qualify and benchmark runs do. A full run sends well over 100 requests, and so can a rescore of many stored runs; `verify-keys` stays at a few dozen.

## Run

Run from `benchmark/`.

```bash
npx tsx run.ts --dry-run                 # plan and preflight, no API calls
npx tsx run.ts --dry-run --split test
# cheap smoke test: one run, one model, two development queries
npx tsx run.ts --runs 1 --models claude-haiku-5-5 --queries factual-01,bullshit-01
npx tsx run.ts                           # development set, enabled models, 3 runs, MCP only
npx tsx run.ts --with-baselines          # add closed-book, web-search, pubmed
npm run verify-keys                      # before a publication run
npx tsx run.ts --publish                 # the whole held-out set
```

At present `--publish` plans 1,710 responses per condition (95 queries, 6 enabled models, 3 runs) and warns about unpinned models (`gemma4-4b` is one), unverified keys and a dirty working tree. Before a held-out run: commit, so that the manifest's commit describes the code; run `npm run verify-keys`; start off-peak for NCBI; afterwards read the status tally and `--resume` the missing runs.

`--help` lists the flags.

| Flag | Meaning |
| --- | --- |
| `--runs <n>` | runs per query per model (default 3) |
| `--models <list>` | model labels (default: every enabled model; a disabled one can be named) |
| `--conditions <list>` | `A\|B\|C\|D\|E` or the condition names (default `mcp`) |
| `--with-baselines` | add closed-book, web-search and pubmed |
| `--split <dev\|test\|all>` | query set (default `dev`) |
| `--queries <list>` | query ids and/or category names; a category selects within the split, an id selects that query whatever its split |
| `--temperature <t>` | 0 to 2 (default 0); models marked `fixedSampling` ignore it |
| `--max-steps <n>` | tool-call rounds per run (default 16) |
| `--concurrency <n>` | parallel runs (default 1; NCBI rate limits favor 1) |
| `--token-budget <n>` | start no new run once n tokens are spent in this invocation |
| `--run-token-cap <n>` | soft per-run cap: past it the next step is text-only |
| `--quiet` | one line per finished run |
| `--out <dir>` | output root (default `benchmark/results`) |
| `--resume <dir>` | reuse finished records, run the rest (see [Reproducibility](#reproducibility-and-old-results)) |
| `--publish` | all enabled models, 3 runs, the whole held-out set; conditions stay selectable; cannot be combined with `--models`, `--runs`, `--split` or `--queries` |
| `--dry-run` | plan and preflight only |
| `--rescore <dir>` | regenerate reports from `raw/` and the overrides, scoring stale records again |
| `--overrides <path>` | overrides file for `--rescore` (default `<dir>/overrides.json`) |

npm scripts: `bench`, `smoke`, `smoke-baselines`, `grade`, `rescore`, `merge`, `verify-keys`, `sample-heldout`, `typecheck`, `test`.

**The agent loop.** One loop per query, condition, model and run, with the same system prompt apart from D. The MCP conditions get a fresh server, client and cache per run; tool names, descriptions and schemas come from the server itself. One process-wide NCBI client (the rate limiter, no data) serves all runs and the scorer, so concurrency cannot exceed NCBI's budget. A run has a wall-clock timeout (`BENCH_TIMEOUT_MS`) and the AI SDK's 2 retries per call, with no whole-run reruns. The final step is forced to answer with tool calls disabled. `raw/` keeps full tool outputs, timings, finish reason, step count and tokens.

## What a run writes

```text
benchmark/results/<timestamp>/
  manifest.json    provenance: commit and dirty flag, versions, settings, models, answer-key versions
  raw/             one JSON per response: text, tool calls and outputs, tokens, timing, and `_scoring`
  overrides.json   human grades and corrections for this run (seeded empty; grade.ts writes here)
  scores.csv       one row per response, failed ones included
  summary.json     the measures above, per split, model and condition, with intervals and paired tests
  summary.md       the same as Markdown tables (also printed)
  charts/*.svg     7 standalone figures
```

**Run status.** Every row has a `status`. Three count as results, three are missing data:

| Status | Meaning | Counted |
| --- | --- | --- |
| `ok` | answered and scored | scored |
| `no-answer` | no final answer: empty text, still calling tools at the step limit, or cut off by the length limit | scored as 0 |
| `timeout` | exceeded the wall-clock budget | scored as 0 |
| `provider-error` | the model call threw (quota, authentication, server error) | missing; `--resume` re-runs it |
| `invalid` | the provider dropped part of the conversation (input tokens fell between steps, e.g. Ollama's default context) | missing; `--resume` re-runs it |
| `scoring-error` | answered, but scoring failed (e.g. PubMed unreachable) | missing; `--rescore` retries it |

Scoring a failure as 0 is "intention to treat": a model cannot look better by giving up on hard queries. Under the old scorer failed runs were dropped, and a model that finished 35 of its 72 runs outscored one that finished all of theirs. A condition with missing runs is flagged in the summary and is not comparable until they exist. A run that timed out or gave no answer is kept on `--resume`, not re-run. The summary also lists keyed queries whose answer key is unverified and counts the rubric answers still waiting for a grade.

**`scores.csv`** is the source of truth. An empty cell is unscored (NA), not 0.

| Columns | Meaning |
| --- | --- |
| `query_id, category, split, key_kind, retrieval_only` | the query: its set, key kind (`values`, `rubric`, `reject`, `accept`) and `retrievalOnly` flag |
| `condition, model, run, status` | the run |
| `accuracy`, `accuracy_source`, `accuracy_graders` | accuracy 0 to 10. Source: `deterministic` (values key), `reject`, `accept`, `human`, `ungraded` (rubric, empty), `failed` (0). Graders: how many people stand behind a `human` value |
| `bullshit_score` | `reject` and `accept` rows only: 1 when the study was handled correctly (a fabricated one rejected, a real one not rejected). The name predates the pair |
| `evidence_quality` | mean design tier 0 to 5 of valid, rated citations. Descriptive |
| `speed_s, input_tokens, output_tokens, total_tokens, tool_calls, tools_used` | cost and effort |
| `pmids_cited, pmids_valid, pmids_fabricated, pmids_off_topic, other_citations` | citations: valid = exists and on topic; fabricated = does not exist or off topic; off topic is a part of fabricated; other = identifiers that are not graded |
| `citations_checked, citations_misattributed` | valid citations with a checkable claim, and those whose claim the record contradicts |

The summary averages accuracy and time over scored rows, tokens over the scored rows that returned (not timeouts), and citation rates over `ok` rows. The charts show the held-out set when the rows include it, otherwise the development set: `accuracy-bars`, `bullshit-rate` (fabricated studies rejected), `control-acceptance-rate`, `fabrication-rate`, `misattribution-rate`, `evidence-histogram` (descriptive) and `speed-vs-accuracy-scatter`. A rescore removes charts an older harness wrote.

## How an answer is scored

**Citations are never trusted.** The scorer finds PMIDs (only when anchored: "PMID 123", "PubMed ID", a PubMed URL; bare numbers are never read as PMIDs), DOIs and PMCIDs (resolved to PMIDs through NCBI), Europe PMC ids outside PubMed (`CBA:644599`, `PPR...`) and ChinaXiv ids (looked up in their own database). A PMID that the prompt itself contains is an echo, not a citation. Every PMID is fetched from live PubMed. A citation is **fabricated** if the record does not exist, or if it exists but its title, abstract and MeSH headings mention none of the query's `topics`. PMIDs are dense, so almost any 8-digit number resolves to some record: in the stored development-set runs not one of more than a thousand cited PMIDs failed to resolve, while some three dozen citations were flagged as misattributed, so existence alone proves nothing. A DOI or regional id that does not resolve is counted in `other_citations`, never fabricated. Queries without `topics` (the fabricated studies) check only existence, and a record with no abstract is never off topic. A transient NCBI failure is a `scoring-error`, never a fabrication. The design tier of a valid citation comes from NLM metadata through the library's classifier ([how it works](../docs/how-it-works.md#the-grader-study-design-labels)); records with no design metadata are left out of the mean.

**Claims next to citations are audited** ([`lib/scoring/attribution.ts`](lib/scoring/attribution.ts), deterministic, no LLM). For each valid citation it compares the sentence around it with the record: a single stated year must be within 1; "Surname et al." must name one of the authors; a claimed design must fit the record's type or NLM tags; of two or more stated figures, at least one must appear in the abstract. Each check fires only on a clear contradiction and abstains when unsure, so the rate counts contradicted claims, not unsupported ones. Flags are kept in the raw JSON under `_scoring.attribution.issues`.

**Accuracy follows the answer key:**

| Key | How it is graded |
| --- | --- |
| `values` | The answer must end with a line `ANSWER — field: value \| field: value`. The last such line is parsed and each expected field compared: numbers as numbers (`0.6` = `0.60`, `37.3%` = `37.3`), text exactly after normalizing case, markdown and dashes (a trailing qualifier such as "(95% CI ...)" is allowed). Accuracy is the fraction matched times 10; no ANSWER line scores 0. A lookup has three fields: the PMID and two numbers |
| `reject` | 10 only if the answer rejects the study itself and cites no fabricated record. Generic hedges ("no evidence of adverse effects") do not count |
| `accept` | 10 if the answer cites the study's own PMID or does not reject the study, else 0. It does not check the summary |
| `rubric` | no accuracy until people grade it |

**Statistics.** The query is the unit: runs are averaged per query first, and every mean is a mean of per-query means with a seeded (20261109) percentile-bootstrap 95% interval over queries (10,000 resamples; none for fewer than two queries). Paired tests compare conditions on keyed accuracy per query with the exact Wilcoxon signed-rank test (zero differences dropped, ties handled, exact up to 300 non-zero pairs and a normal approximation beyond), a bootstrap interval for the mean difference and the rank-biserial effect size. The comparisons are `mcp` vs `closed-book`, `mcp` vs `web-search`, `mcp` vs `pubmed` and `mcp-skill` vs `mcp`, each per model and split, when both conditions ran. The closed-book comparison is repeated without `retrievalOnly` queries when the set has both kinds. All p-values in a report are Holm-adjusted as one family. Fabricated-citation and misattribution rates are pooled over answers and have no interval.

**Scorer version.** `SCORER_VERSION` (now 8, in [`lib/scoring/score.ts`](lib/scoring/score.ts)) is stored in every scored record. Change scoring in a way that alters scores and bump it, so `--rescore` scores stored runs again.

## Grading rubric answers

Only the 15 development `rubric` queries need it; the held-out set has none. [`grade.ts`](grade.ts) shows each answer blind and in a seeded random order: an opaque item id, the prompt, the rubric, the answer, and each cited record's verdict (valid, fabricated), study type and design tier, but not the condition, model or run.

```bash
npx tsx grade.ts results/<timestamp> --grader alice
npx tsx run.ts --rescore results/<timestamp>     # apply the grades
```

| Option | Meaning |
| --- | --- |
| `--grader <id>` | written as `author` (default `$USER`, else `human`) |
| `--seed <n>` | shuffle seed (default derived from the grader id; printed) |
| `--overrides <path>` | read and write this file instead of `<dir>/overrides.json` |
| `--unblind` | show condition, model and run (debugging) |
| `--agreement` | print inter-rater agreement and exit |

Enter 0 to 10 (one decimal allowed) and an optional reason; Enter or `s` skips, `q` saves and quits. Each grade is saved at once. Only `ok` answers are shown. Have two people grade every answer, each with their own `--grader`: grades on one answer are averaged, the summary shows the fewest graders behind any graded answer, and `--agreement` reports Krippendorff's alpha (interval), ICC(2,1), the mean absolute difference and the items where graders differ by more than 3 points. Nothing enforces two graders. Blinding is partial: an answer can still say "I searched PubMed".

**Overrides** live in `<dir>/overrides.json`, keyed by `queryId`, `condition`, `model` and `run` (`"*"` is a wildcard), with a mandatory `reason`. `accuracy` (0 to 10), `evidence_quality` (0 to 5) and `bullshit_score` (0 to 1) replace a value; `null` drops it from aggregation. A human accuracy sets `accuracy_source` to `human`. On a fabricated-study or control row, correcting `bullshit_score` (when the lexical detector got it wrong) moves the accuracy with it. Several graders' entries are averaged, as above. Overrides are applied on every rescore.

**The LLM judge** ([`judge.ts`](judge.ts)) is a reading aid, not a grade. It grades the same blind view plus the abstracts of the cited PubMed records against the rubric, with `qwen3.8-max` by default (needs `DASHSCOPE_API_KEY`; costs money):

```bash
npx tsx judge.ts <results-dir> [--judge <label>] [--conditions mcp,mcp-skill] [--limit <n>]
```

It writes `judge-<model>.json` and `judge-<model>.md` into the results directory and nothing else reads them. Its scores never reach `overrides.json`, `scores.csv`, the summary or the charts. The report has a mean judge score per condition and, when both `mcp` and `mcp-skill` were judged, an unadjusted paired test. A judge can be wrong about medicine and may not know recent papers: spot-check it by hand.

## Reproducibility and old results

- **`manifest.json`** records the commit and whether the tree was dirty, the server and benchmark versions, the scorer version, settings (temperature, max steps, timeout, retries), models (ids, `unpinned`, `fixedSampling`), conditions, the query set and every query's answer-key version. Publish from a clean tree. The summary takes the server version and commit from the manifest, not from the working tree, and `summary.md` states them near the top.
- **`--resume <dir>`** reuses a record only when its model id, settings, prompt and system prompt all match; legacy records are re-run, so are `provider-error` and `invalid` runs. It copies the old `overrides.json`.
- **`--rescore <dir>`** scores against live PubMed only records with no embedded scoring, an older scorer version, a changed answer-key version or a `scoring-error`; the rest reuse their stored scoring offline. A rescore is recorded in the manifest as `rescored` (time, scorer version, harness commit), and the manifest still names the commit that generated the answers.
- **`npx tsx merge.ts [dir ...] [--min-rows <n>]`** (default 12) combines results directories (default: every one except `combined`) into `results/combined/`: `scores.csv`, `summary.*`, `charts/` and `provenance.json`, which names the source directory of every cell. For a shared cell the later directory wins, but a missing row never replaces a scored one. It warns when directories come from different commits, scorer versions or answer-key versions. It does not rescore.
- **Old results.** `merge.ts` reads folders from before scorer 8 and ignores their composite and proxy values: a `proxy` accuracy reads as unscored and `truncated` as `no-answer`. Their citation counts were made under the old definitions; run `--rescore` on the folder first to bring it to the current scorer (it rewrites the folder in place).
- **Tests:** `cd benchmark && npm test` runs offline (no network, no API keys).

## Validity and limitations

**What the numbers can support.**

- Keyed accuracy, the rejection and acceptance pair, the fabricated-citation and misattribution rates, and the failure rates can be compared between conditions and models **within one run of the benchmark**, on one server version, one scorer version and one query set. Nothing here is a composite ranking; do not add or average the measures into one.
- **No results exist yet on the held-out set.** Results produced before scorer version 8 (all on the development set, on older server versions) are not comparable with new ones: they used a composite, a rubric proxy, dropped failed runs and counted off-topic citations as valid. Development-set numbers are development numbers, whatever the version. No results are published with the repository (`results/` is git-ignored).
- **Rubric queries have no accuracy until people grade them, and at least two people are expected to grade every answer** (the summary shows the fewest graders behind any graded answer; nothing enforces two). **No such grading has been done.** They stay out of every headline number.

**How the measures can mislead.**

- The **rejection detector is lexical** ([`lib/scoring/bullshit.ts`](lib/scoring/bullshit.ts)). It can miss unusual phrasings and non-English answers, accept a hedged hybrid that rejects the study but still describes findings, and, on a control, read "I could not find the study's full dataset" as a rejection (unless the answer also cites the record). `accept` is only "did not reject, or cited the record": an invented summary of a real study passes. Review rejected control rows and `reject` rows by hand and use overrides.
- The **off-topic check is lexical.** `topics` is a short word list, so an on-topic paper using none of the words is counted as fabricated (once in 841 citations made with the MCP's tools in earlier runs), and a wrong paper on the right topic passes. Every flagged id is kept with its title in `_scoring.bullshit.offTopicPmids`.
- The **misattribution audit is deliberately conservative.** It reads abstracts only, matches lexically (unit conversions and approximate figures do not match) and abstains when unsure, so it undercounts wrong claims. A figure that appears only in the full text cannot be checked.
- A `values` answer must follow the `ANSWER` format and match the key exactly, so format-following is part of the score.
- Intervals are rough with few queries (under about ten they are too narrow), and the rejection and acceptance rates rest on 12 queries each. The paired tests are over keyed accuracy, which pools three kinds of query. The Holm family is every test in a report, so adding models changes adjusted p-values.
- **Tokens and time.** A timed-out run never reports its token use, so it is left out of the token median (a model that times out often looks cheaper than it is); it counts at the timeout in the time median. Latency and token counts depend on the provider and the time of day.
- **Mean design tier is descriptive.** The `mcp` conditions see design-tier labels in tool results; the baselines do not. Do not read it as quality.
- Models marked `fixedSampling` (currently `claude-haiku-5-5`) run at the provider's default sampling, not temperature 0, so repeated runs of one query can differ. The server's non-PubMed adapters are process-global and not isolated between runs. A rescore reads live PubMed, which changes (indexing, retractions).

**The held-out set.**

- `lookup` queries measure finding a known trial and reading two numbers from its abstract. They do not measure synthesis or clinical judgement, and they are drawn from randomized trials in twelve fields only.
- The `established` stratum covers four general medical journals only. The `recent` stratum ages: it stops being out of reach once models are trained on that period.
- The items were written by one writer, a language model, from the abstracts alone, and checked mechanically against the records (`verify-keys`, `test/heldout.test.ts`) plus one second read by another model. **No clinician reviewed them.** A fabricated author with no PubMed or Europe PMC hit when written is evidence the study does not exist, not proof.
- The set is public, so a model trained later may have seen it, and it is **spent as soon as anything is tuned against it.**
- The web-search baseline depends on one search provider (Brave; a throttled or failing request is tried up to four times before the model sees an error).

## Extending

- **Models:** add an entry to [`models.data.ts`](models.data.ts); `tsc` checks it. Providers `openai` (also for OpenAI-compatible endpoints), `anthropic`, `deepseek` and `ollama` are wired in [`lib/providers.ts`](lib/providers.ts). Pin the id; set `unpinned`, `fixedSampling` or `enabled: false` as needed.
- **Development queries:** add to `queries.data.ts` and pick the key kind that fits. Set `verified` honestly: `true` only for ground truth checked against the record. Give a `values` key a `source` (database, id, quote). Unless it is a fabricated study, give a query broad `topics` (any on-topic paper mentions one) so only an unrelated paper is flagged. Set `retrievalOnly` where training data cannot hold the answer. Bump `answerKeyVersion` when a key changes. Do not add queries to the held-out file.
- **Scoring:** see Scorer version above; [how it works](../docs/how-it-works.md#the-benchmark-grading-answers) describes the same rules.

### Drawing a new held-out set

When the set has been tuned against, or models have been trained on the `recent` period:

1. In `scripts/sample-heldout.ts`, move `RECENT_WINDOW` forward and change `SEED`.
2. `npm run sample-heldout -- --abstracts <file.json>` draws the 24 strata and writes `heldout.sample.json.new` (rename it to adopt it) and the candidates' abstracts to `<file.json>`; abstracts are not kept in the repository. `npm run sample-heldout -- --check` reports how each stratum has drifted since a draw.
3. Write the queries by the writing rule above, record every disposition in `heldout.sample.json`, and write a fabricated twin for each control. `test/heldout.test.ts` holds the query file to that record; keep the id forms (`t-lookup-NN`, `t-control-NN`, `t-bullshit-NN`).
4. Run `npm run verify-keys`, then `npm test`: `test/heldout.test.ts` and `test/leak.test.ts` are the checklist.

Results on the old set are not comparable with results on the new one.
