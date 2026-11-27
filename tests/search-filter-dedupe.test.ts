import { describe, it, expect, vi, afterEach } from "vitest";
import { searchLiterature } from "../src/core/literature";
import { NcbiClient, searchPubMed } from "../src/core/pubmed";
import { EuropePmcAdapter } from "../src/core/adapters/europepmc";
import type { AdapterHttp } from "../src/core/adapters/http";
import { LRUBackend } from "../src/core/cache";
import { classifyDesign, designPublicationTypes, excludedPublicationTypes, filteredPageWarning } from "../src/core/grader";
import { STUDY_TYPES } from "../src/core/types";
import type { DatabaseAdapter } from "../src/core/adapters/types";
import type { NcbiArticle, StudyType } from "../src/core/types";

/** A fake adapter that serves a fixed set of articles from memory. */
function fakeAdapter(id: string, articles: NcbiArticle[], count = articles.length): DatabaseAdapter {
  return {
    id,
    name: id,
    search: async () => ({ count, ids: articles.map((a) => a.id) }),
    fetch: async (ids) => articles.filter((a) => ids.includes(a.id)),
  };
}

const record = (id: string, extra: Partial<NcbiArticle> = {}): NcbiArticle => ({
  id,
  title: `Record ${id}`,
  authors: ["Doe J"],
  journal: "J Test",
  pubDate: "1984",
  publicationTypes: [],
  ...extra,
});

/** The design tags, one of each group the classifier reads, in the order of its table: the 10 tag groups. */
const GROUPS = [
  "Network Meta-Analysis",
  "Meta-Analysis",
  "Systematic Review",
  "Randomized Controlled Trial",
  "Controlled Clinical Trial",
  "Clinical Trial",
  "Observational Study",
  "Case Reports",
  "Review",
  "Clinical Trial, Veterinary",
];

/** The design names of every study type: every publication type a design filter can ask a database about. */
const ALL_DESIGN_NAMES = designPublicationTypes(STUDY_TYPES.filter((t) => t !== "unknown"))!;

/** The runs of words of a name, as Europe PMC matches a PUB_TYPE phrase against a publication type. */
const words = (name: string): string[] => name.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
const containsRun = (hay: string[], needle: string[]): boolean => hay.some((_, i) => needle.every((w, j) => hay[i + j] === w));

