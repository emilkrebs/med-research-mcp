import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fetchFulltext, type FetchedResource, type FulltextDeps } from "../src/core/fulltext";
import { LRUBackend } from "../src/core/cache";
import type { NcbiClient } from "../src/core/pubmed";
import type { UnpaywallClient } from "../src/core/unpaywall";
import type { Article } from "../src/core/types";

/**
 * A DOI given with an id that no record confirms is flagged by the DOI's own record, whatever the id looks like, also on
 * the abstract fallback (#51); and a fallback for a record without a DOI says that Unpaywall and the publisher's site
 * were not tried, with the record's url when it has one (#41). Every network seam is a stand-in.
 */

const DOI = "10.3389/fneur.2024.1391448";
const DOI_NOTICE = "42707607";
const RETRACTED_START = 'RETRACTED: this record is flagged "retracted" (as in literature_search): do not use its findings as evidence.';
const NO_ID = "99999999";
const PMID = "16060722";
const PMC = "PMC1182327";

/** As Europe PMC's `core` search returns the record of a DOI: the retraction in its types and links. */
const retractedByDoi: Article = {
  id: "38711552",
  title: "RETRACTED: Critical review of the evidence for Vojta Therapy",
  authors: ["Doe J"],
  journal: "Front Neurol",
  pubDate: "2024",
  doi: DOI,
  database: "europepmc",
  publicationTypes: ["Retracted Publication", "Systematic Review", "Journal Article"],
  corrections: [{ type: "RetractionIn", id: DOI_NOTICE }],
  abstract: "The DOI's abstract.",
};
/** A record with no flag: PubMed's or Europe PMC's, with the given id, PMCID and DOI. */
const plain = (id: string, extra: Partial<Article> = {}): Article => ({
  id,
  title: "Why most published research findings are false",
  authors: ["Ioannidis J"],
  journal: "PLoS Med",
  pubDate: "2005",
  publicationTypes: ["Journal Article"],
  abstract: "The record's abstract.",
  ...extra,
});

const strayRequests: string[] = [];
beforeEach(() => {
  strayRequests.length = 0;
  vi.stubGlobal("fetch", async (url: unknown) => {
    strayRequests.push(String(url));
    throw new Error("no network in tests");
  });
});
afterEach(() => {
  vi.unstubAllGlobals();
  expect(strayRequests).toEqual([]);
});

/** The NCBI client: esummary answers from `records`, or fails when `down`; efetch has no abstract of its own. */
function pubmed(records: Article[], options: { down?: boolean } = {}) {
  const esummary = vi.fn(async (pmids: string[]) => {
    if (options.down) throw new Error("NCBI is down");
    return new Map(records.filter((r) => pmids.includes(r.id)).map((r) => [r.id, r] as const));
  });
  const efetch = vi.fn(async (pmids: string[]) => new Map([[pmids[0]!, { publicationTypes: [], meshHeadings: [], corrections: [] }]]));
  return { client: { tool: "med-research-mcp", esummary, efetch } as unknown as NcbiClient, esummary };
}

/** Europe PMC's adapter: the record of a DOI from `byDoi`, of an id from `byId`, and nothing else. */
function europePmc(byDoi: Article[] = [], byId: Article[] = []) {
  const fetchByDoi = vi.fn(async (doi: string) => byDoi.find((r) => r.doi?.toLowerCase() === doi.toLowerCase()) ?? null);
  const adapter: FulltextDeps["adapter"] = () => ({
    fetch: async (ids: string[]) => byId.filter((r) => ids.includes(r.id)),
    fetchByDoi,
  });
  return { fetchByDoi, adapter };
}

/** An Unpaywall that has no open-access copy of any DOI. */
function unpaywall() {
  const lookup = vi.fn(async () => ({ status: "none" as const }));
  return { lookup, client: { lookup, sharedContact: false } as unknown as UnpaywallClient };
}

/** Every URL answers HTTP `code`; the full-text API of Europe PMC answers 404 (it has no text), unless `code` is given. */
function answering(code?: number) {
  const fetchUrl = vi.fn(
    async (url: string): Promise<FetchedResource> => ({ ok: false, status: code ?? (url.includes("ebi.ac.uk") ? 404 : 403), contentType: "text/html", finalUrl: url }),
  );
  return fetchUrl;
}
const requested = (fetchUrl: { mock: { calls: unknown[][] } }): string[] => fetchUrl.mock.calls.map(([url]) => String(url));

