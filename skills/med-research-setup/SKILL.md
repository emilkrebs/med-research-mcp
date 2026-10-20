---
name: med-research-setup
description: Use when helping a user install, configure, or troubleshoot the med-research-mcp MCP server (evidence-graded multi-database literature search). Walks through registering it with an MCP client (Claude Code, Claude Desktop via .mcpb, Cursor and other JSON configs, Hermes and other YAML configs) via npx or a source build, connecting to a self-hosted HTTP instance, importing the core library directly, wiring up NCBI credentials, installing the companion skills, and verifying it works. Trigger on "install the med-research MCP", "set up med-research-mcp", "configure literature search", or connection/credential problems with it.
---

# Installing & setting up the med-research-mcp MCP

Guide the user through this. **Gather two things first, then run the right path.** Don't dump every option — ask, then act.

## Step 0 — Gather

Ask the user (or infer from context):
1. **Which client?** Claude Code (CLI), Claude Desktop, Cursor or another JSON-config client, Hermes or another YAML-config client, a self-hosted HTTP instance, or direct library import.
2. **NCBI contact email** — strongly recommended; NCBI's usage policy asks for one on every request, so NCBI can reach the user before blocking their IP. (Optional: an NCBI API key, which raises the rate limit from 3 to 10 req/s.)

Requires Node.js 22.22.2 or later on 22, 24.15.0 or later on 24, or 26+ (`node --version`).

## Step 1 — Register with the chosen client

The package runs straight from npm with `npx -y med-research-mcp`; no clone or build needed. To run from a clone instead, see Step 1b.

### Claude Code (CLI)
```bash
claude mcp add med-research-mcp -s user \
  -e NCBI_EMAIL=you@example.com \
  -- npx -y med-research-mcp
```
Use `-s user` for all projects, `-s local` for just this one. Verify:
```bash
claude mcp get med-research-mcp      # expect: Status ✓ Connected
```
Tools appear in **new** Claude Code sessions.

### Claude Desktop (.mcpb — easiest for non-technical users)
Download `med-research-mcp.mcpb` from the repository's latest GitHub release (or build it: `npm run build:mcpb` in a clone writes `dist/med-research-mcp.mcpb`) and drag it onto Claude Desktop. The installer offers optional fields for the NCBI contact email, an NCBI API key, an Unpaywall email and an institutional proxy prefix — no JSON editing. Note: `.mcpb` installs do **not** load the companion skills; see Step 3.

### Cursor and other JSON configs (`mcpServers`)
```json
{
  "mcpServers": {
    "med-research-mcp": {
      "command": "npx",
      "args": ["-y", "med-research-mcp"],
      "env": { "NCBI_EMAIL": "you@example.com" }
    }
  }
}
```

### Hermes and other YAML configs
```yaml
mcp_servers:
  med-research-mcp:
    command: npx
    args: ["-y", "med-research-mcp"]
    env:
      NCBI_EMAIL: "you@example.com"
      # optional:
      # NCBI_API_KEY: "..."
```

### A self-hosted HTTP instance
If the user (or their team) runs the HTTP entry (`npm run start:http`, see `docs/hosting.md` in the repository), point the client at it instead:
```json
{
  "mcpServers": {
    "med-research-mcp": {
      "type": "http",
      "url": "https://their-host/mcp",
      "headers": { "Authorization": "Bearer <token>" }
    }
  }
}
```
There is no public instance. On an HTTP instance, full texts resolve through open access only (no institutional proxy).

### Direct library import (any Node project)
`npm install med-research-mcp`, then `import { searchLiterature, fetchLiterature, fetchFulltext, createCache } from "med-research-mcp/core"`. The build ships ESM and CommonJS, so `import` and `require` both work.

## Step 1b — From a clone (development, or before a release reaches npm)

```bash
git clone https://github.com/emilkrebs/med-research-mcp.git
cd med-research-mcp
npm install
npm run build          # produces dist/
```
Find the absolute path (`pwd`) and use `node <REPO>/dist/mcp/index.js` as the command (args: `["<REPO>/dist/mcp/index.js"]`) in any config above. Re-run `npm run build` after source changes, or run the source directly with `npx tsx <REPO>/src/mcp/index.ts`.

## Step 2 — Environment reference