describe("excludedPublicationTypes", () => {
  it("lists every design tag for unknown, and is exact: a record has such a tag exactly when it is not unknown", () => {
    const excluded = excludedPublicationTypes(["unknown"]);
    expect(new Set(excluded)).toEqual(new Set(ALL_DESIGN_NAMES));
    for (let mask = 0; mask < 1 << GROUPS.length; mask++) {
      const tags = GROUPS.filter((_, i) => mask & (1 << i));
      expect(tags.some((t) => excluded.includes(t))).toBe(classifyDesign({ title: "", publicationTypes: tags }).studyType !== "unknown");
    }
  });

  it("leaves a filter that names just its design as it was, and a search without a filter", () => {
    expect(excludedPublicationTypes()).toEqual([]);
    expect(excludedPublicationTypes([])).toEqual([]);
    for (const type of ["randomized-controlled-trial", "meta-analysis", "systematic-review", "observational", "review", "case-report", "animal-study"] as const) {
      expect(excludedPublicationTypes([type])).toEqual([]);
    }
    expect(excludedPublicationTypes(undefined, 4)).toEqual([]);
  });

  it("excludes the designs the classifier ranks above a clinical trial, and not the tags it ranks below one", () => {
    const excluded = excludedPublicationTypes(["clinical-trial"]);
    // A synthesis, an RCT and a controlled trial win over a Clinical Trial tag; so do veterinary types, and an observational or case-report
    // tag (the lowest tier wins, and the observational candidate comes first on a tie).
    for (const name of ["Network Meta-Analysis", "Meta-Analysis", "Systematic Review", "Randomized Controlled Trial", "Equivalence Trial", "Controlled Clinical Trial"]) {
      expect(excluded).toContain(name);
    }
    for (const name of ["Observational Study", "Case Reports", "Clinical Trial, Veterinary", "Randomized Controlled Trial, Veterinary", "Observational Study, Veterinary"]) {
      expect(excluded).toContain(name);
    }
    // A record tagged Clinical Trial and Review is a clinical trial (a bare review comes last), and the trial tags themselves are the filter's.
    expect(excluded).not.toContain("Review");
    expect(excluded).not.toContain("Scoping Review");
    for (const name of designPublicationTypes(["clinical-trial"])!) expect(excluded).not.toContain(name);
  });

  it("excludes the designs above a controlled trial that is not randomized", () => {
    // Its tag finds every RCT in PubMed, as Clinical Trial's does, and an RCT also tagged Controlled Clinical Trial is an RCT.
    expect(excludedPublicationTypes(["non-randomized-trial"])).toEqual([
      "Network Meta-Analysis",
      "Meta-Analysis",
      "Systematic Review",
      "Randomized Controlled Trial",
      "Equivalence Trial",
      "Observational Study",
      "Case Reports",
      "Clinical Trial, Veterinary",
      "Randomized Controlled Trial, Veterinary",
      "Observational Study, Veterinary",
    ]);
  });

  it("keeps the tags of every design that the filter wants together with a trial, or unknown", () => {
    // An RCT also tagged as a controlled or any other trial is an RCT: neither tag can go.
    const withRct = excludedPublicationTypes(["clinical-trial", "randomized-controlled-trial"]);
    expect(withRct).not.toContain("Randomized Controlled Trial");
    expect(withRct).not.toContain("Controlled Clinical Trial");
    expect(withRct).not.toContain("Clinical Trial");
    expect(withRct).toContain("Meta-Analysis");
    // A veterinary tag outranks everything, so a filter that wants animal-study can exclude nothing.
    expect(excludedPublicationTypes(["unknown", "animal-study"])).toEqual([]);
    expect(excludedPublicationTypes(["clinical-trial", "animal-study"])).toEqual([]);
  });

  it("never lists a tag of a record the filter keeps, whichever tags the record has besides", () => {
    const filters: [StudyType[], number | undefined][] = [
      [["unknown"], undefined],
      [["clinical-trial"], undefined],
      [["non-randomized-trial"], undefined],
      [["clinical-trial", "randomized-controlled-trial"], undefined],
      [["unknown", "randomized-controlled-trial"], undefined],
      [["unknown", "review"], undefined],
      [["unknown", "observational", "case-report"], undefined],
      [["clinical-trial", "review"], undefined],
      [["clinical-trial", "meta-analysis"], undefined],
      [["unknown", "clinical-trial"], undefined],
      [["clinical-trial", "non-randomized-trial", "randomized-controlled-trial"], 2],
      [["clinical-trial", "randomized-controlled-trial"], 4],
      [["unknown", "randomized-controlled-trial"], 4],
      [["clinical-trial"], 3],
    ];
    for (const [studyTypes, minDesignTier] of filters) {
      const excluded = excludedPublicationTypes(studyTypes, minDesignTier);
      for (let mask = 0; mask < 1 << GROUPS.length; mask++) {
        const tags = GROUPS.filter((_, i) => mask & (1 << i));
        const { studyType, designTier } = classifyDesign({ title: "", publicationTypes: tags });
        const keeps = studyTypes.includes(studyType) && (designTier ?? 0) >= (minDesignTier ?? 0);
        if (keeps) expect(tags.filter((t) => excluded.includes(t)), `${studyTypes} tier ${minDesignTier}: ${tags}`).toEqual([]);
      }
    }
  });

  it("excludes every longer design type that contains an excluded name, as Europe PMC matches a PUB_TYPE phrase by its words", () => {
    // PUB_TYPE:"Observational Study" also finds "Observational Study, Veterinary", "Meta-Analysis" "Network Meta-Analysis", and so on.
    for (const studyTypes of [["unknown"], ["clinical-trial"], ["non-randomized-trial"], ["unknown", "randomized-controlled-trial"], ["unknown", "review"]] as StudyType[][]) {
      const excluded = excludedPublicationTypes(studyTypes);
      for (const name of excluded) {
        const wider = ALL_DESIGN_NAMES.filter((other) => other !== name && containsRun(words(other), words(name)));
        expect(wider.filter((other) => !excluded.includes(other)), `${studyTypes}: ${name}`).toEqual([]);
      }
    }
  });
});