describe("the DOI's record speaks on the abstract fallback, whatever the id", () => {
  /** The calls of the issue's sequence: the DOI's record is looked up by one call and cached for the next. */
  const deps = (adapter: FulltextDeps["adapter"], fetchUrl = answering(403)): FulltextDeps => ({ unpaywall: unpaywall().client, fetchUrl, proxyPrefix: "", adapter });

  it("opens with RETRACTED for a numeric id that names no record, with the DOI's record already cached by an earlier call", async () => {
    const cache = new LRUBackend();
    const { client, esummary } = pubmed([]);
    const first = europePmc([retractedByDoi]);
    // An id of no recognised shape reads the DOI's record, which is kept...
    const junk = await fetchFulltext({ id: "weird-id-xyz", doi: DOI }, cache, client, deps(first.adapter));
    expect(junk.warning!.startsWith(RETRACTED_START)).toBe(true);
    expect(first.fetchByDoi).toHaveBeenCalledTimes(1);

    // ...so that a call whose Europe PMC can say nothing, and which has no time to wait for it, still has the warning.
    const second = europePmc();
    const out = await fetchFulltext({ id: NO_ID, doi: DOI }, cache, client, deps(second.adapter));
    expect(esummary).toHaveBeenCalledWith([NO_ID]);
    expect(out).toMatchObject({ source: "none", doi: DOI });
    expect(out.warning!.startsWith(`${RETRACTED_START} Linked notice: europepmc ${DOI_NOTICE} (literature_fetch).`)).toBe(true);
    expect(out.warning).toContain("No full text found, and no abstract is available.");
    expect(second.fetchByDoi).not.toHaveBeenCalled();
  });

  it("opens with RETRACTED for the same call on a cache that holds nothing: the DOI's record is looked up beside the routes", async () => {
    const { client } = pubmed([]);
    const { fetchByDoi, adapter } = europePmc([retractedByDoi]);
    const out = await fetchFulltext({ id: NO_ID, doi: DOI }, new LRUBackend(), client, deps(adapter));
    expect(out.source).toBe("none");
    expect(out.warning!.startsWith(`${RETRACTED_START} Linked notice: europepmc ${DOI_NOTICE} (literature_fetch).`)).toBe(true);
    expect(fetchByDoi).toHaveBeenCalledWith(DOI);
  });

  it("does the same for a PMID whose record can't be read, and for a PMCID whose record Europe PMC doesn't have", async () => {
    for (const [id, client] of [
      [PMID, pubmed([], { down: true }).client],
      [PMC, pubmed([]).client],
    ] as const) {
      const out = await fetchFulltext({ id, doi: DOI }, new LRUBackend(), client, deps(europePmc([retractedByDoi]).adapter, answering()));
      expect(out.source, id).toBe("none");
      expect(out.warning!.startsWith(RETRACTED_START), id).toBe(true);
    }
  });

  it("warns by the id's record and the DOI's, for an abstract whose record has no DOI to confirm the DOI given", async () => {
    // The abstract is the PMID's, and the routes that found no text were those of the DOI: each record that is flagged speaks.
    const own: Article = plain(PMID, { publicationTypes: ["Journal Article", "Retracted Publication"], corrections: [{ type: "RetractionIn", id: "11111111" }] });
    const out = await fetchFulltext({ id: PMID, doi: DOI }, new LRUBackend(), pubmed([own]).client, deps(europePmc([retractedByDoi]).adapter));
    expect(out).toMatchObject({ source: "none", fulltext: "The record's abstract." });
    expect(out.warning!.startsWith(RETRACTED_START)).toBe(true);
    expect(out.warning).toContain(`europepmc ${DOI_NOTICE}`);
    expect(out.warning).toContain("pubmed 11111111");
    // A record with no flag on either side adds nothing.
    const quiet = await fetchFulltext({ id: PMID, doi: DOI }, new LRUBackend(), pubmed([plain(PMID)]).client, deps(europePmc([{ ...retractedByDoi, title: "Critical review", publicationTypes: [], corrections: [] }]).adapter));
    expect(quiet.warning).not.toMatch(/RETRACTED|NOTICE|EXPRESSION/);
  });

  it("leaves the DOI's record out of the warning for a DOI the id's record confirms, and for the text of the id's PMCID", async () => {
    // The record has the DOI given: nothing is looked up by it, and a flag Europe PMC's record of the DOI might carry is the id's own.
    const confirmed = plain(PMID, { doi: DOI });
    const { fetchByDoi, adapter } = europePmc([retractedByDoi]);
    const out = await fetchFulltext({ id: PMID, doi: DOI }, new LRUBackend(), pubmed([confirmed]).client, deps(adapter));
    expect(out.source).toBe("none");
    expect(out.warning).not.toMatch(/RETRACTED/);
    expect(fetchByDoi).not.toHaveBeenCalled();

    // Europe PMC's text of a PMCID is the PMCID's article, not the DOI's, even when the DOI's record, flagged, is cached.
    const cache = new LRUBackend();
    const { client } = pubmed([]);
    await fetchFulltext({ id: "weird-id-xyz", doi: DOI }, cache, client, deps(europePmc([retractedByDoi]).adapter));
    const ofPmcid = europePmc([retractedByDoi], [plain(PMC)]);
    const text = await fetchFulltext({ id: PMC, doi: DOI }, cache, client, {
      ...deps(ofPmcid.adapter),
      fetchUrl: async (url: string) => ({ ok: true, status: 200, contentType: "application/xml", finalUrl: url, text: "<xml/>" }),
      jatsToMarkdown: async () => "# Text\n\n" + "content ".repeat(200),
    });
    expect(text.source).toBe("europepmc");
    expect(text.warning).toBeUndefined();
  });

  it("still refuses a DOI that is not the PMID's, as before", async () => {
    await expect(
      fetchFulltext({ id: PMID, doi: DOI }, new LRUBackend(), pubmed([plain(PMID, { doi: "10.1371/journal.pmed.0020124" })]).client, deps(europePmc([retractedByDoi]).adapter)),
    ).rejects.toMatchObject({ code: "INVALID_INPUT" });
  });
});

