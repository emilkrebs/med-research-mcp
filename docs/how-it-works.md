# How med-research-mcp works

This document explains what happens inside the server: how a search travels through the databases, how each result gets its study-design label, how full texts are found, and how the benchmark grades answers. For installation, see the [README](../README.md); for parameters and results, the [tool reference](tools.md).

Three different things in this repo grade something:

| | Where | What it grades |
| --- | --- | --- |
| **The grader** (design labeler) | [`src/core/grader.ts`](../src/core/grader.ts) | Every search result: its study design, design tier and integrity flags, from NLM metadata |
| **Human grading** | [`benchmark/grade.ts`](../benchmark/grade.ts) | Open-ended benchmark answers, blind, on a 0–10 scale |
| **LLM judge** | [`benchmark/judge.ts`](../benchmark/judge.ts) | The same answers, as a second opinion that never replaces a human grade |

## Contents

- [Architecture](#architecture)
- [Life of a search](#life-of-a-search)
- [The grader: study-design labels](#the-grader-study-design-labels)
- [Fetch and full text](#fetch-and-full-text)
- [Rate limits, errors and caching](#rate-limits-errors-and-caching)
- [The benchmark: grading answers](#the-benchmark-grading-answers)

## Architecture

```text
MCP client (Claude Code, Claude Desktop, Cursor, …)
   │  stdio
   ▼
src/mcp/index.ts     CLI: env warnings, stdio transport, closes the cache on exit
src/mcp/server.ts    createServer(): tool schemas (zod), one shared cache and NCBI client
   │
   ▼
src/core/            plain TypeScript, no MCP dependency (published as med-research-mcp/core)
├─ literature.ts     searchLiterature / fetchLiterature: fan out, classify, de-duplicate, filter, sort
├─ adapters/         one file per database, plus registry.ts
├─ pubmed.ts         NcbiClient: esearch → esummary → efetch, with a rate limiter
├─ grader.ts         study-design labels, tiers and flags
├─ fulltext.ts       PMCID → Europe PMC, DOI → Unpaywall → proxy → doi.org → abstract
├─ public-fetch.ts   fetches full-text pages, refusing private addresses
├─ cache.ts          in-memory LRU or SQLite
└─ errors.ts         typed errors
```

The hosted entry, [`src/http/`](../src/http/), serves the same server over Streamable HTTP ([hosting.md](hosting.md)).

Three principles shape the code:

- **The core does the work.** The MCP layer validates input, calls the core and returns the result as JSON. An app that embeds `med-research-mcp/core` gets the same behavior as an MCP client.
- **Search makes no LLM calls.** Labels come from database metadata. Reading abstracts, appraising studies and classifying unlabeled papers is the calling model's job, guided by the [skills](../skills/).
- **A label claims only what the metadata establishes.** When the metadata is silent, the answer is `unknown` and `null`, never a guess.

## Life of a search

What `literature_search` (core: `searchLiterature` in [`literature.ts`](../src/core/literature.ts)) does with a request:

1. **Validate.** zod checks the arguments: `database` must name known databases and the query mustn't be empty. The core checks again, for library callers, and refuses dates that don't exist (`2020-13`, which PubMed would silently ignore) and a `from` after `to`, with `INVALID_INPUT`. `maxResults` is clamped to 1–50 per database.
2. **Pick the adapters.** `database` defaults to `pubmed`, and `"all"` selects every adapter; ids are read case-insensitively, and an unknown one raises `INVALID_INPUT`, so a typo can't look like a search that found nothing. The server substitutes a PubMed adapter bound to its shared `NcbiClient`, so all tool calls go through one rate limiter.
3. **Fan out.** The adapters run in parallel. `search` returns ids and a hit count, then `fetch` turns the first `maxResults` ids into records. With a design filter (`studyTypes`, `minDesignTier`), PubMed and Europe PMC are asked only for records carrying a publication type the filter can keep ([`designPublicationTypes`](../src/core/grader.ts), derived from the same tag lists as the classifier, so every record the filter keeps carries one), and the databases without design metadata, ChinaXiv and RussiaRxiv, aren't searched, with a warning. A filter only on designs metadata never assigns (`cohort`, …) searches nothing and says so. When a database fails (a network error, a rate limit, a query too broad for PubMed), its failure becomes a warning (`"<database> search failed: …"`, with the error's actionable message) and the other databases still return results. When every database searched fails, the search throws the first error instead: an outage must never look like an empty result, which a model could read as "no studies exist".
4. **Classify.** Each record goes through `classifyArticle` ([next section](#the-grader-study-design-labels)), which adds `studyType`, `designTier` and `flags`. MeSH headings feed the classification and are then removed from search results to keep them compact.
5. **De-duplicate by DOI.** DOIs are normalized (URL and `doi:` prefixes removed, compared case-insensitively). One record per DOI survives: the higher-ranked copy, placed where the DOI first appeared. It also takes the other copies' `retracted`, `expression-of-concern`, `corrected` and `updated` flags, since those describe the paper, not one database's record; a merged `retracted` sets its tier to 0. Records without a DOI are all kept, unless the same database returned the same id twice (the `chinaxiv` adapter with `language: "ru"` and the `russiarxiv` adapter search the same corpus).
6. **Filter.** `minDesignTier` drops records below the given tier. A `null` tier counts as below any minimum; how many records were dropped that way is reported in a warning. `studyTypes` keeps only the listed types. This is the exact check the narrowed query in step 3 only approximates: a record tagged both `Randomized Controlled Trial` and `Observational Study` classifies as observational. Filtering runs after de-duplication, so a retracted copy the filter would drop still passes its flag to the copy that is kept.
7. **Sort.** A stable sort by [rank](#ranking): tiers 5 to 2, then unknown tiers, then tiers 1 and 0. Records of equal rank keep their database's order (relevance or date), with databases in the order they were requested.
8. **Return** `{ articles, total, query, warnings? }`, where `total` sums the hit counts each database reported before truncation (for the narrowed query, with a design filter).

### The databases

| | `pubmed` | `europepmc` | `chinaxiv` | `russiarxiv` |
| --- | --- | --- | --- | --- |
| API | NCBI E-utilities | Europe PMC REST | ChinaRxiv API, `source=chinaxiv` | ChinaRxiv API, `source=russiarxiv` |
| Query | PubMed syntax, including field tags | plain text, PubMed field tags removed | plain text, field tags removed | plain text, field tags removed |
| `dateRange` | publication date | `FIRST_PDATE` | `from_date` / `to_date` | `from_date` / `to_date` |

Dates may be given as `YYYY-MM-DD`, `YYYY-MM` or `YYYY`; for Europe PMC and ChinaRxiv, which need full dates, a year or month becomes its first or last day.
| `sort: "date"` | ✓ | ✓ | ignored | ignored |
| Design metadata | publication types, MeSH, correction links | the same, for MEDLINE records | none | none |
| Text provenance | authors' | authors' | mostly machine-translated | machine-translated; abstracts mostly machine-written |

`language` is read only by the `chinaxiv` adapter, where `"ru"` switches the search to the RussiaRxiv corpus.

- **PubMed** makes three E-utilities calls: `esearch` for the PMIDs, `esummary` for the bibliographic record, and `efetch` (XML) for the abstract, MeSH headings and CommentsCorrections links that `esummary` lacks. `efetch`'s publication types replace `esummary`'s when it has any. A fresh summary is cached only after `efetch` succeeds for it, so a failed `efetch` can't leave a record cached without its retraction links. A query matching more than 100,000 records is refused with `QUERY_TOO_BROAD`. A design filter adds `AND ("Randomized Controlled Trial"[pt] OR …)` to the term. PubMed's relevance ranking varies between identical requests (five identical searches returned five different top-20 lists, 2026-10-20), so the client reuses a search's PMIDs for an hour (`searchTtlMs`): a repeated search returns the same papers. `esummary` also gives the record's PMCID, which `literature_fulltext` uses.
- **Europe PMC** returns complete records (abstract, publication types, MeSH, correction links) from a single `resultType=core` search request. MEDLINE records keep their PMID as id. Numeric ids from other sources would collide with PMIDs, so they get a source prefix, e.g. `CBA:521529` (Chinese Biological Abstracts); `PPR…` preprint and `PMC…` ids stay as they are. Europe PMC's correction link names are mapped to PubMed's (`RetractionIn`, …), so these records classify exactly like PubMed's. In `core` results the journal is `journalInfo.journal.title` (a preprint's server is `bookOrReportDetails.publisher`), and the date is the issue date (`journalInfo.dateOfPublication`, e.g. "2026 Sep"), else the first publication date: records added to PMC recently have no `pubYear`. A design filter adds `AND (PUB_TYPE:"…" OR …)`.
- **ChinaXiv and RussiaRxiv** come from the [ChinaRxiv API](https://chinarxiv.org/api/docs), an independent project, not ChinaXiv (the Chinese Academy of Sciences preprint platform, which publishes no API). One API serves both corpora, so every request sets `source`; without it, a `chinaxiv` search would mix in RussiaRxiv records and count them in `total`. Titles and abstracts are ChinaRxiv's English versions: "most records are machine-translated" (chinarxiv.org), and almost every RussiaRxiv abstract was written by ChinaRxiv rather than the authors (351 of 357 sampled search results, 2026-10-19). The adapter keeps both facts as `machineTranslated` (any original not detected as English) and `machineGeneratedAbstract`, which become [flags](#step-2-the-flags), and links the English page as `url` and the original record (ChinaXiv, Math-Net.Ru, …) as `originalUrl`. Search results carry abstracts cut at 500 characters; `literature_fetch` loads the complete record from `/papers/{id}`, by exact id. The records have no publication types, so they are always `unknown`, and no DOI, so DOI de-duplication and `literature_fulltext` don't apply to them. The API returns only records that contain every word of the query, in any order, and treats `AND` and `OR` as words ("gut microbiota", "microbiota gut" and "gut OR microbiota" each match 55 ChinaXiv records; "vitamin" 87, "depression" 229, "vitamin depression" none; 2026-10-20), so an empty result for a query of several words comes with a warning to use fewer words.

The REST adapters (all but PubMed) keep the records they parse during `search` in a per-process memo of up to 1,000 entries, so the `fetch` that follows doesn't make a second request. They also write records through to the cache under `<database>:<id>`.

**Adding a database** takes one file in [`src/core/adapters/`](../src/core/adapters/) that implements `DatabaseAdapter` (or extends `RestAdapter`), one line in [`registry.ts`](../src/core/adapters/registry.ts), and its id in the `DATABASES` list in [`src/mcp/server.ts`](../src/mcp/server.ts), which feeds the tool descriptions. An adapter never classifies, merges or knows about other databases; `literature.ts` does that.

## The grader: study-design labels

[`src/core/grader.ts`](../src/core/grader.ts) gives every search result a `studyType`, a `designTier` and, when any apply, `flags`. Its only inputs are database metadata:

- **NLM PublicationType tags** (PubMed, and Europe PMC, which mirrors them), for the design and most flags.
- **CommentsCorrections links** (retraction, expression of concern, erratum, newer version), for flags.
- **The MeSH check tags `Animals` and `Humans`**, for one warning.
- **The title**, only to catch a publisher's `RETRACTED` prefix.
- **ChinaRxiv's `source_language` and `abstract_source` fields**, for two warnings about a record's text.

No keyword or regex rule reads the title or abstract to guess a design. A record without publication types is `unknown`. That's common for recent papers, journals outside MEDLINE, and ChinaXiv / RussiaRxiv. Unknown means unlabeled, not weak: the model reads the design from the abstract, as the [`med-research`](../skills/med-research/SKILL.md) skill instructs.

Every mapping in `grader.ts` cites its source; the list is at the [end of this section](#sources).

### Step 1: the design

`studyType` comes from NLM's publication types, following NLM's own definitions in [MeSH](https://id.nlm.nih.gov/mesh/). The tags are checked in this order, and the first match decides:

1. Veterinary tags (`Clinical Trial, Veterinary`, `Randomized Controlled Trial, Veterinary`, `Observational Study, Veterinary`) → `animal-study`.
2. `Network Meta-Analysis` → `meta-analysis`, tier 5.
3. `Meta-Analysis` → `meta-analysis`, tier `null`.
4. `Systematic Review` → `systematic-review`, tier `null`.
5. Primary designs. Each matching tag adds a candidate, and when there are several, the one with the lowest tier wins:
   - `Case Reports` → `case-report`
   - `Observational Study` → `observational`
   - `Randomized Controlled Trial` or `Equivalence Trial` → `randomized-controlled-trial`; otherwise `Controlled Clinical Trial` → `non-randomized-trial`; otherwise any other trial type → `clinical-trial`
6. `Review` or `Scoping Review` → `review`.
7. None of these → `unknown`.

A synthesis is labeled as a synthesis even when it also carries the tags of the designs it pooled. Why each label is assigned the way it is:

- `Randomized Controlled Trial` and `Equivalence Trial` (a child of RCT in the MeSH tree) → `randomized-controlled-trial`.
- `Controlled Clinical Trial` → `non-randomized-trial`. NLM defines it as controlled and tags randomized trials as RCT instead; its controls may be historical.
- `Clinical Trial`, phases I–IV, `Adaptive`, `Pragmatic` (moved under Clinical Trial in MeSH 2026) and `Human Challenge Trials` → `clinical-trial`: randomization and control aren't indexed.
- `Observational Study` → `observational`. MeSH design headings ("Cohort Studies", "Prospective Studies"…) are **not** used to narrow it or to classify untagged records: sampled 2023 records showed them applied to diagnostic, intervention and ecological studies too.
- `Meta-Analysis`, `Network Meta-Analysis` → `meta-analysis`; `Systematic Review` → `systematic-review`; `Case Reports` → `case-report`; `Review`, `Scoping Review` → `review`; veterinary tags → `animal-study`.
- Conflicting primary tags (e.g. RCT plus Observational Study, mostly observational analyses of trial cohorts) take the lower design.

### Step 2: the flags

**`flags`** come from publication types, the CommentsCorrections links in PubMed and Europe PMC records, MeSH check tags, and ChinaRxiv's provenance fields.

| Flag | Source | Effect |
| --- | --- | --- |
| `retracted` | `Retracted Publication` tag, a `RetractionIn` link, or a publisher title prefix (`RETRACTED:`, `RETRACTED ARTICLE:`, `[Retracted]`; not on notices) | tier 0 |
| `notice` | `Retraction Notice` (named "Retraction of Publication" before 2025), `Expression of Concern`, `Published Erratum`: a notice, not a study | tier 0 |
| `protocol` | `Clinical Trial Protocol` | tier 0 |
| `editorial` | `Editorial`, `Comment` | tier 0 |
| `expression-of-concern` | an `ExpressionOfConcernIn` link (the article itself is never tagged) | warning |
| `corrected` | an `ErratumIn` link | warning |
| `updated` | an `UpdateIn` link: a newer version exists, e.g. an updated Cochrane review | warning |
| `animals-not-humans` | MeSH `Animals` without `Humans`. Only a warning: automated indexing drops `Humans` from human trials often enough that this filter wrongly excluded human RCTs 7× as often as under manual indexing ([Askin 2025](https://pubmed.ncbi.nlm.nih.gov/39975499/)) | warning |
| `preprint`, `letter` | `Preprint`, `Letter` (letters include research letters) | warning |
| `machine-translated` | A ChinaXiv or RussiaRxiv record whose original ChinaRxiv didn't detect as English: the title and abstract are a machine translation. Check `originalUrl` before quoting a dose, population or outcome | warning |
| `machine-generated-abstract` | ChinaRxiv's `abstract_source: "machine_generated"`: the abstract is ChinaRxiv's summary, not the authors' (almost all RussiaRxiv records) | warning |

### Step 3: the tier

1. A record flagged `retracted`, `notice`, `protocol` or `editorial` is not usable as evidence: its tier is 0, whatever its design.
2. Otherwise the tier comes from the table below, except for syntheses, which got their tier in step 1.
3. `unknown` has tier `null`.

**`designTier`** ranks the design for "Does this intervention help?" by the [OCEBM 2011 Levels of Evidence](https://www.cebm.ox.ac.uk/resources/levels-of-evidence/ocebm-levels-of-evidence): level 1 → 5, level 2 → 4, level 3 → 3, level 4 → 2, below level 4 → 1, non-human → 0.

| `studyType` | `designTier` | Basis (OCEBM 2011, treatment benefits) |
| --- | --- | --- |
| `meta-analysis`, `systematic-review` | 5 **only if it pooled randomized trials**; otherwise `null` | Level 1 is a systematic review *of randomized trials*. A review ranks with what it pooled, and MeSH rarely shows that: in 2022, 77% of reviews/meta-analyses carried no heading for it. Only `Network Meta-Analysis`, defined as pooling randomized trials, gets 5 |
| `randomized-controlled-trial` | 4 | Level 2. NLM also applies the tag to secondary analyses of trial data |
| `cohort` | 3 | Level 3 (non-randomized controlled cohort) |
| `non-randomized-trial`, `clinical-trial`, `observational`, `case-control`, `cross-sectional` | 2 | Level 4 or a label spanning levels 3–4 (historical controls, single-arm trials, unspecified observational design) |
| `case-report`, `review` | 1 | Below level 4: a single case, or a review not indexed as systematic (16% of 2023 papers titled "systematic review" carry only `Review`) |
| `animal-study`, `in-vitro` | 0 | Non-human: at most mechanism-based reasoning (level 5) for human questions |
| `unknown` | `null` | **Unrated, not weak.** When `minDesignTier` drops these, a warning reports how many |

Two rules keep the tiers conservative:

- **When a label's NLM definition admits designs at different levels, the lower level is used.** `Controlled Clinical Trial` allows historical controls (level 4), so it ranks 2 rather than 3.
- **A systematic review has no level of its own; it ranks with the studies it pooled.** Metadata rarely shows what was pooled, so a synthesis ranks 5 only when its publication type is defined as pooling randomized trials, and `null` otherwise.

`cohort`, `case-control`, `cross-sectional` and `in-vitro` are never assigned from metadata; they exist for designs the model reads from an abstract.

### Ranking

Search results are sorted by `designTier`, with `null` ranked as 1.5 ([`rankKey`](../src/core/grader.ts)). Known tiers 2–5 come first. Unknown tiers come next, because an unlabeled record or an unrated meta-analysis may well be strong and needs reading. Case reports, narrative reviews, non-human and non-evidence records come last. The same rank decides which copy survives DOI de-duplication (it keeps the other copies' retraction and correction flags).

### Examples

What `classifyDesign` returns for some typical metadata:

| Metadata | `studyType` | `designTier` | `flags` |
| --- | --- | --- | --- |
| `Journal Article`, `Randomized Controlled Trial` | `randomized-controlled-trial` | 4 | |
| `Meta-Analysis`, `Systematic Review` | `meta-analysis` | `null` | |
| `Network Meta-Analysis`, `Systematic Review` | `meta-analysis` | 5 | |
| `Randomized Controlled Trial`, `Observational Study` | `observational` | 2 | |
| `Case Reports`, `Review` | `case-report` | 1 | |
| `Randomized Controlled Trial`, `Retracted Publication` | `randomized-controlled-trial` | 0 | `retracted` |
| `Randomized Controlled Trial` plus an `ErratumIn` link | `randomized-controlled-trial` | 4 | `corrected` |
| `Clinical Trial Protocol` | `unknown` | 0 | `protocol` |
| `Journal Article`, MeSH `Animals`, `Mice` | `unknown` | `null` | `animals-not-humans` |
| A ChinaXiv record translated from Chinese (no publication types) | `unknown` | `null` | `machine-translated` |
| A RussiaRxiv record | `unknown` | `null` | `machine-translated`, `machine-generated-abstract` |

### What the labels are not

- **Not hand-curated.** These are NLM's labels, but since 2022 NLM indexes MEDLINE automatically (MTIA, then the neural MTIX), curating selected records by hand, and has been bringing publication types into that automation ([NLM 2021](https://www.nlm.nih.gov/pubs/techbull/nd21/nd21_medline_2022.html), [NLM 2024](https://www.nlm.nih.gov/pubs/techbull/ma24/ma24_mtix.html)). Treat a label as a strong prior to confirm when it matters.
- **Not an appraisal.** `designTier` ranks the design; it doesn't appraise the study. Risk of bias, imprecision, inconsistency, indirectness and publication bias need the paper ([GRADE](https://pubmed.ncbi.nlm.nih.gov/21208779/)), and the [`med-research-ebm`](../skills/med-research-ebm/SKILL.md) skill covers them.
- **Only for treatment questions.** Prognosis, diagnosis and harms questions rank designs differently (OCEBM).

### Changing the grader

- Cite a source for every mapping, in the code comment. Check NLM definitions against the current MeSH JSON record (`https://id.nlm.nih.gov/mesh/<UI>.json`), and measure any rule on real PubMed records before relying on it.
- Prefer the conservative choice: the lower tier, or `null` when unsure.
- Add a case to [`tests/grader.test.ts`](../tests/grader.test.ts).
- If tiers change, bump `SCORER_VERSION` in [`benchmark/lib/scoring/score.ts`](../benchmark/lib/scoring/score.ts) so `--rescore` re-grades stored benchmark runs instead of reusing their embedded scores.

### Sources

As listed in `grader.ts`, all checked 2026-10-17:

- **[OCEBM]** OCEBM Levels of Evidence Working Group. "The Oxford 2011 Levels of Evidence". Oxford Centre for Evidence-Based Medicine. <https://www.cebm.ox.ac.uk/resources/levels-of-evidence/ocebm-levels-of-evidence>
- **[OCEBM-intro]** Howick J, et al. "The 2011 Oxford CEBM Levels of Evidence (Introductory Document)". Same URL. The levels are "NOT intended to provide you with a definitive judgment about the quality of evidence".
- **[GRADE-3]** Balshem H, et al. GRADE guidelines: 3. Rating the quality of evidence. *J Clin Epidemiol* 2011;64:401-6. [PMID 21208779](https://pubmed.ncbi.nlm.nih.gov/21208779/).
- **[GRADE-8]** Guyatt GH, et al. GRADE guidelines: 8. Rating the quality of evidence — indirectness. *J Clin Epidemiol* 2011;64:1303-10. [PMID 21802903](https://pubmed.ncbi.nlm.nih.gov/21802903/).
- **[MeSH]** NLM MeSH publication-type records (definition, tree position, history), `https://id.nlm.nih.gov/mesh/<UI>.json`. The UIs are cited inline in `grader.ts`.
- **[NLM-XML]** NLM, MEDLINE/PubMed XML element descriptions, CommentsCorrections. [Archived copy](https://wayback.archive-it.org/org-350/20240220194809/https://www.nlm.nih.gov/bsd/licensee/elements_descriptions.html).
- **[NLM-2021]** NLM Technical Bulletin 2021 Nov–Dec, "MEDLINE 2022 Initiative: Transition to Automated Indexing". <https://www.nlm.nih.gov/pubs/techbull/nd21/nd21_medline_2022.html>
- **[NLM-2024]** NLM Technical Bulletin 2024 Mar–Apr, "MTIX: the Next-Generation Algorithm for Automated Indexing of MEDLINE". <https://www.nlm.nih.gov/pubs/techbull/ma24/ma24_mtix.html>
- **[Askin-2025]** Askin N, et al. Filtering failure: the impact of automated indexing in Medline on retrieval of human studies for knowledge synthesis. *J Med Libr Assoc* 2025. doi:10.5195/jmla.2025.1972. [PMID 39975499](https://pubmed.ncbi.nlm.nih.gov/39975499/).

The PubMed counts quoted above (77%, 16%) were measured on PubMed by the project and are documented next to the rules they support in `grader.ts`.

## Fetch and full text

### `literature_fetch`

Pure data: it returns the stored records, with publication types, MeSH headings and correction links, and doesn't classify them. Records come back in the order requested, and ids that couldn't be fetched are listed in `missing`.

- **PubMed** runs `esummary` and `efetch`, as in search.
- **Europe PMC** looks an id up by `EXT_ID` and `SRC` and accepts only an exact match. A bare number would run a full-text search and return unrelated papers.
- **ChinaXiv and RussiaRxiv** load the complete record from `/papers/{id}` and accept only an exact id match, since search results carry abstracts cut at 500 characters. If that request fails, they return the preview from an earlier search.

### `literature_fulltext`

[`fulltext.ts`](../src/core/fulltext.ts) needs a numeric PMID, a PMCID or Europe PMC preprint id, or a DOI. DOI-based resolution works for any database whose records carry DOIs; ChinaXiv and RussiaRxiv records have none, so for them the tool returns `NOT_FOUND` with a message pointing to the record's `url`.

1. **Cache.** An open-access full text resolved in the last 30 days is returned immediately.
2. **Find the DOI and PMCID**: from the arguments, a cached record (`literature_search` caches PubMed records with their PMCID), or a fresh `esummary` call.
3. **Try each source in order**, stopping at the first that yields text:
   1. **Europe PMC**, when there is a PMCID (or the id is a `PMC…` or `PPR…` id): its full-text API, `/{PMCID}/fullTextXML`. It serves Europe PMC's open-access subset, needs no email, and its JATS XML keeps tables, which publisher pages often move to separate pages. It is tried first because it's the most complete open-access copy, and the only one the PMC and Europe PMC terms allow fetching automatically (see Unpaywall below).
   2. **Unpaywall**: every open-access location it knows for the DOI, the direct PDF link first, then the landing page. It needs a contact email: `MED_RESEARCH_UNPAYWALL_EMAIL`, else `NCBI_EMAIL`, else the project's contact address. `MED_RESEARCH_UNPAYWALL=0` turns the lookup off, so no DOI goes to Unpaywall. A client reuses each answer for a day (the MCP server shares one client between all tool calls); a failed lookup isn't reused. PubMed Central and Europe PMC allow automated downloading only through their APIs and bulk services, not their websites ([PMC](https://pmc.ncbi.nlm.nih.gov/about/copyright/), [Europe PMC](https://europepmc.org/Copyright)), so a location on either site is fetched from Europe PMC's full-text API by its PMCID or preprint id (`/{PMCID}/fullTextXML`; Unpaywall usually writes PMC links as `…/pmc/articles/<number>`), or, without one, skipped. The JATS XML becomes markdown: section headings, paragraphs, lists, tables row by row, one form per formula, figure captions, and the OCR text of scanned articles. An article whose body holds less than 500 characters, typically one Europe PMC has only as an abstract, doesn't count as full text.
   3. **Institutional proxy**: `MED_RESEARCH_PROXY_PREFIX` followed by the DOI, if configured. The request carries no browser cookies, so it works only where the proxy admits the machine without a login (EZproxy's `AutoLoginIP`, typically on the campus network or VPN).
   4. **Direct**: `https://doi.org/<DOI>`, which works for open-access articles and on networks with IP-based access.
4. **Fall back** to the abstract, with `source: "none"` and a warning that says what each source answered and what to do: Unpaywall knows no open-access copy or couldn't be asked (an HTTP error, a timeout, turned off), the publisher refused access (HTTP 401–403: paywalled, or blocking automated clients), its page held only the abstract, doi.org doesn't know the DOI, an address was refused, and so on. A DOI doi.org doesn't know (404) returns `NOT_FOUND` when there's no abstract to fall back on.

Each URL is fetched with a 20-second timeout by [`fetchPublic`](../src/core/public-fetch.ts). These URLs come from Unpaywall and from whoever registered the DOI, so it refuses any address that isn't publicly routable: loopback, private, link-local (including the cloud metadata endpoints `169.254.169.254` and `100.100.100.200`), CGNAT and reserved ranges. It checks IP-literal hosts before connecting and host names when the connection is made, so DNS rebinding can't slip past the check, follows at most 10 redirects (checking each hop), allows only `http:` and `https:`, and refuses bodies over 30 MB. A refused URL counts as "no text here" and the next one is tried; if the result falls back to the abstract, the warning mentions the refusal, because a fake-IP DNS proxy (Clash, Surge or sing-box in TUN mode) makes every host name resolve to a reserved address. `MED_RESEARCH_FULLTEXT_ALLOW_PRIVATE=1` turns the address check off, for personal machines only. The `Content-Type` header decides how a response is read, because publishers often serve an HTML paywall page from a `…/pdf` URL. HTML is reduced to the article body with [Readability](https://github.com/mozilla/readability) and converted to markdown with [turndown](https://github.com/mixmark-io/turndown); PDFs are converted to plain text with pdf-parse (`format: "pdf"`). A result shorter than 500 characters is treated as a paywall stub, and the next URL is tried.

A web page must also hold the article, not just its landing page. A paywalled article's page shows the title, the abstract and often the keywords and reference list, which together pass any plain length check; arXiv's abstract page converted to 2,357 characters and came back as `source: "direct"` before this check (2026-10-20). So the markdown is split at its headings: sections that are never the article ("Similar content being viewed by others", "Cited by", recommended articles) are dropped from the text, and the abstract (an "Abstract" or "Summary" section, or a paragraph starting "Abstract:") and front and back matter (references, keywords, highlights, author information, …) are kept but not counted. The rest must reach 2,000 characters, about 300 words. When the page labels no abstract, the known abstract's length is taken off; an "Abstract" section longer than 3,000 characters is taken to hold the body nested under it. A very short article can fail this check; the warning then says the page "showed little beyond the abstract", and `https://doi.org/<DOI>` is the place to check.

Only open-access (Europe PMC and Unpaywall) texts are cached: a text from the proxy or direct route may be licensed to this user alone, and the cache may be persistent or, on a hosted instance, shared. The cache stores the full, untruncated text. The returned text is capped at `MED_RESEARCH_FULLTEXT_MAX_CHARS` (default 50,000), with `truncated: true` when it was cut.

## Rate limits, errors and caching

**Rate limits.** Each `NcbiClient` queues its requests and spaces them to 3 per second, or 10 with `NCBI_API_KEY`, with a 20% margin: NCBI counts requests as they arrive, and arrival times jitter, so spaced exactly 1/3 s apart, 2 of 15 serialized requests drew a 429, and 400 ms apart, 1 of 15 (2026-10-20). A 429 is waited out (NCBI's `Retry-After`, 2 s) and retried up to twice, holding back the queue meanwhile, before `RATE_LIMIT` reaches the caller. The MCP server shares one client between all tools, so concurrent tool calls stay within NCBI's limit. The Europe PMC and ChinaRxiv adapters retry a 429 the same way when `Retry-After` is 5 seconds or less. Requests carry `NCBI_EMAIL`, or without it the project's contact address, as NCBI's usage policy asks. Every upstream request times out after 15 seconds (20 for full-text pages).

**Errors.** Library functions throw `ResearchApiException` with a code (`RATE_LIMIT`, `QUERY_TOO_BROAD`, `PARSE_FAILURE`, `NETWORK_ERROR`, `NOT_FOUND`, `INVALID_INPUT`), a message for logs, a `userMessage` for the agent, and whether it is `recoverable`. An HTTP 429 that retries don't clear becomes `RATE_LIMIT` with the server's `Retry-After`, naming the database that sent it. The MCP tools return these as `isError` results. A multi-database search is the exception while at least one database answers: each failing database becomes a warning, not an error.

**Caching.** The cache holds three stores, each with its own lifetime:

| Store | Expires after | Why |
| --- | --- | --- |
| Summaries (metadata) | 7 days | Metadata changes after publication: indexing adds publication types and MeSH, and retractions, expressions of concern and errata arrive at any time. A cached record must not hide a retraction for long |
| Abstracts | never | Abstracts don't change |
| Open-access full texts | 30 days | The paper is stable, but resolved open-access URLs rot. Proxy and direct texts are never cached |

Apart from these, each `NcbiClient` keeps PubMed search results (PMIDs and count) in memory for an hour, so a repeated search returns the same papers (see [The databases](#the-databases)).

The `memory` backend is an LRU of 200 entries per store that dies with the process. The `sqlite` backend persists to a WAL-mode database and loads its native binding (`better-sqlite3`, an optional dependency) lazily; if the binding is missing or fails to load, the server logs a warning and uses memory instead.

## The benchmark: grading answers

The [benchmark](../benchmark/) measures whether the MCP helps a model give accurate, well-cited answers to biomedical questions. It runs 32 queries across 7 categories against one or more conditions: `mcp` (the real server, in-process), `mcp-skill` (the same plus the `med-research` skill in the system prompt), and optional `closed-book` and `web-search` baselines. [`benchmark/README.md`](../benchmark/README.md) has the full details; this is how an answer gets its score.

**1. Citations are checked, never trusted.** Every cited PMID is fetched from live PubMed; DOIs and PMCIDs are resolved to PMIDs first, and Europe PMC and ChinaXiv ids are looked up in their own database. A PMID that doesn't resolve is a **fabrication**. One that does is classified by the same `classifyArticle` the MCP uses, so **evidence quality** is the mean `designTier` of the valid citations, leaving out unrated ones. A transient NCBI failure becomes a `scoring-error`, never a fabrication.

**2. Misattribution is audited.** A real paper cited for something it doesn't say passes the fabrication check, so [`attribution.ts`](../benchmark/lib/scoring/attribution.ts) compares the text around each citation with the record: topic, year, author, claimed design, and figures against the abstract. It flags only clear contradictions and is reported next to the composite, not in it.

**3. Accuracy depends on the query's answer key:**

| Key | Queries | How it is graded |
| --- | --- | --- |
| `values` | 13 | The model ends with an `ANSWER — field: value \| …` line, and each field is compared with the key. Fully automated |
| `reject` | 4 | The query asks about a study that doesn't exist. Full marks only for saying so about that study, while citing no non-existent PMID |
| `rubric` | 15 | Open-ended. Until a human grades it, accuracy is a provisional proxy (citation tier × 2) that must not be quoted as accuracy |

**4. Rubric answers are graded by people.** [`grade.ts`](../benchmark/grade.ts) shows each answer blind (prompt, rubric, answer and the cited records, but not the condition, model, run or proxy score) in a seeded random order. Grades go to `overrides.json`, and `run.ts --rescore` applies them. Several graders can grade the same run; their grades are averaged, and `--agreement` reports Krippendorff's α and ICC.

**5. The LLM judge gives a second opinion.** [`judge.ts`](../benchmark/judge.ts) grades the same blind view plus the abstracts of the cited PubMed records, against the rubric. Its grades go to `judge-<model>.json` and a report, `judge-<model>.md`, which compares conditions (including mcp-skill vs mcp). They are never written to `overrides.json`, so they never count as human grades. A judge can be wrong about medicine and may not know recent papers, so spot-check it by hand.

**6. The composite** (0–10) weighs accuracy 40%, evidence quality 25%, citation integrity 25%, speed 5% and token cost 5%. A bullshit query scores only on whether the model rejected the fabricated study.

One caveat matters when reading the results: the MCP condition sees the same design labels the scorer uses, which gives it a structural advantage on the evidence term. See [Validity and limitations](../benchmark/README.md#validity-and-limitations) before citing any number.
