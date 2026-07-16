---
name: med-research-setup
description: Use when helping a user install, configure, or troubleshoot the med-research-mcp MCP server (evidence-graded multi-database literature search). Walks through building the project, registering it with an MCP client (Claude Code, Claude Desktop via .mcpb, Cursor, Hermes) or importing the core library directly, wiring up NCBI credentials, and verifying it works. Trigger on "install the med-research MCP", "set up med-research-mcp", "configure literature search", or connection/credential problems with it.
---

# Installing & setting up the med-research-mcp MCP

Guide the user through this. **Gather three things first, then run the right path.** Don't dump every option — ask, then act.

## Step 0 — Gather

Ask the user (or infer from context):
1. **Which client?** Claude Code (CLI), Claude Desktop, Cursor, Hermes, or direct library import (Biohacking-IDE).
2. **NCBI contact email** — strongly recommended; NCBI asks for one on every request and throttles anonymous traffic. (Optional: an NCBI API key, which raises the rate limit from 3 to 10 req/s.)

Find the repo's absolute path (`pwd` inside it, or locate `med-research-mcp`). Substitute it for `<REPO>` below.

## Step 1 — Build

```bash
cd <REPO>
npm install
npm run build          # produces dist/ (dual ESM+CJS + .d.ts)
npm test               # optional: 80 tests should pass
```

Requires Node ≥ 18. Re-run `npm run build` after any source change — clients run the compiled `dist/`.

## Step 2 — Register with the chosen client

### Claude Code (CLI)
```bash
claude mcp add med-research-mcp -s user \
  -e NCBI_EMAIL=you@example.com \
  -- node <REPO>/dist/mcp/index.js
```
Use `-s user` for all projects, `-s local` for just this one. Verify:
```bash
claude mcp get med-research-mcp      # expect: Status ✓ Connected
```
Tools appear in **new** Claude Code sessions.

### Claude Desktop (.mcpb — easiest for non-technical users)
```bash
npm run build:mcpb             # produces dist/med-research-mcp.mcpb
```
Drag `dist/med-research-mcp.mcpb` onto Claude Desktop. The installer prompts for the NCBI contact email (required) plus optional NCBI API key, Unpaywall email, and institutional proxy prefix — no JSON editing. Note: `.mcpb` installs do **not** auto-load the companion skills; copy them in manually (Step 4).

### Cursor / generic JSON (`mcpServers`)
```json
{
  "mcpServers": {
    "med-research-mcp": {
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
  med-research-mcp:
    command: npx
    args: ["tsx", "<REPO>/src/mcp/index.ts"]
    env:
      NCBI_EMAIL: "you@example.com"
      # optional:
      # NCBI_API_KEY: "..."
```

### Direct library import (Biohacking-IDE / any TS project)
Add as a git submodule (or dependency), then `import { searchLiterature, fetchLiterature, fetchFulltext } from "med-research-mcp/core"` and `import { createCache } from "med-research-mcp/core/cache"`. The dual ESM+CJS build means both ESM and CommonJS consumers work.

## Step 3 — Environment reference

| Var | Needed? | Purpose |
|-----|---------|---------|
| `NCBI_EMAIL` | recommended | Contact email; avoids anonymous throttling |
| `NCBI_API_KEY` | optional | Raises rate limit 3 → 10 req/s |
| `MED_RESEARCH_UNPAYWALL_EMAIL` | optional | Contact email for Unpaywall lookups (`literature_fulltext`). Falls back to `NCBI_EMAIL`. |
| `MED_RESEARCH_PROXY_PREFIX` | optional | EZproxy-style DOI prefix for off-campus full-text — `literature_fulltext` prepends it to the DOI, e.g. `https://doi-org.ezproxy.your-university.edu`. Needs an existing proxy session on the machine. |
| `MED_RESEARCH_CACHE_BACKEND` | optional | `memory` (default) or `sqlite` (persistent, survives restarts — used by the Biohacking-IDE integration). `better-sqlite3` is bundled. |
| `MED_RESEARCH_CACHE_PATH` | optional | SQLite file path when the backend is `sqlite` (default `./pubmed-cache.db`; `:memory:` for ephemeral). |
| `MED_RESEARCH_FULLTEXT_MAX_CHARS` | optional | Cap on returned full-text length. Default 50000; longer bodies are truncated (`truncated: true`). |

## Step 4 — Install the companion skills

So the AI actually uses the tools well, install the usage skill `med-research` and its critical-appraisal reference `med-research-ebm` (the workflow skill loads the EBM one on demand):
```bash
mkdir -p ~/.claude/skills && cp -r <REPO>/skills/med-research <REPO>/skills/med-research-ebm ~/.claude/skills/
```
(Use `.claude/skills/` for a single project.)

## Step 5 — Verify

Start a new session with the client and run a `literature_search` for `creatine AND cognition[tiab]` (maxResults 3). Expect a few graded articles with study types and 0–5 evidence scores.

## Troubleshooting

- **"No such file … dist/mcp/index.js"** → run `npm run build` (or point the client at `npx tsx <REPO>/src/mcp/index.ts` instead).
- **Tools don't show up** → MCP servers load at client startup; restart the session.
- **Throttling / RATE_LIMIT** → set `NCBI_EMAIL`; add `NCBI_API_KEY` for higher limits.
- **`QUERY_TOO_BROAD`** → the query is too generic; add `[tiab]`/`[mesh]` field tags or `AND` clauses.
- **Changed the source** → rebuild (`npm run build`); the `tsx`/Hermes path picks up source automatically.
- **Connection check** (Claude Code): `claude mcp get med-research-mcp`. Remove with `claude mcp remove med-research-mcp -s user`.