describe("a fallback for a record without a DOI says that the routes that go by a DOI were not tried", () => {
  it("names Unpaywall and the publisher's site for a PMID whose record has a PMCID and no DOI, and asks neither", async () => {
    const record = plain("22428439", { pmcid: "PMC6181682" });
    const { lookup, client } = unpaywall();
    const fetchUrl = answering();
    const out = await fetchFulltext({ id: "22428439" }, new LRUBackend(), pubmed([record]).client, { unpaywall: client, fetchUrl });
    expect(out).toMatchObject({ source: "none", fulltext: "The record's abstract." });
    expect(out).not.toHaveProperty("doi");
    expect(out.warning).toBe(
      "No full text found; returned the abstract only. Europe PMC has no open-access full text for PMC6181682. The record has no DOI, so Unpaywall and the publisher's site were not tried.",
    );
    expect(lookup).not.toHaveBeenCalled();
    expect(requested(fetchUrl)).toEqual(["https://www.ebi.ac.uk/europepmc/webservices/rest/PMC6181682/fullTextXML"]);
  });

  it("names the proxy too when one is configured, which goes by the DOI as well, and fetches none of them", async () => {
    const { client } = unpaywall();
    const fetchUrl = answering();
    const out = await fetchFulltext({ id: "22428439" }, new LRUBackend(), pubmed([plain("22428439", { pmcid: "PMC6181682" })]).client, {
      unpaywall: client,
      fetchUrl,
      proxyPrefix: "https://proxy.example",
    });
    expect(out.warning).toContain("The record has no DOI, so Unpaywall, the proxy and the publisher's site were not tried.");
    expect(requested(fetchUrl)).toHaveLength(1);
  });

  it("adds the record's url for an id of Europe PMC, as a place a browser may open, and does not fetch it", async () => {
    const url = "https://arxiv.org/abs/2007.09477v2";
    const record = plain("PPR270079", { database: "europepmc", url });
    const fetchUrl = answering();
    const out = await fetchFulltext({ id: "PPR270079" }, new LRUBackend(), pubmed([]).client, {
      unpaywall: unpaywall().client,
      fetchUrl,
      adapter: europePmc([], [record]).adapter,
    });
    expect(out).toMatchObject({ source: "none", fulltext: "The record's abstract." });
    expect(out.warning).toBe(
      `No full text found; returned the abstract only. Europe PMC has no open-access full text for PPR270079. The record has no DOI, so Unpaywall and the publisher's site were not tried. A browser may open ${url}.`,
    );
    expect(requested(fetchUrl)).toEqual(["https://www.ebi.ac.uk/europepmc/webservices/rest/PPR270079/fullTextXML"]);
  });

  it("leaves the url out when the record has none, and says nothing of it for a DOI that was tried", async () => {
    const none = await fetchFulltext({ id: "PPR270079" }, new LRUBackend(), pubmed([]).client, {
      unpaywall: unpaywall().client,
      fetchUrl: answering(),
      adapter: europePmc([], [plain("PPR270079", { database: "europepmc" })]).adapter,
    });
    expect(none.warning).toContain("so Unpaywall and the publisher's site were not tried.");
    expect(none.warning).not.toContain("A browser may open");

    // With a DOI the routes ran, and each says what it answered; nothing was skipped.
    const { lookup, client } = unpaywall();
    const tried = await fetchFulltext({ id: PMID }, new LRUBackend(), pubmed([plain(PMID, { doi: DOI, pmcid: PMC })]).client, { unpaywall: client, fetchUrl: answering() });
    expect(lookup).toHaveBeenCalled();
    expect(tried.warning).toContain("Unpaywall found no open-access copy");
    expect(tried.warning).not.toContain("no DOI");
  });

  it("says it for a ChinaXiv record, which has none, without offering its own page", async () => {
    const record: Article = { ...plain("chinaxiv-202401.00027"), database: "chinaxiv", machineTranslated: true, url: "https://chinarxiv.org/items/chinaxiv-202401.00027" };
    const out = await fetchFulltext({ id: record.id }, new LRUBackend(), pubmed([]).client, {
      adapter: (database) => (database === "chinaxiv" ? { fetch: async () => [], fetchFull: async () => [record], fetchText: async () => null } : undefined),
    });
    expect(out).toMatchObject({ source: "none", fulltext: "The record's abstract." });
    expect(out.warning).toContain("ChinaRxiv has no text for this record. The record has no DOI, so Unpaywall and the publisher's site were not tried. Machine translation");
    expect(out.warning).not.toContain("A browser may open");
  });
});
