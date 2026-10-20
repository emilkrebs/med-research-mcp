# Changelog

## 0.6.0 (unreleased)

The first public release. Earlier versions were never published; the git history has their changes.

What the server does: three MCP tools (`literature_search`, `literature_fetch`, `literature_fulltext`) over PubMed, Europe PMC, ChinaXiv and RussiaRxiv, study-design labels from NLM metadata, full-text resolution, an in-memory or SQLite cache, a stdio server, a Streamable HTTP server for self-hosting, a `.mcpb` bundle for Claude Desktop, and three agent skills.

Changes since 0.5.0:

### Security

- `literature_fulltext` no longer fetches from loopback, private, link-local, CGNAT or reserved addresses. The URLs it follows come from Unpaywall and from DOI registrants; on a hosted deployment, a DOI redirecting to a cloud metadata endpoint could otherwise have exposed credentials. Every redirect is checked, host names are checked at connect time (no DNS rebinding), and bodies over 30 MB are refused. On a personal machine behind a fake-IP DNS proxy, `MED_RESEARCH_FULLTEXT_ALLOW_PRIVATE=1` turns the address check off, and the warning says so when it applies.

### Compliance

- Open-access copies that Unpaywall finds on PubMed Central or Europe PMC (articles and preprints) are fetched through Europe PMC's full-text API instead of their websites, whose terms forbid automated downloading. The JATS XML is converted to markdown with tables row by row, and an article Europe PMC has only as an abstract doesn't pass for full text.
- Only open-access full texts are cached. Texts from the institutional proxy or the direct DOI route may be licensed to one user, and the cache can be persistent or shared.
- The `literature_search` query description tells the model never to put details that identify a person into a query.
- The README now carries NCBI's disclaimer and copyright notice, which NCBI requires to be "evident to users", and credits Europe PMC, Unpaywall and ChinaRxiv.

### Fixed

