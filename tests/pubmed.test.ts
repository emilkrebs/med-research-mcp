import { describe, it, expect, vi, afterEach } from "vitest";
import { NcbiClient, searchPubMed, fetchPubMed } from "../src/core/pubmed";
import { PubMedAdapter } from "../src/core/adapters/pubmed";
import { PROJECT_CONTACT_EMAIL } from "../src/core/version";
import { LRUBackend } from "../src/core/cache";
import type { NcbiArticle, SearchInput } from "../src/core/types";

const EFETCH_XML = `<?xml version="1.0" ?>
<PubmedArticleSet>
  <PubmedArticle>
    <MedlineCitation>
      <PMID Version="1">11111111</PMID>
      <Article>
        <ArticleTitle>Creatine supplementation and cognition</ArticleTitle>
        <Abstract>
          <AbstractText Label="BACKGROUND">Creatine may affect cognition.</AbstractText>
          <AbstractText Label="METHODS">A double-blind randomized controlled trial.</AbstractText>
          <AbstractText Label="RESULTS">Memory improved.</AbstractText>
        </Abstract>
        <PublicationTypeList>
          <PublicationType UI="D016449">Randomized Controlled Trial</PublicationType>
          <PublicationType UI="D016428">Journal Article</PublicationType>
        </PublicationTypeList>
      </Article>
      <CommentsCorrectionsList>
        <CommentsCorrections RefType="CommentIn">
          <RefSource>J Test. 2022;1:2.</RefSource>
          <PMID Version="1">33333333</PMID>
        </CommentsCorrections>
        <CommentsCorrections RefType="RetractionIn">
          <RefSource>J Test. 2023;2:3.</RefSource>
          <PMID Version="1">44444444</PMID>
        </CommentsCorrections>
        <CommentsCorrections RefType="ErratumIn">
          <RefSource>J Test. 2023;2:4.</RefSource>
        </CommentsCorrections>
      </CommentsCorrectionsList>
      <MeshHeadingList>
        <MeshHeading>
          <DescriptorName UI="D003401" MajorTopicYN="Y">Creatine</DescriptorName>
          <QualifierName UI="Q000008" MajorTopicYN="N">administration &amp; dosage</QualifierName>
        </MeshHeading>
        <MeshHeading>
          <DescriptorName UI="D006801" MajorTopicYN="N">Humans</DescriptorName>
        </MeshHeading>
      </MeshHeadingList>
    </MedlineCitation>
  </PubmedArticle>
  <PubmedArticle>
    <MedlineCitation>
      <PMID Version="1">22222222</PMID>
      <Article>
        <ArticleTitle>A narrative review of nootropics</ArticleTitle>
        <Abstract>
          <AbstractText>This narrative review summarizes nootropic evidence.</AbstractText>
        </Abstract>
        <PublicationTypeList>
          <PublicationType UI="D016454">Review</PublicationType>
        </PublicationTypeList>
      </Article>
    </MedlineCitation>
  </PubmedArticle>
</PubmedArticleSet>`;

describe("NcbiClient.parseEfetch", () => {
  const client = new NcbiClient({ email: "test@example.com" });
  const parsed = client.parseEfetch(EFETCH_XML);

  it("parses both articles", () => {
    expect(parsed.size).toBe(2);
    expect(parsed.has("11111111")).toBe(true);
    expect(parsed.has("22222222")).toBe(true);
  });

  it("concatenates structured multi-section abstracts with labels", () => {
    const a = parsed.get("11111111");
    expect(a?.abstract).toContain("BACKGROUND: Creatine may affect cognition.");
    expect(a?.abstract).toContain("METHODS: A double-blind randomized controlled trial.");
    expect(a?.abstract).toContain("RESULTS: Memory improved.");
  });

  it("extracts publication types (array and single forms)", () => {
    expect(parsed.get("11111111")?.publicationTypes).toEqual([
      "Randomized Controlled Trial",
      "Journal Article",
    ]);
    expect(parsed.get("22222222")?.publicationTypes).toEqual(["Review"]);
  });

  it("extracts MeSH descriptor names and an empty list when there are none", () => {
    expect(parsed.get("11111111")?.meshHeadings).toEqual(["Creatine", "Humans"]);
    expect(parsed.get("22222222")?.meshHeadings).toEqual([]);
  });

  it("keeps retraction/erratum links (with their PMID when given) and drops comment links", () => {
    expect(parsed.get("11111111")?.corrections).toEqual([{ type: "RetractionIn", id: "44444444" }, { type: "ErratumIn" }]);
    expect(parsed.get("22222222")?.corrections).toEqual([]);
  });

  it("handles an unlabeled single abstract section", () => {
    expect(parsed.get("22222222")?.abstract).toBe(
      "This narrative review summarizes nootropic evidence.",
    );
  });
});

