import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fetchFulltext, fulltextCacheKey, STANDING_WAIT_MS, type FetchedResource, type FulltextDeps } from "../src/core/fulltext";
import { EuropePmcAdapter } from "../src/core/adapters/europepmc";
import type { AdapterHttp } from "../src/core/adapters/http";
import { LRUBackend, SQLiteBackend, type Cache } from "../src/core/cache";
import type { NcbiClient } from "../src/core/pubmed";
import type { UnpaywallClient, UnpaywallLookup } from "../src/core/unpaywall";
import type { ResearchApiException } from "../src/core/errors";
import type { Article } from "../src/core/types";

/**
 * A text is cached under the source it was fetched from and labelled with the DOI it belongs to, whatever id and
 * DOI a call names; a DOI given with a PMID is checked against the PMID's record; a DOI alone is looked up for
 * its standing. The fakes below serve a text per URL, so that a text returned for the wrong source shows.
 */

const A = "38453139";
const A_DOI = "10.1111/iwj.14690";
const A_NOTICE = "39637866";
const B_DOI = "10.1371/journal.pmed.0020124";
const PMID_B = "16060722";
const VOJTA_DOI = "10.3389/fneur.2024.1391448";
const VOJTA_NOTICE = "42707607";
const RETRACTED_START = 'RETRACTED: this record is flagged "retracted" (as in literature_search): do not use its findings as evidence.';

const retractedA: Article = {
  id: A,
  title: "A retracted trial",
  authors: ["Doe J"],
  journal: "Int Wound J",
  pubDate: "2024",
  doi: A_DOI,
  publicationTypes: ["Journal Article", "Retracted Publication"],
  corrections: [{ type: "RetractionIn", id: A_NOTICE }],
};
const recordB: Article = {
  id: PMID_B,
  title: "Why most published research findings are false",
  authors: ["Ioannidis J"],
  journal: "PLoS Med",
  pubDate: "2005",
  doi: B_DOI,
  pmcid: "PMC1182327",
  publicationTypes: ["Journal Article"],
};
/** As Europe PMC's `core` search returns the record of a DOI: the retraction in its types and links. */
const vojtaRecord: Article = {
  id: "38711552",
  title: "RETRACTED: Critical review of the evidence for Vojta Therapy",
  authors: ["Doe J"],
  journal: "Front Neurol",
  pubDate: "2024",
  doi: VOJTA_DOI,
  database: "europepmc",
  publicationTypes: ["Retracted Publication", "Systematic Review", "Journal Article"],
  corrections: [{ type: "RetractionIn", id: VOJTA_NOTICE }],
};

// The tests inject every network seam. A request that reaches the real ones is a failure, not a swallowed lookup.
const strayRequests: string[] = [];
beforeEach(() => {
  strayRequests.length = 0;
  vi.stubGlobal("fetch", async (url: unknown) => {
    strayRequests.push(String(url));
    throw new Error("no network in tests");
  });
});
afterEach(() => {
  vi.useRealTimers();
  expect(strayRequests).toEqual([]);
});

/** A text that differs in every word from the text of any other URL, and long enough to read in parts. */
function bodyOf(url: string): string {
  const tag = url.replace(/\W+/g, "_");
  return `# Text from ${url}\n\n${Array.from({ length: 600 }, (_, i) => `${tag}_${i}`).join(" ")}`;
}

/** The NCBI client: esummary answers from `records`, or fails when `down`. */
function pubmed(records: Article[], options: { down?: boolean } = {}) {
  const esummary = vi.fn(async (pmids: string[]) => {
    if (options.down) throw new Error("NCBI is down");
    return new Map(records.filter((r) => pmids.includes(r.id)).map((r) => [r.id, r] as const));
  });
  const efetch = vi.fn(async (pmids: string[]) => new Map([[pmids[0]!, { abstract: "An abstract.", publicationTypes: [], meshHeadings: [], corrections: [] }]]));
  return { client: { tool: "med-research-mcp", esummary, efetch } as unknown as NcbiClient, esummary };
}

/** Unpaywall knows an open-access copy at `https://oa.example/<doi>` of each DOI in `known`. */
function unpaywallOf(known: string[]): UnpaywallClient {
  const lookup = async (doi: string): Promise<UnpaywallLookup> =>
    known.some((k) => k.toLowerCase() === doi.toLowerCase())
      ? { status: "found", result: { doi, isOa: true, urls: [`https://oa.example/${doi}`] } }
      : { status: "none" };
  return { lookup: vi.fn(lookup), sharedContact: false } as unknown as UnpaywallClient;
}

