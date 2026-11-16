# Tool reference

The three MCP tools, their parameters and what they return. For how they work inside, see [how-it-works.md](how-it-works.md); for installation, the [README](../README.md).

| Tool | What it does |
| --- | --- |
| [`literature_search`](#literature_search) | Searches one or more databases, merges and de-duplicates the results, and labels each with its study design. No LLM calls. |
| [`literature_fetch`](#literature_fetch) | Returns full metadata, the whole abstract and the design labels for specific ids. |
| [`literature_fulltext`](#literature_fulltext) | Returns an article's full text as markdown, found through its id or DOI; ChinaXiv and RussiaRxiv texts come as machine translations. |

Typical workflow: start with `literature_search`, read promising papers with `literature_fetch`, and use `literature_fulltext` when the abstract isn't enough (methods, dosage, sample sizes). All three are read-only, and refuse a parameter they don't know, so a misnamed one (`databases`, `DOI`) can't be dropped unnoticed.

## `literature_search`

| Parameter | Type | Required | Notes |
| --- | --- | --- | --- |
| `query` | `string` | yes | Search query, not empty. 2–5 keywords, not a sentence: PubMed ANDs every space-separated word, so each extra word narrows the result and a long phrase matches nothing. If a search returns 0, retry with fewer keywords before concluding that no evidence exists. An upper-case `OR` joins alternatives on `pubmed` and `europepmc`; ChinaRxiv reads it as a word (see [Databases](#databases)). PubMed field tags (`[tiab]`, `[mesh]`, `[au]`, `[pt]`) apply to `pubmed`; for other databases they're removed, since those would search them as words. On `europepmc` alone, `TITLE_ABS:word` limits one word to title and abstract (also `TITLE:`, `ABSTRACT:`) and `SRC:PPR` keeps preprints; a tag covers only the next word (`TITLE:a b` is `TITLE:a AND b`; `TITLE:(a b)` needs both in the title). PubMed reads this syntax as words, so leave it out when `pubmed` is searched too. Europe PMC matches a plain query against the full text, so papers that only mention the words match too ([how it works](how-it-works.md#the-databases)). |
| `database` | `string \| string[]` | no | `"pubmed"` (default), `"europepmc"`, `"chinaxiv"`, `"russiarxiv"`, an array of these, or `"all"`, in lower case. Any other value is refused. See [Databases](#databases). |
| `maxResults` | `number` | no | Records per database and page: with several databases, a page holds up to `maxResults` from each. Default `10`, max `50`. |
| `abstractMaxChars` | `number` | no | Cut each abstract to at most this many characters (a whole number, `0` or more), at a word boundary and ending in `…`, and set `abstractTruncated: true` on the article. `0` leaves abstracts out; the flag still says the article had one. Default: whole abstracts. A page of 10 full abstracts is roughly 20,000–30,000 characters and `600` halves it, so set one when searching several databases. `literature_fetch` returns the whole abstract. See [Result size](#result-size). |
| `page` | `number` | no | Page, an integer from `1` (default). Page n holds each database's records (n−1)·`maxResults`+1 to n·`maxResults`, in that database's own order. To read on, pass the `nextPage` of the previous result, with the same `maxResults`: another one moves where pages start, so records repeat or are skipped. A page starting past each database's 10,000th record is refused. See [Paging](#paging). |
| `minDesignTier` | `number` | no | Drop results below this design tier (`0`–`5`; `4` = RCTs). Also leaves out every record with a `null` tier (unlabeled records and most meta-analyses and systematic reviews), with a warning. Narrows the query like `studyTypes`, so those records are never fetched. |
| `studyTypes` | `string[]` | no | Keep only these study types. To keep reviews and trials, use this instead of `minDesignTier`. The filter goes into the query (see [Design filters](#design-filters)), so a page holds matching records, short only of those whose tags classify them as another type. `cohort`, `case-control`, `cross-sectional` and `in-vitro` are never assigned from metadata, so filtering on them returns nothing, with a warning. `animal-study` comes only from veterinary publication types: laboratory animal studies aren't labeled with it but flagged `animals-not-humans`, and a search that finds no `animal-study` says so. An empty list means no filter. |
| `dateRange` | `{ from?, to? }` | no | Publication date filter: `YYYY-MM-DD`, `YYYY-MM` or `YYYY` (a year or month covers all of it). `from` or `to` alone leaves the other end open. Applies to every database, and on `pubmed` and `europepmc` matches the electronic publication date too (see [Dates](#dates)). A date that doesn't exist (`2020-13`), or `from` after `to`, is refused. |
| `sort` | `"relevance" \| "date"` | no | `"relevance"` (default): each database's relevance order, re-sorted by design tier when merged. `"date"`: newest first by first publication (the earlier of `pubDate` and `epubDate`), across databases, except that ChinaXiv and RussiaRxiv ignore it (see [Paging](#paging)). PubMed has no such order, so the newest are found among a pool of its issue-date and date-added orders: at least 100 PMIDs of each, more on later pages. |
| `language` | `string` | no | ISO 639-1 hint. Only `chinaxiv` reads it: `"ru"` searches the RussiaRxiv corpus. |

Returns `{ articles, total, totalByDatabase?, query, databases, filters?, page, maxResults, nextPage?, warnings? }`:

- **`articles`**: one record per paper, sorted by design tier (or by date). Each has `pmid` (the database's own id: a PMID, all digits, for PubMed and for MEDLINE records on Europe PMC; any other id (`PPR…`, `PMC…`, `CBA:…`, `chinaxiv-…`, `ru-…`) is cited by it with the database, or by `doi` or `url`), `title`, `abstract` (with `abstractTruncated: true` when it is cut, see [Result size](#result-size)), `authors`, `journal`, `pubDate`, `epubDate` (when there is one, see [Dates](#dates)), `doi`, `publicationTypes`, `corrections` (retraction, erratum and update links), and for non-PubMed records `database`, `url` and `language`. ChinaXiv and RussiaRxiv records add `originalUrl`, the record they were translated from; ChinaRxiv returns their authors as one string, which is split into names and cleaned of affiliation markers and repeats, a comma-separated list only where no comma can be part of one name. Every record carries the [study design labels](#study-design-labels): `studyType`, `designTier` and, when any apply, `flags`. MeSH headings are left out to keep results compact; `literature_fetch` returns them.
- **`total`**: the hit counts each database reported, summed, before paging and de-duplication. With a design filter, these count the records the narrowed query matched. A record held by two databases counts twice, so `total` can exceed what the pages hold.
- **`totalByDatabase`**: `{ id: count }`, each database's own count. Only when more than one database was searched; a database that failed is left out, since its 0 would read as a count.
- **`databases`**: the ids searched, in order, including one that failed (a warning says so) and leaving out one a design filter skipped. `[]` when nothing was searched.
- **`filters`**: `{ dateRange?, studyTypes?, minDesignTier? }` as given; absent when the search gave none.
- **`page`**: the page returned.
- **`maxResults`**: the records per database the page holds (the default 10 when none was given). Ask for `nextPage` with it.
- **`nextPage`**: present when some database searched has records past this page; pass it as `page`, with the same `maxResults`, to continue. Absent on the last page.
- **`warnings`**: a database that failed while others answered (its error's message becomes a warning, and the others' results are still returned), records with no tier that `minDesignTier` leaves out, study types below `minDesignTier`, databases a design filter skipped, PubMed records returned without their abstract and retraction links because `efetch` failed, an `animal-study` filter that found none, a ChinaXiv or RussiaRxiv search that matched nothing because of its query rules (one warning naming both when both were searched), a `page` past the last result (it returns no articles), PubMed records beyond its 9,999-record limit (narrow the query), and a search that matched no record at all — unless a design filter or a failed database already explains the zero — so a zero is not mistaken for an absence of evidence. Under a `dateRange` it names the range (`No record matched the query "…" within dateRange 2020 to 2021. This is not evidence of absence: retry without the dateRange, or with fewer keywords.`); a one-word query is told to try a synonym, another spelling or another database. When every database searched fails, the tool returns the [error](#errors) instead, so a failed search never looks like an empty one.

PubMed ranks results by relevance differently from one identical request to the next (five identical searches returned five different top-20 lists, 2026-10-20). So that a repeated search returns the same papers, the server reuses a PubMed search's results for an hour.

Titles and abstracts are plain text. PubMed's and Europe PMC's markup (HTML, JATS, MathML) is removed: italics and bold keep their text, character references are decoded (`&#xb1;` → `±`, `&copy;` → `©`), a superscript of digits and signs becomes superscript characters (`10⁻³`, `kg⁻¹`, `³¹P`), subscripts become plain text (`HbA1c`), and the sections of a structured abstract start lines as `LABEL: text`.

### Result size

Whole abstracts make up most of a result: ten PubMed results for four generic queries came to 25,115–28,106 characters of JSON, 12,760–13,330 with `abstractMaxChars: 600` and 6,577–7,154 with `0`; the abstract text alone was about 2,000 characters per record (2026-11-16). `abstractMaxChars` cuts at a word boundary and the `…` counts within the limit. An abstract that fits is left alone. `abstractTruncated: true` also marks a ChinaXiv or RussiaRxiv search preview that ChinaRxiv cut at 500 characters (its search endpoint keeps 497 characters and adds `...`), and that flag is never cleared. `literature_fetch` returns the whole abstract, without the flag.

### Paging

`maxResults` caps each database's share of a page at 50, and `page` reads past it. Each page is merged, de-duplicated by DOI and sorted (by design tier, or by date) on its own, not together with earlier pages. With `sort: "date"` the newest-first order is global only for PubMed and Europe PMC: ChinaXiv and RussiaRxiv ignore `sort`, so their records come in relevance order and are sorted by date only within their page. A page past the end returns no articles and a warning (`Page N is past the last result…`), also when another database failed (`…of the databases that answered`); `page` `0` or a fraction is refused (the schema rejects it first; `INVALID_INPUT` in library calls).

Paging reaches only the first 10,000 records of a search per database: a page starting beyond them is refused with `INVALID_INPUT` (narrow the query with more specific terms, a `dateRange` or `studyTypes`), and the last page before that limit has no `nextPage`.

- **PubMed** serves only the first 9,999 records of a search (an `esearch` limit): later pages return no PubMed records and a warning to narrow the query, and the last reachable page carries that warning too. Because its relevance order differs between identical requests, the client takes PMIDs in blocks of 500 from one request and cuts pages from that cached list, extending it with `retstart` when a later page needs more. So within the one-hour cache no page repeats a record, but a record can still be skipped at a 500-record block boundary; with the search cache off (`searchTtlMs` 0), or after its one-hour TTL, pages come from separate requests and can repeat or skip records. With `sort: "date"` the pool of candidates grows geometrically as pages go deeper (up to 9,999 PMIDs of each order) and is rebuilt O(log n) times, so deep date pages cost more requests. Each PMID in the pool needs an `esummary` for its dates (about 2 s per 200), so on the HTTP server a deep date page can run out of its 30 seconds (`TIMEOUT`): the dates already fetched are kept for an hour, so retrying gets further (several tries for the deepest pages). A page past the last record is answered from the counts.
- **Europe PMC** ignores a `page` parameter; the adapter pages with `cursorMark`, remembers the cursors, and reaches a later page cold by walking cheap `idlist` requests.
- **ChinaXiv and RussiaRxiv** page with an opaque ChinaRxiv cursor. A cold later page walks from page 1 with one request per page, against ChinaRxiv's anonymous limit of 30 requests per minute.

### Dates

`pubDate` is the date the database reports, usually the journal issue's (`2019 Apr`). Many papers are published online months earlier; `epubDate` holds that date when the database has it (`2018 Sep 20` from PubMed, `2024-12-16` from Europe PMC). `dateRange` matches either: PubMed's publication date "includes both print and electronic dates of publication" ([PubMed Help](https://pubmed.ncbi.nlm.nih.gov/help/)), and Europe PMC is queried on the first publication date, the earlier of the two. So a search for 2024 can return a record with `pubDate: "2025 Jul"` and `epubDate: "2024-12-16"`.

### Design filters

`studyTypes` and `minDesignTier` are applied inside the databases that have design metadata. PubMed and Europe PMC are asked only for records carrying a publication type the filter can keep (`"Randomized Controlled Trial"[pt] OR "Equivalence Trial"[pt]` for `randomized-controlled-trial`; `PUB_TYPE:` for Europe PMC), and the [labels](#study-design-labels) are then checked on every record, so a record whose tags classify it otherwise (an RCT also tagged `Observational Study` is `observational`) is still dropped. A search for 20 RCTs on creatine and cognition returns 20 RCTs out of 34 candidates; filtering the plain top 20, as earlier versions did, found 5 (2026-10-20).

Because the query is narrowed, `minDesignTier` never sees the records with a `null` tier that it leaves out, and can't count them: "creatine supplementation" at `minDesignTier: 3` returns RCTs only, with a `total` of 796 of 3,427 records (2026-10-22). The warning says that unrated records were left out whenever `studyTypes` alone would have kept some.

`chinaxiv` and `russiarxiv` records carry no design metadata, so a design filter would drop all of them: those databases aren't searched, and a warning says so. Search them without the filter and read the abstracts.

## `literature_fetch`

| Parameter | Type | Required | Notes |
| --- | --- | --- | --- |
| `ids` | `string[]` | yes | 1–50 database-specific ids: PMIDs for `pubmed`; for `europepmc`, PMIDs, PMCIDs (the record comes back under its PMID) or prefixed ids for records outside PubMed, e.g. `CBA:644599` (Chinese Biological Abstracts) or `PPR…` preprints; for `chinaxiv` and `russiarxiv`, the ids `literature_search` returned. |
| `database` | `string` | yes | The database the ids belong to: `pubmed`, `europepmc`, `chinaxiv` or `russiarxiv`. Any other value is refused. |

Returns `{ articles, missing, warnings? }`: the records in the order requested, graded like search results ([`studyType`, `designTier` and `flags`](#study-design-labels)), with the whole abstract, publication types, MeSH headings and retraction/correction links (`pubmed` and `europepmc`; ChinaRxiv has none). ChinaXiv and RussiaRxiv records are complete here, without the `abstractTruncated` mark; search results cut their abstracts at 500 characters. `missing` lists ids that couldn't be fetched.

## `literature_fulltext`

| Parameter | Type | Required | Notes |
| --- | --- | --- | --- |
| `id` | `string` | yes | Article id as `literature_search` returns it: a PMID, a PMCID (`PMC…`, a record's `pmcid`), a Europe PMC preprint id (`PPR…`), or a ChinaXiv or RussiaRxiv id (`chinaxiv-YYYYMM.NNNNN`, `ru-YYYYMM.NNNNN`); each works on its own. Any other id (a Europe PMC `CBA:…` id, say) also needs `doi`. |
| `doi` | `string` | no | The record's DOI, `10.…` or a `https://doi.org/` link (`dx.` and `www.` too), from the `doi` field of a `literature_search` result; a `url` or `originalUrl` is not one. Required when `id` isn't one of those above: a URL there is refused with `INVALID_INPUT`, and one given with an id that resolves alone is ignored. With a PMID it saves the lookup of the DOI; a PMCID or `PPR` id without it uses the DOI Europe PMC has for the record, which opens the Unpaywall, proxy and direct steps below. |
| `offset` | `number` | no | Character position to return the text from: the previous call's `nextOffset`. Default `0`. |
| `maxChars` | `number` | no | The most characters to return. At most `MED_RESEARCH_FULLTEXT_MAX_CHARS` (default 50,000), which is also the default. |

Tries, in order: for a ChinaXiv or RussiaRxiv id, ChinaRxiv's translated text (see below); Europe PMC's full-text API, when the record has a PMCID (no email needed; tables come through row by row); the open-access copies Unpaywall knows; the institutional proxy, if configured; and the DOI directly. If none yields the article, it returns the abstract when the record has one, and no text otherwise: PubMed's for a PMID, for any other id the record's own from the database that holds it (looked up at Europe PMC by exact id when it isn't cached; ChinaRxiv's for a ChinaXiv or RussiaRxiv id). Returns `{ id, doi?, source, fulltext?, format, truncated, totalChars?, nextOffset?, warning? }`, where `source` says which route worked (`europepmc`, `unpaywall`, `proxy`, `direct`, `chinarxiv`, or `none` for the abstract fallback) and `format` is `markdown` or `pdf` (plain text extracted from a PDF).

A long text comes in parts. `totalChars` is the length of the whole text; when more follows, `truncated` is `true` and `nextOffset` says where the next part starts, so a call with `offset: nextOffset` reads on. A part ends at a paragraph break, line break or space near its limit rather than mid-word, and the parts join up to the whole text. An `offset` past the end returns `INVALID_INPUT`. Every part comes from the text the first part came from: open-access texts are cached whole, and a proxy, direct or ChinaRxiv text is kept in memory while it is read, for 30 minutes after its last part, so later parts cost no download. The abstract fallback is returned whole; with an `offset`, when the text can't be fetched again, it returns no text, so that the abstract is never taken for the next part.

A web page counts as the full text only if it holds at least 2,000 characters besides its abstract, keywords, references and similar front and back matter. A paywalled article's page shows the abstract and little else, and so does arXiv's abstract page; those fall through to the next route. Sections a publisher's page adds that aren't the article, such as "Similar content being viewed by others" or "Cited by", are removed from the text.

When it falls back, `warning` says what each route answered: no open-access copy, Unpaywall couldn't be asked (an HTTP error, a timeout, or turned off), the publisher refused access (HTTP 403, paywalled or blocking automated clients), the page held only the abstract, doi.org doesn't know the DOI, and so on, with what to do about it. A DOI that doi.org doesn't know returns `NOT_FOUND` when there's no abstract to return either.

A ChinaXiv or RussiaRxiv id gets its text from [ChinaRxiv](#databases), a third-party service (`GET /api/v1/papers/{id}/text`), as `source: "chinarxiv"`, paged with `offset` and `maxChars` like any text. It is a machine translation into English, not the authors' wording, and `warning` says so on the successful result too: *Machine translation into English by ChinaRxiv, a third-party service, not the authors' wording: check numbers and claims against the original at \<originalUrl\> before relying on them.* An English original gets no note. When ChinaRxiv has no text for the record, the result is the record's whole abstract (from `/papers/{id}`) with `source: "none"` and a warning: `ChinaRxiv has no text for this record.`, the translation note, and `ChinaRxiv wrote this abstract, not the authors.` where that applies. A call that finds nothing cached makes up to two requests to ChinaRxiv, the record and the text, with the same IP address, User-Agent and `X-API-Email` as a search. These texts are not put in the 30-day cache.

Copies that Unpaywall locates on PubMed Central or Europe PMC (articles and preprints) are fetched through Europe PMC's full-text API too, whose terms allow automated retrieval, instead of from those websites, whose terms don't. Pages are fetched only from public addresses: the tool refuses URLs and redirects that lead to loopback, private or link-local networks (such as cloud metadata endpoints), and bodies over 30 MB. When a refusal may be a fake-IP DNS proxy on the user's machine, the warning says how to allow it (`MED_RESEARCH_FULLTEXT_ALLOW_PRIVATE=1`, never on a shared server). Open-access texts (Europe PMC, Unpaywall) are cached for 30 days; texts from the proxy, direct or ChinaRxiv routes aren't cached at all. See [how-it-works.md](how-it-works.md#literature_fulltext).

**The proxy and direct routes can return licensed content.** The proxy route uses your institution's subscriptions, and so does the direct route (`https://doi.org/<DOI>`) when the machine is on a network with IP-based access. For subscription content, publisher terms often forbid use with AI tools unless your licence expressly allows it (Elsevier, for example: "You may not use Content from the Services in combination with an artificial intelligence tool … except as otherwise expressly permitted"), and they forbid systematic downloading. Configure the proxy only if your institution's licences permit this use, and don't let an agent fetch papers in bulk. The proxy works only if it lets the machine in without a login (on the campus network or VPN): the server sends no browser cookies.

## Databases

| Id | Source | Covers | Design labels |
| --- | --- | --- | --- |
| `pubmed` | NCBI E-utilities | PubMed / MEDLINE | Yes |
| `europepmc` | Europe PMC REST API | A mirror of PubMed, plus preprints (`PPR…`) and other sources such as Chinese Biological Abstracts (`CBA:…`). A plain query is matched against the full text, so papers that only mention the words match too | For MEDLINE-indexed records |
| `chinaxiv` | ChinaRxiv API (third party) | ChinaXiv preprints, machine-translated into English | No: always `unknown` |
| `russiarxiv` | ChinaRxiv API (third party) | Soviet-era papers, mostly mathematics, physics and chemistry; almost no medicine (25,456 records, machine-translated; most abstracts written by ChinaRxiv) | No: always `unknown` |

ChinaRxiv returns only records that contain every word of the query, in any order, and treats `AND` and `OR` as words: "vitamin" and "depression" each match ChinaXiv records, "vitamin depression" none. Search them with one or two key words; an empty result for a longer query comes with a warning saying so.

RussiaRxiv holds 25,456 Soviet-era records, mostly mathematics, chemistry and physics. A zero there is no sign that Russian medical research is missing: the one-word queries `sleep` matched 0 records, `rat` 2, `clinical` 11 and `water` 1,381 (ChinaRxiv API, 2026-11-16).

> **ChinaRxiv is not ChinaXiv.** [ChinaXiv](https://chinaxiv.org) is the Chinese Academy of Sciences preprint platform and does not publish a public API. `chinaxiv` and `russiarxiv` are served by [ChinaRxiv](https://chinarxiv.org), an independent project that machine-translates papers from ChinaXiv and other repositories into English (the Soviet-era papers appear on its sister site, SovietRxiv). It is not affiliated with the Chinese Academy of Sciences. Its records carry the flags `machine-translated` and, where ChinaRxiv wrote the abstract itself, `machine-generated-abstract`. Check the original record (`originalUrl`) before relying on a dose, population or outcome.

## Study design labels

Every `literature_search` result and `literature_fetch` article carries three fields, computed from database metadata only (plus a publisher's `RETRACTED:` title prefix, for the `retracted` flag), never by reading a design from the title or abstract. [How it works](how-it-works.md#the-grader-study-design-labels) has the full mapping, the reasoning and the sources.

- **`studyType`**: the design, from NLM PublicationType tags (PubMed, and Europe PMC, which mirrors them). Records without such tags are `unknown`: common for recent papers, journals outside MEDLINE, Europe PMC's preprints and `CBA:…` records, and every ChinaXiv and RussiaRxiv record. **Unknown means unlabeled, not weak.**
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

Results are sorted with tiers 2–5 first, then `null`, then tiers 1 and 0, unless `sort` is `"date"`.

Two limits matter:

- **`designTier` ranks the design; it doesn't appraise the study.** Risk of bias, imprecision, inconsistency, indirectness and publication bias need the paper ([GRADE](https://pubmed.ncbi.nlm.nih.gov/21208779/)), and prognosis, diagnosis and harms questions rank designs differently (OCEBM). The skills cover this.
- **The labels are NLM's, but not hand-curated.** Since 2022, NLM indexes MEDLINE automatically, curating selected records by hand ([NLM 2021](https://www.nlm.nih.gov/pubs/techbull/nd21/nd21_medline_2022.html), [NLM 2024](https://www.nlm.nih.gov/pubs/techbull/ma24/ma24_mtix.html)). Treat a label as a strong prior to confirm when it matters.

## Errors

A failing tool returns an `isError` result whose text holds this payload (`UNKNOWN` for unexpected errors). Parameters the schema rejects (an unknown database, an empty query, `maxResults` over 50, a `page` below 1, above 10,000 or not an integer) come back as an `isError` result with the validation message instead. `literature_search` fails only when every database it searched failed, or on input it refuses; `literature_fetch` lists ids it couldn't fetch in `missing`, and fails outright only when a PubMed request fails (unreachable, or rate-limited).

```ts
{
  code: "RATE_LIMIT" | "QUERY_TOO_BROAD" | "PARSE_FAILURE" | "NETWORK_ERROR" | "TIMEOUT" | "NOT_FOUND" | "INVALID_INPUT";
  message: string;      // human-readable, for logs
  userMessage: string;  // actionable phrasing for the agent or user
  recoverable: boolean; // whether retrying or adjusting can succeed
  retryAfter?: number;  // seconds to wait before retrying (rate limits)
}
```

| Code | When | What to do |
| --- | --- | --- |
| `RATE_LIMIT` | A database kept answering 429 after two retries, or asked for a wait over 5 seconds; the message names it | Wait `retryAfter` seconds. For PubMed, set `NCBI_API_KEY` |
| `QUERY_TOO_BROAD` | A PubMed query matched more than 100,000 records (in a multi-database search: a warning) | Add `[tiab]` or `[mesh]` terms or `AND` clauses |
| `PARSE_FAILURE`, `NETWORK_ERROR` | The database was unreachable or answered something unreadable. A server error (HTTP 500, 502, 503, 504), a timeout or a dropped connection has already been retried twice, within 20 seconds | Retry once, then report the database as unreachable |
| `TIMEOUT` | On the HTTP server, a search or fetch used up its 30 seconds: before a request could be sent, while waiting for an answer, or before a retry. Typically a deep `sort: "date"` page | Retry. A deep search page keeps the work already done, so each retry gets further, and the deepest date pages can take several. If retries stop getting further, ask for an earlier page or narrow the query |
| `NOT_FOUND` | `literature_fulltext` got an id it can't resolve (no such PMID, or an id that needs a DOI, such as `CBA:…`, without one), or a DOI doi.org doesn't know and there's no abstract to return | Check the id, or pass the `doi` of the search result |
| `INVALID_INPUT` | A date that doesn't exist, or `from` after `to`; a `page` starting past the 10,000th record of a search; a full-text `offset` past the end of the text; a `doi` that isn't one (a record's `url`, say) where the id needs one; in library calls also an unknown database, an empty query or a `page` below 1 or not a whole number (the MCP schema refuses those itself) | Correct the parameter the message names |

In a multi-database search, a database that fails while others answer becomes a warning, `<database> search failed: <message>`, not an error.
