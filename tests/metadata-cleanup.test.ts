import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { parseEuropePmc, splitPubTypes } from "../src/core/adapters/europepmc";
import { ChinaRXivAdapter, parsePapers, readableJournal } from "../src/core/adapters/chinarxiv";
import { SovietRxivAdapter } from "../src/core/adapters/russiarxiv";
import type { AdapterHttp } from "../src/core/adapters/http";
import { splitAuthors } from "../src/core/adapters/util";
import { LRUBackend } from "../src/core/cache";
import { fetchFulltext as fetchFulltextWith, type FulltextDeps } from "../src/core/fulltext";
import { classifyArticle, classifyDesign } from "../src/core/grader";
import { searchLiterature } from "../src/core/literature";
import type { NcbiClient } from "../src/core/pubmed";
import type { DatabaseAdapter } from "../src/core/adapters/types";
import type { Article } from "../src/core/types";

/** A Europe PMC `core` record with the fields these tests vary; everything else a record needs is fixed. */
const epmcRecord = (extra: Record<string, unknown> = {}) => ({
  id: "9500320",
  source: "MED",
  pmid: "9500320",
  title: "Ileal-lymphoid-nodular hyperplasia, non-specific colitis, and pervasive developmental disorder in children.",
  authorString: "Wakefield AJ, Walker-Smith JA.",
  journalInfo: { journal: { title: "Lancet" }, dateOfPublication: "1998 Feb 28" },
  pubTypeList: { pubType: ["Journal Article"] },
  ...extra,
});
const parse = (extra: Record<string, unknown> = {}) => parseEuropePmc({ hitCount: 1, resultList: { result: [epmcRecord(extra)] } }).articles[0]!;

describe("the last author of a Europe PMC record", () => {
  // Europe PMC's authorString ends with the list's own period, which PubMed's names don't have.
  it("loses the period that ends the list, and only that one", () => {
    expect(splitAuthors("Seckman CC, Lanza FL.")).toEqual(["Seckman CC", "Lanza FL"]);
    expect(splitAuthors("Hosoda K.")).toEqual(["Hosoda K"]);
    // A string without it is left as it is, and so is a name's own period (CBA:562006 ends in two).
    expect(splitAuthors("Smith J, Doe A")).toEqual(["Smith J", "Doe A"]);
    expect(splitAuthors("Zhi-cheng, Sun Feng min, Yuan Jin-hong..")).toEqual(["Zhi-cheng", "Sun Feng min", "Yuan Jin-hong."]);
    expect(splitAuthors("Smith J; Doe A.")).toEqual(["Smith J", "Doe A"]);
    expect(splitAuthors("Collaborators of East Shizuoka Tirzepatide study.")).toEqual(["Collaborators of East Shizuoka Tirzepatide study"]);
    expect(splitAuthors(".")).toEqual([]);
    expect(splitAuthors(undefined)).toEqual([]);
  });

  it("reads like the same record's PubMed copy, in a parsed record", () => {
    const pubmedAuthors = ["Wakefield AJ", "Walker-Smith JA"];
    expect(parse().authors).toEqual(pubmedAuthors);
  });
});

