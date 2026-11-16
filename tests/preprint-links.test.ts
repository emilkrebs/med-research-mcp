import { describe, it, expect } from "vitest";
import { parseEuropePmc } from "../src/core/adapters/europepmc";
import type { DatabaseAdapter } from "../src/core/adapters/types";
import { LRUBackend } from "../src/core/cache";
import { classifyArticle, classifyDesign, mergeDuplicate } from "../src/core/grader";
import { searchLiterature } from "../src/core/literature";
import { NcbiClient } from "../src/core/pubmed";
import { CORRECTION_TYPES } from "../src/core/types";
import type { Article, GradedArticle } from "../src/core/types";

/**
 * A preprint and the journal article it became, as Europe PMC returns them (resultType=core, 2026-11-16):
 * PPR1312266 "Preprint of" 42905201, which answers "Preprint in" PPR1312266.
 */
const EPMC_PREPRINT = {
  id: "PPR1312266",
  source: "PPR",
  doi: "10.21203/rs.3.rs-10744245/v1",
  title: "A preprint on a drug comparison",
  authorString: "Doe J",
  bookOrReportDetails: { publisher: "Research Square" },
  pubYear: "2026",
  language: "eng",
  pubTypeList: { pubType: ["Preprint"] },
  commentCorrectionList: {
    commentCorrection: [
      {
        source: "MED",
        id: "42905201",
        reference: "Eur J Orthop Surg Traumatol. 2026 Oct;36(1):417",
        type: "Preprint of",
        note: "CrossRef Pre-print loader",
        orderIn: 10001,
      },
    ],
  },
};

const EPMC_ARTICLE = {
  id: "42905201",
  source: "MED",
  pmid: "42905201",
  doi: "10.1007/s00590-026-05000-9",
  title: "A drug comparison",
  authorString: "Doe J",
  journalInfo: { journal: { title: "Eur J Orthop Surg Traumatol" }, dateOfPublication: "2026 Oct" },
  language: "eng",
  pubTypeList: { pubType: ["Comparative Study", "research-article", "Journal Article"] },
  commentCorrectionList: {
    commentCorrection: [{ source: "PPR", id: "PPR1312266", type: "Preprint in", note: "CrossRef Pre-print loader", orderIn: 10002 }],
  },
};

const epmc = (...results: object[]): Article[] => parseEuropePmc({ hitCount: results.length, resultList: { result: results } }).articles;

/** efetch XML as PubMed returns it for a preprint and its article (shapes of 2026-11-16, made-up PMIDs). */
const PUBMED_XML = `<?xml version="1.0" ?>
<PubmedArticleSet>
<PubmedArticle><MedlineCitation Status="PubMed-not-MEDLINE" Owner="NLM"><PMID Version="1">50000001</PMID>
<Article><ArticleTitle>A preprint on a drug comparison.</ArticleTitle>
<PublicationTypeList><PublicationType UI="D016428">Journal Article</PublicationType><PublicationType UI="D000076942">Preprint</PublicationType></PublicationTypeList></Article>
<CommentsCorrectionsList><CommentsCorrections RefType="UpdateIn"><RefSource>J Test. 2026 Sep 15:abc1.</RefSource><PMID Version="1">50000002</PMID></CommentsCorrections></CommentsCorrectionsList>
</MedlineCitation></PubmedArticle>
<PubmedArticle><MedlineCitation Status="PubMed-not-MEDLINE" Owner="NLM"><PMID Version="1">50000002</PMID>
<Article><ArticleTitle>A drug comparison.</ArticleTitle>
<PublicationTypeList><PublicationType UI="D016428">Journal Article</PublicationType></PublicationTypeList></Article>
<CommentsCorrectionsList><CommentsCorrections RefType="UpdateOf"><RefSource>medRxiv. 2026 May 22:2026.05.20.1.</RefSource><PMID Version="1">50000001</PMID></CommentsCorrections></CommentsCorrectionsList>
</MedlineCitation></PubmedArticle>
</PubmedArticleSet>`;

