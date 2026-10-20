import { afterEach, describe, expect, it, vi } from "vitest";
import { defaultJatsToMarkdown, fetchFulltext, type FetchedResource, type FulltextDeps } from "../src/core/fulltext";
import { UnpaywallClient, type UnpaywallResult } from "../src/core/unpaywall";
import { FULLTEXT_TTL_MS, LRUBackend } from "../src/core/cache";
import { NcbiClient } from "../src/core/pubmed";
import { PROJECT_CONTACT_EMAIL } from "../src/core/version";
import { ResearchApiException } from "../src/core/errors";
import { BlockedUrlError } from "../src/core/public-fetch";
import type { Article } from "../src/core/types";

const DOI = "10.1000/xyz123";

const ARTICLE: Article = {
  pmid: "12345678",
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
  opts: { summary?: Article | null; abstract?: string; onEsummary?: () => void } = {},
): NcbiClient {
  return {
    esummary: async (pmids: string[]) => {
      opts.onEsummary?.();
      const m = new Map<string, Article>();
      if (opts.summary) m.set(pmids[0]!, opts.summary);
      return m;
    },
    efetch: async (pmids: string[]) => {
      const m = new Map<string, { abstract?: string; publicationTypes: string[] }>();
      m.set(pmids[0]!, { ...(opts.abstract ? { abstract: opts.abstract } : {}), publicationTypes: [] });
      return m;
    },
  } as unknown as NcbiClient;
}