describe("the PubMed query of a design filter", () => {
  afterEach(() => vi.unstubAllGlobals());

  async function term(input: Parameters<NcbiClient["esearch"]>[0]): Promise<string | null> {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ esearchresult: { count: "1", idlist: ["1"] } }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    await new NcbiClient({ email: "test@example.com" }).esearch(input);
    return new URL(String((fetchMock.mock.calls[0] as unknown[])[0])).searchParams.get("term");
  }

  it("takes unknown away from every design tag, by the tag alone, as [pt] would also take the narrower types", async () => {
    const excluded = excludedPublicationTypes(["unknown"]);
    expect(await term({ query: "creatine cognition", studyTypes: ["unknown"] })).toBe(
      `(creatine cognition) NOT (${excluded.map((t) => `"${t}"[pt:noexp]`).join(" OR ")})`,
    );
    expect(excluded).toContain("Randomized Controlled Trial");
    expect(excluded).toContain("Review");
  });

  it("keeps a clinical-trial filter's tags and excludes the designs above it", async () => {
    const wanted = designPublicationTypes(["clinical-trial"])!.map((t) => `"${t}"[pt]`).join(" OR ");
    const excluded = excludedPublicationTypes(["clinical-trial"]).map((t) => `"${t}"[pt:noexp]`).join(" OR ");
    expect(await term({ query: "tirzepatide apnea", studyTypes: ["clinical-trial"] })).toBe(`(tirzepatide apnea) AND (${wanted}) NOT (${excluded})`);
  });

  it("writes the whole query for a controlled trial that is not randomized", async () => {
    expect(await term({ query: "creatine[tiab]", studyTypes: ["non-randomized-trial"] })).toBe(
      '(creatine[tiab]) AND ("Controlled Clinical Trial"[pt]) NOT ("Network Meta-Analysis"[pt:noexp] OR "Meta-Analysis"[pt:noexp] OR ' +
        '"Systematic Review"[pt:noexp] OR "Randomized Controlled Trial"[pt:noexp] OR "Equivalence Trial"[pt:noexp] OR ' +
        '"Observational Study"[pt:noexp] OR "Case Reports"[pt:noexp] OR "Clinical Trial, Veterinary"[pt:noexp] OR ' +
        '"Randomized Controlled Trial, Veterinary"[pt:noexp] OR "Observational Study, Veterinary"[pt:noexp])',
    );
  });

  it("leaves the query of other filters, and of none, as it was", async () => {
    expect(await term({ query: "creatine[tiab]", studyTypes: ["randomized-controlled-trial"] })).toBe(
      '(creatine[tiab]) AND ("Randomized Controlled Trial"[pt] OR "Equivalence Trial"[pt])',
    );
    expect(await term({ query: "creatine" })).toBe("creatine");
  });
});