/** An adapter for Europe PMC that finds the records of `byDoi` by DOI, those of `byId` by id or PMCID (as its search does), and nothing else. */
function europePmc(byDoi: Article[] = [], byId: Article[] = []) {
  const fetchByDoi = vi.fn(async (doi: string) => byDoi.find((r) => r.doi?.toLowerCase() === doi.toLowerCase()) ?? null);
  const adapter: FulltextDeps["adapter"] = () => ({
    fetch: async (ids: string[]) => byId.filter((r) => ids.includes(r.id) || (r.pmcid !== undefined && ids.includes(r.pmcid))),
    fetchByDoi,
  });
  return { fetchByDoi, adapter };
}

/** Every URL answers with a page whose text is `bodyOf(url)`; a URL in `refused` answers 403. */
function web(options: { refused?: (url: string) => boolean } = {}) {
  const fetchUrl = vi.fn(async (url: string): Promise<FetchedResource> => {
    if (options.refused?.(url)) return { ok: false, status: 403, contentType: "text/html", finalUrl: url };
    return { ok: true, status: 200, contentType: url.includes("/fullTextXML") ? "application/xml" : "text/html", finalUrl: url, text: url };
  });
  return {
    fetchUrl,
    htmlToMarkdown: async (_html: string, url: string) => bodyOf(url),
    jatsToMarkdown: async (xml: string) => bodyOf(xml),
  };
}

const fetched = (fetchUrl: { mock: { calls: unknown[][] } }): string[] => fetchUrl.mock.calls.map(([url]) => String(url));
const epmcUrl = (pmcid: string): string => `https://www.ebi.ac.uk/europepmc/webservices/rest/${pmcid}/fullTextXML`;

