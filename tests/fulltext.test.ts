import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { defaultJatsToMarkdown, fetchFulltext as fetchFulltextWith, fulltextCacheKey, STANDING_WAIT_MS, type FetchedResource, type FulltextDeps } from "../src/core/fulltext";
import { UnpaywallClient, type UnpaywallLookup, type UnpaywallResult } from "../src/core/unpaywall";
import { EuropePmcAdapter } from "../src/core/adapters/europepmc";
import { ChinaRXivAdapter } from "../src/core/adapters/chinarxiv";
import type { AdapterHttp } from "../src/core/adapters/http";
import { FULLTEXT_TTL_MS, LRUBackend, type Cache } from "../src/core/cache";
import { fetchPubMed, NcbiClient } from "../src/core/pubmed";
import { PROJECT_CONTACT_EMAIL } from "../src/core/version";
import { errors, ResearchApiException } from "../src/core/errors";
import { BlockedUrlError } from "../src/core/public-fetch";
import type { Article, Correction } from "../src/core/types";

const DOI = "10.1000/xyz123";

const ARTICLE: Article = {
  id: "12345678",
  title: "Creatine and cognition",
  authors: ["Doe J"],
  journal: "J Test",
  pubDate: "2021",
  doi: DOI,
  publicationTypes: ["Randomized Controlled Trial"],
  abstract: "Short cached abstract.",
};

/** Long enough to count as an article body (MIN_BODY_CHARS, 2000 characters besides the abstract). */
const LONG_MARKDOWN = "# Methods\n\n" + "word ".repeat(600);

/** A stand-in NCBI client. esummary/efetch are the only methods fetchFulltext touches. */
function fakeClient(
  opts: {
    summary?: Article | null;
    abstract?: string;
    /** What efetch adds to the summary, as the real one returns it. */
    efetched?: { publicationTypes?: string[]; meshHeadings?: string[]; corrections?: Correction[] };
    onEsummary?: () => void;
    onEfetch?: () => void;
    tool?: string;
  } = {},
): NcbiClient {
  return {
    tool: opts.tool ?? "med-research-mcp",
    esummary: async (pmids: string[]) => {
      opts.onEsummary?.();
      const m = new Map<string, Article>();
      if (opts.summary) m.set(pmids[0]!, opts.summary);
      return m;
    },
    efetch: async (pmids: string[]) => {
      opts.onEfetch?.();
      const m = new Map<string, unknown>();
      m.set(pmids[0]!, {
        ...(opts.abstract ? { abstract: opts.abstract } : {}),
        publicationTypes: opts.efetched?.publicationTypes ?? [],
        meshHeadings: opts.efetched?.meshHeadings ?? [],
        corrections: opts.efetched?.corrections ?? [],
      });
      return m;
    },
  } as unknown as NcbiClient;
}

function fakeUnpaywall(result: UnpaywallResult | null): UnpaywallClient {
  return answeringUnpaywall(result ? { status: "found", result } : { status: "none" });
}

function answeringUnpaywall(answer: UnpaywallLookup, sharedContact = false): UnpaywallClient {
  return { lookup: async () => answer, sharedContact } as unknown as UnpaywallClient;
}

/** No adapter for any database: a lookup of a record that PubMed doesn't know finds nothing. */
const noRecords: FulltextDeps["adapter"] = () => undefined;

/** A stand-in for the registry's Europe PMC adapter, answering by id from `records`. */
function fakeEuropePmc(records: Article[] = []) {
  const fetch = vi.fn(async (ids: string[]) => records.filter((r) => ids.includes(r.id)));
  const adapter: FulltextDeps["adapter"] = () => ({ fetch });
  return { fetch, adapter };
}

// The record lookups for ids PubMed doesn't know default to the registry's adapters, which use the
// network. A test that reaches one without injecting `adapter` fails here, instead of its request
// being swallowed as a failed lookup.
const strayRequests: string[] = [];

/**
 * What a test that injects no `adapter` gets: Europe PMC holds no record of any DOI (a DOI that no record of its id
 * confirms is looked up there, which many of these tests, given a PMID with its DOI and no summary, cause without caring
 * for the answer), and a lookup of an id is recorded as a stray request, as the registry's adapters' would be.
 */
const defaultAdapter: FulltextDeps["adapter"] = (database) => ({
  fetch: async (ids: string[]) => {
    strayRequests.push(`${database} lookup of ${ids.join(", ")}`);
    return [];
  },
});

/** `fetchFulltext`, with `defaultAdapter` for a test that names none. */
function fetchFulltext(input: Parameters<typeof fetchFulltextWith>[0], cache?: Cache, client?: NcbiClient, deps: FulltextDeps = {}) {
  return fetchFulltextWith(input, cache, client, { adapter: defaultAdapter, ...deps });
}
beforeEach(() => {
  strayRequests.length = 0;
  vi.stubGlobal("fetch", async (url: unknown) => {
    strayRequests.push(String(url));
    throw new Error("no network in tests");
  });
});
afterEach(() => {
  expect(strayRequests).toEqual([]);
});

function htmlResource(text: string, url = "https://oa.example/article"): FetchedResource {
  return { ok: true, status: 200, contentType: "text/html", finalUrl: url, text };
}
function pdfResource(bytes: Uint8Array, url = "https://oa.example/paper.pdf"): FetchedResource {
  return { ok: true, status: 200, contentType: "application/pdf", finalUrl: url, bytes };
}
function paywalled(): FetchedResource {
  return { ok: false, status: 403, contentType: "text/html", finalUrl: "x" };
}