describe("Europe PMC links between a preprint and its article", () => {
  it("maps 'Preprint of' to UpdateIn and 'Preprint in' to UpdateOf, with the id the other record is keyed by", () => {
    const [preprint, article] = epmc(EPMC_PREPRINT, EPMC_ARTICLE);
    expect(preprint!.corrections).toEqual([{ type: "UpdateIn", id: "42905201" }]);
    expect(article!.corrections).toEqual([{ type: "UpdateOf", id: "PPR1312266" }]);
  });

  it("flags the preprint as updated and the article not at all", () => {
    const [preprint, article] = epmc(EPMC_PREPRINT, EPMC_ARTICLE).map(classifyArticle);
    expect(preprint!.flags).toEqual(["updated", "preprint"]);
    expect(article!.flags).toBeUndefined();
    // Linking changes neither design nor tier.
    expect(preprint).toMatchObject({ studyType: "unknown", designTier: null });
  });

  it("maps PubMed's own pair, which Europe PMC carries for the records it holds under MED", () => {
    const [preprint, article] = epmc(
      {
        id: "50000001",
        source: "MED",
        pmid: "50000001",
        pubTypeList: { pubType: ["Journal Article", "Preprint"] },
        commentCorrectionList: { commentCorrection: [{ source: "MED", id: "50000002", type: "Update in" }] },
      },
      {
        id: "50000002",
        source: "MED",
        pmid: "50000002",
        commentCorrectionList: {
          commentCorrection: [
            { source: "MED", id: "50000001", type: "Update of" },
            { source: "PPR", id: "PPR1237523", type: "Preprint in", note: "Link created based on a title-first author match" },
          ],
        },
      },
    );
    expect(preprint!.corrections).toEqual([{ type: "UpdateIn", id: "50000002" }]);
    // One preprint held under two ids is linked under both.
    expect(article!.corrections).toEqual([
      { type: "UpdateOf", id: "50000001" },
      { type: "UpdateOf", id: "PPR1237523" },
    ]);
  });

  it("keeps heuristic links like the others, drops comment links, and lists a link named twice once", () => {
    const [record] = epmc({
      id: "PPR1",
      source: "PPR",
      commentCorrectionList: {
        commentCorrection: [
          { source: "MED", id: "50000002", type: "Preprint of", note: "Link created based on a title-first author match" },
          { source: "MED", id: "50000002", type: "Update in" },
          { source: "MED", id: "50000003", type: "Comment in" },
        ],
      },
    });
    expect(record!.corrections).toEqual([{ type: "UpdateIn", id: "50000002" }]);
  });

  it("reads a link without an id, and a link type in any case", () => {
    const [record] = epmc({ id: "PPR2", source: "PPR", commentCorrectionList: { commentCorrection: { type: "PREPRINT OF" } } });
    expect(record!.corrections).toEqual([{ type: "UpdateIn" }]);
  });

  it("leaves a preprint without a published version and an article without a preprint unlinked", () => {
    const [bare] = epmc({ id: "PPR3", source: "PPR", pubTypeList: { pubType: ["Preprint"] } });
    expect(bare).not.toHaveProperty("corrections");
    expect(classifyArticle(bare!).flags).toEqual(["preprint"]);
  });
});

describe("PubMed links between a preprint and its article", () => {
  const parsed = new NcbiClient({ email: "" }).parseEfetch(PUBMED_XML);

  it("reads UpdateIn on the preprint and UpdateOf on the article, with the other record's PMID", () => {
    expect(parsed.get("50000001")?.corrections).toEqual([{ type: "UpdateIn", id: "50000002" }]);
    expect(parsed.get("50000002")?.corrections).toEqual([{ type: "UpdateOf", id: "50000001" }]);
  });

  it("flags the preprint as updated and the article not at all", () => {
    const grade = (pmid: string) => {
      const data = parsed.get(pmid)!;
      return classifyArticle({ pmid, title: "", authors: [], journal: "", pubDate: "", ...data });
    };
    expect(grade("50000001").flags).toEqual(["updated", "preprint"]);
    expect(grade("50000002").flags).toBeUndefined();
  });
});