describe("a text is cached under the source it was fetched from", () => {
  it("refuses a DOI that is not the PMID's, and then serves the PMID its own text, labelled with its own DOI and warning", async () => {
    const cache = new LRUBackend();
    const { client } = pubmed([retractedA]);
    const { fetchUrl, ...pages } = web();
    const deps: FulltextDeps = { unpaywall: unpaywallOf([A_DOI, B_DOI]), fetchUrl, adapter: europePmc().adapter, ...pages };

    const refused = await fetchFulltext({ id: A, doi: B_DOI }, cache, client, deps).catch((e: unknown) => e as ResearchApiException);
    expect(refused).toMatchObject({ code: "INVALID_INPUT", recoverable: true });
    expect(refused.userMessage).toContain(B_DOI);
    expect(refused.userMessage).toContain(A_DOI);
    expect(refused.userMessage).toContain(`PMID ${A}`);
    expect(refused.userMessage).toMatch(/Leave out doi/);
    expect(fetchUrl).not.toHaveBeenCalled();
    expect(cache.getFulltext(fulltextCacheKey("unpaywall", B_DOI))).toBeNull();

    const own = await fetchFulltext({ id: A }, cache, client, deps);
    expect(own).toMatchObject({ id: A, source: "unpaywall", doi: A_DOI });
    expect(own.fulltext).toContain(`https://oa.example/${A_DOI}`);
    expect(own.fulltext).not.toContain(B_DOI);
    expect(own.warning!.startsWith(`${RETRACTED_START} Linked notice: pubmed ${A_NOTICE}`)).toBe(true);
    expect(fetched(fetchUrl)).toEqual([`https://oa.example/${A_DOI}`]);
  });

  it("keeps a text fetched for a DOI that couldn't be checked away from the PMID, which later gets its own", async () => {
    const cache = new LRUBackend();
    const { fetchUrl, ...pages } = web();
    const deps: FulltextDeps = { unpaywall: unpaywallOf([A_DOI, B_DOI]), fetchUrl, adapter: europePmc().adapter, ...pages };

    // PubMed can't be reached, so the DOI given is all there is: its text comes back, labelled with it.
    const unchecked = await fetchFulltext({ id: A, doi: B_DOI }, cache, pubmed([retractedA], { down: true }).client, deps);
    expect(unchecked).toMatchObject({ source: "unpaywall", doi: B_DOI });
    expect(unchecked.fulltext).toContain(`https://oa.example/${B_DOI}`);
    expect(cache.getFulltext(fulltextCacheKey("unpaywall", B_DOI))).toMatchObject({ doi: B_DOI });

    // A call for the PMID alone, with PubMed up, gets its own text, not that one.
    const own = await fetchFulltext({ id: A }, cache, pubmed([retractedA]).client, deps);
    expect(own).toMatchObject({ source: "unpaywall", doi: A_DOI });
    expect(own.fulltext).toContain(`https://oa.example/${A_DOI}`);
    expect(own.warning).toContain(RETRACTED_START);
    // And the PMID with the DOI that is its own reads the cached text of that DOI.
    const again = await fetchFulltext({ id: A, doi: A_DOI }, cache, pubmed([retractedA]).client, deps);
    expect(again.fulltext).toBe(own.fulltext);
    expect(fetched(fetchUrl)).toEqual([`https://oa.example/${B_DOI}`, `https://oa.example/${A_DOI}`]);
  });

  it("returns the text of the DOI named, under that DOI, for an id that is the same two calls running", async () => {
    const cache = new LRUBackend();
    const { client } = pubmed([]);
    const { fetchUrl, ...pages } = web();
    const deps: FulltextDeps = { unpaywall: unpaywallOf([A_DOI, B_DOI]), fetchUrl, adapter: europePmc().adapter, ...pages };

    const first = await fetchFulltext({ id: "x", doi: A_DOI }, cache, client, deps);
    expect(first).toMatchObject({ id: "x", source: "unpaywall", doi: A_DOI });
    expect(first.fulltext).toContain(`https://oa.example/${A_DOI}`);

    const second = await fetchFulltext({ id: "x", doi: B_DOI }, cache, client, deps);
    expect(second).toMatchObject({ id: "x", source: "unpaywall", doi: B_DOI });
    expect(second.fulltext).toContain(`https://oa.example/${B_DOI}`);
    expect(second.fulltext).not.toContain(A_DOI);

    // Each DOI's text comes from the cache, whatever the id: no request, and no other DOI's text.
    const again = await fetchFulltext({ id: "another", doi: A_DOI.toUpperCase() }, cache, client, deps);
    expect(again).toMatchObject({ id: "another", doi: A_DOI });
    expect(again.fulltext).toBe(first.fulltext);
    expect(fetchUrl).toHaveBeenCalledTimes(2);
    // An id given alone is not read from under that id.
    await expect(fetchFulltext({ id: "x" }, cache, client, deps)).rejects.toMatchObject({ code: "NOT_FOUND" });
  });

  it("labels a Europe PMC text with the DOI of the PMCID's record, never one the caller gave, and keeps it under the PMCID", async () => {
    const cache = new LRUBackend();
    const { client } = pubmed([recordB]);
    const { fetchUrl, ...pages } = web();
    const deps: FulltextDeps = { unpaywall: unpaywallOf([A_DOI]), fetchUrl, adapter: europePmc().adapter, ...pages };

    // The PMID's record has a PMCID: Europe PMC's text of it, whether or not a DOI is given.
    const withDoi = await fetchFulltext({ id: PMID_B, doi: B_DOI }, cache, client, deps);
    expect(withDoi).toMatchObject({ source: "europepmc", doi: B_DOI });
    expect(withDoi.fulltext).toContain(epmcUrl("PMC1182327"));
    expect(cache.getFulltext(fulltextCacheKey("europepmc", "PMC1182327"))).toMatchObject({ source: "europepmc", doi: B_DOI });
    const alone = await fetchFulltext({ id: PMID_B }, cache, client, deps);
    expect(alone).toEqual({ ...withDoi, id: PMID_B });
    const byPmcid = await fetchFulltext({ id: "pmc1182327" }, cache, client, deps);
    expect(byPmcid).toMatchObject({ source: "europepmc", doi: B_DOI, fulltext: withDoi.fulltext });
    expect(fetchUrl).toHaveBeenCalledTimes(1);

    // A DOI given with a PMCID doesn't relabel its text: it is the text of the PMCID.
    const other = new LRUBackend();
    const given = await fetchFulltext({ id: "PMC1182327", doi: A_DOI }, other, client, { ...deps, adapter: () => ({ fetch: async () => [recordB] }) });
    expect(given).toMatchObject({ source: "europepmc", doi: B_DOI });
    // With no record to say, it says nothing, and stores nothing: a later call is not told a DOI the text may not have.
    const unrecorded = new LRUBackend();
    const unlabeled = await fetchFulltext({ id: "PMC1182327", doi: A_DOI }, unrecorded, client, { ...deps, adapter: () => undefined });
    expect(unlabeled.source).toBe("europepmc");
    expect(unlabeled.doi).toBeUndefined();
    expect(unrecorded.getFulltext(fulltextCacheKey("europepmc", "PMC1182327"))?.doi).toBeUndefined();
    expect((await fetchFulltext({ id: "PMC1182327" }, unrecorded, client, { ...deps, adapter: () => undefined })).doi).toBeUndefined();
  });

  it("serves from the cache only a text of the source it is kept for", async () => {
    const cache = new LRUBackend();
    const { client } = pubmed([]);
    const { fetchUrl, ...pages } = web();
    const deps: FulltextDeps = { unpaywall: unpaywallOf([A_DOI]), fetchUrl, adapter: europePmc().adapter, ...pages };
    // A proxy or direct text, as 0.5.0 cached them, is never served, whatever key it is found under.
    cache.setFulltext(fulltextCacheKey("unpaywall", A_DOI), { source: "proxy", fulltext: "licensed to one reader. ".repeat(100), format: "markdown", fetchedAt: Date.now() });
    const out = await fetchFulltext({ id: "x", doi: A_DOI }, cache, client, deps);
    expect(out.fulltext).toContain(`https://oa.example/${A_DOI}`);
    expect(cache.getFulltext(fulltextCacheKey("unpaywall", A_DOI))).toMatchObject({ source: "unpaywall" });
  });
});

