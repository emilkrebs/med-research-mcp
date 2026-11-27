import { describe, it, expect, vi, afterEach } from "vitest";
import { NcbiClient, searchPubMed } from "../src/core/pubmed";
import { PubMedAdapter } from "../src/core/adapters/pubmed";
import type { DatabaseAdapter } from "../src/core/adapters/types";
import { searchLiterature, resetProbeAllowance } from "../src/core/literature";
import { LRUBackend } from "../src/core/cache";
import { designPublicationTypes } from "../src/core/grader";
import type { SearchInput } from "../src/core/types";

/** The way esearch ran into a term it can't read, as it answered on 2026-11-27 (an HTTP 200 with the error at the top level). */
const WRAPPED = "Search Backend failed: An error occurred while processing request. Status: 500. Source: /api/search/?r= Details: Search is temporarily unavailable. Please try again later. Details: ";

const esearchJson = (count: number, idlist: string[], extra: Record<string, unknown> = {}): Response =>
  new Response(JSON.stringify({ esearchresult: { count: String(count), idlist, ...extra } }), { status: 200 });
const range = (from: number, to: number): string[] => Array.from({ length: to - from + 1 }, (_, i) => String(from + i));
/** An API key lifts the request pacing from 3 to 10 a second. */
const quick = (config: { broadThreshold?: number } = {}) => new NcbiClient({ email: "test@example.com", apiKey: "test-key", ...config });
const sentTerm = (mock: { mock: { calls: unknown[][] } }, call = 0): string | null =>
  new URL(String(mock.mock.calls[call]![0])).searchParams.get("term");

