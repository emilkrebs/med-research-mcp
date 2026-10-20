# Publishing a release

How to publish a version to npm, GitHub and ModelScope's MCP Square. The order matters: ModelScope installs the server from npm and reads the README from GitHub.

## 1. Before the first release

- **Make the GitHub repository public.** ModelScope's quick create reads the README from GitHub, the README's logo loads from `raw.githubusercontent.com`, and the install instructions clone the repository and link its releases. npm also generates provenance only for packages published from a public repository.
- **Register the tool name with NCBI.** NCBI's usage guidelines say that sending `tool` and `email` "is not sufficient to comply with this policy; these values must be registered with NCBI" ([NBK25497](https://www.ncbi.nlm.nih.gov/books/NBK25497/)). Email <eutilities@ncbi.nlm.nih.gov> with the tool name `med-research-mcp`, your contact email, your name and the repository URL. It's a one-off.
- **Read the terms of the services the server calls** ([compliance.md](compliance.md#upstream-services)), and ModelScope's [user agreement](https://www.modelscope.cn/docs/agreements/terms) before submitting there (see [step 5](#5-modelscope-mcp-square)).

## 2. Prepare the version

1. Make sure CI is green on `main`.
2. Set the version in `package.json` with `npm version <x.y.z> --no-git-tag-version`, then in `mcpb/manifest.json`, `plugin.json` and `mcp.json` (`build:mcpb` refuses a manifest version that differs from `package.json`). A pre-release has a suffix: `0.6.0-next.0`, `0.6.0-next.1`, …
3. In [CHANGELOG.md](../CHANGELOG.md), replace "(unreleased)" with the date. Leave it for a pre-release.
4. Run the checks the release depends on:

   ```bash
   npm ci
   npm run typecheck && npm test
   npm run build && npm run build:mcpb
   npm pack --dry-run   # should list dist/core, dist/mcp, dist/http, src, skills, mcpb/manifest.json
   ```

5. Commit and push to `main`, or merge a pull request with the change.

## 3. GitHub release

Publishing a release publishes the package to npm ([step 4](#4-npm)). Build the `.mcpb` from `main` and create the release with the changelog section as its notes:

```bash
git switch main && git pull
npm run build:mcpb
gh release create v<x.y.z> dist/med-research-mcp.mcpb --target main --title v<x.y.z> --notes-file <notes.md>
```

For a pre-release, add `--prerelease` (on the website: "Set as a pre-release"). The workflow refuses a release whose pre-release setting doesn't match the version. The README's Claude Desktop instructions link to the latest release's `.mcpb`, and GitHub's latest release skips pre-releases, so that link keeps pointing at the last release.

## 4. npm

[`publish.yml`](../.github/workflows/publish.yml) runs when a release is published. It checks that the tag is `v` plus the version in `package.json` and that the release's pre-release setting matches the version, runs the typecheck and tests, and runs `npm publish`. It authenticates with [trusted publishing](https://docs.npmjs.com/trusted-publishers), with no token, and npm adds provenance. A pre-release goes to the `next` dist-tag and any other version to `latest`, so `npx med-research-mcp` keeps installing the last release and `med-research-mcp@next` the pre-release.

The job runs in the `publish` environment. To require an approval before each publish, add required reviewers under the repository's Settings → Environments → publish.

A run that fails before `npm publish` has published nothing. Fix the cause and re-run it; if the fix needs a new commit, delete the release and its tag and create them again.

Once it has published, check the package the way a client runs it, from a directory outside the repository and with no environment variables set: it must start, keep stdout clean (stdout is the MCP channel; logs go to stderr), and list three tools.

```bash
cd "$(mktemp -d)"
printf '%s\n' \
  '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"check","version":"0"}}}' \
  '{"jsonrpc":"2.0","method":"notifications/initialized"}' \
  '{"jsonrpc":"2.0","id":2,"method":"tools/list","params":{}}' \
  | npx -y med-research-mcp@<x.y.z>
```

### The first publish

npm only takes a trusted publisher for a package that exists, so the first version, a pre-release, is published from your machine, and the second one through the workflow:

1. Prepare `0.6.0-next.0` as in [step 2](#2-prepare-the-version).
2. On `main`, at that commit:

   ```bash
   npm login
   npm publish --tag next   # prepublishOnly rebuilds dist/
   git tag v0.6.0-next.0 && git push origin v0.6.0-next.0
   ```

   npm refuses a pre-release without `--tag`. This version has no provenance; npm generates it only in CI. Don't create a GitHub release for it: the workflow would try to publish the version again and fail.
3. Prepare `0.6.0-next.1`.
4. On npmjs.com, add a trusted publisher under the package's Settings → Trusted publishing: GitHub Actions, user `emilkrebs`, repository `med-research-mcp`, workflow filename `publish.yml`, environment `publish` (all case-sensitive). Under allowed actions, allow `npm publish`; otherwise only [staged publishing](https://docs.npmjs.com/staged-publishing) is allowed. A new configuration expires if it hasn't published within 2 days, which is why the next version is ready first.
5. Create the release for `v0.6.0-next.1` as a pre-release ([step 3](#3-github-release)). The workflow publishes it to `next`, and its npm page should show provenance.
6. Under Settings → Publishing access, choose "Require two-factor authentication and disallow tokens". The workflow doesn't use a token, so it keeps working.

## 5. ModelScope MCP Square

ModelScope lists MCP servers at <https://www.modelscope.cn/mcp> and can host npm-published ones for its users. These rules were checked against ModelScope's documentation (["创建MCP服务"](https://www.modelscope.cn/docs/mcp/create), [limits](https://www.modelscope.cn/docs/mcp/limits), docs build of 2026-10-09) on 2026-10-19. The ones marked † come from the creation form in ModelScope's web app rather than its documentation. Recheck them when submitting.

**What ModelScope needs:**

- **An npm package.** Hosting works only for configs whose `command` is `npx` or `uvx`; it doesn't install from GitHub or a URL.
- **A README whose first `mcpServers` JSON block is the stdio config.** Quick create takes the server config from the README ("当前快速创建仅支持在Github仓库 README 正文中提供了有效的STDIO类型服务配置时可用"), and the environment variables from that block's `env` keys. In this README that's the block under "Cursor, Windsurf, Cline and other clients". Keep it first, keep it free of comments, and keep `mcpServers` at the top level.
- **Absolute links.**† ModelScope renders a link that doesn't start with `http` as plain text, and drops images whose `src` doesn't. The README uses absolute GitHub URLs for files and images for this reason; in-page `#anchors` show as plain text there.

**Creating the listing** at <https://modelscope.cn/mcp/servers/create>, with "quick create" from GitHub:

| Field | Value |
| --- | --- |
| GitHub URL | `https://github.com/emilkrebs/med-research-mcp` |
| English name | `med-research-mcp`. **Permanent**†: it can't be changed, and a deleted listing's name can't be reused |
| Chinese display name | Optional; ModelScope translates the English name if left empty |
| Owner, visibility | Your account; listings are always public |
| Hosting type | "可托管部署" (hostable) or "仅本地可用" (local only); see below |
| Categories (up to 3†) | `research-and-data` (学术研究), `scientific-tool` (科研工具), optionally `search` |
| Tags | e.g. `pubmed`, `europe-pmc`, `evidence-based-medicine`, `循证医学` |
| Icon | `mcpb/icon.png` |

**After creating it, in Settings:**

- **Server config.** ModelScope recommends the `@latest` suffix for hosted packages: `"args": ["-y", "med-research-mcp@latest"]`.
- **Environment variables.** Make them all optional. A required variable needs a working test value on a hostable listing†, and **test values are public**† (they appear in the page's data), so never enter a real API key or a private email. List `NCBI_EMAIL`, `NCBI_API_KEY`, `MED_RESEARCH_UNPAYWALL_EMAIL` and `MED_RESEARCH_CHINAXIV_EMAIL` with a description and a "详细指引" (how to get it). Leave out `MED_RESEARCH_PROXY_PREFIX` and the cache variables: an institution's subscriptions don't extend to ModelScope's users ([hosting.md](hosting.md#environment-variables)), and a hosted instance has no persistent disk.
- **The AI-written description and categories.** Check them; quick create generates both.
- **The Chinese translation of the README.** ModelScope machine-translates it ("翻译版本为平台自动完成，仅供参考"). Read the translated medical disclaimer, privacy note and label explanations, since medical wording suffers most in translation.
- **The intended use, in Chinese,** in the description or at the top of the Chinese README, so the listing can't be read as a medical service ([compliance.md](compliance.md#intended-use)). Suggested wording, to be checked by a native speaker:

  > 预期用途：本工具是面向科研与教育的学术文献检索工具，用于检索 PubMed、Europe PMC、ChinaRxiv 等数据库中已发表的科学文献，依据文献元数据标注研究设计类型，并获取可公开获取的全文，或在用户自行配置时经其所在机构获取的全文。本工具不用于任何疾病的诊断、预防、监护、治疗或者缓解，不提供用药指导或治疗建议，不用于针对具体患者的诊疗决策，不处理患者数据，不作为医疗器械使用。研究设计标注仅反映文献的索引信息，不代表研究结论可靠或适用于任何个人。如有健康问题，请咨询医生。

- **How results are ranked, in Chinese,** since China's algorithm-recommendation provisions ask services that rank results to explain the basic principles ([compliance.md](compliance.md#china-modelscope)). Suggested wording:

  > 排序说明：检索结果按研究设计等级排序（依据牛津循证医学中心 2011 年证据等级与美国国家医学图书馆的文献类型标注）：设计等级 5 至 2 级的文献依次排在最前，其次为未评级的文献，最后为 1 级和 0 级的文献；同一等级内保留各数据库的原始顺序。不使用个人数据，不做个性化推荐。

- **The description** should call it literature search, including on dietary supplements (膳食补充剂相关文献检索), and make no efficacy or treatment claims.

**Hostable or local only.** A hostable listing runs the server for ModelScope users in an isolated environment on Alibaba Cloud, after a deploy check that installs the package and calls `tools/list` (only the first config is deployed, stdio first, with no fallback to other configs). Before choosing it, consider:

- **The hosted Node version is undocumented.** The package needs Node 22.22.2+ (24.15+, 26+). The server starts on older versions with a warning, but full-text extraction may not work. If the deploy check fails, this is the first suspect.
- **Reaching the databases from mainland China is unverified.** Other hosted listings call overseas APIs, but whether NCBI, EMBL-EBI, Unpaywall, doi.org and ChinaRxiv answer reliably from ModelScope's network isn't documented. After the check passes, run all three tools on the "工具测试" (tool test) tab.
- **Shared egress addresses.** Many hosted users may share outbound IPs, and NCBI rate-limits per IP; users should set their own `NCBI_EMAIL` and `NCBI_API_KEY` when connecting.
- **Data flows.** Hosted users' queries pass through ModelScope's infrastructure as well as the databases'; [compliance.md](compliance.md#data-flows) describes them.
- **Free-tier limits** apply to hosted connections (at the time of checking: 500 requests per 5 seconds across all free deployments, and 50,000 requests per user).

"仅本地可用" lists the server without hosting; users copy the `npx` config into their own client. It's the safe choice if the deploy check or the tool test fails.

**ModelScope's terms to know** ([user agreement](https://www.modelscope.cn/docs/agreements/terms), checked 2026-10-19). Content published there is reviewed for prohibited material (political, pornographic, violent, illegal, advertising or spam). Publishing grants ModelScope a worldwide, irrevocable, sublicensable licence to host and distribute it, and every user a perpetual, irrevocable licence to use, copy and adapt it through ModelScope (§3.2.1; compatible with the MIT license). The agreement is governed by Chinese law (§9.5), registration requires phone verification (§2.2.2), and the service "旨在供中华人民共和国内地用户使用" — is intended for users in mainland China, without a guarantee for anyone else (§10.2).

**On each later release:** ModelScope doesn't re-read the README by itself. Update the README and config in the listing's Settings; hosted connections with `@latest` pick up the new npm version. Pre-releases go to `next` and leave the listing alone.

Questions about a listing: DingTalk group 44837352, as ModelScope's [contribution article](https://www.modelscope.cn/headlines/article/1189) gives.

## 6. Optional: the MCP Registry

The official [MCP Registry](https://modelcontextprotocol.io/registry/quickstart) lists servers by metadata (`server.json`) and verifies npm packages through an `mcpName` field in `package.json`. ModelScope's documentation doesn't mention it, so it isn't needed for the steps above.