describe("a text read in parts continues only from the source it started from", () => {
  const PROXY = "https://proxy.example";
  /** Only the institutional proxy gives a text, so none is cached. */
  const proxied = () => {
    const { fetchUrl, ...pages } = web({ refused: (url) => !url.startsWith(PROXY) });
    return { fetchUrl, deps: { unpaywall: unpaywallOf([]), proxyPrefix: PROXY, fetchUrl, adapter: europePmc().adapter, ...pages } satisfies FulltextDeps };
  };

  it("doesn't carry the text of one DOI over to a call for another, whatever the id", async () => {
    const cache = new LRUBackend();
    const { client } = pubmed([]);
    const { fetchUrl, deps } = proxied();
    const a = await fetchFulltext({ id: "x", doi: A_DOI, maxChars: 1000 }, cache, client, deps);
    expect(a).toMatchObject({ source: "proxy", doi: A_DOI, truncated: true });
    const next = a.nextOffset!;

    // The same id with another DOI is another source: its own text from the offset, fetched, and labelled with its DOI.
    const b = await fetchFulltext({ id: "x", doi: B_DOI, offset: next, maxChars: 1000 }, cache, client, deps);
    expect(b).toMatchObject({ source: "proxy", doi: B_DOI });
    expect(b.fulltext).toContain(B_DOI.replace(/\W+/g, "_"));
    expect(b.fulltext).not.toContain(A_DOI.replace(/\W+/g, "_"));
    expect(fetched(fetchUrl)).toEqual([`${PROXY}/${A_DOI}`, `${PROXY}/${B_DOI}`]);

    // The first text goes on for the DOI it came from, under any id: the same download, no request.
    for (const id of ["x", "y"]) {
      const more = await fetchFulltext({ id, doi: A_DOI, offset: next, maxChars: 1000 }, cache, client, deps);
      expect(more).toMatchObject({ id, source: "proxy", doi: A_DOI });
      expect(more.fulltext).toContain(A_DOI.replace(/\W+/g, "_"));
      expect(more.fulltext).not.toContain(B_DOI.replace(/\W+/g, "_"));
    }
    expect(fetchUrl).toHaveBeenCalledTimes(2);
  });

  it("keeps a PMID's reading to the DOI of its record, and a proxy's to its prefix", async () => {
    const cache = new LRUBackend();
    const { client } = pubmed([retractedA]);
    const { fetchUrl, deps } = proxied();
    const first = await fetchFulltext({ id: A, maxChars: 1000 }, cache, client, deps);
    expect(first).toMatchObject({ source: "proxy", doi: A_DOI, truncated: true });
    const more = await fetchFulltext({ id: A, offset: first.nextOffset!, maxChars: 1000 }, cache, client, deps);
    expect(more.fulltext).toContain(A_DOI.replace(/\W+/g, "_"));
    expect(fetchUrl).toHaveBeenCalledTimes(1);

    // The same DOI through another prefix is another source, fetched anew.
    const other = web({ refused: (url) => !url.startsWith("https://other.example") });
    await fetchFulltext({ id: A, offset: first.nextOffset!, maxChars: 1000 }, cache, client, { ...deps, ...other, proxyPrefix: "https://other.example" });
    expect(fetched(other.fetchUrl)).toEqual([`https://other.example/${A_DOI}`]);
  });

  it("refuses a later part of a PMID's text, too, when the DOI given is not the PMID's", async () => {
    const cache = new LRUBackend();
    const { client } = pubmed([retractedA]);
    const { fetchUrl, deps } = proxied();
    const first = await fetchFulltext({ id: A, maxChars: 1000 }, cache, client, deps);
    await expect(fetchFulltext({ id: A, doi: B_DOI, offset: first.nextOffset!, maxChars: 1000 }, cache, client, deps)).rejects.toMatchObject({ code: "INVALID_INPUT" });
    expect(fetchUrl).toHaveBeenCalledTimes(1);
  });
});

