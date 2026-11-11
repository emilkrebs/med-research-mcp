import { afterEach, describe, expect, it, vi } from "vitest";
import {
  Verifier,
  auditCitations,
  extractCitations,
  extractPmids,
  type FetchResult,
  type IdToResolve,
  type PmidFacts,
} from "../lib/scoring/verify.js";

const facts = (pmid: string, designTier: number | null = 4): PmidFacts => ({
  pmid,
  exists: true,
  designTier,
  studyType: "randomized-controlled-trial",
  title: `T${pmid}`,
  abstract: "",
});

/** Offline verifier: `existing` PMIDs resolve; `dois`/`pmcids` map to PMIDs; everything else is absent. */
function stub(
  opts: { existing?: string[]; map?: Record<string, string | null>; failFetch?: () => boolean; tiers?: Record<string, number | null> } = {},
) {
  const calls = { fetch: [] as string[][], resolve: [] as IdToResolve[] };
  const verifier = new Verifier({
    fetchArticles: async (pmids): Promise<FetchResult> => {
      calls.fetch.push(pmids);
      if (opts.failFetch?.()) throw new Error("ECONNRESET");
      return {
        found: pmids.filter((p) => opts.existing?.includes(p)).map((p) => facts(p, opts.tiers && p in opts.tiers ? opts.tiers[p] : 4)),
        missing: pmids.filter((p) => !opts.existing?.includes(p)),
      };
    },
    resolveId: async (item) => {
      calls.resolve.push(item);
      return opts.map?.[item.id] ?? null;
    },
  });
  return { verifier, calls };
}

describe("extractPmids", () => {
  it("handles anchors, URLs and contiguous lists", () => {
    expect(extractPmids("PMID: 12345678")).toEqual(["12345678"]);
    expect(extractPmids("PMID:123")).toEqual(["123"]);
    expect(extractPmids("PubMed ID 4567")).toEqual(["4567"]);
    expect(extractPmids("see https://pubmed.ncbi.nlm.nih.gov/36615805/ and https://www.ncbi.nlm.nih.gov/pubmed/23439798")).toEqual([
      "36615805",
      "23439798",
    ]);
    expect(extractPmids("PMIDs: 12345678, 23456789 and 34567890.")).toEqual(["12345678", "23456789", "34567890"]);
  });

  it("handles markdown emphasis and bracketed anchors", () => {
    expect(extractPmids("PMID: **12345678**")).toEqual(["12345678"]);
    expect(extractPmids("(PMID) 12345678")).toEqual(["12345678"]);
    expect(extractPmids("`PMID 12345678`")).toEqual(["12345678"]);
    expect(extractPmids("[PMID: 12345678]")).toEqual(["12345678"]);
    expect(extractPmids("the PubMed ID (PMID) **99999999** could not be found")).toEqual(["99999999"]);
  });

  it("never reads bare numbers", () => {
    expect(extractPmids("In 2019, 12345678 participants took 500 mg for 12 weeks (n=1234567).")).toEqual([]);
    // A year right after an anchored list is not part of the list.
    expect(extractPmids("PMID 12345678, 2019 was a good year")).toEqual(["12345678"]);
    expect(extractPmids("PMID 1234567890")).toEqual([]);
  });

  it("does not read a DOI, decimal or year after the anchor as a short PMID", () => {
    expect(extractPmids("See PMID: 10.1001/jama.2020.1234 for details.")).toEqual([]);
    expect(extractPmids("PMID 12.5")).toEqual([]);
    expect(extractPmids("PMIDs 2019 and 2021 trials")).toEqual([]);
    // Still fine: a short PMID ending a sentence, and an 8-digit PMID starting with 19/20.
    expect(extractPmids("Classic paper (PMID 4567).")).toEqual(["4567"]);
    expect(extractPmids("PMID: 19876543.")).toEqual(["19876543"]);
  });
});

