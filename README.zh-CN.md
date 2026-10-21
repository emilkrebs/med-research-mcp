<p align="center">
  <img src="https://raw.githubusercontent.com/emilkrebs/med-research-mcp/main/mcpb/icon.png" alt="med-research-mcp 图标" width="120" height="120">
</p>

<h1 align="center">med-research-mcp</h1>

<p align="center">
  <strong>面向 AI 智能体、按证据等级标注的科学文献检索。</strong>
</p>

<p align="center">
  <a href="https://github.com/emilkrebs/med-research-mcp/blob/main/README.md">English</a> · 简体中文
</p>

<p align="center">
  <a href="#安装">安装</a> ·
  <a href="#配置">配置</a> ·
  <a href="#工具">工具</a> ·
  <a href="#智能体技能">技能</a> ·
  <a href="#文档">文档</a> ·
  <a href="#医学免责声明">免责声明</a> ·
  <a href="#数据来源与版权">数据来源</a>
</p>

`med-research-mcp` 是一个 [MCP](https://modelcontextprotocol.io)（模型上下文协议）服务器。它让 AI 助手能够检索 PubMed、Europe PMC 和 ChinaRxiv（含 ChinaXiv 与 RussiaRxiv 数据源），并告诉助手每条结果属于哪一类研究。这样，助手在回答之前就能分清 Meta 分析和病例报告，也能识别出已撤稿的论文。它专为医学、临床和膳食补充剂研究而设计：在这些领域，“证据究竟说明了什么”比一串摘要更重要。

- **一次检索覆盖四个数据库**，结果合并并去重。
- **研究设计标注来自美国国家医学图书馆（NLM）的元数据**：每条结果都注明它属于哪类研究、这种设计在证据等级中处于什么位置，以及是否已被撤稿或更正。不做猜测：没有相应元数据的记录标为 `unknown`。
- **摘要不够时可获取全文**，途径包括开放获取版本、你所在机构的代理或 DOI。
- **智能体技能（Agent Skills）**，教助手编写精确的检索式、解读标注并评价证据。
- **不调用大语言模型，无需账号，不发送遥测数据**。服务器在你自己的电脑上运行。

> **重要提示**：本工具是科研辅助工具，不构成医疗建议，也不是诊断工具。请勿在检索内容中输入任何可识别患者身份的信息：检索内容会发送到[隐私](#隐私)一节列出的数据库。另请参阅[医学免责声明](#医学免责声明)。

## 预期用途与排序说明

**预期用途**：本工具是面向科研与教育的学术文献检索工具，用于检索 PubMed、Europe PMC、ChinaRxiv 等数据库中已发表的科学文献，依据文献元数据标注研究设计类型，并获取可公开获取的全文，或在用户自行配置时经其所在机构获取的全文。本工具不用于任何疾病的诊断、预防、监护、治疗或者缓解，不提供用药指导或治疗建议，不用于针对具体患者的诊疗决策，不处理患者数据，不作为医疗器械使用。研究设计标注仅反映文献的索引信息，不代表研究结论可靠或适用于任何个人。如有健康问题，请咨询医生。

**排序说明**：检索结果按研究设计等级排序（依据牛津循证医学中心 2011 年证据等级与美国国家医学图书馆的文献类型标注）：设计等级 5 至 2 级的文献依次排在最前，其次为未评级的文献，最后为 1 级和 0 级的文献；同一等级内保留各数据库的原始顺序。不使用个人数据，不做个性化推荐。

## 安装

需要 [Node.js](https://nodejs.org) 22.22.2 或更高的 22.x 版本、24.15.0 或更高的 24.x 版本，或 26 及以上版本。服务器直接从 npm 运行，无需克隆仓库或构建。请将示例中的 `you@example.com` 替换为你的邮箱（见[配置](#配置)）。

### Claude Code

```bash
claude mcp add med-research-mcp -s user \
  -e NCBI_EMAIL=you@example.com \
  -- npx -y med-research-mcp
```

`-s user` 使它在你的所有项目中可用。运行 `claude mcp get med-research-mcp` 可检查连接；工具会在新会话中出现。

### Claude Desktop

从[最新发布版本](https://github.com/emilkrebs/med-research-mcp/releases/latest)下载 `med-research-mcp.mcpb`，拖到 Claude Desktop 上即可。安装程序会提供几项可选设置（例如你的邮箱），无需编辑任何 JSON。

### Cursor、Windsurf、Cline 等客户端

将以下内容添加到客户端的 MCP 配置中：

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

使用 YAML 配置的客户端（如 Hermes）填写相同的 `command`、`args` 和 `env` 即可。

### 从源码安装

```bash
git clone https://github.com/emilkrebs/med-research-mcp.git
cd med-research-mcp
npm install
npm run build
```

然后将 `node /path/to/med-research-mcp/dist/mcp/index.js` 用作启动命令；运行 `npm run build:mcpb` 可构建 Claude Desktop 安装包。如需将服务器作为团队共享的 HTTP 服务运行，请参阅 [docs/hosting.md](https://github.com/emilkrebs/med-research-mcp/blob/main/docs/hosting.md)（英文）。

## 配置

以下变量在 MCP 客户端配置的 `env` 中设置。它们都是可选的，但请设置 `NCBI_EMAIL`。

| 变量 | 作用 |
| --- | --- |
| `NCBI_EMAIL` | 你的联系邮箱。按照 NCBI 使用政策的要求，它会随每个 NCBI（PubMed）请求一起发送，以便 NCBI 在封禁超出限额的 IP 之前联系你。未单独设置 Unpaywall 和 ChinaRxiv 的邮箱时，也用于这两项服务。如未设置，发往 NCBI 和 Unpaywall 的请求会改为附带本项目的联系邮箱。 |
| `NCBI_API_KEY` | 将 PubMed 的速率上限从每秒 3 次请求提高到 10 次。可在 [NCBI 账户设置](https://www.ncbi.nlm.nih.gov/account/settings/)中获取。 |
| `MED_RESEARCH_UNPAYWALL_EMAIL` | Unpaywall 的联系邮箱。Unpaywall 用于查找开放获取的全文。 |
| `MED_RESEARCH_CHINAXIV_EMAIL` | ChinaRxiv 的联系邮箱。ChinaRxiv 提供 `chinaxiv` 和 `russiarxiv` 两个数据源；设置后，其速率上限从每分钟 30 次请求提高到 300 次。 |
| `MED_RESEARCH_PROXY_PREFIX` | 你所在机构用于 doi.org 的 EZproxy 地址，例如 `https://doi-org.ezproxy.your-university.edu`，用于阅读你有权访问的付费论文。仅当该代理无需登录即可放行本机时才有效，例如在校园网内或通过 VPN 连接时。请仅在机构的许可协议允许时使用：许多出版商禁止将订阅内容用于 AI 工具。 |
| `MED_RESEARCH_FULLTEXT_MAX_CHARS` | 返回全文的最大长度（字符数）。默认为 `50000`。 |
| `MED_RESEARCH_FULLTEXT_ALLOW_PRIVATE` | 设为 `1` 时，允许获取全文的请求访问私有或保留网络地址（服务器默认拒绝）。仅当个人电脑使用 fake-IP 模式的 DNS 代理（如 TUN 模式下的 Clash、Surge 或 sing-box）或分离解析（split-horizon DNS）时才需要；切勿在共享服务器上设置。 |
| `MED_RESEARCH_CACHE_BACKEND` | `memory`（默认）或 `sqlite`；后者在重启后仍保留缓存。 |
| `MED_RESEARCH_CACHE_PATH` | `sqlite` 后端使用的 SQLite 文件。请使用绝对路径：默认值 `./pubmed-cache.db` 是相对于客户端启动服务器时所在目录的路径。 |

[`.env.example`](https://github.com/emilkrebs/med-research-mcp/blob/main/.env.example)（英文）逐一说明了上述变量，以及 HTTP 服务器的变量。

## 工具

| 工具 | 作用 |
| --- | --- |
| `literature_search` | 检索一个或多个数据库，并为每条结果标注研究设计、设计等级和警示标记。 |
| `literature_fetch` | 返回指定论文的完整记录和摘要。 |
| `literature_fulltext` | 在能找到开放获取或已获授权的版本时，以 Markdown 格式返回论文全文。 |

助手通常先检索，再阅读有价值的摘要，在需要研究方法、剂量或样本量时获取全文。全部参数见 [docs/tools.md](https://github.com/emilkrebs/med-research-mcp/blob/main/docs/tools.md)（英文）。

每条结果上的标注含义如下：

- **`studyType`**（研究类型）是 NLM 标引的研究设计，例如 `meta-analysis`（Meta 分析）、`randomized-controlled-trial`（随机对照试验）、`case-report`（病例报告）等；记录没有此类元数据时为 `unknown`。**`unknown` 表示未标注，不代表证据弱**。这种情况在新近发表的论文、未被 MEDLINE 收录的期刊以及 ChinaXiv 和 RussiaRxiv 数据源中很常见；对于这些论文，助手会自行阅读摘要。
- **`designTier`**（设计等级）参照[牛津循证医学中心（OCEBM）证据等级](https://www.cebm.ox.ac.uk/resources/levels-of-evidence/ocebm-levels-of-evidence)，针对“这种治疗是否有效？”这类问题为研究设计排序，从 5 级（随机试验的系统综述）到 0 级（动物和实验室研究、已撤稿论文）。它只为研究设计分级，不评价研究本身的质量。元数据无法确定设计时，该值为 `null`：包括未标注的记录，以及大多数 Meta 分析——它们的等级取决于所合并的研究。`null` 表示未评级，不代表证据弱。
- **`flags`**（警示标记）提示撤稿、更正、关注声明、预印本和机器翻译文本。

ChinaXiv 和 RussiaRxiv 的记录来自 [ChinaRxiv](https://chinarxiv.org)。这是一个独立项目，与中国科学院的 ChinaXiv（中国科学院科技论文预发布平台）没有关联。ChinaRxiv 的英文文本由机器翻译，大多数 RussiaRxiv 摘要也是它自行撰写的；在依据其中的剂量、研究人群或结局之前，请核对原始记录。

## 智能体技能

三个 [Agent Skills（智能体技能）](https://github.com/emilkrebs/med-research-mcp/tree/main/skills)教助手用好这些工具：

- **[med-research](https://github.com/emilkrebs/med-research-mcp/blob/main/skills/med-research/SKILL.md)**：工作流程。编写精确的 PubMed 检索式、解读标注、判断未标注论文的研究类型，并在报告研究发现时说明其确定程度。
- **[med-research-ebm](https://github.com/emilkrebs/med-research-mcp/blob/main/skills/med-research-ebm/SKILL.md)**：严格评价，仅在结论将取决于单篇论文时加载，涵盖偏倚风险、效应量、异质性、因果关系和适用性。
- **[med-research-setup](https://github.com/emilkrebs/med-research-mcp/blob/main/skills/med-research-setup/SKILL.md)**：帮助助手安装本服务器并排查故障。

为 Claude Code 安装这些技能：

```bash
git clone --depth 1 https://github.com/emilkrebs/med-research-mcp.git
mkdir -p ~/.claude/skills && cp -r med-research-mcp/skills/* ~/.claude/skills/
```

如只想在某个项目中使用，请安装到该项目的 `.claude/skills/` 目录。技能在新会话中生效。Claude Desktop 不会从 `.mcpb` 或 `~/.claude/skills/` 读取技能：请将每个技能文件夹分别压缩为 zip，在 Customize → Skills → “+” → “Upload a skill” 中上传，并在 Settings → Capabilities 中开启 “Code execution and file creation”。

## 隐私

服务器在你的电脑上运行，不发送遥测数据。你的检索内容会发送到你所检索的数据库（PubMed 由 NCBI 提供，Europe PMC 由 EMBL-EBI 提供，此外还有 ChinaRxiv），获取全文的请求会发送到 Unpaywall、doi.org 和出版商网站，它们各自适用其服务条款和隐私政策。检索结果缓存在你的电脑上，默认保存在内存中，除非你选择 SQLite。如果你使用他人运行的 HTTP 实例，其运营方也会收到你的检索内容。请勿在检索内容中输入姓名、病历号或其他可识别患者身份的信息。详见 [docs/compliance.md](https://github.com/emilkrebs/med-research-mcp/blob/main/docs/compliance.md)（英文）。

## 文档

以下文档均为英文。

- **[工具参考](https://github.com/emilkrebs/med-research-mcp/blob/main/docs/tools.md)**：参数、结果、数据库、标注和错误。
- **[工作原理](https://github.com/emilkrebs/med-research-mcp/blob/main/docs/how-it-works.md)**：检索流程、研究设计标注的分配方式及其依据、全文获取、缓存，以及基准测试如何为回答评分。
- **[托管部署](https://github.com/emilkrebs/med-research-mcp/blob/main/docs/hosting.md)**：为团队通过 HTTP 运行服务器。
- **[使用核心库](https://github.com/emilkrebs/med-research-mcp/blob/main/docs/library.md)**：不经 MCP，直接调用相同的功能。
- **[合规](https://github.com/emilkrebs/med-research-mcp/blob/main/docs/compliance.md)**：预期用途、数据流向，以及所调用服务的条款。
- **[开发](https://github.com/emilkrebs/med-research-mcp/blob/main/docs/development.md)**：构建、测试和发布。
- **[基准测试](https://github.com/emilkrebs/med-research-mcp/blob/main/benchmark/README.md)**：各模型借助本服务器回答生物医学问题的表现。
- **[版本发布](https://github.com/emilkrebs/med-research-mcp/releases)**：每个版本的变更。

## 医学免责声明

`med-research-mcp` 是面向科研与教育的文献检索工具。它不提供医疗建议、诊断或治疗建议，不用于针对具体患者的诊疗决策，也不是医疗器械。其研究设计标注只对研究的设计方式进行分级，既不评价单项研究的质量，也不表示其结果适用于任何人。这些标注不能替代临床判断，也不能替代具备资质的专业人员。请务必对照原始文献核实研究发现，并在做出医疗或膳食补充剂相关决定之前咨询医生。

## 数据来源与版权

PubMed 数据由美国国家医学图书馆（NLM）通过美国国家生物技术信息中心（NCBI）的 E-utilities 提供，适用 [NCBI 的免责声明和版权声明](https://www.ncbi.nlm.nih.gov/home/about/policies/)。NLM 不主张 PubMed 摘要的版权，但摘要的出版商或作者可能主张；NLM 也不为本工具背书。Europe PMC 数据来自 Europe PMC REST API（EMBL-EBI），适用 [EMBL-EBI 使用条款](https://www.ebi.ac.uk/about/terms-of-use)。开放获取版本的位置信息来自 [Unpaywall](https://unpaywall.org)。ChinaXiv 和 RussiaRxiv 的记录来自 [ChinaRxiv API](https://chinarxiv.org/api/docs)，其接口规范声明采用 CC BY 4.0 许可。全文归其权利人所有，请在相应许可范围内使用。

## 许可证

[MIT](https://github.com/emilkrebs/med-research-mcp/blob/main/LICENSE.md)。