describe("the two databases agree", () => {
  it("gives the same situation the same link types and flags, whichever database it comes from", () => {
    const [epmcPreprint, epmcArticle] = epmc(EPMC_PREPRINT, EPMC_ARTICLE).map(classifyArticle);
    const pubmed = new NcbiClient({ email: "" }).parseEfetch(PUBMED_XML);
    const [pmPreprint, pmArticle] = ["50000001", "50000002"].map((pmid) =>
      classifyArticle({ pmid, title: "", authors: [], journal: "", pubDate: "", ...pubmed.get(pmid)! }),
    );
    const shape = (a: GradedArticle) => ({ links: a.corrections?.map((c) => c.type), flags: a.flags });
    expect(shape(epmcPreprint!)).toEqual(shape(pmPreprint!));
    expect(shape(epmcArticle!)).toEqual(shape(pmArticle!));
  });

  it("uses names PubMed has", () => {
    expect(CORRECTION_TYPES).toEqual(["RetractionIn", "ExpressionOfConcernIn", "ErratumIn", "UpdateIn", "UpdateOf"]);
  });
});

describe("what a link does to a record's grade", () => {
  const classify = (publicationTypes: string[], types: Parameters<typeof classifyDesign>[0]["corrections"] = []) =>
    classifyDesign({ title: "", publicationTypes, corrections: types });

  it("flags UpdateIn as updated, and UpdateOf not at all", () => {
    expect(classify(["Preprint"], [{ type: "UpdateIn", id: "1" }]).flags).toEqual(["updated", "preprint"]);
    expect(classify([], [{ type: "UpdateOf", id: "1" }]).flags).toEqual([]);
    expect(classify([], [{ type: "UpdateIn", id: "1" }]).flags).toEqual(["updated"]);
  });

  it("leaves the design and its tier alone", () => {
    expect(classify(["Randomized Controlled Trial"], [{ type: "UpdateOf", id: "1" }])).toMatchObject({
      studyType: "randomized-controlled-trial",
      designTier: 4,
      flags: [],
    });
    expect(classify(["Randomized Controlled Trial", "Preprint"], [{ type: "UpdateIn", id: "1" }])).toMatchObject({
      designTier: 4,
      flags: ["updated", "preprint"],
    });
  });
});

describe("merging two copies of one record keeps the links", () => {
  const graded = (over: Partial<GradedArticle>): GradedArticle => ({
    pmid: "1",
    title: "A preprint",
    authors: [],
    journal: "medRxiv",
    pubDate: "2026",
    publicationTypes: ["Preprint"],
    studyType: "unknown",
    designTier: null,
    ...over,
  });
  const linked = graded({ corrections: [{ type: "UpdateIn", id: "50000002" }], flags: ["updated", "preprint"] });
  const unlinked = graded({ pmid: "PPR1", database: "europepmc", flags: ["preprint"] });

  it("takes the published version from the copy that has it, whichever copy is kept", () => {
    for (const merged of [mergeDuplicate(unlinked, linked), mergeDuplicate(linked, unlinked)]) {
      expect(merged.corrections).toEqual([{ type: "UpdateIn", id: "50000002" }]);
      expect(merged.flags).toEqual(["updated", "preprint"]);
    }
    expect(mergeDuplicate(unlinked, linked).pmid).toBe("PPR1");
  });

  it("lists a link both copies have once, and adds the ids only one has", () => {
    const other = graded({ pmid: "PPR1", corrections: [{ type: "UpdateIn", id: "50000002" }, { type: "UpdateIn", id: "50000009" }] });
    expect(mergeDuplicate(linked, other).corrections).toEqual([
      { type: "UpdateIn", id: "50000002" },
      { type: "UpdateIn", id: "50000009" },
    ]);
  });

  it("adds a link without an id only when the kept copy has none of its type", () => {
    const idless = graded({ corrections: [{ type: "ErratumIn" }] });
    expect(mergeDuplicate(linked, idless).corrections).toEqual([{ type: "UpdateIn", id: "50000002" }, { type: "ErratumIn" }]);
    const withId = graded({ corrections: [{ type: "ErratumIn", id: "7" }] });
    expect(mergeDuplicate(withId, idless).corrections).toEqual([{ type: "ErratumIn", id: "7" }]);
  });

  it("returns the kept copy itself when the other adds nothing", () => {
    expect(mergeDuplicate(linked, graded({ flags: ["preprint"] }))).toBe(linked);
    expect(mergeDuplicate(linked, { ...linked, pmid: "PPR1" })).toBe(linked);
  });

  it("adds links without adding a flags property to a copy that has none", () => {
    const merged = mergeDuplicate(graded({}), graded({ pmid: "2", corrections: [{ type: "UpdateOf", id: "50000001" }] }));
    expect(merged.corrections).toEqual([{ type: "UpdateOf", id: "50000001" }]);
    expect(merged).not.toHaveProperty("flags");
  });

  it("still passes a retraction on with its link, and zeroes the tier", () => {
    const retracted = graded({
      pmid: "3",
      corrections: [{ type: "RetractionIn", id: "60000001" }],
      flags: ["retracted", "preprint"],
      designTier: 0,
    });
    const merged = mergeDuplicate(graded({ designTier: 4, studyType: "randomized-controlled-trial" }), retracted);
    // The kept copy is not a preprint, so only the paper-level flag comes over.
    expect(merged).toMatchObject({ flags: ["retracted"], designTier: 0, corrections: [{ type: "RetractionIn", id: "60000001" }] });
  });
});