// AbstractText is mixed content. Fragments of PMIDs 40292479, 32599716, 38418482 and 30243806
// as efetch returns them (2026-10-22), which 0.6.0 returned as "(= 0.03)", "31 &#xb1; 8 years",
// "consecutiveP-MRS scans" and "haemoglobin Aover time".
const MIXED_XML = `<?xml version="1.0" ?>
<PubmedArticleSet>
  <PubmedArticle><MedlineCitation><PMID Version="1">40292479</PMID><Article><Abstract><AbstractText><b>Background/Objectives</b>: Creatine monohydrate (CrM) is considered to be one of the most effective supplements. <b>Methods</b>: Sixty-three (34 females, 29 males, 31 &#xb1; 8 years) participants were randomised. Lean mass increased more with CrM (<i>p</i> = 0.03).</AbstractText></Abstract></Article></MedlineCitation></PubmedArticle>
  <PubmedArticle><MedlineCitation><PMID Version="1">32599716</PMID><Article><Abstract><AbstractText>Twenty-two participants were randomized to supplement with creatine (CR: <i>n</i> = 13, 26 &#xb1; 4 yrs; 0.0055 g&#xb7;kg<sup>-1</sup> post training set).</AbstractText></Abstract></Article></MedlineCitation></PubmedArticle>
  <PubmedArticle><MedlineCitation><PMID Version="1">38418482</PMID><Article><Abstract><AbstractText>Two consecutive <sup>31</sup>P-MRS scans, <sup>1</sup>H-MRS, and cognitive tests were performed during 21&#xa0;h of sleep deprivation.</AbstractText></Abstract></Article></MedlineCitation></PubmedArticle>
  <PubmedArticle><MedlineCitation><PMID Version="1">30243806</PMID><Article><Abstract>
    <AbstractText Label="METHODS">The primary outcome was the change in haemoglobin A<sub>1c</sub> over time.</AbstractText>
    <AbstractText Label="RESULTS">[MD (95% CI)&#x2009;=&#x2009;-0.38% (-0.62, -0.15)]; p &lt; 0.05 &amp; more.</AbstractText>
    <AbstractText Label="EMPTY"></AbstractText>
  </Abstract></Article></MedlineCitation></PubmedArticle>
</PubmedArticleSet>`;

describe("NcbiClient.parseEfetch — mixed-content abstracts", () => {
  const parsed = new NcbiClient({ email: "test@example.com" }).parseEfetch(MIXED_XML);
  const abstract = (pmid: string): string | undefined => parsed.get(pmid)?.abstract;

  it("keeps the text of inline elements", () => {
    expect(abstract("40292479")).toContain("Background/Objectives: Creatine monohydrate");
    expect(abstract("40292479")).toContain("effective supplements. Methods: Sixty-three");
    expect(abstract("40292479")).toContain("(p = 0.03)");
    expect(abstract("32599716")).toContain("(CR: n = 13,");
    expect(abstract("30243806")).toContain("haemoglobin A1c over time");
  });

  it("decodes character references, and writes a superscript of digits and signs as superscript characters", () => {
    expect(abstract("40292479")).toContain("31 ± 8 years");
    expect(abstract("32599716")).toContain("0.0055 g·kg⁻¹ post");
    expect(abstract("38418482")).toBe(
      "Two consecutive ³¹P-MRS scans, ¹H-MRS, and cognitive tests were performed during 21 h of sleep deprivation.",
    );
  });

  it("keeps labels, decodes escaped text once, and drops a section without text", () => {
    expect(abstract("30243806")).toBe(
      "METHODS: The primary outcome was the change in haemoglobin A1c over time.\n" +
        "RESULTS: [MD (95% CI) = -0.38% (-0.62, -0.15)]; p < 0.05 & more.",
    );
  });
});

// NCBI's esummary returns an ERROR-DOC object (uid + error, no title) for uids it
// doesn't recognize instead of omitting the key — e.g. for a nonexistent PMID. These
// tests exercise the real esummary()/fetchPubMed() parse path (real HTTP layer mocked
// via vi.stubGlobal("fetch", ...), not a fake NcbiClient) to prove such docs are
// skipped rather than turned into empty stub articles.
describe("NcbiClient.esummary error-doc handling", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  const VALID_DOC = {
    uid: "11111111",
    title: "Creatine and cognition.",
    fulljournalname: "J Test",
    pubdate: "2021",
    authors: [{ name: "Doe J" }],
    pubtype: ["Journal Article"],
  };
  const ESUMMARY_PAYLOAD = {
    result: {
      uids: ["11111111", "99999999"],
      "11111111": VALID_DOC,
      "99999999": { uid: "99999999", error: "cannot get document summary" },
    },
  };

  it("skips the ERROR-DOC for a nonexistent PMID but keeps a valid doc in the same batch", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(JSON.stringify(ESUMMARY_PAYLOAD), { status: 200 })),
    );

    const client = new NcbiClient({ email: "test@example.com" });
    const out = await client.esummary(["11111111", "99999999"]);

    expect(out.has("99999999")).toBe(false);
    expect(out.get("11111111")?.title).toBe("Creatine and cognition");
  });

  it("keeps the electronic publication date next to the issue date", async () => {
    // PMID 30243806: issue 2019 Apr, online 2018 Sep 20 (esummary, 2026-10-22).
    const payload = {
      result: {
        uids: ["30243806", "11111111"],
        "30243806": { ...VALID_DOC, uid: "30243806", pubdate: "2019 Apr", epubdate: "2018 Sep 20" },
        "11111111": { ...VALID_DOC, epubdate: "" },
      },
    };
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify(payload), { status: 200 })));

    const out = await new NcbiClient({ email: "test@example.com" }).esummary(["30243806", "11111111"]);
    expect(out.get("30243806")).toMatchObject({ pubDate: "2019 Apr", epubDate: "2018 Sep 20" });
    expect(out.get("11111111")).not.toHaveProperty("epubDate");
  });

  it("fetchPubMed reports the nonexistent PMID as missing instead of a stub article", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) =>
        String(url).includes("efetch.fcgi")
          ? new Response("<PubmedArticleSet></PubmedArticleSet>", { status: 200 })
          : new Response(JSON.stringify(ESUMMARY_PAYLOAD), { status: 200 }),
      ),
    );

    const client = new NcbiClient({ email: "test@example.com" });
    const out = await fetchPubMed({ ids: ["11111111", "99999999"] }, new LRUBackend(), client);

    expect(out.missing).toEqual(["99999999"]);
    expect(out.articles.map((a) => a.pmid)).toEqual(["11111111"]);
    expect(out.articles.find((a) => a.pmid === "99999999")).toBeUndefined();
  });
});

