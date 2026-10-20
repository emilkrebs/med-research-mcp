<p align="center">
  <img src="https://raw.githubusercontent.com/emilkrebs/med-research-mcp/main/mcpb/icon.png" alt="med-research-mcp icon" width="120" height="120">
</p>

<h1 align="center">med-research-mcp</h1>

<p align="center">
  <strong>Evidence-graded scientific literature search for AI agents.</strong>
</p>

<p align="center">
  <a href="#install">Install</a> ·
  <a href="#configuration">Configuration</a> ·
  <a href="#tools">Tools</a> ·
  <a href="#agent-skills">Skills</a> ·
  <a href="#documentation">Docs</a> ·
  <a href="#medical-disclaimer">Disclaimer</a> ·
  <a href="#data-sources-and-copyright">Data sources</a>
</p>

`med-research-mcp` is an [MCP](https://modelcontextprotocol.io) server that lets an AI assistant search PubMed, Europe PMC, ChinaXiv and RussiaRxiv, and tells it what kind of study each result is. The assistant can then tell a meta-analysis from a case report, and a retracted paper from a sound one, before it answers. It's built for medical, clinical and supplementation research, where "what does the evidence actually say" matters more than a list of abstracts.

- **Four databases in one search**, merged and de-duplicated.
- **Study-design labels from NLM metadata**: each result says what kind of study it is, where that design ranks in the evidence hierarchy, and whether it was retracted or corrected. No guessing: a record without metadata says `unknown`.
- **Full text when the abstract isn't enough**, through open access, your institution's proxy, or the DOI.
- **Agent skills** that teach the assistant to write precise queries, read the labels and appraise evidence.
- **No LLM calls, no accounts, no telemetry.** It runs on your machine.

> [!IMPORTANT]
> This is a research aid, not medical advice and not a diagnostic tool. Don't put anything that identifies a patient into a query: queries are sent to the databases listed under [Privacy](#privacy). See the [medical disclaimer](#medical-disclaimer).

## Install

You need [Node.js](https://nodejs.org) 22.22.2 or later on 22, 24.15.0 or later on 24, or 26+. The server runs straight from npm, so there's nothing to clone or build. In the examples, replace `you@example.com` with your email (see [Configuration](#configuration)).

### Claude Code

```bash
claude mcp add med-research-mcp -s user \
  -e NCBI_EMAIL=you@example.com \
  -- npx -y med-research-mcp
```

`-s user` makes it available in all your projects. `claude mcp get med-research-mcp` checks the connection; the tools appear in new sessions.

### Claude Desktop

Download `med-research-mcp.mcpb` from the [latest release](https://github.com/emilkrebs/med-research-mcp/releases/latest) and drag it onto Claude Desktop. The installer asks for your email and a few optional settings; there's no JSON to edit.

### Cursor, Windsurf, Cline and other clients

Add this to the client's MCP configuration:

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

Clients configured in YAML, such as Hermes, take the same `command`, `args` and `env`.

### From source

```bash
git clone https://github.com/emilkrebs/med-research-mcp.git
cd med-research-mcp
npm install
npm run build
```

Then use `node /path/to/med-research-mcp/dist/mcp/index.js` as the command, and `npm run build:mcpb` builds the Claude Desktop bundle. To run the server as a shared HTTP service for a team, see [docs/hosting.md](https://github.com/emilkrebs/med-research-mcp/blob/main/docs/hosting.md).

## Configuration

Set these in the `env` block of your MCP client's configuration. All are optional, but do set `NCBI_EMAIL`.

| Variable | What it does |
| --- | --- |
| `NCBI_EMAIL` | Your contact email, sent with every NCBI (PubMed) request as its usage policy asks, so NCBI can reach you before blocking an IP that exceeds its limits. Also used for Unpaywall and ChinaRxiv when their own emails aren't set. |
| `NCBI_API_KEY` | Raises the PubMed rate limit from 3 to 10 requests per second. Get one in your [NCBI account settings](https://www.ncbi.nlm.nih.gov/account/settings/). |
| `MED_RESEARCH_UNPAYWALL_EMAIL` | Contact email for Unpaywall, which finds open-access full texts. |
| `MED_RESEARCH_CHINAXIV_EMAIL` | Contact email for ChinaRxiv, which serves the `chinaxiv` and `russiarxiv` sources; raises its rate limit from 30 to 300 requests per minute. |
| `MED_RESEARCH_PROXY_PREFIX` | Your institution's EZproxy host for doi.org, e.g. `https://doi-org.ezproxy.your-university.edu`, to read paywalled papers you have access to. It works only if the proxy lets this machine in without a login, e.g. on the campus network or VPN. Use it only if your institution's licences allow it: many publishers forbid using subscription content with AI tools. |
| `MED_RESEARCH_FULLTEXT_MAX_CHARS` | Cap on the length of returned full texts. Default `50000`. |
| `MED_RESEARCH_FULLTEXT_ALLOW_PRIVATE` | `1` lets full-text fetches reach private or reserved network addresses, which the server otherwise refuses. Needed only on a personal machine behind a fake-IP DNS proxy (Clash, Surge or sing-box in TUN mode) or split-horizon DNS; never set it on a shared server. |
| `MED_RESEARCH_CACHE_BACKEND` | `memory` (default) or `sqlite`, which keeps the cache across restarts. |
| `MED_RESEARCH_CACHE_PATH` | The SQLite file for the `sqlite` backend. Use an absolute path: the default, `./pubmed-cache.db`, is relative to the directory your client starts the server in. |

[`.env.example`](https://github.com/emilkrebs/med-research-mcp/blob/main/.env.example) documents each one, plus the HTTP server's variables.

## Tools

| Tool | What it does |
| --- | --- |
| `literature_search` | Searches one or more databases and labels each result with its study design, design tier and integrity flags. |
| `literature_fetch` | Returns the full record and abstract of specific papers. |
| `literature_fulltext` | Returns a paper's full text as markdown, when an open-access or licensed copy can be found. |

The assistant usually searches first, reads the promising abstracts, and fetches the full text when it needs the methods, dosage or sample size. [docs/tools.md](https://github.com/emilkrebs/med-research-mcp/blob/main/docs/tools.md) has every parameter.

What the labels on each result mean:

- **`studyType`** is the design as NLM indexed it: `meta-analysis`, `randomized-controlled-trial`, `case-report` and so on, or `unknown` when the record has no such metadata. **Unknown means unlabeled, not weak.** It's common for recent papers, journals outside MEDLINE, and the ChinaXiv and RussiaRxiv sources; the assistant reads those abstracts itself.
- **`designTier`** ranks the design for "does this treatment work?", from 5 (a systematic review of randomized trials) down to 0 (animal and lab studies, retracted papers), following the [Oxford CEBM levels of evidence](https://www.cebm.ox.ac.uk/resources/levels-of-evidence/ocebm-levels-of-evidence). It ranks the design, not the quality of the study. It's `null` when the metadata can't place the design: unlabeled records, and most meta-analyses, which rank with the studies they pooled. Null means unrated, not weak.
- **`flags`** warn about retractions, corrections, expressions of concern, preprints, and machine-translated text.

ChinaXiv and RussiaRxiv records come from [ChinaRxiv](https://chinarxiv.org), an independent project not affiliated with the Chinese Academy of Sciences' ChinaXiv. Its English text is machine-translated, and it wrote most RussiaRxiv abstracts itself; check the original record before relying on a dose, population or outcome.

## Agent skills

Three [Agent Skills](https://github.com/emilkrebs/med-research-mcp/tree/main/skills) teach the assistant to use the tools well:

- **[med-research](https://github.com/emilkrebs/med-research-mcp/blob/main/skills/med-research/SKILL.md)**: the workflow. Writing precise PubMed queries, reading the labels, classifying unlabeled papers, and reporting findings with how certain they are.
- **[med-research-ebm](https://github.com/emilkrebs/med-research-mcp/blob/main/skills/med-research-ebm/SKILL.md)**: critical appraisal, loaded only when a conclusion will rest on one paper: risk of bias, effect sizes, heterogeneity, causation, applicability.
- **[med-research-setup](https://github.com/emilkrebs/med-research-mcp/blob/main/skills/med-research-setup/SKILL.md)**: helps an assistant install and troubleshoot the server.

To install them for Claude Code:

```bash
git clone --depth 1 https://github.com/emilkrebs/med-research-mcp.git
mkdir -p ~/.claude/skills && cp -r med-research-mcp/skills/* ~/.claude/skills/
```

Use `.claude/skills/` inside a project to install them for that project only. Skills take effect in new sessions. Claude Desktop doesn't read skills from the `.mcpb` or from `~/.claude/skills/`: zip each skill folder and upload it under Customize → Skills → "+" → "Upload a skill", with "Code execution and file creation" turned on under Settings → Capabilities.

## Privacy

The server runs on your machine and sends no telemetry. Your queries go to the databases you search (NCBI for PubMed, EMBL-EBI for Europe PMC, ChinaRxiv), and full-text requests go to Unpaywall, doi.org and the publishers' sites, each under its own terms and privacy policy. Results are cached on your machine, in memory unless you choose SQLite. If you use someone else's HTTP instance, its operator receives your queries too. Don't put names, record numbers or other details that identify a patient into a query. [docs/compliance.md](https://github.com/emilkrebs/med-research-mcp/blob/main/docs/compliance.md) has the details.

## Documentation

- **[Tool reference](https://github.com/emilkrebs/med-research-mcp/blob/main/docs/tools.md)**: parameters, results, databases, labels and errors.
- **[How it works](https://github.com/emilkrebs/med-research-mcp/blob/main/docs/how-it-works.md)**: the search pipeline, how the design labels are assigned and why, full-text resolution, caching, and how the benchmark grades answers.
- **[Hosting](https://github.com/emilkrebs/med-research-mcp/blob/main/docs/hosting.md)**: running the server over HTTP for a team.
- **[Using the core library](https://github.com/emilkrebs/med-research-mcp/blob/main/docs/library.md)**: the same functions without MCP.
- **[Compliance](https://github.com/emilkrebs/med-research-mcp/blob/main/docs/compliance.md)**: intended use, data flows, and the terms of the services it calls.
- **[Development](https://github.com/emilkrebs/med-research-mcp/blob/main/docs/development.md)** and **[publishing](https://github.com/emilkrebs/med-research-mcp/blob/main/docs/publishing.md)**.
- **[Benchmark](https://github.com/emilkrebs/med-research-mcp/blob/main/benchmark/README.md)**: how well models answer biomedical questions with the server.
- **[Changelog](https://github.com/emilkrebs/med-research-mcp/blob/main/CHANGELOG.md)**.

## Medical disclaimer

`med-research-mcp` is a literature search tool for research and education. It does not provide medical advice, diagnosis, or treatment recommendations, is not meant for decisions about an individual patient's care, and is not a medical device. Its design labels rank how studies were designed, not the quality of individual studies or whether their results apply to anyone. They are not a substitute for clinical judgement or a qualified professional. Always verify findings against the primary source and consult a healthcare provider before making medical or supplementation decisions.

## Data sources and copyright

PubMed data comes from the U.S. National Library of Medicine through NCBI's E-utilities; [NCBI's disclaimer and copyright notice](https://www.ncbi.nlm.nih.gov/home/about/policies/) applies. NLM doesn't claim copyright on PubMed abstracts, but their publishers or authors may, and NLM doesn't endorse this tool. Europe PMC data comes from the Europe PMC REST API (EMBL-EBI), under the [EMBL-EBI terms of use](https://www.ebi.ac.uk/about/terms-of-use). Open-access locations come from [Unpaywall](https://unpaywall.org). ChinaXiv and RussiaRxiv records come from the [ChinaRxiv API](https://chinarxiv.org/api/docs), whose specification declares CC BY 4.0. Full texts belong to their rights holders; use them within their licences.

## License

[MIT](https://github.com/emilkrebs/med-research-mcp/blob/main/LICENSE.md).