describe("the Europe PMC query of a design filter", () => {
  async function query(input: Parameters<EuropePmcAdapter["search"]>[0]): Promise<string | null> {
    const urls: string[] = [];
    const http: AdapterHttp = {
      json: async <T>(url: string): Promise<T> => {
        urls.push(url);
        return { hitCount: 0, resultList: { result: [] } } as T;
      },
      text: async () => "",
    };
    await new EuropePmcAdapter(http).search(input);
    return new URL(urls[0]!).searchParams.get("query");
  }

  it("takes unknown away from every design type, leaving the records of the longer types that are not designs", async () => {
    const q = (await query({ query: "creatine", studyTypes: ["unknown"] }))!;
    expect(q.startsWith("(creatine) AND NOT (")).toBe(true);
    // PUB_TYPE:"Review" finds 123,323 book reviews and 281 scientific integrity reviews, "Clinical Trial" 24,574 protocols (2026-11-27).
    expect(q).toContain('(PUB_TYPE:"Review" AND NOT PUB_TYPE:"Book Review" AND NOT PUB_TYPE:"Scientific Integrity Review")');
    expect(q).toContain('(PUB_TYPE:"Clinical Trial" AND NOT PUB_TYPE:"Clinical Trial Protocol")');
    for (const name of excludedPublicationTypes(["unknown"])) expect(q).toContain(`PUB_TYPE:"${name}"`);
    expect(q).not.toContain("[pt");
  });

  it("writes the whole query for a controlled trial that is not randomized, after the date clause", async () => {
    const dates = "(FIRST_PDATE:[1900-01-01 TO 1985-12-31] OR E_PDATE:[1900-01-01 TO 1985-12-31] OR P_PDATE:[1900-01-01 TO 1985-12-31])";
    expect(await query({ query: "creatine[tiab]", studyTypes: ["non-randomized-trial"], dateRange: { to: "1985" } })).toBe(
      `(TITLE_ABS:creatine) AND (PUB_TYPE:"Controlled Clinical Trial") AND ${dates} AND NOT (PUB_TYPE:"Network Meta-Analysis" OR ` +
        'PUB_TYPE:"Meta-Analysis" OR PUB_TYPE:"Systematic Review" OR PUB_TYPE:"Randomized Controlled Trial" OR PUB_TYPE:"Equivalence Trial" OR ' +
        'PUB_TYPE:"Observational Study" OR PUB_TYPE:"Case Reports" OR PUB_TYPE:"Clinical Trial, Veterinary" OR ' +
        'PUB_TYPE:"Randomized Controlled Trial, Veterinary" OR PUB_TYPE:"Observational Study, Veterinary")',
    );
  });

  it("leaves the query of other filters as it was", async () => {
    expect(await query({ query: "creatine[tiab]", studyTypes: ["case-report"] })).toBe('(TITLE_ABS:creatine) AND (PUB_TYPE:"Case Reports")');
    expect(await query({ query: "creatine" })).toBe("creatine");
  });
});