describe("a search with a preprint and its article", () => {
  const preprint: Article = {
    pmid: "PPR1312266",
    title: "A preprint on a drug comparison",
    authors: ["Doe J"],
    journal: "Research Square",
    pubDate: "2026",
    doi: "10.21203/rs.3.rs-10744245/v1",
    publicationTypes: ["Preprint"],
    database: "europepmc",
    corrections: [{ type: "UpdateIn", id: "42905201" }],
  };
  const article: Article = {
    pmid: "42905201",
    title: "A drug comparison",
    authors: ["Doe J"],
    journal: "Eur J Orthop Surg Traumatol",
    pubDate: "2026 Oct",
    doi: "10.1007/s00590-026-05000-9",
    publicationTypes: ["Randomized Controlled Trial"],
    corrections: [{ type: "UpdateOf", id: "PPR1312266" }],
  };
  const serving = (id: string, articles: Article[]): DatabaseAdapter => ({
    id,
    name: id,
    search: async () => ({ count: articles.length, ids: articles.map((a) => a.pmid) }),
    fetch: async (ids) => articles.filter((a) => ids.includes(a.pmid)),
  });

  it("returns both as two records, each with its link, and in the order its tier gives", async () => {
    const out = await searchLiterature({ query: "drug comparison", database: "all" }, new LRUBackend(), [
      serving("europepmc", [preprint]),
      serving("pubmed", [article]),
    ]);
    expect(out.articles.map((a) => a.pmid)).toEqual(["42905201", "PPR1312266"]);
    expect(out.articles.map((a) => a.corrections)).toEqual([[{ type: "UpdateOf", id: "PPR1312266" }], [{ type: "UpdateIn", id: "42905201" }]]);
    expect(out.articles.map((a) => a.flags)).toEqual([undefined, ["updated", "preprint"]]);
    expect(out.total).toBe(2);
  });

  it("merges the copies of a preprint that two databases hold, with the link only one has", async () => {
    const heldByPubmed: Article = { ...preprint, pmid: "50000001", database: undefined, corrections: undefined };
    delete heldByPubmed.database;
    delete heldByPubmed.corrections;
    const out = await searchLiterature({ query: "drug comparison", database: "all" }, new LRUBackend(), [
      serving("pubmed", [heldByPubmed]),
      serving("europepmc", [preprint]),
    ]);
    expect(out.articles).toHaveLength(1);
    expect(out.articles[0]).toMatchObject({
      pmid: "50000001",
      flags: ["updated", "preprint"],
      corrections: [{ type: "UpdateIn", id: "42905201" }],
    });
  });
});