/** A PubMed answering esearch with `esearch(term)`, esummary with one record per id, and efetch with no abstracts. */
function pubmed(esearch: (term: string, retmax: number) => Response) {
  const fetchMock = vi.fn(async (input: string | URL | Request) => {
    const url = new URL(String(input));
    if (url.pathname.endsWith("esearch.fcgi")) return esearch(url.searchParams.get("term") ?? "", Number(url.searchParams.get("retmax")));
    if (url.pathname.endsWith("esummary.fcgi")) {
      const ids = (url.searchParams.get("id") ?? "").split(",");
      const docs = Object.fromEntries(ids.map((uid) => [uid, { uid, title: `Record ${uid}.`, fulljournalname: "J Test", pubdate: "2024", authors: [], pubtype: ["Journal Article"] }]));
      return new Response(JSON.stringify({ result: { uids: ids, ...docs } }), { status: 200 });
    }
    return new Response("<PubmedArticleSet></PubmedArticleSet>", { status: 200 });
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

// "diabetes" matched 1,156,395 records (2026-11-27) and was refused, in every database selection that held PubMed.
describe("a broad PubMed query is served, with a warning", () => {
  it("returns the page of a query over 100,000 records, with a warning that names the count and how to narrow", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => esearchJson(1_156_395, range(1, 10))));
    const out = await quick().esearch({ query: "diabetes" });
    expect(out).toMatchObject({ count: 1_156_395, pmids: range(1, 10), more: true });
    expect(out.warning).toBe(
      "PubMed matched 1,156,395 records, so the query is broad: it serves only the first 9,999 of them, and the rest can't be reached. " +
        "Narrow it with [tiab] or [mesh] field tags, more specific terms or AND clauses, a dateRange or a studyTypes filter.",
    );
  });

  it("warns above 10,000 records and says nothing at 10,000 or fewer", async () => {
    for (const [count, warned] of [[9_999, false], [10_000, false], [10_001, true]] as const) {
      vi.stubGlobal("fetch", vi.fn(async () => esearchJson(count, range(1, 10))));
      const { warning } = await quick().esearch({ query: `x${count}` });
      expect(warning !== undefined, String(count)).toBe(warned);
    }
  });

  it("keeps the warning on every page of a broad search, and gives way to the cap's own on the last one", async () => {
    vi.stubGlobal("fetch", vi.fn(async (input: string | URL | Request) => {
      const params = new URL(String(input)).searchParams;
      const start = Number(params.get("retstart") ?? 0);
      return esearchJson(50_000, range(start + 1, start + Number(params.get("retmax"))));
    }));
    const client = quick();
    expect((await client.esearch({ query: "x", page: 1 })).warning).toMatch(/^PubMed matched 50,000 records/);
    expect((await client.esearch({ query: "x", page: 2 })).warning).toMatch(/^PubMed matched 50,000 records/);
    const last = await client.esearch({ query: "x", maxResults: 50, page: 200 });
    expect(last.warning).toMatch(/^PubMed serves only the first 9,999 records of a search/);
    expect(last.warning).not.toContain("PubMed matched");
  });

  it("still throws QUERY_TOO_BROAD where the client is given a broadThreshold, for a count over it only", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => esearchJson(1_156_395, range(1, 10))));
    await expect(quick({ broadThreshold: 100_000 }).esearch({ query: "diabetes" })).rejects.toMatchObject({
      code: "QUERY_TOO_BROAD",
      message: "Query matched 1156395 results",
      recoverable: true,
    });
    vi.stubGlobal("fetch", vi.fn(async () => esearchJson(100_000, range(1, 10))));
    expect((await quick({ broadThreshold: 100_000 }).esearch({ query: "diabetes" })).count).toBe(100_000);
    // Zero is a threshold too, not a missing one.
    await expect(quick({ broadThreshold: 0 }).esearch({ query: "diabetes" })).rejects.toMatchObject({ code: "QUERY_TOO_BROAD" });
  });

  it("serves the standalone search's records with the warning once", async () => {
    pubmed(() => esearchJson(1_156_395, range(1, 3)));
    const out = await searchPubMed({ query: "diabetes", maxResults: 3 }, new LRUBackend(), quick());
    expect(out.total).toBe(1_156_395);
    expect(out.articles.map((a) => a.id)).toEqual(["1", "2", "3"]);
    expect(out.warnings?.filter((w) => w.startsWith("PubMed matched 1,156,395 records"))).toHaveLength(1);
  });

  it("serves literature_search's PubMed search, alone and beside another database, with the warning", async () => {
    pubmed(() => esearchJson(1_156_395, range(1, 2)));
    const adapter = new PubMedAdapter(quick());
    const alone = await searchLiterature({ query: "diabetes", database: "pubmed", maxResults: 2 }, new LRUBackend(), [adapter]);
    expect(alone.total).toBe(1_156_395);
    expect(alone.articles.map((a) => a.id)).toEqual(["1", "2"]);
    expect(alone.warnings).toEqual([expect.stringMatching(/^PubMed matched 1,156,395 records, so the query is broad/)]);

    const other: DatabaseAdapter = {
      id: "europepmc",
      name: "Europe PMC",
      search: async () => ({ count: 0, ids: [] }),
      fetch: async () => [],
    };
    const both = await searchLiterature({ query: "diabetes", database: ["pubmed", "europepmc"], maxResults: 2 }, new LRUBackend(), [adapter, other]);
    expect(both.articles).toHaveLength(2);
    expect(both.totalByDatabase).toEqual({ pubmed: 1_156_395, europepmc: 0 });
    // Not "PubMed / NCBI search failed: … too broad", as 0.8.1 said.
    expect(both.warnings?.some((w) => /search failed|too broad/.test(w))).toBe(false);
  });

  it("reads the count of a word-probe from a broad PubMed answer, which no longer arrives as an error", async () => {
    resetProbeAllowance();
    // "cancer chemotherapy quokka" finds nothing; without "quokka", the two words find 373,618 records (a count 0.8.1 read from the error).
    pubmed((term) => (term === "cancer chemotherapy" ? esearchJson(373_618, ["1"]) : esearchJson(0, [])));
    const out = await searchLiterature({ query: "cancer chemotherapy quokka", database: "pubmed" }, new LRUBackend(), [new PubMedAdapter(quick())]);
    expect(out.total).toBe(0);
    expect(out.warnings).toEqual(['Without "quokka" the query matches 373,618 records in PubMed.']);
  });
});