describe("the warning for a page the design filter cut", () => {
  const rct = record("1", { doi: "10.1234/a", publicationTypes: ["Randomized Controlled Trial"] });
  const trial = record("2", { doi: "10.1234/b", publicationTypes: ["Clinical Trial, Phase II"] });
  const review = record("3", { doi: "10.1234/c", publicationTypes: ["Review"] });

  it("says how many fetched records were kept, and that total and nextPage count them before the filter", async () => {
    const out = await searchLiterature({ query: "x", studyTypes: ["clinical-trial"], maxResults: 3 }, new LRUBackend(), [
      fakeAdapter("pubmed", [rct, trial, review], 51),
    ]);
    expect(out.articles.map((a) => a.id)).toEqual(["2"]);
    expect(out).toMatchObject({ total: 51, nextPage: 2 });
    expect(out.warnings).toEqual([
      "The studyTypes/minDesignTier filter kept 1 of the 3 records this page fetched; the others are classified as another study type or rank " +
        "below minDesignTier. total and nextPage count records before this filter, so this page can be short or empty while later pages hold more.",
    ]);
  });

  it("warns for a page the filter emptied, and for minDesignTier alone", async () => {
    const none = await searchLiterature({ query: "x", studyTypes: ["unknown"], maxResults: 2 }, new LRUBackend(), [fakeAdapter("pubmed", [rct, trial], 1521)]);
    expect(none).toMatchObject({ articles: [], total: 1521, nextPage: 2 });
    expect(none.warnings).toEqual([expect.stringContaining("kept 0 of the 2 records this page fetched")]);

    const tier = await searchLiterature({ query: "x", minDesignTier: 4 }, new LRUBackend(), [fakeAdapter("pubmed", [rct, trial, review])]);
    expect(tier.articles.map((a) => a.id)).toEqual(["1"]);
    expect(tier.warnings).toEqual([
      expect.stringContaining("leaves out every record with an unknown design tier"),
      expect.stringContaining("kept 1 of the 3 records"),
    ]);
  });

  it("counts a paper once however many databases returned it, and says nothing when the filter dropped nothing", async () => {
    const copy = { ...trial, database: "europepmc" };
    const out = await searchLiterature({ query: "x", database: ["pubmed", "europepmc"], studyTypes: ["clinical-trial"] }, new LRUBackend(), [
      fakeAdapter("pubmed", [trial, rct]),
      fakeAdapter("europepmc", [copy]),
    ]);
    expect(out.articles.map((a) => a.id)).toEqual(["2"]);
    expect(out.warnings).toEqual([expect.stringContaining("kept 1 of the 2 records")]);

    const all = await searchLiterature({ query: "x", database: ["pubmed", "europepmc"], studyTypes: ["clinical-trial"] }, new LRUBackend(), [
      fakeAdapter("pubmed", [trial]),
      fakeAdapter("europepmc", [copy]),
    ]);
    expect(all.warnings).toBeUndefined();
    expect((await searchLiterature({ query: "x" }, new LRUBackend(), [fakeAdapter("pubmed", [rct, trial, review])])).warnings).toBeUndefined();
  });

  it("is the one searchPubMed gives, from the records it classified", async () => {
    const client = {
      esearch: async () => ({ count: 40, pmids: ["1", "2", "9"], more: true }),
      // PMID 9 has no summary: it was not fetched, so it is not a record the filter dropped.
      esummary: async () => new Map([["1", { ...rct }], ["2", { ...trial }]]),
      efetch: async () =>
        new Map([
          ["1", { abstract: "a", publicationTypes: rct.publicationTypes, meshHeadings: [], corrections: [] }],
          ["2", { abstract: "b", publicationTypes: trial.publicationTypes, meshHeadings: [], corrections: [] }],
        ]),
    } as unknown as NcbiClient;
    const out = await searchPubMed({ query: "x", studyTypes: ["clinical-trial"] }, new LRUBackend(), client);
    expect(out.articles.map((a) => a.id)).toEqual(["2"]);
    expect(out).toMatchObject({ total: 40, nextPage: 2 });
    expect(out.warnings).toEqual([expect.stringContaining("kept 1 of the 2 records this page fetched")]);
  });

  it("has nothing to say for a page that kept every record", () => {
    expect(filteredPageWarning(3, 3)).toBeUndefined();
    expect(filteredPageWarning(0, 0)).toBeUndefined();
    expect(filteredPageWarning(0, 1)).toContain("kept 0 of the 1 records");
  });
});

