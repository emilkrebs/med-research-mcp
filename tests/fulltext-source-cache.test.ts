import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
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

    // A DOI given with a PMCID is checked against the record of the PMCID, as a PMID's is: another is refused.
    const other = new LRUBackend();
    const known: FulltextDeps["adapter"] = () => ({ fetch: async () => [recordB] });
    const refused = await fetchFulltext({ id: "PMC1182327", doi: A_DOI }, other, client, { ...deps, adapter: known }).catch((e: unknown) => e as ResearchApiException);
    expect(refused).toMatchObject({ code: "INVALID_INPUT" });
    expect(refused.userMessage).toContain("PMC1182327");
    expect(refused.userMessage).toContain(A_DOI);
    expect(refused.userMessage).toContain(B_DOI);
    expect(other.getFulltext(fulltextCacheKey("europepmc", "PMC1182327"))).toBeNull();
    const given = await fetchFulltext({ id: "PMC1182327", doi: B_DOI }, other, client, { ...deps, adapter: known });
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

  /** What each caller reads, run through a cache that holds an earlier version's entries, plain-id keys included. */
  async function readsOnlyItsOwn(cache: Cache): Promise<void> {
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
  }

  it("empties the full texts of format 3, which a file written by an earlier version holds under plain ids, and keeps its own, with their DOIs", async () => {
    const dir = mkdtempSync(join(tmpdir(), "fulltext-v3-"));
    const path = join(dir, "cache.db");
    try {
      // A file as the version before this one left it: its tables, with the key column `id` and no `doi`.
      const raw = new Database(path);
      raw.exec(`
        CREATE TABLE summaries_v3 (id TEXT PRIMARY KEY, article TEXT NOT NULL, fetched_at INTEGER NOT NULL);
        CREATE TABLE abstracts_v3 (id TEXT PRIMARY KEY, abstract TEXT NOT NULL, fetched_at INTEGER NOT NULL);
        CREATE TABLE fulltexts_v3 (id TEXT PRIMARY KEY, source TEXT NOT NULL, fulltext TEXT NOT NULL, format TEXT NOT NULL, fetched_at INTEGER NOT NULL);
      `);
      const insert = raw.prepare("INSERT INTO fulltexts_v3 VALUES (?, ?, ?, ?, ?)");
      for (const [id, source] of [[A, "unpaywall"], ["x", "unpaywall"], ["PMC1182327", "europepmc"]] as const) insert.run(id, source, OLD_TEXT, "markdown", Date.now());
      raw.close();

      const cache = new SQLiteBackend(path);
      try {
        for (const id of [A, "x", "PMC1182327"]) expect(cache.getFulltext(id), id).toBeNull();
        await readsOnlyItsOwn(cache);
      } finally {
        cache.close();
      }
      // The old table is emptied, not dropped, and what the new version stored is in the new one, with its DOI column.
      const after = new Database(path);
      expect(after.prepare("SELECT COUNT(*) AS n FROM fulltexts_v3").get()).toEqual({ n: 0 });
      expect(after.prepare("SELECT source, doi FROM fulltexts_v4 WHERE id = ?").get(fulltextCacheKey("unpaywall", A_DOI))).toEqual({ source: "unpaywall", doi: A_DOI });
      after.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("ignores a text kept under a plain id in a cache that doesn't separate versions, and leaves it there", async () => {
    const cache = new LRUBackend();
    stale(A, cache);
    stale("x", cache);
    stale("PMC1182327", cache, "europepmc");
    await readsOnlyItsOwn(cache);
    expect(cache.getFulltext(A)?.fulltext).toBe(OLD_TEXT);
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

describe("a text read in parts stays the one it started with, whichever source answers later", () => {
  const tagOf = (url: string): string => url.replace(/\W+/g, "_");

  it("keeps to the Unpaywall copy when Europe PMC, which failed for the first part, answers for the next", async () => {
    const cache = new LRUBackend();
    const { client } = pubmed([recordB]);
    let europePmcUp = false;
    const { fetchUrl, ...pages } = web({ refused: (url) => !europePmcUp && url.includes("/fullTextXML") });
    const deps: FulltextDeps = { unpaywall: unpaywallOf([B_DOI]), fetchUrl, adapter: europePmc().adapter, ...pages };

    const first = await fetchFulltext({ id: PMID_B, maxChars: 500 }, cache, client, deps);
    expect(first).toMatchObject({ source: "unpaywall", doi: B_DOI, truncated: true });
    europePmcUp = true;
    const requests = fetchUrl.mock.calls.length;
    const more = await fetchFulltext({ id: PMID_B, offset: first.nextOffset!, maxChars: 500 }, cache, client, deps);
    expect(more).toMatchObject({ source: "unpaywall", doi: B_DOI });
    expect(more.fulltext).toContain(tagOf(`https://oa.example/${B_DOI}`));
    expect(fetchUrl).toHaveBeenCalledTimes(requests);

    // From the start of a text, Europe PMC is tried first, as on a cold cache.
    const fresh = await fetchFulltext({ id: PMID_B, maxChars: 500 }, cache, client, deps);
    expect(fresh.source).toBe("europepmc");
  });

  it("keeps to the text of a DOI that couldn't be checked when the record can be read for the next part", async () => {
    const cache = new LRUBackend();
    const { fetchUrl, ...pages } = web();
    const deps: FulltextDeps = { unpaywall: unpaywallOf([B_DOI]), fetchUrl, adapter: europePmc().adapter, ...pages };

    // PubMed is down for the first part: no PMCID, so the DOI's copy is read.
    const first = await fetchFulltext({ id: PMID_B, doi: B_DOI, maxChars: 500 }, cache, pubmed([recordB], { down: true }).client, deps);
    expect(first).toMatchObject({ source: "unpaywall", truncated: true });
    // It is up for the next, and says the PMID has a PMCID: the text that was started is still the one read on.
    const requests = fetchUrl.mock.calls.length;
    const more = await fetchFulltext({ id: PMID_B, doi: B_DOI, offset: first.nextOffset!, maxChars: 500 }, cache, pubmed([recordB]).client, deps);
    expect(more).toMatchObject({ source: "unpaywall", doi: B_DOI });
    expect(more.fulltext).toContain(tagOf(`https://oa.example/${B_DOI}`));
    expect(fetchUrl).toHaveBeenCalledTimes(requests);
  });
});

describe("a ChinaRxiv text is labelled with the DOI of ChinaRxiv's own record, never the caller's", () => {
  const ID = "chinaxiv-202401.00027";
  const BODY = ("Translated sentence. ".repeat(60)).trim();
  const record = (extra: Partial<Article> = {}): Article => ({
    id: ID,
    title: "A translated paper",
    authors: ["Zhang W"],
    journal: "ChinaXiv",
    pubDate: "2024",
    publicationTypes: [],
    database: "chinaxiv",
    machineTranslated: true,
    ...extra,
  });
  const chinarxiv = (found: Article): FulltextDeps["adapter"] => () => ({ fetch: async () => [found], fetchFull: async () => [found], fetchText: async () => BODY });

  it("serves the text without the DOI given, and every later part too, from anyone", async () => {
    const cache = new LRUBackend();
    const { client } = pubmed([]);
    const deps: FulltextDeps = { unpaywall: unpaywallOf([B_DOI]), adapter: chinarxiv(record()) };

    const first = await fetchFulltext({ id: ID, doi: B_DOI, maxChars: 400 }, cache, client, deps);
    expect(first).toMatchObject({ id: ID, source: "chinarxiv", truncated: true });
    expect(first.doi).toBeUndefined();
    const next = first.nextOffset!;
    for (const input of [{ id: ID }, { id: ID, doi: B_DOI }, { id: ID, doi: A_DOI }]) {
      const more = await fetchFulltext({ ...input, offset: next, maxChars: 400 }, cache, client, deps);
      expect(more, JSON.stringify(input)).toMatchObject({ source: "chinarxiv" });
      expect(more.doi, JSON.stringify(input)).toBeUndefined();
    }
  });

  it("labels it with the DOI the record itself has", async () => {
    const cache = new LRUBackend();
    const deps: FulltextDeps = { unpaywall: unpaywallOf([]), adapter: chinarxiv(record({ doi: A_DOI })) };
    const first = await fetchFulltext({ id: ID, doi: B_DOI, maxChars: 400 }, cache, pubmed([]).client, deps);
    expect(first).toMatchObject({ source: "chinarxiv", doi: A_DOI });
    const more = await fetchFulltext({ id: ID, offset: first.nextOffset!, maxChars: 400 }, cache, pubmed([]).client, deps);
    expect(more).toMatchObject({ source: "chinarxiv", doi: A_DOI });
  });
});

describe("the record of an id speaks for the text of a DOI only when the DOI is the id's own", () => {
  const NOTICE_ID = "11111111";
  const DOI_NOTICE = "22222222";
  const marks = (id: string) => ({ publicationTypes: ["Journal Article", "Retracted Publication"], corrections: [{ type: "RetractionIn" as const, id }], database: "europepmc" as const });
  /** The record of PMC1182327, retracted, whose DOI is `doi` (none, when undefined). */
  const idRecord = (doi?: string): Article => ({ ...recordB, ...(doi ? { doi } : { doi: undefined }), ...marks(NOTICE_ID) });
  /** The record Europe PMC holds for B_DOI: flagged, with another notice. */
  const doiRecord: Article = { ...recordB, ...marks(DOI_NOTICE) };
  const europePmcOf = (found: Article, byDoi: Article[] = []) => {
    const { fetchByDoi } = europePmc(byDoi);
    const adapter: FulltextDeps["adapter"] = () => ({ fetch: async () => [found], fetchByDoi });
    return { adapter, fetchByDoi };
  };
  const deps = (adapter: FulltextDeps["adapter"], europePmcUp: boolean): FulltextDeps => {
    const { fetchUrl, ...pages } = web({ refused: (url) => !europePmcUp && url.includes("/fullTextXML") });
    return { unpaywall: unpaywallOf([B_DOI]), fetchUrl, adapter, ...pages };
  };

  it("puts the record's warning on the text of the DOI the record confirms, even when Europe PMC has none", async () => {
    const out = await fetchFulltext({ id: "PMC1182327", doi: B_DOI }, new LRUBackend(), pubmed([]).client, deps(europePmcOf(idRecord(B_DOI)).adapter, false));
    expect(out).toMatchObject({ source: "unpaywall", doi: B_DOI });
    expect(out.warning).toContain(`europepmc ${NOTICE_ID}`);
  });

  it("puts the warning of the DOI's own record on the text of a DOI that a record without one can't confirm, and not the id's", async () => {
    for (const [id, found, client] of [
      ["PMC1182327", idRecord(), pubmed([]).client],
      [PMID_B, idRecord(), pubmed([idRecord()]).client],
    ] as const) {
      const { adapter, fetchByDoi } = europePmcOf(found, [doiRecord]);
      const out = await fetchFulltext({ id, doi: B_DOI }, new LRUBackend(), client, deps(adapter, false));
      expect(out, id).toMatchObject({ source: "unpaywall", doi: B_DOI });
      expect(out.warning, id).toContain(`europepmc ${DOI_NOTICE}`);
      expect(out.warning, id).not.toContain(NOTICE_ID);
      expect(fetchByDoi, id).toHaveBeenCalledWith(B_DOI);
    }
    // With nothing known of the DOI, the text has no warning: the id's record says nothing of it.
    const { adapter } = europePmcOf(idRecord());
    expect((await fetchFulltext({ id: "PMC1182327", doi: B_DOI }, new LRUBackend(), pubmed([]).client, deps(adapter, false))).warning).toBeUndefined();
  });

  it("still puts the record's warning on Europe PMC's text of the PMCID, and on the abstract returned in place of a text", async () => {
    const { adapter } = europePmcOf(idRecord(), [doiRecord]);
    const text = await fetchFulltext({ id: "PMC1182327", doi: B_DOI }, new LRUBackend(), pubmed([]).client, deps(adapter, true));
    expect(text.source).toBe("europepmc");
    expect(text.warning).toContain(`europepmc ${NOTICE_ID}`);
    expect(text.warning).not.toContain(DOI_NOTICE);

    const { fetchUrl, ...pages } = web({ refused: () => true });
    const none = await fetchFulltext({ id: PMID_B, doi: B_DOI }, new LRUBackend(), pubmed([idRecord()]).client, { unpaywall: unpaywallOf([B_DOI]), fetchUrl, proxyPrefix: "", adapter, ...pages });
    expect(none.source).toBe("none");
    expect(none.warning).toContain(`europepmc ${NOTICE_ID}`);
  });

  it("warns by the DOI's record when the id's can't be read", async () => {
    const { adapter } = europePmcOf(idRecord(), [doiRecord]);
    const down = await fetchFulltext({ id: A, doi: B_DOI }, new LRUBackend(), pubmed([], { down: true }).client, deps(adapter, false));
    expect(down).toMatchObject({ source: "unpaywall", doi: B_DOI });
    expect(down.warning).toContain(`europepmc ${DOI_NOTICE}`);
    expect(down.warning).not.toContain(A_NOTICE);
  });
});

describe("a PMID's text that is still cached is served while PubMed can't be reached", () => {
  /** A cache whose summaries have expired (they last 7 days, a text 30) when `expired` is set. */
  class ExpiringSummaries extends LRUBackend {
    expired = false;
    override getSummary(id: string): Article | null {
      return this.expired ? null : super.getSummary(id);
    }
  }
  const down = pubmed([], { down: true }).client;

  it.each([
    ["Europe PMC's text of the PMID's PMCID", PMID_B, recordB, "europepmc"],
    ["an Unpaywall copy of the PMID's DOI", A, retractedA, "unpaywall"],
  ] as const)("serves %s, every part of it", async (_name, pmid, record, source) => {
    const cache = new ExpiringSummaries();
    const { fetchUrl, ...pages } = web();
    const deps: FulltextDeps = { unpaywall: unpaywallOf([A_DOI, B_DOI]), fetchUrl, adapter: europePmc().adapter, ...pages };
    const first = await fetchFulltext({ id: pmid, maxChars: 500 }, cache, pubmed([record]).client, deps);
    expect(first.source).toBe(source);
    cache.expired = true;
    const requests = fetchUrl.mock.calls.length;
    const again = await fetchFulltext({ id: pmid, maxChars: 500 }, cache, down, deps);
    expect(again).toMatchObject({ source, doi: first.doi, fulltext: first.fulltext, totalChars: first.totalChars });
    // Its record wasn't read, so it says that the paper's standing wasn't checked, on every part.
    const unchecked = "PubMed couldn't be reached, so the paper's retraction and correction status wasn't checked.";
    expect(again.warning).toContain(unchecked);
    expect(first.warning ?? "").not.toContain("wasn't checked");
    const later = await fetchFulltext({ id: pmid, offset: first.nextOffset!, maxChars: 500 }, cache, down, deps);
    expect(later.source).toBe(source);
    expect(later.warning).toContain(unchecked);
    expect(fetchUrl).toHaveBeenCalledTimes(requests);
    // A PMID with no text kept still fails as it does, since without its record there is nothing to go on.
    await expect(fetchFulltext({ id: "99999999" }, cache, down, deps)).rejects.toThrow("NCBI is down");
  });

  it("keeps the entries for PMIDs out of the places for texts, of which a cache in memory has few", async () => {
    const records = [1, 2, 3].map((n): Article => ({ ...recordB, id: `1000000${n}`, doi: `10.1000/paper${n}`, pmcid: undefined, title: `Paper ${n}` }));
    const { client } = pubmed(records);
    const { fetchUrl, ...pages } = web();
    const deps: FulltextDeps = { unpaywall: unpaywallOf(records.map((r) => r.doi!)), fetchUrl, adapter: europePmc().adapter, ...pages };
    // Room for three texts: one entry per PMID read, kept with them, would leave room for one or two.
    const cache = new LRUBackend(3);
    for (const r of records) expect((await fetchFulltext({ id: r.id }, cache, client, deps)).source).toBe("unpaywall");
    for (const r of records) expect(cache.getFulltext(fulltextCacheKey("unpaywall", r.doi!)), r.id).not.toBeNull();
  });

  it("is no abstract that an id can read: the entry for a PMID is found by that PMID alone", async () => {
    const cache = new LRUBackend();
    const { client } = pubmed([retractedA]);
    const { fetchUrl, ...pages } = web();
    const deps: FulltextDeps = { unpaywall: unpaywallOf([A_DOI]), fetchUrl, adapter: europePmc().adapter, ...pages };
    await fetchFulltext({ id: A }, cache, client, deps);
    // An id that is not a PMID, with a DOI that has no text anywhere, comes back with no abstract, whatever the entry says.
    const refused = web({ refused: () => true });
    const out = await fetchFulltext({ id: `pointer:${A}`, doi: VOJTA_DOI }, cache, client, { unpaywall: unpaywallOf([]), proxyPrefix: "", fetchUrl: refused.fetchUrl, adapter: europePmc().adapter, ...refused });
    expect(out.source).toBe("none");
    expect(out.fulltext).toBeUndefined();
  });

  it("leaves no way to the text of a DOI that couldn't be confirmed for the PMID it was given with", async () => {
    const cache = new ExpiringSummaries();
    const { fetchUrl, ...pages } = web();
    const deps: FulltextDeps = { unpaywall: unpaywallOf([A_DOI, B_DOI]), fetchUrl, adapter: europePmc().adapter, ...pages };
    // PubMed is down, so B's DOI can't be checked against the PMID's record: B's text is returned for the call.
    const unchecked = await fetchFulltext({ id: A, doi: B_DOI }, cache, down, deps);
    expect(unchecked).toMatchObject({ source: "unpaywall", doi: B_DOI });
    // Nothing ties the PMID to it: when the PMID's record can't be read, the PMID gets no text, not that one.
    await expect(fetchFulltext({ id: A }, cache, down, deps)).rejects.toThrow("NCBI is down");
  });
});

describe("a DOI no record answers for is not searched for on every call", () => {
  const page = (): FulltextDeps => {
    const { fetchUrl, ...pages } = web();
    return { unpaywall: unpaywallOf([VOJTA_DOI]), fetchUrl, ...pages };
  };

  it("remembers that Europe PMC has no record, for the cache the call has", async () => {
    const cache = new LRUBackend();
    const { client } = pubmed([]);
    const { fetchByDoi, adapter } = europePmc();
    for (let i = 0; i < 3; i++) await fetchFulltext({ id: "x", doi: VOJTA_DOI }, cache, client, { ...page(), adapter });
    expect(fetchByDoi).toHaveBeenCalledTimes(1);
    // Another cache starts again.
    await fetchFulltext({ id: "x", doi: VOJTA_DOI }, new LRUBackend(), client, { ...page(), adapter });
    expect(fetchByDoi).toHaveBeenCalledTimes(2);
  });

  it("doesn't remember a request that failed, which is asked again and warns once it answers", async () => {
    const cache = new LRUBackend();
    const { client } = pubmed([]);
    const fetchByDoi = vi.fn().mockRejectedValueOnce(new Error("Europe PMC is down")).mockResolvedValue(vojtaRecord);
    const adapter: FulltextDeps["adapter"] = () => ({ fetch: async () => [], fetchByDoi });
    expect((await fetchFulltext({ id: "x", doi: VOJTA_DOI }, cache, client, { ...page(), adapter })).warning).toBeUndefined();
    expect((await fetchFulltext({ id: "x", doi: VOJTA_DOI }, cache, client, { ...page(), adapter })).warning).toContain(RETRACTED_START);
    expect(fetchByDoi).toHaveBeenCalledTimes(2);
  });
});

describe("the DOI's own record gets its wait from when it is asked for, whatever the id's record took", () => {
  const later = <T>(ms: number, value: T): Promise<T> => new Promise((resolve) => setTimeout(() => resolve(value), ms));
  /** A PDF copy of the Vojta DOI: no landing page, so the text is there at once. */
  const pdf = (): FulltextDeps => ({
    unpaywall: unpaywallOf([VOJTA_DOI]),
    fetchUrl: async (url: string) => ({ ok: !url.includes("/fullTextXML"), status: url.includes("/fullTextXML") ? 404 : 200, contentType: "application/pdf", finalUrl: url, bytes: new Uint8Array([1]) }),
    pdfToText: async () => "Text. " + "content ".repeat(200),
  });

  it("warns by the DOI's record, which takes 0.5 s, after the id's record, which took the whole wait and more", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    // The PMID's esummary takes 4 s, so the wait for it ends at 3 s and the DOI given goes on unchecked; Europe PMC then
    // answers the DOI's own record in 0.5 s, within a wait of its own, and the text is flagged.
    const { client, esummary } = pubmed([retractedA]);
    esummary.mockImplementation(() => later(4000, new Map([[A, retractedA]])));
    const fetchByDoi = vi.fn(() => later(500, vojtaRecord));
    const adapter: FulltextDeps["adapter"] = () => ({ fetch: async () => [], fetchByDoi });
    const call = fetchFulltext({ id: A, doi: VOJTA_DOI }, new LRUBackend(), client, { ...pdf(), adapter });
    await vi.advanceTimersByTimeAsync(STANDING_WAIT_MS);
    await vi.advanceTimersByTimeAsync(500);
    const out = await call;
    expect(out).toMatchObject({ source: "unpaywall", doi: VOJTA_DOI });
    expect(out.warning).toBe(`${RETRACTED_START} Linked notice: europepmc ${VOJTA_NOTICE} (literature_fetch).`);
  });

  it("does the same for a PMCID whose record is late, and still leaves the DOI's record out when it is later than its own wait", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    const { client } = pubmed([]);
    for (const [lookupMs, flagged] of [[500, true], [STANDING_WAIT_MS + 1000, false]] as const) {
      const fetchByDoi = vi.fn(() => later(lookupMs, vojtaRecord));
      const adapter: FulltextDeps["adapter"] = () => ({ fetch: () => later(4000, [recordB]), fetchByDoi });
      const call = fetchFulltext({ id: "PMC1182327", doi: VOJTA_DOI }, new LRUBackend(), client, { ...pdf(), adapter });
      await vi.advanceTimersByTimeAsync(STANDING_WAIT_MS);
      await vi.advanceTimersByTimeAsync(Math.min(lookupMs, STANDING_WAIT_MS));
      const out = await call;
      expect(out.source, String(lookupMs)).toBe("unpaywall");
      expect(out.warning?.startsWith(RETRACTED_START) ?? false, String(lookupMs)).toBe(flagged);
      // Not the id's record, which is of another paper.
      expect(out.warning ?? "", String(lookupMs)).not.toContain("PMC1182327");
    }
  });
});

describe("a Europe PMC record read for a PMID is not kept as PubMed's", () => {
  it("leaves the bare PMID's summary, which search and fetch serve as PubMed's, to PubMed's records", async () => {
    const { client } = pubmed([]);
    const refused = web({ refused: () => true });
    const deps: FulltextDeps = { unpaywall: unpaywallOf([]), proxyPrefix: "", adapter: europePmc().adapter, ...refused };
    // A record Europe PMC's search left in the cache, read for the abstract that efetch then completes.
    const fromEuropePmc = new LRUBackend();
    fromEuropePmc.setSummary(`europepmc:${A}`, { ...retractedA, database: "europepmc" });
    const out = await fetchFulltext({ id: A }, fromEuropePmc, client, deps);
    expect(out.source).toBe("none");
    expect(fromEuropePmc.getSummary(A)).toBeNull();
    // The esummary a call made itself is PubMed's: completed by efetch, it is kept under the bare PMID, as before.
    const fromPubMed = new LRUBackend();
    fromPubMed.setSummary(`fulltext:${A}`, retractedA);
    await fetchFulltext({ id: A }, fromPubMed, client, deps);
    expect(fromPubMed.getSummary(A)).toMatchObject({ id: A });
  });
});
