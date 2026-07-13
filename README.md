# med-research-mcp

**Evidence-graded PubMed search for AI agents.**

`med-research-mcp` searches PubMed and grades the evidence quality of every result — study type, evidence score, confidence, dosage, population, and limitations — so an AI agent (or a human) can tell a meta-analysis from a case report at a glance. It's built for optimizing biology, supplementation research, and clinical decision support, where "what does the evidence actually say" matters more than a raw list of abstracts.

It ships as a small, dependency-light TypeScript library (`core/`) with a thin [MCP](https://modelcontextprotocol.io) stdio adapter on top, plus a `.mcpb` bundle for one-click install into Claude Desktop. It's a personal, open-source tool, and the `core/` library is designed to be embedded directly into other projects — including Biohacking-IDE, without going through MCP at all.

This is a research aid, not a diagnostic tool. See [Medical disclaimer](#medical-disclaimer).

## Two-path grading model

`med-research-mcp` grades evidence quality via two complementary paths:

- **`pubmed_search` — fast keyword grading.** Every search result is graded immediately using PubMed's own curated `PublicationType` tags (assigned by NLM indexers) where available, falling back to regex rules over the title/abstract otherwise. No network calls beyond PubMed itself, no LLM tokens. Always cheap, always available.
- **`pubmed_grade` — precise LLM grading.** Given a single PMID, an LLM verifies the study-type classification, extracts PICO (population/intervention/comparison/outcome), sample size, effect size, funding source, and red flags (conflicts of interest, tiny samples, preprints, retractions). Costs tokens, and is meant to be used selectively on the papers that matter. If the LLM is unavailable or times out, it transparently falls back to the keyword grade instead of failing.

Use `pubmed_search` to triage a query, then `pubmed_grade` on the handful of papers you actually need to trust.

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

### `pubmed_search`

Search PubMed and return evidence-graded results using fast keyword heuristics. Always cheap.

| Parameter | Type | Required | Notes |
| --- | --- | --- | --- |
| `query` | `string` | yes | PubMed query. Supports field tags: `[tiab]` (title/abstract), `[mesh]` (MeSH term), `[au]` (author). |
| `maxResults` | `number` | no | Results to return. Default `10`, hard cap `50`. |
| `minEvidenceScore` | `number` | no | Drop results below this evidence score (`0`–`5`). |
| `studyTypes` | `string[]` | no | Keep only these study types (see [Evidence grading system](#evidence-grading-system)). |
| `dateRange` | `{ from?, to? }` | no | Publication date filter, `YYYY-MM-DD`. |
| `sort` | `"relevance" \| "date"` | no | Default `"relevance"`. |

**Returns** `SearchOutput`:

```ts
{
  articles: GradedArticle[]; // NcbiArticle + studyType, evidenceScore, confidence, dosage?, population?, limitations?, gradingMethod
  total: number;             // total hits reported by esearch, before maxResults truncation
  query: string;
  warnings?: string[];
}
```

### `pubmed_grade`

Deep-grade one paper with an LLM: verify study type, extract PICO/sample size/effect size/funding, and flag red flags. Costs tokens; falls back to keyword grading if no LLM is configured or the call times out.

| Parameter | Type | Required | Notes |
| --- | --- | --- | --- |
| `pmid` | `string` | yes | PubMed ID to deep-grade. |
| `abstract` | `string` | no | Abstract text, if already fetched, to skip a network round-trip. |

**Returns** `DeepGradeOutput`:

```ts
{
  pmid: string;
  correctedStudyType: StudyType;
  correctedScore: number;       // LLM-adjusted evidence score, 0-5
  pico: { population?, intervention?, comparison?, outcome? };
  sampleSize?: number;
  effectSize?: string;
  fundingSource?: string;
  redFlags: string[];           // conflicts of interest, tiny sample, preprint, retracted, etc.
  gradingReasoning: string;
  gradingMethod: "llm";
  fallback?: boolean;           // true when the LLM path failed and this is a keyword-derived fallback
  warning?: string;             // present on fallback: why the LLM grade was unavailable
}
```

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

**Known keyword-path weaknesses** (why `pubmed_grade` exists):

- Protocol papers ("we will randomize...") can misread as completed RCTs.
- Meta-analyses that pool poor-quality underlying studies still score a flat `5`.
- Comparative phrasing like "unlike previous randomized trials…" can trigger a false-positive RCT match.
- Animal studies that mention humans only incidentally (e.g. "may inform future human trials") can escape the animal-study downgrade.

`pubmed_grade` resolves all of these by having an LLM actually read and reason about the paper.

## Configuration

| Variable | Required | Description |
| --- | --- | --- |
| `NCBI_EMAIL` | Recommended | Contact email sent with every NCBI request, as NCBI's usage policy asks. |
| `NCBI_API_KEY` | No | Raises the NCBI rate limit from 3 to 10 requests/second. |
| `PUBMED_LLM_PROVIDER` | No | `openai` \| `anthropic` \| `local`. Required for `pubmed_grade` to use the LLM path. |
| `PUBMED_LLM_API_KEY` | Depends on provider | API key for the chosen LLM provider. |
| `PUBMED_LLM_MODEL` | No | Overrides the provider default. Defaults: `openai` → `gpt-4o-mini`, `anthropic` → `claude-haiku-4-5-20251001`, `local` → `llama3.1`. |
| `PUBMED_LLM_BASE_URL` | Required for `local` | OpenAI-compatible endpoint (e.g. Ollama, LM Studio). Optional override for other providers. |
| `PUBMED_CACHE_BACKEND` | No | `memory` (default). `sqlite` is planned for v0.2. |
| `PUBMED_CACHE_PATH` | No | Path for the cache file, when using a persistent backend. |

## MCP client setup

### Hermes / generic stdio (YAML)

```yaml
mcp_servers:
  med-research-mcp:
    command: npx
    args: ["tsx", "/path/to/med-research-mcp/src/mcp/index.ts"]
    env:
      NCBI_EMAIL: "you@example.com"
      NCBI_API_KEY: ""
      PUBMED_LLM_PROVIDER: "anthropic"
      PUBMED_LLM_API_KEY: ""
```

### Claude Desktop / Cursor (JSON)

Run `npm run build` first, then point the client at the built output:

```json
{
  "mcpServers": {
    "med-research-mcp": {
      "command": "node",
      "args": ["/path/to/med-research-mcp/dist/mcp/index.js"],
      "env": {
        "NCBI_EMAIL": "you@example.com",
        "NCBI_API_KEY": "",
        "PUBMED_LLM_PROVIDER": "anthropic",
        "PUBMED_LLM_API_KEY": ""
      }
    }
  }
}
```

### Claude Desktop via `.mcpb`

```bash
npm run build:mcpb
```

Then drag the resulting `dist/med-research-mcp.mcpb` onto Claude Desktop. The installer prompts for your NCBI contact email and LLM API key at install time — no manual JSON editing required.

## Agent skills

This repo ships two [Agent Skills](skills/) that make the MCP self-guiding:

- **[pubmed-research](skills/pubmed-research/SKILL.md)** — teaches an AI how to drive the two tools well: precise PubMed queries with field tags, reading the evidence grades (scores, confidence, limitations), when to escalate from the cheap keyword grade to LLM deep-grading, and how to report findings (cite PMIDs, surface red flags, not-medical-advice).
- **[pubmed-mcp-setup](skills/pubmed-mcp-setup/SKILL.md)** — guides an AI helping a user install, configure, and troubleshoot the server across clients (Claude Code, Claude Desktop `.mcpb`, Cursor, Hermes) and credentials.

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
import { searchPubMed, gradeArticle } from "med-research-mcp/core";
import { createCache } from "med-research-mcp/core/cache";

const cache = createCache({ backend: "memory" });

const results = await searchPubMed(
  { query: "creatine AND cognition[tiab]", maxResults: 10 },
  cache,
);
```

Thanks to the dual ESM/CJS build, this works whether the consuming project uses `import` or `require`.

## Caching

In v0.1.0, caching is an in-memory LRU (roughly 200 entries) that dies with the process. A SQLite-backed cache — surviving restarts, with a 30-day TTL for summaries/abstracts and indefinite retention for LLM grades — is planned for v0.2.

## Error handling

Every failure path surfaces a typed `PubMedError`:

```ts
{
  code: "RATE_LIMIT" | "QUERY_TOO_BROAD" | "NO_ABSTRACT" | "PARSE_FAILURE"
      | "LLM_UNAVAILABLE" | "LLM_TIMEOUT" | "NETWORK_ERROR" | "NOT_FOUND";
  message: string;       // human-readable, for logs
  userMessage: string;   // actionable phrasing for the agent/user
  recoverable: boolean;  // whether retrying or adjusting can succeed
  retryAfter?: number;   // seconds to wait before retrying (rate limits)
}
```

`LLM_UNAVAILABLE` and `LLM_TIMEOUT` are not fatal to `pubmed_grade` — they cause it to degrade gracefully to a keyword-derived grade (with `fallback: true` and a `warning` explaining why) rather than returning an error.

## v0.1.0 scope

**In scope:**
- PubMed search via NCBI eutils, with field-tag support (`[tiab]`, `[mesh]`, `[au]`).
- Fast keyword-based evidence grading on every search result.
- Precise LLM-based deep grading of a single paper, with OpenAI / Anthropic / local (OpenAI-compatible) providers.
- In-memory caching.
- MCP stdio server and a `.mcpb` bundle for Claude Desktop.
- Direct, dependency-free library use via `med-research-mcp/core`.

**Out of scope (for now):**
- Persistent (SQLite) caching — planned for v0.2.
- Full-text article retrieval (abstract only).
- Batch/bulk LLM grading of multiple papers in one call.
- Any storage or transmission of PHI/patient data.

## Medical disclaimer

`med-research-mcp` is a research and evidence-triage tool. It does not provide medical advice, diagnosis, or treatment recommendations, and its evidence grades — whether keyword- or LLM-derived — are heuristics, not a substitute for clinical judgement or a qualified professional. Always verify findings against the primary source and consult a healthcare provider before making medical or supplementation decisions.

## License

MIT
