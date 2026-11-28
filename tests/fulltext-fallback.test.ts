import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fetchFulltext, type FetchedResource, type FulltextDeps } from "../src/core/fulltext";
import type { UnpaywallClient } from "../src/core/unpaywall";
import { ChinaRXivAdapter } from "../src/core/adapters/chinarxiv";
import { EuropePmcAdapter } from "../src/core/adapters/europepmc";
import type { AdapterHttp } from "../src/core/adapters/http";
import { LRUBackend } from "../src/core/cache";
import type { NcbiClient } from "../src/core/pubmed";
import { errors } from "../src/core/errors";
import type { Article } from "../src/core/types";

// What literature_fulltext returns when there is no full text: the abstract cut to maxChars (#29), and ids that name
// no article reported as NOT_FOUND, not as an outage or a paywall (#35). The fakes mirror those of fulltext.test.ts.

const DOI = "10.1000/xyz123";
const ARTICLE: Article = {
  id: "12345678",
  title: "Creatine and cognition",
  authors: ["Doe J"],
  journal: "J Test",
  pubDate: "2021",
  doi: DOI,
  publicationTypes: ["Randomized Controlled Trial"],
  abstract: "Short abstract.",
};
/** About 1,300 characters, the kind of abstract that came back whole for maxChars 300. */
const LONG_ABSTRACT = Array.from({ length: 40 }, (_, i) => `Sentence ${i} reports a finding.`).join(" ");

/** A stand-in NCBI client: esummary answers `summary`, efetch has no abstract of its own. */
function fakeClient(summary: Article | null = ARTICLE): NcbiClient {
  return {
    tool: "med-research-mcp",
    esummary: async (pmids: string[]) => new Map(summary ? [[pmids[0]!, summary]] : []),
    efetch: async (pmids: string[]) => new Map([[pmids[0]!, { publicationTypes: [], meshHeadings: [], corrections: [] }]]),
  } as unknown as NcbiClient;
}

/** An Unpaywall that knows no open-access copy. */
const noCopy = { lookup: async () => ({ status: "none" }), sharedContact: false } as unknown as UnpaywallClient;

const status = (code: number) => async (url: string): Promise<FetchedResource> => ({ ok: false, status: code, contentType: "text/html", finalUrl: url });
const paywalled = status(403);

/** Europe PMC answers 404 for the full text, and the other hosts (doi.org) refuse. */
const europePmcWithoutText = async (url: string): Promise<FetchedResource> => status(url.includes("ebi.ac.uk") ? 404 : 403)(url);

/**
 * A stand-in for the registry's Europe PMC adapter, answering by id from `records`. Like RestAdapter's, its `fetch` counts a
 * failed request as no record, and only `find` throws: `failure` is what the request raises.
 */
function fakeEuropePmc(records: Article[] = [], failure?: Error) {
  const fetch = vi.fn(async (ids: string[]) => (failure ? [] : records.filter((r) => ids.includes(r.id))));
  const find = vi.fn(async (id: string) => {
    if (failure) throw failure;
    return records.find((r) => r.id === id) ?? null;
  });
  const adapter: FulltextDeps["adapter"] = () => ({ fetch, find });
  return { fetch, find, adapter };
}

// No test here may reach the network: a stray request would be swallowed as a failed lookup.
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
  vi.unstubAllGlobals();
  expect(strayRequests).toEqual([]);
});