describe("a DOI given with an id that names no record is looked up for the article's standing", () => {
  const page = () => {
    const { fetchUrl, ...pages } = web();
    return { fetchUrl, deps: { unpaywall: unpaywallOf([VOJTA_DOI]), fetchUrl, ...pages } satisfies FulltextDeps };
  };
  /** A PDF copy: no landing page to tell from the article, so the abstract, which the DOI's record would give, isn't needed. */
  const pdf = (): FulltextDeps => ({
    unpaywall: unpaywallOf([VOJTA_DOI]),
    fetchUrl: async (url: string) => ({ ok: true, status: 200, contentType: "application/pdf", finalUrl: url, bytes: new Uint8Array([1]) }),
    pdfToText: async () => "Text. " + "content ".repeat(200),
  });

  it("opens the warning with RETRACTED, naming the notice, and keeps the record for the next call", async () => {
    const cache = new LRUBackend();
    const { client } = pubmed([]);
    const { fetchByDoi, adapter } = europePmc([vojtaRecord]);
    const { deps } = page();
    const out = await fetchFulltext({ id: "vojta-check", doi: VOJTA_DOI }, cache, client, { ...deps, adapter });
    expect(out).toMatchObject({ id: "vojta-check", source: "unpaywall", doi: VOJTA_DOI });
    expect(out.warning).toBe(`${RETRACTED_START} Linked notice: europepmc ${VOJTA_NOTICE} (literature_fetch).`);
    expect(fetchByDoi).toHaveBeenCalledWith(VOJTA_DOI);

    // The record and the text are in the cache: the next call, under any id, asks for neither and warns the same.
    const again = await fetchFulltext({ id: "something else", doi: VOJTA_DOI.toUpperCase() }, cache, client, { ...deps, adapter });
    expect(again.warning).toBe(out.warning);
    expect(again.fulltext).toBe(out.fulltext);
    expect(fetchByDoi).toHaveBeenCalledTimes(1);
  });

  it("warns on the abstract fallback and on a text in parts, and for an id of another database of Europe PMC", async () => {
    const { client } = pubmed([]);
    const { adapter } = europePmc([vojtaRecord]);
    const fallback = await fetchFulltext({ id: "x", doi: VOJTA_DOI }, new LRUBackend(), client, {
      unpaywall: unpaywallOf([]),
      fetchUrl: async () => ({ ok: false, status: 403, contentType: "text/html", finalUrl: "x" }),
      proxyPrefix: "",
      adapter,
    });
    expect(fallback.source).toBe("none");
    expect(fallback.warning!.startsWith(RETRACTED_START)).toBe(true);
    // The record of the DOI gives the abstract, too, as an id's own would have.
    expect(fallback.warning).toContain("No full text found");

    const { deps } = page();
    const cba = await fetchFulltext({ id: "CBA:644599", doi: VOJTA_DOI, maxChars: 1000 }, new LRUBackend(), client, { ...deps, adapter });
    expect(cba).toMatchObject({ source: "unpaywall", truncated: true });
    expect(cba.warning!.startsWith(RETRACTED_START)).toBe(true);
  });

  it("asks nothing for the later parts of a text, and says nothing of a record that carries no flag, or can't be had", async () => {
    const { client } = pubmed([]);
    const { fetchByDoi, adapter } = europePmc([vojtaRecord]);
    const later = await fetchFulltext({ id: "x", doi: VOJTA_DOI, offset: 100, maxChars: 200 }, new LRUBackend(), client, { ...pdf(), adapter });
    expect(later).toMatchObject({ source: "unpaywall", truncated: true });
    expect(later.warning).toBeUndefined();
    expect(fetchByDoi).not.toHaveBeenCalled();

    // (A publisher's "RETRACTED:" title marker flags a record too, so the title is the plain one.)
    const plain = europePmc([{ ...vojtaRecord, title: "Critical review of the evidence for Vojta Therapy", publicationTypes: ["Journal Article"], corrections: [] }]);
    expect((await fetchFulltext({ id: "x", doi: VOJTA_DOI }, new LRUBackend(), client, { ...pdf(), adapter: plain.adapter })).warning).toBeUndefined();
    for (const adapter of [europePmc().adapter, () => undefined, () => ({ fetch: async () => [] }), () => ({ fetch: async () => [], fetchByDoi: async () => Promise.reject(new Error("Europe PMC is down")) })] as const) {
      const out = await fetchFulltext({ id: "x", doi: VOJTA_DOI }, new LRUBackend(), client, { ...pdf(), adapter });
      expect(out.source).toBe("unpaywall");
      expect(out.warning).toBeUndefined();
    }
  });

  it(`leaves out a lookup that outlasts ${STANDING_WAIT_MS} ms from the call's start, and has it for the next call`, async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const { client } = pubmed([]);
    const deps = pdf();
    const cache = new LRUBackend();
    let release!: (found: Article) => void;
    const late = new Promise<Article>((resolve) => (release = resolve));
    const adapter: FulltextDeps["adapter"] = () => ({ fetch: async () => [], fetchByDoi: () => late });
    const call = fetchFulltext({ id: "x", doi: VOJTA_DOI }, cache, client, { ...deps, adapter });
    await vi.advanceTimersByTimeAsync(STANDING_WAIT_MS);
    const out = await call;
    expect(out.source).toBe("unpaywall");
    expect(out.warning).toBeUndefined();
    release(vojtaRecord);
    await vi.advanceTimersByTimeAsync(0);
    // The text is cached; the record, which arrived late, is what the next call warns by.
    const next = await fetchFulltext({ id: "x", doi: VOJTA_DOI }, cache, client, { ...deps, adapter: europePmc().adapter });
    expect(next.warning).toContain(RETRACTED_START);
  });

  it("reads the record from Europe PMC's search on the DOI, in the core format, and accepts only a record of that DOI", async () => {
    const queries: URLSearchParams[] = [];
    const core = (doi: string) => ({
      hitCount: 1,
      resultList: {
        result: [
          {
            id: "38711552",
            source: "MED",
            pmid: "38711552",
            pmcid: "PMC11070493",
            doi,
            title: "RETRACTED: Critical review of the evidence for Vojta Therapy",
            pubTypeList: { pubType: ["Retracted Publication", "Systematic Review", "Journal Article"] },
            commentCorrectionList: { commentCorrection: [{ source: "MED", id: VOJTA_NOTICE, type: "Retraction in" }] },
          },
        ],
      },
    });
    const http = (answer: (doi: string) => object): AdapterHttp => ({
      json: (async (url: string) => {
        const params = new URL(url).searchParams;
        queries.push(params);
        return answer(/^DOI:"(.*)"$/.exec(params.get("query")!)![1]!);
      }) as AdapterHttp["json"],
      text: async () => "",
    });
    const { client } = pubmed([]);
    const { deps } = page();
    const out = await fetchFulltext({ id: "vojta-check", doi: `https://doi.org/${VOJTA_DOI}` }, new LRUBackend(), client, { ...deps, adapter: () => new EuropePmcAdapter(http(core)) });
    expect(out.warning).toBe(`${RETRACTED_START} Linked notice: europepmc ${VOJTA_NOTICE} (literature_fetch).`);
    expect(queries).toHaveLength(1);
    expect(Object.fromEntries(queries[0]!)).toMatchObject({ query: `DOI:"${VOJTA_DOI}"`, resultType: "core", format: "json" });

    // A record of another DOI, which a loose match could return, is no record of this one.
    const adapter = new EuropePmcAdapter(http(() => core("10.1000/another")));
    expect(await adapter.fetchByDoi(VOJTA_DOI)).toBeNull();
    // The match ignores case, as Europe PMC's does.
    expect((await new EuropePmcAdapter(http(core)).fetchByDoi(VOJTA_DOI.toUpperCase()))?.id).toBe("38711552");
    expect(await new EuropePmcAdapter(http(() => ({ hitCount: 0, resultList: { result: [] } }))).fetchByDoi(VOJTA_DOI)).toBeNull();
  });
});

