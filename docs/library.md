# Using the core library

`med-research-mcp/core` is the library the MCP server is built on. It has no MCP dependency, so other Node projects can import it directly and get the same behavior as an MCP client.

```bash
npm install med-research-mcp
```

```ts
import { createCache, fetchFulltext, fetchLiterature, searchLiterature } from "med-research-mcp/core";

const cache = createCache({ backend: "memory" });

// Search two databases: results come back labeled, merged and sorted by design tier.
const { articles, warnings } = await searchLiterature(
  { query: "creatine AND cognition[tiab]", database: ["pubmed", "europepmc"], maxResults: 10 },
  cache,
);

// Full metadata and abstract for the top result (`Article.id` holds the database-specific id).
const top = articles[0]!;
const fetched = await fetchLiterature({ ids: [top.id], database: top.database ?? "pubmed" }, cache);

// Its full text, resolved through the DOI.
const fulltext = await fetchFulltext({ id: top.id, doi: top.doi }, cache);
```

The build ships both ESM and CommonJS, so this works with `import` and `require` alike. The functions take the same inputs and return the same shapes as the [tools](tools.md), with one difference: the library's `Article` keeps the database's own id in `id` (a PMID, or `PPR…`, `CBA:…`, `chinaxiv-…`) and has no `pmid`, and the MCP tools print the article with `id` as its first key and add `pmid` after it only when the id is a PMID (all digits). `isPmidRecord(article)` tells a library user which records those are: it is true for a record of PubMed or Europe PMC whose id is all digits. Before 0.8.0 the library kept the id in `pmid`. `searchLiterature` also probes a search that finds nothing, as the tool does: a first-page query of 2 to 5 plain words that every database answers with nothing is searched again without each word, for the count, which costs up to one more request per word and database and can take several seconds ([how it works](how-it-works.md#zero-results-probing-the-words)). `searchPubMed`, which has no merge, doesn't probe, but warns of a word PubMed ignored.

Also exported:

- `classifyDesign` and `classifyArticle`, to label your own records with the [grader](how-it-works.md#the-grader-study-design-labels).
- `searchPubMed` and `fetchPubMed`, the PubMed-only pipeline without the multi-database merge (`searchPubMed` keeps PubMed's order instead of sorting by tier, and its result has no `databases` or `filters`; `fetchPubMed` returns its articles ungraded, where `fetchLiterature` grades them).
- `NcbiClient`, with its rate limiter. Share one client between calls (pass it to `PubMedAdapter`, `searchPubMed` and `fetchFulltext`) so that concurrent requests stay within NCBI's limit.
- The adapters (`PubMedAdapter`, `EuropePmcAdapter`, `ChinaRXivAdapter`, `SovietRxivAdapter`), `adaptersFor` (a `database` value to adapters, refusing unknown ids) and `getAdapters` (which drops them), `designPublicationTypes`, the types, and the constants `STUDY_TYPES`, `RECORD_FLAGS` and `DESIGN_TIER`. The types include `SearchFilters` (what `filters` in a search result echoes), `AdapterSearchResult` (what an adapter's `search` returns) and `EmptyReason` (why it found nothing, when its query rules say so: `every-word`; databases that report the same reason share one warning), and `RecordSource` and `RecordDatabase` (what `fetchFulltext` asks of the adapter of a database whose ids PubMed doesn't know).
- `parseChinaRXiv(data, { complete? })`, which turns a ChinaRxiv API response into records; `complete: true` says they come from `/papers/{id}`, so that none is marked `abstractTruncated`.
- `fetchFulltext`'s fourth argument, `FulltextDeps`, injects its seams for tests and embedding: `unpaywall`, `adapter` (database id to the adapter that holds its records, used for a record's abstract, the DOI Europe PMC has for a preprint or another Europe PMC id, and ChinaRxiv's text; the registry's by default), the fetch and conversion functions, `proxyPrefix`, `maxChars`, `timeoutMs` and `now`.

Configuration comes from the same environment variables as the server ([README](../README.md#configuration)), read when the module is imported: the default adapters are created then, so set the variables before importing (e.g. `node --env-file=.env app.js`). To configure in code instead, pass your own clients, e.g. `searchLiterature(input, cache, [new PubMedAdapter(new NcbiClient({ email, apiKey }))])`; `NcbiClient` and `UnpaywallClient` take their settings as constructor options. If you build your own software on the library, give `NcbiClient` and `UnpaywallClient` your own `tool` and `email`: only the default tool, `med-research-mcp`, sends this project's contact address when there is no email in code or in the environment. `fetchFulltext`'s default `UnpaywallClient` takes the `NcbiClient`'s tool. A blank `email` sends none, which turns `UnpaywallClient` off (`configured` is then false); `UnpaywallClient.lookup()` tells an answer without copies apart from a failed or skipped lookup, where `resolve()` returns `null` for all of them.

## Caching

`createCache({ backend })` returns one of two backends:

- **`memory`** (default): an LRU of about 200 entries per store that dies with the process.
- **`sqlite`**: a WAL-mode SQLite file (`path`, default `./pubmed-cache.db`) that survives restarts. It needs `better-sqlite3`, an optional native dependency, loaded only when this backend is created; `createCache` throws if it can't be loaded. Construct `new SQLiteBackend(path)` directly to reach `close()`, for exit, and `vacuum()`, which a long-running process should call now and then to remove expired rows.

Summaries expire after 7 days, because their metadata changes after publication (indexing adds publication types, and retractions, expressions of concern and errata arrive at any time). Open-access full texts expire after 30 days, as resolved URLs rot; texts from the proxy or direct route aren't cached, because they may be licensed to one user, and neither are ChinaRxiv's translations, which are only held in memory for 30 minutes while being read. Abstracts never expire. What the cache stores has a format version (`CACHE_FORMAT_VERSION`, now 3): a SQLite file written by an earlier version is emptied when first opened, and a `Cache` of your own should keep versions apart the same way. Format 3 holds a record's id under `id`, where formats 1 and 2 held it under `pmid`.

## Errors

Library functions throw a `ResearchApiException` (`isMedResearchError` tells it apart), whose `toJSON()` gives the payload described in the [tool reference](tools.md#errors). `searchLiterature` throws `INVALID_INPUT` for an unknown database, an empty query, a `page` that isn't a whole number from 1, an `abstractMaxChars` that isn't a whole number from 0, or a date that doesn't exist, and otherwise only when every database it searched failed; while one answers, each failure becomes an entry in `warnings` instead. `fetchLiterature` throws `INVALID_INPUT` for an unknown database.