describe("publicationTypes and articleTypes of a Europe PMC record", () => {
  it("keeps NLM's names in publicationTypes and moves the publisher's article types to articleTypes", () => {
    const sr = parse({ pubTypeList: { pubType: ["Systematic Review", "systematic-review", "Journal Article"] } });
    expect(sr.publicationTypes).toEqual(["Systematic Review", "Journal Article"]);
    expect(sr.articleTypes).toEqual(["systematic-review"]);

    const caseReport = parse({ pubTypeList: { pubType: ["Journal Article", "Case Reports", "case-report"] } });
    expect(caseReport.publicationTypes).toEqual(["Journal Article", "Case Reports"]);
    expect(caseReport.articleTypes).toEqual(["case-report"]);

    // A record with only the publisher's type (a MEDLINE record not yet indexed, a PMC article) has an empty NLM list.
    const unindexed = parse({ pubTypeList: { pubType: ["research-article"] } });
    expect(unindexed.publicationTypes).toEqual([]);
    expect(unindexed.articleTypes).toEqual(["research-article"]);
    expect(parse({ pubTypeList: { pubType: ["review-article", "article-commentary"] } }).articleTypes).toEqual(["review-article", "article-commentary"]);
  });

  it("sets no articleTypes on a record that has none, and leaves a single type given as a string alone", () => {
    const plain = parse({ pubTypeList: { pubType: ["Randomized Controlled Trial", "Journal Article"] } });
    expect(plain.publicationTypes).toEqual(["Randomized Controlled Trial", "Journal Article"]);
    expect("articleTypes" in plain).toBe(false);
    expect(parse({ pubTypeList: { pubType: "Preprint" } }).publicationTypes).toEqual(["Preprint"]);
    expect(parse({ pubTypeList: undefined }).publicationTypes).toEqual([]);
  });

  it("never moves an NLM name: punctuation, digits and lower-case words inside a name keep it a name", () => {
    const names = [
      "Research Support, N.I.H., Extramural",
      "Research Support, Non-U.S. Gov't",
      "Clinical Trial, Phase III",
      "Randomized Controlled Trial, Veterinary",
      "Consensus Development Conference, NIH",
      "Aphorisms and Proverbs",
      "Meta-Analysis",
      "Video-Audio Media",
      "Retraction of Publication",
    ];
    expect(splitPubTypes(names)).toEqual({ publicationTypes: names, articleTypes: [] });
  });

  it("leaves a capitalised publisher string in publicationTypes: only a string with no capital letter is an article type", () => {
    // Seen on 2026-11-28: "Research article" and "Short communication" (CBA), "Abstract", "Brief Report" and "Meeting Report" (PMC).
    expect(splitPubTypes(["Research article", "Brief Report", "brief-report"])).toEqual({
      publicationTypes: ["Research article", "Brief Report"],
      articleTypes: ["brief-report"],
    });
  });

  it("is graded as before the split: the classifier reads both lists", () => {
    // What Europe PMC returned for records of every kind, as one list (2026-11-28), and the classifier's grade for each list.
    const lists: string[][] = [
      ["Systematic Review", "systematic-review", "Journal Article"],
      ["Meta-Analysis", "Systematic Review", "Journal Article"],
      ["Network Meta-Analysis", "Meta-Analysis", "Journal Article"],
      ["Randomized Controlled Trial", "Journal Article"],
      ["Journal Article", "Case Reports", "case-report"],
      ["Journal Article", "Case Reports", "case-study"],
      ["research-article", "Journal Article", "Case Reports"],
      ["Review", "review-article", "Journal Article"],
      ["Journal Article", "Review", "Retracted Publication"],
      ["Retracted Publication", "research-article", "Journal Article"],
      ["Retraction Notice", "retraction"],
      ["Published Erratum", "correction"],
      ["Expression of Concern", "expression-of-concern"],
      ["Clinical Trial Protocol", "Journal Article"],
      ["Clinical Trial, Phase III", "Randomized Controlled Trial", "Multicenter Study", "Journal Article"],
      ["Observational Study", "research-article"],
      ["Editorial", "Comment", "article-commentary"],
      ["Comment", "article-commentary"],
      ["Letter"],
      ["Preprint"],
      ["Abstract"],
      ["brief-report", "Brief Report"],
      ["methods-article"],
      ["other", "Journal Article", "Case Reports"],
      ["news", "News"],
      // JATS values that are also the names of NLM's design tags once case is ignored: the classifier has always matched them.
      ["editorial"],
      ["letter"],
      ["editorial", "research-article"],
      [],
    ];
    for (const list of lists) {
      const before = classifyDesign({ title: "T", publicationTypes: list });
      const record = parse({ pubTypeList: { pubType: list } });
      const after = classifyArticle(record);
      expect({ list, studyType: after.studyType, designTier: after.designTier, flags: after.flags ?? [] }).toEqual({
        list,
        studyType: before.studyType,
        designTier: before.designTier,
        flags: before.flags,
      });
    }
  });

  it("grades by articleTypes as it graded the same strings in publicationTypes", () => {
    // Fails if the classifier reads publicationTypes alone: JATS "editorial" and "letter" are the names of two flags.
    expect(classifyDesign({ title: "", publicationTypes: [], articleTypes: ["editorial"] })).toMatchObject({ designTier: 0, flags: ["editorial"] });
    expect(classifyDesign({ title: "", publicationTypes: [], articleTypes: ["letter"] }).flags).toEqual(["letter"]);
    // Both lists count, and an empty or absent one adds nothing.
    expect(classifyDesign({ title: "", publicationTypes: ["Randomized Controlled Trial"], articleTypes: ["research-article"] }).studyType).toBe("randomized-controlled-trial");
    expect(classifyDesign({ title: "", publicationTypes: ["Review"], articleTypes: [] })).toMatchObject({ studyType: "review", designTier: 1 });
    // A record cached before articleTypes existed still holds the mixed list in publicationTypes, and grades alike.
    const cached = classifyDesign({ title: "", publicationTypes: ["Systematic Review", "systematic-review", "editorial"] });
    const split = classifyDesign({ title: "", publicationTypes: ["Systematic Review"], articleTypes: ["systematic-review", "editorial"] });
    expect(split).toEqual(cached);
  });
});