- Parallel tool calls drew `RATE_LIMIT` errors from PubMed although requests were queued: spaced exactly at NCBI's limit, they arrive closer together after network jitter (2 of 6 parallel searches failed). Requests are now spaced with a 20% margin, and a 429 is waited out (`Retry-After`, up to 5 s, twice) while the queue holds, before `RATE_LIMIT` reaches the caller. Europe PMC and ChinaRxiv requests retry a short `Retry-After` the same way.
- `literature_fulltext` took any page over 500 characters as the full text, so a landing page showing only the abstract (arXiv's abstract page; a paywalled article's page) came back as `source: "direct"`. A page now needs 2,000 characters besides its abstract and front and back matter; sections that aren't the article ("Similar content being viewed by others", "Cited by") are removed from the text.
- Every full-text failure was reported as "paywalled", with advice to configure a proxy, including a publisher blocking automated clients and a DOI that doesn't exist. The warning now says what each source answered (Unpaywall not asked because no email is set, HTTP 403 from the publisher, a page with only the abstract, …), and a DOI doi.org doesn't know returns `NOT_FOUND` when there's no abstract either.
- `studyTypes` and `minDesignTier` filtered only the first `maxResults` records: 20 requested RCTs came back as 5, next to a `total` counting everything. PubMed (`[pt]`) and Europe PMC (`PUB_TYPE:`) are now queried for the publication types the filter can keep, and the labels are checked on every record as before; `chinaxiv` and `russiarxiv`, which have no design metadata, are skipped with a warning. An empty `studyTypes` list means no filter instead of keeping nothing.
- Unknown database ids, including `"PubMed"`, returned an empty result with a warning, or were dropped silently next to known ones. The tool schema now lists the ids and refuses others, and the library raises the new `INVALID_INPUT` error. An empty query raises it too, instead of a `PARSE_FAILURE` promising partial results, and so do dates that don't exist (`2020-13`), which PubMed ignored, and a `from` after `to`.
- Europe PMC records had an empty `journal`: it was read from a field only `lite` results have. It now comes from `journalInfo` (a preprint's server from `bookOrReportDetails`), and the date is the issue date, else the first publication date, so recently added PMC records no longer have an empty one.

- In the Claude Desktop bundle (`.mcpb`), every HTML and PDF full text failed to extract and fell back to the abstract: jsdom and pdf-parse can't be bundled. jsdom now ships beside the bundle, pdf.js's worker is inlined, and CI resolves an HTML page and a PDF through the unpacked bundle.
- With `database: "all"` and `language: "ru"`, RussiaRxiv records came back twice; repeated ids from the same database are now merged.
- `literature_search` turned every failure into a warning, even when the only database searched failed, so a rate limit or an over-broad PubMed query came back as an empty result that reads as "no studies exist". When every database it searched fails, it now returns the error (`RATE_LIMIT` with `retryAfter`, `QUERY_TOO_BROAD`, …); partial failures stay warnings, worded with the error's actionable message.
- PubMed field tags reached Europe PMC and ChinaRxiv unchanged, where they're searched as words (Europe PMC: 16 records for `creatine AND cognition[tiab]`, 7,179 without the tag). They're now removed for those databases.
- `literature_fetch` on `europepmc` with a `PMC…` id returned the record but also listed the id as missing; records now carry `pmcid`.
- With `MED_RESEARCH_TRUST_PROXY=1`, the HTTP server rate-limited by the first `X-Forwarded-For` entry, which the client controls behind a proxy that appends to the header. It now uses the last entry, the one the proxy added.
- `russiarxiv`: `literature_fetch` looked ids up with a text search and returned the first hit unchecked, which could be a different paper. It now uses the exact-id endpoint and returns the complete record, not the 500-character search preview.
- `chinaxiv` searches mixed RussiaRxiv records into their results and counted them in `total`; each adapter now asks for its own corpus.
- ChinaXiv and RussiaRxiv records linked a relative API path or a 404 page as their `url`; it is now the record's English page, and `originalUrl` links the original.
- An empty `MED_RESEARCH_UNPAYWALL_EMAIL` (a blank field in the `.mcpb` installer, or `=` in a `.env` file) disabled Unpaywall instead of falling back to `NCBI_EMAIL`.
- Rate-limit errors from Europe PMC and ChinaRxiv blamed PubMed and suggested `NCBI_API_KEY`; they now name the database.
- `literature_fulltext` on a DOI-less non-PubMed id reported "No PubMed article found"; it now explains that a DOI is needed, and it no longer sends such ids to NCBI.
- The full-text User-Agent reported version 0.2.0; all requests now send the package version.
- The npm package could include `dist/med-research-mcp.mcpb` (2 MB); it now ships only the built library, servers, sources and skills.
- Setting `NCBI_EMAIL` was described as avoiding throttling; NCBI uses the email to contact you before blocking an IP, and its limits are per IP. The proxy setting was said to need "an active proxy session"; the server sends no browser cookies, so it works only where the proxy admits the machine without a login.
- The skills attributed "temporality is required" to Bradford Hill, who wrote that none of his considerations is a sine qua non; called placebo responses "real" where the cited review says placebo interventions "can influence" patient-reported outcomes; and quoted OCEBM's level 1 for treatment benefit in the wording OCEBM itself flags as ambiguous. Every citation in the skills, the grader and the docs was rechecked against its primary source ([compliance.md](docs/compliance.md#verification-of-2026-10-19)).

### Added

- `literature_fulltext` reads articles with a PMCID from Europe PMC's full-text API first: open access, no email needed, and with tables, which publisher pages often keep on separate pages. It takes a PMCID or a Europe PMC preprint id as the `id`, so Europe PMC records without a DOI can be read too. PubMed records now carry `pmcid`.
- An identical PubMed search within an hour returns the same papers: PubMed's relevance ranking varies between identical requests.
- An empty ChinaXiv or RussiaRxiv result for a query of several words comes with a warning: ChinaRxiv matches only records containing every word.
- The `INVALID_INPUT` error code.

- Flags `machine-translated` and `machine-generated-abstract` on ChinaXiv and RussiaRxiv records, from ChinaRxiv's metadata: their English text is machine-translated, and almost every RussiaRxiv abstract was written by ChinaRxiv, not the authors. The records also carry `originalUrl`.
- `dateRange` now filters `chinaxiv` and `russiarxiv` searches too, and accepts `YYYY` or `YYYY-MM` as well as `YYYY-MM-DD`.

### Documentation

- The README covers setup and the essentials; parameters, the library, development and publishing moved to [`docs/`](docs/). New: [tools.md](docs/tools.md), [library.md](docs/library.md), [development.md](docs/development.md), [compliance.md](docs/compliance.md), [publishing.md](docs/publishing.md).
- Installation runs from npm (`npx -y med-research-mcp`) instead of a clone.
- The skills, tool descriptions and how-it-works now describe ChinaRxiv's machine-translated records, and the setup skill lists every environment variable.
- The skills frame results as research findings, not advice about a person: doses are reported as what studies used, and applicability is judged against the population in the question.
- [compliance.md](docs/compliance.md) records the intended use, data flows, upstream terms and the verification of the scientific content; [hosting.md](docs/hosting.md) adds a privacy-notice template for operators and security notes.
