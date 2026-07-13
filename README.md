# med-research-mcp

**Evidence-graded scientific literature search for AI agents.**

`med-research-mcp` searches PubMed and a growing set of regional databases (Europe PMC, ChinaRXiv, RussiaRXiv) and grades the evidence quality of every result — study type, evidence score, confidence, dosage, population, and limitations — so an AI agent (or a human) can tell a meta-analysis from a case report at a glance. It's built for optimizing biology, supplementation research, and clinical decision support, where "what does the evidence actually say" matters more than a raw list of abstracts.

It ships as a small, dependency-light TypeScript library (`core/`) with a thin [MCP](https://modelcontextprotocol.io) stdio adapter on top, plus a `.mcpb` bundle for one-click install into Claude Desktop. It's a personal, open-source tool, and the `core/` library is designed to be embedded directly into other projects — including Biohacking-IDE, without going through MCP at all.

This is a research aid, not a diagnostic tool. See [Medical disclaimer](#medical-disclaimer).

## Tool overview

The MCP server exposes three tools:

- **`literature_search`** — search one or more databases (PubMed, Europe PMC, ChinaRXiv, RussiaRXiv), merge + de-duplicate by DOI, and return keyword-graded results. Always cheap, no LLM.
- **`literature_fetch`** — fetch full metadata + abstracts for database-specific ids.
- **`literature_fulltext`** — resolve and return an article’s full text as markdown via DOI (Unpaywall → proxy → direct DOI fallback). Database-agnostic.

Typical workflow: start with `literature_search`, drill into papers with `literature_fetch`, and use `literature_fulltext` when the abstract isn’t enough.

## Install & build

```bash
npm install
```

| Script | Description |
| --- | --- |
| `npm run dev` | Run the MCP server with `tsx watch` for local development (auto-restarts on change). |
| `npm run build` | Build `dist/` with [tsup](https://tsup.egoist.dev/). |
| `npm start` | Run the built server: `node dist/mcp/index.js`. |
| `npm test` | Run the test suite with [vitest](https://vitest.dev/). |
| `npm run build:mcpb` | Package `dist/med-research-mcp.mcpb` for Claude Desktop. |

The build uses **tsup**, not plain `tsc`. tsup emits dual **ESM + CJS** output for every entry point (`dist/core/index.js` / `.cjs`, etc.), which is what lets both the ESM MCP server (`dist/mcp/index.js`) and CommonJS consumers — such as Biohacking-IDE / Theia — `require()` or `import` `med-research-mcp/core` from the same package. A plain `tsc` build would only produce one module format and break one side of that split.

## Tools reference

### `literature_search`

Search one or more databases and return merged, de-duplicated, evidence-graded results. PubMed results benefit from NLM tag grading; other databases are graded keyword-only (lower confidence). Always cheap — no LLM calls.

| Parameter | Type | Required | Notes |
| --- | --- | --- | --- |
| `query` | `string` | yes | Search query. PubMed field tags (`[tiab]`, `[mesh]`, `[au]`) apply to the pubmed database; other databases receive it as plain text. |
| `database` | `string \| string[]` | no | `"pubmed"` (default), `"europepmc"`, `"chinaxiv"`, `"russiarxiv"`, or `"all"`. |
| `maxResults` | `number` | no | Results per database. Default `10`, max `50`. |
| `minEvidenceScore` | `number` | no | Drop results below this evidence score (`0`–`5`). |
| `studyTypes` | `string[]` | no | Keep only these study types. |
| `dateRange` | `{ from?, to? }` | no | Publication date filter, `YYYY-MM-DD`. |
| `sort` | `"relevance" \| "date"` | no | Per-database sort; merged results are always re-sorted by evidence score. |
| `language` | `string` | no | ISO 639-1 language hint for adapters that support it. |

### `literature_fetch`

Fetch full metadata and abstracts for one or more ids from a specific database. Returns raw article objects with `database`, `url`, and `language` fields for non-PubMed sources — no grading.

| Parameter | Type | Required | Notes |
| --- | --- | --- | --- |
| `ids` | `string[]` | yes | Database-specific ids (PMIDs for pubmed, etc.). 1–50. |
| `database` | `string` | yes | Which database the ids belong to: `pubmed`, `europepmc`, `chinaxiv`, `russiarxiv`. |

### `literature_fulltext`

Fetch an article's full text as markdown via DOI — database-agnostic. Tries Unpaywall (open access), institutional proxy (if configured), and direct DOI access; falls back to abstract-only if paywalled. Pass the `doi` from a `literature_search` result for non-PubMed articles.

| Parameter | Type | Required | Notes |
| --- | --- | --- | --- |
| `pmid` | `string` | yes | Article id (a PMID, or a non-PubMed database's id). |
| `doi` | `string` | no | DOI — database-agnostic. Required when the id is not a numeric PMID. |

## Evidence grading system

Study types are ordered highest evidence quality first. The keyword grader tries curated PubMed `PublicationType` tags before falling back to regex over the title and abstract; a curated tag, when present, always wins over the regex result.

| Study type | Score | Key patterns |
| --- | --- | --- |
| `meta-analysis` | 5 | `meta-analysis`, `systematic review`, `pooled analysis` |
| `randomized-controlled-trial` | 4 | `randomized`/`randomised`, `double-blind`, `placebo-control(led)`, `RCT` |
| `cohort` | 3 | `cohort`, `longitudinal`, `prospective`, `follow-up` |
| `review` | 3 | `review`, `literature review`, `narrative review` (excludes `systematic review`, which is caught as `meta-analysis`) |
| `case-control` | 2 | `case-control`, `matched control` |
| `case-report` | 1 | `case report`, `case study`, `case presentation` |
| `animal-study` | 0 | `murine`, `rodent(s)`, `animal model`, `mice`, `rats` — a match is downgraded (not forced to `animal-study`) when human terms (`humans`, `patients`, `adults`, `participants`, etc.) are also present |

**Confidence.** When no curated `PublicationType` tag is available, confidence is `positiveHits * 0.4 + 0.2`, capped at `1`. Negative keywords (e.g. `study protocol`, future-tense `we will`, `unlike previous randomized trials…`) halve the confidence and are recorded as a limitation. A curated PubMed tag alone scores `0.85`–`0.95` confidence depending on whether the keyword pass corroborates it.

**Known keyword-path weaknesses** (apply to `literature_search`):

- Protocol papers ("we will randomize...") can misread as completed RCTs.
- Meta-analyses that pool poor-quality underlying studies still score a flat `5`.
- Comparative phrasing like "unlike previous randomized trials…" can trigger a false-positive RCT match.
- Animal studies that mention humans only incidentally (e.g. "may inform future human trials") can escape the animal-study downgrade.

For papers where the keyword grade is suspicious, fetch the full abstract with `literature_fetch` and use `literature_fulltext` to read the methods section directly.

## Configuration

| Variable | Required | Description |
| --- | --- | --- |
| `NCBI_EMAIL` | Recommended | Contact email sent with every NCBI request, as NCBI's usage policy asks. |
| `NCBI_API_KEY` | No | Raises the NCBI rate limit from 3 to 10 requests/second. |
| `PUBMED_UNPAYWALL_EMAIL` | No | Contact email for Unpaywall open-access lookups (used by `*_fulltext`). Falls back to `NCBI_EMAIL` if unset. |
| `PUBMED_CACHE_BACKEND` | No | `memory` (default). `sqlite` is planned for a future release. |
| `PUBMED_CACHE_PATH` | No | Path for the cache file, when using a persistent backend. |

## MCP client setup

### Hermes / generic stdio (YAML)

```yaml
mcp_servers:
  med-research-mcp:
    command: npx
    args: ["tsx", "/path/to/pubmed-bio-mcp/src/mcp/index.ts"]
    env:
      NCBI_EMAIL: "you@example.com"
      NCBI_API_KEY: ""
```

### Claude Desktop / Cursor (JSON)

Run `npm run build` first, then point the client at the built output:

```json
{
  "mcpServers": {
    "med-research-mcp": {
      "command": "node",
      "args": ["/path/to/pubmed-bio-mcp/dist/mcp/index.js"],
      "env": {
        "NCBI_EMAIL": "you@example.com",
        "NCBI_API_KEY": ""
      }
    }
  }
}
```

### Claude Desktop via `.mcpb`

```bash
npm run build:mcpb
```

Then drag the resulting `dist/med-research-mcp.mcpb` onto Claude Desktop. The installer prompts for your NCBI contact email at install time — no manual JSON editing required.

## Agent skills

This repo ships two [Agent Skills](skills/) that make the MCP self-guiding:

- **[med-research](skills/med-research/SKILL.md)** — teaches an AI how to drive the three tools: writing precise PubMed queries with field tags, reading evidence grades (scores, confidence, limitations), when to use `literature_fetch` vs `literature_fulltext`, multi-database searches, and how to report findings (cite PMIDs, surface red flags, not-medical-advice).
- **[med-research-setup](skills/med-research-setup/SKILL.md)** — guides an AI helping a user install, configure, and troubleshoot the server across clients (Claude Code, Claude Desktop `.mcpb`, Cursor, Hermes) and credentials.

Install them into Claude Code so they activate alongside the MCP:

```bash
# personal (all your projects)
mkdir -p ~/.claude/skills && cp -r skills/* ~/.claude/skills/

# or project-scoped (this workspace only)
mkdir -p .claude/skills && cp -r skills/* .claude/skills/
```

Skills take effect in new Claude Code sessions. (Claude Desktop `.mcpb` installs don't auto-load skills — copy them in as above.)

## Direct library use (Biohacking-IDE)

The `core/` library has no MCP dependency and can be imported directly:

```ts
import { searchPubMed, searchLiterature, fetchPubMed, fetchLiterature, fetchFulltext } from "med-research-mcp/core";
import { createCache } from "med-research-mcp/core/cache";

const cache = createCache({ backend: "memory" });

// PubMed only
const results = await searchPubMed(
  { query: "creatine AND cognition[tiab]", maxResults: 10 },
  cache,
);

// Multi-database
const multi = await searchLiterature(
  { query: "creatine AND cognition", database: ["pubmed", "europepmc"], maxResults: 10 },
  cache,
);
```

Thanks to the dual ESM/CJS build, this works whether the consuming project uses `import` or `require`.

## Caching

Caching is an in-memory LRU (roughly 200 entries) that dies with the process. A SQLite-backed cache — surviving restarts, with a 30-day TTL for summaries/abstracts — is planned for a future release.

## Error handling

Every failure path surfaces a typed `PubMedError`:

```ts
{
  code: "RATE_LIMIT" | "QUERY_TOO_BROAD" | "NO_ABSTRACT" | "PARSE_FAILURE"
      | "NETWORK_ERROR" | "NOT_FOUND";
  message: string;       // human-readable, for logs
  userMessage: string;   // actionable phrasing for the agent/user
  recoverable: boolean;  // whether retrying or adjusting can succeed
  retryAfter?: number;   // seconds to wait before retrying (rate limits)
}
```

## v0.3.0 scope

**In scope:**
- PubMed search and fetch via NCBI eutils, with field-tag support (`[tiab]`, `[mesh]`, `[au]`).
- Multi-database search across PubMed, Europe PMC, ChinaRXiv, and RussiaRXiv.
- Fast keyword-based evidence grading on every search result (NLM `PublicationType` tags for PubMed, keyword heuristics for other databases).
- Full-text retrieval via Unpaywall, institutional proxy, and direct DOI fallback.
- In-memory caching.
- MCP stdio server and a `.mcpb` bundle for Claude Desktop.
- Direct, dependency-free library use via `med-research-mcp/core`.

**Out of scope (for now):**
- Persistent (SQLite) caching — planned for v0.4.
- Any storage or transmission of PHI/patient data.

## Medical disclaimer

`med-research-mcp` is a research and evidence-triage tool. It does not provide medical advice, diagnosis, or treatment recommendations, and its evidence grades are heuristics, not a substitute for clinical judgement or a qualified professional. Always verify findings against the primary source and consult a healthcare provider before making medical or supplementation decisions.

## License

MIT