describe("a DOI given with a PMID is checked against the PMID's record, and the record gives the PMCID", () => {
  it.each(["10.1371/journal.pmed.0020124.", "10.1371/journal.pmed.0020124,", "10.1371/journal.pmed.0020124;", " doi:10.1371/journal.pmed.0020124. "])(
    "returns Europe PMC's text of the PMID for the DOI %j, as it does without one",
    async (given) => {
      const { client } = pubmed([recordB]);
      const { fetchUrl, ...pages } = web({ refused: (url) => !url.startsWith("https://www.ebi.ac.uk/") });
      const deps: FulltextDeps = { unpaywall: unpaywallOf([B_DOI]), fetchUrl, adapter: europePmc().adapter, ...pages };
      const out = await fetchFulltext({ id: PMID_B, doi: given }, new LRUBackend(), client, deps);
      expect(out).toMatchObject({ id: PMID_B, source: "europepmc", doi: B_DOI });
      expect(fetched(fetchUrl)).toEqual([epmcUrl("PMC1182327")]);
      const alone = await fetchFulltext({ id: PMID_B }, new LRUBackend(), client, deps);
      expect(alone).toEqual(out);
    },
  );

  it("strips the sentence's punctuation from a DOI given alone, so that Unpaywall is asked about the DOI", async () => {
    const unpaywall = unpaywallOf([B_DOI]);
    const { fetchUrl, ...pages } = web();
    const out = await fetchFulltext({ id: "x", doi: `${B_DOI}.` }, new LRUBackend(), pubmed([]).client, { unpaywall, fetchUrl, adapter: europePmc().adapter, ...pages });
    expect(unpaywall.lookup).toHaveBeenCalledWith(B_DOI);
    expect(out).toMatchObject({ source: "unpaywall", doi: B_DOI });
  });

  it("gets the same text from the record whether or not the DOI is given, and whatever is cached", async () => {
    // With a DOI the PMID was fetched by the DOI (the publisher's page), without one by the PMCID (the JATS): now both are Europe PMC's.
    const { fetchUrl, ...pages } = web();
    const deps: FulltextDeps = { unpaywall: unpaywallOf([B_DOI]), fetchUrl, adapter: europePmc().adapter, ...pages };
    const cache = new LRUBackend();
    const { client } = pubmed([recordB]);
    const cold = await fetchFulltext({ id: PMID_B, doi: B_DOI, maxChars: 500 }, cache, client, deps);
    const warm = await fetchFulltext({ id: PMID_B, maxChars: 500 }, cache, client, deps);
    expect(cold.source).toBe("europepmc");
    expect(warm).toEqual(cold);
    expect(cold.totalChars).toBe(warm.totalChars);

    // A copy of the DOI that a call by DOI alone kept (the publisher's page) doesn't take the place of Europe PMC's text.
    const other = new LRUBackend();
    const byDoi = await fetchFulltext({ id: "x", doi: B_DOI, maxChars: 500 }, other, client, deps);
    expect(byDoi.source).toBe("unpaywall");
    const byPmid = await fetchFulltext({ id: PMID_B, maxChars: 500 }, other, client, deps);
    expect(byPmid.source).toBe("europepmc");
    expect(byPmid.fulltext).toBe(cold.fulltext);
  });

  it("serves the copy kept for the DOI when Europe PMC has no text of the PMCID, without asking Unpaywall again", async () => {
    const cache = new LRUBackend();
    const { client } = pubmed([recordB]);
    const unpaywall = unpaywallOf([B_DOI]);
    const { fetchUrl, ...pages } = web({ refused: (url) => url.includes("/fullTextXML") });
    const deps: FulltextDeps = { unpaywall, fetchUrl, adapter: europePmc().adapter, ...pages };
    const first = await fetchFulltext({ id: PMID_B, maxChars: 500 }, cache, client, deps);
    expect(first).toMatchObject({ source: "unpaywall", doi: B_DOI });
    expect(fetched(fetchUrl)).toEqual([epmcUrl("PMC1182327"), `https://oa.example/${B_DOI}`]);
    // Europe PMC is asked first, as on a cold cache; the Unpaywall copy then comes from the cache.
    const again = await fetchFulltext({ id: PMID_B, maxChars: 500 }, cache, client, deps);
    expect(again).toEqual(first);
    expect(fetched(fetchUrl)).toEqual([epmcUrl("PMC1182327"), `https://oa.example/${B_DOI}`, epmcUrl("PMC1182327")]);
    expect(unpaywall.lookup).toHaveBeenCalledTimes(1);
  });

  it("goes on with the DOI given when the record has none, and refuses when it has another, whatever the id's other records say", async () => {
    const { fetchUrl, ...pages } = web();
    const deps: FulltextDeps = { unpaywall: unpaywallOf([A_DOI, B_DOI]), fetchUrl, adapter: europePmc().adapter, ...pages };
    const { doi: _doi, ...undated } = retractedA;
    const out = await fetchFulltext({ id: A, doi: B_DOI }, new LRUBackend(), pubmed([undated]).client, deps);
    expect(out).toMatchObject({ source: "unpaywall", doi: B_DOI });

    // A record a search cached counts, with no request to PubMed.
    const cache = new LRUBackend();
    cache.setSummary(A, retractedA);
    const { client, esummary } = pubmed([]);
    await expect(fetchFulltext({ id: A, doi: B_DOI }, cache, client, deps)).rejects.toMatchObject({ code: "INVALID_INPUT" });
    expect(esummary).not.toHaveBeenCalled();
  });
});