| Var | Needed? | Purpose |
|-----|---------|---------|
| `NCBI_EMAIL` | recommended | Contact email NCBI's usage policy asks for, so NCBI can reach the user before blocking an IP; without it, requests carry the project's contact address. Also the fallback for the two emails below. |
| `NCBI_API_KEY` | optional | Raises the NCBI rate limit from 3 to 10 req/s |
| `MED_RESEARCH_CHINAXIV_EMAIL` | optional | Contact email sent to ChinaRxiv (`chinaxiv`, `russiarxiv`); raises its limit from 30 to 300 requests/minute. Falls back to `NCBI_EMAIL`. |
| `MED_RESEARCH_UNPAYWALL_EMAIL` | optional | Contact email for Unpaywall lookups (`literature_fulltext`). Falls back to `NCBI_EMAIL`, then to the project's contact address. |
| `MED_RESEARCH_UNPAYWALL` | optional | `0` turns the Unpaywall lookups off, so no DOI is sent there; full texts then come only from Europe PMC, the proxy and the DOI itself. |
| `MED_RESEARCH_PROXY_PREFIX` | optional | EZproxy-style DOI prefix for off-campus full text — `literature_fulltext` prepends it to the DOI, e.g. `https://doi-org.ezproxy.your-university.edu`. Works only if the proxy lets the machine in without a login (campus network or VPN); a proxy login in the browser isn't used. Use only if the institution's licences allow it: many publishers forbid using subscription content with AI tools. |
| `MED_RESEARCH_CACHE_BACKEND` | optional | `memory` (default) or `sqlite` (persistent, survives restarts). `sqlite` needs `better-sqlite3`, an optional native dependency; if it isn't installed or fails to load, the server warns and uses `memory`. `.mcpb` installs always use `memory`. |
| `MED_RESEARCH_CACHE_PATH` | optional | SQLite file path when the backend is `sqlite` (default `./pubmed-cache.db`, relative to the directory the client starts the server in, so use an absolute path; `:memory:` for ephemeral). |
| `MED_RESEARCH_FULLTEXT_MAX_CHARS` | optional | Cap on returned full-text length. Default 50000; longer bodies are truncated (`truncated: true`). |
| `MED_RESEARCH_FULLTEXT_ALLOW_PRIVATE` | optional | `1` lets full-text fetches reach private or reserved addresses, refused by default. Only for a personal machine behind a fake-IP DNS proxy (Clash, Surge, sing-box TUN mode) or split-horizon DNS — never on a shared server. |

## Step 3 — Install the companion skills

So the AI actually uses the tools well, install the usage skill `med-research` and its critical-appraisal reference `med-research-ebm` (the workflow skill loads the EBM one on demand). From a clone:
```bash
mkdir -p ~/.claude/skills && cp -r <REPO>/skills/med-research <REPO>/skills/med-research-ebm ~/.claude/skills/
```
Without a clone, fetch them first: `git clone --depth 1 https://github.com/emilkrebs/med-research-mcp.git /tmp/med-research-mcp` and copy from `/tmp/med-research-mcp/skills/`. Use `.claude/skills/` instead of `~/.claude/skills/` for a single project. Skills load in new sessions.

Claude Desktop (and claude.ai) don't read skills from a folder: zip each skill folder (`med-research`, `med-research-ebm`) and upload it under Customize → Skills → "+" → "Upload a skill". "Code execution and file creation" must be on under Settings → Capabilities.

## Step 4 — Verify

Start a new session with the client and run a `literature_search` for `creatine AND cognition[tiab]` (maxResults 3). Expect a few articles with a `studyType` and a 0–5 `designTier` (`null` when unknown — records without NLM design metadata, and most meta-analyses).

## Troubleshooting

- **`npx` fails or hangs** → check `node --version` against the requirement above, and that the machine can reach the npm registry. Behind a corporate proxy, configure npm's proxy settings, or use Step 1b.
- **"No such file … dist/mcp/index.js"** (clone) → run `npm run build`, or point the client at `npx tsx <REPO>/src/mcp/index.ts` instead.
- **Tools don't show up** → MCP servers load at client startup; restart the session.
- **Throttling / RATE_LIMIT** → the error names the database that throttled; wait `retryAfter` seconds. For PubMed, add `NCBI_API_KEY` (10 instead of 3 requests per second), and set `NCBI_EMAIL` so NCBI can reach the user before blocking an IP.
- **`QUERY_TOO_BROAD`** → the query is too generic; add `[tiab]`/`[mesh]` field tags or `AND` clauses.
- **Full text always falls back to the abstract** → the `warning` says what each source answered. Many papers are paywalled. If the warning says locations were refused for their addresses and the user runs a fake-IP DNS proxy (Clash, Surge, sing-box TUN mode), set `MED_RESEARCH_FULLTEXT_ALLOW_PRIVATE=1` on their personal machine. Otherwise, or, where the user's institution licenses this use, configure `MED_RESEARCH_PROXY_PREFIX` (it works only if the proxy lets the machine in without a login, e.g. on the campus network or VPN).
- **Connection check** (Claude Code): `claude mcp get med-research-mcp`. Remove with `claude mcp remove med-research-mcp -s user`.