describe("de-duplication of records that share a PMID", () => {
  // PMID 4036935 of the issue: DOI-less in both databases, with the names written two ways.
  const fromPubMed = record("4036935", { title: "Ethanol, aspirin, ibuprofen, and the gastroduodenal mucosa", authors: ["Royer GL Jr"], publicationTypes: ["Controlled Clinical Trial"] });
  const fromEuropePmc = { ...fromPubMed, authors: ["Royer GL"], database: "europepmc" };
  const run = (...adapters: DatabaseAdapter[]) => searchLiterature({ query: "x", database: adapters.map((a) => a.id) }, new LRUBackend(), adapters);

  it("returns a record without a DOI that two databases hold once, the first copy, and counts it twice in total", async () => {
    const out = await run(fakeAdapter("pubmed", [fromPubMed], 3), fakeAdapter("europepmc", [fromEuropePmc], 684));
    expect(out.articles).toHaveLength(1);
    expect(out.articles[0]).toMatchObject({ id: "4036935", authors: ["Royer GL Jr"] });
    expect(out.articles[0]!.database).toBeUndefined();
    expect(out.total).toBe(687);
  });

  it("merges a copy with a DOI into one without, keeps the better-classified one, and passes the retraction on", async () => {
    const rct = record("42", { publicationTypes: ["Randomized Controlled Trial"] });
    const retracted = record("42", { doi: "10.1234/42", publicationTypes: ["Review", "Retracted Publication"], database: "europepmc" });
    const out = await run(fakeAdapter("pubmed", [rct]), fakeAdapter("europepmc", [retracted]));
    expect(out.articles).toHaveLength(1);
    expect(out.articles[0]).toMatchObject({ id: "42", studyType: "randomized-controlled-trial", designTier: 0, flags: ["retracted"] });
  });

  it("merges the other way round as well, a DOI first and none after", async () => {
    const withDoi = record("42", { doi: "10.1234/42" });
    const without = record("42", { database: "europepmc" });
    const out = await run(fakeAdapter("pubmed", [withDoi]), fakeAdapter("europepmc", [without]));
    expect(out.articles.map((a) => a.doi)).toEqual(["10.1234/42"]);
  });

  it("keeps first-seen order, a merged record in the place of its first copy", async () => {
    const other = (id: string) => record(id, { doi: `10.1234/${id}` });
    const out = await run(
      fakeAdapter("pubmed", [other("1"), record("2"), other("3")]),
      fakeAdapter("europepmc", [other("4"), { ...record("2"), database: "europepmc" }, { ...other("1"), database: "europepmc" }]),
    );
    expect(out.articles.map((a) => a.id)).toEqual(["1", "2", "3", "4"]);
  });

  it("merges copies that meet only through a third one holding both a DOI and the PMID", async () => {
    const preprintCopy = record("PPR1", { doi: "10.1234/x", database: "europepmc" });
    const medline = record("7", { doi: "10.1234/x", database: "europepmc" });
    const out = await run(fakeAdapter("pubmed", [record("7")]), fakeAdapter("europepmc", [preprintCopy, medline]));
    expect(out.articles.map((a) => a.id)).toEqual(["7"]);
  });

  it("does not merge a preprint with its article: their DOIs and PMIDs differ", async () => {
    const article = record("100", { doi: "10.1234/article" });
    const preprint = record("200", { doi: "10.1234/preprint", publicationTypes: ["Preprint"] });
    const out = await run(fakeAdapter("pubmed", [article, preprint]));
    expect(out.articles.map((a) => a.id).sort()).toEqual(["100", "200"]);
  });

  it("does not merge ids that are not PMIDs across databases, or a PMID with another database's number", async () => {
    // Europe PMC writes a non-MEDLINE record's number as SRC:id: "CBA:521529" is not PubMed's 521529.
    const cba = record("CBA:521529", { database: "europepmc" });
    const pubmed = record("521529");
    expect((await run(fakeAdapter("pubmed", [pubmed]), fakeAdapter("europepmc", [cba]))).articles).toHaveLength(2);

    // The same id in two databases that are not both PubMed's: two records, as before.
    const chinaxiv = record("chinaxiv-1", { database: "chinaxiv" });
    const russiarxiv = record("chinaxiv-1", { database: "russiarxiv" });
    expect((await run(fakeAdapter("chinaxiv", [chinaxiv]), fakeAdapter("russiarxiv", [russiarxiv]))).articles).toHaveLength(2);
  });

  it("still merges a DOI-less record that one database returned twice", async () => {
    const twice = record("ru-1", { database: "russiarxiv" });
    expect((await run(fakeAdapter("russiarxiv", [twice, twice]))).articles).toHaveLength(1);
  });
});
