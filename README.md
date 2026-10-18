<p align="center">
  <img src="mcpb/icon.png" alt="med-research-mcp icon" width="120" height="120">
</p>

<h1 align="center">med-research-mcp</h1>

<p align="center">
  <strong>Evidence-graded scientific literature search for AI agents.</strong>
</p>

<p align="center">
  <a href="#hosted-instance">Hosted instance</a> ·
  <a href="#install">Install</a> ·
  <a href="#configuration">Configuration</a> ·
  <a href="#tools">Tools</a> ·
  <a href="#agent-skills">Skills</a> ·
  <a href="#medical-disclaimer">Disclaimer</a>
</p>

`med-research-mcp` searches PubMed, Europe PMC, ChinaXiv and RussiaRxiv and labels every result with its study design, so an AI agent (or a human) can tell a meta-analysis from a case report at a glance. Labels come from NLM metadata, are ranked in the evidence hierarchy, and flag retractions and other integrity notices. Appraising the paper itself (reading the abstract, rating down, judging applicability) is left to the model, guided by the bundled [skills](#agent-skills). It's built for medical, clinical and supplementation research, where "what does the evidence actually say" matters more than a raw list of abstracts.

- **Four databases in one call**, merged and de-duplicated by DOI.
- **Study-design labels from NLM metadata**: a `studyType`, a 0–5 `designTier` based on the OCEBM 2011 levels, and `flags` for retractions, expressions of concern, errata and more. No keyword guessing: a record without metadata says `unknown`.
- **Full text when the abstract isn't enough**, via Unpaywall, an institutional proxy or the DOI.
- **Cheap**: search makes no LLM calls, and results are cached.
- **Agent skills** that teach the model to write precise queries, read the labels and appraise evidence.

It's an open-source tool, used in professional research work: a TypeScript library (`core/`) with a thin [MCP](https://modelcontextprotocol.io) stdio server on top, plus a `.mcpb` bundle for one-click install in Claude Desktop. The library has no MCP dependency and can be embedded directly in other projects.

> [!IMPORTANT]
> This is a research aid, not a diagnostic tool. See [Medical disclaimer](#medical-disclaimer).

## Hosted instance

A public instance runs at `https://mcp.example.com/mcp` (Streamable HTTP), serving the same three tools with no signup. Configure your MCP client with that URL; see [docs/hosting.md](docs/hosting.md#deploy) for a client config example.

```json
{
  "mcpServers": {
    "med-research-mcp": {
      "type": "http",
      "url": "https://mcp.example.com/mcp"
    }
  }
}
```

Use the hosted instance for evaluation and testing — it is shared, rate-limited and resolves full texts only through open access. **Anyone using it in production should deploy their own**: self-hosting ([below](#install) for stdio, [docs/hosting.md](docs/hosting.md) for HTTP) gives you your own rate limits, an optional persistent cache, and the institutional-proxy route, which is not usable on a hosted instance because it depends on the caller's own proxy session.

| Limit | Default |
| --- | --- |
| Requests per IP | 60/min, burst 20 → 429 with `Retry-After` |
| Concurrent requests (global) | 8, queue 100 → 503 with `Retry-After: 5` |
| Request body | 1 MB → 413 |

The endpoint logs no queries, has no accounts and stores nothing ([privacy note](docs/hosting.md#privacy)).

## Install

Requires Node.js 22.22.2 or later; on Node 24, 24.15.0 or later.

```bash
git clone https://github.com/emilkrebs/med-research-mcp.git
cd med-research-mcp
npm install
npm run build
```

Then register the server with your MCP client. In the examples, replace `/path/to/med-research-mcp` with the absolute path of your clone, and `you@example.com` with your email (see [Configuration](#configuration)).

### Claude Code

```bash
claude mcp add med-research-mcp -s user \
  -e NCBI_EMAIL=you@example.com \
  -- node /path/to/med-research-mcp/dist/mcp/index.js
```

`-s user` registers it for all your projects; use `-s local` for the current one only. `claude mcp get med-research-mcp` checks the connection. The tools appear in new sessions.

### Claude Desktop (`.mcpb`)

```bash
npm run build:mcpb
```

Drag the resulting `dist/med-research-mcp.mcpb` onto Claude Desktop. The installer asks for your NCBI contact email and, optionally, an NCBI API key, an Unpaywall email and an institutional proxy prefix. No JSON editing required.

### Cursor and other JSON configs

```json
{
  "mcpServers": {
    "med-research-mcp": {
      "command": "node",
      "args": ["/path/to/med-research-mcp/dist/mcp/index.js"],
      "env": {
        "NCBI_EMAIL": "you@example.com",
        "NCBI_API_KEY": ""
      }
    }
  }
}
```

### Hermes and other YAML configs

This runs the TypeScript source directly, so it needs no build and picks up source changes:

```yaml
mcp_servers:
  med-research-mcp:
    command: npx
    args: ["tsx", "/path/to/med-research-mcp/src/mcp/index.ts"]
    env:
      NCBI_EMAIL: "you@example.com"
      NCBI_API_KEY: ""
```

Clients that run `dist/` need `npm run build` again after every source change. To make the agent use the tools well, also install the [agent skills](#agent-skills).

## Configuration

Set these in your MCP client's `env` block. The server reads them from its environment and doesn't load a `.env` file itself; [`.env.example`](.env.example) documents each one.

| Variable | Required | Description |
| --- | --- | --- |
| `NCBI_EMAIL` | Recommended | Contact email sent with every NCBI request, as NCBI's usage policy asks. Without it, you're more likely to be throttled. |
| `NCBI_API_KEY` | No | Raises the NCBI rate limit from 3 to 10 requests per second. Get one in your [NCBI account settings](https://www.ncbi.nlm.nih.gov/account/settings/). |
| `MED_RESEARCH_CHINAXIV_EMAIL` | No | Contact email sent as `X-API-Email` on ChinaXiv and RussiaRxiv requests, raising the ChinaRxiv rate limit from 30 to 300 requests/minute. Falls back to `NCBI_EMAIL`. |
| `MED_RESEARCH_UNPAYWALL_EMAIL` | No | Contact email for Unpaywall open-access lookups in `literature_fulltext`. Falls back to `NCBI_EMAIL`. |
| `MED_RESEARCH_PROXY_PREFIX` | No | Your institution's EZproxy host for doi.org, e.g. `https://doi-org.ezproxy.your-university.edu`. `literature_fulltext` requests `<prefix>/<DOI>`, so `…/login?url=` prefixes don't work. Needs an active proxy session on the machine. See the [terms note](#literature_fulltext). |
| `MED_RESEARCH_FULLTEXT_MAX_CHARS` | No | Cap on the length of returned full texts. Default `50000`. |
| `MED_RESEARCH_CACHE_BACKEND` | No | `memory` (default, in-process) or `sqlite` (persistent, survives restarts). |
| `MED_RESEARCH_CACHE_PATH` | No | SQLite file for the `sqlite` backend. Default `./pubmed-cache.db`; `:memory:` for a throwaway database. |

## Tools

| Tool | What it does |
| --- | --- |
| [`literature_search`](#literature_search) | Searches one or more databases, merges and de-duplicates the results, and labels each with its study design. No LLM calls. |
| [`literature_fetch`](#literature_fetch) | Returns full metadata and abstracts for specific ids. |
| [`literature_fulltext`](#literature_fulltext) | Returns an article's full text as markdown, found through its DOI. |

Typical workflow: start with `literature_search`, read promising papers with `literature_fetch`, and use `literature_fulltext` when the abstract isn't enough (methods, dosage, sample sizes).

### `literature_search`

Returns `{ articles, total, query, warnings? }`. Each article carries `studyType`, `designTier` and, when any apply, `flags` (see [Study design labels](#study-design-labels)).

| Parameter | Type | Required | Notes |
| --- | --- | --- | --- |
| `query` | `string` | yes | Search query. PubMed field tags (`[tiab]`, `[mesh]`, `[au]`) apply to `pubmed`; other databases receive the query as plain text. |
| `database` | `string \| string[]` | no | `"pubmed"` (default), `"europepmc"`, `"chinaxiv"`, `"russiarxiv"`, an array of these, or `"all"`. See [Databases](#databases). |
| `maxResults` | `number` | no | Results per database. Default `10`, max `50`. |
| `minDesignTier` | `number` | no | Drop results below this design tier (`0`–`5`; `4` = RCTs). Also drops every result with a `null` tier (unlabeled records and most meta-analyses and systematic reviews) and reports how many in a warning. |
| `studyTypes` | `string[]` | no | Keep only these study types. To keep reviews and trials, use this instead of `minDesignTier`. `cohort`, `case-control`, `cross-sectional` and `in-vitro` are never assigned from metadata, so filtering on them returns nothing. |
| `dateRange` | `{ from?, to? }` | no | Publication date filter, `YYYY-MM-DD`. Applies to `pubmed` and `europepmc`. |
| `sort` | `"relevance" \| "date"` | no | Order within each database. The merged list is always re-sorted by design tier. |
| `language` | `string` | no | ISO 639-1 hint for databases that support it. |

If one database fails during a multi-database search, its error becomes an entry in `warnings` and the other databases' results are still returned.

### `literature_fetch`

Returns `{ articles, missing, warnings? }`: the raw records with publication types, MeSH headings and retraction/correction links, plus `database`, `url` and `language` for non-PubMed sources. No design labels.

| Parameter | Type | Required | Notes |
| --- | --- | --- | --- |
| `ids` | `string[]` | yes | 1–50 database-specific ids: PMIDs for `pubmed`; for `europepmc`, PMIDs or prefixed ids for records outside PubMed, e.g. `CBA:521529` (Chinese Biological Abstracts) or `PPR…` preprints. |
| `database` | `string` | yes | The database the ids belong to: `pubmed`, `europepmc`, `chinaxiv` or `russiarxiv`. |

### `literature_fulltext`

Tries Unpaywall (open access), then the institutional proxy (if configured), then the DOI directly, and falls back to the abstract if the article is paywalled. Returns `{ id, doi?, source, fulltext?, format, truncated, warning? }`, where `source` says which route worked (`unpaywall`, `proxy`, `direct`, or `none` for the abstract fallback).

The proxy route uses your own institutional access. Use it only as your institution's and the publishers' terms allow: typically personal research use, no systematic or automated downloading, and some licenses forbid passing full texts to AI tools.

| Parameter | Type | Required | Notes |
| --- | --- | --- | --- |
| `id` | `string` | yes | Article id: a PMID, or another database's id. |
| `doi` | `string` | no | Required when `id` isn't a numeric PMID. Pass the `doi` from a `literature_search` result. |

### Databases

| Id | Source | Covers | Design labels |
| --- | --- | --- | --- |
| `pubmed` | NCBI E-utilities | PubMed / MEDLINE | Yes |
| `europepmc` | Europe PMC REST API | A mirror of PubMed, plus preprints and other sources such as Chinese Biological Abstracts | For MEDLINE-indexed records |
| `chinaxiv` | ChinaRxiv API | Chinese preprints, with English title and abstract when available | No: always `unknown` |
| `russiarxiv` | ChinaRxiv API | Soviet-era and Russian papers | No: always `unknown` |

## Study design labels

Every `literature_search` result carries three fields, computed by [`src/core/grader.ts`](src/core/grader.ts) from NLM metadata only. No keyword or regex rules read the title or abstract.

- **`studyType`**: the design, from NLM PublicationType tags (PubMed, and Europe PMC, which mirrors them). A label is assigned only as far as the metadata establishes it. Records without such tags are `unknown`, which is common for recent papers, journals outside MEDLINE, and ChinaXiv / RussiaRxiv. **Unknown means unlabeled, not weak**: the model reads the abstract and classifies it, as the [`med-research`](skills/med-research/SKILL.md) skill instructs.
- **`designTier`**: how high the design ranks for "Does this intervention help?" by the [OCEBM 2011 Levels of Evidence](https://www.cebm.ox.ac.uk/resources/levels-of-evidence/ocebm-levels-of-evidence). When a label's definition spans levels, the lower one is used.
- **`flags`**: integrity notices and warnings, from publication types, retraction and correction links, and MeSH check tags.

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

`retracted`, `notice` (retraction notices, expressions of concern, errata), `protocol` and `editorial` mark records that aren't usable as evidence. `expression-of-concern`, `corrected`, `updated` (a newer version exists), `animals-not-humans`, `preprint` and `letter` are warnings that leave the tier alone. Results are sorted with tiers 2–5 first, then `null`, then tiers 1 and 0.

Keep two limits in mind:

- **`designTier` ranks the design; it doesn't appraise the study.** Risk of bias, imprecision, inconsistency, indirectness and publication bias need the paper ([GRADE](https://pubmed.ncbi.nlm.nih.gov/21208779/)), and prognosis, diagnosis and harms questions rank designs differently (OCEBM). The skills cover this.
- **The labels are NLM's, but not hand-curated.** Since 2022, NLM indexes MEDLINE automatically, curating selected records by hand ([NLM 2021](https://www.nlm.nih.gov/pubs/techbull/nd21/nd21_medline_2022.html), [NLM 2024](https://www.nlm.nih.gov/pubs/techbull/ma24/ma24_mtix.html)). Treat a label as a strong prior to confirm when it matters.

**[How it works](docs/how-it-works.md#the-grader-study-design-labels)** has the full mapping from publication types to labels, the reasoning behind each tier and flag, worked examples, and the sources.

## Agent skills

This repo ships three [Agent Skills](skills/) that make the MCP self-guiding:

- **[med-research](skills/med-research/SKILL.md)**: the workflow skill. How to drive the three tools, write precise PubMed queries with field tags, read the design labels and classify unlabeled papers from their abstract, choose between `literature_fetch` and `literature_fulltext`, search several databases, and report findings. Three few-shot patterns (simple lookup, evidence synthesis, bullshit detection) help even small models converge on the right workflow.
- **[med-research-ebm](skills/med-research-ebm/SKILL.md)**: the critical-appraisal reference, loaded only when a paper is about to drive a real decision. Covers PICO framing, RoB 2 / ROBINS-I, AMSTAR-2, effect sizes, confidence intervals and NNT, heterogeneity, Bradford Hill causation, applicability and conflicts of interest. It's kept separate so the workflow skill stays lean.
- **[med-research-setup](skills/med-research-setup/SKILL.md)**: guides an AI that helps a user install, configure and troubleshoot the server.

To install them for Claude Code:

```bash
# for all your projects
mkdir -p ~/.claude/skills && cp -r skills/* ~/.claude/skills/

# or for the current project only
mkdir -p .claude/skills && cp -r skills/* .claude/skills/
```

Skills take effect in new sessions. Claude Desktop `.mcpb` installs don't load skills automatically, so copy them in the same way.

## Using the core library

`med-research-mcp/core` has no MCP dependency and can be imported directly:

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

The build ships both ESM and CommonJS, so this works with `import` and `require` alike. Also exported: `classifyDesign` to label your own records, and the PubMed-only `searchPubMed` and `fetchPubMed`, which run the same NCBI pipeline without the multi-database merge (`searchPubMed` keeps PubMed's order instead of sorting by tier).

## Caching and errors

**Caching.** The `memory` backend (default) is an LRU of about 200 entries per store that dies with the process. The `sqlite` backend persists to a WAL-mode SQLite file and survives restarts. It needs `better-sqlite3`, an optional native dependency; if that isn't installed or fails to load, the server logs a warning and uses memory instead. Summaries expire after 7 days, because their metadata changes after publication (indexing adds publication types, and retractions, expressions of concern and errata arrive at any time). Full texts expire after 30 days, as resolved URLs rot. Abstracts never expire.

**Errors.** Library functions throw a `ResearchApiException`, whose `toJSON()` gives:

```ts
{
  code: "RATE_LIMIT" | "QUERY_TOO_BROAD" | "PARSE_FAILURE" | "NETWORK_ERROR" | "NOT_FOUND";
  message: string;      // human-readable, for logs
  userMessage: string;  // actionable phrasing for the agent or user
  recoverable: boolean; // whether retrying or adjusting can succeed
  retryAfter?: number;  // seconds to wait before retrying (rate limits)
}
```

The MCP tools return the same payload as an `isError` result (`UNKNOWN` for unexpected errors).

## Development

| Script | Description |
| --- | --- |
| `npm run dev` | Run the MCP server with `tsx watch`, restarting on change. |
| `npm run dev:http` | Same for the hosted HTTP entry (`src/http/index.ts`). |
| `npm run build` | Build `dist/`: [tsup](https://tsup.egoist.dev/) for the JavaScript, `tsc --emitDeclarationOnly` for the type declarations. |
| `npm start` | Run the built server (`node dist/mcp/index.js`). |
| `npm run start:http` | Run the built HTTP server (`node dist/http/index.js`); see [docs/hosting.md](docs/hosting.md). |
| `npm test` | Run the test suite with [vitest](https://vitest.dev/). `npm run test:watch` re-runs on change. |
| `npm run typecheck` | Type-check without emitting. |
| `npm run build:mcpb` | Bundle the server with esbuild and pack `dist/med-research-mcp.mcpb` for Claude Desktop. |

The build uses tsup rather than plain `tsc` because it emits **both ESM and CommonJS** for every entry point (`dist/core/index.js` and `.cjs`, and so on). The MCP server runs as ESM, while CommonJS consumers `require()` `med-research-mcp/core` from the same package. A plain `tsc` build produces one module format and would break one side.

- **[docs/how-it-works.md](docs/how-it-works.md)** explains the internals: the search pipeline, the design grader, full-text resolution, rate limits and caching.
- **[benchmark/](benchmark/README.md)** measures how well models answer biomedical questions with the MCP, optionally against closed-book and web-search baselines. It verifies every citation against live PubMed and grades open-ended answers blind, by hand or with an LLM judge as a second opinion.

## Scope (v0.5.0)

**In scope:**

- PubMed search and fetch via NCBI E-utilities, with field tags (`[tiab]`, `[mesh]`, `[au]`).
- Multi-database search across PubMed, Europe PMC, ChinaXiv and RussiaRxiv.
- Study-design labels and retraction/correction flags from NLM metadata (PublicationType tags, CommentsCorrections links) for PubMed and Europe PMC records.
- Full-text retrieval via Unpaywall, an institutional proxy, or the DOI.
- In-memory (default) and persistent SQLite caching.
- An MCP stdio server and a `.mcpb` bundle for Claude Desktop.
- A stateless Streamable HTTP server for hosted deployments ([docs/hosting.md](docs/hosting.md)).
- Direct library use via `med-research-mcp/core`, without MCP.

**Out of scope (for now):**

- Any storage or transmission of PHI or patient data.

## Medical disclaimer

`med-research-mcp` is a research and evidence-triage tool. It does not provide medical advice, diagnosis, or treatment recommendations, and its design labels rank study designs, not the quality of individual studies. They are not a substitute for clinical judgement or a qualified professional. Always verify findings against the primary source and consult a healthcare provider before making medical or supplementation decisions.

## License

[MIT](LICENSE.md)