describe("linked notices of a retracted article", () => {
  // PMID 9500320 as both databases return it (2026-11-28): the same links, in the same order, from PubMed and from Europe PMC,
  // whose MEDLINE record has the PMID as its id. Two retraction notices and one expression of concern.
  const RETRACTIONS = ["15016483", "20137807"];
  const CONCERNS = ["21971344"];
  const ARTICLE: Article = {
    id: "9500320",
    title: "Ileal-lymphoid-nodular hyperplasia, non-specific colitis, and pervasive developmental disorder in children",
    authors: ["Wakefield AJ"],
    journal: "Lancet",
    pubDate: "1998 Feb 28",
    doi: "10.1016/s0140-6736(97)11096-0",
    publicationTypes: ["Journal Article", "Retracted Publication"],
    abstract: "A cached abstract.",
  };
  const link = (type: "RetractionIn" | "ExpressionOfConcernIn", ids: string[]) => ids.map((id) => ({ type, id }));
  const pubmedCopy: Article = { ...ARTICLE, corrections: [...link("RetractionIn", RETRACTIONS), ...link("ExpressionOfConcernIn", CONCERNS)] };
  const europePmcCopy: Article = { ...pubmedCopy, database: "europepmc" };
  const RETRACTED = 'RETRACTED: this record is flagged "retracted" (as in literature_search): do not use its findings as evidence.';
  const CONCERN = 'EXPRESSION OF CONCERN: one is linked to this record (flag "expression-of-concern"): read the notice before relying on its findings.';
  const WANTED = `${RETRACTED} Linked notices: pubmed 15016483, pubmed 20137807 (literature_fetch). ${CONCERN} Linked notice: pubmed 21971344 (literature_fetch).`;

  const noRequests = vi.fn(async () => {
    throw new Error("no network in tests");
  });
  beforeEach(() => {
    vi.stubGlobal("fetch", noRequests);
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    noRequests.mockClear();
  });

  const client = { tool: "med-research-mcp", esummary: async () => new Map(), efetch: async () => new Map() } as unknown as NcbiClient;
  const deps: FulltextDeps = {
    // The record is cached, so the lookups of other databases are not made; no text is found, so the warning is the fallback's.
    adapter: () => undefined,
    unpaywall: { lookup: async () => ({ status: "none" }), sharedContact: false } as unknown as FulltextDeps["unpaywall"],
    fetchUrl: async () => ({ ok: false, status: 403, contentType: "text/html", finalUrl: "x" }),
  };
  /** The standing the warning opens with: what comes before the fallback's account of the routes tried. */
  const warningWith = async (...copies: [key: string, record: Article][]): Promise<string> => {
    const cache = new LRUBackend();
    for (const [key, record] of copies) cache.setSummary(key, record);
    const { warning } = await fetchFulltextWith({ id: "9500320" }, cache, client, deps);
    return warning!.split(" No full text found;")[0]!;
  };

  it("names each notice once when the PubMed and Europe PMC copies both link it", async () => {
    expect(await warningWith(["9500320", pubmedCopy], ["europepmc:9500320", europePmcCopy])).toBe(WANTED);
  });

  it("says the same whichever copy is cached, so the list doesn't depend on the cache", async () => {
    expect(await warningWith(["9500320", pubmedCopy])).toBe(WANTED);
    // The Europe PMC copy alone names its notices by their PMIDs, as PubMed's does: not as "europepmc 15016483".
    expect(await warningWith(["europepmc:9500320", europePmcCopy])).toBe(WANTED);
  });

  it("names a notice once, in the order the copies first name it, when the copies list them in another order", async () => {
    const reversed: Article = { ...europePmcCopy, corrections: [...link("ExpressionOfConcernIn", CONCERNS), ...link("RetractionIn", [...RETRACTIONS].reverse())] };
    expect(await warningWith(["9500320", pubmedCopy], ["europepmc:9500320", reversed])).toBe(WANTED);
    expect(await warningWith(["europepmc:9500320", reversed])).toContain("Linked notices: pubmed 20137807, pubmed 15016483 (literature_fetch).");
  });

  it("keeps an id that is no PMID with its database, beside a PMID that both copies name", async () => {
    const withPreprint: Article = { ...europePmcCopy, corrections: [...link("RetractionIn", ["15016483"]), { type: "RetractionIn", id: "PPR654321" }] };
    const warning = await warningWith(["9500320", { ...pubmedCopy, corrections: link("RetractionIn", ["15016483"]) }], ["europepmc:9500320", withPreprint]);
    expect(warning).toBe(`${RETRACTED} Linked notices: pubmed 15016483, europepmc PPR654321 (literature_fetch).`);
  });

  it("says 'notice' for one notice, however many copies link it", async () => {
    const one = (r: Article): Article => ({ ...r, corrections: link("RetractionIn", ["20137807"]) });
    expect(await warningWith(["9500320", one(pubmedCopy)], ["europepmc:9500320", one(europePmcCopy)])).toBe(`${RETRACTED} Linked notice: pubmed 20137807 (literature_fetch).`);
  });
});