describe("the abstract fallback honours maxChars", () => {
  const withAbstract = (abstract: string): Article => ({ ...ARTICLE, abstract });
  const fallback = (abstract: string, maxChars: number | undefined, extra: Partial<Parameters<typeof fetchFulltext>[0]> = {}, deps: FulltextDeps = {}) =>
    fetchFulltext({ id: "12345678", ...(maxChars === undefined ? {} : { maxChars }), ...extra }, new LRUBackend(), fakeClient(withAbstract(abstract)), {
      unpaywall: noCopy,
      fetchUrl: paywalled,
      ...deps,
    });

  it("cuts a long abstract to maxChars at a word boundary, and says so, without a nextOffset that leads nowhere", async () => {
    const out = await fallback(LONG_ABSTRACT, 300);
    const shown = out.fulltext!;
    expect(out.source).toBe("none");
    expect(shown.length).toBeLessThanOrEqual(300);
    // A whole number of words, cut in the last fifth of the limit, and a prefix of the abstract.
    expect(shown.length).toBeGreaterThanOrEqual(240);
    expect(LONG_ABSTRACT.startsWith(shown)).toBe(true);
    expect(LONG_ABSTRACT[shown.length - 1]).toBe(" ");
    expect(out.truncated).toBe(true);
    expect(out.totalChars).toBe(LONG_ABSTRACT.length);
    expect(out).not.toHaveProperty("nextOffset");
    expect(out.warning).toContain(
      `No full text found; returned the abstract only, cut to its first ${shown.length} of ${LONG_ABSTRACT.length} characters to fit maxChars: literature_fetch returns it whole.`,
    );
    // The reason the text wasn't found follows, as before.
    expect(out.warning).toContain("refused access (HTTP 403)");
  });

  it("returns an abstract that fits whole, as before, with its length", async () => {
    for (const maxChars of [LONG_ABSTRACT.length, LONG_ABSTRACT.length + 1, undefined]) {
      const out = await fallback(LONG_ABSTRACT, maxChars);
      expect(out).toMatchObject({ source: "none", fulltext: LONG_ABSTRACT, truncated: false, totalChars: LONG_ABSTRACT.length });
      expect(out).not.toHaveProperty("nextOffset");
      expect(out.warning).toContain("No full text found; returned the abstract only.");
      expect(out.warning).not.toMatch(/cut to|literature_fetch/);
    }
  });

  it("cuts at maxChars when the abstract has no break to cut at, and keeps a character outside the BMP whole", async () => {
    const solid = "a".repeat(499) + "\u{1D6FC}" + "b".repeat(100);
    const out = await fallback(solid, 500);
    expect(out.fulltext).toBe("a".repeat(499));
    expect(out).toMatchObject({ truncated: true, totalChars: solid.length });
    const hard = await fallback("a".repeat(400), 100);
    expect(hard.fulltext).toBe("a".repeat(100));
    expect(hard.warning).toContain("cut to its first 100 of 400 characters");
  });

  it("applies the server's limit when maxChars asks for more", async () => {
    const out = await fallback(LONG_ABSTRACT, 5000, {}, { maxChars: 200 });
    expect(out.fulltext!.length).toBeLessThanOrEqual(200);
    expect(out).toMatchObject({ truncated: true, totalChars: LONG_ABSTRACT.length });
  });

  it("returns no text, and no length, for a call that reads on from an offset", async () => {
    const out = await fallback(LONG_ABSTRACT, 300, { offset: 100 });
    expect(out.source).toBe("none");
    expect(out.fulltext).toBeUndefined();
    expect(out).toMatchObject({ truncated: false });
    expect(out).not.toHaveProperty("totalChars");
    expect(out).not.toHaveProperty("nextOffset");
    expect(out.warning).toContain("so there is no part from offset 100; call without offset for the abstract.");
    expect(out.warning).not.toContain("literature_fetch");
  });

  it("cuts the abstract of a PMID whose DOI couldn't be resolved, too", async () => {
    const { doi: _doi, ...undated } = ARTICLE;
    const out = await fetchFulltext({ id: "12345678", maxChars: 300 }, new LRUBackend(), fakeClient({ ...undated, abstract: LONG_ABSTRACT }), {});
    expect(out).toMatchObject({ source: "none", truncated: true, totalChars: LONG_ABSTRACT.length });
    expect(out.fulltext!.length).toBeLessThanOrEqual(300);
    expect(out.warning).toMatch(/^No full text found; returned the abstract only, cut to its first \d+ of \d+ characters to fit maxChars: literature_fetch returns it whole\. Could not resolve a DOI/);
  });

  it("cuts the abstract of a preprint, and of a ChinaRxiv record, and keeps what is said of the record", async () => {
    const preprint: Article = { ...ARTICLE, id: "PPR123456", doi: undefined, journal: "medRxiv", database: "europepmc", abstract: LONG_ABSTRACT };
    const ppr = await fetchFulltext({ id: "PPR123456", maxChars: 100 }, new LRUBackend(), fakeClient(), {
      fetchUrl: status(404),
      adapter: fakeEuropePmc([preprint]).adapter,
    });
    expect(ppr).toMatchObject({ source: "none", truncated: true, totalChars: LONG_ABSTRACT.length });
    expect(ppr.fulltext!.length).toBeLessThanOrEqual(100);
    expect(ppr.warning).toContain("Europe PMC has no open-access full text for PPR123456");

    const china: Article = { ...preprint, id: "chinaxiv-202401.00027", database: "chinaxiv", machineTranslated: true, originalUrl: "https://chinaxiv.org/abs/202401.00027" };
    const cn = await fetchFulltext({ id: china.id, maxChars: 100 }, new LRUBackend(), fakeClient(), {
      adapter: (database) => (database === "chinaxiv" ? { fetch: async () => [], fetchFull: async () => [china], fetchText: async () => null } : undefined),
    });
    expect(cn).toMatchObject({ source: "none", truncated: true, totalChars: LONG_ABSTRACT.length });
    expect(cn.fulltext!.length).toBeLessThanOrEqual(100);
    expect(cn.warning).toContain("literature_fetch returns it whole.");
    expect(cn.warning).toContain("ChinaRxiv has no text for this record.");
    expect(cn.warning).toContain("Machine translation into English by ChinaRxiv");
  });
});