describe("fetchFulltext resolution strategy", () => {
  it("resolves via Unpaywall, returns markdown, and serves the second call from cache", async () => {
    const cache = new LRUBackend();
    const client = fakeClient({ summary: ARTICLE });
    const fetchUrl = vi.fn(async () => htmlResource("<html><body>...</body></html>"));
    const deps: FulltextDeps = {
      unpaywall: fakeUnpaywall({ doi: DOI, isOa: true, urls: ["https://oa.example/article"] }),
      fetchUrl,
      htmlToMarkdown: async () => LONG_MARKDOWN,
    };

    const out = await fetchFulltext({ id: "12345678" }, cache, client, deps);
    expect(out.source).toBe("unpaywall");
    expect(out.format).toBe("markdown");
    expect(out.doi).toBe(DOI);
    expect(out.truncated).toBe(false);
    expect(out.fulltext).toContain("Methods");

    const out2 = await fetchFulltext({ id: "12345678" }, cache, client, deps);
    expect(out2.source).toBe("unpaywall");
    expect(out2.doi).toBe(DOI);
    // Cache hit — the network fetch ran only for the first call.
    expect(fetchUrl).toHaveBeenCalledTimes(1);
  });

  it("falls through to the institutional proxy when Unpaywall misses", async () => {
    const fetchUrl = vi.fn(async (url: string) => (url.includes("ezproxy") ? htmlResource("<html/>", url) : paywalled()));
    const deps: FulltextDeps = {
      unpaywall: fakeUnpaywall(null),
      proxyPrefix: "https://doi-org.ezproxy.example.edu",
      fetchUrl,
      htmlToMarkdown: async () => LONG_MARKDOWN,
    };

    const out = await fetchFulltext({ id: "12345678", doi: DOI }, new LRUBackend(), fakeClient(), deps);
    expect(out.source).toBe("proxy");
    expect(fetchUrl).toHaveBeenCalledWith("https://doi-org.ezproxy.example.edu/10.1000/xyz123", expect.any(Number));
  });

  it("fetches PMC and Europe PMC copies through Europe PMC's API, never their websites", async () => {
    const fetchUrl = vi.fn(async (url: string) =>
      url.includes("/fullTextXML") ? { ...htmlResource("<article/>", url), contentType: "application/xml" } : paywalled(),
    );
    const jatsToMarkdown = vi.fn(async () => LONG_MARKDOWN);
    const htmlToMarkdown = vi.fn(async () => LONG_MARKDOWN);
    const deps: FulltextDeps = {
      unpaywall: fakeUnpaywall({
        doi: DOI,
        isOa: true,
        urls: [
          "https://www.ncbi.nlm.nih.gov/pmc/articles/1234567", // Unpaywall's usual form: no "PMC" prefix
          "https://pmc.ncbi.nlm.nih.gov/articles/PMC1234567/pdf/main.pdf",
          "https://europepmc.org/articles/pmc1234567",
          "https://europepmc.org/abstract/MED/12345678", // an abstract page: dropped
          "https://europepmc.org/article/PPR/PPR1318364", // a preprint: the API has its full text
          "https://oa.example/article",
        ],
      }),
      fetchUrl,
      htmlToMarkdown,
      jatsToMarkdown,
    };

    const out = await fetchFulltext({ id: "12345678", doi: DOI }, new LRUBackend(), fakeClient(), deps);
    expect(out.source).toBe("unpaywall");
    expect(fetchUrl.mock.calls.map(([url]) => url)).toEqual([
      "https://www.ebi.ac.uk/europepmc/webservices/rest/PMC1234567/fullTextXML",
    ]);

    // The full list, had the first API call failed: PMC copies deduplicated, the abstract page gone.
    const all = vi.fn(async () => paywalled());
    await fetchFulltext({ id: "12345678", doi: DOI }, new LRUBackend(), fakeClient(), { ...deps, fetchUrl: all });
    expect(all.mock.calls.map(([url]) => url).slice(0, 3)).toEqual([
      "https://www.ebi.ac.uk/europepmc/webservices/rest/PMC1234567/fullTextXML",
      "https://www.ebi.ac.uk/europepmc/webservices/rest/PPR1318364/fullTextXML",
      "https://oa.example/article",
    ]);
    expect(jatsToMarkdown).toHaveBeenCalledWith("<article/>");
    expect(htmlToMarkdown).not.toHaveBeenCalled();
  });

  it("skips a PMC copy outside Europe PMC's open-access set and tries the next location", async () => {
    const fetchUrl = vi.fn(async (url: string) => (url.includes("/fullTextXML") ? paywalled() : htmlResource("<x/>", url)));
    const deps: FulltextDeps = {
      unpaywall: fakeUnpaywall({
        doi: DOI,
        isOa: true,
        urls: ["https://www.ncbi.nlm.nih.gov/pmc/articles/PMC7654321/", "https://oa.example/article"],
      }),
      fetchUrl,
      htmlToMarkdown: async () => LONG_MARKDOWN,
    };
    const out = await fetchFulltext({ id: "12345678", doi: DOI }, new LRUBackend(), fakeClient(), deps);
    expect(out.source).toBe("unpaywall");
    expect(fetchUrl.mock.calls.map(([url]) => url)).toEqual([
      "https://www.ebi.ac.uk/europepmc/webservices/rest/PMC7654321/fullTextXML",
      "https://oa.example/article",
    ]);
  });

  it("recognizes a PMC copy in Unpaywall's usual form, without the PMC prefix", async () => {
    const fetchUrl = vi.fn(async () => paywalled());
    await fetchFulltext({ id: "12345678", doi: DOI }, new LRUBackend(), fakeClient(), {
      unpaywall: fakeUnpaywall({ doi: DOI, isOa: true, urls: ["https://www.ncbi.nlm.nih.gov/pmc/articles/4974751"] }),
      fetchUrl,
    });
    expect(fetchUrl.mock.calls[0]?.[0]).toBe("https://www.ebi.ac.uk/europepmc/webservices/rest/PMC4974751/fullTextXML");
  });

  it("leaves other NCBI pages, such as Bookshelf, to the regular fetch", async () => {
    const fetchUrl = vi.fn(async (url: string) => htmlResource("<x/>", url));
    const deps: FulltextDeps = {
      unpaywall: fakeUnpaywall({ doi: DOI, isOa: true, urls: ["https://www.ncbi.nlm.nih.gov/books/NBK1234/"] }),
      fetchUrl,
      htmlToMarkdown: async () => LONG_MARKDOWN,
    };
    await fetchFulltext({ id: "12345678", doi: DOI }, new LRUBackend(), fakeClient(), deps);
    expect(fetchUrl.mock.calls[0]?.[0]).toBe("https://www.ncbi.nlm.nih.gov/books/NBK1234/");
  });

  it("ignores a proxy or direct text cached by an older version", async () => {
    const cache = new LRUBackend();
    cache.setFulltext("12345678", { source: "proxy", fulltext: LONG_MARKDOWN, format: "markdown", fetchedAt: Date.now() });
    const fetchUrl = vi.fn(async () => paywalled());
    const out = await fetchFulltext({ id: "12345678", doi: DOI }, cache, fakeClient(), { unpaywall: fakeUnpaywall(null), fetchUrl });
    expect(out.source).toBe("none");
    expect(fetchUrl).toHaveBeenCalled();
  });

  it("says when a location was refused for its address, and how to allow it on a personal machine", async () => {
    const deps: FulltextDeps = {
      unpaywall: fakeUnpaywall({ doi: DOI, isOa: true, urls: ["https://oa.example/article"] }),
      fetchUrl: async (url: string) => {
        if (url.startsWith("https://oa.example")) throw new BlockedUrlError("Refusing to connect: oa.example resolves to 198.18.0.7", "address");
        return paywalled();
      },
    };
    const out = await fetchFulltext({ id: "12345678", doi: DOI }, new LRUBackend(), fakeClient(), deps);
    expect(out.source).toBe("none");
    expect(out.warning).toContain("MED_RESEARCH_FULLTEXT_ALLOW_PRIVATE=1");

    const plain = await fetchFulltext({ id: "12345678", doi: DOI }, new LRUBackend(), fakeClient(), {
      unpaywall: fakeUnpaywall(null),
      fetchUrl: async () => paywalled(),
    });
    expect(plain.warning).not.toContain("MED_RESEARCH_FULLTEXT_ALLOW_PRIVATE");
  });

  it("doesn't cache a proxy text, which may be licensed to this user alone", async () => {
    const cache = new LRUBackend();
    const fetchUrl = vi.fn(async (url: string) => (url.includes("ezproxy") ? htmlResource("<html/>", url) : paywalled()));
    const deps: FulltextDeps = {
      unpaywall: fakeUnpaywall(null),
      proxyPrefix: "https://doi-org.ezproxy.example.edu",
      fetchUrl,
      htmlToMarkdown: async () => LONG_MARKDOWN,
    };
    expect((await fetchFulltext({ id: "12345678", doi: DOI }, cache, fakeClient(), deps)).source).toBe("proxy");
    expect(cache.getFulltext("12345678")).toBeNull();
  });

  it("uses direct DOI access when there is no OA copy and no proxy", async () => {
    const fetchUrl = vi.fn(async (url: string) => (url.startsWith("https://doi.org/") ? htmlResource("<x/>", url) : paywalled()));
    const deps: FulltextDeps = { unpaywall: fakeUnpaywall(null), fetchUrl, htmlToMarkdown: async () => LONG_MARKDOWN };

    const out = await fetchFulltext({ id: "12345678", doi: DOI }, new LRUBackend(), fakeClient(), deps);
    expect(out.source).toBe("direct");
    expect(fetchUrl).toHaveBeenCalledWith("https://doi.org/10.1000/xyz123", expect.any(Number));
  });

  it("extracts PDF bytes and flags format 'pdf'", async () => {
    const deps: FulltextDeps = {
      unpaywall: fakeUnpaywall({ doi: DOI, isOa: true, urls: ["https://oa.example/p.pdf"] }),
      fetchUrl: async () => pdfResource(new Uint8Array([1, 2, 3])),
      pdfToText: async () => "Full PDF text. " + "content ".repeat(200),
    };

    const out = await fetchFulltext({ id: "12345678", doi: DOI }, new LRUBackend(), fakeClient(), deps);
    expect(out.format).toBe("pdf");
    expect(out.source).toBe("unpaywall");
    expect(out.fulltext).toContain("Full PDF text");
  });

  it("falls back to the abstract when every source is paywalled", async () => {
    const deps: FulltextDeps = {
      unpaywall: fakeUnpaywall(null),
      fetchUrl: async () => paywalled(),
    };

    const out = await fetchFulltext(
      { id: "12345678", doi: DOI },
      new LRUBackend(),
      fakeClient({ abstract: "The full abstract text." }),
      deps,
    );
    expect(out.source).toBe("none");
    expect(out.fulltext).toBe("The full abstract text.");
    expect(out.warning).toMatch(/paywalled/i);
    expect(out.warning).toMatch(/MED_RESEARCH_PROXY_PREFIX/);
  });

  it("adjusts the fallback warning when a proxy is already configured", async () => {
    const deps: FulltextDeps = {
      unpaywall: fakeUnpaywall(null),
      proxyPrefix: "https://doi-org.ezproxy.example.edu",
      fetchUrl: async () => paywalled(),
    };
    const out = await fetchFulltext({ id: "12345678", doi: DOI }, new LRUBackend(), fakeClient({ abstract: "abs" }), deps);
    expect(out.source).toBe("none");
    expect(out.warning).not.toMatch(/MED_RESEARCH_PROXY_PREFIX/);
  });

  it("treats a sub-threshold extraction as a paywall stub, not full text", async () => {
    const deps: FulltextDeps = {
      unpaywall: fakeUnpaywall({ doi: DOI, isOa: true, urls: ["https://oa.example/a"] }),
      fetchUrl: async () => htmlResource("<x/>"),
      htmlToMarkdown: async () => "Access this article for $39.95",
    };
    const out = await fetchFulltext({ id: "12345678", doi: DOI }, new LRUBackend(), fakeClient({ abstract: "abs" }), deps);
    expect(out.source).toBe("none");
  });

  it("truncates text beyond maxChars and flags truncated", async () => {
    const deps: FulltextDeps = {
      unpaywall: fakeUnpaywall({ doi: DOI, isOa: true, urls: ["https://oa.example/u"] }),
      fetchUrl: async () => htmlResource("<x/>"),
      htmlToMarkdown: async () => "A".repeat(5000),
      maxChars: 1000,
    };
    const out = await fetchFulltext({ id: "12345678", doi: DOI }, new LRUBackend(), fakeClient(), deps);
    expect(out.truncated).toBe(true);
    expect(out.fulltext).toHaveLength(1000);
    expect(out).toMatchObject({ totalChars: 5000, nextOffset: 1000 });
  });

  describe("reading a long text in parts", () => {
    const words = Array.from({ length: 2000 }, (_, i) => `word${i}`).join(" ");
    const text = `# Title\n\n${words.slice(0, 4000)}\n\n${words.slice(4000)}`;
    const setup = () => {
      const fetchUrl = vi.fn(async () => htmlResource("<x/>"));
      const deps: FulltextDeps = {
        unpaywall: fakeUnpaywall({ doi: DOI, isOa: true, urls: ["https://oa.example/u"] }),
        fetchUrl,
        htmlToMarkdown: async () => text,
        maxChars: 3000,
      };
      return { cache: new LRUBackend(), fetchUrl, deps };
    };

    it("ends a part at a space, not mid-word, and reads on from nextOffset out of the cache", async () => {
      const { cache, fetchUrl, deps } = setup();
      const parts: string[] = [];
      let offset: number | undefined = 0;
      while (offset !== undefined) {
        const out = await fetchFulltext({ id: "12345678", doi: DOI, offset }, cache, fakeClient(), deps);
        expect(out.totalChars).toBe(text.length);
        expect(out.fulltext!.length).toBeLessThanOrEqual(3000);
        expect(out.truncated).toBe(out.nextOffset !== undefined);
        if (out.truncated) expect(out.fulltext).toMatch(/\s$/);
        parts.push(out.fulltext!);
        offset = out.nextOffset;
      }
      expect(parts.length).toBeGreaterThan(2);
      expect(parts.join("")).toBe(text);
      // One fetch: the cache holds the whole text, so later parts cost nothing.
      expect(fetchUrl).toHaveBeenCalledTimes(1);
    });

    it("prefers a paragraph break, and takes a smaller maxChars but none above the configured limit", async () => {
      const { cache, deps } = setup();
      const first = await fetchFulltext({ id: "12345678", doi: DOI, maxChars: 4200 }, cache, fakeClient(), deps);
      // Capped at deps.maxChars, then cut back to a space.
      expect(first.fulltext!.length).toBeGreaterThan(2400);
      expect(first.fulltext!.length).toBeLessThanOrEqual(3000);
      const paragraph = await fetchFulltext({ id: "12345678", doi: DOI, offset: 2000, maxChars: 2500 }, cache, fakeClient(), deps);
      expect(paragraph.nextOffset).toBe(text.indexOf("\n\n", 100) + 2);
      const small = await fetchFulltext({ id: "12345678", doi: DOI, maxChars: 100 }, cache, fakeClient(), deps);
      expect(small.fulltext!.length).toBeLessThanOrEqual(100);
    });

    it("raises INVALID_INPUT for an offset past the end or a bad number", async () => {
      const { cache, deps } = setup();
      await expect(fetchFulltext({ id: "12345678", doi: DOI, offset: text.length }, cache, fakeClient(), deps)).rejects.toMatchObject({
        code: "INVALID_INPUT",
        userMessage: expect.stringContaining(`which has ${text.length} characters`),
      });
      await expect(fetchFulltext({ id: "12345678", doi: DOI, offset: -1 }, cache, fakeClient(), deps)).rejects.toMatchObject({ code: "INVALID_INPUT" });
      await expect(fetchFulltext({ id: "12345678", doi: DOI, maxChars: 0 }, cache, fakeClient(), deps)).rejects.toMatchObject({ code: "INVALID_INPUT" });
    });

    it("reads a direct text on from the same download, even when Unpaywall answers by then", async () => {
      const unpaywall = vi.fn<() => Promise<UnpaywallLookup>>(async () => ({ status: "failed" }));
      const fetchUrl = vi.fn(async (url: string) => htmlResource("<x/>", url));
      const deps: FulltextDeps = {
        unpaywall: { lookup: unpaywall, sharedContact: false } as unknown as UnpaywallClient,
        fetchUrl,
        htmlToMarkdown: async (_html, url) => (url.startsWith("https://doi.org/") ? text : `# Other\n\n${"other ".repeat(1000)}`),
        maxChars: 3000,
      };
      const cache = new LRUBackend();
      const first = await fetchFulltext({ id: "12345678", doi: DOI }, cache, fakeClient(), deps);
      expect(first).toMatchObject({ source: "direct", truncated: true });

      // The lookup that failed answers now, with a copy of another length.
      unpaywall.mockResolvedValue({ status: "found", result: { doi: DOI, isOa: true, urls: ["https://oa.example/u"] } });
      const parts = [first.fulltext!];
      let offset = first.nextOffset;
      while (offset !== undefined) {
        const out = await fetchFulltext({ id: "12345678", doi: DOI, offset }, cache, fakeClient(), deps);
        expect(out.source).toBe("direct");
        parts.push(out.fulltext!);
        offset = out.nextOffset;
      }
      expect(parts.join("")).toBe(text);
      expect(fetchUrl).toHaveBeenCalledTimes(1);
      // Never cached: a direct text may be licensed to this user alone.
      expect(cache.getFulltext("12345678")).toBeNull();

      // Read to the end, the text is let go: a new reading resolves afresh.
      const again = await fetchFulltext({ id: "12345678", doi: DOI, offset: 3000 }, cache, fakeClient(), deps);
      expect(again.source).toBe("unpaywall");
    });

    it("returns no text for an offset when the text can't be fetched again, not the abstract", async () => {
      const deps: FulltextDeps = { unpaywall: fakeUnpaywall(null), fetchUrl: async () => paywalled() };
      const out = await fetchFulltext({ id: "12345678", doi: DOI, offset: 50_000 }, new LRUBackend(), fakeClient({ abstract: "The abstract." }), deps);
      expect(out).toMatchObject({ source: "none", truncated: false });
      expect(out.fulltext).toBeUndefined();
      expect(out.warning).toMatch(/^No full text found, so there is no part from offset 50000; call without offset for the abstract\. /);
    });

    it("never splits a character outside the BMP between parts", async () => {
      const math = "𝛼".repeat(1000);
      const deps: FulltextDeps = {
        unpaywall: fakeUnpaywall({ doi: DOI, isOa: true, urls: ["https://oa.example/u"] }),
        fetchUrl: async () => htmlResource("<x/>"),
        htmlToMarkdown: async () => `# Formulas\n\n${math}`,
        maxChars: 1001,
      };
      const cache = new LRUBackend();
      const first = await fetchFulltext({ id: "12345678", doi: DOI }, cache, fakeClient(), deps);
      expect(first.nextOffset).toBe(1000);
      expect(first.fulltext!.at(-1)).not.toMatch(/[\uD800-\uDBFF]/);
      const second = await fetchFulltext({ id: "12345678", doi: DOI, offset: first.nextOffset!, maxChars: 1 }, cache, fakeClient(), deps);
      // A part of one code unit still holds the whole character.
      expect(second.fulltext).toBe("𝛼");
      // And when that character ends the text, the part is the last one.
      const last = await fetchFulltext({ id: "12345678", doi: DOI, offset: 2010, maxChars: 1 }, cache, fakeClient(), deps);
      expect(last).toMatchObject({ fulltext: "𝛼", truncated: false, totalChars: 2012 });
      expect(last.nextOffset).toBeUndefined();
    });
  });

  describe("MED_RESEARCH_FULLTEXT_MAX_CHARS", () => {
    afterEach(() => {
      delete process.env.MED_RESEARCH_FULLTEXT_MAX_CHARS;
    });

    it("takes a whole number of characters, 1 or more, and ignores anything else", async () => {
      const deps: FulltextDeps = {
        unpaywall: fakeUnpaywall({ doi: DOI, isOa: true, urls: ["https://oa.example/u"] }),
        fetchUrl: async () => htmlResource("<x/>"),
        htmlToMarkdown: async () => "A".repeat(60_000),
      };
      const read = async (value: string) => {
        process.env.MED_RESEARCH_FULLTEXT_MAX_CHARS = value;
        return (await fetchFulltext({ id: "12345678", doi: DOI }, new LRUBackend(), fakeClient(), deps)).nextOffset;
      };
      expect(await read("1500")).toBe(1500);
      expect(await read("1500.5")).toBe(50_000);
      expect(await read("0.5")).toBe(50_000);
      expect(await read("0")).toBe(50_000);
    });
  });

  it("normalizes a DOI passed as a URL before resolving", async () => {
    const lookup = vi.fn(async (): Promise<UnpaywallLookup> => ({ status: "found", result: { doi: DOI, isOa: true, urls: ["https://oa.example/u"] } }));
    const deps: FulltextDeps = {
      unpaywall: { lookup } as unknown as UnpaywallClient,
      fetchUrl: async () => htmlResource("<x/>"),
      htmlToMarkdown: async () => LONG_MARKDOWN,
    };
    await fetchFulltext({ id: "12345678", doi: "https://doi.org/10.1000/xyz123" }, new LRUBackend(), fakeClient(), deps);
    expect(lookup).toHaveBeenCalledWith(DOI);
  });

  it("throws NOT_FOUND for a non-numeric id", async () => {
    await expect(fetchFulltext({ id: "not-a-pmid" }, new LRUBackend(), fakeClient())).rejects.toBeInstanceOf(
      ResearchApiException,
    );
  });

  it("says Europe PMC has no record of an id given without a DOI, and what to do", async () => {
    const europePmc = fakeEuropePmc();
    const error = await fetchFulltext({ id: "cba:644599" }, new LRUBackend(), fakeClient(), { adapter: europePmc.adapter }).catch(
      (e: unknown) => e as ResearchApiException,
    );
    expect(error).toMatchObject({ code: "NOT_FOUND", recoverable: false });
    expect(error.userMessage).toContain('Europe PMC has no record of "cba:644599"');
    expect(error.userMessage).not.toContain("PubMed article");
    // Asked once, by the id as Europe PMC writes it.
    expect(europePmc.fetch.mock.calls.map(([ids]) => ids)).toEqual([["CBA:644599"]]);
    // A failing Europe PMC is no record either, and the message allows for it.
    const failing: FulltextDeps["adapter"] = () => ({
      fetch: async () => {
        throw new Error("Europe PMC is down");
      },
    });
    const down = await fetchFulltext({ id: "CBA:644599" }, new LRUBackend(), fakeClient(), { adapter: failing }).catch((e: unknown) => e as ResearchApiException);
    expect(down).toMatchObject({ code: "NOT_FOUND" });
    expect(down.userMessage).toContain("or couldn't be reached");
  });

  it("tells which ids work on their own, what to pass instead, and that a url is not a doi", async () => {
    const asked = vi.fn();
    // An id of no shape any database has is refused before anything is asked.
    const unrecognized = await fetchFulltext({ id: "not-a-pmid" }, new LRUBackend(), fakeClient(), { adapter: asked }).catch((e: unknown) => e as ResearchApiException);
    expect(asked).not.toHaveBeenCalled();
    const looked = await fetchFulltext({ id: "CBA:644599" }, new LRUBackend(), fakeClient(), { adapter: noRecords }).catch((e: unknown) => e as ResearchApiException);
    expect(unrecognized.userMessage).toContain('"not-a-pmid" is not an id literature_fulltext looks up');
    for (const [name, error] of [["unrecognized", unrecognized], ["looked up", looked]] as const) {
      const message = error.userMessage;
      expect(error, name).toMatchObject({ code: "NOT_FOUND", recoverable: false });
      // What to pass: the id as search returned it, prefix included, or the doi; and what to do for a record without one.
      expect(message, name).toContain("Pass the id of a literature_search result, with any prefix (CBA:644599), or the doi of that result");
      expect(message, name).toContain("open its url instead");
      expect(message, name).toContain("A url or originalUrl is not a doi");
    }
    // The ids that work on their own, in the message for an id none of them is.
    for (const own of ["PMID", "PMCID (PMC…)", "PPR…", "CBA:…", "IND…", "chinaxiv-…", "ru-…"]) expect(unrecognized.userMessage).toContain(own);
    expect(unrecognized.userMessage).not.toMatch(/can't be resolved|neither/);
  });

  it("raises INVALID_INPUT for a url passed as the doi of an id that needs one, naming the mistake", async () => {
    // For an id Europe PMC has no record of: with one that has a DOI, the record's is used (see "other Europe PMC ids").
    for (const doi of ["https://chinaxiv.org/abs/202401.00027", "chinaxiv.org/abs/202401.00027", "not a doi", "10.12/short"]) {
      const error = await fetchFulltext({ id: "CBA:644599", doi }, new LRUBackend(), fakeClient(), { adapter: noRecords }).catch((e: unknown) => e as ResearchApiException);
      expect(error, doi).toMatchObject({ code: "INVALID_INPUT", recoverable: true });
      expect(error.userMessage, doi).toContain(`doi ${JSON.stringify(doi)} is not a DOI`);
      expect(error.userMessage, doi).toContain("A record's url or originalUrl is not a doi");
    }
    // A long one is cut in the message.
    const long = await fetchFulltext({ id: "CBA:1", doi: `https://example.org/${"x".repeat(500)}` }, new LRUBackend(), fakeClient(), { adapter: noRecords }).catch((e: unknown) => e as ResearchApiException);
    expect(long.userMessage.length).toBeLessThan(600);
    // An id of no known shape too, without asking anyone.
    const unrecognized = await fetchFulltext({ id: "not-a-pmid", doi: "https://chinaxiv.org/abs/1" }, new LRUBackend(), fakeClient()).catch((e: unknown) => e as ResearchApiException);
    expect(unrecognized).toMatchObject({ code: "INVALID_INPUT" });
  });

  it("ignores a url passed as the doi of an id that resolves on its own", async () => {
    const out = await fetchFulltext({ id: "12345678", doi: "https://chinaxiv.org/abs/202401.00027" }, new LRUBackend(), fakeClient({ summary: ARTICLE }), {
      unpaywall: fakeUnpaywall({ doi: DOI, isOa: true, urls: ["https://oa.example/article"] }),
      fetchUrl: async () => htmlResource("<x/>"),
      htmlToMarkdown: async () => LONG_MARKDOWN,
    });
    expect(out).toMatchObject({ source: "unpaywall", doi: DOI });
  });

  it("reads a doi.org link of any usual host form", async () => {
    const lookup = vi.fn(async (): Promise<UnpaywallLookup> => ({ status: "none" }));
    const deps: FulltextDeps = { unpaywall: { lookup } as unknown as UnpaywallClient, fetchUrl: async () => paywalled(), adapter: noRecords };
    for (const doi of ["https://www.doi.org/10.1000/xyz123", "http://dx.doi.org/10.1000/xyz123", "doi:10.1000/xyz123", " 10.1000/xyz123 "]) {
      await fetchFulltext({ id: "CBA:644599", doi }, new LRUBackend(), fakeClient(), deps);
    }
    expect(lookup.mock.calls.map(([d]) => d)).toEqual([DOI, DOI, DOI, DOI]);
  });

  it("doesn't ask PubMed for the abstract of another database's id", async () => {
    const efetch = vi.fn();
    const client = { ...fakeClient(), efetch } as unknown as NcbiClient;
    const result = await fetchFulltext({ id: "CBA:521529", doi: DOI }, new LRUBackend(), client, {
      unpaywall: fakeUnpaywall(null),
      fetchUrl: async () => paywalled(),
      adapter: noRecords,
    });
    expect(result.source).toBe("none");
    expect(efetch).not.toHaveBeenCalled();
  });

  it("throws NOT_FOUND when the id has no summary and no DOI", async () => {
    await expect(
      fetchFulltext({ id: "99999999" }, new LRUBackend(), fakeClient({ summary: null })),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
  });

  it("keeps a bare number a PMID: PubMed is asked, and Europe PMC never, whatever record has that number", async () => {
    // "644599" is also the number of a CBA record, which Europe PMC keys "CBA:644599" to tell them apart.
    const europePmc = fakeEuropePmc([{ ...ARTICLE, id: "CBA:644599", database: "europepmc" }]);
    const onEsummary = vi.fn();
    await expect(fetchFulltext({ id: "644599" }, new LRUBackend(), fakeClient({ onEsummary }), { adapter: europePmc.adapter })).rejects.toMatchObject({
      code: "NOT_FOUND",
      userMessage: expect.stringContaining("No PubMed article found for PMID 644599"),
    });
    expect(onEsummary).toHaveBeenCalledTimes(1);
    expect(europePmc.fetch).not.toHaveBeenCalled();
  });
});

describe("fetchFulltext — other Europe PMC ids, looked up like a preprint's", () => {
  const CBA = "CBA:644599";
  const CBA_DOI = "10.1000/cba-paper";
  const CBA_RECORD: Article = {
    id: CBA,
    title: "A Chinese Biological Abstracts record",
    authors: ["Zhang W"],
    journal: "Chin J Test",
    pubDate: "2007",
    publicationTypes: [],
    database: "europepmc",
    abstract: "The CBA record's abstract.",
  };
  const paywall = (): FulltextDeps => ({ unpaywall: fakeUnpaywall(null), fetchUrl: async () => paywalled() });

  it("opens the Unpaywall and direct routes with the DOI of the record, as for a preprint, and returns the text", async () => {
    const europePmc = fakeEuropePmc([{ ...CBA_RECORD, doi: CBA_DOI }]);
    const lookup = vi.fn(async (): Promise<UnpaywallLookup> => ({ status: "found", result: { doi: CBA_DOI, isOa: true, urls: ["https://oa.example/article"] } }));
    const out = await fetchFulltext({ id: "cba:644599" }, new LRUBackend(), fakeClient(), {
      unpaywall: { lookup } as unknown as UnpaywallClient,
      fetchUrl: async () => htmlResource("<x/>"),
      htmlToMarkdown: async () => LONG_MARKDOWN,
      adapter: europePmc.adapter,
    });
    expect(out).toMatchObject({ id: "cba:644599", source: "unpaywall", doi: CBA_DOI });
    expect(lookup).toHaveBeenCalledWith(CBA_DOI);
    expect(europePmc.fetch.mock.calls.map(([ids]) => ids)).toEqual([[CBA]]);
  });

  it("returns the record's abstract, with a warning that no text was found, when the DOI's routes have none", async () => {
    const europePmc = fakeEuropePmc([{ ...CBA_RECORD, doi: CBA_DOI }]);
    const out = await fetchFulltext({ id: CBA }, new LRUBackend(), fakeClient(), { ...paywall(), adapter: europePmc.adapter });
    expect(out).toMatchObject({ source: "none", doi: CBA_DOI, fulltext: "The CBA record's abstract.", truncated: false });
    expect(out.warning).toContain("No full text found; returned the abstract only.");
    expect(out.warning).toContain("The publisher's site");
  });

  it("returns the abstract, and says the record has no DOI, for a record without one", async () => {
    const europePmc = fakeEuropePmc([CBA_RECORD]);
    const lookup = vi.fn();
    const fetchUrl = vi.fn();
    const out = await fetchFulltext({ id: CBA }, new LRUBackend(), fakeClient(), { unpaywall: { lookup } as unknown as UnpaywallClient, fetchUrl, adapter: europePmc.adapter });
    expect(out).toMatchObject({ source: "none", fulltext: "The CBA record's abstract.", truncated: false });
    expect(out.doi).toBeUndefined();
    expect(out.warning).toBe("No full text found; returned the abstract only. Europe PMC's record for this id has no DOI, so no full-text source could be tried.");
    // Nothing to ask a DOI route about.
    expect(lookup).not.toHaveBeenCalled();
    expect(fetchUrl).not.toHaveBeenCalled();

    // The record's url, when it has one, is the only place left to point to.
    const url = "https://www.surechembl.org/document/US-20120071552-A1";
    const patent = await fetchFulltext({ id: CBA }, new LRUBackend(), fakeClient(), { adapter: fakeEuropePmc([{ ...CBA_RECORD, url }]).adapter });
    expect(patent.warning).toBe(`No full text found; returned the abstract only. Europe PMC's record for this id has no DOI, so no full-text source could be tried. A browser may open ${url}.`);
  });

  it("goes on with the record's PMCID, when it has one, through Europe PMC's full-text API", async () => {
    const europePmc = fakeEuropePmc([{ ...CBA_RECORD, pmcid: "PMC7654321" }]);
    const fetchUrl = vi.fn(async (url: string) => ({ ...htmlResource("<article/>", url), contentType: "application/xml" }));
    const out = await fetchFulltext({ id: CBA }, new LRUBackend(), fakeClient(), { fetchUrl, jatsToMarkdown: async () => LONG_MARKDOWN, adapter: europePmc.adapter });
    expect(out.source).toBe("europepmc");
    expect(fetchUrl.mock.calls.map(([url]) => url)).toEqual(["https://www.ebi.ac.uk/europepmc/webservices/rest/PMC7654321/fullTextXML"]);
  });

  it("remembers the record, and asks Europe PMC for it once", async () => {
    const europePmc = fakeEuropePmc([{ ...CBA_RECORD, doi: CBA_DOI }]);
    const cache = new LRUBackend();
    const deps: FulltextDeps = { ...paywall(), adapter: europePmc.adapter };
    await fetchFulltext({ id: CBA }, cache, fakeClient(), deps);
    await fetchFulltext({ id: CBA }, cache, fakeClient(), deps);
    expect(europePmc.fetch).toHaveBeenCalledTimes(1);
  });

  it("checks a DOI the caller gave against the record's: refused when it is another, used when it is the record's or the record has none", async () => {
    const europePmc = fakeEuropePmc([{ ...CBA_RECORD, doi: CBA_DOI }]);
    const lookup = vi.fn(async (): Promise<UnpaywallLookup> => ({ status: "none" }));
    const deps = (adapter: FulltextDeps["adapter"]): FulltextDeps => ({ unpaywall: { lookup } as unknown as UnpaywallClient, fetchUrl: async () => paywalled(), adapter });
    // Another DOI: nothing is looked for under it.
    const error = await fetchFulltext({ id: CBA, doi: DOI }, new LRUBackend(), fakeClient(), deps(europePmc.adapter)).catch((e: unknown) => e as ResearchApiException);
    expect(error).toMatchObject({ code: "INVALID_INPUT" });
    expect(error.userMessage).toContain(`${CBA}: its record has ${CBA_DOI}`);
    expect(lookup).not.toHaveBeenCalled();
    // The record's own, whatever its form.
    const same = await fetchFulltext({ id: CBA, doi: `https://doi.org/${CBA_DOI.toUpperCase()}` }, new LRUBackend(), fakeClient(), deps(europePmc.adapter));
    expect(lookup).toHaveBeenCalledWith(CBA_DOI.toUpperCase());
    expect(same).toMatchObject({ source: "none", doi: CBA_DOI.toUpperCase(), fulltext: "The CBA record's abstract." });
    // A record without one can't say, and the DOI given is the only one there is.
    lookup.mockClear();
    const bare = await fetchFulltext({ id: CBA, doi: DOI }, new LRUBackend(), fakeClient(), deps(fakeEuropePmc([CBA_RECORD]).adapter));
    expect(lookup).toHaveBeenCalledWith(DOI);
    expect(bare).toMatchObject({ source: "none", doi: DOI, fulltext: "The CBA record's abstract." });
  });

  it("uses the record's DOI over a url given as the doi", async () => {
    const europePmc = fakeEuropePmc([{ ...CBA_RECORD, doi: CBA_DOI }]);
    const out = await fetchFulltext({ id: CBA, doi: "https://europepmc.org/article/CBA/644599" }, new LRUBackend(), fakeClient(), { ...paywall(), adapter: europePmc.adapter });
    expect(out).toMatchObject({ source: "none", doi: CBA_DOI });
  });

  it("looks up each kind of id by its exact query: SRC:id with a prefix, the bare id without one", async () => {
    const queries: string[] = [];
    const record = (id: string, source: string) => ({ id, source, title: `Record ${id}`, abstractText: `Abstract of ${id}.`, doi: undefined });
    const http: AdapterHttp = {
      json: async <T>(url: string): Promise<T> => {
        const query = new URL(url).searchParams.get("query")!;
        queries.push(query);
        const found = /^EXT_ID:(?:"([^"]+)"|(\d+) AND SRC:([A-Z]{3}))$/.exec(query);
        const id = found?.[1] ?? found?.[2];
        const source = found?.[3] ?? (id?.startsWith("IND") ? "AGR" : id?.startsWith("WO") ? "PAT" : id?.startsWith("NBK") ? "NBK" : "CTX");
        return { hitCount: 1, resultList: { result: id ? [record(id, source)] : [] } } as T;
      },
      text: async () => "",
    };
    const adapter = new EuropePmcAdapter(http);
    for (const [given, expected] of [
      ["CBA:644335", "EXT_ID:644335 AND SRC:CBA"],
      ["ETH:836421", "EXT_ID:836421 AND SRC:ETH"],
      ["IND609546324", 'EXT_ID:"IND609546324"'],
      ["wo2012049332", 'EXT_ID:"WO2012049332"'],
      ["NBK625970", 'EXT_ID:"NBK625970"'],
      ["C2201", 'EXT_ID:"C2201"'],
    ] as const) {
      queries.length = 0;
      const out = await fetchFulltext({ id: given }, new LRUBackend(), fakeClient(), { ...paywall(), adapter: () => adapter });
      expect(queries, given).toEqual([expected]);
      expect(out, given).toMatchObject({ id: given, source: "none" });
      expect(out.fulltext, given).toMatch(/^Abstract of /);
    }
  });

  it("leaves the ChinaRxiv ids to ChinaRxiv, and every id that fits no database to the error, without asking Europe PMC", async () => {
    const asked: string[] = [];
    const adapter: FulltextDeps["adapter"] = (database) => {
      asked.push(database);
      return undefined;
    };
    // A ChinaRxiv id: its own database is asked, and when it has no text nothing is asked of Europe PMC.
    const out = await fetchFulltext({ id: "chinaxiv-202401.00027" }, new LRUBackend(), fakeClient(), { adapter });
    expect(out.source).toBe("none");
    expect(new Set(asked)).toEqual(new Set(["chinaxiv"]));
    // Not a ChinaRxiv id, and no Europe PMC id either: hyphens, dots, slashes, spaces.
    asked.length = 0;
    for (const id of ["chinaxiv-2024.00027", "ru-1962", "202401.00027", "10.1000/xyz", "doi:10.1000/xyz", "PMID:12345678", "two words", "https://europepmc.org/article/CBA/644599", "CBA:"]) {
      await expect(fetchFulltext({ id }, new LRUBackend(), fakeClient(), { adapter }), id).rejects.toMatchObject({ code: "NOT_FOUND" });
    }
    expect(asked).toEqual([]);
  });
});

describe("fetchFulltext — an article, not its landing page", () => {
  const words = (n: number): string => "text ".repeat(n / 5).trim();
  /** Shaped like arXiv's abstract page as turndown renders it: links, the abstract, metadata. */
  const ARXIV_LIKE = [
    "[View PDF](https://arxiv.org/pdf/0000.00000) [HTML (experimental)](https://arxiv.org/html/0000.00000v7)",
    "> Abstract:" + words(1100),
    "Comments: 15 pages, 5 figures",
    "Subjects: Computation and Language (cs.CL); Machine Learning (cs.LG)",
    "Cite as: arXiv:0000.00000 [cs.CL]",
  ].join("\n\n");

  const directOnly = (markdown: string, abstract?: string) => ({
    deps: {
      unpaywall: fakeUnpaywall(null),
      fetchUrl: async (url: string) => htmlResource("<x/>", url),
      htmlToMarkdown: async () => markdown,
    } satisfies FulltextDeps,
    client: fakeClient(abstract ? { abstract } : {}),
  });

  it("returns the abstract, with a reason, for a page that holds little more", async () => {
    const { deps, client } = directOnly(ARXIV_LIKE, "The abstract.");
    const out = await fetchFulltext({ id: "12345678", doi: DOI }, new LRUBackend(), client, deps);
    expect(out.source).toBe("none");
    expect(out.fulltext).toBe("The abstract.");
    expect(out.warning).toMatch(/little beyond the abstract/);
  });

  it("takes a known abstract off a page that doesn't label it", async () => {
    const abstract = words(2500);
    const landing = directOnly(`# Title\n\n${abstract}\n\nPurchase this article`, abstract);
    expect((await fetchFulltext({ id: "12345678", doi: DOI }, new LRUBackend(), landing.client, landing.deps)).source).toBe("none");
    const article = directOnly(`# Title\n\n${abstract}\n\n## Methods\n\n${words(3000)}`, abstract);
    expect((await fetchFulltext({ id: "12345678", doi: DOI }, new LRUBackend(), article.client, article.deps)).source).toBe("direct");
  });

  it("doesn't count references or keywords as the article", async () => {
    const { deps, client } = directOnly(`## Abstract\n\n${words(1200)}\n\n## Keywords\n\ncreatine\n\n## References\n\n${words(9000)}`);
    expect((await fetchFulltext({ id: "12345678", doi: DOI }, new LRUBackend(), client, deps)).source).toBe("none");
  });

  it("counts a body nested under the Abstract heading past an abstract's length", async () => {
    const { deps, client } = directOnly(`## Abstract\n\n${words(1200)}\n\n### Introduction\n\n${words(5000)}`);
    expect((await fetchFulltext({ id: "12345678", doi: DOI }, new LRUBackend(), client, deps)).source).toBe("direct");
  });

  it("drops sections that are never the article, and keeps the rest", async () => {
    const page = [
      "## Abstract",
      words(1000),
      "### Similar content being viewed by others",
      "![](https://media.example/fig1.png)",
      "Another paper's title",
      "## Background",
      words(3000),
      "## References",
      "1. Doe J. A cited paper.",
    ].join("\n\n");
    const { deps, client } = directOnly(page);
    const out = await fetchFulltext({ id: "12345678", doi: DOI }, new LRUBackend(), client, deps);
    expect(out.source).toBe("direct");
    expect(out.fulltext).not.toMatch(/Similar content|Another paper|fig1\.png/);
    expect(out.fulltext).toMatch(/## Background[\s\S]*## References/);
  });
});

describe("fetchFulltext — Europe PMC by PMCID", () => {
  const PMC_URL = "https://www.ebi.ac.uk/europepmc/webservices/rest/PMC7654321/fullTextXML";
  const jats = (url: string): FetchedResource => ({ ...htmlResource("<article/>", url), contentType: "application/xml" });

  it("reads a record with a PMCID from Europe PMC first, without asking Unpaywall, and caches it", async () => {
    const cache = new LRUBackend();
    cache.setSummary("12345678", { ...ARTICLE, pmcid: "PMC7654321" });
    const lookup = vi.fn();
    const fetchUrl = vi.fn(async (url: string) => jats(url));
    const deps: FulltextDeps = {
      unpaywall: { lookup } as unknown as UnpaywallClient,
      fetchUrl,
      jatsToMarkdown: async () => LONG_MARKDOWN,
    };
    const out = await fetchFulltext({ id: "12345678" }, cache, fakeClient(), deps);
    expect(out).toMatchObject({ source: "europepmc", doi: DOI, format: "markdown" });
    expect(fetchUrl.mock.calls.map(([url]) => url)).toEqual([PMC_URL]);
    expect(lookup).not.toHaveBeenCalled();
    expect((await fetchFulltext({ id: "12345678" }, cache, fakeClient(), deps)).source).toBe("europepmc");
    expect(fetchUrl).toHaveBeenCalledTimes(1);
  });

  it("takes a PMCID as the id, without a DOI", async () => {
    const fetchUrl = vi.fn(async (url: string) => jats(url));
    const out = await fetchFulltext({ id: "pmc7654321" }, new LRUBackend(), fakeClient(), {
      fetchUrl,
      jatsToMarkdown: async () => LONG_MARKDOWN,
      adapter: noRecords,
    });
    expect(out.source).toBe("europepmc");
    expect(out.doi).toBeUndefined();
    expect(fetchUrl).toHaveBeenCalledWith(PMC_URL, expect.any(Number));
  });

  it("says so when Europe PMC has no open-access text for a PMCID without a DOI", async () => {
    const out = await fetchFulltext({ id: "PMC7654321" }, new LRUBackend(), fakeClient(), {
      fetchUrl: async () => ({ ok: false, status: 404, contentType: "text/html", finalUrl: PMC_URL }),
      adapter: noRecords,
    });
    expect(out.source).toBe("none");
    expect(out.fulltext).toBeUndefined();
    expect(out.warning).toContain("Europe PMC has no open-access full text for PMC7654321");
  });

  it("doesn't fetch the same Europe PMC text again when Unpaywall lists it too", async () => {
    const cache = new LRUBackend();
    cache.setSummary("12345678", { ...ARTICLE, pmcid: "PMC7654321" });
    const fetchUrl = vi.fn(async () => paywalled());
    const out = await fetchFulltext({ id: "12345678" }, cache, fakeClient(), {
      unpaywall: fakeUnpaywall({ doi: DOI, isOa: true, urls: ["https://www.ncbi.nlm.nih.gov/pmc/articles/7654321"] }),
      fetchUrl,
    });
    expect(fetchUrl.mock.calls.map(([url]) => url)).toEqual([PMC_URL, "https://doi.org/10.1000/xyz123"]);
    expect(out.warning).toContain("Unpaywall lists no other open-access copy.");
    expect(out.warning).not.toContain("()");
  });

  describe("an id PubMed doesn't know, such as a preprint", () => {
    const PREPRINT_DOI = "10.1101/2024.01.01.123456";
    const { doi: _doi, ...undated } = ARTICLE;
    const PREPRINT: Article = {
      ...undated,
      id: "PPR123456",
      title: "A preprint",
      journal: "medRxiv",
      publicationTypes: ["Preprint"],
      database: "europepmc",
      abstract: "The preprint's abstract.",
    };
    const noText = async (url: string): Promise<FetchedResource> => ({ ok: false, status: 404, contentType: "text/html", finalUrl: url });

    it("returns the abstract Europe PMC has for a preprint it has no full text of", async () => {
      const europePmc = fakeEuropePmc([PREPRINT]);
      const out = await fetchFulltext({ id: "ppr123456" }, new LRUBackend(), fakeClient(), { fetchUrl: noText, adapter: europePmc.adapter });
      expect(out).toMatchObject({ source: "none", fulltext: "The preprint's abstract." });
      expect(out.warning).toContain("No full text found; returned the abstract only.");
      expect(out.warning).toContain("Europe PMC has no open-access full text for PPR123456");
      // Asked once, by the id as Europe PMC writes it.
      expect(europePmc.fetch.mock.calls.map(([ids]) => ids)).toEqual([["PPR123456"]]);
    });

    it("asks for the record once, beside the text, when Europe PMC has the text, and says nothing of a record that carries no flag", async () => {
      const europePmc = fakeEuropePmc([PREPRINT]);
      const cache = new LRUBackend();
      const deps: FulltextDeps = {
        fetchUrl: async (url: string) => ({ ...htmlResource("<article/>", url), contentType: "application/xml" }),
        jatsToMarkdown: async () => LONG_MARKDOWN,
        adapter: europePmc.adapter,
      };
      const out = await fetchFulltext({ id: "PPR123456" }, cache, fakeClient(), deps);
      expect(out.source).toBe("europepmc");
      expect(out.warning).toBeUndefined();
      expect(europePmc.fetch.mock.calls.map(([ids]) => ids)).toEqual([["PPR123456"]]);
      // The record is kept, so that the next call (the text is cached too) asks for nothing.
      expect((await fetchFulltext({ id: "PPR123456" }, cache, fakeClient(), deps)).source).toBe("europepmc");
      expect(europePmc.fetch).toHaveBeenCalledTimes(1);
    });

    it("opens the Unpaywall and direct routes with the DOI of Europe PMC's record, and remembers the record", async () => {
      const europePmc = fakeEuropePmc([{ ...PREPRINT, doi: PREPRINT_DOI }]);
      const cache = new LRUBackend();
      const lookup = vi.fn(async (): Promise<UnpaywallLookup> => ({ status: "found", result: { doi: PREPRINT_DOI, isOa: true, urls: ["https://oa.example/preprint.pdf"] } }));
      const fetchUrl = vi.fn(async (url: string) => (url.includes("oa.example") ? pdfResource(new Uint8Array([1]), url) : await noText(url)));
      const deps: FulltextDeps = {
        unpaywall: { lookup } as unknown as UnpaywallClient,
        fetchUrl,
        pdfToText: async () => "Preprint text. " + "content ".repeat(200),
        adapter: europePmc.adapter,
      };
      const out = await fetchFulltext({ id: "PPR123456" }, cache, fakeClient(), deps);
      expect(out).toMatchObject({ source: "unpaywall", doi: PREPRINT_DOI, format: "pdf" });
      expect(lookup).toHaveBeenCalledWith(PREPRINT_DOI);
      expect(fetchUrl.mock.calls.map(([url]) => url)).toEqual([
        "https://www.ebi.ac.uk/europepmc/webservices/rest/PPR123456/fullTextXML",
        "https://oa.example/preprint.pdf",
      ]);
      // The next call, from the cache, reports the same DOI without asking Europe PMC again.
      expect(await fetchFulltext({ id: "PPR123456" }, cache, fakeClient(), deps)).toMatchObject({ source: "unpaywall", doi: PREPRINT_DOI });
      expect(europePmc.fetch).toHaveBeenCalledTimes(1);
    });

    it("refuses a DOI the caller gave when it isn't the record's, and keeps one the record can't contradict", async () => {
      const lookup = vi.fn(async (): Promise<UnpaywallLookup> => ({ status: "none" }));
      const deps = (adapter: FulltextDeps["adapter"]): FulltextDeps => ({ unpaywall: { lookup } as unknown as UnpaywallClient, fetchUrl: noText, adapter });
      const error = await fetchFulltext({ id: "PPR123456", doi: DOI }, new LRUBackend(), fakeClient(), deps(fakeEuropePmc([{ ...PREPRINT, doi: PREPRINT_DOI }]).adapter)).catch(
        (e: unknown) => e as ResearchApiException,
      );
      expect(error).toMatchObject({ code: "INVALID_INPUT" });
      expect(error.userMessage).toContain(`PPR123456: its record has ${PREPRINT_DOI}`);
      expect(lookup).not.toHaveBeenCalled();
      // A record without a DOI can't contradict it.
      const out = await fetchFulltext({ id: "PPR123456", doi: DOI }, new LRUBackend(), fakeClient(), deps(fakeEuropePmc([PREPRINT]).adapter));
      expect(lookup).toHaveBeenCalledWith(DOI);
      expect(out.doi).toBe(DOI);
    });

    it("carries on as before when the lookup fails or has no adapter to ask", async () => {
      const failing: FulltextDeps["adapter"] = () => ({
        fetch: async () => {
          throw new Error("Europe PMC is down");
        },
      });
      for (const adapter of [failing, noRecords]) {
        const out = await fetchFulltext({ id: "PPR123456" }, new LRUBackend(), fakeClient(), { fetchUrl: noText, adapter });
        expect(out.source).toBe("none");
        expect(out.fulltext).toBeUndefined();
        expect(out.warning).toContain("No full text found, and no abstract is available.");
      }
    });

    it("finds the record a search left in the cache, under the key the adapter stores it by", async () => {
      const cba: Article = { ...PREPRINT, id: "CBA:644599", journal: "Chin Med J", publicationTypes: [], abstract: "The CBA record's abstract." };
      const cache = new LRUBackend();
      cache.setSummary("europepmc:CBA:644599", cba);
      const asked: string[] = [];
      const http: AdapterHttp = { json: (async (url: string) => (asked.push(new URL(url).searchParams.get("query")!), {})) as AdapterHttp["json"], text: async () => "" };
      const out = await fetchFulltext({ id: "CBA:644599", doi: DOI }, cache, fakeClient(), {
        unpaywall: fakeUnpaywall(null),
        fetchUrl: async () => paywalled(),
        adapter: () => new EuropePmcAdapter(http),
      });
      expect(out).toMatchObject({ source: "none", fulltext: "The CBA record's abstract." });
      // The record has no DOI to confirm the one given, so that DOI's own record is looked up; the id's, never.
      expect(asked).toEqual([`DOI:"${DOI}"`]);
    });

    it("uses the record a search just found in the adapter's memory, and otherwise asks Europe PMC for the exact id", async () => {
      const found = {
        hitCount: 1,
        resultList: { result: [{ id: "PPR123456", source: "PPR", title: "A preprint", abstractText: "The preprint's abstract.", pubType: "Preprint" }] },
      };
      const urls: string[] = [];
      const http: AdapterHttp = {
        json: async <T>(url: string): Promise<T> => {
          urls.push(url);
          return found as T;
        },
        text: async () => "",
      };
      const adapter = new EuropePmcAdapter(http);
      await adapter.search({ query: "preprint" });
      const before = urls.length;
      const deps: FulltextDeps = { fetchUrl: noText, adapter: () => adapter };
      expect((await fetchFulltext({ id: "PPR123456" }, new LRUBackend(), fakeClient(), deps)).fulltext).toBe("The preprint's abstract.");
      expect(urls.length).toBe(before);

      // A cold adapter asks for that id alone.
      const cold = new EuropePmcAdapter(http);
      const out = await fetchFulltext({ id: "PPR123456" }, new LRUBackend(), fakeClient(), { fetchUrl: noText, adapter: () => cold });
      expect(out.fulltext).toBe("The preprint's abstract.");
      expect(new URL(urls.at(-1)!).searchParams.get("query")).toBe("EXT_ID:PPR123456 AND SRC:PPR");
    });
  });
});

describe("fetchFulltext — ChinaXiv and RussiaRxiv by their ChinaRxiv id", () => {
  const CN_ID = "chinaxiv-202401.00027";
  const RU_ID = "ru-196201.58177";
  const ORIGINAL = "https://chinaxiv.org/abs/202401.00027";
  const BODY = ("<!-- source-page: 001 -->\n\n# A title\n\n" + "Translated sentence. ".repeat(60)).trim();
  const RECORD: Article = {
    id: CN_ID,
    title: "Gastrointestinal dysfunction",
    authors: ["Li Jing"],
    journal: "ChinaXiv",
    pubDate: "2024-01-03",
    publicationTypes: [],
    database: "chinaxiv",
    originalUrl: ORIGINAL,
    machineTranslated: true,
    abstract: "The complete abstract.",
  };

  /** A stand-in for the ChinaRxiv adapters: `text` is what `/text` answers (null: no text; an Error: the request fails). */
  function fakeChinaRxiv(text: string | null | Error, record?: Article) {
    const fetchText = vi.fn(async (_id: string) => {
      if (text instanceof Error) throw text;
      return text;
    });
    const fetchFull = vi.fn(async (_ids: string[]) => (record ? [record] : []));
    const databases: string[] = [];
    const adapter: FulltextDeps["adapter"] = (database) => {
      databases.push(database);
      return database === "europepmc" ? undefined : { fetch: async () => [], fetchFull, fetchText };
    };
    return { fetchText, fetchFull, databases, adapter };
  }

  it("returns the translated text, and says it is a machine translation with a pointer to the original", async () => {
    const china = fakeChinaRxiv(BODY, RECORD);
    const out = await fetchFulltext({ id: CN_ID }, new LRUBackend(), fakeClient(), { adapter: china.adapter });
    expect(out).toMatchObject({ id: CN_ID, source: "chinarxiv", format: "markdown", fulltext: BODY, truncated: false, totalChars: BODY.length });
    expect(out.doi).toBeUndefined();
    expect(out.warning).toContain("Machine translation into English by ChinaRxiv");
    expect(out.warning).toContain(`against the original at ${ORIGINAL}`);
    expect(china.fetchText).toHaveBeenCalledWith(CN_ID);
    expect([...new Set(china.databases)]).toEqual(["chinaxiv"]);
  });

  it("takes a RussiaRxiv id from the russiarxiv adapter, and a capitalized id as the API writes it", async () => {
    const china = fakeChinaRxiv(BODY, { ...RECORD, id: RU_ID, database: "russiarxiv", originalUrl: "https://www.mathnet.ru/eng/dan27147" });
    const out = await fetchFulltext({ id: ` RU-196201.58177 ` }, new LRUBackend(), fakeClient(), { adapter: china.adapter });
    expect(out.source).toBe("chinarxiv");
    expect(out.warning).toContain("https://www.mathnet.ru/eng/dan27147");
    expect([...new Set(china.databases)]).toEqual(["russiarxiv"]);
    expect(china.fetchText).toHaveBeenCalledWith(RU_ID);
  });

  it("leaves out the translation warning for an English original, and says it when the record couldn't be read", async () => {
    const { machineTranslated: _t, ...english } = RECORD;
    const original = await fetchFulltext({ id: CN_ID }, new LRUBackend(), fakeClient(), { adapter: fakeChinaRxiv(BODY, english).adapter });
    expect(original.source).toBe("chinarxiv");
    expect(original.warning).toBeUndefined();

    const unread = await fetchFulltext({ id: CN_ID }, new LRUBackend(), fakeClient(), { adapter: fakeChinaRxiv(BODY).adapter });
    expect(unread.warning).toContain("Machine translation into English by ChinaRxiv");
    expect(unread.warning).toContain("its originalUrl is in the record literature_fetch returns");
  });

  it("doesn't put the text into the cache, and reads on from the same download with the warning on every part", async () => {
    const china = fakeChinaRxiv(BODY, RECORD);
    const cache = new LRUBackend();
    const deps: FulltextDeps = { adapter: china.adapter, maxChars: 400 };
    const parts: string[] = [];
    let offset: number | undefined = 0;
    while (offset !== undefined) {
      const out = await fetchFulltext({ id: CN_ID, offset }, cache, fakeClient(), deps);
      expect(out.source).toBe("chinarxiv");
      expect(out.warning).toContain("Machine translation");
      parts.push(out.fulltext!);
      offset = out.nextOffset;
    }
    expect(parts.length).toBeGreaterThan(2);
    expect(parts.join("")).toBe(BODY);
    expect(china.fetchText).toHaveBeenCalledTimes(1);
    expect(cache.getFulltext(CN_ID)).toBeNull();
    // Read to the end, it is let go: a new reading asks again.
    await fetchFulltext({ id: CN_ID }, cache, fakeClient(), deps);
    expect(china.fetchText).toHaveBeenCalledTimes(2);
  });

  it("opens the warning with a retraction the record's title marks, ahead of the translation note, on every part and on the fallback", async () => {
    const retracted = { ...RECORD, title: "RETRACTED: Gastrointestinal dysfunction" };
    const china = fakeChinaRxiv(BODY, retracted);
    const deps: FulltextDeps = { adapter: china.adapter, maxChars: 400 };
    let offset: number | undefined = 0;
    let parts = 0;
    while (offset !== undefined) {
      const out: Awaited<ReturnType<typeof fetchFulltext>> = await fetchFulltext({ id: CN_ID, offset }, new LRUBackend(), fakeClient(), deps);
      expect(out.warning, `part ${parts}`).toMatch(/^RETRACTED: this record is flagged "retracted".* Machine translation into English/);
      parts += 1;
      offset = out.nextOffset;
    }
    expect(parts).toBeGreaterThan(2);

    const none = await fetchFulltext({ id: CN_ID }, new LRUBackend(), fakeClient(), { adapter: fakeChinaRxiv(null, retracted).adapter });
    expect(none.source).toBe("none");
    expect(none.warning).toMatch(/^RETRACTED: .* No full text found; returned the abstract only\./);
  });

  it("returns the complete abstract, and says there is no text, when ChinaRxiv has none for the record", async () => {
    const out = await fetchFulltext({ id: CN_ID }, new LRUBackend(), fakeClient(), { adapter: fakeChinaRxiv(null, RECORD).adapter });
    expect(out).toMatchObject({ source: "none", fulltext: "The complete abstract.", truncated: false });
    expect(out.warning).toContain("No full text found; returned the abstract only.");
    expect(out.warning).toContain("ChinaRxiv has no text for this record.");
    expect(out.warning).toContain(`original at ${ORIGINAL}`);
    expect(out.warning).not.toMatch(/cut at 500|wrote this abstract/);
  });

  it("says when the abstract is a search preview, or one ChinaRxiv wrote", async () => {
    const record = { ...RECORD, abstractTruncated: true, machineGeneratedAbstract: true };
    const out = await fetchFulltext({ id: RU_ID }, new LRUBackend(), fakeClient(), { adapter: fakeChinaRxiv(null, record).adapter });
    expect(out.source).toBe("none");
    expect(out.warning).toContain("ChinaRxiv wrote this abstract, not the authors.");
    expect(out.warning).toContain("The abstract is cut at 500 characters");
  });

  it("treats a text of a few characters as none", async () => {
    const out = await fetchFulltext({ id: CN_ID }, new LRUBackend(), fakeClient(), { adapter: fakeChinaRxiv("<!-- source-page: 001 -->", RECORD).adapter });
    expect(out.source).toBe("none");
    expect(out.warning).toContain("ChinaRxiv has no text for this record.");
  });

  it("says what went wrong, and returns the abstract, when the text can't be read", async () => {
    const limited = await fetchFulltext({ id: CN_ID }, new LRUBackend(), fakeClient(), {
      adapter: fakeChinaRxiv(errors.rateLimit(30, "ChinaRxiv"), RECORD).adapter,
    });
    expect(limited).toMatchObject({ source: "none", fulltext: "The complete abstract." });
    expect(limited.warning).toContain("ChinaRxiv rate-limited the request (HTTP 429).");
    const down = await fetchFulltext({ id: CN_ID }, new LRUBackend(), fakeClient(), { adapter: fakeChinaRxiv(new Error("HTTP 503"), RECORD).adapter });
    expect(down.warning).toContain("ChinaRxiv couldn't be reached.");
    // Neither the record nor the text: nothing to return, and no error either.
    const nothing = await fetchFulltext({ id: CN_ID }, new LRUBackend(), fakeClient(), { adapter: fakeChinaRxiv(null).adapter });
    expect(nothing).toMatchObject({ source: "none" });
    expect(nothing.fulltext).toBeUndefined();
    expect(nothing.warning).toContain("No full text found, and no abstract is available. ChinaRxiv has no text for this record.");
  });

  it("goes on to the DOI routes when a DOI was given and ChinaRxiv has no text", async () => {
    const out = await fetchFulltext({ id: CN_ID, doi: DOI }, new LRUBackend(), fakeClient(), {
      adapter: fakeChinaRxiv(null, RECORD).adapter,
      unpaywall: fakeUnpaywall({ doi: DOI, isOa: true, urls: ["https://oa.example/article"] }),
      fetchUrl: async () => htmlResource("<x/>"),
      htmlToMarkdown: async () => LONG_MARKDOWN,
    });
    expect(out).toMatchObject({ source: "unpaywall", doi: DOI });
  });

  it("asks the ChinaRxiv API for exactly the id's text, with the adapter's headers", async () => {
    const urls: string[] = [];
    const http: AdapterHttp = {
      json: async <T>(url: string): Promise<T> => {
        urls.push(url);
        const paper = url.endsWith("/text") ? { id: CN_ID, title: "T", body_md: BODY, word_count: 60 } : { id: CN_ID, title: "T", authors: [], abstract: "Whole.", source: "chinaxiv", source_language: "zh", source_url: ORIGINAL };
        return paper as T;
      },
      text: async () => "",
    };
    const adapter = new ChinaRXivAdapter(http);
    const out = await fetchFulltext({ id: CN_ID }, new LRUBackend(), fakeClient(), { adapter: (database) => (database === "chinaxiv" ? adapter : undefined) });
    expect(out).toMatchObject({ source: "chinarxiv", fulltext: BODY });
    expect(out.warning).toContain(ORIGINAL);
    expect(urls.sort()).toEqual([
      `https://chinarxiv.org/api/v1/papers/${CN_ID}`,
      `https://chinarxiv.org/api/v1/papers/${CN_ID}/text`,
    ]);
  });

  it("never sends an id that isn't a ChinaRxiv id to ChinaRxiv", async () => {
    const adapter = vi.fn();
    for (const id of ["chinaxiv-202401.00027/../../stats", "chinaxiv-202401.00027?x=1", "https://chinarxiv.org/items/chinaxiv-202401.00027", "202401.00027", "chinaxiv-2024.00027"]) {
      await expect(fetchFulltext({ id }, new LRUBackend(), fakeClient(), { adapter })).rejects.toMatchObject({ code: "NOT_FOUND" });
    }
    expect(adapter).not.toHaveBeenCalled();
  });
});

describe("fetchFulltext — the record's standing, said first", () => {
  const NOTICE_ID = "38512453";
  const RETRACTED_TEXT =
    'RETRACTED: this record is flagged "retracted" (as in literature_search): do not use its findings as evidence.';
  /** As a search or fetch leaves it in the cache: publication types and the link to the retraction notice. */
  const RETRACTED: Article = {
    ...ARTICLE,
    publicationTypes: ["Randomized Controlled Trial", "Retracted Publication"],
    corrections: [{ type: "RetractionIn", id: NOTICE_ID }],
  };
  /** As esummary returns it: the types, no abstract, no links. */
  const { abstract: _abstract, ...ESUMMARY } = ARTICLE;
  const oa = (): FulltextDeps => ({
    unpaywall: fakeUnpaywall({ doi: DOI, isOa: true, urls: ["https://oa.example/article"] }),
    fetchUrl: async () => htmlResource("<x/>"),
    htmlToMarkdown: async () => LONG_MARKDOWN,
  });
  const nothing = (): FulltextDeps => ({ unpaywall: fakeUnpaywall(null), fetchUrl: async () => paywalled(), adapter: noRecords });

  it("opens the warning of a text it found when an earlier search or fetch cached the record as retracted, naming the notice", async () => {
    const cache = new LRUBackend();
    cache.setSummary("12345678", RETRACTED);
    const onEsummary = vi.fn();
    const onEfetch = vi.fn();
    const out = await fetchFulltext({ id: "12345678" }, cache, fakeClient({ onEsummary, onEfetch }), oa());
    expect(out).toMatchObject({ source: "unpaywall", doi: DOI });
    expect(out.fulltext).toContain("Methods");
    expect(out.warning).toBe(`${RETRACTED_TEXT} Linked notice: pubmed ${NOTICE_ID} (literature_fetch).`);
    // Nothing was asked for the flag.
    expect(onEsummary).not.toHaveBeenCalled();
    expect(onEfetch).not.toHaveBeenCalled();
  });

  it("reads a record Europe PMC's adapter cached, under its own key, whatever the id is called", async () => {
    // A search through the real adapter leaves its core records in the cache; no stand-in for that key.
    const core = {
      hitCount: 1,
      resultList: {
        result: [
          {
            id: "12345678",
            source: "MED",
            pmid: "12345678",
            doi: DOI,
            title: "Creatine and cognition",
            pubTypeList: { pubType: ["Retracted Publication", "Randomized Controlled Trial"] },
            commentCorrectionList: { commentCorrection: [{ source: "MED", id: NOTICE_ID, type: "Retraction in" }] },
          },
        ],
      },
    };
    const adapter = new EuropePmcAdapter({ json: (async () => core) as AdapterHttp["json"], text: async () => "" });
    const cache = new LRUBackend();
    await adapter.fetch(["12345678"], cache);
    const out = await fetchFulltext({ id: "12345678", doi: DOI }, cache, fakeClient(), oa());
    expect(out.source).toBe("unpaywall");
    expect(out.warning).toBe(`${RETRACTED_TEXT} Linked notice: europepmc ${NOTICE_ID} (literature_fetch).`);
  });

  /** A PDF copy: no landing page to tell from the article, so the abstract isn't needed to read it. */
  const pdf = (): FulltextDeps => ({
    unpaywall: fakeUnpaywall({ doi: DOI, isOa: true, urls: ["https://oa.example/paper.pdf"] }),
    fetchUrl: async (url: string) => pdfResource(new Uint8Array([1]), url),
    pdfToText: async () => "Text. " + "content ".repeat(200),
  });

  it("knows a retraction from the esummary it makes anyway for a PMID given alone, without the notice's id", async () => {
    const cache = new LRUBackend();
    const onEsummary = vi.fn();
    const onEfetch = vi.fn();
    const summary = { ...ESUMMARY, publicationTypes: ["Randomized Controlled Trial", "Retracted Publication"] };
    const out = await fetchFulltext({ id: "12345678" }, cache, fakeClient({ summary, onEsummary, onEfetch }), pdf());
    expect(out).toMatchObject({ source: "unpaywall", format: "pdf" });
    expect(out.warning).toBe(RETRACTED_TEXT);
    // The request the DOI needed, and no other.
    expect(onEsummary).toHaveBeenCalledTimes(1);
    expect(onEfetch).not.toHaveBeenCalled();
    // The warning is the same from the cache, which has the text and the summary.
    expect((await fetchFulltext({ id: "12345678" }, cache, fakeClient(), pdf())).warning).toBe(RETRACTED_TEXT);
  });

  it("gets the notice's id, and an expression of concern, from the efetch that an HTML page's abstract check makes anyway", async () => {
    // An HTML copy is told from a landing page by the abstract, which efetch fetches when no summary has it.
    const onEfetch = vi.fn();
    const cache = new LRUBackend();
    const efetched = { publicationTypes: ["Randomized Controlled Trial", "Retracted Publication"], corrections: [{ type: "RetractionIn" as const, id: NOTICE_ID }, { type: "ExpressionOfConcernIn" as const, id: "42781840" }] };
    const out = await fetchFulltext({ id: "12345678" }, cache, fakeClient({ summary: ESUMMARY, onEfetch, efetched, abstract: "An abstract." }), oa());
    expect(out.source).toBe("unpaywall");
    expect(onEfetch).toHaveBeenCalledTimes(1);
    expect(out.warning!.startsWith(`${RETRACTED_TEXT} Linked notice: pubmed ${NOTICE_ID} (literature_fetch). EXPRESSION OF CONCERN: `)).toBe(true);
    expect(out.warning).toContain("Linked notice: pubmed 42781840");
  });

  it("knows an expression of concern, and the notice's id, from the esummary it makes anyway for a PMID given alone", async () => {
    // esummary's references (see ESUMMARY_REFTYPES in pubmed.ts): PMID 27578231 has no type that marks its expression of concern, only the link.
    const cache = new LRUBackend();
    const summary = { ...ESUMMARY, corrections: [{ type: "ExpressionOfConcernIn" as const, id: "42781840" }] };
    const onEfetch = vi.fn();
    const out = await fetchFulltext({ id: "12345678" }, cache, fakeClient({ summary, onEfetch }), pdf());
    expect(out.source).toBe("unpaywall");
    expect(out.warning).toBe(
      'EXPRESSION OF CONCERN: one is linked to this record (flag "expression-of-concern"): read the notice before relying on its findings. Linked notice: pubmed 42781840 (literature_fetch).',
    );
    expect(onEfetch).not.toHaveBeenCalled();
  });

  it("leaves literature_fetch to load the full record after a text call that cached only esummary's, links included", async () => {
    // The 4e7b932 case: an abstract cached by an earlier search, whose summary expired, next to esummary's record.
    const esummary = {
      result: {
        uids: ["27578231"],
        "27578231": {
          uid: "27578231",
          title: "A trial.",
          pubdate: "2016",
          pubtype: ["Journal Article", "Randomized Controlled Trial"],
          articleids: [{ idtype: "doi", value: DOI }],
          references: [{ refsource: "Int J Gynaecol Obstet. 2026 Sep 24. doi: 10.1002/ijgo.71386.", reftype: "Expression of concern in", pmid: 42781840, note: "" }],
        },
      },
    };
    const efetchXml =
      "<PubmedArticleSet><PubmedArticle><MedlineCitation><PMID>27578231</PMID><Article><Abstract><AbstractText>Abstract.</AbstractText></Abstract></Article>" +
      '<CommentsCorrectionsList><CommentsCorrections RefType="ExpressionOfConcernIn"><PMID>42781840</PMID></CommentsCorrections></CommentsCorrectionsList>' +
      "<MeshHeadingList><MeshHeading><DescriptorName>Humans</DescriptorName></MeshHeading></MeshHeadingList></MedlineCitation></PubmedArticle></PubmedArticleSet>";
    const requested: string[] = [];
    vi.stubGlobal("fetch", async (url: unknown) => {
      requested.push(new URL(String(url)).pathname);
      return new Response(String(url).includes("efetch.fcgi") ? efetchXml : JSON.stringify(esummary), { status: 200 });
    });
    const client = new NcbiClient({ email: "test@example.com" });
    const cache = new LRUBackend();
    cache.setAbstract("27578231", "Abstract.");

    const out = await fetchFulltext({ id: "27578231" }, cache, client, pdf());
    expect(out.warning).toContain("EXPRESSION OF CONCERN");
    expect(out.warning).toContain("Linked notice: pubmed 42781840");
    expect(requested.filter((p) => p.endsWith("efetch.fcgi"))).toEqual([]);
    expect(cache.getSummary("27578231")).toBeNull();

    const fetched = await fetchPubMed({ ids: ["27578231"] }, cache, client);
    expect(requested.filter((p) => p.endsWith("efetch.fcgi"))).toHaveLength(1);
    expect(fetched.articles[0]).toMatchObject({ meshHeadings: ["Humans"], corrections: [{ type: "ExpressionOfConcernIn", id: "42781840" }] });
  });

  it("says nothing of an article whose records carry no flag, and nothing when it knows no record", async () => {
    const plain = await fetchFulltext({ id: "12345678" }, new LRUBackend(), fakeClient({ summary: ESUMMARY }), oa());
    expect(plain.warning).toBeUndefined();
    // A PMID given with its DOI and no cached summary, read from a PDF, whose esummary finds no record: no flag is known.
    const onEsummary = vi.fn();
    const onEfetch = vi.fn();
    const unknown = await fetchFulltext({ id: "12345678", doi: DOI }, new LRUBackend(), fakeClient({ onEsummary, onEfetch }), pdf());
    expect(unknown).toMatchObject({ source: "unpaywall" });
    expect(unknown.warning).toBeUndefined();
    expect(onEsummary).toHaveBeenCalledTimes(1);
    expect(onEfetch).not.toHaveBeenCalled();
  });

  it("opens the fallback's warning with the retraction, from the efetch that fetches the abstract, and completes the cached summary", async () => {
    const cache = new LRUBackend();
    const client = fakeClient({
      summary: ESUMMARY, // esummary: no flag, no links
      abstract: "Abstract from efetch.",
      efetched: { publicationTypes: ["Randomized Controlled Trial", "Retracted Publication"], corrections: [{ type: "RetractionIn", id: NOTICE_ID }] },
    });
    const out = await fetchFulltext({ id: "12345678" }, cache, client, nothing());
    expect(out).toMatchObject({ source: "none", fulltext: "Abstract from efetch." });
    expect(out.warning!.startsWith(`${RETRACTED_TEXT} Linked notice: pubmed ${NOTICE_ID} (literature_fetch). No full text found; returned the abstract only.`)).toBe(true);
    // The summary search and fetch find under the bare PMID now has what efetch added, next to the abstract it cached.
    expect(cache.getAbstract("12345678")).toBe("Abstract from efetch.");
    expect(cache.getSummary("12345678")).toMatchObject({ corrections: [{ type: "RetractionIn", id: NOTICE_ID }], publicationTypes: ["Randomized Controlled Trial", "Retracted Publication"] });
  });

  it("knows the record from efetch alone for a PMID given with its DOI and no cached summary", async () => {
    const cache = new LRUBackend();
    const client = fakeClient({ abstract: "Abstract.", efetched: { corrections: [{ type: "RetractionIn", id: NOTICE_ID }] } });
    const out = await fetchFulltext({ id: "12345678", doi: DOI }, cache, client, nothing());
    expect(out.source).toBe("none");
    expect(out.warning).toContain(`${RETRACTED_TEXT} Linked notice: pubmed ${NOTICE_ID}`);
    // Not a summary: it has no title or authors, so it isn't cached as one.
    expect(cache.getSummary("12345678")).toBeNull();
  });

  it("keeps the esummary record from the bare PMID, so that a later fetch still asks efetch for the links", async () => {
    // Search and fetch skip efetch for a PMID with a cached summary and a cached abstract.
    const cache = new LRUBackend();
    cache.setAbstract("12345678", "Abstract cached by an earlier search, whose summary expired.");
    await fetchFulltext({ id: "12345678" }, cache, fakeClient({ summary: ESUMMARY }), nothing());
    expect(cache.getSummary("12345678")).toBeNull();
    // It is still the fulltext call's own, and gives the DOI to the next call from the cache.
    cache.setFulltext(fulltextCacheKey("unpaywall", DOI), { source: "unpaywall", fulltext: LONG_MARKDOWN, format: "markdown", fetchedAt: Date.now(), doi: DOI });
    expect(await fetchFulltext({ id: "12345678" }, cache, fakeClient(), nothing())).toMatchObject({ source: "unpaywall", doi: DOI });
  });

  it("reports a retraction recorded after the full text was cached, with the cached text", async () => {
    const cache = new LRUBackend();
    const deps = oa();
    expect((await fetchFulltext({ id: "12345678" }, cache, fakeClient({ summary: ESUMMARY }), deps)).warning).toBeUndefined();
    expect(cache.getFulltext(fulltextCacheKey("unpaywall", DOI))?.source).toBe("unpaywall");

    // Weeks later a search finds the article retracted; the text is still the cached one.
    cache.setSummary("12345678", RETRACTED);
    const fetchUrl = vi.fn(async () => paywalled());
    const later = await fetchFulltext({ id: "12345678" }, cache, fakeClient(), { ...deps, fetchUrl });
    expect(later).toMatchObject({ source: "unpaywall", doi: DOI });
    expect(later.fulltext).toContain("Methods");
    expect(later.warning).toBe(`${RETRACTED_TEXT} Linked notice: pubmed ${NOTICE_ID} (literature_fetch).`);
    expect(fetchUrl).not.toHaveBeenCalled();
    // Nothing was stored with the text but the DOI it belongs to: it carries no warning of its own.
    expect(Object.keys(cache.getFulltext(fulltextCacheKey("unpaywall", DOI))!).sort()).toEqual(["doi", "fetchedAt", "format", "fulltext", "source"]);
  });

  it("puts the retraction first, before the other things the warning says, on every part of a text", async () => {
    const cache = new LRUBackend();
    cache.setSummary("12345678", RETRACTED);
    const deps: FulltextDeps = {
      unpaywall: fakeUnpaywall(null),
      proxyPrefix: "https://doi-org.ezproxy.example.edu",
      fetchUrl: async (url: string) => (url.includes("ezproxy") ? htmlResource("<html/>", url) : paywalled()),
      htmlToMarkdown: async () => LONG_MARKDOWN,
      maxChars: 1000,
    };
    let offset: number | undefined = 0;
    let parts = 0;
    while (offset !== undefined) {
      const out: Awaited<ReturnType<typeof fetchFulltext>> = await fetchFulltext({ id: "12345678", offset }, cache, fakeClient(), deps);
      expect(out.source).toBe("proxy");
      expect(out.warning, `part ${parts}`).toContain(RETRACTED_TEXT);
      parts += 1;
      offset = out.nextOffset;
    }
    expect(parts).toBeGreaterThan(2);

    // And first of those the fallback says, also when no text is returned for an offset.
    const fallback = await fetchFulltext({ id: "12345678", doi: DOI, offset: 5 }, cache, fakeClient(), nothing());
    expect(fallback.warning!.startsWith(RETRACTED_TEXT)).toBe(true);
    expect(fallback.warning).toContain("No full text found, so there is no part from offset 5");
  });

  it("says that a record is a notice, and which kind, and warns of an expression of concern with its notice", async () => {
    const notice = (type: string): Article => ({ ...ARTICLE, title: "Notice", publicationTypes: [type] });
    for (const [type, kind] of [
      ["Retraction Notice", "a retraction notice"],
      ["Retraction of Publication", "a retraction notice"],
      ["Expression of Concern", "an expression of concern"],
      ["Published Erratum", "an erratum"],
    ] as const) {
      const cache = new LRUBackend();
      cache.setSummary("12345678", notice(type));
      const out = await fetchFulltext({ id: "12345678" }, cache, fakeClient(), oa());
      expect(out.warning, type).toBe(`NOTICE: this record is ${kind} (flag "notice"), not a study: its text is no evidence for a claim.`);
    }

    const cache = new LRUBackend();
    cache.setSummary("12345678", { ...ARTICLE, corrections: [{ type: "ExpressionOfConcernIn", id: "42781840" }, { type: "ErratumIn" }] });
    const out = await fetchFulltext({ id: "12345678" }, cache, fakeClient(), oa());
    expect(out.warning).toBe(
      'EXPRESSION OF CONCERN: one is linked to this record (flag "expression-of-concern"): read the notice before relying on its findings. Linked notice: pubmed 42781840 (literature_fetch).',
    );
  });

  it("counts a retraction one record has for the article, and doesn't repeat itself or name a notice twice", async () => {
    const cache = new LRUBackend();
    // The bare key and Europe PMC's: one lacks the flag, both link the same notice.
    cache.setSummary("12345678", { ...ARTICLE, corrections: [{ type: "ExpressionOfConcernIn", id: "42781840" }] });
    cache.setSummary("europepmc:12345678", { ...RETRACTED, database: "europepmc", corrections: [{ type: "RetractionIn", id: NOTICE_ID }, { type: "RetractionIn", id: NOTICE_ID }] });
    const out = await fetchFulltext({ id: "12345678" }, cache, fakeClient(), oa());
    expect(out.warning).toBe(
      `${RETRACTED_TEXT} Linked notice: europepmc ${NOTICE_ID} (literature_fetch). ` +
        'EXPRESSION OF CONCERN: one is linked to this record (flag "expression-of-concern"): read the notice before relying on its findings. Linked notice: pubmed 42781840 (literature_fetch).',
    );
  });

  it("knows the record of a preprint or PMC id from Europe PMC's lookup, on the fallback, and from a cached one on the success path", async () => {
    const preprint: Article = {
      ...ARTICLE,
      id: "PPR123456",
      publicationTypes: ["Preprint"],
      database: "europepmc",
      corrections: [{ type: "RetractionIn", id: "PPR654321" }],
    };
    const noText = async (url: string): Promise<FetchedResource> => ({ ok: false, status: 404, contentType: "text/html", finalUrl: url });
    const europePmc = fakeEuropePmc([{ ...preprint, doi: undefined }]);
    const looked = await fetchFulltext({ id: "PPR123456" }, new LRUBackend(), fakeClient(), { fetchUrl: noText, adapter: europePmc.adapter });
    expect(looked.source).toBe("none");
    expect(looked.warning!.startsWith(`${RETRACTED_TEXT} Linked notice: europepmc PPR654321 (literature_fetch). No full text found; returned the abstract only.`)).toBe(true);

    // Europe PMC has the text: the record is asked for beside it when no cache holds it, and not when one does.
    const jats = async (url: string): Promise<FetchedResource> => ({ ...htmlResource("<article/>", url), contentType: "application/xml" });
    const success = (adapter: FulltextDeps["adapter"], cache: LRUBackend) =>
      fetchFulltext({ id: "PPR123456" }, cache, fakeClient(), { fetchUrl: jats, jatsToMarkdown: async () => LONG_MARKDOWN, adapter });
    const cold = fakeEuropePmc([preprint]);
    const without = await success(cold.adapter, new LRUBackend());
    expect(without.source).toBe("europepmc");
    expect(without.warning!.startsWith(`${RETRACTED_TEXT} Linked notice: europepmc PPR654321 (literature_fetch).`)).toBe(true);
    expect(cold.fetch).toHaveBeenCalledTimes(1);
    const cache = new LRUBackend();
    cache.setSummary("europepmc:PPR123456", preprint);
    expect((await success(cold.adapter, cache)).warning).toContain(RETRACTED_TEXT);
    expect(cold.fetch).toHaveBeenCalledTimes(1);
  });
});

describe("fetchFulltext — a PMCID given alone, whose record no search cached under it", () => {
  // Europe PMC's record of PMC12905075 (checked 2026-11-16): PMID 41695609, retracted, notice 42205309.
  const PMCID = "PMC12905075";
  const PMC_URL = `https://www.ebi.ac.uk/europepmc/webservices/rest/${PMCID}/fullTextXML`;
  const retracted: Article = {
    id: "41695609",
    title: "A retracted trial",
    authors: [],
    journal: "SAGE Open Nurs",
    pubDate: "2026",
    publicationTypes: ["Retracted Publication", "research-article", "Journal Article"],
    database: "europepmc",
    pmcid: PMCID,
    corrections: [{ type: "RetractionIn", id: "42205309" }],
  };
  const WARNING_START =
    'RETRACTED: this record is flagged "retracted" (as in literature_search): do not use its findings as evidence. Linked notice: europepmc 42205309 (literature_fetch).';
  const jats = (url: string): FetchedResource => ({ ...htmlResource("<article/>", url), contentType: "application/xml" });
  /** An adapter that answers by PMCID, as Europe PMC's `PMCID:` query does, with the record under its PMID. */
  const byPmcid = (answer: (ids: string[]) => Promise<Article[]> = async (ids) => (ids[0] === PMCID ? [retracted] : [])) => {
    const fetch = vi.fn(answer);
    const adapter: FulltextDeps["adapter"] = () => ({ fetch });
    return { fetch, adapter };
  };
  const deps = (adapter: FulltextDeps["adapter"], fetchUrl: FulltextDeps["fetchUrl"] = async (url) => jats(url)): FulltextDeps => ({
    fetchUrl,
    jatsToMarkdown: async () => LONG_MARKDOWN,
    adapter,
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("opens the warning of the text with the retraction, from Europe PMC's record of the PMCID asked for beside the text's request", async () => {
    const europePmc = byPmcid();
    // The text's request ends only once the record has been asked for: the two run side by side, not one after the other.
    let asked!: () => void;
    const recordAsked = new Promise<void>((resolve) => (asked = resolve));
    europePmc.fetch.mockImplementation(async () => {
      asked();
      return [retracted];
    });
    const fetchUrl = vi.fn(async (url: string) => {
      await recordAsked;
      return jats(url);
    });
    // A search left the record in the cache under its PMID, where a PMCID doesn't find it.
    const cache = new LRUBackend();
    cache.setSummary("41695609", retracted);
    const out = await fetchFulltext({ id: PMCID }, cache, fakeClient(), deps(europePmc.adapter, fetchUrl));
    expect(out).toMatchObject({ source: "europepmc", format: "markdown", truncated: false });
    expect(out.fulltext).toContain("word");
    expect(out.warning).toBe(WARNING_START);
    expect(fetchUrl.mock.calls.map(([url]) => url)).toEqual([PMC_URL]);
    expect(europePmc.fetch.mock.calls.map(([ids]) => ids)).toEqual([[PMCID]]);
  });

  it("asks for the record once: the next call, with the text cached, finds it under the PMCID", async () => {
    const europePmc = byPmcid();
    const cache = new LRUBackend();
    const fetchUrl = vi.fn(async (url: string) => jats(url));
    const d = deps(europePmc.adapter, fetchUrl);
    expect((await fetchFulltext({ id: PMCID }, cache, fakeClient(), d)).warning).toBe(WARNING_START);
    const again = await fetchFulltext({ id: PMCID }, cache, fakeClient(), d);
    expect(again.warning).toBe(WARNING_START);
    expect(fetchUrl).toHaveBeenCalledTimes(1);
    expect(europePmc.fetch).toHaveBeenCalledTimes(1);
    // Later parts of the text are the same article: nothing is asked for them either.
    const part = await fetchFulltext({ id: PMCID, offset: 100, maxChars: 200 }, cache, fakeClient(), d);
    expect(part.warning).toBe(WARNING_START);
    expect(europePmc.fetch).toHaveBeenCalledTimes(1);
  });

  it("asks for nothing when the cache already holds a record of the PMCID, and says nothing of one without a flag", async () => {
    const europePmc = byPmcid();
    const cache = new LRUBackend();
    cache.setSummary(PMCID, retracted);
    expect((await fetchFulltext({ id: PMCID }, cache, fakeClient(), deps(europePmc.adapter))).warning).toBe(WARNING_START);
    expect(europePmc.fetch).not.toHaveBeenCalled();

    const plain = byPmcid(async () => [{ ...retracted, publicationTypes: ["Journal Article"], corrections: [] }]);
    const out = await fetchFulltext({ id: PMCID }, new LRUBackend(), fakeClient(), deps(plain.adapter));
    expect(out.source).toBe("europepmc");
    expect(out.warning).toBeUndefined();
    expect(plain.fetch).toHaveBeenCalledTimes(1);
  });

  it("opens the fallback's warning too, with the one lookup serving the DOI and the abstract", async () => {
    const europePmc = byPmcid();
    const out = await fetchFulltext({ id: PMCID }, new LRUBackend(), fakeClient(), {
      ...deps(europePmc.adapter, async (url) => ({ ok: false, status: 404, contentType: "text/html", finalUrl: url })),
      unpaywall: fakeUnpaywall(null),
    });
    expect(out.source).toBe("none");
    expect(out.warning!.startsWith(`${WARNING_START} No full text found, and no abstract is available.`)).toBe(true);
    expect(europePmc.fetch).toHaveBeenCalledTimes(1);
  });

  it("returns the text unchanged when the lookup fails or finds no record", async () => {
    for (const adapter of [byPmcid(async () => Promise.reject(new Error("Europe PMC is down"))).adapter, byPmcid(async () => []).adapter, noRecords]) {
      const out = await fetchFulltext({ id: PMCID }, new LRUBackend(), fakeClient(), deps(adapter));
      expect(out).toMatchObject({ source: "europepmc", truncated: false });
      expect(out.fulltext).toContain("word");
      expect(out.warning).toBeUndefined();
    }
  });

  it(`waits for a lookup that doesn't answer no longer than ${STANDING_WAIT_MS} ms from the call's start, and then returns the text without a warning`, async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const europePmc = byPmcid(() => new Promise<Article[]>(() => {}));
    const call = fetchFulltext({ id: PMCID }, new LRUBackend(), fakeClient(), deps(europePmc.adapter));
    let settled = false;
    void call.then(() => (settled = true));
    await vi.advanceTimersByTimeAsync(STANDING_WAIT_MS - 1);
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    const out = await call;
    expect(settled).toBe(true);
    expect(out).toMatchObject({ source: "europepmc", truncated: false });
    expect(out.warning).toBeUndefined();
  });

  it("doesn't hold a text back for a lookup that has answered, and leaves its wait's timer cleared", async () => {
    const set = vi.spyOn(globalThis, "setTimeout");
    const clear = vi.spyOn(globalThis, "clearTimeout");
    try {
      const europePmc = byPmcid();
      const started = Date.now();
      const out = await fetchFulltext({ id: PMCID }, new LRUBackend(), fakeClient(), deps(europePmc.adapter));
      expect(out.warning).toBe(WARNING_START);
      expect(Date.now() - started).toBeLessThan(STANDING_WAIT_MS);
      const waits = set.mock.results.filter((_, i) => set.mock.calls[i]![1] === STANDING_WAIT_MS).map((r) => r.value);
      expect(waits).toHaveLength(1);
      expect(clear.mock.calls.map(([timer]) => timer)).toContain(waits[0]);
    } finally {
      set.mockRestore();
      clear.mockRestore();
    }
  });

  it("takes the same trouble for a preprint id, whose record a search keeps under the same key", async () => {
    const preprint: Article = { ...retracted, id: "PPR123456", pmcid: undefined };
    const europePmc = byPmcid(async (ids) => (ids[0] === "PPR123456" ? [preprint] : []));
    const out = await fetchFulltext({ id: "PPR123456" }, new LRUBackend(), fakeClient(), deps(europePmc.adapter));
    expect(out.warning).toBe(WARNING_START);
    expect(europePmc.fetch.mock.calls.map(([ids]) => ids)).toEqual([["PPR123456"]]);
  });
});

describe("fetchFulltext — a PMID given with its DOI, whose record no cache holds", () => {
  const PMID = "12345678";
  const NOTICE_ID = "38512453";
  const WARNING_START = `RETRACTED: this record is flagged "retracted" (as in literature_search): do not use its findings as evidence. Linked notice: pubmed ${NOTICE_ID} (literature_fetch).`;
  /** As PubMed's esummary returns it: the types and the correction links, no abstract. */
  const { abstract: _abstract, ...ESUMMARY } = ARTICLE;
  const retracted: Article = { ...ESUMMARY, publicationTypes: ["Journal Article", "Retracted Publication"], corrections: [{ type: "RetractionIn", id: NOTICE_ID }] };

  /** A client whose esummary is `answer` (the retracted record by default), counted. */
  const pubmed = (answer: (ids: string[]) => Promise<Map<string, Article>> = async (ids) => new Map([[ids[0]!, retracted]])) => {
    const esummary = vi.fn(answer);
    const onEfetch = vi.fn();
    const client = { ...fakeClient({ abstract: "Abstract from efetch.", onEfetch }), esummary } as unknown as NcbiClient;
    return { client, esummary, onEfetch };
  };
  const jats = (url: string): FetchedResource => ({ ...htmlResource("<article/>", url), contentType: "application/xml" });

  /** One way for a text, or the abstract in its place, to come back. `source` is the one the call reports. */
  interface Path {
    name: string;
    deps: () => FulltextDeps;
    cached?: boolean;
    source: string;
    /** The fallback's warning goes on after the standing, and its text is the abstract; a text's warning ends with the standing. */
    fallback?: boolean;
  }
  const paths: Path[] = [
    {
      name: "the cached text",
      cached: true,
      source: "unpaywall",
      deps: () => ({ unpaywall: fakeUnpaywall(null), fetchUrl: async () => paywalled(), adapter: noRecords }),
    },
    {
      name: "Unpaywall's copy",
      source: "unpaywall",
      deps: () => ({
        unpaywall: fakeUnpaywall({ doi: DOI, isOa: true, urls: ["https://oa.example/paper.pdf"] }),
        fetchUrl: async (url) => pdfResource(new Uint8Array([1]), url),
        pdfToText: async () => "Text. " + "content ".repeat(200),
      }),
    },
    {
      name: "Unpaywall's PMC copy, fetched through Europe PMC's API",
      source: "unpaywall",
      deps: () => ({
        unpaywall: fakeUnpaywall({ doi: DOI, isOa: true, urls: ["https://pmc.ncbi.nlm.nih.gov/articles/PMC1234567/"] }),
        fetchUrl: async (url) => (url.includes("/PMC1234567/fullTextXML") ? jats(url) : paywalled()),
        jatsToMarkdown: async () => LONG_MARKDOWN,
      }),
    },
    {
      name: "the proxy",
      source: "proxy",
      deps: () => ({
        unpaywall: fakeUnpaywall(null),
        proxyPrefix: "https://doi-org.ezproxy.example.edu",
        fetchUrl: async (url) => (url.includes("ezproxy") ? htmlResource("<html/>", url) : paywalled()),
        htmlToMarkdown: async () => LONG_MARKDOWN,
      }),
    },
    {
      name: "the direct DOI",
      source: "direct",
      deps: () => ({
        unpaywall: fakeUnpaywall(null),
        proxyPrefix: "",
        fetchUrl: async (url) => htmlResource("<html/>", url),
        htmlToMarkdown: async () => LONG_MARKDOWN,
      }),
    },
    {
      name: "the abstract fallback",
      source: "none",
      fallback: true,
      deps: () => ({ unpaywall: fakeUnpaywall(null), proxyPrefix: "", fetchUrl: async () => paywalled(), adapter: noRecords }),
    },
  ];
  const cacheFor = (path: Path): LRUBackend => {
    const cache = new LRUBackend();
    if (path.cached) {
      cache.setFulltext(fulltextCacheKey("unpaywall", DOI), { source: "unpaywall", fulltext: LONG_MARKDOWN, format: "markdown", fetchedAt: Date.now(), doi: DOI });
    }
    return cache;
  };

  it.each(paths)("opens the warning with the retraction on $name, from the esummary read before the text is looked for", async (path) => {
    const { client, esummary } = pubmed();
    const out = await fetchFulltext({ id: PMID, doi: DOI }, cacheFor(path), client, path.deps());
    expect(out.source).toBe(path.source);
    expect(out.doi).toBe(DOI);
    if (path.fallback) {
      expect(out.warning!.startsWith(`${WARNING_START} No full text found; returned the abstract only.`)).toBe(true);
      expect(out.fulltext).toBe("Abstract from efetch.");
    } else {
      expect(out.fulltext).toBeTruthy();
      expect(out.warning).toBe(WARNING_START);
    }
    expect(esummary.mock.calls).toEqual([[[PMID]]]);
  });

  it("reads the record before it asks for the text, and keeps it for the next call", async () => {
    const { client, esummary } = pubmed();
    // The record's DOI and PMCID say where to fetch from, so the text's request comes only after the record's.
    const order: string[] = [];
    esummary.mockImplementation(async (ids: string[]) => {
      order.push("record");
      return new Map([[ids[0]!, retracted]]);
    });
    const fetchUrl = vi.fn(async (url: string) => {
      order.push("text");
      return pdfResource(new Uint8Array([1]), url);
    });
    const cache = new LRUBackend();
    const deps: FulltextDeps = {
      unpaywall: fakeUnpaywall({ doi: DOI, isOa: true, urls: ["https://oa.example/paper.pdf"] }),
      fetchUrl,
      pdfToText: async () => "Text. " + "content ".repeat(200),
    };
    expect((await fetchFulltext({ id: PMID, doi: DOI }, cache, client, deps)).warning).toBe(WARNING_START);
    expect(order).toEqual(["record", "text"]);
    // Under the call's own key, not the bare PMID, which search and fetch keep for records that efetch has completed.
    expect(cache.getSummary(PMID)).toBeNull();
    expect(cache.getSummary(`fulltext:${PMID}`)).toMatchObject({ id: PMID, corrections: [{ type: "RetractionIn", id: NOTICE_ID }] });

    // The next call has the text and the record in the cache: no request for either, the same warning.
    const again = await fetchFulltext({ id: PMID, doi: DOI }, cache, client, deps);
    expect(again.warning).toBe(WARNING_START);
    expect(fetchUrl).toHaveBeenCalledTimes(1);
    expect(esummary).toHaveBeenCalledTimes(1);
    // So do the later parts of the text: the record is the one cached, and asked for no more.
    const later = await fetchFulltext({ id: PMID, doi: DOI, offset: 100, maxChars: 200 }, cache, client, deps);
    expect(later.warning).toBe(WARNING_START);
    expect(esummary).toHaveBeenCalledTimes(1);
  });

  it(`waits for the record before it asks for a text, for it says where to look, but no longer than ${STANDING_WAIT_MS} ms`, async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    try {
      let release!: (found: Map<string, Article>) => void;
      const { client, esummary } = pubmed(() => new Promise((resolve) => (release = resolve)));
      const fetchUrl = vi.fn(async (url: string) => pdfResource(new Uint8Array([1]), url));
      const deps: FulltextDeps = { ...paths[1]!.deps(), fetchUrl };
      const cache = new LRUBackend();
      const call = fetchFulltext({ id: PMID, doi: DOI }, cache, client, deps);
      await vi.advanceTimersByTimeAsync(STANDING_WAIT_MS - 1);
      expect(fetchUrl).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(1);
      // The record is late: the DOI given is used unchecked, and the PMID's record, which can't say that it is the PMID's,
      // doesn't speak for the text, even when it arrives before the text is returned.
      release(new Map([[PMID, retracted]]));
      const out = await call;
      expect(out).toMatchObject({ source: "unpaywall", doi: DOI });
      expect(out.warning).toBeUndefined();
      expect(fetchUrl).toHaveBeenCalledTimes(1);
      expect(esummary).toHaveBeenCalledTimes(1);
      // It is kept for the next call, which has the record, and so the text's warning.
      expect((await fetchFulltext({ id: PMID, doi: DOI }, cache, client, deps)).warning).toBe(WARNING_START);
      expect(esummary).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("waits for the esummary of a PMID given alone as long as it takes, for it has no DOI without it", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    try {
      let release!: (found: Map<string, Article>) => void;
      const { client } = pubmed(() => new Promise((resolve) => (release = resolve)));
      const fetchUrl = vi.fn(async (url: string) => pdfResource(new Uint8Array([1]), url));
      const call = fetchFulltext({ id: PMID }, new LRUBackend(), client, { ...paths[1]!.deps(), fetchUrl });
      await vi.advanceTimersByTimeAsync(10 * STANDING_WAIT_MS);
      expect(fetchUrl).not.toHaveBeenCalled();
      release(new Map([[PMID, retracted]]));
      expect(await call).toMatchObject({ source: "unpaywall", doi: DOI, warning: WARNING_START });
    } finally {
      vi.useRealTimers();
    }
  });

  it("refuses a DOI that is not the one the PMID's record has, naming both, and fetches nothing", async () => {
    const lookup = vi.fn(async (): Promise<UnpaywallLookup> => ({ status: "found", result: { doi: DOI, isOa: true, urls: ["https://oa.example/paper.pdf"] } }));
    const fetchUrl = vi.fn(async (url: string) => pdfResource(new Uint8Array([1]), url));
    const { client } = pubmed(async (ids) => new Map([[ids[0]!, { ...retracted, doi: "10.1000/other" }]]));
    const error = await fetchFulltext({ id: PMID, doi: DOI }, new LRUBackend(), client, {
      unpaywall: { lookup, sharedContact: false } as unknown as UnpaywallClient,
      fetchUrl,
      pdfToText: async () => "Text. " + "content ".repeat(200),
    }).catch((e: unknown) => e as ResearchApiException);
    expect(error).toMatchObject({ code: "INVALID_INPUT", recoverable: true });
    expect(error.userMessage).toContain(DOI);
    expect(error.userMessage).toContain("10.1000/other");
    expect(error.userMessage).toMatch(/Leave out doi/);
    expect(lookup).not.toHaveBeenCalled();
    expect(fetchUrl).not.toHaveBeenCalled();
  });

  it("takes the DOI of the record as the PMID's, whatever its case or form", async () => {
    const lookup = vi.fn(async (): Promise<UnpaywallLookup> => ({ status: "found", result: { doi: DOI, isOa: true, urls: ["https://oa.example/paper.pdf"] } }));
    const deps: FulltextDeps = {
      unpaywall: { lookup, sharedContact: false } as unknown as UnpaywallClient,
      fetchUrl: async (url) => pdfResource(new Uint8Array([1]), url),
      pdfToText: async () => "Text. " + "content ".repeat(200),
    };
    for (const [recorded, given] of [
      [DOI.toUpperCase(), DOI],
      [DOI, `https://doi.org/${DOI.toUpperCase()}`],
      [DOI, `doi:${DOI}`],
    ] as const) {
      const { client } = pubmed(async (ids) => new Map([[ids[0]!, { ...retracted, doi: recorded }]]));
      const out = await fetchFulltext({ id: PMID, doi: given }, new LRUBackend(), client, deps);
      expect(out.source, `${recorded} ${given}`).toBe("unpaywall");
      expect(out.warning, `${recorded} ${given}`).toBe(WARNING_START);
    }
  });

  it("goes on with the DOI given when the record has none, without the record's warning, which isn't the DOI's", async () => {
    const lookup = vi.fn(async (): Promise<UnpaywallLookup> => ({ status: "found", result: { doi: DOI, isOa: true, urls: ["https://oa.example/paper.pdf"] } }));
    const deps: FulltextDeps = {
      unpaywall: { lookup, sharedContact: false } as unknown as UnpaywallClient,
      fetchUrl: async (url) => pdfResource(new Uint8Array([1]), url),
      pdfToText: async () => "Text. " + "content ".repeat(200),
    };
    const { client } = pubmed(async (ids) => new Map([[ids[0]!, { ...retracted, doi: undefined }]]));
    const out = await fetchFulltext({ id: PMID, doi: DOI }, new LRUBackend(), client, deps);
    expect(out).toMatchObject({ source: "unpaywall", doi: DOI });
    expect(lookup).toHaveBeenCalledWith(DOI);
    expect(out.warning).toBeUndefined();
  });

  it.each(paths)("returns what it has on $name when the lookup fails or finds no record, and never throws for it", async (path) => {
    for (const answer of [async () => Promise.reject(new Error("NCBI is down")), async () => new Map<string, Article>()]) {
      const { client, esummary } = pubmed(answer);
      const out = await fetchFulltext({ id: PMID, doi: DOI }, cacheFor(path), client, path.deps());
      expect(out.source).toBe(path.source);
      expect(out.fulltext).toBeTruthy();
      expect(out.warning ?? "").not.toMatch(/RETRACTED/);
      expect(esummary).toHaveBeenCalledTimes(1);
    }
  });

  it("sends no request for the record when the cache holds one, under any of the keys the warning reads", async () => {
    const plain: Article = { ...ESUMMARY, publicationTypes: ["Journal Article"] };
    for (const [key, record] of [
      [PMID, retracted],
      [`europepmc:${PMID}`, { ...retracted, database: "europepmc" as const }],
      [`fulltext:${PMID}`, retracted],
    ] as const) {
      const cache = new LRUBackend();
      cache.setSummary(key, record);
      const { client, esummary } = pubmed();
      const out = await fetchFulltext({ id: PMID, doi: DOI }, cache, client, paths[1]!.deps());
      expect(out.source, key).toBe("unpaywall");
      expect(out.warning, key).toContain("RETRACTED:");
      expect(esummary, key).not.toHaveBeenCalled();
    }
    // A cached record with no flag is a record: it says nothing, and nothing is asked.
    const cache = new LRUBackend();
    cache.setSummary(PMID, plain);
    const { client, esummary } = pubmed();
    const out = await fetchFulltext({ id: PMID, doi: DOI }, cache, client, paths[1]!.deps());
    expect(out.warning).toBeUndefined();
    expect(esummary).not.toHaveBeenCalled();
  });

  it("reads the record for the later parts of a text too, once, since the DOI is checked against it at every call", async () => {
    const { client, esummary } = pubmed();
    const cache = new LRUBackend();
    const out = await fetchFulltext({ id: PMID, doi: DOI, offset: 100, maxChars: 200 }, cache, client, paths[1]!.deps());
    expect(out).toMatchObject({ source: "unpaywall", truncated: true });
    expect(out.warning).toBe(WARNING_START);
    expect(esummary).toHaveBeenCalledTimes(1);
    await fetchFulltext({ id: PMID, doi: DOI, offset: 300, maxChars: 200 }, cache, client, paths[1]!.deps());
    expect(esummary).toHaveBeenCalledTimes(1);
  });

  it("makes the one esummary request for a PMID given without a DOI, as before: its answer is awaited, and is the call's own", async () => {
    const { client, esummary } = pubmed();
    const out = await fetchFulltext({ id: PMID }, new LRUBackend(), client, paths[1]!.deps());
    expect(out).toMatchObject({ source: "unpaywall", doi: DOI });
    expect(out.warning).toBe(WARNING_START);
    expect(esummary.mock.calls).toEqual([[[PMID]]]);

    // A failed request is still an error of the call there, since without it there is no DOI to go on.
    const down = pubmed(async () => Promise.reject(new Error("NCBI is down")));
    await expect(fetchFulltext({ id: PMID }, new LRUBackend(), down.client, paths[1]!.deps())).rejects.toThrow("NCBI is down");
    expect(down.esummary).toHaveBeenCalledTimes(1);
  });

  it("sends no request for the record of a DOI that is not one, a PMID then being treated as given alone", async () => {
    // A url in `doi` is no DOI: the PMID's own esummary supplies it, and is the one request.
    const { client, esummary } = pubmed();
    const out = await fetchFulltext({ id: PMID, doi: "https://example.org/paper" }, new LRUBackend(), client, paths[1]!.deps());
    expect(out).toMatchObject({ source: "unpaywall", doi: DOI });
    expect(esummary).toHaveBeenCalledTimes(1);
  });
});

describe("fetchFulltext — why a full text wasn't found", () => {
  const status = (code: number, finalUrl: string): FetchedResource => ({ ok: false, status: code, contentType: "text/html", finalUrl });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
  });

  it("names the site that refused the request, and the status", async () => {
    const out = await fetchFulltext({ id: "12345678", doi: DOI }, new LRUBackend(), fakeClient({ abstract: "abs" }), {
      unpaywall: fakeUnpaywall(null),
      fetchUrl: async () => status(403, "https://www.publisher.example/article/1"),
    });
    expect(out.warning).toContain("The publisher's site (www.publisher.example) refused access (HTTP 403)");
    expect(out.warning).toContain("https://doi.org/10.1000/xyz123");
  });

  it("says a DOI is unknown to doi.org instead of calling it paywalled", async () => {
    const deps: FulltextDeps = { unpaywall: fakeUnpaywall(null), fetchUrl: async (url: string) => status(404, url), adapter: noRecords };
    const out = await fetchFulltext({ id: "12345678", doi: DOI }, new LRUBackend(), fakeClient({ abstract: "abs" }), deps);
    expect(out.source).toBe("none");
    expect(out.warning).toContain("doi.org has no record of DOI 10.1000/xyz123");
    expect(out.warning).not.toMatch(/paywalled|PROXY_PREFIX/);

    // With no abstract to return either, the DOI is reported as not found.
    await expect(fetchFulltext({ id: "CBA:1", doi: DOI }, new LRUBackend(), fakeClient(), deps)).rejects.toMatchObject({
      code: "NOT_FOUND",
      message: expect.stringContaining("10.1000/xyz123"),
    });
  });

  it("says Unpaywall failed, not that it found nothing, and points a client error at the shared address", async () => {
    const out = await fetchFulltext({ id: "12345678", doi: DOI }, new LRUBackend(), fakeClient({ abstract: "abs" }), {
      unpaywall: answeringUnpaywall({ status: "failed", httpStatus: 429 }, true),
      fetchUrl: async (url: string) => status(403, url),
    });
    expect(out.warning).toContain("Unpaywall rate-limited the lookup (HTTP 429), so open-access copies weren't looked up.");
    expect(out.warning).toContain("set your own in NCBI_EMAIL or MED_RESEARCH_UNPAYWALL_EMAIL");
    expect(out.warning).not.toContain("Unpaywall found no open-access copy");
  });

  it("says Unpaywall couldn't be reached, without blaming the address", async () => {
    const out = await fetchFulltext({ id: "12345678", doi: DOI }, new LRUBackend(), fakeClient({ abstract: "abs" }), {
      unpaywall: answeringUnpaywall({ status: "failed" }, true),
      fetchUrl: async (url: string) => status(403, url),
    });
    expect(out.warning).toContain("Unpaywall couldn't be reached, so open-access copies weren't looked up.");
    expect(out.warning).not.toContain("shared contact address");
  });

  it("doesn't lend the project's address to another tool's default Unpaywall client", async () => {
    for (const name of ["MED_RESEARCH_UNPAYWALL", "MED_RESEARCH_UNPAYWALL_EMAIL", "NCBI_EMAIL"]) vi.stubEnv(name, "");
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const out = await fetchFulltext({ id: "12345678", doi: DOI }, new LRUBackend(), fakeClient({ abstract: "abs", tool: "other-app" }), {
      fetchUrl: async (url: string) => status(403, url),
    });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(out.warning).toContain("Open-access copies weren't looked up: Unpaywall is turned off (MED_RESEARCH_UNPAYWALL=0) or has no contact email.");
  });
});

describe("fulltext cache TTL", () => {
  it("returns fresh cached full text", () => {
    const cache = new LRUBackend();
    const data = { source: "direct", fulltext: "y", format: "markdown" as const, fetchedAt: Date.now() };
    cache.setFulltext("1", data);
    expect(cache.getFulltext("1")).toEqual(data);
  });

  it("expires cached full text older than the TTL", () => {
    const cache = new LRUBackend();
    cache.setFulltext("1", {
      source: "unpaywall",
      fulltext: "x",
      format: "markdown",
      fetchedAt: Date.now() - (FULLTEXT_TTL_MS + 1000),
    });
    expect(cache.getFulltext("1")).toBeNull();
  });
});

describe("UnpaywallClient", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
  });

  it("sends the project's contact address when no email is set", async () => {
    vi.stubEnv("MED_RESEARCH_UNPAYWALL_EMAIL", "");
    vi.stubEnv("NCBI_EMAIL", "");
    const urls: string[] = [];
    vi.stubGlobal("fetch", async (url: string) => {
      urls.push(url);
      return new Response(JSON.stringify({ doi: "10.1/x", is_oa: false, oa_locations: [] }), { status: 200 });
    });

    await new UnpaywallClient().resolve("10.1/x");
    expect(urls[0]).toContain(`email=${encodeURIComponent(PROJECT_CONTACT_EMAIL)}`);
  });

  it("falls back to NCBI_EMAIL when MED_RESEARCH_UNPAYWALL_EMAIL is empty (a blank .mcpb field)", async () => {
    vi.stubEnv("MED_RESEARCH_UNPAYWALL_EMAIL", "");
    vi.stubEnv("NCBI_EMAIL", "ncbi@example.com");
    const urls: string[] = [];
    vi.stubGlobal("fetch", async (url: string) => {
      urls.push(url);
      return new Response(JSON.stringify({ doi: "10.1/x", is_oa: false, oa_locations: [] }), { status: 200 });
    });

    const client = new UnpaywallClient();
    await client.resolve("10.1/x");
    expect(urls[0]).toContain("email=ncbi%40example.com");
  });

  it("resolves a DOI to its OA URLs, PDF-first and deduped", async () => {
    const payload = {
      doi: "10.1/x",
      is_oa: true,
      best_oa_location: { url: "https://pmc/article", url_for_pdf: "https://pmc/article.pdf" },
      oa_locations: [
        { url: "https://pmc/article", url_for_pdf: "https://pmc/article.pdf" },
        { url: "https://repo/paper" },
      ],
    };
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(JSON.stringify(payload), { status: 200 })),
    );

    const client = new UnpaywallClient({ email: "a@b.com" });
    const res = await client.resolve("10.1/x");
    expect(res?.urls).toEqual(["https://pmc/article.pdf", "https://pmc/article", "https://repo/paper"]);
  });

  it("returns null when Unpaywall reports no OA copy", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(JSON.stringify({ doi: "10.1/x", is_oa: false, best_oa_location: null, oa_locations: [] }), { status: 200 })),
    );
    const client = new UnpaywallClient({ email: "a@b.com" });
    expect(await client.resolve("10.1/x")).toBeNull();
  });

  it("returns null on an HTTP error", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("not found", { status: 404 })),
    );
    const client = new UnpaywallClient({ email: "a@b.com" });
    expect(await client.resolve("10.1/x")).toBeNull();
  });

  it("treats a placeholder the MCP host left unfilled as unset", async () => {
    vi.stubEnv("MED_RESEARCH_UNPAYWALL_EMAIL", "${user_config.unpaywallEmail}");
    vi.stubEnv("NCBI_EMAIL", "${user_config.ncbiEmail}");
    const urls: string[] = [];
    vi.stubGlobal("fetch", async (url: string) => {
      urls.push(url);
      return new Response(JSON.stringify({ doi: "10.1/x", is_oa: false, oa_locations: [] }), { status: 200 });
    });
    await new UnpaywallClient().resolve("10.1/x");
    expect(urls[0]).toContain(`email=${encodeURIComponent(PROJECT_CONTACT_EMAIL)}`);
  });

  it("is off with MED_RESEARCH_UNPAYWALL=0 or a blank email in code, and sends nothing", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    vi.stubEnv("MED_RESEARCH_UNPAYWALL", "0");
    vi.stubEnv("NCBI_EMAIL", "ncbi@example.com");
    const off = new UnpaywallClient();
    expect(off.configured).toBe(false);
    expect(await off.lookup("10.1/x")).toEqual({ status: "off" });
    expect(await off.resolve("10.1/x")).toBeNull();
    expect(new UnpaywallClient({ email: "" }).configured).toBe(false);
    expect(fetchMock).not.toHaveBeenCalled();
    // An email passed in code turns the lookups back on.
    expect(new UnpaywallClient({ email: "a@b.com" }).configured).toBe(true);
  });

  it("sends the project's address only for its own tool", () => {
    vi.stubEnv("MED_RESEARCH_UNPAYWALL_EMAIL", "");
    vi.stubEnv("NCBI_EMAIL", "");
    expect(new UnpaywallClient().sharedContact).toBe(true);
    expect(new UnpaywallClient({ tool: "other-app" }).configured).toBe(false);
  });

  it("tells a failed lookup apart from one without copies", async () => {
    const client = new UnpaywallClient({ email: "a@b.com" });
    vi.stubGlobal("fetch", vi.fn(async () => new Response("slow down", { status: 429 })));
    expect(await client.lookup("10.1/x")).toEqual({ status: "failed", httpStatus: 429 });
    vi.stubGlobal("fetch", vi.fn(async () => Promise.reject(new TypeError("fetch failed"))));
    expect(await client.lookup("10.1/x")).toEqual({ status: "failed" });
    vi.stubGlobal("fetch", vi.fn(async () => new Response("not found", { status: 404 })));
    expect(await client.lookup("10.1/x")).toEqual({ status: "none" });
  });

  it("reuses an answer for the same DOI, but asks again after a failure", async () => {
    const answering = vi.fn(async () => new Response(JSON.stringify({ doi: "10.1/x", is_oa: false, oa_locations: [] }), { status: 200 }));
    vi.stubGlobal("fetch", answering);
    const client = new UnpaywallClient({ email: "a@b.com" });
    await client.lookup("10.1/X");
    await client.lookup("10.1/x");
    expect(answering).toHaveBeenCalledTimes(1);

    const failing = vi.fn(async () => new Response("", { status: 503 }));
    vi.stubGlobal("fetch", failing);
    await client.lookup("10.1/y");
    await client.lookup("10.1/y");
    expect(failing).toHaveBeenCalledTimes(2);
  });
});