// A fake client lets us exercise the orchestrator without hitting the network.
function fakeClient(): NcbiClient {
  const summaries = new Map<string, NcbiArticle>([
    [
      "11111111",
      {
        pmid: "11111111",
        title: "Creatine and cognition",
        authors: ["Doe J"],
        journal: "J Test",
        pubDate: "2021",
        publicationTypes: ["Randomized Controlled Trial", "Journal Article"],
      },
    ],
    [
      "22222222",
      {
        pmid: "22222222",
        title: "Narrative review of nootropics",
        authors: ["Roe R"],
        journal: "J Rev",
        pubDate: "2020",
        publicationTypes: ["Review"],
      },
    ],
  ]);
  return {
    esearch: async () => ({ count: 2, pmids: ["11111111", "22222222"] }),
    esummary: async (pmids: string[]) => new Map(pmids.map((p) => [p, summaries.get(p)!])),
    efetch: async () =>
      new Map([
        ["11111111", { abstract: "A double-blind randomized controlled trial in 40 adults.", publicationTypes: ["Randomized Controlled Trial"], meshHeadings: ["Humans"], corrections: [] }],
        ["22222222", { abstract: "This narrative review summarizes evidence.", publicationTypes: ["Review"], meshHeadings: [], corrections: [{ type: "RetractionIn", id: "55555555" }] }],
      ]),
  } as unknown as NcbiClient;
}

describe("searchPubMed orchestration", () => {
  it("classifies results and preserves esearch order", async () => {
    const out = await searchPubMed({ query: "creatine" }, new LRUBackend(), fakeClient());
    expect(out.total).toBe(2);
    expect(out.articles.map((a) => a.pmid)).toEqual(["11111111", "22222222"]);
    expect(out.articles[0]?.studyType).toBe("randomized-controlled-trial");
    expect(out.articles[0]?.designTier).toBe(4);
    expect(out.articles[0]?.meshHeadings).toEqual(["Humans"]);
    // 22222222's efetch record carries a retraction link (see the retraction test below).
    expect(out.articles[1]?.studyType).toBe("review");
    expect(out.page).toBe(1);
    expect(out).not.toHaveProperty("nextPage");
  });

  it("returns the page, and nextPage while PubMed holds records past it", async () => {
    const client = fakeClient();
    const esearch = vi.spyOn(client, "esearch").mockResolvedValue({ count: 25, pmids: ["11111111", "22222222"] });
    const run = (input: Partial<SearchInput>) => searchPubMed({ query: "x", ...input }, new LRUBackend(), client);

    expect(await run({})).toMatchObject({ page: 1, nextPage: 2, total: 25 });
    expect(await run({ page: 2 })).toMatchObject({ page: 2, nextPage: 3 });
    expect(esearch).toHaveBeenLastCalledWith(expect.objectContaining({ page: 2 }));
    expect(await run({ page: 3 })).not.toHaveProperty("nextPage");
    // The page holds records 11 to 25 of 25.
    expect(await run({ page: 2, maxResults: 15 })).not.toHaveProperty("nextPage");
    expect(await run({ maxResults: 25 })).not.toHaveProperty("nextPage");
    expect(await run({ maxResults: 24 })).toMatchObject({ nextPage: 2 });
  });

  it("offers no nextPage past the 9,999 records PubMed serves, and passes on esearch's warning", async () => {
    const client = fakeClient();
    const esearch = vi.spyOn(client, "esearch").mockResolvedValue({ count: 50_000, pmids: ["11111111", "22222222"] });
    const run = (page: number) => searchPubMed({ query: "x", page, maxResults: 50 }, new LRUBackend(), client);
    expect(await run(199)).toMatchObject({ nextPage: 200 });
    expect(await run(200)).not.toHaveProperty("nextPage");

    esearch.mockResolvedValue({ count: 50_000, pmids: [], warning: "PubMed serves only the first 9,999 records of a search." });
    const past = await run(201);
    expect(past).toMatchObject({ articles: [], total: 50_000, page: 201 });
    expect(past).not.toHaveProperty("nextPage");
    expect(past.warnings).toEqual(["PubMed serves only the first 9,999 records of a search.", "No results returned."]);
  });

  it("filters by minDesignTier, and says it leaves out unrated records", async () => {
    const out = await searchPubMed({ query: "x", minDesignTier: 4 }, new LRUBackend(), fakeClient());
    expect(out.articles).toHaveLength(1);
    expect(out.articles[0]?.pmid).toBe("11111111");
    expect(out.warnings).toEqual([expect.stringContaining("leaves out every record with an unknown design tier")]);
  });

  it("says what the filter leaves out when PubMed returns nothing", async () => {
    const client = fakeClient();
    vi.spyOn(client, "esearch").mockResolvedValueOnce({ count: 0, pmids: [] });
    const out = await searchPubMed({ query: "creatine meta-analysis", minDesignTier: 3 }, new LRUBackend(), client);
    expect(out.warnings).toEqual([
      expect.stringContaining("leaves out every record with an unknown design tier"),
      expect.stringContaining("No articles matched this query"),
    ]);
  });

  it("explains an animal-study filter that finds none, unless minDesignTier is what left them out", async () => {
    const none = await searchPubMed({ query: "x", studyTypes: ["animal-study"] }, new LRUBackend(), fakeClient());
    expect(none.warnings).toEqual([expect.stringContaining("flagged animals-not-humans")]);

    const esearch = vi.fn();
    const client = fakeClient();
    vi.spyOn(client, "esearch").mockImplementation(esearch);
    const below = await searchPubMed({ query: "x", studyTypes: ["animal-study"], minDesignTier: 1 }, new LRUBackend(), client);
    expect(below).toMatchObject({ articles: [], total: 0 });
    expect(below.warnings).toEqual(["animal-study (designTier 0) records are below minDesignTier 1, so none are kept. Lower minDesignTier to keep them."]);
    expect(esearch).not.toHaveBeenCalled();
  });

  it("filters by study type", async () => {
    const out = await searchPubMed({ query: "x", studyTypes: ["review"] }, new LRUBackend(), fakeClient());
    expect(out.articles).toHaveLength(1);
    expect(out.articles[0]?.studyType).toBe("review");
  });

  it("flags a retraction that only efetch's correction links carry", async () => {
    const out = await searchPubMed({ query: "x" }, new LRUBackend(), fakeClient());
    expect(out.articles[1]).toMatchObject({ studyType: "review", designTier: 0, flags: ["retracted"] });
  });

  it("does not cache a summary whose efetch failed, so its retraction links are fetched next time", async () => {
    // Abstracts never expire, so they can outlive an expired summary.
    const cache = new LRUBackend();
    cache.setAbstract("11111111", "Cached abstract.");
    cache.setAbstract("22222222", "Cached abstract.");
    const client = fakeClient();
    vi.spyOn(client, "efetch").mockRejectedValueOnce(new Error("HTTP 429"));

    const first = await searchPubMed({ query: "x" }, cache, client);
    expect(first.warnings?.some((w) => /retraction\/correction links/.test(w))).toBe(true);
    expect(cache.getSummary("22222222")).toBeNull();

    const second = await searchPubMed({ query: "x" }, cache, client);
    expect(second.articles[1]).toMatchObject({ designTier: 0, flags: ["retracted"] });
  });
});