describe("ids that name no article are NOT_FOUND", () => {
  /** A stand-in for ChinaRxiv's adapters: `/text` answers `answer` (an Error is thrown), the record is `record`. */
  function fakeChinaRxiv(answer: string | null | Error, record?: Article) {
    const fetchText = vi.fn(async () => {
      if (answer instanceof Error) throw answer;
      return answer;
    });
    const adapter: FulltextDeps["adapter"] = (database) =>
      database === "europepmc" ? undefined : { fetch: async () => [], fetchFull: async () => (record ? [record] : []), fetchText };
    return { fetchText, adapter };
  }
  const CN_RECORD: Article = { ...ARTICLE, id: "chinaxiv-202401.00027", doi: undefined, database: "chinaxiv", machineTranslated: true, abstract: "The record's abstract." };

  describe("ChinaXiv and RussiaRxiv ids that ChinaRxiv answers 404 for", () => {
    for (const id of ["chinaxiv-209912.99999", "ru-000001.1"]) {
      it(`${id} is NOT_FOUND, not "couldn't be reached"`, async () => {
        const china = fakeChinaRxiv(errors.notFound(id, "ChinaRxiv"));
        const rejection = await fetchFulltext({ id }, new LRUBackend(), fakeClient(), { adapter: china.adapter }).catch((e: unknown) => e);
        expect(rejection).toMatchObject({ code: "NOT_FOUND", recoverable: false });
        expect((rejection as Error).message).toContain(id);
        expect(rejection).toMatchObject({ userMessage: expect.stringContaining(`ChinaRxiv has no record of "${id}"`) });
        expect(china.fetchText).toHaveBeenCalledWith(id);
      });
    }

    it("is found through the adapter's own HTTP layer: a 404 from the API is NOT_FOUND, with no retry", async () => {
      const requested: string[] = [];
      vi.stubGlobal("fetch", async (url: unknown) => {
        requested.push(String(url));
        return new Response("not found", { status: 404 });
      });
      const adapter = new ChinaRXivAdapter();
      await expect(
        fetchFulltext({ id: "chinaxiv-209912.99999" }, new LRUBackend(), fakeClient(), { adapter: (d) => (d === "chinaxiv" ? adapter : undefined) }),
      ).rejects.toMatchObject({ code: "NOT_FOUND" });
      // One request, not retried, and no record lookup after it: nothing is left to say about an id it doesn't know.
      expect(requested).toEqual(["https://chinarxiv.org/api/v1/papers/chinaxiv-209912.99999/text"]);
    });

    it("stays a warning when the id is known but the request failed: a refused request, a server error, a dropped connection", async () => {
      for (const failure of [errors.network("ChinaRxiv returned HTTP 403", 403), errors.network("ChinaRxiv returned HTTP 503 (attempt 3)", 503), new TypeError("fetch failed")]) {
        const out = await fetchFulltext({ id: CN_RECORD.id }, new LRUBackend(), fakeClient(), { adapter: fakeChinaRxiv(failure, CN_RECORD).adapter });
        expect(out).toMatchObject({ source: "none", fulltext: "The record's abstract." });
        expect(out.warning).toContain("ChinaRxiv couldn't be reached.");
      }
    });

    it("goes on to the DOI routes when a DOI was given, and names the 404 if they have no text either", async () => {
      const out = await fetchFulltext({ id: "chinaxiv-209912.99999", doi: DOI }, new LRUBackend(), fakeClient(), {
        adapter: fakeChinaRxiv(errors.notFound("chinaxiv-209912.99999", "ChinaRxiv")).adapter,
        unpaywall: noCopy,
        fetchUrl: paywalled,
      });
      expect(out).toMatchObject({ source: "none", doi: DOI });
      expect(out.warning).toContain("ChinaRxiv has no such page (HTTP 404).");
    });

    it("a record that has no text is still its abstract", async () => {
      const out = await fetchFulltext({ id: CN_RECORD.id }, new LRUBackend(), fakeClient(), { adapter: fakeChinaRxiv(null, CN_RECORD).adapter });
      expect(out).toMatchObject({ source: "none", fulltext: "The record's abstract." });
      expect(out.warning).toContain("ChinaRxiv has no text for this record.");
    });
  });

  describe("PMCIDs and preprint ids that Europe PMC has neither text nor record of", () => {
    for (const id of ["PMC999999999", "pmc999999999", "PPR999999999"]) {
      it(`${id} is NOT_FOUND, not a missing open-access text`, async () => {
        const europePmc = fakeEuropePmc();
        const rejection = await fetchFulltext({ id }, new LRUBackend(), fakeClient(), { fetchUrl: europePmcWithoutText, adapter: europePmc.adapter }).catch((e: unknown) => e);
        expect(rejection).toMatchObject({ code: "NOT_FOUND", recoverable: false });
        expect(rejection).toMatchObject({ userMessage: expect.stringContaining(`Europe PMC has no record of "${id}"`) });
        expect(europePmc.find).toHaveBeenCalledWith(id.toUpperCase(), expect.anything());
      });
    }

    it("is NOT_FOUND whatever the full-text request answered, as no status tells an unknown id from a real one without text", async () => {
      // Europe PMC answered HTTP 500 for both PMC999999999 (unknown) and PMC6181682 (real, no open-access text) on 2026-11-27.
      const unreachable = async (): Promise<FetchedResource> => {
        throw new TypeError("fetch failed");
      };
      for (const fetchUrl of [status(404), status(500), status(503), status(429), unreachable]) {
        await expect(fetchFulltext({ id: "PMC999999999" }, new LRUBackend(), fakeClient(), { fetchUrl, adapter: fakeEuropePmc().adapter })).rejects.toMatchObject({
          code: "NOT_FOUND",
        });
      }
    });

    it("a real one without open-access text still gets its abstract", async () => {
      const record: Article = { ...ARTICLE, id: "PMC6181682", doi: undefined, database: "europepmc", abstract: "The record's abstract." };
      const out = await fetchFulltext({ id: "PMC6181682" }, new LRUBackend(), fakeClient(), { fetchUrl: europePmcWithoutText, adapter: fakeEuropePmc([record]).adapter });
      expect(out).toMatchObject({ source: "none", fulltext: "The record's abstract." });
      expect(out.warning).toContain("Europe PMC has no open-access full text for PMC6181682.");
      // So does one whose record has no abstract: it exists.
      const bare = await fetchFulltext({ id: "PMC6181682" }, new LRUBackend(), fakeClient(), {
        fetchUrl: europePmcWithoutText,
        adapter: fakeEuropePmc([{ ...record, abstract: undefined }]).adapter,
      });
      expect(bare.source).toBe("none");
      expect(bare.warning).toContain("No full text found, and no abstract is available.");
    });

    it("a real one without text gets its abstract whatever the full-text request answered", async () => {
      const record: Article = { ...ARTICLE, id: "PMC6181682", doi: undefined, database: "europepmc", abstract: "The record's abstract." };
      for (const fetchUrl of [status(404), status(500)]) {
        const out = await fetchFulltext({ id: "PMC6181682" }, new LRUBackend(), fakeClient(), { fetchUrl, adapter: fakeEuropePmc([record]).adapter });
        expect(out).toMatchObject({ source: "none", fulltext: "The record's abstract." });
      }
    });

    it("stays a warning when the record lookup could not answer: the request failed, or the adapter can't tell failure from no record", async () => {
      const cantTell: FulltextDeps["adapter"] = () => ({ fetch: async () => [] });
      for (const adapter of [fakeEuropePmc([], new Error("Europe PMC is down")).adapter, cantTell, () => undefined] satisfies FulltextDeps["adapter"][]) {
        const out = await fetchFulltext({ id: "PMC999999999" }, new LRUBackend(), fakeClient(), { fetchUrl: europePmcWithoutText, adapter });
        expect(out.source).toBe("none");
        expect(out.fulltext).toBeUndefined();
        expect(out.warning).toContain("No full text found, and no abstract is available. Europe PMC has no open-access full text for PMC999999999.");
      }
    });

    it("uses the record the second lookup finds, for the abstract and the standing, when the first failed", async () => {
      const record: Article = { ...ARTICLE, id: "PMC6181682", doi: undefined, database: "europepmc", publicationTypes: ["Retracted Publication"], abstract: "The record's abstract." };
      const find = vi.fn(async () => record);
      const cache = new LRUBackend();
      const out = await fetchFulltext({ id: "PMC6181682" }, cache, fakeClient(), { fetchUrl: europePmcWithoutText, adapter: () => ({ fetch: async () => [], find }) });
      expect(out).toMatchObject({ source: "none", fulltext: "The record's abstract." });
      expect(out.warning).toMatch(/^RETRACTED: .* No full text found; returned the abstract only\. Europe PMC has no open-access full text for PMC6181682\./);
      // Kept for the next call, as the first lookup's record would have been.
      expect(cache.getSummary("PMC6181682")).toMatchObject({ abstract: "The record's abstract." });
    });

    it("leaves a DOI that was given to the routes that use it", async () => {
      const out = await fetchFulltext({ id: "PMC999999999", doi: DOI }, new LRUBackend(), fakeClient(), {
        fetchUrl: europePmcWithoutText,
        unpaywall: noCopy,
        adapter: fakeEuropePmc().adapter,
      });
      expect(out).toMatchObject({ source: "none", doi: DOI });
    });
  });
});

