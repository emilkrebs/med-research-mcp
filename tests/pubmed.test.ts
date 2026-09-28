import { describe, it, expect, vi, afterEach } from "vitest";
import { NcbiClient, searchPubMed, fetchPubMed } from "../src/core/pubmed";
import { LRUBackend } from "../src/core/cache";
import type { NcbiArticle } from "../src/core/types";

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

  it("handles an unlabeled single abstract section", () => {
    expect(parsed.get("22222222")?.abstract).toBe(
      "This narrative review summarizes nootropic evidence.",
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
        ["11111111", { abstract: "A double-blind randomized controlled trial in 40 adults.", publicationTypes: ["Randomized Controlled Trial"] }],
        ["22222222", { abstract: "This narrative review summarizes evidence.", publicationTypes: ["Review"] }],
      ]),
  } as unknown as NcbiClient;
}

describe("searchPubMed orchestration", () => {
  it("grades results and preserves esearch order", async () => {
    const out = await searchPubMed({ query: "creatine" }, new LRUBackend(), fakeClient());
    expect(out.total).toBe(2);
    expect(out.articles.map((a) => a.pmid)).toEqual(["11111111", "22222222"]);
    expect(out.articles[0]?.studyType).toBe("randomized-controlled-trial");
    expect(out.articles[0]?.evidenceScore).toBe(4);
    expect(out.articles[1]?.studyType).toBe("review");
    expect(out.articles[1]?.evidenceScore).toBe(1);
  });

  it("filters by minEvidenceScore", async () => {
    const out = await searchPubMed({ query: "x", minEvidenceScore: 4 }, new LRUBackend(), fakeClient());
    expect(out.articles).toHaveLength(1);
    expect(out.articles[0]?.pmid).toBe("11111111");
  });

  it("filters by study type", async () => {
    const out = await searchPubMed({ query: "x", studyTypes: ["review"] }, new LRUBackend(), fakeClient());
    expect(out.articles).toHaveLength(1);
    expect(out.articles[0]?.studyType).toBe("review");
  });
});