describe("default extraction (real libraries)", () => {
  it("converts a JATS article to markdown: sections, lists, tables row by row, one form per formula", async () => {
    const filler = "Adults aged 18 to 65 were randomised to creatine or placebo and followed for six weeks. ".repeat(6);
    const xml = String.raw`<?xml version="1.0" encoding="UTF-8"?>
      <article xmlns:mml="http://www.w3.org/1998/Math/MathML"><front><article-meta>
        <title-group><article-title>Creatine and <italic>cognition</italic></article-title></title-group>
        <abstract><p>Background text.</p><p>Results: 38 participants.</p></abstract>
      </article-meta></front>
      <body>
        <sec><title>Methods</title><p>We randomised 38 adults. ${filler}</p>
          <sec><title>Outcomes</title><list><list-item><p>Memory</p></list-item><list-item><p>Speed</p></list-item></list></sec>
          <p>Doses are shown below.
            <table-wrap><label>Table 1.</label><caption><p>Baseline characteristics</p></caption>
              <table><thead><tr><th>Group</th><th>Age (yrs)</th></tr></thead>
                <tbody><tr><td>Creatine</td><td>6–11</td></tr><tr><td>Placebo</td><td>97.2</td></tr></tbody></table>
            </table-wrap>
          </p>
          <p>Power was <inline-formula><alternatives>
            <tex-math>\documentclass[12pt]{minimal}\usepackage{amsmath}\begin{document}$1-\beta = 0.8$\end{document}</tex-math>
            <mml:math><mml:mn>1</mml:mn><mml:mo>-</mml:mo><mml:mi>β</mml:mi></mml:math>
          </alternatives></inline-formula> overall.</p>
        </sec>
      </body>
      <back><ref-list><ref><mixed-citation>Smith J. Not in the output.</mixed-citation></ref></ref-list></back></article>`;
    const md = await defaultJatsToMarkdown(xml);
    expect(md.startsWith("# Creatine and cognition\n\n## Abstract\n\nBackground text.\n\nResults: 38 participants.\n\n## Methods")).toBe(true);
    expect(md).toContain("### Outcomes\n\n- Memory\n\n- Speed");
    expect(md).toContain(
      "Doses are shown below.\n\n*Table 1. Baseline characteristics*\n\n| Group | Age (yrs) |\n| --- | --- |\n| Creatine | 6–11 |\n| Placebo | 97.2 |",
    );
    expect(md).toContain("Power was $1-\\beta = 0.8$ overall.");
    expect(md).not.toContain("documentclass");
    expect(md).not.toContain("Not in the output");
  });

  it("leaves out Europe PMC's reference-list section and headings over nothing", async () => {
    // The shape of PMC11944689's back sections, which 0.6.0 printed as "## References\n\n## Associated Data" (2026-10-22).
    const filler = "Creatine monohydrate was taken at 5 g/day for thirteen weeks alongside resistance training. ".repeat(8);
    const xml = `<?xml version="1.0" encoding="UTF-8"?>
      <article><front><article-meta><title-group><article-title>Creatine and lean mass</article-title></title-group></article-meta></front>
      <body>
        <sec><title>Methods</title><p>${filler}</p></sec>
        <sec sec-type="ref-list"><title>References</title><sec><ref-list><ref><label>1.</label>
          <mixed-citation><named-content content-type="citation-string">Spahillari A. Not in the output.</named-content></mixed-citation></ref></ref-list></sec></sec>
        <sec sec-type="associated-data"><title>Associated Data</title>
          <sec sec-type="supplementary-materials"><title>Supplementary Materials</title>
            <supplementary-material><media href="nutrients-17-01081-s001.zip"/></supplementary-material></sec>
          <sec sec-type="data-availability-statement"><title>Data Availability Statement</title><p>Data are available on request.</p></sec>
        </sec>
      </body></article>`;
    const md = await defaultJatsToMarkdown(xml);
    expect(md).not.toContain("References");
    expect(md).not.toContain("Not in the output");
    expect(md).not.toContain("Supplementary Materials");
    expect(md.endsWith("## Associated Data\n\n### Data Availability Statement\n\nData are available on request.")).toBe(true);
  });

  it("includes the OCR text of scanned articles, and returns nothing for an abstract-only article", async () => {
    const meta = `<front><article-meta><title-group><article-title>A 1955 trial</article-title></title-group>
      <abstract><p>${"An abstract long enough to pass for full text on its own. ".repeat(12)}</p></abstract></article-meta></front>`;
    const ocr = "Thirty patients were given the drug for 14 days. ".repeat(12);
    const scanned = await defaultJatsToMarkdown(
      `<article>${meta}<body><preformat preformat-type="pmc-ocr-text">${ocr}</preformat></body></article>`,
    );
    expect(scanned).toContain("Thirty patients were given the drug for 14 days.");
    expect(await defaultJatsToMarkdown(`<article>${meta}<body/></article>`)).toBe("");
  });

  it("reduces an HTML document to its article body and converts it to markdown", async () => {
    const paragraph =
      "<p>Creatine improved memory in a randomized controlled trial with 40 healthy adults over 12 weeks.</p>";
    const html = `<html><body><nav>menu</nav><article><h1>Study Title</h1>${paragraph.repeat(40)}</article><footer>ads</footer></body></html>`;

    const out = await fetchFulltext({ id: "12345678", doi: DOI }, new LRUBackend(), fakeClient(), {
      unpaywall: fakeUnpaywall({ doi: DOI, isOa: true, urls: ["https://oa.example/article"] }),
      fetchUrl: async () => htmlResource(html),
      // htmlToMarkdown left as the real default (jsdom + readability + turndown)
    });

    expect(out.source).toBe("unpaywall");
    expect(out.format).toBe("markdown");
    expect(out.fulltext).toMatch(/Creatine improved memory/);
  });

  it("imports PDFParse from pdf-parse and instantiates it", async () => {
    const { PDFParse } = await import("pdf-parse");
    expect(PDFParse).toBeDefined();
    expect(typeof PDFParse).toBe("function");
  });
});