describe("a PMCID against the real Europe PMC adapter, whose fetch counts a failed request as no record", () => {
  const FOUND = { hitCount: 1, resultList: { result: [{ id: "30283138", source: "MED", pmcid: "PMC6181682", title: "A paper", abstractText: "The record's abstract.", pubType: "Journal Article" }] } };
  const NONE = { hitCount: 0, resultList: { result: [] } };
  const over = (json: AdapterHttp["json"]): AdapterHttp => ({ json, text: async () => "" });
  const run = (id: string, adapter: EuropePmcAdapter, fetchUrl = status(500)) =>
    fetchFulltext({ id }, new LRUBackend(), fakeClient(), { fetchUrl, adapter: (database) => (database === "europepmc" ? adapter : undefined) });

  it("is NOT_FOUND only when Europe PMC answers that it has no record, and gets its abstract when it has one", async () => {
    await expect(run("PMC999999999", new EuropePmcAdapter(over(async <T>() => NONE as T)))).rejects.toMatchObject({ code: "NOT_FOUND" });
    const out = await run("PMC6181682", new EuropePmcAdapter(over(async <T>() => FOUND as T)));
    expect(out).toMatchObject({ source: "none", fulltext: "The record's abstract." });
  });

  it("stays the fallback, not NOT_FOUND, whatever fails the lookup: a 503, a rate limit, a timeout, a dropped connection", async () => {
    for (const failure of [
      errors.network("Europe PMC returned HTTP 503 (attempt 3)", 503),
      errors.rateLimit(60, "Europe PMC"),
      errors.network("Europe PMC didn't answer within 15 s"),
      errors.network("fetch failed"),
      errors.outOfTime("Europe PMC"),
    ]) {
      const out = await run("PMC6181682", new EuropePmcAdapter(over(async () => Promise.reject(failure))));
      expect(out.source, failure.message).toBe("none");
      expect(out.warning).toContain("No full text found, and no abstract is available. Europe PMC has no open-access full text for PMC6181682.");
    }
  });

  it("finds the record on the second lookup when the first failed", async () => {
    const json = vi.fn(async <T>(): Promise<T> => FOUND as T).mockRejectedValueOnce(errors.network("Europe PMC returned HTTP 503", 503));
    const out = await run("PMC6181682", new EuropePmcAdapter(over(json)));
    expect(out).toMatchObject({ source: "none", fulltext: "The record's abstract." });
    expect(json).toHaveBeenCalledTimes(2);
  });

  it("stays the fallback through the HTTP layer itself: a 429 it won't wait for, and a 503 it retries to the end", async () => {
    vi.stubGlobal("fetch", async () => new Response("", { status: 429, headers: { "retry-after": "60" } }));
    const limited = await run("PMC6181682", new EuropePmcAdapter());
    expect(limited.source).toBe("none");
    vi.useFakeTimers();
    vi.stubGlobal("fetch", async () => new Response("", { status: 503 }));
    const pending = run("PMC6181682", new EuropePmcAdapter());
    await vi.advanceTimersByTimeAsync(30_000);
    const down = await pending;
    expect(down.source).toBe("none");
    expect(down.warning).toContain("No full text found, and no abstract is available.");
  });
});

describe("errors.notFound", () => {
  it("says PMID for a PMID, as it did, and names the database for another id", () => {
    expect(errors.notFound("99999999")).toMatchObject({
      code: "NOT_FOUND",
      message: "PMID 99999999 not found",
      userMessage: "No PubMed article found for PMID 99999999. Check the identifier.",
    });
    const other = errors.notFound("PMC999999999", "Europe PMC");
    expect(other).toMatchObject({ code: "NOT_FOUND", recoverable: false, message: "Europe PMC has no record PMC999999999" });
    expect(other.userMessage).toBe('Europe PMC has no record of "PMC999999999". Check the identifier: pass the id of a literature_search result exactly as it gave it.');
  });
});