describe("fetchPubMed metadata refresh", () => {
  it("re-runs efetch for a refreshed summary even when its abstract is cached", async () => {
    const cache = new LRUBackend();
    cache.setAbstract("22222222", "Cached abstract.");
    const client = fakeClient();
    const efetch = vi.spyOn(client, "efetch");
    const out = await fetchPubMed({ ids: ["22222222"] }, cache, client);
    expect(efetch).toHaveBeenCalledWith(["22222222"]);
    // The retraction link arrives with efetch; the cached abstract is not lost.
    expect(out.articles[0]?.corrections).toEqual([{ type: "RetractionIn", id: "55555555" }]);
    expect(out.articles[0]?.abstract).toBeDefined();
  });

  it("does not cache a summary whose efetch failed, so its retraction links are fetched next time", async () => {
    const cache = new LRUBackend();
    cache.setAbstract("22222222", "Cached abstract.");
    const client = fakeClient();
    vi.spyOn(client, "efetch").mockRejectedValueOnce(new Error("HTTP 429"));

    const first = await fetchPubMed({ ids: ["22222222"] }, cache, client);
    expect(first.articles[0]?.corrections).toBeUndefined();
    expect(cache.getSummary("22222222")).toBeNull();

    const second = await fetchPubMed({ ids: ["22222222"] }, cache, client);
    expect(second.articles[0]?.corrections).toEqual([{ type: "RetractionIn", id: "55555555" }]);
  });

  it("replaces a cached summary's older correction links with efetch's", async () => {
    // No cached abstract, so efetch runs for the cached summary.
    const cache = new LRUBackend();
    const client = fakeClient();
    const [stale] = (await client.esummary(["22222222"])).values();
    cache.setSummary("22222222", { ...stale!, corrections: [{ type: "ErratumIn" }] });
    const out = await fetchPubMed({ ids: ["22222222"] }, cache, client);
    expect(out.articles[0]?.corrections).toEqual([{ type: "RetractionIn", id: "55555555" }]);
    expect(cache.getSummary("22222222")?.corrections).toEqual([{ type: "RetractionIn", id: "55555555" }]);
  });

  it("skips efetch when both summary and abstract are cached", async () => {
    const cache = new LRUBackend();
    const client = fakeClient();
    await fetchPubMed({ ids: ["11111111"] }, cache, client);
    const efetch = vi.spyOn(client, "efetch");
    const out = await fetchPubMed({ ids: ["11111111"] }, cache, client);
    expect(efetch).not.toHaveBeenCalled();
    expect(out.articles[0]?.abstract).toBe("A double-blind randomized controlled trial in 40 adults.");
  });
});

