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

// Full metadata and abstract for the top result (`pmid` holds the database-specific id).
const top = articles[0]!;
const fetched = await fetchLiterature({ ids: [top.pmid], database: top.database ?? "pubmed" }, cache);

// Its full text, resolved through the DOI.
const fulltext = await fetchFulltext({ id: top.pmid, doi: top.doi }, cache);
```

The build ships both ESM and CommonJS, so this works with `import` and `require` alike. The functions take the same inputs and return the same shapes as the [tools](tools.md).

Also exported:

- `classifyDesign` and `classifyArticle`, to label your own records with the [grader](how-it-works.md#the-grader-study-design-labels).
- `searchPubMed` and `fetchPubMed`, the PubMed-only pipeline without the multi-database merge (`searchPubMed` keeps PubMed's order instead of sorting by tier).
- `NcbiClient`, with its rate limiter. Share one client between calls (pass it to `PubMedAdapter`, `searchPubMed` and `fetchFulltext`) so that concurrent requests stay within NCBI's limit.
- The adapters (`PubMedAdapter`, `EuropePmcAdapter`, `ChinaRXivAdapter`, `SovietRxivAdapter`) and `getAdapters`, the types, and the constants `STUDY_TYPES`, `RECORD_FLAGS` and `DESIGN_TIER`.

Configuration comes from the same environment variables as the server ([README](../README.md#configuration)), read when the module is imported: the default adapters are created then, so set the variables before importing (e.g. `node --env-file=.env app.js`). To configure in code instead, pass your own clients, e.g. `searchLiterature(input, cache, [new PubMedAdapter(new NcbiClient({ email, apiKey }))])`; `NcbiClient` and `UnpaywallClient` take their settings as constructor options.

## Caching

`createCache({ backend })` returns one of two backends:

- **`memory`** (default): an LRU of about 200 entries per store that dies with the process.
- **`sqlite`**: a WAL-mode SQLite file (`path`, default `./pubmed-cache.db`) that survives restarts. It needs `better-sqlite3`, an optional native dependency, loaded only when this backend is created; `createCache` throws if it can't be loaded. Construct `new SQLiteBackend(path)` directly to reach `close()`, for exit, and `vacuum()`, which a long-running process should call now and then to remove expired rows.

Summaries expire after 7 days, because their metadata changes after publication (indexing adds publication types, and retractions, expressions of concern and errata arrive at any time). Open-access full texts expire after 30 days, as resolved URLs rot; texts from the proxy or direct route aren't cached, because they may be licensed to one user. Abstracts never expire.

## Errors

Library functions throw a `ResearchApiException` (`isMedResearchError` tells it apart), whose `toJSON()` gives the payload described in the [tool reference](tools.md#errors). `searchLiterature` throws only when every database it searched failed; while one answers, each failure becomes an entry in `warnings` instead.