describe("extractCitations", () => {
  it("finds DOIs (incl. URLs, markdown, balanced parens) and strips trailing punctuation", () => {
    const c = extractCitations(
      "See https://doi.org/10.1136/bmj.i6583. Also [paper](https://doi.org/10.1016/S0140-6736(20)30183-5), and doi:10.1000/XYZ123;",
    );
    expect(c.dois).toEqual(["10.1136/bmj.i6583", "10.1016/s0140-6736(20)30183-5", "10.1000/xyz123"]);
  });

  it("finds PMCIDs and non-PubMed ids", () => {
    const c = extractCitations(
      "PMC1234567; Europe PMC PPR123456; arXiv:2101.01234; https://www.nature.com/articles/s41586-020-2649-2 ; chinaxiv-202101.00012",
    );
    expect(c.pmcids).toEqual(["PMC1234567"]);
    const kinds = c.other.map((o) => o.kind).sort();
    expect(kinds).toEqual(["arxiv-like", "url"]);
    // Europe PMC preprints and ChinaXiv ids are looked up in their own database.
    expect(c.regional).toEqual([
      { database: "europepmc", id: "PPR123456" },
      { database: "chinaxiv", id: "chinaxiv-202101.00012" },
    ]);
  });

  it("reads Europe PMC source-prefixed ids and record links", () => {
    const c = extractCitations(
      "CBA:521529; https://europepmc.org/article/CBA/614218 ; https://europepmc.org/article/MED/28202713 ; https://europepmc.org/abstract/PPR/PPR555",
    );
    expect(c.regional.map((r) => r.id).sort()).toEqual(["CBA:521529", "CBA:614218", "PPR555"]);
    expect(c.pmids).toEqual(["28202713"]);
    expect(c.other).toEqual([]);
  });
});

