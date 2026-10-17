# med-research-mcp

**Evidence-graded scientific literature search for AI agents.**

`med-research-mcp` searches PubMed and a growing set of regional databases (Europe PMC, ChinaRXiv, RussiaRXiv) and labels every result's study design from NLM metadata, ranked in the evidence hierarchy and flagged for retractions and other integrity notices, so an AI agent (or a human) can tell a meta-analysis from a case report at a glance. Appraising the paper itself (reading the abstract, rating down, judging applicability) is left to the model, guided by the bundled [skills](#agent-skills). It's built for optimizing biology, supplementation research, and clinical decision support, where "what does the evidence actually say" matters more than a raw list of abstracts.

It ships as a small, dependency-light TypeScript library (`core/`) with a thin [MCP](https://modelcontextprotocol.io) stdio adapter on top, plus a `.mcpb` bundle for one-click install into Claude Desktop. It's a personal, open-source tool, and the `core/` library is designed to be embedded directly into other projects — including Biohacking-IDE, without going through MCP at all.

This is a research aid, not a diagnostic tool. See [Medical disclaimer](#medical-disclaimer).

## Tool overview

The MCP server exposes three tools:

- **`literature_search`** — search one or more databases (PubMed, Europe PMC, ChinaRXiv, RussiaRXiv), merge + de-duplicate by DOI, and return results labeled with their study design. Always cheap, no LLM.
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

Search one or more databases and return merged, de-duplicated results, each labeled with its study design (see [Study design labels](#study-design-labels)). Always cheap — no LLM calls.

| Parameter | Type | Required | Notes |
| --- | --- | --- | --- |
| `query` | `string` | yes | Search query. PubMed field tags (`[tiab]`, `[mesh]`, `[au]`) apply to the pubmed database; other databases receive it as plain text. |
| `database` | `string \| string[]` | no | `"pubmed"` (default), `"europepmc"`, `"chinaxiv"`, `"russiarxiv"`, or `"all"`. |
| `maxResults` | `number` | no | Results per database. Default `10`, max `50`. |
| `minDesignTier` | `number` | no | Drop results below this design tier (`0`–`5`). Results with an unknown tier — unclassified records and most meta-analyses/systematic reviews — are dropped too, with a warning. |
| `studyTypes` | `string[]` | no | Keep only these study types. Use this, not `minDesignTier`, to keep reviews and trials. |
| `dateRange` | `{ from?, to? }` | no | Publication date filter, `YYYY-MM-DD`. |
| `sort` | `"relevance" \| "date"` | no | Per-database sort; merged results are always re-sorted by design tier. |
| `language` | `string` | no | ISO 639-1 language hint for adapters that support it. |

### `literature_fetch`

Fetch full metadata and abstracts for one or more ids from a specific database. Returns raw article objects with publication types, MeSH headings and retraction/correction links, plus `database`, `url`, and `language` fields for non-PubMed sources — no design label.

| Parameter | Type | Required | Notes |
| --- | --- | --- | --- |
| `ids` | `string[]` | yes | Database-specific ids (PMIDs for pubmed, etc.). 1–50. Europe PMC records outside PubMed carry a source prefix, e.g. `CBA:521529` (Chinese Biological Abstracts). |
| `database` | `string` | yes | Which database the ids belong to: `pubmed`, `europepmc`, `chinaxiv`, `russiarxiv`. |

### `literature_fulltext`

Fetch an article's full text as markdown via DOI — database-agnostic. Tries Unpaywall (open access), institutional proxy (if configured), and direct DOI access; falls back to abstract-only if paywalled. Pass the `doi` from a `literature_search` result for non-PubMed articles.

| Parameter | Type | Required | Notes |
| --- | --- | --- | --- |
| `id` | `string` | yes | Article id (a PMID, or a non-PubMed database's id). |
| `doi` | `string` | no | DOI — database-agnostic. Required when the id is not a numeric PMID. |

## Study design labels

Every `literature_search` result carries `studyType`, `designTier` and, when any apply, `flags`. They are computed from NLM metadata only — no keyword or regex rules read the title or abstract. The code is [src/core/grader.ts](src/core/grader.ts); every mapping there cites its source.

**`studyType`** comes from NLM PublicationType tags (PubMed, and Europe PMC, which mirrors them), following NLM's own definitions in [MeSH](https://id.nlm.nih.gov/mesh/). A label is assigned only as far as the metadata establishes it:

- `Randomized Controlled Trial` and `Equivalence Trial` (a child of RCT in the MeSH tree) → `randomized-controlled-trial`.
- `Controlled Clinical Trial` → `non-randomized-trial`. NLM defines it as controlled and tags randomized trials as RCT instead; its controls may be historical.
- `Clinical Trial`, phases I–IV, `Adaptive`, `Pragmatic` (moved under Clinical Trial in MeSH 2026) and `Human Challenge Trials` → `clinical-trial`: randomization and control aren't indexed.
- `Observational Study` → `observational`. MeSH design headings ("Cohort Studies", "Prospective Studies"…) are **not** used to narrow it or to classify untagged records: sampled 2023 records showed them applied to diagnostic, intervention and ecological studies too.
- `Meta-Analysis`, `Network Meta-Analysis` → `meta-analysis`; `Systematic Review` → `systematic-review`; `Case Reports` → `case-report`; `Review`, `Scoping Review` → `review`; veterinary tags → `animal-study`.
- Conflicting primary tags (e.g. RCT plus Observational Study, mostly observational analyses of trial cohorts) take the lower design.
- No such tag → `unknown`. That's common for recent papers, journals outside MEDLINE, and ChinaXiv / RussiaRxiv. Unknown means unlabeled, not weak: the model reads the abstract and classifies it, as the [`med-research`](skills/med-research/SKILL.md) skill instructs.

These are NLM's labels, but not hand-curated. Since 2022 NLM indexes MEDLINE automatically (MTIA, then the neural MTIX), curating selected records by hand, and has been bringing publication types into that automation ([NLM 2021](https://www.nlm.nih.gov/pubs/techbull/nd21/nd21_medline_2022.html), [NLM 2024](https://www.nlm.nih.gov/pubs/techbull/ma24/ma24_mtix.html)). Treat a label as a strong prior to confirm when it matters.

**`designTier`** ranks the design for "Does this intervention help?" by the [OCEBM 2011 Levels of Evidence](https://www.cebm.ox.ac.uk/resources/levels-of-evidence/ocebm-levels-of-evidence). When a label's definition spans levels, the lower one is used.

| `studyType` | `designTier` | Basis (OCEBM 2011, treatment benefits) |
| --- | --- | --- |
| `meta-analysis`, `systematic-review` | 5 **only if it pooled randomized trials**; otherwise `null` | Level 1 is a systematic review *of randomized trials*. A review ranks with what it pooled, and MeSH rarely shows that: in 2022, 77% of reviews/meta-analyses carried no heading for it. Only `Network Meta-Analysis`, defined as pooling randomized trials, gets 5 |
| `randomized-controlled-trial` | 4 | Level 2. NLM also applies the tag to secondary analyses of trial data |
| `cohort` | 3 | Level 3 (non-randomized controlled cohort) |
| `non-randomized-trial`, `clinical-trial`, `observational`, `case-control`, `cross-sectional` | 2 | Level 4 or a label spanning levels 3–4 (historical controls, single-arm trials, unspecified observational design) |
| `case-report`, `review` | 1 | Below level 4: a single case, or a review not indexed as systematic (16% of 2023 papers titled "systematic review" carry only `Review`) |
| `animal-study`, `in-vitro` | 0 | Non-human: at most mechanism-based reasoning (level 5) for human questions |
| `unknown` | `null` | **Unrated, not weak.** When `minDesignTier` drops these, a warning reports how many |

`cohort`, `case-control`, `cross-sectional` and `in-vitro` are never assigned from metadata; they exist for designs the model reads from an abstract. **`designTier` ranks the design; it doesn't appraise the study.** Risk of bias, imprecision, inconsistency, indirectness and publication bias need the paper ([GRADE](https://pubmed.ncbi.nlm.nih.gov/21208779/)), and prognosis, diagnosis and harms questions rank designs differently (OCEBM). The skills cover this.

**`flags`** come from publication types, the CommentsCorrections links in PubMed and Europe PMC records, and MeSH check tags.

| Flag | Source | Effect |
| --- | --- | --- |
| `retracted` | `Retracted Publication` tag, a `RetractionIn` link, or a publisher `RETRACTED` title prefix | tier 0 |
| `notice` | `Retraction Notice` (named "Retraction of Publication" before 2025), `Expression of Concern`, `Published Erratum` — a notice, not a study | tier 0 |
| `protocol` | `Clinical Trial Protocol` | tier 0 |
| `editorial` | `Editorial`, `Comment` | tier 0 |
| `expression-of-concern` | an `ExpressionOfConcernIn` link (the article itself is never tagged) | warning |
| `corrected` | an `ErratumIn` link | warning |
| `updated` | an `UpdateIn` link: a newer version exists, e.g. an updated Cochrane review | warning |
| `animals-not-humans` | MeSH `Animals` without `Humans`. Only a warning: automated indexing drops `Humans` from human trials often enough that this filter wrongly excluded human RCTs 7× as often as under manual indexing ([Askin 2025](https://pubmed.ncbi.nlm.nih.gov/39975499/)) | warning |
| `preprint`, `letter` | `Preprint`, `Letter` (letters include research letters) | warning |

**Sort order.** Known tiers 2–5 first, then records with an unknown tier, then tiers 1 and 0. Within a tier, the per-database relevance order is kept. Search results leave out `meshHeadings` to stay compact; `literature_fetch` returns them.

## Configuration

| Variable | Required | Description |
| --- | --- | --- |
| `NCBI_EMAIL` | Recommended | Contact email sent with every NCBI request, as NCBI's usage policy asks. |
| `NCBI_API_KEY` | No | Raises the NCBI rate limit from 3 to 10 requests/second. |
| `MED_RESEARCH_UNPAYWALL_EMAIL` | No | Contact email for Unpaywall open-access lookups (used by `*_fulltext`). Falls back to `NCBI_EMAIL` if unset. |
| `MED_RESEARCH_CACHE_BACKEND` | No | `memory` (default, in-process LRU) or `sqlite` (persistent, survives restarts). |
| `MED_RESEARCH_CACHE_PATH` | No | Path for the SQLite cache file, when `MED_RESEARCH_CACHE_BACKEND=sqlite`. Defaults to `./pubmed-cache.db`. |

## MCP client setup

### Hermes / generic stdio (YAML)

```yaml
mcp_servers:
  med-research-mcp:
    command: npx
    args: ["tsx", "/Users/private/Desktop/repos/pubmed-bio-mcp/src/mcp/index.ts"]
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
      "args": ["/Users/private/Desktop/repos/pubmed-bio-mcp/dist/mcp/index.js"],
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

This repo ships three [Agent Skills](skills/) that make the MCP self-guiding, in two tiers:

- **[med-research](skills/med-research/SKILL.md)** — the lean workflow skill (~85 lines): how to drive the three tools, write precise PubMed queries with field tags, read design labels and classify unlabeled papers from their abstract, choose `literature_fetch` vs `literature_fulltext`, do multi-database searches, and report findings. Includes three few-shot patterns (simple lookup, evidence synthesis, bullshit detection) so even small models converge on the right workflow, plus a pointer to the EBM reference below.
- **[med-research-ebm](skills/med-research-ebm/SKILL.md)** — the EBM critical-appraisal reference, loaded only when a paper is about to drive a real decision: PICO framing, RoB 2 / ROBINS-I, AMSTAR-2, effect sizes/CIs/NNT, heterogeneity, Bradford Hill causation, applicability, and conflicts of interest. Kept separate so the workflow skill stays lean and fast.
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
import { searchLiterature, fetchLiterature, fetchFulltext } from "med-research-mcp/core";
import { createCache } from "med-research-mcp/core/cache";

const cache = createCache({ backend: "memory" });

// Multi-database (primary API)
const results = await searchLiterature(
  { query: "creatine AND cognition", database: ["pubmed", "europepmc"], maxResults: 10 },
  cache,
);

// Fetch full text for a result
const article = await fetchLiterature({ ids: [results[0].id], database: "pubmed" }, cache);
```

> **PubMed-only aliases:** `searchPubMed` and `fetchPubMed` remain available for PubMed-specific use cases — they are thin wrappers around the primary API.

Thanks to the dual ESM/CJS build, this works whether the consuming project uses `import` or `require`.

## Caching

Two backends are available, selected via `MED_RESEARCH_CACHE_BACKEND`:

- **`memory` (default)** — an in-memory LRU (roughly 200 entries per store) that dies with the process.
- **`sqlite`** — a persistent cache that survives restarts, backed by a WAL-mode SQLite database at `MED_RESEARCH_CACHE_PATH` (default `./pubmed-cache.db`). If the native `better-sqlite3` binding fails to load, the server logs a warning and falls back to the in-memory cache.

In both backends, summaries expire after 7 days, because their metadata changes after publication: indexing adds publication types, and retractions, expressions of concern and errata arrive at any time. Full texts expire after 30 days (resolved URLs rot). Abstracts never expire.

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
- Study-design labels and retraction/correction flags on every search result from NLM metadata (`PublicationType` tags, CommentsCorrections links) for PubMed and Europe PMC.
- Full-text retrieval via Unpaywall, institutional proxy, and direct DOI fallback.
- In-memory (default) and persistent SQLite caching.
- MCP stdio server and a `.mcpb` bundle for Claude Desktop.
- Direct, dependency-free library use via `med-research-mcp/core`.

**Out of scope (for now):**
- Any storage or transmission of PHI/patient data.

## Medical disclaimer

`med-research-mcp` is a research and evidence-triage tool. It does not provide medical advice, diagnosis, or treatment recommendations, and its design labels rank study designs, not the quality of individual studies. They are not a substitute for clinical judgement or a qualified professional. Always verify findings against the primary source and consult a healthcare provider before making medical or supplementation decisions.

## License

MIT