describe("NcbiClient requests", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  const esearchResponse = (ids: string[]): Response =>
    new Response(JSON.stringify({ esearchresult: { count: String(ids.length), idlist: ids } }), { status: 200 });
  const tooMany = (retryAfter: string): Response => new Response("", { status: 429, headers: { "retry-after": retryAfter } });

  it("narrows the query to the publication types a design filter can keep", async () => {
    const fetchMock = vi.fn(async () => esearchResponse(["1"]));
    vi.stubGlobal("fetch", fetchMock);
    const client = new NcbiClient({ email: "test@example.com" });
    await client.esearch({ query: "creatine[tiab]", studyTypes: ["randomized-controlled-trial"] });
    const term = new URL(String((fetchMock.mock.calls[0] as unknown[])[0])).searchParams.get("term");
    expect(term).toBe('(creatine[tiab]) AND ("Randomized Controlled Trial"[pt] OR "Equivalence Trial"[pt])');

    // A filter that can keep nothing sends no request.
    expect(await client.esearch({ query: "x", studyTypes: ["cohort"] })).toEqual({ count: 0, pmids: [] });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("returns the same PMIDs for an identical search, as PubMed's relevance order varies between requests", async () => {
    const orders = [["1", "2"], ["2", "3"], ["4"], ["5"], ["6"]];
    const fetchMock = vi.fn(async () => esearchResponse(orders.shift()!));
    vi.stubGlobal("fetch", fetchMock);
    const client = new NcbiClient({ email: "test@example.com" });
    const first = await client.esearch({ query: "x" });
    expect(await client.esearch({ query: "x" })).toEqual(first);
    expect(fetchMock).toHaveBeenCalledTimes(1);

    await client.esearch({ query: "y" });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    const uncached = new NcbiClient({ email: "test@example.com", searchTtlMs: 0 });
    await uncached.esearch({ query: "x" });
    await uncached.esearch({ query: "x" });
    expect(fetchMock).toHaveBeenCalledTimes(4);
  });

  it('with sort "date", returns the records first published last, from PubMed\'s issue-date and date-added orders', async () => {
    // PubMed's pub_date order leads with later issues published online earlier (the semaglutide search, 2026-10-22).
    const dates: Record<string, { pubdate: string; epubdate: string }> = {
      "42886550": { pubdate: "2026 Dec 31", epubdate: "2026 Oct 16" },
      "42894545": { pubdate: "2026 Dec", epubdate: "2026 Oct 17" },
      "42545731": { pubdate: "2027 Jan", epubdate: "2026 Aug 3" },
      "42902597": { pubdate: "2026 Oct 20", epubdate: "2026 Oct 20" },
      "42901618": { pubdate: "2026 Oct 20", epubdate: "2026 Oct 20" },
      "42422741": { pubdate: "2026", epubdate: "2026 Jun 24" },
    };
    const issueOrder = ["42545731", "42886550", "42894545", "42422741"];
    const addedOrder = ["42902597", "42901618", "42894545", "42886550"];
    const fetchMock = vi.fn(async (input: string | URL | Request) => {
      const url = new URL(String(input));
      if (url.pathname.endsWith("esummary.fcgi")) {
        const ids = url.searchParams.get("id")!.split(",");
        return new Response(JSON.stringify({ result: { uids: ids, ...Object.fromEntries(ids.map((id) => [id, { uid: id, title: id, ...dates[id] }])) } }));
      }
      return esearchResponse(url.searchParams.get("sort") === "pub_date" ? issueOrder : addedOrder);
    });
    vi.stubGlobal("fetch", fetchMock);
    const client = new NcbiClient({ email: "test@example.com" });

    const out = await client.esearch({ query: "semaglutide", sort: "date", maxResults: 4 });
    expect(out.pmids).toEqual(["42902597", "42901618", "42894545", "42886550"]);
    const searches = fetchMock.mock.calls.map(([u]) => new URL(String(u))).filter((u) => u.pathname.endsWith("esearch.fcgi"));
    expect(searches.map((u) => [u.searchParams.get("sort"), u.searchParams.get("retmax")])).toEqual([
      ["pub_date", "100"],
      [null, "100"],
    ]);
    // An identical search is served from memory, and so, once, are the summaries of the PMIDs it returned.
    const requests = fetchMock.mock.calls.length;
    expect(await client.esearch({ query: "semaglutide", sort: "date", maxResults: 4 })).toEqual(out);
    expect([...(await client.esummary(out.pmids)).keys()].sort()).toEqual([...out.pmids].sort());
    expect(fetchMock.mock.calls.length).toBe(requests);
    await client.esummary(out.pmids);
    expect(fetchMock.mock.calls.length).toBe(requests + 1);
  });

  it('with sort "date", takes 4 × maxResults from each order and asks esummary for at most 200 at a time', async () => {
    const ids = (from: number) => Array.from({ length: 200 }, (_, i) => String(from + i));
    const fetchMock = vi.fn(async (input: string | URL | Request) => {
      const url = new URL(String(input));
      if (url.pathname.endsWith("esummary.fcgi")) {
        const batch = url.searchParams.get("id")!.split(",");
        return new Response(JSON.stringify({ result: { uids: batch, ...Object.fromEntries(batch.map((id) => [id, { uid: id, pubdate: "2026 Oct 1" }])) } }));
      }
      return esearchResponse(url.searchParams.get("sort") === "pub_date" ? ids(1000) : ids(2000));
    });
    vi.stubGlobal("fetch", fetchMock);
    const out = await new NcbiClient({ email: "test@example.com" }).esearch({ query: "x", sort: "date", maxResults: 50 });
    expect(out.pmids).toHaveLength(50);
    const summaries = fetchMock.mock.calls.map(([u]) => new URL(String(u))).filter((u) => u.pathname.endsWith("esummary.fcgi"));
    expect(summaries.map((u) => u.searchParams.get("id")!.split(",").length)).toEqual([200, 200]);
    const retmax = fetchMock.mock.calls.map(([u]) => new URL(String(u))).find((u) => u.pathname.endsWith("esearch.fcgi"))!.searchParams.get("retmax");
    expect(retmax).toBe("200");
  });

  /** An esearch response reporting `count` hits, `ids` of them listed. */
  const esearchOf = (count: number, ids: string[]): Response =>
    new Response(JSON.stringify({ esearchresult: { count: String(count), idlist: ids } }), { status: 200 });
  const esearchRequests = (mock: { mock: { calls: unknown[][] } }): URL[] =>
    mock.mock.calls.map(([u]) => new URL(String(u))).filter((u) => u.pathname.endsWith("esearch.fcgi"));
  const range = (from: number, to: number): string[] => Array.from({ length: to - from + 1 }, (_, i) => String(from + i));
  // An API key lifts the request pacing from 3 to 10 a second.
  const quick = (config: { searchTtlMs?: number } = {}) => new NcbiClient({ email: "test@example.com", apiKey: "test-key", ...config });

  /** A PubMed whose relevance search holds `count` hits, "1", "2", … in that order, served by retstart and retmax. */
  const relevanceFetch = (count: number) =>
    vi.fn(async (input: string | URL | Request) => {
      const params = new URL(String(input)).searchParams;
      const start = Number(params.get("retstart") ?? 0);
      const length = Math.max(0, Math.min(Number(params.get("retmax")), count - start));
      return esearchOf(count, range(start + 1, start + length));
    });

  it("cuts the pages of a relevance search from one block of 500 PMIDs, in a single request", async () => {
    const fetchMock = relevanceFetch(2000);
    vi.stubGlobal("fetch", fetchMock);
    const client = quick();

    expect((await client.esearch({ query: "x" })).pmids).toEqual(range(1, 10));
    expect(await client.esearch({ query: "x", page: 2 })).toEqual({ count: 2000, pmids: range(11, 20) });
    // Pages of another size are cut from the same list.
    expect((await client.esearch({ query: "x", maxResults: 50, page: 10 })).pmids).toEqual(range(451, 500));
    const requests = esearchRequests(fetchMock);
    expect(requests).toHaveLength(1);
    expect(requests[0]!.searchParams.get("retmax")).toBe("500");
    expect(requests[0]!.searchParams.has("retstart")).toBe(false);

    // Without a search cache, a page is cut from a request of its own.
    const uncached = quick({ searchTtlMs: 0 });
    expect((await uncached.esearch({ query: "x", page: 2 })).pmids).toEqual(range(11, 20));
  });

  it("extends the list with retstart for a page past the first block, and serves later pages from it", async () => {
    const fetchMock = relevanceFetch(2000);
    vi.stubGlobal("fetch", fetchMock);
    const client = quick();
    const page = async (n: number) => (await client.esearch({ query: "x", maxResults: 50, page: n })).pmids;
    const requested = () => esearchRequests(fetchMock).map((u) => [u.searchParams.get("retstart"), u.searchParams.get("retmax")]);

    expect(await page(1)).toEqual(range(1, 50));
    expect(await page(11)).toEqual(range(501, 550));
    expect(requested()).toEqual([[null, "500"], ["500", "500"]]);
    expect(await page(12)).toEqual(range(551, 600));
    expect(await page(1)).toEqual(range(1, 50));
    expect(requested()).toHaveLength(2);
    expect(await page(21)).toEqual(range(1001, 1050));
    expect(requested()[2]).toEqual(["1000", "500"]);

    // A first request for a distant page takes every block up to it.
    const fresh = relevanceFetch(2000);
    vi.stubGlobal("fetch", fresh);
    expect((await quick().esearch({ query: "y", maxResults: 50, page: 11 })).pmids).toEqual(range(501, 550));
    expect(esearchRequests(fresh).map((u) => [u.searchParams.get("retstart"), u.searchParams.get("retmax")])).toEqual([[null, "1000"]]);
  });

  it("drops a PMID an extending block repeats, as PubMed's relevance order drifts, so no page repeats one", async () => {
    const fetchMock = vi.fn(async (input: string | URL | Request) =>
      new URL(String(input)).searchParams.has("retstart") ? esearchOf(600, ["3", ...range(501, 600)]) : esearchOf(600, range(1, 500)),
    );
    vi.stubGlobal("fetch", fetchMock);
    const client = quick();
    const seen: string[] = [];
    for (let page = 1; page <= 12; page++) seen.push(...(await client.esearch({ query: "x", maxResults: 50, page })).pmids);
    expect(seen).toEqual(range(1, 600));
    expect(esearchRequests(fetchMock)).toHaveLength(2);
    // Past the last record there is nothing to fetch.
    expect((await client.esearch({ query: "x", maxResults: 50, page: 13 })).pmids).toEqual([]);
    expect(esearchRequests(fetchMock)).toHaveLength(2);
  });

  it("returns no PMIDs and a warning for a page starting past PubMed's first 9,999 records", async () => {
    const fetchMock = relevanceFetch(20_000);
    vi.stubGlobal("fetch", fetchMock);
    const client = quick();

    const out = await client.esearch({ query: "x", maxResults: 50, page: 201 });
    expect(out).toEqual({ count: 20_000, pmids: [], warning: expect.stringContaining("first 9,999 records") });
    // Only the count is asked for.
    expect(esearchRequests(fetchMock).map((u) => u.searchParams.get("retmax"))).toEqual(["0"]);

    // With the search cached, its count is reused.
    await client.esearch({ query: "y", maxResults: 50 });
    expect(await client.esearch({ query: "y", maxResults: 50, page: 300 })).toMatchObject({ count: 20_000, pmids: [], warning: expect.any(String) });
    expect(esearchRequests(fetchMock)).toHaveLength(2);
  });

  it("serves the records up to the 9,999th, and none from the next one", async () => {
    vi.stubGlobal("fetch", relevanceFetch(20_000));
    // Page 200 of 50 starts at record 9,951: it holds the 49 records served.
    const last = await quick().esearch({ query: "x", maxResults: 50, page: 200 });
    expect(last.pmids).toEqual(range(9951, 9999));
    expect(last).not.toHaveProperty("warning");

    const edge = quick();
    expect((await edge.esearch({ query: "y", maxResults: 3, page: 3333 })).pmids).toEqual(range(9997, 9999));
    expect(await edge.esearch({ query: "y", maxResults: 3, page: 3334 })).toMatchObject({ pmids: [], warning: expect.any(String) });
  });

  /** A PubMed whose `count` hits "1" … `count` were published in that order: the issue-date order lists the oldest first, the date-added order the newest. */
  const dateFetch = (count: number) =>
    vi.fn(async (input: string | URL | Request) => {
      const url = new URL(String(input));
      if (url.pathname.endsWith("esummary.fcgi")) {
        const ids = url.searchParams.get("id")!.split(",");
        const docs = ids.map((id) => [id, { uid: id, title: id, pubdate: String(1000 + Number(id)) }]);
        return new Response(JSON.stringify({ result: { uids: ids, ...Object.fromEntries(docs) } }));
      }
      const length = Math.min(Number(url.searchParams.get("retmax")), count);
      const byIssue = url.searchParams.get("sort") === "pub_date";
      return esearchOf(count, Array.from({ length }, (_, i) => String(byIssue ? i + 1 : count - i)));
    });

  it('with sort "date", cuts the pages of a result the pool holds whole from one order', async () => {
    const fetchMock = dateFetch(25);
    vi.stubGlobal("fetch", fetchMock);
    const client = quick();
    const page = async (n: number) => (await client.esearch({ query: "x", sort: "date", page: n })).pmids;

    expect(await page(1)).toEqual(range(16, 25).reverse());
    expect(await page(2)).toEqual(range(6, 15).reverse());
    expect(await page(3)).toEqual(range(1, 5).reverse());
    expect(esearchRequests(fetchMock)).toHaveLength(2);
  });

  it('with sort "date", pools more of each order for a page past the part of the pool that is final', async () => {
    const fetchMock = dateFetch(5000);
    vi.stubGlobal("fetch", fetchMock);
    const client = quick();
    const page = async (n: number) => (await client.esearch({ query: "x", sort: "date", page: n })).pmids;
    const retmaxes = () => esearchRequests(fetchMock).map((u) => u.searchParams.get("retmax"));

    expect(await page(1)).toEqual(range(4991, 5000).reverse());
    // The first 100 of each order are final to 25 records, so page 2 (to record 20) needs no new request.
    expect(await page(2)).toEqual(range(4981, 4990).reverse());
    expect(retmaxes()).toEqual(["100", "100"]);
    // Page 3 reaches record 30, so 4 × 30 of each order are pooled.
    expect(await page(3)).toEqual(range(4971, 4980).reverse());
    expect(retmaxes()).toEqual(["100", "100", "120", "120"]);
  });

  it("waits out a 429 and retries, holding back the queue, instead of failing the call", async () => {
    vi.useFakeTimers();
    const responses = [tooMany("2"), esearchResponse(["1"]), esearchResponse(["2"])];
    const fetchMock = vi.fn(async () => responses.shift()!);
    vi.stubGlobal("fetch", fetchMock);
    const client = new NcbiClient({ email: "test@example.com" });
    const first = client.esearch({ query: "x" });
    const second = client.esearch({ query: "y" });
    await vi.advanceTimersByTimeAsync(1000);
    // The second search waits behind the first one's retry.
    expect(fetchMock).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(5000);
    expect(await first).toEqual({ count: 1, pmids: ["1"] });
    expect(await second).toEqual({ count: 1, pmids: ["2"] });
  });

  it("gives up with RATE_LIMIT after its retries, or at once when NCBI asks for a long wait", async () => {
    vi.useFakeTimers();
    const fetchMock = vi.fn(async () => tooMany("2"));
    vi.stubGlobal("fetch", fetchMock);
    const client = new NcbiClient({ email: "test@example.com" });
    const pending = client.esearch({ query: "x" }).catch((e: unknown) => e);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(await pending).toMatchObject({ code: "RATE_LIMIT", retryAfter: 2 });
    expect(fetchMock).toHaveBeenCalledTimes(3);

    fetchMock.mockImplementation(async () => tooMany("60"));
    const long = client.esearch({ query: "y" }).catch((e: unknown) => e);
    await vi.advanceTimersByTimeAsync(1000);
    expect(await long).toMatchObject({ code: "RATE_LIMIT", retryAfter: 60 });
    expect(fetchMock).toHaveBeenCalledTimes(4);
  });

  it("keeps the PMCID esummary reports", async () => {
    const doc = {
      uid: "37968687",
      title: "The effects of creatine supplementation on cognitive performance",
      pubdate: "2023 Nov 15",
      articleids: [
        { idtype: "pubmed", value: "37968687" },
        { idtype: "pmc", value: "PMC10647179" },
        { idtype: "pmcid", value: "pmc-id: PMC10647179;" },
        { idtype: "doi", value: "10.1186/s12916-023-03146-5" },
      ],
    };
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ result: { uids: ["37968687"], "37968687": doc } }), { status: 200 })));
    const out = await new NcbiClient({ email: "test@example.com" }).esummary(["37968687"]);
    expect(out.get("37968687")).toMatchObject({ pmcid: "PMC10647179", doi: "10.1186/s12916-023-03146-5" });
  });
});