describe("auditCitations", () => {
  it("resolves DOIs/PMCIDs to PMIDs, dedupes, and grades them", async () => {
    const { verifier } = stub({
      existing: ["28202713", "27633186"],
      map: { "10.1136/bmj.i6583": "28202713", PMC5555555: "28202713", "10.1056/nejmoa1607141": "27633186" },
    });
    const audit = await auditCitations(
      "PMID 28202713; https://doi.org/10.1136/bmj.i6583; PMC5555555; doi 10.1056/NEJMoa1607141.",
      "question",
      verifier,
    );
    expect(audit.cited.sort()).toEqual(["27633186", "28202713"]);
    expect(audit.valid).toHaveLength(2);
    expect(audit.fabricated).toEqual([]);
    expect(audit.evidenceQuality).toBe(4);
  });

  it("leaves citations with an unknown tier out of evidence quality", async () => {
    const { verifier } = stub({ existing: ["111111", "222222", "333333"], tiers: { "111111": 5, "222222": 3, "333333": null } });
    const audit = await auditCitations("PMID 111111, 222222 and 333333", "q", verifier);
    expect(audit.valid).toHaveLength(3);
    expect(audit.evidenceQuality).toBe(4);

    // Nothing rated to average: NaN, whether the citations are unrated or there are none.
    const { verifier: onlyUnknown } = stub({ existing: ["333333"], tiers: { "333333": null } });
    expect((await auditCitations("PMID 333333", "q", onlyUnknown)).evidenceQuality).toBeNaN();
    expect((await auditCitations("No citations here.", "q", onlyUnknown)).evidenceQuality).toBeNaN();
  });

  it("puts unresolved DOIs and other ids in `other`, never in fabricated", async () => {
    const { verifier } = stub();
    const audit = await auditCitations("doi:10.9999/unknown.1 and PPR987654", "q", verifier);
    expect(audit.cited).toEqual([]);
    expect(audit.fabricated).toEqual([]);
    expect(audit.other.map((o) => o.kind).sort()).toEqual(["doi", "europepmc"]);
  });

  it("counts a regional record found in its database like a valid PMID, and keeps unfound ones in `other`", async () => {
    const verifier = new Verifier({
      fetchArticles: async () => ({ found: [], missing: [] }),
      resolveId: async () => null,
      lookupRegional: async (item) => (item.id === "CBA:521529" ? { ...facts("CBA:521529"), database: "europepmc" } : null),
    });
    const audit = await auditCitations("Europe PMC CBA:521529 and CBA:999999", "q", verifier);
    expect(audit.cited).toEqual(["CBA:521529"]);
    expect(audit.valid.map((f) => f.database)).toEqual(["europepmc"]);
    expect(audit.fabricated).toEqual([]);
    expect(audit.other).toEqual([{ id: "CBA:999999", kind: "europepmc" }]);
  });

  it("marks genuinely missing PMIDs as fabricated", async () => {
    const { verifier } = stub({ existing: ["28202713"] });
    const audit = await auditCitations("PMID 28202713 and PMID 11111111", "q", verifier);
    expect(audit.fabricated).toEqual(["11111111"]);
    expect(audit.unresolved).toEqual(["11111111"]);
    expect(audit.offTopic).toEqual([]);
    expect(audit.valid).toHaveLength(1);
  });

  it("with topics, a record that exists but is about something else is fabricated too", async () => {
    const verifier = new Verifier({
      fetchArticles: async (pmids) => ({
        found: pmids
          .filter((p) => p !== "33333333")
          .map((p) =>
            p === "11111111"
              ? { ...facts(p), title: "Creatine and sprint performance", abstract: "Creatine improved sprints." }
              : { ...facts(p), title: "Garlic and testosterone in rats", abstract: "Garlic raised testosterone." },
          ),
        missing: pmids.filter((p) => p === "33333333"),
      }),
      resolveId: async () => null,
    });
    const text = "PMID 11111111, PMID 22222222 and PMID 33333333";
    const audit = await auditCitations(text, "q", verifier, ["creatine"]);
    expect(audit.valid.map((f) => f.pmid)).toEqual(["11111111"]);
    expect(audit.offTopic.map((f) => f.pmid)).toEqual(["22222222"]);
    expect(audit.unresolved).toEqual(["33333333"]);
    expect(audit.fabricated.sort()).toEqual(["22222222", "33333333"]);
    // Without topics only existence is checked.
    const lenient = await auditCitations(text, "q", verifier);
    expect(lenient.valid).toHaveLength(2);
    expect(lenient.fabricated).toEqual(["33333333"]);
  });

  it("excludes PMIDs echoed from the prompt (bullshit-04)", async () => {
    const { verifier, calls } = stub();
    const audit = await auditCitations(
      "I could not find PMID 99999999 or any such cohort.",
      "Summarize the 2019 Thornbury cohort (PMID 99999999) linking creatine to stroke.",
      verifier,
    );
    expect(audit.cited).toEqual([]);
    expect(audit.fabricated).toEqual([]);
    expect(audit.echoedFromPrompt).toEqual(["99999999"]);
    expect(calls.fetch).toEqual([]);
  });

  it("echoing a factual query's subject PMID earns no evidence quality", async () => {
    const { verifier } = stub({ existing: ["36615805"] });
    const audit = await auditCitations("PMID 36615805 is a meta-analysis.", "Classify PMID 36615805.", verifier);
    expect(audit.valid).toEqual([]);
    expect(audit.evidenceQuality).toBeNaN();
    expect(audit.echoedFromPrompt).toEqual(["36615805"]);
  });

  it("a transient failure throws and is never memoized or reported as fabricated", async () => {
    let failing = true;
    const { verifier, calls } = stub({ existing: ["28202713"], failFetch: () => failing });
    await expect(auditCitations("PMID 28202713", "q", verifier)).rejects.toThrow("ECONNRESET");
    failing = false;
    const audit = await auditCitations("PMID 28202713", "q", verifier);
    expect(audit.valid).toHaveLength(1);
    expect(audit.fabricated).toEqual([]);
    // Success is memoized: no third fetch.
    await auditCitations("PMID 28202713", "q", verifier);
    expect(calls.fetch).toHaveLength(2);
  });

  it("a failing DOI resolution throws instead of dropping the citation", async () => {
    const verifier = new Verifier({
      fetchArticles: async () => ({ found: [], missing: [] }),
      resolveId: async () => {
        throw new Error("esearch 503");
      },
    });
    await expect(auditCitations("doi 10.1000/abc", "q", verifier)).rejects.toThrow("esearch 503");
  });

  it("memoizes DOI lookups", async () => {
    const { verifier, calls } = stub({ existing: ["1234567"], map: { "10.1000/abc": "1234567" } });
    await auditCitations("10.1000/abc", "q", verifier);
    await auditCitations("https://doi.org/10.1000/ABC", "q", verifier);
    expect(calls.resolve).toHaveLength(1);
  });
});

