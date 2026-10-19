# Changelog

## 0.6.0 (unreleased)

The first public release. Earlier versions were never published; the git history has their changes.

What the server does: three MCP tools (`literature_search`, `literature_fetch`, `literature_fulltext`) over PubMed, Europe PMC, ChinaXiv and RussiaRxiv, study-design labels from NLM metadata, full-text resolution, an in-memory or SQLite cache, a stdio server, a Streamable HTTP server for self-hosting, a `.mcpb` bundle for Claude Desktop, and three agent skills.

Changes since 0.5.0:

### Security

- `literature_fulltext` no longer fetches from loopback, private, link-local, CGNAT or reserved addresses. The URLs it follows come from Unpaywall and from DOI registrants; on a hosted deployment, a DOI redirecting to a cloud metadata endpoint could otherwise have exposed credentials. Every redirect is checked, host names are checked at connect time (no DNS rebinding), and bodies over 30 MB are refused.

### Compliance

- Open-access copies hosted by PubMed Central or Europe PMC are fetched through Europe PMC's full-text API instead of their websites, whose terms forbid automated downloading.
- Only open-access full texts are cached. Texts from the institutional proxy or the direct DOI route may be licensed to one user, and the cache can be persistent or shared.
- The `literature_search` query description tells the model never to put details that identify a person into a query.
- The README now carries NCBI's disclaimer and copyright notice, which NCBI requires to be "evident to users", and credits Europe PMC, Unpaywall and ChinaRxiv.

### Fixed

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

- Flags `machine-translated` and `machine-generated-abstract` on ChinaXiv and RussiaRxiv records, from ChinaRxiv's metadata: their English text is machine-translated, and almost every RussiaRxiv abstract was written by ChinaRxiv, not the authors. The records also carry `originalUrl`.
- `dateRange` now filters `chinaxiv` and `russiarxiv` searches too.

### Documentation

- The README covers setup and the essentials; parameters, the library, development and publishing moved to [`docs/`](docs/). New: [tools.md](docs/tools.md), [library.md](docs/library.md), [development.md](docs/development.md), [compliance.md](docs/compliance.md), [publishing.md](docs/publishing.md).
- Installation runs from npm (`npx -y med-research-mcp`) instead of a clone.
- The skills, tool descriptions and how-it-works now describe ChinaRxiv's machine-translated records, and the setup skill lists every environment variable.
- The skills frame results as research findings, not advice about a person: doses are reported as what studies used, and applicability is judged against the population in the question.
- [compliance.md](docs/compliance.md) records the intended use, data flows, upstream terms and the verification of the scientific content; [hosting.md](docs/hosting.md) adds a privacy-notice template for operators and security notes.