describe("PubMedAdapter.search", () => {
  it("passes on the page's PMIDs and esearch's warning, and says no page follows past PubMed's 9,999 records", async () => {
    const esearch = vi.fn(async (_input: SearchInput): Promise<{ count: number; pmids: string[]; warning?: string }> => ({ count: 30_000, pmids: [], warning: "Past 9,999." }));
    const adapter = new PubMedAdapter({ esearch } as unknown as NcbiClient);
    expect(await adapter.search({ query: "x", page: 201, maxResults: 50 })).toEqual({ count: 30_000, ids: [], warning: "Past 9,999.", more: false });
    expect(esearch).toHaveBeenCalledWith({ query: "x", page: 201, maxResults: 50 });

    esearch.mockResolvedValue({ count: 30_000, pmids: ["1"] });
    expect((await adapter.search({ query: "x", page: 200, maxResults: 50 })).more).toBe(false);
    expect((await adapter.search({ query: "x", page: 199, maxResults: 50 })).more).toBe(true);

    esearch.mockResolvedValue({ count: 2, pmids: ["1", "2"] });
    expect(await adapter.search({ query: "x" })).toEqual({ count: 2, ids: ["1", "2"], more: false });
  });
});

describe("NcbiClient contact email", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
  });

  /** The query parameters of the client's first request. */
  const sentParams = async (client: NcbiClient): Promise<URLSearchParams> => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ esearchresult: { count: "0", idlist: [] } }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    await client.esearch({ query: "x" });
    return new URL(String((fetchMock.mock.calls[0] as unknown[])[0])).searchParams;
  };

  it("sends the user's NCBI_EMAIL with the tool name", async () => {
    vi.stubEnv("NCBI_EMAIL", "user@example.com");
    const params = await sentParams(new NcbiClient());
    expect(params.get("tool")).toBe("med-research-mcp");
    expect(params.get("email")).toBe("user@example.com");
  });

  it("sends the developer contact when NCBI_EMAIL is unset or blank", async () => {
    for (const value of [undefined, "", "  "]) {
      vi.stubEnv("NCBI_EMAIL", value);
      expect((await sentParams(new NcbiClient())).get("email")).toBe(PROJECT_CONTACT_EMAIL);
    }
  });

  it("prefers an email passed in code over NCBI_EMAIL", async () => {
    vi.stubEnv("NCBI_EMAIL", "user@example.com");
    expect((await sentParams(new NcbiClient({ email: "app@example.com" }))).get("email")).toBe("app@example.com");
  });

  it("sends no email when code passes a blank one", async () => {
    vi.stubEnv("NCBI_EMAIL", "user@example.com");
    expect((await sentParams(new NcbiClient({ email: "" }))).has("email")).toBe(false);
  });

  it("treats placeholders the MCP host left unfilled as unset", async () => {
    vi.stubEnv("NCBI_EMAIL", "${user_config.ncbiEmail}");
    vi.stubEnv("NCBI_API_KEY", "${user_config.ncbiApiKey}");
    const params = await sentParams(new NcbiClient());
    expect(params.get("email")).toBe(PROJECT_CONTACT_EMAIL);
    expect(params.has("api_key")).toBe(false);
  });

  it("sends no stand-in email with another tool name, since NCBI registers tool and email as a pair", async () => {
    vi.stubEnv("NCBI_EMAIL", undefined);
    const params = await sentParams(new NcbiClient({ tool: "other-app" }));
    expect(params.get("tool")).toBe("other-app");
    expect(params.has("email")).toBe(false);
  });
});