// `()` and a lone `"` reached esearch, whose "Search is temporarily unavailable. Please try again later" was read as an outage.
describe("a query with nothing to search", () => {
  const search = (input: SearchInput, adapters?: DatabaseAdapter[]) => searchLiterature(input, new LRUBackend(), adapters);
  /** An adapter that fails the test if it is asked anything. */
  const untouched = (id = "pubmed") => ({
    id,
    name: id,
    search: vi.fn(async () => ({ count: 0, ids: [] as string[] })),
    fetch: vi.fn(async () => []),
  });

  it("is refused as INVALID_INPUT, before any database is asked, when it holds no letter or digit", async () => {
    for (const query of ["()", '"', "((", ")(", '""', "()()", "( )", "*", "-", "[]", "!!!", "...", '" "', "&& ()", "💊", "+-"]) {
      const adapter = untouched();
      const error = await search({ query }, [adapter]).catch((e: unknown) => e);
      expect(error, query).toMatchObject({ code: "INVALID_INPUT", recoverable: true });
      expect((error as { userMessage: string }).userMessage, query).toContain("no letter or digit");
      expect((error as { userMessage: string }).userMessage, query).toContain("Send words or a quoted phrase");
      expect(adapter.search, query).not.toHaveBeenCalled();
    }
  });

  it("is refused alone, with a design filter (which matched `()` against every clinical trial) and over several databases", async () => {
    const [pubmedAdapter, europe] = [untouched("pubmed"), untouched("europepmc")];
    await expect(search({ query: "()", database: ["pubmed", "europepmc"], minDesignTier: 2 }, [pubmedAdapter, europe])).rejects.toMatchObject({
      code: "INVALID_INPUT",
    });
    await expect(search({ query: '"', studyTypes: ["clinical-trial"] }, [pubmedAdapter])).rejects.toMatchObject({ code: "INVALID_INPUT" });
    expect(pubmedAdapter.search).not.toHaveBeenCalled();
    expect(europe.search).not.toHaveBeenCalled();
  });

  it("is still refused as an empty query when it is blank", async () => {
    await expect(search({ query: "   " }, [untouched()])).rejects.toMatchObject({ code: "INVALID_INPUT", userMessage: "The query is empty." });
  });

  it("lets a query that works today through: unbalanced brackets and quotes round words, AND alone, emoji beside words, other scripts", async () => {
    for (const query of ["diabetes)", "(diabetes", '"diabetes', 'diabetes"', "diabetes[", "AND", "OR", "💊 aspirin", "aspirin 💊", "阿司匹林", "Привет", "5", "COVID-19", "[tiab]", "()[tiab]", "(AND)", "٣"]) {
      const adapter = untouched();
      await expect(search({ query }, [adapter]), query).resolves.toBeDefined();
      // At least once: a two-word query that finds nothing is probed word by word.
      expect(adapter.search, query).toHaveBeenCalled();
    }
  });

  it("maps esearch's 'Empty Term' and parser errors to INVALID_INPUT, from either place esearch puts them", async () => {
    for (const [message, shape] of [
      ["Empty Term in the request", "top"],
      ["Empty Term in the request", "inner"],
      ["begin 1, end 0, length 1", "top"],
      ["begin 1, end 0, length 1", "inner"],
      ["Empty term and query_key - nothing todo", "top"],
    ] as const) {
      const body = shape === "top" ? { ERROR: `${WRAPPED}${message}` } : { esearchresult: { ERROR: `${WRAPPED}${message}` } };
      vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify(body), { status: 200 })));
      const error = await quick().esearch({ query: "()" }).catch((e: unknown) => e);
      expect(error, message).toMatchObject({ code: "INVALID_INPUT", recoverable: true });
      const { userMessage } = error as { userMessage: string };
      // What PubMed said, that it is no outage, and what to send.
      expect(userMessage).toContain(`it said "${message}"`);
      expect(userMessage).toContain("not an outage");
      expect(userMessage).toContain('"sleep apnea" AND tirzepatide');
      expect(userMessage).not.toMatch(/temporarily unavailable/);
    }
  });

  it("reaches the standalone search and literature_search's PubMed adapter as INVALID_INPUT", async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ ERROR: `${WRAPPED}begin 1, end 0, length 1` }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    await expect(searchPubMed({ query: '"' }, new LRUBackend(), quick())).rejects.toMatchObject({ code: "INVALID_INPUT" });
    await expect(new PubMedAdapter(quick()).search({ query: '"' })).rejects.toMatchObject({ code: "INVALID_INPUT" });
    // Not retried: esearch answered 200, and the error is the query's.
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("keeps any other esearch error the PARSE_FAILURE it was, and a real backend failure recoverable", async () => {
    for (const message of [
      "boom",
      "Search Backend failed: An error occurred while processing request. Status: 500. Source: /api/search/?r= Details: Search is temporarily unavailable. Please try again later.",
      `${WRAPPED}Connection refused`,
      "Search Backend failed: An error occurred while processing request. Status: 503.",
      "Invalid db name specified: nonsense",
    ]) {
      for (const body of [{ ERROR: message }, { esearchresult: { ERROR: message } }]) {
        vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify(body), { status: 200 })));
        await expect(quick().esearch({ query: "diabetes" }), message).rejects.toMatchObject({ code: "PARSE_FAILURE", recoverable: true });
      }
    }
  });

  it("raises the mapped error, not a warning, when PubMed is the only database searched and fails on a query that has a letter", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ ERROR: `${WRAPPED}Empty Term in the request` }), { status: 200 })));
    await expect(searchLiterature({ query: "a", database: "pubmed" }, new LRUBackend(), [new PubMedAdapter(quick())])).rejects.toMatchObject({
      code: "INVALID_INPUT",
    });
  });
});

