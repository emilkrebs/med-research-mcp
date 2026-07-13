import { afterEach, describe, expect, it, vi } from "vitest";
import { fetchFulltext, type FetchedResource, type FulltextDeps } from "../src/core/fulltext";
import { UnpaywallClient, type UnpaywallResult } from "../src/core/unpaywall";
import { FULLTEXT_TTL_MS, LRUBackend } from "../src/core/cache";
import { NcbiClient } from "../src/core/pubmed";
import { ResearchApiException } from "../src/core/errors";
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

/** Long enough to clear MIN_FULLTEXT_CHARS (500). */
const LONG_MARKDOWN = "# Methods\n\n" + "word ".repeat(300);

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
  return { configured: true, resolve: async () => result } as unknown as UnpaywallClient;
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

    const out = await fetchFulltext({ pmid: "12345678" }, cache, client, deps);
    expect(out.source).toBe("unpaywall");
    expect(out.format).toBe("markdown");
    expect(out.doi).toBe(DOI);
    expect(out.truncated).toBe(false);
    expect(out.fulltext).toContain("Methods");

    const out2 = await fetchFulltext({ pmid: "12345678" }, cache, client, deps);
    expect(out2.source).toBe("unpaywall");
    expect(out2.doi).toBe(DOI);
    // Cache hit — the network fetch ran only for the first call.
    expect(fetchUrl).toHaveBeenCalledTimes(1);
  });

  it("falls through to the institutional proxy when Unpaywall misses", async () => {
    const fetchUrl = vi.fn(async (url: string) => (url.includes("ezproxy") ? htmlResource("<html/>", url) : paywalled()));
    const deps: FulltextDeps = {
      unpaywall: fakeUnpaywall(null),
      proxyPrefix: "https://doi-org.ezproxy.uni-kiel.de",
      fetchUrl,
      htmlToMarkdown: async () => LONG_MARKDOWN,
    };

    const out = await fetchFulltext({ pmid: "12345678", doi: DOI }, new LRUBackend(), fakeClient(), deps);
    expect(out.source).toBe("proxy");
    expect(fetchUrl).toHaveBeenCalledWith("https://doi-org.ezproxy.uni-kiel.de/10.1000/xyz123", expect.any(Number));
  });

  it("uses direct DOI access when there is no OA copy and no proxy", async () => {
    const fetchUrl = vi.fn(async (url: string) => (url.startsWith("https://doi.org/") ? htmlResource("<x/>", url) : paywalled()));
    const deps: FulltextDeps = { unpaywall: fakeUnpaywall(null), fetchUrl, htmlToMarkdown: async () => LONG_MARKDOWN };

    const out = await fetchFulltext({ pmid: "12345678", doi: DOI }, new LRUBackend(), fakeClient(), deps);
    expect(out.source).toBe("direct");
    expect(fetchUrl).toHaveBeenCalledWith("https://doi.org/10.1000/xyz123", expect.any(Number));
  });

  it("extracts PDF bytes and flags format 'pdf'", async () => {
    const deps: FulltextDeps = {
      unpaywall: fakeUnpaywall({ doi: DOI, isOa: true, urls: ["https://oa.example/p.pdf"] }),
      fetchUrl: async () => pdfResource(new Uint8Array([1, 2, 3])),
      pdfToText: async () => "Full PDF text. " + "content ".repeat(200),
    };

    const out = await fetchFulltext({ pmid: "12345678", doi: DOI }, new LRUBackend(), fakeClient(), deps);
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
      { pmid: "12345678", doi: DOI },
      new LRUBackend(),
      fakeClient({ abstract: "The full abstract text." }),
      deps,
    );
    expect(out.source).toBe("none");
    expect(out.fulltext).toBe("The full abstract text.");
    expect(out.warning).toMatch(/paywalled/i);
    expect(out.warning).toMatch(/PUBMED_PROXY_PREFIX/);
  });

  it("adjusts the fallback warning when a proxy is already configured", async () => {
    const deps: FulltextDeps = {
      unpaywall: fakeUnpaywall(null),
      proxyPrefix: "https://doi-org.ezproxy.uni-kiel.de",
      fetchUrl: async () => paywalled(),
    };
    const out = await fetchFulltext({ pmid: "12345678", doi: DOI }, new LRUBackend(), fakeClient({ abstract: "abs" }), deps);
    expect(out.source).toBe("none");
    expect(out.warning).not.toMatch(/PUBMED_PROXY_PREFIX/);
  });

  it("treats a sub-threshold extraction as a paywall stub, not full text", async () => {
    const deps: FulltextDeps = {
      unpaywall: fakeUnpaywall({ doi: DOI, isOa: true, urls: ["https://oa.example/a"] }),
      fetchUrl: async () => htmlResource("<x/>"),
      htmlToMarkdown: async () => "Access this article for $39.95",
    };
    const out = await fetchFulltext({ pmid: "12345678", doi: DOI }, new LRUBackend(), fakeClient({ abstract: "abs" }), deps);
    expect(out.source).toBe("none");
  });

  it("truncates text beyond maxChars and flags truncated", async () => {
    const deps: FulltextDeps = {
      unpaywall: fakeUnpaywall({ doi: DOI, isOa: true, urls: ["u"] }),
      fetchUrl: async () => htmlResource("<x/>"),
      htmlToMarkdown: async () => "A".repeat(5000),
      maxChars: 1000,
    };
    const out = await fetchFulltext({ pmid: "12345678", doi: DOI }, new LRUBackend(), fakeClient(), deps);
    expect(out.truncated).toBe(true);
    expect(out.fulltext).toHaveLength(1000);
  });

  it("skips the PMID→DOI lookup when a DOI is supplied", async () => {
    const onEsummary = vi.fn();
    const deps: FulltextDeps = {
      unpaywall: fakeUnpaywall({ doi: DOI, isOa: true, urls: ["u"] }),
      fetchUrl: async () => htmlResource("<x/>"),
      htmlToMarkdown: async () => LONG_MARKDOWN,
    };
    const out = await fetchFulltext({ pmid: "12345678", doi: DOI }, new LRUBackend(), fakeClient({ onEsummary }), deps);
    expect(out.source).toBe("unpaywall");
    expect(onEsummary).not.toHaveBeenCalled();
  });

  it("normalizes a DOI passed as a URL before resolving", async () => {
    const resolve = vi.fn(async () => ({ doi: DOI, isOa: true, urls: ["u"] }));
    const deps: FulltextDeps = {
      unpaywall: { configured: true, resolve } as unknown as UnpaywallClient,
      fetchUrl: async () => htmlResource("<x/>"),
      htmlToMarkdown: async () => LONG_MARKDOWN,
    };
    await fetchFulltext({ pmid: "12345678", doi: "https://doi.org/10.1000/xyz123" }, new LRUBackend(), fakeClient(), deps);
    expect(resolve).toHaveBeenCalledWith(DOI);
  });

  it("throws NOT_FOUND for a non-numeric PMID", async () => {
    await expect(fetchFulltext({ pmid: "not-a-pmid" }, new LRUBackend(), fakeClient())).rejects.toBeInstanceOf(
      ResearchApiException,
    );
  });

  it("throws NOT_FOUND when the PMID has no summary and no DOI", async () => {
    await expect(
      fetchFulltext({ pmid: "99999999" }, new LRUBackend(), fakeClient({ summary: null })),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
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

  it("does not query without a contact email", async () => {
    vi.stubEnv("PUBMED_UNPAYWALL_EMAIL", "");
    vi.stubEnv("NCBI_EMAIL", "");
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);

    const client = new UnpaywallClient();
    expect(client.configured).toBe(false);
    expect(await client.resolve("10.1/x")).toBeNull();
    expect(fetchSpy).not.toHaveBeenCalled();
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
  it("reduces an HTML document to its article body and converts it to markdown", async () => {
    const paragraph =
      "<p>Creatine improved memory in a randomized controlled trial with 40 healthy adults over 12 weeks.</p>";
    const html = `<html><body><nav>menu</nav><article><h1>Study Title</h1>${paragraph.repeat(20)}</article><footer>ads</footer></body></html>`;

    const out = await fetchFulltext({ pmid: "12345678", doi: DOI }, new LRUBackend(), fakeClient(), {
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
