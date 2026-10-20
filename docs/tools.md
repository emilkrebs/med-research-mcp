# Tool reference

The three MCP tools, their parameters and what they return. For how they work inside, see [how-it-works.md](how-it-works.md); for installation, the [README](../README.md).

| Tool | What it does |
| --- | --- |
| [`literature_search`](#literature_search) | Searches one or more databases, merges and de-duplicates the results, and labels each with its study design. No LLM calls. |
| [`literature_fetch`](#literature_fetch) | Returns full metadata and abstracts for specific ids. |
| [`literature_fulltext`](#literature_fulltext) | Returns an article's full text as markdown, found through its DOI. |

Typical workflow: start with `literature_search`, read promising papers with `literature_fetch`, and use `literature_fulltext` when the abstract isn't enough (methods, dosage, sample sizes). All three are read-only.

## `literature_search`

| Parameter | Type | Required | Notes |
| --- | --- | --- | --- |
| `query` | `string` | yes | Search query. PubMed field tags (`[tiab]`, `[mesh]`, `[au]`, `[pt]`) apply to `pubmed`; for other databases they're removed, since those would search them as words. |
| `database` | `string \| string[]` | no | `"pubmed"` (default), `"europepmc"`, `"chinaxiv"`, `"russiarxiv"`, an array of these, or `"all"`. See [Databases](#databases). |
| `maxResults` | `number` | no | Results per database. Default `10`, max `50`. |
| `minDesignTier` | `number` | no | Drop results below this design tier (`0`–`5`; `4` = RCTs). Also drops every result with a `null` tier (unlabeled records and most meta-analyses and systematic reviews) and reports how many in a warning. |
| `studyTypes` | `string[]` | no | Keep only these study types. To keep reviews and trials, use this instead of `minDesignTier`. `cohort`, `case-control`, `cross-sectional` and `in-vitro` are never assigned from metadata, so filtering on them returns nothing. |
| `dateRange` | `{ from?, to? }` | no | Publication date filter: `YYYY-MM-DD`, `YYYY-MM` or `YYYY` (a year or month covers all of it). Applies to every database. |
| `sort` | `"relevance" \| "date"` | no | Order within `pubmed` and `europepmc`. The merged list is always re-sorted by design tier. |
| `language` | `string` | no | ISO 639-1 hint. Only `chinaxiv` reads it: `"ru"` searches the RussiaRxiv corpus. |

Returns `{ articles, total, query, warnings? }`:

- **`articles`**: one record per paper, sorted by design tier. Each has `pmid` (the database's id: a PMID for PubMed, otherwise that database's id), `title`, `abstract`, `authors`, `journal`, `pubDate`, `doi`, `publicationTypes`, `corrections` (retraction, erratum and update links), and for non-PubMed records `database`, `url` and `language`. ChinaXiv and RussiaRxiv records add `originalUrl`, the record they were translated from. Every record carries the [study design labels](#study-design-labels): `studyType`, `designTier` and, when any apply, `flags`. MeSH headings are left out to keep results compact; `literature_fetch` returns them.
- **`total`**: the hit counts each database reported, summed, before truncation to `maxResults`.
- **`warnings`**: a database that failed while others answered (its error's message becomes a warning, and the others' results are still returned), or records dropped by `minDesignTier` for having no tier. When every database searched fails, the tool returns the [error](#errors) instead, so a failed search never looks like an empty one.

## `literature_fetch`

| Parameter | Type | Required | Notes |
| --- | --- | --- | --- |
| `ids` | `string[]` | yes | 1–50 database-specific ids: PMIDs for `pubmed`; for `europepmc`, PMIDs or prefixed ids for records outside PubMed, e.g. `CBA:521529` (Chinese Biological Abstracts) or `PPR…` preprints; for `chinaxiv` and `russiarxiv`, the ids `literature_search` returned. |
| `database` | `string` | yes | The database the ids belong to: `pubmed`, `europepmc`, `chinaxiv` or `russiarxiv`. |

Returns `{ articles, missing, warnings? }`: the raw records in the order requested, with publication types, MeSH headings and retraction/correction links, and no design labels. ChinaXiv and RussiaRxiv records are complete here; search results cut their abstracts at 500 characters. `missing` lists ids that couldn't be fetched.

## `literature_fulltext`

| Parameter | Type | Required | Notes |
| --- | --- | --- | --- |
| `id` | `string` | yes | Article id: a PMID, or another database's id. |
| `doi` | `string` | no | Required when `id` isn't a numeric PMID. Pass the `doi` from a `literature_search` result. |

Tries Unpaywall (open access), then the institutional proxy (if configured), then the DOI directly, and falls back to the abstract if the article is paywalled. Returns `{ id, doi?, source, fulltext?, format, truncated, warning? }`, where `source` says which route worked (`unpaywall`, `proxy`, `direct`, or `none` for the abstract fallback) and `format` is `markdown` or `pdf` (plain text extracted from a PDF). Texts are capped at `MED_RESEARCH_FULLTEXT_MAX_CHARS` (default 50,000 characters), with `truncated: true` when cut.

ChinaXiv and RussiaRxiv records have no DOI, so they can't be resolved; the tool says so, and their `url` links the record.

Copies that Unpaywall locates on PubMed Central or Europe PMC (articles and preprints) are fetched through Europe PMC's full-text API, whose terms allow automated retrieval, instead of from those websites, whose terms don't; their tables come through row by row. Pages are fetched only from public addresses: the tool refuses URLs and redirects that lead to loopback, private or link-local networks (such as cloud metadata endpoints), and bodies over 30 MB. When a refusal may be a fake-IP DNS proxy on the user's machine, the warning says how to allow it (`MED_RESEARCH_FULLTEXT_ALLOW_PRIVATE=1`, never on a shared server). Open-access texts are cached for 30 days; texts from the proxy or direct routes aren't cached at all. See [how-it-works.md](how-it-works.md#literature_fulltext).

**The proxy and direct routes can return licensed content.** The proxy route uses your institution's subscriptions, and so does the direct route (`https://doi.org/<DOI>`) when the machine is on a network with IP-based access. For subscription content, publisher terms often forbid use with AI tools unless your licence expressly allows it (Elsevier, for example: "You may not use Content from the Services in combination with an artificial intelligence tool … except as otherwise expressly permitted"), and they forbid systematic downloading. Configure the proxy only if your institution's licences permit this use, and don't let an agent fetch papers in bulk. The proxy works only if it lets the machine in without a login (on the campus network or VPN): the server sends no browser cookies.

## Databases

| Id | Source | Covers | Design labels |
| --- | --- | --- | --- |
| `pubmed` | NCBI E-utilities | PubMed / MEDLINE | Yes |
| `europepmc` | Europe PMC REST API | A mirror of PubMed, plus preprints and other sources such as Chinese Biological Abstracts | For MEDLINE-indexed records |
| `chinaxiv` | ChinaRxiv API (third party) | ChinaXiv preprints, machine-translated into English | No: always `unknown` |
| `russiarxiv` | ChinaRxiv API (third party) | Soviet-era and Russian papers, machine-translated; most abstracts written by ChinaRxiv | No: always `unknown` |

> **ChinaRxiv is not ChinaXiv.** [ChinaXiv](https://chinaxiv.org) is the Chinese Academy of Sciences preprint platform and does not publish a public API. `chinaxiv` and `russiarxiv` are served by [ChinaRxiv](https://chinarxiv.org), an independent project that machine-translates papers from ChinaXiv and other repositories into English (the Soviet-era papers appear on its sister site, SovietRxiv). It is not affiliated with the Chinese Academy of Sciences. Its records carry the flags `machine-translated` and, where ChinaRxiv wrote the abstract itself, `machine-generated-abstract`. Check the original record (`originalUrl`) before relying on a dose, population or outcome.

## Study design labels

Every `literature_search` result carries three fields, computed from database metadata only (plus a publisher's `RETRACTED:` title prefix, for the `retracted` flag), never by reading a design from the title or abstract. [How it works](how-it-works.md#the-grader-study-design-labels) has the full mapping, the reasoning and the sources.

- **`studyType`**: the design, from NLM PublicationType tags (PubMed, and Europe PMC, which mirrors them). Records without such tags are `unknown`: common for recent papers, journals outside MEDLINE, and every ChinaXiv and RussiaRxiv record. **Unknown means unlabeled, not weak.**
- **`designTier`**: how high the design ranks for "Does this intervention help?" by the [OCEBM 2011 Levels of Evidence](https://www.cebm.ox.ac.uk/resources/levels-of-evidence/ocebm-levels-of-evidence). When a label's definition spans levels, the lower one is used.
- **`flags`**: integrity notices and warnings.

| `designTier` | `studyType` |
| --- | --- |
| 5 | `meta-analysis`, `systematic-review`, **only if it pooled randomized trials**. Metadata rarely shows that, so only `Network Meta-Analysis` gets 5 |
| 4 | `randomized-controlled-trial` |
| 3 | `cohort` |
| 2 | `non-randomized-trial`, `clinical-trial`, `observational`, `case-control`, `cross-sectional` |
| 1 | `case-report`, `review` (not indexed as systematic) |
| 0 | `animal-study`, `in-vitro`, and any record flagged `retracted`, `notice`, `protocol` or `editorial` |
| `null` | `unknown`, and meta-analyses and systematic reviews whose pooled designs aren't indexed. **Unrated, not weak** |

`cohort`, `case-control`, `cross-sectional` and `in-vitro` are never assigned from metadata; they're labels for designs the model reads from an abstract.

| Flag | Meaning | Tier |
| --- | --- | --- |
| `retracted` | The paper was retracted | 0 |
| `notice` | A retraction notice, expression of concern or erratum: a notice, not a study | 0 |
| `protocol` | A trial protocol: planned, no results | 0 |
| `editorial` | An editorial or comment | 0 |
| `expression-of-concern` | The journal has published concerns about the paper | unchanged |
| `corrected` | An erratum exists; check the numbers you quote | unchanged |
| `updated` | A newer version exists, e.g. an updated Cochrane review | unchanged |
| `animals-not-humans` | MeSH lists animals but not humans; usually an animal study, but automated indexing sometimes drops the Humans tag | unchanged |
| `preprint` | Not peer reviewed | unchanged |
| `letter` | A letter, which may be correspondence or a short research report | unchanged |
| `machine-translated` | ChinaXiv/RussiaRxiv text machine-translated into English | unchanged |
| `machine-generated-abstract` | The abstract was written by ChinaRxiv, not the authors | unchanged |

Results are sorted with tiers 2–5 first, then `null`, then tiers 1 and 0.

Two limits matter:

- **`designTier` ranks the design; it doesn't appraise the study.** Risk of bias, imprecision, inconsistency, indirectness and publication bias need the paper ([GRADE](https://pubmed.ncbi.nlm.nih.gov/21208779/)), and prognosis, diagnosis and harms questions rank designs differently (OCEBM). The skills cover this.
- **The labels are NLM's, but not hand-curated.** Since 2022, NLM indexes MEDLINE automatically, curating selected records by hand ([NLM 2021](https://www.nlm.nih.gov/pubs/techbull/nd21/nd21_medline_2022.html), [NLM 2024](https://www.nlm.nih.gov/pubs/techbull/ma24/ma24_mtix.html)). Treat a label as a strong prior to confirm when it matters.

## Errors

A failing tool returns an `isError` result whose text holds this payload (`UNKNOWN` for unexpected errors). `literature_search` fails only when every database it searched failed; `literature_fetch` lists ids it couldn't fetch in `missing`, and fails outright only when a PubMed request fails (unreachable, or rate-limited).

```ts
{
  code: "RATE_LIMIT" | "QUERY_TOO_BROAD" | "PARSE_FAILURE" | "NETWORK_ERROR" | "NOT_FOUND";
  message: string;      // human-readable, for logs
  userMessage: string;  // actionable phrasing for the agent or user
  recoverable: boolean; // whether retrying or adjusting can succeed
  retryAfter?: number;  // seconds to wait before retrying (rate limits)
}
```

| Code | When | What to do |
| --- | --- | --- |
| `RATE_LIMIT` | A database answered 429; the message names it | Wait `retryAfter` seconds. For PubMed, set `NCBI_API_KEY` |
| `QUERY_TOO_BROAD` | A PubMed query matched more than 100,000 records (in a multi-database search: a warning) | Add `[tiab]` or `[mesh]` terms or `AND` clauses |
| `PARSE_FAILURE`, `NETWORK_ERROR` | The database was unreachable or answered something unreadable | Retry once, then report the database as unreachable |
| `NOT_FOUND` | `literature_fulltext` got an id it can't resolve (no such PMID, or a non-PubMed id without a DOI) | Check the id, or pass the DOI |

In a multi-database search, a database that fails while others answer becomes a warning, `<database> search failed: <message>`, not an error.