// The server's own trial clause held "Human Challenge Trials"[pt], for which PubMed has no phrase (0 records, 2026-11-27): every
// search with a design filter said so, naming a phrase the caller never typed.
describe("phrases the server added to a PubMed query", () => {
  const HCT = '"Human Challenge Trials"[pt]';
  /** An esearch answer for `tirzepatide apnea` and a design filter, which names the phrases PubMed has none for. */
  const answer = (quoted: string[], count = 11): Response =>
    esearchJson(count, range(1, 3), {
      querytranslation: '("tirzepatide"[All Fields]) AND ("apnea"[All Fields]) AND ("Clinical Trial"[Publication Type])',
      warninglist: { phrasesignored: [], quotedphrasesnotfound: quoted, outputmessages: [] },
    });
  const warningOf = async (input: SearchInput, quoted: string[]): Promise<string | undefined> => {
    vi.stubGlobal("fetch", vi.fn(async () => answer(quoted)));
    return (await quick().esearch(input)).warning;
  };

  it("still sends the trial clause with the phrase, so the filter keeps a record that carries only that type", async () => {
    const fetchMock = vi.fn(async () => answer([HCT]));
    vi.stubGlobal("fetch", fetchMock);
    await quick().esearch({ query: "tirzepatide apnea", minDesignTier: 2 });
    expect(sentTerm(fetchMock)).toContain(HCT);
    expect(designPublicationTypes(["clinical-trial"])).toContain("Human Challenge Trials");
  });

  it("says nothing of the phrase for a minDesignTier of 2 or lower, or a trial studyType", async () => {
    expect(await warningOf({ query: "tirzepatide apnea", minDesignTier: 2, maxResults: 1 }, [HCT])).toBeUndefined();
    expect(await warningOf({ query: "tirzepatide apnea", minDesignTier: 1 }, [HCT])).toBeUndefined();
    expect(await warningOf({ query: "tirzepatide apnea", studyTypes: ["clinical-trial"] }, [HCT])).toBeUndefined();
    expect(await warningOf({ query: "tirzepatide apnea", studyTypes: ["clinical-trial", "review"] }, [HCT])).toBeUndefined();
    // However esearch writes the phrase: with the tag as the caller typed it, or in another case.
    expect(await warningOf({ query: "tirzepatide apnea", minDesignTier: 2 }, ['"human challenge trials"[pt]'])).toBeUndefined();
  });

  it("says nothing of it for the filter's phrase on every page, and on a repeated search from the cache", async () => {
    const fetchMock = vi.fn(async () => answer([HCT]));
    vi.stubGlobal("fetch", fetchMock);
    const client = quick();
    for (const page of [1, 2, 1]) expect((await client.esearch({ query: "tirzepatide apnea", minDesignTier: 2, maxResults: 1, page })).warning).toBeUndefined();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("still reports the caller's own unknown phrase, and names only that one", async () => {
    expect(await warningOf({ query: 'tirzepatide "qzx wrt"', minDesignTier: 2 }, ['"qzx wrt"', HCT])).toBe(
      'PubMed has no phrase "qzx wrt", so it searched the words separately: a record need not hold them together.',
    );
    expect(await warningOf({ query: 'tirzepatide "qzx wrt"', minDesignTier: 2 }, [HCT, '"qzx wrt"'])).toContain('"qzx wrt"');
    expect(await warningOf({ query: 'tirzepatide "qzx wrt"', minDesignTier: 2 }, [HCT, '"qzx wrt"'])).not.toContain("Human Challenge");
  });

  it("reports the phrase when the caller typed it, with or without a design filter", async () => {
    const own = 'PubMed has no phrase "Human Challenge Trials", so it searched the words separately: a record need not hold them together.';
    expect(await warningOf({ query: '"Human Challenge Trials"' }, ['"Human Challenge Trials"'])).toBe(own);
    expect(await warningOf({ query: 'tirzepatide "human challenge trials"[pt]' }, ['"human challenge trials"[pt]'])).toBe(
      'PubMed has no phrase "human challenge trials", so it searched the words separately: a record need not hold them together.',
    );
    // The same words in the query, and the filter's clause too: the caller's phrase counts.
    expect(await warningOf({ query: '"Human Challenge Trials"', minDesignTier: 2 }, ['"Human Challenge Trials"', HCT])).toBe(own);
  });

  it("leaves the other unknown-term warnings of a filtered search as they were", async () => {
    vi.stubGlobal("fetch", vi.fn(async () =>
      esearchJson(11, range(1, 3), {
        querytranslation: '("tirzepatide"[All Fields]) AND ("Clinical Trial"[Publication Type])',
        errorlist: { phrasesnotfound: ["qzxvbnmk"], fieldsnotfound: [] },
        warninglist: { phrasesignored: [], quotedphrasesnotfound: [HCT], outputmessages: [] },
      })));
    expect((await quick().esearch({ query: "tirzepatide qzxvbnmk", minDesignTier: 2 })).warning).toBe(
      'PubMed ignored "qzxvbnmk": no record contains it, so it searched without it.',
    );
  });

  it("does not suppress a phrase when there is no design filter to have added it", async () => {
    // The query has the words only as a caller's phrase; the same esearch answer without a filter is the caller's.
    expect(await warningOf({ query: "tirzepatide apnea" }, ['"Human Challenge Trials"[pt]'])).toMatch(/^PubMed has no phrase "Human Challenge Trials"/);
  });
});
