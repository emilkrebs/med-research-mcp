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
| `ids` | `string[]` | yes | Database-specific ids (PMIDs for pubmed, etc.). 1–50. Europe PMC records outside PubMed carry a source prefix, e.g. `CBA:521529` (Chinese Biological Abstracts). |
| `database` | `string` | yes | Which database the ids belong to: `pubmed`, `europepmc`, `chinaxiv`, `russiarxiv`. |

### `literature_fulltext`

Fetch an article's full text as markdown via DOI — database-agnostic. Tries Unpaywall (open access), institutional proxy (if configured), and direct DOI access; falls back to abstract-only if paywalled. Pass the `doi` from a `literature_search` result for non-PubMed articles.

| Parameter | Type | Required | Notes |
| --- | --- | --- | --- |
| `id` | `string` | yes | Article id (a PMID, or a non-PubMed database's id). |
| `doi` | `string` | no | DOI — database-agnostic. Required when the id is not a numeric PMID. |

## Evidence grading system

Grading has two steps: classify the **study design**, then rate the **evidence score** down from that design's starting tier. It is built to avoid optimistic bias — when the grader is unsure, it errs toward the lower tier, and it never rates a score up.

### 1. Study design

Curated PubMed `PublicationType` tags are used first, taking the most specific tag regardless of order. Generic tags (`Review`, `Observational Study`, `Clinical Trial`) can only be *refined* to a more specific design when the abstract states that design outright. For example, a pre-2019 systematic review that NLM tagged only as `Review` is refined, but an `Observational Study` is never promoted to an RCT. Veterinary tags map to `animal-study`.

Without tags, weighted keyword cues vote for each design:

- **The title counts double.** CONSORT 1a, STROBE 1a and PRISMA 1 all ask authors to name the design in the title.
- **Sentences about other work cast no vote**, for example "previous meta-analyses have shown…", "unlike prior RCTs…", or "further randomized trials are needed". (English only.)
- **Negations are handled.** "non-randomized" and "quasi-randomised" (and the equivalents in other supported languages) count as a non-randomized trial. "Institutional review board" and "chart review" are not treated as reviews.
- **A declared synthesis wins over the designs it pools.** A meta-analysis of RCTs is a meta-analysis, and a narrative review of meta-analyses is a review.
- **Preclinical work stays preclinical.** Animal or in-vitro cues with no human participants mean `animal-study` or `in-vitro`, even when the animals were randomized.
- **Ties go to the lower tier.**

| Study type | Starting score | Notes |
| --- | --- | --- |
| `meta-analysis` | 5 | Quantitative synthesis |
| `systematic-review` | 5 | Systematic search and appraisal, with or without pooling |
| `randomized-controlled-trial` | 4 | |
| `non-randomized-trial` | 3 | Single-arm, quasi-randomized, or controlled but not randomized (OCEBM level 3) |
| `cohort` | 3 | Prospective or retrospective observational follow-up |
| `case-control` | 2 | |
| `cross-sectional` | 2 | Can't establish temporality |
| `case-report` | 1 | Case report or case series |
| `review` | 1 | Narrative, scoping or literature review. Unsystematic synthesis, ranked with expert opinion |
| `animal-study` / `in-vitro` | 0 | Not directly applicable to humans |
| `unknown` | 0 | **Unclassified, not weak.** Flagged in `limitations`. When `minEvidenceScore` drops these results, a warning reports how many |

### 2. Rating down

These signals lower the score, and each step is listed in `scoreAdjustments`:

| Signal | Effect |
| --- | --- |
| Retracted publication (NLM tag or `RETRACTED` title) | → 0 |
| Study protocol (NLM `Clinical Trial Protocol`, protocol title, "this protocol describes…") | → 0 |
| NLM `Editorial` / `Comment` | → 0 |
| Meta-analysis or systematic review of animal / in-vitro studies | → 0 |
| Meta-analysis or systematic review of observational studies only | −1 (GRADE starts such evidence at low certainty) |
| Pilot or feasibility trial (title, or "this pilot…") | −1 (not powered for efficacy) |

The penalties are deliberately small wherever the detection is heuristic. **Nothing rates up**, because GRADE's upgrade criteria (large effect, dose-response) need effect sizes that regexes can't read reliably. `Preprint`, `Letter`, post-hoc analyses and mixed human/animal papers only add a `limitations` note. **The source database and the language never change a score.** Non-PubMed and non-English results only get lower `confidence`.

**Confidence.** With an NLM tag, confidence is `0.95` when the keywords agree and `0.85` otherwise. A tag refined by keywords scores `0.8`. For keyword-only grades, confidence is `(1 − e^−w) · (0.5 + 0.5 · w / (w + r))`, where `w` is the winning design's cue weight and `r` is the runner-up's. It is capped at `0.8` so a regex never out-ranks a curated tag. Protocol or future-tense wording halves the confidence, and title-only grades are capped at `0.5`.

**Remaining keyword-path limits:** `literature_search` doesn't read risk of bias, imprecision, inconsistency or indirectness, which need the methods and results sections. Sentence-level background detection only works in English. For a paper that will drive a decision, read it with `literature_fulltext` and appraise it (see the `med-research-ebm` skill).

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

- **[med-research](skills/med-research/SKILL.md)** — the lean workflow skill (~85 lines): how to drive the three tools, write precise PubMed queries with field tags, read evidence grades (scores, confidence, limitations), choose `literature_fetch` vs `literature_fulltext`, do multi-database searches, and report findings. Includes three few-shot patterns (simple lookup, evidence synthesis, bullshit detection) so even small models converge on the right workflow, plus a pointer to the EBM reference below.
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
- **`sqlite`** — a persistent cache that survives restarts, backed by a WAL-mode SQLite database at `MED_RESEARCH_CACHE_PATH` (default `./pubmed-cache.db`). Full texts expire after a 30-day TTL; summaries and abstracts never expire, since published papers don't change. If the native `better-sqlite3` binding fails to load, the server logs a warning and falls back to the in-memory cache.

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
- In-memory (default) and persistent SQLite caching.
- MCP stdio server and a `.mcpb` bundle for Claude Desktop.
- Direct, dependency-free library use via `med-research-mcp/core`.

**Out of scope (for now):**
- Any storage or transmission of PHI/patient data.

## Medical disclaimer

`med-research-mcp` is a research and evidence-triage tool. It does not provide medical advice, diagnosis, or treatment recommendations, and its evidence grades are heuristics, not a substitute for clinical judgement or a qualified professional. Always verify findings against the primary source and consult a healthcare provider before making medical or supplementation decisions.

## License

MIT
