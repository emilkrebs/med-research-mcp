# Compliance

What med-research-mcp is for, where its data goes, what the services it calls require, and how its scientific content is checked. The sources were checked on 2026-10-19. This page records the project's reading of them; it isn't legal advice, and the points about China and HIPAA in particular deserve a lawyer's look before you rely on them.

## Contents

- [Intended use](#intended-use)
- [Data flows](#data-flows)
- [Patient data](#patient-data)
- [Upstream services](#upstream-services)
- [Privacy](#privacy)
- [China (ModelScope)](#china-modelscope)
- [Scientific standards](#scientific-standards)
- [Open items](#open-items)

## Intended use

> med-research-mcp is a literature search and retrieval tool for research and education. It finds published scientific records (PubMed, Europe PMC, ChinaXiv and RussiaRxiv), labels each with the study design recorded in its bibliographic metadata, and retrieves full texts that are openly available or, if the user configures it, available through their institution's access. It is not intended to diagnose, prevent, monitor, predict, treat or alleviate any disease, to provide dosing or treatment recommendations, or to inform decisions about the care of an individual patient, and it does not process patient data. It is not a medical device and has not been assessed by any regulator. Design labels describe how a study was indexed, not whether its results are valid or apply to anyone.

Whether software is a medical device depends on its intended purpose, as the manufacturer states it in labelling, instructions and promotion (EU MDR 2017/745, Art. 2(12); for the US, 21 CFR 801.4). Retrieving and labelling literature falls outside the definitions as long as nothing turns it into advice about a specific patient:

- **EU.** [MDCG 2019-11 rev.1](https://health.ec.europa.eu/document/download/b45335c5-1679-4c71-a91c-fc7a4d37f12b_en?filename=mdcg_2019_11_en.pdf) (June 2025): "'Simple search', which refers to the retrieval of records by matching record metadata against record search criteria or to the retrieval of information does not qualify as MDSW (e.g. library functions)", and it lists "scientific literature" among information not for the benefit of individual patients. The line it draws is software that combines medical knowledge "with patient-specific data" into recommendations for individual patients. The design labels go beyond simple search, so staying outside rests on not being for individual patients.
- **US.** The FDA's [Policy for Device Software Functions](https://www.fda.gov/media/80958/download) (Appendix A) treats reference software "with generic text search capabilities", such as "electronic copies of medical textbooks or literature articles", as not a device. Its [Clinical Decision Support guidance](https://www.fda.gov/media/109618/download) (January 2026) applies to software that supports recommendations about a patient, and states that software providing recommendations to patients or caregivers rather than professionals meets the device definition.
- **China.** NMPA's 2021 guidance on AI medical software (Notice No. 47) doesn't regulate software as a device when it processes non-device data or has no medical purpose.

To stay within this, the tool descriptions, README and skills avoid framing results as advice for a person: the skills report doses and populations as what studies found, not as recommendations, speak of "the population in the question" rather than "the patient", and tell the model to point to a professional for decisions about someone's care. Keep it that way in listings and promotion: avoid "clinical decision support", "dosing guidance", "personalized" and "for clinicians at the point of care".

## Data flows

The server sends no telemetry and has no accounts. A tool call sends data only to the services needed to answer it:

| Service | When | What it receives |
| --- | --- | --- |
| NCBI E-utilities (NLM, USA) | `pubmed` searches and fetches; the PMID-to-DOI lookup in `literature_fulltext` | The query or PMIDs, `tool=med-research-mcp`, `NCBI_EMAIL` (without it, the project's contact address), `NCBI_API_KEY`, and the machine's IP address. NLM's [privacy policy](https://www.nlm.nih.gov/web_policies.html) says it records search terms |
| Europe PMC REST API (EMBL-EBI, UK) | `europepmc` searches and fetches; full texts of PubMed Central copies | The query or ids, and the IP address |
| ChinaRxiv API | `chinaxiv` and `russiarxiv` searches and fetches | The query or ids, the IP address, and `MED_RESEARCH_CHINAXIV_EMAIL` (or `NCBI_EMAIL`) as `X-API-Email`; ChinaRxiv says it collects these emails "to understand who our API users are" |
| Unpaywall (OurResearch/OpenAlex, USA) | `literature_fulltext` | The DOI and `MED_RESEARCH_UNPAYWALL_EMAIL` (or `NCBI_EMAIL`) |
| doi.org, publishers and repositories | `literature_fulltext` | Requests for the DOI's pages, from the IP address, with the server's User-Agent |
| Your institution's proxy | `literature_fulltext`, if configured | Requests for the DOI, from the IP address |

Every request identifies the software with the User-Agent `med-research-mcp/<version> (https://github.com/emilkrebs/med-research-mcp)`. Results are cached on the machine that runs the server, in memory unless SQLite is chosen; the cache holds article records, not queries. On a hosted instance, the operator also receives the requests ([hosting.md](hosting.md#privacy)).

## Patient data

Don't enter anything that identifies a person: names or initials, dates of birth or admission, record or case numbers, addresses, phone numbers, email addresses, images, or rare combinations of details. Ask about conditions and interventions, not about patients. Queries leave the machine and go to the services above, none of which has agreed to protect health information for you, and the project offers no HIPAA business associate agreement or GDPR data processing agreement.

The tool description of `literature_search` tells the model the same, since the model writes the queries. Under HIPAA, the project is neither a covered entity nor a business associate (45 CFR 160.103); a clinician who puts protected health information into a query discloses it to third parties, and that responsibility lies with the clinician's organisation. Under the GDPR, health data is a special category; under China's PIPL, sending personal information abroad needs notice, separate consent and an impact assessment. Leaving it out of queries avoids all of these.

## Upstream services

### NCBI E-utilities (PubMed)

The [NCBI policies page](https://www.ncbi.nlm.nih.gov/home/about/policies/) and the E-utilities usage guidelines ([NBK25497](https://www.ncbi.nlm.nih.gov/books/NBK25497/)) ask for:

| Requirement | How it's met |
| --- | --- |
| "Make no more than 3 requests every 1 second", 10 with an API key; the limit applies per IP | `NcbiClient` queues and spaces requests to 3 per second, or 10 with `NCBI_API_KEY`, shared by every tool call in a process. Separate processes behind one IP share NCBI's limit |
| `tool` and `email` on every request, "so that we can track your project and contact you if there is a problem" | Every request sends `tool=med-research-mcp` and an email: `NCBI_EMAIL`, or the project's contact address `hello@emilkrebs.dev` when it isn't set |
| "Merely providing values for tool and email in requests is not sufficient to comply with this policy; these values must be registered with NCBI" | **Open**: the maintainer registers `tool=med-research-mcp` with `hello@emilkrebs.dev` by email to <eutilities@ncbi.nlm.nih.gov> |
| "NCBI's Disclaimer and Copyright notice must be evident to users of your service" | The README's [Data sources and copyright](../README.md#data-sources-and-copyright) section links it |
| "Run retrieval scripts on weekends or between 9 pm and 5 am Eastern Time weekdays for any series of more than 100 requests" | Interactive use doesn't qualify; benchmark runs do, and its README says so |

NCBI's guidelines describe `email` both as the software developer's address, "not that of a third-party end user" (NBK25497), and as the "E-mail address of the E-utility user" (NBK25499). Each installation sends the email of whoever runs it, as Biopython and similar tools do. When none is set, it sends the developer address the project registers with its tool name, so every request carries a contact NCBI can reach. The registration request asks NCBI which of the two it prefers. "NLM does not claim the copyright on the abstracts in PubMed; however, journal publishers or authors may": the tool returns abstracts to the person who searched, and redistributing them is up to that person.

### Europe PMC and PubMed Central

- The REST API is the sanctioned route; [EMBL-EBI's terms of use](https://www.ebi.ac.uk/about/terms-of-use) expect attribution, which the README gives.
- Neither site allows automated downloading of articles from its website. [PMC](https://pmc.ncbi.nlm.nih.gov/about/copyright/): "Do not use any other automated processes for downloading articles, even if you are only retrieving articles from the PMC Article Datasets (including the PMC Open Access Subset)". [Europe PMC](https://europepmc.org/Copyright) names its OAI, RESTful, SOAP and bulk services as the only ones for automated downloading. `literature_fulltext` therefore fetches the PubMed Central and Europe PMC copies that Unpaywall lists from Europe PMC's full-text API instead of either website ([how-it-works.md](how-it-works.md#literature_fulltext)).

### Unpaywall

"Requests must include your email", and users should "limit use to 100,000 calls per day" ([API page](https://unpaywall.org/products/api)). The client sends the email on every request and skips Unpaywall without one; one call per `literature_fulltext` keeps an installation far below the daily figure.

### ChinaRxiv

The [API specification](https://chinarxiv.org/api/openapi.json) allows 30 requests per minute anonymously and 300 with an `X-API-Email` header, which the adapters send. It declares a CC BY 4.0 licence; whether that covers the records or only the specification isn't stated, so the README attributes ChinaRxiv as the source. Records carry the `machine-translated` and `machine-generated-abstract` flags, keeping ChinaRxiv's own marking of machine-written text.

### Publishers, the proxy and the direct route

Full texts belong to their rights holders. Open-access copies come with their own licences. Subscription content is a different matter:

- Publisher website terms often forbid using content with AI tools unless a licence expressly allows it, and forbid systematic downloading. [Elsevier](https://www.elsevier.com/legal/elsevier-website-terms-and-conditions) (revised 12 March 2026): "You may not use Content from the Services in combination with an artificial intelligence tool … except as otherwise expressly permitted under these Terms and Conditions, or any relevant license or subscription agreement", and "If the Services contain robot exclusion files or robot exclusion headers, you agree to honor them".
- The text-and-data-mining exceptions of EU copyright law (Directive 2019/790, Arts. 3–4; in Germany §§ 44b, 60d UrhG) cover copies made for mining, not passing full texts on to others, and the general exception yields to a machine-readable reservation by the rights holder.

So the project: fetches one paper at a user's request, never in bulk; caches only open-access texts; tells users to configure the proxy only where their institution's licences permit AI use; and tells operators not to run a shared instance on a network with IP-based subscriptions ([hosting.md](hosting.md#environment-variables)).

## Privacy

- **Locally (stdio, `.mcpb`):** the server runs as the user's own process; the data flows above are all that leave the machine.
- **Hosted (HTTP):** the server logs only method, path, status, duration and an IP address shortened to /24 (IPv6 /48), holds full IP addresses in memory for rate limiting (dropped one to two hours after the last request), and never logs queries or results. A shortened IP address can still be personal data while full addresses exist elsewhere (in reverse-proxy or cloud logs), so treat the logs as such. The operator is the controller and owes users a privacy notice; [hosting.md](hosting.md#a-privacy-notice-for-your-instance) has a template.

## China (ModelScope)

Points that matter for a listing on ModelScope, which runs in mainland China:

- **Generative AI rules.** The [Interim Measures for Generative AI Services](https://www.cac.gov.cn/2023-07/13/c_1690898327029107.htm) and the AI-generated content labelling measures apply to providers of generative AI services. The server makes no LLM calls, so it isn't one; the obligations fall on whoever runs the model. Keeping ChinaRxiv's `machine-generated-abstract` marking is in the spirit of the labelling rules.
- **Ranking.** The [algorithm recommendation provisions](https://www.cac.gov.cn/2022-01/04/c_1642894606364259.htm) cover ranking and retrieval algorithms offered to the public and ask that their basic principles be explained. [How it works](how-it-works.md#ranking) explains the ranking, and the listing carries the Chinese summary below. Whether the provisions reach an MCP tool is untested.
- **Health-product advertising.** The tool makes no efficacy claims and isn't an advertisement; describe it as literature search on dietary supplements (膳食补充剂相关文献检索), never with treatment or efficacy claims.
- **Cross-border personal information.** Queries without personal information raise no transfer issue under the PIPL; queries with it would. This is the strongest reason for the patient-data rule above.
- **ModelScope's own terms** ([user agreement](https://www.modelscope.cn/docs/agreements/terms)). Content published there is reviewed for prohibited material (political, pornographic, violent, illegal, advertising or spam). Publishing grants ModelScope a worldwide, irrevocable, sublicensable licence to host and distribute it, and every user a perpetual, irrevocable licence to use, copy and adapt it through ModelScope (§3.2.1; compatible with the MIT license). The agreement is governed by Chinese law (§9.5), registration requires phone verification (§2.2.2), and the service "旨在供中华人民共和国内地用户使用" — is intended for users in mainland China, without a guarantee for anyone else (§10.2).

The listing states the intended use and the ranking in Chinese, in its description or at the top of its Chinese README, since ModelScope machine-translates the README and medical wording suffers most in translation. The wording is still to be checked by a native speaker.

Intended use, as [above](#intended-use):

> 预期用途：本工具是面向科研与教育的学术文献检索工具，用于检索 PubMed、Europe PMC、ChinaRxiv 等数据库中已发表的科学文献，依据文献元数据标注研究设计类型，并获取可公开获取的全文，或在用户自行配置时经其所在机构获取的全文。本工具不用于任何疾病的诊断、预防、监护、治疗或者缓解，不提供用药指导或治疗建议，不用于针对具体患者的诊疗决策，不处理患者数据，不作为医疗器械使用。研究设计标注仅反映文献的索引信息，不代表研究结论可靠或适用于任何个人。如有健康问题，请咨询医生。

Ranking, as in [how it works](how-it-works.md#ranking):

> 排序说明：检索结果按研究设计等级排序（依据牛津循证医学中心 2011 年证据等级与美国国家医学图书馆的文献类型标注）：设计等级 5 至 2 级的文献依次排在最前，其次为未评级的文献，最后为 1 级和 0 级的文献；同一等级内保留各数据库的原始顺序。不使用个人数据，不做个性化推荐。

## Scientific standards

Every scientific claim in the code, docs and skills must trace to a primary source that was checked, not recalled:

- **The design labels** come only from NLM metadata. [`grader.ts`](../src/core/grader.ts) cites a source for every mapping (MeSH records, OCEBM, GRADE, NLM bulletins) and measures each heuristic on real PubMed records; when in doubt it chooses the lower tier, or `null`. [How it works](how-it-works.md#the-grader-study-design-labels) has the reasoning and the rules for changing it.
- **The skills** cite every claim, numbered against a reference list with PMIDs.
- **The benchmark** verifies every citation in an answer against live PubMed and is explicit about its limits ([benchmark/README.md](../benchmark/README.md#validity-and-limitations)).

### Verification of 2026-10-19

Before the first release, every reference in the skills, the grader and the docs was checked against its primary source:

- **Citations.** All 32 PMIDs match their PubMed records (authors, journal, year, volume, pages), as do the GRIM test's DOI and the Cochrane Handbook's current version (6.5, 2024).
- **Claims.** These were confirmed in the abstract, full text or source document: LeLorier 1997 (κ = 0.35); Prasad 2013 (146 of 363 established practices reversed, 40.2%); Ciani 2013 (odds ratios 0.51 vs 0.76); Askin 2025 (human RCTs excluded seven times as often under automated indexing; full text); Lundh 2017; COMPare (87% of trials needed corrections); the Cochrane Handbook's I² ranges, prediction-interval caveats (normality, "five or more" studies), the ten-study rule for funnel-plot tests and the RoB 2 domains (chapters 8, 10, 13); the GRADE wording for certainty levels (chapter 15); ROBINS-I V2 (November 2025 draft: deviations domain dropped, immortal-time questions added); every row of the OCEBM 2011 table and its footnote; the OCEBM and GRADE quotes in `grader.ts`; CONSORT 2025 item 1a, STROBE item 1(a) and PRISMA 2020 item 1; Cohen's d conventions (Cohen 1992, Table 1); the MeSH definitions behind the tiers (Network Meta-Analysis, Controlled Clinical Trial, Pragmatic Clinical Trial, Retraction Notice); and the skill's worked examples (PMID 36615805 is a meta-analysis of 21 RCTs; no 2023 Jensen trial of melatonin and REM sleep exists).
- **Corrected.** Hill (1965) wrote that none of his considerations "can be required as a sine qua non", so the skills no longer attribute "temporality is required" to him. The Cochrane placebo review says placebo interventions "can influence" patient-reported outcomes, not that the effects are real. OCEBM's level 1 for treatment benefit is now quoted with its intended reading. Cohen's conventions gained a citable journal source.

## Open items

- **Register the tool name with NCBI** (maintainer).
- **robots.txt and TDM reservations** aren't checked before fetching a publisher page on the proxy or direct route.
- **Full-text licences** aren't passed through to results, so CC BY attribution of an open-access text is left to the user.
- **ChinaRxiv's licence**: whether CC BY 4.0 covers the records is unclear.
- **Not verified from primary sources:** the PIPL's articles on extraterritorial scope and local representatives, the Cybersecurity Law's log-retention rule (relevant if you operate an endpoint in China), and HIPAA's de-identification standard (45 CFR 164.514). Ask counsel before running a China-facing endpoint or handling clinical queries in a covered entity.