function fakeUnpaywall(result: UnpaywallResult | null): UnpaywallClient {
  return { resolve: async () => result } as unknown as UnpaywallClient;
}

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
  });

  it("skips the id→DOI lookup when a DOI is supplied", async () => {
    const onEsummary = vi.fn();
    const deps: FulltextDeps = {
      unpaywall: fakeUnpaywall({ doi: DOI, isOa: true, urls: ["https://oa.example/u"] }),
      fetchUrl: async () => htmlResource("<x/>"),
      htmlToMarkdown: async () => LONG_MARKDOWN,
    };
    const out = await fetchFulltext({ id: "12345678", doi: DOI }, new LRUBackend(), fakeClient({ onEsummary }), deps);
    expect(out.source).toBe("unpaywall");
    expect(onEsummary).not.toHaveBeenCalled();
  });

  it("normalizes a DOI passed as a URL before resolving", async () => {
    const resolve = vi.fn(async () => ({ doi: DOI, isOa: true, urls: ["https://oa.example/u"] }));
    const deps: FulltextDeps = {
      unpaywall: { resolve } as unknown as UnpaywallClient,
      fetchUrl: async () => htmlResource("<x/>"),
      htmlToMarkdown: async () => LONG_MARKDOWN,
    };
    await fetchFulltext({ id: "12345678", doi: "https://doi.org/10.1000/xyz123" }, new LRUBackend(), fakeClient(), deps);
    expect(resolve).toHaveBeenCalledWith(DOI);
  });

  it("throws NOT_FOUND for a non-numeric id", async () => {
    await expect(fetchFulltext({ id: "not-a-pmid" }, new LRUBackend(), fakeClient())).rejects.toBeInstanceOf(
      ResearchApiException,
    );
  });

  it("explains that a DOI-less record from another database can't be resolved", async () => {
    const error = await fetchFulltext({ id: "chinaxiv-202401.00027" }, new LRUBackend(), fakeClient()).catch(
      (e: unknown) => e as ResearchApiException,
    );
    expect(error).toMatchObject({ code: "NOT_FOUND", recoverable: false });
    expect(error.userMessage).toContain("no DOI");
    expect(error.userMessage).not.toContain("PubMed article");
  });

  it("doesn't ask PubMed for the abstract of another database's id", async () => {
    const efetch = vi.fn();
    const client = { ...fakeClient(), efetch } as unknown as NcbiClient;
    const result = await fetchFulltext({ id: "CBA:521529", doi: DOI }, new LRUBackend(), client, {
      unpaywall: fakeUnpaywall(null),
      fetchUrl: async () => paywalled(),
    });
    expect(result.source).toBe("none");
    expect(efetch).not.toHaveBeenCalled();
  });

  it("throws NOT_FOUND when the id has no summary and no DOI", async () => {
    await expect(
      fetchFulltext({ id: "99999999" }, new LRUBackend(), fakeClient({ summary: null })),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
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
    const resolve = vi.fn();
    const fetchUrl = vi.fn(async (url: string) => jats(url));
    const deps: FulltextDeps = {
      unpaywall: { resolve } as unknown as UnpaywallClient,
      fetchUrl,
      jatsToMarkdown: async () => LONG_MARKDOWN,
    };
    const out = await fetchFulltext({ id: "12345678" }, cache, fakeClient(), deps);
    expect(out).toMatchObject({ source: "europepmc", doi: DOI, format: "markdown" });
    expect(fetchUrl.mock.calls.map(([url]) => url)).toEqual([PMC_URL]);
    expect(resolve).not.toHaveBeenCalled();
    expect((await fetchFulltext({ id: "12345678" }, cache, fakeClient(), deps)).source).toBe("europepmc");
    expect(fetchUrl).toHaveBeenCalledTimes(1);
  });

  it("takes a PMCID as the id, without a DOI", async () => {
    const fetchUrl = vi.fn(async (url: string) => jats(url));
    const out = await fetchFulltext({ id: "pmc7654321" }, new LRUBackend(), fakeClient(), {
      fetchUrl,
      jatsToMarkdown: async () => LONG_MARKDOWN,
    });
    expect(out.source).toBe("europepmc");
    expect(out.doi).toBeUndefined();
    expect(fetchUrl).toHaveBeenCalledWith(PMC_URL, expect.any(Number));
  });

  it("says so when Europe PMC has no open-access text for a PMCID without a DOI", async () => {
    const out = await fetchFulltext({ id: "PMC7654321" }, new LRUBackend(), fakeClient(), {
      fetchUrl: async () => ({ ok: false, status: 404, contentType: "text/html", finalUrl: PMC_URL }),
    });
    expect(out.source).toBe("none");
    expect(out.fulltext).toBeUndefined();
    expect(out.warning).toContain("Europe PMC has no open-access full text for PMC7654321");
  });

  it("doesn't fetch the same Europe PMC text again when Unpaywall lists it too", async () => {
    const cache = new LRUBackend();
    cache.setSummary("12345678", { ...ARTICLE, pmcid: "PMC7654321" });
    const fetchUrl = vi.fn(async () => paywalled());
    await fetchFulltext({ id: "12345678" }, cache, fakeClient(), {
      unpaywall: fakeUnpaywall({ doi: DOI, isOa: true, urls: ["https://www.ncbi.nlm.nih.gov/pmc/articles/7654321"] }),
      fetchUrl,
    });
    expect(fetchUrl.mock.calls.map(([url]) => url)).toEqual([PMC_URL, "https://doi.org/10.1000/xyz123"]);
  });
});

describe("fetchFulltext — why a full text wasn't found", () => {
  const status = (code: number, finalUrl: string): FetchedResource => ({ ok: false, status: code, contentType: "text/html", finalUrl });

  it("names the site that refused the request, and the status", async () => {
    const out = await fetchFulltext({ id: "12345678", doi: DOI }, new LRUBackend(), fakeClient({ abstract: "abs" }), {
      unpaywall: fakeUnpaywall(null),
      fetchUrl: async () => status(403, "https://www.publisher.example/article/1"),
    });
    expect(out.warning).toContain("The publisher's site (www.publisher.example) refused access (HTTP 403)");
    expect(out.warning).toContain("https://doi.org/10.1000/xyz123");
  });

  it("says a DOI is unknown to doi.org instead of calling it paywalled", async () => {
    const deps: FulltextDeps = { unpaywall: fakeUnpaywall(null), fetchUrl: async (url: string) => status(404, url) };
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
