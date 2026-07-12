---
name: pubmed-mcp-setup
description: Use when helping a user install, configure, or troubleshoot the pubmed-bio MCP server (evidence-graded PubMed search). Walks through building the project, registering it with an MCP client (Claude Code, Claude Desktop via .mcpb, Cursor, Hermes) or importing the core library directly, wiring up NCBI and LLM credentials, and verifying it works. Trigger on "install the pubmed MCP", "set up pubmed-bio", "configure PubMed search", or connection/credential problems with it.
---

# Installing & setting up the pubmed-bio MCP

Guide the user through this. **Gather three things first, then run the right path.** Don't dump every option — ask, then act.

## Step 0 — Gather

Ask the user (or infer from context):
1. **Which client?** Claude Code (CLI), Claude Desktop, Cursor, Hermes, or direct library import (Biohacking-IDE).
2. **NCBI contact email** — strongly recommended; NCBI asks for one on every request and throttles anonymous traffic. (Optional: an NCBI API key, which raises the rate limit from 3 to 10 req/s.)
3. **LLM for deep grading?** Optional. Provider (`openai` / `anthropic` / `local`) + API key enables the `pubmed_grade` tool. Without it, `pubmed_grade` falls back to keyword grading — perfectly fine to skip at first.

Find the repo's absolute path (`pwd` inside it, or locate `pubmed-bio-mcp`). Substitute it for `<REPO>` below.

## Step 1 — Build

```bash
cd <REPO>
npm install
npm run build          # produces dist/ (dual ESM+CJS + .d.ts)
npm test               # optional: 29 tests should pass
```

Requires Node ≥ 18. Re-run `npm run build` after any source change — clients run the compiled `dist/`.

## Step 2 — Register with the chosen client

### Claude Code (CLI)
```bash
claude mcp add pubmed-bio -s user \
  -e NCBI_EMAIL=you@example.com \
  -- node <REPO>/dist/mcp/index.js
```
Use `-s user` for all projects, `-s local` for just this one. Add `-e PUBMED_LLM_PROVIDER=anthropic -e PUBMED_LLM_API_KEY=sk-...` to enable deep grading. Verify:
```bash
claude mcp get pubmed-bio      # expect: Status ✓ Connected
```
Tools appear in **new** Claude Code sessions.

### Claude Desktop (.mcpb — easiest for non-technical users)
```bash
npm run build:mcpb             # produces dist/pubmed-bio.mcpb
```
Drag `dist/pubmed-bio.mcpb` onto Claude Desktop. The installer prompts for the NCBI email and (optional) LLM key — no JSON editing. Note: `.mcpb` installs do **not** auto-load the companion `pubmed-research` skill; copy it in manually (Step 4).

### Cursor / generic JSON (`mcpServers`)
```json
{
  "mcpServers": {
    "pubmed-bio": {
      "command": "node",
      "args": ["<REPO>/dist/mcp/index.js"],
      "env": { "NCBI_EMAIL": "you@example.com" }
    }
  }
}
```

### Hermes / generic stdio (YAML) — runs TypeScript source directly, no build needed
```yaml
mcp_servers:
  pubmed-bio:
    command: npx
    args: ["tsx", "<REPO>/src/mcp/index.ts"]
    env:
      NCBI_EMAIL: "you@example.com"
      # optional:
      # NCBI_API_KEY: "..."
      # PUBMED_LLM_PROVIDER: "openai"
      # PUBMED_LLM_API_KEY: "sk-..."
```

### Direct library import (Biohacking-IDE / any TS project)
Add as a git submodule (or dependency), then `import { searchPubMed, gradeArticle } from "pubmed-bio/core"` and `import { createCache } from "pubmed-bio/core/cache"`. The dual ESM+CJS build means both ESM and CommonJS consumers work.

## Step 3 — Environment reference

| Var | Needed? | Purpose |
|-----|---------|---------|
| `NCBI_EMAIL` | recommended | Contact email; avoids anonymous throttling |
| `NCBI_API_KEY` | optional | Raises rate limit 3 → 10 req/s |
| `PUBMED_LLM_PROVIDER` | optional | `openai` \| `anthropic` \| `local` — enables `pubmed_grade` |
| `PUBMED_LLM_API_KEY` | with provider | Key for that provider |
| `PUBMED_LLM_MODEL` | optional | Override default (openai `gpt-4o-mini`, anthropic `claude-haiku-4-5-20251001`, local `llama3.1`) |
| `PUBMED_LLM_BASE_URL` | for `local` | OpenAI-compatible endpoint (Ollama/LM Studio) |
| `PUBMED_CACHE_BACKEND` | optional | `memory` (default). `sqlite` is planned for v0.2 |

## Step 4 — Install the companion usage skill

So the AI actually uses the tools well, install `pubmed-research`:
```bash
mkdir -p ~/.claude/skills && cp -r <REPO>/skills/pubmed-research ~/.claude/skills/
```
(Use `.claude/skills/` for a single project.)

## Step 5 — Verify

Start a new session with the client and run a `pubmed_search` for `creatine AND cognition[tiab]` (maxResults 3). Expect a few graded articles with study types and 0–5 evidence scores. If deep grading is configured, `pubmed_grade` on one PMID should return PICO + red flags.

## Troubleshooting

- **"No such file … dist/mcp/index.js"** → run `npm run build` (or point the client at `npx tsx <REPO>/src/mcp/index.ts` instead).
- **Tools don't show up** → MCP servers load at client startup; restart the session.
- **Throttling / RATE_LIMIT** → set `NCBI_EMAIL`; add `NCBI_API_KEY` for higher limits.
- **`pubmed_grade` returns `fallback: true`** → no/invalid LLM provider or key, or it timed out; keyword grade was returned instead. Add/fix `PUBMED_LLM_*`.
- **`QUERY_TOO_BROAD`** → the query is too generic; add `[tiab]`/`[mesh]` field tags or `AND` clauses.
- **Changed the source** → rebuild (`npm run build`); the `tsx`/Hermes path picks up source automatically.
- **Connection check** (Claude Code): `claude mcp get pubmed-bio`. Remove with `claude mcp remove pubmed-bio -s user`.