describe("links of a record that two databases hold", () => {
  const fakeAdapter = (id: string, articles: Article[]): DatabaseAdapter => ({
    id,
    name: id,
    search: async () => ({ count: articles.length, ids: articles.map((a) => a.id) }),
    fetch: async (ids) => articles.filter((a) => ids.includes(a.id)),
  });

  it("lists each notice once in corrections and each flag once in the merged record", async () => {
    const base: Article = { id: "9500320", doi: "10.1016/s0140-6736(97)11096-0", title: "T", authors: ["Wakefield AJ"], journal: "Lancet", pubDate: "1998", publicationTypes: ["Journal Article", "Retracted Publication"] };
    const retraction = [{ type: "RetractionIn" as const, id: "15016483" }, { type: "RetractionIn" as const, id: "20137807" }];
    const concern = [{ type: "ExpressionOfConcernIn" as const, id: "21971344" }];
    const pubmed: Article = { ...base, corrections: [...retraction, ...concern] };
    const europepmc: Article = { ...base, database: "europepmc", corrections: [...concern, ...[...retraction].reverse()] };
    const out = await searchLiterature(
      { query: "x", database: ["pubmed", "europepmc"] },
      new LRUBackend(),
      [fakeAdapter("pubmed", [pubmed]), fakeAdapter("europepmc", [europepmc])],
    );
    expect(out.articles).toHaveLength(1);
    expect(out.articles[0]!.corrections).toEqual([...retraction, ...concern]);
    expect(out.articles[0]!.flags).toEqual(["retracted", "expression-of-concern"]);
  });
});

