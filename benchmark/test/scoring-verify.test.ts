import { describe, expect, it } from "vitest";
import {
  Verifier,
  auditCitations,
  extractCitations,
  extractPmids,
  type FetchResult,
  type IdToResolve,
  type PmidFacts,
} from "../lib/scoring/verify.js";

const facts = (pmid: string, evidenceScore = 4): PmidFacts => ({
  pmid,
  exists: true,
  evidenceScore,
  studyType: "randomized-controlled-trial",
  title: `T${pmid}`,
  abstract: "",
});

/** Offline verifier: `existing` PMIDs resolve; `dois`/`pmcids` map to PMIDs; everything else is absent. */
function stub(opts: { existing?: string[]; map?: Record<string, string | null>; failFetch?: () => boolean } = {}) {
  const calls = { fetch: [] as string[][], resolve: [] as IdToResolve[] };
  const verifier = new Verifier({
    fetchArticles: async (pmids): Promise<FetchResult> => {
      calls.fetch.push(pmids);
      if (opts.failFetch?.()) throw new Error("ECONNRESET");
      return {
        found: pmids.filter((p) => opts.existing?.includes(p)).map((p) => facts(p)),
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
    expect(audit.valid).toHaveLength(1);
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
    expect(audit.evidenceQuality).toBe(0);
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