describe("what an earlier version stored under an id is never read", () => {
  const OLD_TEXT = "Text of another article. ".repeat(100);
  const stale = (key: string, cache: Cache, source = "unpaywall"): void =>
    cache.setFulltext(key, { source, fulltext: OLD_TEXT, format: "markdown", fetchedAt: Date.now() });

  it("ignores a text kept under a plain id in a persistent cache, and keeps its own beside it, with its DOI", async () => {
    const cache = new SQLiteBackend(":memory:");
    try {
      stale(A, cache);
      stale("x", cache);
      stale("PMC1182327", cache, "europepmc");
      const { client } = pubmed([retractedA, recordB]);
      const { fetchUrl, ...pages } = web();
      const deps: FulltextDeps = { unpaywall: unpaywallOf([A_DOI, B_DOI]), fetchUrl, adapter: europePmc([], [recordB]).adapter, ...pages };

      const byPmid = await fetchFulltext({ id: A }, cache, client, deps);
      expect(byPmid.fulltext).toContain(`https://oa.example/${A_DOI}`);
      expect(byPmid.fulltext).not.toContain("another article");
      const byDoi = await fetchFulltext({ id: "x", doi: B_DOI }, cache, client, { ...deps, adapter: europePmc().adapter });
      expect(byDoi.fulltext).not.toContain("another article");
      const byPmcid = await fetchFulltext({ id: "PMC1182327" }, cache, client, deps);
      expect(byPmcid.fulltext).toContain(epmcUrl("PMC1182327"));

      // The texts it fetched are stored under the sources, with the DOI each belongs to, and read back from there.
      expect(cache.getFulltext(fulltextCacheKey("unpaywall", A_DOI))).toMatchObject({ source: "unpaywall", doi: A_DOI });
      expect(cache.getFulltext(fulltextCacheKey("europepmc", "PMC1182327"))).toMatchObject({ source: "europepmc", doi: B_DOI });
      const requests = fetchUrl.mock.calls.length;
      expect(await fetchFulltext({ id: A }, cache, client, deps)).toEqual(byPmid);
      expect(await fetchFulltext({ id: "other", doi: A_DOI }, cache, client, deps)).toMatchObject({ doi: A_DOI, fulltext: byPmid.fulltext });
      expect(await fetchFulltext({ id: PMID_B }, cache, client, deps)).toMatchObject({ source: "europepmc", doi: B_DOI, fulltext: byPmcid.fulltext });
      expect(fetchUrl).toHaveBeenCalledTimes(requests);
      // The entries under plain ids are still there, and not served.
      expect(cache.getFulltext(A)?.fulltext).toBe(OLD_TEXT);
    } finally {
      cache.close();
    }
  });

  it("uses a different key for each source, so that no id or DOI can name another's", () => {
    expect(fulltextCacheKey("europepmc", "pmc1182327")).toBe(fulltextCacheKey("europepmc", "PMC1182327"));
    expect(fulltextCacheKey("unpaywall", A_DOI.toUpperCase())).toBe(fulltextCacheKey("unpaywall", A_DOI));
    expect(fulltextCacheKey("unpaywall", A_DOI)).not.toBe(fulltextCacheKey("europepmc", A_DOI));
    for (const key of [fulltextCacheKey("europepmc", "PMC1182327"), fulltextCacheKey("unpaywall", A_DOI)]) {
      // Not any id a PMID, PMCID or DOI call reads, and not one an earlier version wrote for them.
      expect(key).not.toBe("PMC1182327");
      expect(key).not.toBe(A_DOI);
      expect(key).not.toMatch(/^(?:PMC|PPR)?\d+$/);
    }
  });
});