describe("the journal of a RussiaRxiv record", () => {
  /** What `/api/v1/publications` listed on 2026-11-28: five journals, which hold all 25,456 RussiaRxiv records. */
  const PUBLICATIONS = {
    publications: [
      { key: "doklady_akademii_nauk_sssr", title: "Doklady Akademii Nauk SSSR", original_title: "Доклады Академии наук СССР", paper_count: 14915, publisher: "Academy of Sciences of the USSR", country: "USSR" },
      { key: "izvestiya_tomskogo_politekhnicheskogo", title: "Izvestiya Tomskogo Politekhnicheskogo Instituta", original_title: "Известия Томского политехнического института", paper_count: 7228, publisher: "Tomsk Polytechnic University", country: "Russia" },
      { key: "uspekhi_fizicheskikh_nauk", title: "Uspekhi Fizicheskikh Nauk", original_title: "Успехи физических наук", paper_count: 2733, publisher: "Russian Academy of Sciences", country: "Russia" },
      { key: "differentsialnye_uravneniya", title: "Differentsial'nye Uravneniya", original_title: "Дифференциальные уравнения", paper_count: 481, publisher: "Russian Academy of Sciences", country: "Russia" },
      { key: "gigiena_i_sanitariya", title: "Gigiena i Sanitariya", original_title: "Гигиена и санитария", paper_count: 99, publisher: "Russian Academy of Sciences", country: "Russia" },
    ],
  };
  /** A search result: the journal is its key alone (`publication`), as the search endpoint returns it. */
  const summary = (id: string, publication: string | null, extra: Record<string, unknown> = {}) => ({
    id,
    title: `Paper ${id}`,
    authors: [],
    abstract: "An abstract.",
    abstract_source: "machine_generated",
    date: "1969-01-01",
    source: "russiarxiv",
    source_language: "ru",
    source_url: "https://www.mathnet.ru/eng/dan34780",
    publication,
    ...extra,
  });

  /** Answers `/publications` with `listing` (or fails with it, when it is an Error) and anything else with `papers`. */
  function routedHttp(papers: unknown, listing: unknown = PUBLICATIONS): { http: AdapterHttp; urls: string[] } {
    const urls: string[] = [];
    const http: AdapterHttp = {
      json: async <T>(url: string): Promise<T> => {
        urls.push(url);
        const answer = url.endsWith("/api/v1/publications") ? listing : papers;
        if (answer instanceof Error) throw answer;
        return answer as T;
      },
      text: async () => "",
    };
    return { http, urls };
  }
  const listings = (urls: string[]) => urls.filter((u) => u.endsWith("/api/v1/publications"));

  it("is the journal's title, as literature_fetch gives it, where search returns only the key", async () => {
    const { http, urls } = routedHttp({ total: 2, data: [summary("ru-196901.47859", "doklady_akademii_nauk_sssr"), summary("ru-197501.13997", "izvestiya_tomskogo_politekhnicheskogo")] });
    const adapter = new SovietRxivAdapter(http);
    const cache = new LRUBackend();
    const { ids } = await adapter.search({ query: "disease" });
    const found = await adapter.fetch(ids, cache);
    expect(found.map((a) => a.journal)).toEqual(["Doklady Akademii Nauk SSSR", "Izvestiya Tomskogo Politekhnicheskogo Instituta"]);
    // One search and the one request for the titles; the fetch after it is served from the memo.
    expect(urls).toHaveLength(2);
    expect(listings(urls)).toEqual(["https://chinarxiv.org/api/v1/publications"]);
  });

  it("keeps a title that no key spells: the apostrophe of Differentsial'nye Uravneniya", async () => {
    const { http } = routedHttp({ total: 1, data: [summary("ru-1", "differentsialnye_uravneniya")] });
    const adapter = new SovietRxivAdapter(http);
    await adapter.search({ query: "equation" });
    expect((await adapter.fetch(["ru-1"], new LRUBackend()))[0]!.journal).toBe("Differentsial'nye Uravneniya");
  });

  it("asks for the titles once, also for searches that run together, and again after an hour", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      const { http, urls } = routedHttp({ total: 1, data: [summary("ru-1", "uspekhi_fizicheskikh_nauk")] });
      const adapter = new SovietRxivAdapter(http);
      await Promise.all([adapter.search({ query: "a" }), adapter.search({ query: "b" }), adapter.search({ query: "c" })]);
      expect(listings(urls)).toHaveLength(1);
      await adapter.search({ query: "d" });
      expect(listings(urls)).toHaveLength(1);
      vi.setSystemTime(Date.now() + 61 * 60 * 1000);
      await adapter.search({ query: "e" });
      expect(listings(urls)).toHaveLength(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it("reads the title of a record from /papers/{id}, without asking for the list", async () => {
    const detail = summary("ru-196901.47859", "doklady_akademii_nauk_sssr", { publication_title: "Doklady Akademii Nauk SSSR" });
    const { http, urls } = routedHttp(detail);
    const found = await new SovietRxivAdapter(http).fetchFull(["ru-196901.47859"], new LRUBackend());
    expect(found[0]!.journal).toBe("Doklady Akademii Nauk SSSR");
    expect(listings(urls)).toEqual([]);

    // A detail record that names the key alone is looked up like a search result.
    const bare = routedHttp(summary("ru-196901.47859", "doklady_akademii_nauk_sssr"));
    expect((await new SovietRxivAdapter(bare.http).fetchFull(["ru-196901.47859"], new LRUBackend()))[0]!.journal).toBe("Doklady Akademii Nauk SSSR");
    expect(listings(bare.urls)).toHaveLength(1);
  });

  it("makes no request for the titles when no record needs one: ChinaXiv records have no publication", async () => {
    const chinaxiv = { ...summary("chinaxiv-202401.00027", null), source: "chinaxiv", source_language: "zh" };
    const { http, urls } = routedHttp({ total: 1, data: [chinaxiv] });
    const [article] = (await (async () => {
      const adapter = new ChinaRXivAdapter(http);
      const { ids } = await adapter.search({ query: "exercise" });
      return adapter.fetch(ids, new LRUBackend());
    })());
    expect(article!.journal).toBe("ChinaXiv");
    expect(listings(urls)).toEqual([]);
  });

  it("writes the key as words when the list can't be read, and tries again a minute later", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      const papers = { total: 1, data: [summary("ru-196901.47859", "doklady_akademii_nauk_sssr")] };
      const down = routedHttp(papers, new Error("HTTP 503"));
      const adapter = new SovietRxivAdapter(down.http);
      const { ids } = await adapter.search({ query: "disease" });
      expect(ids).toEqual(["ru-196901.47859"]);
      expect((await adapter.fetch(ids, new LRUBackend()))[0]!.journal).toBe("Doklady Akademii Nauk Sssr");
      // Not asked again at once, or each search of a rate-limited client would wait for it.
      await adapter.search({ query: "other" });
      expect(listings(down.urls)).toHaveLength(1);
      vi.setSystemTime(Date.now() + 61 * 1000);
      await adapter.search({ query: "again" });
      expect(listings(down.urls)).toHaveLength(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it("writes the key as words for a journal the list doesn't have, and for a list of another shape", async () => {
    for (const listing of [PUBLICATIONS, { publications: [] }, {}, { publications: [{ key: 7 }, null] }]) {
      const { http } = routedHttp({ total: 1, data: [summary("ru-9", "zhurnal_novyi")] }, listing);
      const adapter = new SovietRxivAdapter(http);
      await adapter.search({ query: "x" });
      expect((await adapter.fetch(["ru-9"], new LRUBackend()))[0]!.journal).toBe("Zhurnal Novyi");
    }
  });

  it("parses with a given list of titles, and without one writes the key as words", () => {
    const data = { data: [summary("ru-1", "gigiena_i_sanitariya")] };
    expect(parsePapers(data).articles[0]!.journal).toBe("Gigiena I Sanitariya");
    expect(parsePapers(data, { publicationTitles: new Map([["gigiena_i_sanitariya", "Gigiena i Sanitariya"]]) }).articles[0]!.journal).toBe("Gigiena i Sanitariya");
    // The record's own title wins over the list's.
    const titled = { data: [summary("ru-1", "gigiena_i_sanitariya", { publication_title: "Own Title" })] };
    expect(parsePapers(titled, { publicationTitles: new Map([["gigiena_i_sanitariya", "List Title"]]) }).articles[0]!.journal).toBe("Own Title");
  });

  it("readableJournal: underscores become spaces and each word is capitalised; a value that is no key stays", () => {
    expect(readableJournal("doklady_akademii_nauk_sssr")).toBe("Doklady Akademii Nauk Sssr");
    expect(readableJournal("uspekhi_fizicheskikh_nauk")).toBe("Uspekhi Fizicheskikh Nauk");
    expect(readableJournal("matematicheskii_sbornik")).toBe("Matematicheskii Sbornik");
    expect(readableJournal("nature")).toBe("Nature");
    expect(readableJournal("izvestiya_ran_2")).toBe("Izvestiya Ran 2");
    // Already a name: capitals, spaces or other characters.
    expect(readableJournal("Doklady Akademii Nauk SSSR")).toBe("Doklady Akademii Nauk SSSR");
    expect(readableJournal("Differentsial'nye Uravneniya")).toBe("Differentsial'nye Uravneniya");
    expect(readableJournal("Nature")).toBe("Nature");
    expect(readableJournal("a__b")).toBe("a__b");
    expect(readableJournal("")).toBe("");
  });
});