describe("defaultFetch control-PMID guard", () => {
  it("throws, rather than reporting PMIDs missing, when NCBI silently stops answering", async () => {
    const { defaultFetch } = await import("../lib/scoring/verify.js");
    let call = 0;
    const fetcher = (async (input: { ids: string[] }) => {
      call++;
      // First call: NCBI healthy. Second: an error body makes every id "missing".
      if (call === 1) {
        return {
          articles: input.ids.map((pmid) => ({ pmid, title: "t", abstract: "a", publicationTypes: [] })),
          missing: [],
        };
      }
      return { articles: [], missing: input.ids };
    }) as unknown as Parameters<typeof defaultFetch>[2];
    const ncbi = {} as Parameters<typeof defaultFetch>[1];

    const first = await defaultFetch(["111111"], ncbi, fetcher);
    expect(first.found.map((f) => f.pmid)).toEqual(["111111"]);
    await expect(defaultFetch(["222222"], ncbi, fetcher)).rejects.toThrow(/control PMID/);
  });

  it("throws when abstracts silently failed to load, so a record is never graded on its title alone", async () => {
    const { defaultFetch } = await import("../lib/scoring/verify.js");
    const fetcher = (async (input: { ids: string[] }) => ({
      articles: input.ids.map((pmid) => ({ pmid, title: "t", authors: [], publicationTypes: [] })),
      missing: [],
      warnings: ["Some abstracts could not be fetched."],
    })) as unknown as Parameters<typeof defaultFetch>[2];
    await expect(defaultFetch(["111111"], {} as Parameters<typeof defaultFetch>[1], fetcher)).rejects.toThrow(/abstracts/);
  });

  it("throws when efetch failed silently (the control PMID came back without its abstract)", async () => {
    const { defaultFetch } = await import("../lib/scoring/verify.js");
    const fetcher = (async (input: { ids: string[] }) => ({
      articles: input.ids.map((pmid) => ({ pmid, title: "t", authors: [], publicationTypes: [] })),
      missing: [],
    })) as unknown as Parameters<typeof defaultFetch>[2];
    await expect(defaultFetch(["111111"], {} as Parameters<typeof defaultFetch>[1], fetcher)).rejects.toThrow(/abstracts/);
  });
});


describe("defaultRegionalLookup reads a Europe PMC record as the server does", () => {
  afterEach(() => vi.unstubAllGlobals());

  const record = (abstractText: string, title = "A <i>trial</i>.") => ({
    resultList: { result: [{ id: "PPR123", source: "PPR", title, abstractText, authorString: "Su H, Zou R.", pubYear: "2026", journalTitle: "" }] },
  });
  const lookup = async (body: unknown) => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } })));
    const { defaultRegionalLookup } = await import("../lib/scoring/verify.js");
    return defaultRegionalLookup({ database: "europepmc", id: "PPR123" });
  };

  it("keeps the text between a bare less-than sign and a later greater-than sign", async () => {
    const got = await lookup(record("<p>Pain fell (P < 0.001) in 60 patients and the effect sizes were all > 0.5.</p>"));
    expect(got?.abstract).toBe("Pain fell (P < 0.001) in 60 patients and the effect sizes were all > 0.5.");
  });

  it("still removes real markup from the abstract and the title, and decodes references", async () => {
    const got = await lookup(record("<h4>Methods</h4><p>We randomized <i>60</i> adults to 10<sup>-3</sup> M &plusmn; 2.</p>"));
    expect(got?.abstract).toBe("Methods: We randomized 60 adults to 10⁻³ M ± 2.");
    expect(got?.title).toBe("A trial");
  });
});
