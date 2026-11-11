# med-research-mcp benchmark

This benchmark measures whether the **med-research-mcp** server helps a model answer biomedical questions correctly and cite real papers. It runs each query under up to five conditions, checks every answer against ground truth and live PubMed, and reports several measures side by side. **There is no single score.** It is for developers and researchers: using the server does not involve it, and it is not part of the published package.

**Read [Validity and limitations](#validity-and-limitations) before citing any number.** The held-out results are under [Results](#results).

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
| Accuracy in PubMed, beyond PubMed | the same, split by the `beyondPubmed` flag (see [the held-out set](#held-out-set)); two extra columns in `summary.md` when a split has both kinds |
| Fabricated studies rejected | share of fabricated-study queries where the answer rejects the study and cites no fabricated record |
| Real studies accepted | share of real-study control queries where the answer does not reject the study, or cites its record |
| Fabricated-citation rate | cited records that do not exist, or exist but mention none of the query's `topics` (a short word list kept with each query), divided by all cited records |
| Misattribution rate | of the valid citations with a checkable claim next to them, the share where a stated year, author, design or figure contradicts the record (the summary calls these "contradicted claims") |
| Failed and missing runs | the share of runs per status |
| Median tokens, median time | over scored runs |
| Mean design tier | 0 to 5, of the cited records. Descriptive: it says what was cited, not whether the answer is right |
| Rubric accuracy | only from human grades; kept out of everything above |

The rejection and acceptance rates are a pair. A model that rejects everything gets every fabricated study right and every real one wrong; neither number means anything alone. Accuracy on keyed queries pools the three key kinds, so look at the pair as well.

An earlier version combined accuracy, evidence, fabrication, speed and cost into one 0 to 10 composite. It was removed after the validity review of 2026-11-09: failed runs dropped out of its means, citing any record that exists earned credit, and open-ended accuracy was a proxy from the cited papers' design tier.

## The two query sets

| | Development set | Held-out set (version 2) |
| --- | --- | --- |
| File | [`queries.data.ts`](queries.data.ts) | [`queries.heldout.data.ts`](queries.heldout.data.ts) |
| Split name | `dev` | `test` |
| Queries | 32 | 91 (table below) |
| Use | build and tune against it freely | measure. Nothing may be tuned against it |
| Answer keys | 13 `values`, 4 `reject`, 15 `rubric` | all keyed: `values`, `accept`, `reject` |
| How to run | the default, or `--split dev` | `--split test`, or `--publish` for the whole set |

`--split dev|test|all` picks the set. Numbers from the development set are development numbers: the server, the skill and the scorer were built against them. The held-out numbers are the ones to report. Nothing may be tuned against a held-out query: not the server, the skills, the scorer or the prompts. `test/leak.test.ts` fails if the system prompt, a shipped skill, the server's tool names, descriptions and schemas or the plain-PubMed tool descriptions contain a query of either set, the id of its answer record, or a worked example that closely paraphrases a query.

### Development set

32 queries in seven categories: factual 4, drill-down 4, synthesis 8, edge-case 6, compound 2, recent 4, bullshit 4. The 4 `reject` and 13 `values` keys have ground truth and are `verified`. The 15 open-ended `rubric` queries have none, so they have no accuracy until people grade them. Eight queries are `retrievalOnly`: the answer is out of reach of training data (a paper newer than the models, or a record only a regional database holds), so a closed-book baseline scores 0 on them by construction. The `recent` keys age: replace them once models are trained on that period.

### Held-out set

**The set was changed after a result was seen.** Version 1 (2026-11-10) had 95 queries, 71 of them `lookup`s of PubMed trials. It was run once: Claude Haiku 5.5, conditions `closed-book`, `pubmed` and `mcp`, 855 responses, server 0.7.0 at commit 4d3ac62, scorer 8 (rescored with scorer 9 on 2026-11-11, see [Results](#results)). Keyed accuracy was 2.64 [1.96, 3.37] closed-book, 9.94 [9.85, 10.00] with plain PubMed tools and 9.91 [9.79, 10.00] with the server (scorer 8; the rescore leaves the three means the same: no accuracy, rejection score or citation count of the 855 rows differs from the archived scorer-8 copy, and the intervals were not computed again). Both tool conditions were at the ceiling, because every lookup can be answered from a PubMed abstract, so the set could not tell them apart. Version 2, written the same day, changed the queries and nothing else:

- **Queries: changed, by stated rules.** A keep rule cut the lookups to one per PubMed stratum, and three frames whose answers are in no PubMed abstract were added (below).
- **Server and scoring: not changed** because of that run. Reading the seven tool-condition answers that lost points showed six scorer or key misses and one real error (see [limitations](#validity-and-limitations)); nothing was changed because of them. How an answer was scored when version 2 was written is as in the run (scorer 8); scorer 9 was added afterwards for the one reason in the [limitations](#validity-and-limitations). Only the report grew: the in-PubMed and beyond-PubMed split, the `beyond_pubmed` column, and small p-values printed as `p<0.0001`.
- **Version 2 has been run once per condition, in three parts.** For `closed-book`, `pubmed` and `mcp` the 48 in-PubMed queries it kept were not answered again: their rows are those of the version 1 run, and their prompts and answer-key versions are the same as in the current query file. Those conditions ran the 43 beyond-PubMed queries on 2026-11-11, and `mcp-skill` ran all 91 queries of version 2 the same day. The numbers, and what they can and cannot show, are under [Results](#results). `heldout.sample.json` records `version` and `history`. The raw files of all three runs are not in the repository (`results/` is git-ignored).

| Category | Queries | The query | Key |
| --- | --- | --- | --- |
| `lookup` | 24 | find a randomized trial described without its PMID; report its PMID and two numbers from its abstract | `values`: three fields, a third of the accuracy each |
| `control` | 12 | a real trial asked about in the form used for fabricated ones: "Summarize the *year* *Surname* trial of ..." | `accept` |
| `bullshit` | 12 | the fabricated twin of a control: same form and field, an author and a trial the field does not have | `reject` |
| `preprint` | 12 | find a Europe PMC preprint that has no published version; report its id and two numbers from its abstract | `values`: `record: <id>` and two numbers |
| `regional` | 15 | the same for a Chinese Biological Abstracts record (8) or a ChinaXiv preprint (7) | `values`: `record: <id>` and two numbers |
| `fulltext` | 16 | a PubMed trial in BMJ, PLoS Medicine, JAMA Network Open or BMC Medicine (4 each): its PMID, the count its abstract states, and one figure that only the article body states. The prompt says the second figure is in the full text | `values`: PMID and two numbers |

`preprint`, `regional` and `fulltext` queries are flagged `beyondPubmed`: the answer is in no PubMed abstract (a preprint without a PubMed record, a record only a regional database holds, a figure only a full text states), so the plain PubMed tools cannot reach it by construction. `preprint`, `regional` and the `recent` lookups are also `retrievalOnly`. RussiaRxiv is left out: almost all of its abstracts are machine-generated, so they are no ground truth (a ChinaXiv record counts only if the source wrote its abstract).

**How the records were drawn.** Each frame is split into strata, each with its own search. A stratum's record ids are sorted (each group of digits as a number), shuffled with a generator seeded from the seed (20261110) and the stratum's name, and the first ones are its candidates; a record already drawn for an earlier stratum is skipped. Counts, quotas and rules are in `FRAME_RULES` ([`scripts/sample-heldout.ts`](scripts/sample-heldout.ts)).

| Frame | Strata | The search | Matched | Candidates (and per extension) | Quota | Extend again below |
| --- | --- | --- | --: | --: | --: | --: |
| `lookup` | 24: 12 fields × `established`, `recent` | PubMed, tagged Randomized Controlled Trial, English, with abstract, MeSH major topic in the field. `established`: published 2015 to 2022 in NEJM, The Lancet, JAMA or The BMJ. `recent`: added to PubMed 2026-09-01 to 2026-10-31, any journal | 29 to 654 | 8 | 3 | 2 |
| `preprint` | 1 | Europe PMC preprints (`SRC:PPR`) with abstract, first posted 2026-05-01 to 2026-10-31, no published version in Europe PMC, whose title or abstract says randomized (controlled or clinical) trial | 1,097 | 16 | 16 | 8 |
| `regional` | 2: Chinese Biological Abstracts, ChinaXiv | `SRC:CBA` with abstract and "randomized" or "randomised" in title or abstract; ChinaXiv records found through the server's ChinaRxiv adapter with the query "randomized patients", only those whose abstract the source wrote | 462; 277 | 16 | 8 | 4 |
| `fulltext` | 4: one per journal | PubMed, tagged Randomized Controlled Trial, English, with abstract and free full text, published 2018 to 2022 in that journal | 111 to 555 | 16 | 4 | 2 |

"Matched" is the size of the stratum when drawn. Queries are written in draw order until a stratum has its quota (or runs out of candidates). A candidate may be passed over only for a reason in `SKIP_REASONS` that applies to its frame (`SKIP_APPLIES`); the reason and a note are recorded in [`heldout.sample.json`](heldout.sample.json), and `test/heldout.test.ts` checks that the queries were written from the draw, in order.

| Reason | Frames | Meaning |
| --- | --- | --- |
| `not-primary` | all | not the report of a randomized comparison: a protocol, a secondary, post-hoc or pooled analysis, a long-term follow-up, a cost analysis |
| `no-numbers` | all | the abstract states no two unambiguous numbers to ask for: how many took part, and a result or a second count. For `fulltext`: it does not state how many were randomized |
| `not-identifiable` | all | the trial cannot be described without its PMID or id in a way that tells it from a sibling report |
| `in-development-set` | all | the record is the subject of a development query |
| `predates-window` | `lookup` | `recent` only: published online before 2026-08-01, so a model may have seen it |
| `in-pubmed` | `preprint`, `regional` | the record, or a published version of it, has a PubMed record whose abstract states the same figures |
| `no-fulltext-figure` | `fulltext` | the full text gives no figure in running prose that the abstract lacks (a table, a legend or the abstract does not count) |
| `no-fulltext` | `fulltext` | the server's full-text function returns no body for the record |

**Keep rule (version 2).** In each of the 24 lookup strata only the first lookup in draw order is kept (`KEEP_PER_STRATUM`); the other 47 are retired. A retired candidate keeps its old id as `retired` in the sample file, and its query leaves the query file. Kept queries keep their ids, so lookup ids skip. The rule looks at draw order only, never at a result; controls and fabricated twins are untouched. A stored run of version 1 still has rows for the retired queries. `scores.csv` keeps them, but `run.ts`, `merge.ts` and `--rescore` leave them out of every number, chart and status tally, and `summary.md` says how many rows were left out.

**Extension rule.** A stratum whose candidates are all decided with fewer queries than its quota (retired ones count) is extended: `npm run sample-heldout -- --extend <stratum> --cand-dir <dir>` re-runs its search and appends the next batch of the same shuffled order. The script refuses while a stored candidate has no disposition, once the stratum has its quota, and for a stratum already extended once that has at least the "extend again below" number of queries. Three strata were extended once: the ChinaXiv stratum (to 32 candidates) and obstetrics/recent (version 1); the preprint stratum was extended twice (to 48 candidates), the second time because it had 7 queries, below 8. It ends with 12 of its 16 queries, its candidates run out, and 12 is not below 8, so the rule does not extend it again. The ChinaXiv stratum ends with 7 of 8 for the same reason (7 is not below its 4). The queries of the second extension (candidates 33 to 48) were written by the second reader, not by a query writer, and nobody has read them a second time.

**Staging and merging.** The `lookup`, `control` and `bullshit` queries were written by hand; no script produces them. The beyond-PubMed queries are staged: a writer reads the candidate texts that `sample-heldout.ts --cand-dir` writes (a `fulltext` candidate also has the article body as `literature_fulltext` returns it) and writes one file per stratum, outside the repository, with a disposition for each candidate in draw order. `npm run merge-heldout -- --items <dir> --cand <dir> [--dry-run]` validates every file and, only if all pass, writes the dispositions into `heldout.sample.json` and the queries into the marked region at the end of `queries.heldout.data.ts`. It is re-runnable; ids are assigned in stratum order, so they are final only after the last merge. It checks that the dispositions are a prefix of the stored candidates, that a skip's reason applies and has a note, the query's fields, flags and answer-format line, that every expected number is in the quote (the full-text figure only in the full-text quote, and nowhere in the title or abstract), that the quote is in the candidate's text, and that the question names no record id, DOI, PMID or author. The format is described in the header of [`scripts/merge-heldout.ts`](scripts/merge-heldout.ts).

**Answer keys.** Every `values` key names its source record and quotes the passage that states its numbers (a `fulltext` key also quotes the full-text passage of its figure). `npm run verify-keys` checks every `verified` key of both sets against the live records (`npm run verify-keys -- --all` also checks unverified keyed ones):

| Key | What is checked |
| --- | --- |
| `values` | the record exists; each quoted passage is in its title or abstract; each expected number is in the quote; an expected PMID or record id is the source's and is not in the prompt. A study type read from an abstract cannot be checked this way and is a warning. Development keys that name a study type and evidence score are also checked against the record's live NLM design and `DESIGN_TIER` |
| `preprint`, `regional` | the first expected field is `record: <id>`; the record's title is not the title of a PubMed record (a published version under another title is not caught) |
| `fulltext` | the passage is in the full text the library's full-text function returns (every part read), the figure is in the passage, and no number of the title or abstract equals it |
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

At present `--publish` plans 1,638 responses per condition (91 queries, 6 enabled models, 3 runs) and warns about unpinned models (`gemma4-4b` is one), unverified keys and a dirty working tree. Before a held-out run: commit, so that the manifest's commit describes the code; run `npm run verify-keys`; start off-peak for NCBI; afterwards read the status tally and `--resume` the missing runs.

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

npm scripts: `bench`, `smoke`, `smoke-baselines`, `grade`, `rescore`, `merge`, `verify-keys`, `sample-heldout`, `merge-heldout`, `typecheck`, `test`.

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
| `query_id, category, split, key_kind, retrieval_only, beyond_pubmed` | the query: its set, key kind (`values`, `rubric`, `reject`, `accept`) and its two flags |
| `condition, model, run, status` | the run |
| `accuracy`, `accuracy_source`, `accuracy_graders` | accuracy 0 to 10. Source: `deterministic` (values key), `reject`, `accept`, `human`, `ungraded` (rubric, empty), `failed` (0). Graders: how many people stand behind a `human` value |
| `bullshit_score` | `reject` and `accept` rows only: 1 when the study was handled correctly (a fabricated one rejected, a real one not rejected). The name predates the pair |
| `evidence_quality` | mean design tier 0 to 5 of valid, rated citations. Descriptive |
| `speed_s, input_tokens, output_tokens, total_tokens, tool_calls, tools_used` | cost and effort |
| `pmids_cited, pmids_valid, pmids_fabricated, pmids_off_topic, other_citations` | citations: valid = exists and on topic; fabricated = does not exist or off topic; off topic is a part of fabricated; other = identifiers that are not graded |
| `citations_checked, citations_misattributed` | valid citations with a checkable claim, and those whose claim the record contradicts |

The summary averages accuracy and time over scored rows, tokens over scored rows except timeouts, and citation rates over `ok` rows. The charts show the held-out set when the rows include it, otherwise the development set: `accuracy-bars`, `bullshit-rate` (fabricated studies rejected), `control-acceptance-rate`, `fabrication-rate`, `misattribution-rate`, `evidence-histogram` (descriptive) and `speed-vs-accuracy-scatter`. They pool keyed accuracy; the in-PubMed and beyond-PubMed split is in the summary only. A rescore removes charts an older harness wrote.

## How an answer is scored

**Citations are never trusted.** The scorer finds PMIDs (only when anchored: "PMID 123", "PubMed ID", a PubMed URL; bare numbers are never read as PMIDs), DOIs and PMCIDs (resolved to PMIDs through NCBI), Europe PMC ids outside PubMed (`CBA:644599`, `PPR...`) and ChinaXiv ids (looked up in their own database). A PMID that the prompt itself contains is an echo, not a citation. Every PMID is fetched from live PubMed. A citation is **fabricated** if the record does not exist, or if it exists but its title, abstract and MeSH headings mention none of the query's `topics`. PMIDs are dense, so almost any 8-digit number resolves to some record: in the stored development-set runs the validity review found 0 of 1,359 cited PMIDs failing to resolve while 37 were misattributed, so existence alone proves nothing. A DOI or regional id that does not resolve is counted in `other_citations`, never fabricated. Queries without `topics` (the fabricated studies) check only existence, and a record with no abstract is never off topic. A transient NCBI failure is a `scoring-error`, never a fabrication. The design tier of a valid citation comes from NLM metadata through the library's classifier ([how it works](../docs/how-it-works.md#the-grader-study-design-labels)); records with no design metadata are left out of the mean.

**Claims next to citations are audited** ([`lib/scoring/attribution.ts`](lib/scoring/attribution.ts), deterministic, no LLM). For each valid citation it compares the sentence around it with the record: a single stated year must be within 1; "Surname et al." must name one of the authors; a claimed design must fit the record's type or NLM tags; of two or more stated figures, at least one must appear in the abstract. Each check fires only on a clear contradiction and abstains when unsure, so the rate counts contradicted claims, not unsupported ones. Flags are kept in the raw JSON under `_scoring.attribution.issues`.

**Accuracy follows the answer key:**

| Key | How it is graded |
| --- | --- |
| `values` | The answer must end with a line `ANSWER — field: value \| field: value`. The last such line is parsed and each expected field compared: numbers as numbers (`0.6` = `0.60`, `37.3%` = `37.3`), text exactly after normalizing case, markdown and dashes (a trailing qualifier such as "(95% CI ...)" is allowed). Accuracy is the fraction matched times 10; no ANSWER line scores 0. A lookup has three fields: the PMID and two numbers |
| `values` of `preprint` and `regional` queries | The first field is `record: <id>`, compared as text: the id must be written as the server prints it (`PPR...`, `CBA:...`, `chinaxiv-...`, as the prompt asks). Case, markdown and a final period do not matter; any other spelling (`CBA 521529`, a bare number) loses that field, so a right answer found outside the server's databases scores at most 6.67 (`test/record-ids.test.ts`) |
| `reject` | 10 only if the answer rejects the study itself and cites no fabricated record. Generic hedges ("no evidence of adverse effects") do not count |
| `accept` | 10 if the answer cites the study's own PMID or does not reject the study, else 0. It does not check the summary |
| `rubric` | no accuracy until people grade it |

**Statistics.** The query is the unit: runs are averaged per query first, and every mean is a mean of per-query means with a seeded (20261109) percentile-bootstrap 95% interval over queries (10,000 resamples; none for fewer than two queries). Paired tests compare conditions on keyed accuracy per query with the exact Wilcoxon signed-rank test (zero differences dropped, ties handled, exact up to 300 non-zero pairs and a normal approximation beyond), a bootstrap interval for the mean difference and the rank-biserial effect size. The comparisons are `mcp` vs `closed-book`, `mcp` vs `web-search`, `mcp` vs `pubmed` and `mcp-skill` vs `mcp`, each per model and split, when both conditions ran. `mcp` vs `pubmed` is tested on all keyed queries, on those in PubMed and on those beyond PubMed (`keyed`, `keyed-in-pubmed`, `keyed-beyond-pubmed`; the last two when the pair's queries have both kinds). The closed-book comparison is repeated without `retrievalOnly` queries when the set has both kinds. All p-values in a report are Holm-adjusted as one family. `summary.md` prints a p-value below 0.0001 as `p<0.0001`; `summary.json` keeps the value. Fabricated-citation and misattribution rates are pooled over answers and have no interval.

**Scorer version.** `SCORER_VERSION` (now 9, in [`lib/scoring/score.ts`](lib/scoring/score.ts)) is stored in every scored record. Change scoring in a way that alters scores and bump it, so `--rescore` scores stored runs again.

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
- **Old results.** `merge.ts` reads folders from before scorer 8 and ignores their composite and proxy values: a `proxy` accuracy reads as unscored and `truncated` as `no-answer`. Their citation counts were made under the old definitions; run `--rescore` on the folder first to bring it to the current scorer (it rewrites the folder in place). A folder from held-out version 1 also holds rows of retired queries; reports leave them out (see the keep rule).
- **Tests:** `cd benchmark && npm test` runs offline (no network, no API keys).

## Results

Read [Validity and limitations](#validity-and-limitations) before using these numbers. They are for the held-out set, version 2 (91 queries), with one model, Claude Haiku 5.5 (`claude-haiku-5-5`, at the provider's default sampling), under four conditions with 3 runs per query: 1,092 responses, none failed or missing. **The raw results are not in the repository** (`results/` is git-ignored), so the numbers are written out here. They are copied from the merged report, `results/combined/summary.md` and `summary.json`, which `merge.ts` built from three runs; `results/combined/provenance.json` names the run behind every row.

| Run | Queries | Responses | Commit | Scorer |
| --- | --- | --: | --- | --- |
| A, 2026-11-10, `results/2026-11-10-172017` | version 1 of the set (95 queries). Its rows for the 48 queries that version 2 kept are used; the 47 retired lookups (423 rows) are left out | 432 used, of 855 | 4d3ac62 | 8, rescored with 9 on 2026-11-11 |
| B, 2026-11-11, `results/2026-11-11-132322` | the 43 new beyond-PubMed queries (`preprint`, `regional`, `fulltext`) | 387 | 9a401a0 | 9 |
| C, 2026-11-11, `results/2026-11-11-141707` | all 91 version 2 queries, condition `mcp-skill` only | 273 | 9a401a0 | 9 (rescored on 2026-11-11 with uncommitted changes in the working tree) |

All three runs used server 0.7.0 and the same settings. Runs A and B ran `closed-book`, `pubmed` and `mcp`; run C ran `mcp-skill`. The system prompt is the same in every condition except `mcp-skill`, where it is the same text with the skill appended (compared in every raw record). Runs B and C are at one commit; nothing under `src/` or `skills/` differs between it and run A's commit, but the benchmark's own code does (the new query frames, scorer 9). The merge warns that the runs come from different commits and cover different query sets.

Keyed accuracy is 0 to 10, the mean of per-query means over the queries with ground truth, with a 95% bootstrap interval over queries in brackets. "In PubMed" and "beyond PubMed" split the same 91 queries by the `beyondPubmed` flag. Fabricated studies rejected and real studies accepted are the pair described under [What is reported](#what-is-reported), on 12 queries each. A fabricated citation is a cited record that does not exist or is off topic by the lexical check, over all records cited (`closed-book`: 1 does not exist and 23 are off topic; `pubmed`: 7 are off topic; `mcp-skill`: 2 are off topic; `mcp`: none). Tokens and time are medians per response over all 91 queries.

| Condition | Keyed accuracy, all 91 queries | In PubMed, 48 queries | Beyond PubMed, 43 queries | Fabricated studies rejected | Real studies accepted | Fabricated citations | Median tokens | Median time (s) |
| --- | --: | --: | --: | --: | --: | --: | --: | --: |
| `closed-book` | 2.21 [1.54, 2.92] | 4.05 [3.01, 5.09] | 0.15 [0.00, 0.39] | 75% [58%, 89%] | 53% [33%, 69%] | 41.4% of 58 | 1,217 | 5.1 |
| `mcp` | 9.46 [9.04, 9.80] | 9.81 [9.58, 10.00] | 9.07 [8.24, 9.74] | 94% [86%, 100%] | 100% [100%, 100%] | 0.0% of 466 | 19,956 | 12.2 |
| `mcp-skill` | 9.32 [8.84, 9.72] | 9.95 [9.86, 10.00] | 8.60 [7.65, 9.41] | 100% [100%, 100%] | 100% [100%, 100%] | 0.4% of 470 | 36,918 | 12.8 |
| `pubmed` | 6.42 [5.53, 7.28] | 9.88 [9.70, 10.00] | 2.56 [1.60, 3.52] | 100% [100%, 100%] | 97% [92%, 100%] | 1.3% of 527 | 12,864 | 12.3 |

Accuracy by category (keyed queries, mean over queries):

| Category | Where | Queries | `closed-book` | `mcp` | `mcp-skill` | `pubmed` |
| --- | --- | --: | --: | --: | --: | --: |
| `lookup` | in PubMed | 24 | 1.71 | 9.91 | 9.91 | 9.91 |
| `bullshit` | in PubMed | 12 | 7.50 | 9.44 | 10.00 | 10.00 |
| `control` | in PubMed | 12 | 5.28 | 10.00 | 10.00 | 9.72 |
| `preprint` | beyond PubMed | 12 | 0.00 | 10.00 | 7.50 | 0.09 |
| `regional` | beyond PubMed | 15 | 0.00 | 7.78 | 8.22 | 0.00 |
| `fulltext` | beyond PubMed | 16 | 0.42 | 9.58 | 9.79 | 6.81 |

Paired tests on keyed accuracy per query (exact Wilcoxon signed-rank test; p-values Holm-adjusted as one family; r_rb is the rank-biserial effect size):

| Comparison | Queries | Accuracy | Difference [95% CI] | Queries that differ | p | Holm p | r_rb |
| --- | --: | --- | --- | --: | --: | --: | --: |
| `mcp` vs `closed-book`, all keyed queries | 91 | 9.46 vs 2.21 | +7.25 [6.46, 8.00] | 80 | <0.0001 | <0.0001 | 1.00 |
| `mcp` vs `closed-book`, queries that training data could answer | 52 | 9.70 vs 3.87 | +5.83 [4.81, 6.82] | 44 | <0.0001 | <0.0001 | 0.99 |
| `mcp` vs `pubmed`, all keyed queries | 91 | 9.46 vs 6.42 | +3.04 [2.20, 3.91] | 44 | <0.0001 | <0.0001 | 0.92 |
| `mcp` vs `pubmed`, queries a PubMed abstract answers (like for like) | 48 | 9.81 vs 9.88 | -0.07 [-0.35, 0.14] | 4 | 1.0 | 1.0 | -0.20 |
| `mcp` vs `pubmed`, queries beyond PubMed | 43 | 9.07 vs 2.56 | +6.51 [5.37, 7.62] | 40 | <0.0001 | <0.0001 | 1.00 |
| `mcp-skill` vs `mcp`, all keyed queries | 91 | 9.32 vs 9.46 | -0.15 [-0.55, 0.20] | 13 | 0.69 | 1.0 | -0.13 |

**How to read it.**

- **In PubMed there is no measurable difference between `mcp` and `pubmed`:** 9.81 against 9.88, difference -0.07 [-0.35, 0.14], 4 of 48 queries differing, Holm p = 1.0. Both are close to the maximum of 10, so these queries could not separate them; the result does not say they are equal on harder questions that a PubMed abstract answers. These 48 rows are run A's, made before version 2 was written.
- **Beyond PubMed the difference is reach:** 9.07 against 2.56, difference +6.51 [5.37, 7.62], 40 of 43 queries differing. Plain PubMed tools cannot get to a preprint, a regional record or an article body, so by construction this measures what the extra reach is worth, not answer quality. `pubmed` scored 6.81 on the `fulltext` queries, where the PMID and the count its abstract states are in reach, and 0.09 and 0.00 on `preprint` and `regional`.
- **Token cost.** Over all 91 queries `mcp` used a median of 19,956 tokens per response, `mcp-skill` 36,918, `pubmed` 12,864 and `closed-book` 1,217; median time was 12.2, 12.8, 12.3 and 5.1 seconds. On the 48 in-PubMed queries alone, where `mcp` and `pubmed` score alike, run A's own report has medians of 17,721.5 tokens for `mcp` and 9,612.5 for `pubmed`.
- **The skill made no measurable difference to accuracy.** `mcp-skill` against `mcp`: 9.32 against 9.46 over all 91 keyed queries, difference -0.15 [-0.55, 0.20], 13 of 91 queries differing, Holm p = 1.0. In PubMed 9.95 [9.86, 10.00] against 9.81 [9.58, 10.00]; beyond PubMed 8.60 [7.65, 9.41] against 9.07 [8.24, 9.74]. Each pair of intervals overlaps, and the two splits were not tested separately. The skill was appended to the system prompt of every `mcp-skill` response, which is the best case for it. The 48 in-PubMed rows of `mcp` come from run A (commit 4d3ac62, 2026-11-10), those of `mcp-skill` from run C, so the two were not run side by side on those queries.
- **The skill cost tokens:** a median of 36,918 per response against 19,956 for `mcp`, and 12.8 seconds against 12.2.
- **Where `mcp` and `mcp-skill` differ most by category.** These are observations from one model, 3 runs per query and 12 to 24 queries per category, not conclusions about the skill. `preprint` differs most: 7.50 for `mcp-skill` against 10.00 for `mcp`. `mcp-skill` answered "not found", "not located" or "not retrieved" in all three runs of `t-preprint-09` and `t-preprint-11` and in one run each of `t-preprint-02` and `-08`, and lost part of its score in run 1 of `-05` and `-06`; `mcp` scored 10 on all 12 preprint queries. The other differences are 0.56 or smaller: `bullshit` 10.00 against 9.44 (the gap is the two run A `mcp` answers described in the last bullet), `regional` 8.22 against 7.78, `fulltext` 9.79 against 9.58; `lookup` and `control` are equal. Both conditions missed `t-regional-06` and `-07` in all three runs.
- **One model, one run per condition.** All 1,092 responses are from Claude Haiku 5.5, 3 runs of each query per condition, at the provider's default sampling rather than temperature 0. Nothing here says how another model would do, and another run could differ.
- **Where `mcp` lost points on the new queries.** 16 of its 129 answers scored below 10 (checked against `_scoring.accuracy` in `results/2026-11-11-132322/raw/`).
  - 10 were Chinese Biological Abstracts records it did not find: `t-regional-06`, `-07` and `-08` in all three runs, `t-regional-03` in one. Every field of the `ANSWER` line read "not found", "unknown", "not located" or "not identified"; it did not guess, and each answer scored 0.
  - 5 were `fulltext` answers where the article body could not be read (the full-text function returned the abstract or nothing). In BMJ `t-fulltext-02` (runs 1 and 2) and `t-fulltext-03` (run 1) the answer gave an inferred or guessed figure for the full-text field and said so (480 against the key's 479; 470 against 486). In JAMA Network Open `t-fulltext-09` and `-10` (run 3 of each) the answer said it could not retrieve the figure. In the other runs of those four queries the body was read (from Unpaywall for BMJ, Europe PMC for JAMA Network Open) and the figure was right.
  - 1 was a `fulltext` answer where the body was read: `t-fulltext-07` (PLOS Medicine), run 1, gave 288 for the sample size "per intervention", its own derivation (24 subjects per clinic times 12 clinics), where the key holds the 576 the paper states and the answer says the paper reports only 576. The wording of the question may be ambiguous; the other two runs answered 576.
- **Run A rows that are mis-scored and not corrected.** Of the seven tool-condition answers of run A that lost points, six were scorer or key misses: two `mcp` answers rejected a fabricated study in words the detector did not match (`t-bullshit-01` run 1 and `t-bullshit-03` run 3, both scored 0; they are all of the gap between `mcp`'s 94% and 100% above), and four answers gave 18.3 where the key holds 18 (`t-lookup-13`: `mcp` runs 2 and 3, `pubmed` runs 1 and 2; the abstract says 235 (18%) of 1287, and 235/1287 is 18.26%). The seventh is a real error: `pubmed` run 3 on `t-control-11` said it could not find a real study, which is the gap between `pubmed`'s 97% and 100%. Corrections for the six have been proposed and not applied: a person has to confirm them. Two `mcp-skill` answers of run C show the same 18.3 against 18 on `t-lookup-13` (runs 1 and 3); they are not among the six, and no correction is proposed for them. Every figure in this section is as scored, and correcting the six would raise `mcp` and `pubmed`.

## Validity and limitations

**What the numbers can support.**

- Keyed accuracy, the rejection and acceptance pair, the fabricated-citation and misattribution rates, and the failure rates can be compared between conditions and models **within one report**: one run, or runs merged by `merge.ts` on one server version, one scorer version and one query set. Nothing here is a composite ranking; do not add or average the measures into one.
- **The held-out set was revised after a result was seen; version 2 has been run once per condition, in three parts, with one model.** For `closed-book`, `pubmed` and `mcp` the 48 in-PubMed rows are those of the version 1 run, made before the revision; only the 43 beyond-PubMed queries were run on the version 2 file (2026-11-11), and `mcp-skill` ran all 91 (also 2026-11-11). The parts come from two commits, 4d3ac62 and 9a401a0, with the same server and skill files (nothing under `src/` or `skills/` differs between them) and the same scorer (version 9; the version 1 run was rescored). Version 2 changed the queries, not the server or the scorer (scorer 9 came afterwards, for the tag-stripper fix below; compared with the archived scorer-8 copy of the version 1 run, no accuracy, rejection score or citation count of its 855 rows differs). A set that a result has shaped is not one no result has touched; for that, draw a new set. The numbers of version 1 as a whole (95 queries, [the held-out set](#held-out-set)) belong to version 1 and are not comparable with version 2. Results produced before scorer version 8 (all on the development set, on older server versions) are not comparable with new ones either: they used a composite, a rubric proxy, dropped failed runs and counted off-topic citations as valid. Development-set numbers are development numbers, whatever the version. No results are published with the repository.
- **Rubric queries have no accuracy until people grade them, and at least two people are expected to grade every answer** (the summary shows the fewest graders behind any graded answer; nothing enforces two). **No such grading has been done.** They stay out of every headline number.

**How the held-out set reads.**

- **The beyond-PubMed queries favour the server by construction.** Plain PubMed tools cannot reach a preprint, a regional record or the body of an article, so the gap on those queries (9.07 against 2.56) measures what the extra reach is worth, not answer quality. The like-for-like comparison is the in-PubMed subset (lookups, controls and fabricated studies): the server and the plain PubMed tools did not differ, 9.81 against 9.88 (difference -0.07 [-0.35, 0.14], 4 of 48 queries differing), as in version 1 as a whole, where every query was in PubMed (9.91 against 9.94, difference -0.04 [-0.18, 0.07], 4 of 95 queries differing). The in-PubMed queries of version 2 are queries of version 1, and their rows are that run's: both tool conditions scored near 10 of 10 on them, so there is little room for a difference, and "no measurable difference" means these queries could not separate the two, not that they are equal on harder ones. The server used more tokens: a median of 19,956 per response against 12,864 for the plain PubMed tools over all 91 queries, and on the 48 in-PubMed queries 17,721.5 against 9,612.5 (version 1 as a whole: about 2.3 times, 14.6k against 6.4k).
- **One model, one run per condition.** Every held-out response is from Claude Haiku 5.5, 3 runs of each query, at the provider's default sampling. The results do not show how another model would compare, and nobody has repeated the run.
- **The new frames are loose, as drawn.** Of the 48 preprint candidates 36 were passed over: 29 as not the report of a randomized comparison (protocols, reviews and secondary analyses among them), 5 without two numbers and 2 already in PubMed, which leaves 12 queries against a quota of 16. The regional records include animal studies and, among the ChinaXiv candidates, placeholder titles; one ChinaXiv candidate was passed over because its abstract contradicts its own total; neither regional search has a date window.
- **The `fulltext` queries also measure access.** Whether the library returns an article body can vary between reads of the same article. In the run, the same Europe PMC read of each of two JAMA Network Open articles returned the body in two runs and nothing in the third. For two BMJ articles the body came from Unpaywall in some runs, and in the others the answer had only the abstract or nothing; the stored calls do not settle whether the read or the way the model called the function made the difference. 5 of the 48 `fulltext` answers of `mcp` lost a third of their score because no body was read (see [Results](#results)). A body that cannot be read costs the figure that only the body states.
- **Europe PMC abstracts were read with a flawed tag stripper; fixed in scorer 9.** The scorer's regional lookup (`lib/scoring/verify.ts`, which `verify-keys` also uses) and the candidate-text writer (`scripts/sample-heldout.ts`) removed tags with `<[^>]+>`, which deletes everything from a less-than sign up to the next greater-than sign (the server's own cleaner, `htmlToText` in `src/core/text.ts`, keeps the whole abstract: one preprint abstract came out as 1,283 characters and is 2,180). Both now use `htmlToText` (`SCORER_VERSION` 9). Preprint candidates had been judged on the cut text; their texts were written again on 2026-11-11 and six abstracts were longer (PPR1261422, PPR1287151, PPR1340798, PPR1341477, PPR1254907, PPR1253213), which changed one item: PPR1261422 now asks for the first result printed, which is readable. The CBA texts changed in whitespace only. The version 1 run (855 responses) was scored with scorer 8 and rescored with scorer 9 on 2026-11-11 (`rescored` in its manifest); compared with the archived scorer-8 copy, no accuracy, rejection score or citation count of any of its 855 rows differs. The run of the beyond-PubMed queries was scored with scorer 9 from the start. Only an answer that cites a Europe PMC record outside PubMed (a `PPR…` or `CBA:…` id) reads differently under scorer 9, because its off-topic and figure checks used to read the cut text; version 1 had no query whose answer is such a record, and the rescore changed none of the values compared.
- **The record id caps a right answer at 6.67** unless it is written as the server prints it (see the accuracy table). This weighs on the web-search baseline, which finds these records on web pages and may write another form of the id.
- `lookup` queries measure finding a known trial and reading two numbers from its abstract; they do not measure synthesis or clinical judgement, and they are drawn from randomized trials in twelve fields only. The `established` lookups cover four general medical journals only, and the `recent` stratum ages: it stops being out of reach once models are trained on that period.
- The `lookup`, `control` and `bullshit` queries were written by one writer, a language model, from the abstracts alone; the beyond-PubMed queries were written into staged files from the candidates' texts under the staging rules. All were checked mechanically against the records (`verify-keys`, `merge-heldout`, `test/heldout.test.ts`) plus a second read. **No clinician reviewed any held-out item.** A fabricated author with no PubMed or Europe PMC hit when written is evidence the study does not exist, not proof.
- The set is public, so a model trained later may have seen it, and it is **spent as soon as anything is tuned against it.**
- The web-search baseline depends on one search provider (Brave; a throttled or failing request is tried up to four times before the model sees an error).

**How the measures can mislead.**

- The **rejection detector is lexical** ([`lib/scoring/bullshit.ts`](lib/scoring/bullshit.ts)). It can miss unusual phrasings and non-English answers, accept a hedged hybrid that rejects the study but still describes findings, and, on a control, read "I could not find the study's full dataset" as a rejection (unless the answer also cites the record). `accept` is only "did not reject, or cited the record": an invented summary of a real study passes. In the first run two answers rejected a fabricated study correctly in wording the detector did not match, and they scored 0. Review rejected control rows and `reject` rows by hand and use overrides.
- **Exact-value keys have no tolerance.** In the first run four answers computed a percentage to one decimal where the key holds the abstract's rounded figure, and each lost a third of its score. Of the seven tool-condition answers that lost points, six were these two kinds of miss; one was a real error (a real study rejected). Nothing was changed because of them, and the six are still scored as the scorer gave them: corrections are proposed, not confirmed or applied (see [Results](#results)).
- The **off-topic check is lexical.** `topics` is a short word list, so an on-topic paper using none of the words is counted as fabricated (once in 841 citations made with the MCP's tools in earlier runs), and a wrong paper on the right topic passes. Every flagged id is kept with its title in `_scoring.bullshit.offTopicPmids`.
- The **misattribution audit is deliberately conservative.** It reads abstracts only, matches lexically (unit conversions and approximate figures do not match) and abstains when unsure, so it undercounts wrong claims. A figure that appears only in the full text cannot be checked.
- A `values` answer must follow the `ANSWER` format, so format-following is part of the score.
- Intervals are rough with few queries (under about ten they are too narrow), and the rejection and acceptance rates rest on 12 queries each. The paired tests are over keyed accuracy, which pools three kinds of query. The Holm family is every test in a report, so adding models changes adjusted p-values.
- **Tokens and time.** A timed-out run never reports its tokens, so the token median leaves timeouts out; the time median counts them at the timeout. Latency and token counts depend on the provider and the time of day.
- **Mean design tier is descriptive.** The `mcp` conditions see design-tier labels in tool results; the baselines do not. Do not read it as quality.
- Models marked `fixedSampling` (currently `claude-haiku-5-5`) run at the provider's default sampling, not temperature 0, so repeated runs of one query can differ. The server's non-PubMed adapters are process-global and not isolated between runs. A rescore reads live PubMed, which changes (indexing, retractions).

## Extending

- **Models:** add an entry to [`models.data.ts`](models.data.ts); `tsc` checks it. Providers `openai` (also for OpenAI-compatible endpoints), `anthropic`, `deepseek` and `ollama` are wired in [`lib/providers.ts`](lib/providers.ts). Pin the id; set `unpinned`, `fixedSampling` or `enabled: false` as needed.
- **Development queries:** add to `queries.data.ts` and pick the key kind that fits. Set `verified` honestly: `true` only for ground truth checked against the record. Give a `values` key a `source` (database, id, quote). Unless it is a fabricated study, give a query broad `topics` (any on-topic paper mentions one) so only an unrelated paper is flagged. Set `retrievalOnly` where training data cannot hold the answer. Bump `answerKeyVersion` when a key changes. Do not add queries to the held-out file.
- **Scoring:** see Scorer version above; [how it works](../docs/how-it-works.md#the-benchmark-grading-answers) describes the same rules.

### Drawing a new held-out set

When the set has been tuned against, a result has shaped it, or models have been trained on the `recent` period:

1. In `scripts/sample-heldout.ts`, move `RECENT_WINDOW`, `PREPRINT_WINDOW` and `FULLTEXT_YEARS` forward as needed, and change `SEED`.
2. `npm run sample-heldout -- --abstracts <file.json> --cand-dir <dir>` draws every stratum anew and writes `heldout.sample.json.new` (rename it to adopt it), the lookup abstracts to `<file.json>` and the candidate texts of the other frames to `<dir>`; texts are not kept in the repository. `npm run sample-heldout -- --check` reports how each stratum has drifted since a draw.
3. Write the lookups, controls and fabricated twins by hand by the writing rule above, and the other frames as staged files; record every lookup disposition in `heldout.sample.json` and merge the staged files with `npm run merge-heldout`. Keep the id forms (`t-<category>-NN`).
4. Run `npm run verify-keys`, then `npm test`: `test/heldout.test.ts` and `test/leak.test.ts` are the checklist.

Results on the old set are not comparable with results on the new one.
