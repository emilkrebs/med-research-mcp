import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { defaultJatsToMarkdown, fetchFulltext, fulltextCacheKey, type FetchedResource, type FulltextDeps } from "../src/core/fulltext";
import { ChinaRXivAdapter } from "../src/core/adapters/chinarxiv";
import type { AdapterHttp } from "../src/core/adapters/http";
import { LRUBackend } from "../src/core/cache";
import type { NcbiClient } from "../src/core/pubmed";
import type { UnpaywallClient } from "../src/core/unpaywall";

/**
 * What the text of a full text has in it is cleaned before it is cached or kept for the next part: ChinaRxiv's page
 * markers and empty table rows, the layout noise of a PDF, and the doubled "## Abstract" of a JATS article with two
 * abstracts. `totalChars` and `offset` count the cleaned text, in every part.
 */

const DOI = "10.1000/xyz123";
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

/** No NCBI lookup: the DOI is given, and a PMID that PubMed has no summary of is read as it stands. */
const client = { tool: "med-research-mcp", esummary: async () => new Map(), efetch: async () => new Map() } as unknown as NcbiClient;
const unpaywallOf = (...urls: string[]): UnpaywallClient =>
  ({ lookup: async () => ({ status: "found", result: { doi: DOI, isOa: true, urls } }), sharedContact: false }) as unknown as UnpaywallClient;
const pdfResource = (url: string): FetchedResource => ({ ok: true, status: 200, contentType: "application/pdf", finalUrl: url, bytes: new Uint8Array([1, 2, 3]) });

/** Every part of a text, read through `maxChars`-sized calls the way a model reads it. */
async function readInParts(call: (offset: number) => ReturnType<typeof fetchFulltext>): Promise<{ text: string; totals: number[]; parts: number }> {
  let text = "";
  const totals: number[] = [];
  let parts = 0;
  for (let offset: number | undefined = 0; offset !== undefined; ) {
    const out = await call(offset);
    text += out.fulltext ?? "";
    totals.push(out.totalChars ?? 0);
    parts += 1;
    offset = out.nextOffset;
    if (parts > 200) throw new Error("the text does not end");
  }
  return { text, totals, parts };
}

describe("ChinaXiv and RussiaRxiv text", () => {
  const ID = "ru-196201.58177";
  const SENTENCES = (page: number) => Array.from({ length: 12 }, (_, i) => `Translated sentence ${page}.${i} of a Soviet paper.`).join(" ");
  const BODY = [
    "<!-- source-page: 001 -->",
    "",
    "",
    `# A title\n\n${SENTENCES(1)}`,
    "",
    "<!-- source-page: 002 -->",
    "",
    "",
    `${SENTENCES(2)}\n\n|  |  |\n|---|---|\n| Dose | 5 g |\n|  |  |\n| Placebo | 0 g |`,
    "",
    "<!-- source-page: 003 -->",
    "",
    "",
    SENTENCES(3),
  ].join("\n");
  const CLEAN = `# A title\n\n${SENTENCES(1)}\n\n${SENTENCES(2)}\n\n| Dose | 5 g |\n| Placebo | 0 g |\n\n${SENTENCES(3)}`;
  const http: AdapterHttp = {
    json: async <T>(url: string): Promise<T> =>
      (url.endsWith("/text")
        ? { id: ID, title: "T", body_md: BODY, word_count: 60 }
        : { id: ID, title: "T", authors: [], abstract: "Abstract.", source: "russiarxiv", source_language: "ru" }) as T,
    text: async () => "",
  };
  const deps = (): FulltextDeps => ({ adapter: (database) => (database === "russiarxiv" ? new ChinaRXivAdapter(http) : undefined) });

  it("is returned without the page comments and the empty rows, and totalChars is its length", async () => {
    const out = await fetchFulltext({ id: ID }, new LRUBackend(), client, deps());
    expect(out.source).toBe("chinarxiv");
    expect(out.fulltext).toBe(CLEAN);
    expect(out.totalChars).toBe(CLEAN.length);
    expect(out.truncated).toBe(false);
  });

  it("is read in parts of the cleaned text, with the same totalChars in each", async () => {
    const cache = new LRUBackend();
    const { text, totals, parts } = await readInParts((offset) => fetchFulltext({ id: ID, offset, maxChars: 300 }, cache, client, deps()));
    expect(parts).toBeGreaterThan(3);
    expect(text).toBe(CLEAN);
    expect(new Set(totals)).toEqual(new Set([CLEAN.length]));
    expect(text).not.toContain("source-page");
  });
});

describe("PDF text", () => {
  const BODY_LINES = (page: number) => Array.from({ length: 12 }, (_, i) => `Sentence ${page}.${i} of the preprint's body, as it was written.`);
  /** Four pages as pdf-parse returns them: a licence footer, a numbered margin, page markers, and a table whose cells are numbers. */
  const pages = [0, 1, 2, 3].map((p) => [
    ...BODY_LINES(p).map((line, i) => `${line}\t${12 * p + i + 1}`),
    ...(p === 2 ? ["Characteristic\tCohort\tIS\tHS", "Age\t57.9 (13.2)\t59.3 (12.7)\t55.9 (13.9)", "N\t63\t38\t25"] : []),
    "CC-BY 4.0 International license\tIt is made available under a perpetuity.",
    `Posted October ${p + 1}, 2026`,
  ]);
  const NOISY = pages.map((lines, i) => `${lines.join("\n")}\n\n-- ${i + 1} of ${pages.length} --\n\n`).join("").trim();
  const CLEAN = [
    [...BODY_LINES(0), "CC-BY 4.0 International license\tIt is made available under a perpetuity.", "Posted October 1, 2026"],
    BODY_LINES(1),
    [...BODY_LINES(2), "Characteristic\tCohort\tIS\tHS", "Age\t57.9 (13.2)\t59.3 (12.7)\t55.9 (13.9)", "N\t63\t38\t25"],
    BODY_LINES(3),
  ]
    .map((lines) => lines.join("\n"))
    .join("\n\n");

  const deps = (): FulltextDeps => ({
    adapter: () => undefined,
    unpaywall: unpaywallOf("https://oa.example/paper.pdf"),
    fetchUrl: async (url) => pdfResource(url),
    pdfToText: async () => NOISY,
  });

  it("is returned without the markers, the margin numbers and the footer of every page but the first; the table is whole", async () => {
    const out = await fetchFulltext({ id: "12345678", doi: DOI }, new LRUBackend(), client, deps());
    expect(out).toMatchObject({ source: "unpaywall", format: "pdf", truncated: false });
    expect(out.fulltext).toBe(CLEAN);
    expect(out.totalChars).toBe(CLEAN.length);
    expect(out.fulltext).toContain("Age\t57.9 (13.2)\t59.3 (12.7)\t55.9 (13.9)\nN\t63\t38\t25");
  });

  it("is cached as it is returned, so a cached text reads the same, in parts as well", async () => {
    const cache = new LRUBackend();
    await fetchFulltext({ id: "12345678", doi: DOI }, cache, client, deps());
    expect(cache.getFulltext(fulltextCacheKey("unpaywall", DOI))).toMatchObject({ fulltext: CLEAN, format: "pdf" });
    const failing: FulltextDeps = { ...deps(), pdfToText: async () => { throw new Error("served from the cache"); } };
    const { text, totals } = await readInParts((offset) => fetchFulltext({ id: "12345678", doi: DOI, offset, maxChars: 400 }, cache, client, failing));
    expect(text).toBe(CLEAN);
    expect(new Set(totals)).toEqual(new Set([CLEAN.length]));
  });

  it("is kept for paging as it is returned when it comes from a proxy and isn't cached", async () => {
    const cache = new LRUBackend();
    const proxied: FulltextDeps = { ...deps(), unpaywall: { lookup: async () => ({ status: "none" }), sharedContact: false } as unknown as UnpaywallClient, proxyPrefix: "https://doi-org.ezproxy.example.edu" };
    const { text, totals, parts } = await readInParts((offset) => fetchFulltext({ id: "12345678", doi: DOI, offset, maxChars: 400 }, cache, client, proxied));
    expect(parts).toBeGreaterThan(3);
    expect(text).toBe(CLEAN);
    expect(new Set(totals)).toEqual(new Set([CLEAN.length]));
  });

  it("counts what is left against the shortest a full text may be: a PDF of nothing but noise has none", async () => {
    // Thirty pages of a running header and a margin number each: more than 500 characters as extracted, a line of text once cleaned.
    const noise = Array.from({ length: 30 }, (_, i) => `Journal of Tests running header \tPage ${i + 1} of 30\n\n-- ${i + 1} of 30 --\n\n`).join("").trim();
    expect(noise.length).toBeGreaterThan(500);
    const out = await fetchFulltext({ id: "12345678", doi: DOI }, new LRUBackend(), client, {
      ...deps(),
      pdfToText: async () => noise,
      proxyPrefix: undefined,
    });
    expect(out.source).toBe("none");
    expect(out.warning).toContain("No full text found");
  });
});

describe("JATS text with more than one abstract", () => {
  const FILLER = "Adults aged 18 to 65 were randomised to creatine or placebo and followed for six weeks. ".repeat(8);
  const article = (abstracts: string) =>
    `<article><front><article-meta><title-group><article-title>Why most published research findings are false</article-title></title-group>${abstracts}</article-meta></front>` +
    `<body><sec><title>Introduction</title><p>${FILLER}</p></sec></body></article>`;
  // The two abstracts of PMC1182327 (Ioannidis 2005, a PLOS Medicine essay), as Europe PMC returned them on 2026-11-28, the first cut short.
  const SUMMARY = "There is increasing concern that most current published research findings are false.";
  const TEASER = "Published research findings are sometimes refuted by subsequent evidence, says Ioannidis, with ensuing confusion and disappointment.";

  it("has one Abstract heading over both, and loses no abstract text", async () => {
    const md = await defaultJatsToMarkdown(
      article(`<abstract id="abstract1"><title>Summary</title><p>${SUMMARY}</p></abstract><abstract id="abstract2" abstract-type="toc"><p>${TEASER}</p></abstract>`),
    );
    expect(md.match(/^## Abstract$/gm)).toHaveLength(1);
    expect(md.startsWith(`# Why most published research findings are false\n\n## Abstract\n\n${SUMMARY}\n\n${TEASER}\n\n## Introduction`)).toBe(true);
  });

  it("names a later abstract by its title, as a part of the one Abstract", async () => {
    const md = await defaultJatsToMarkdown(
      article(`<abstract><p>${SUMMARY}</p></abstract><abstract abstract-type="summary"><title>Author Summary</title><p>${TEASER}</p></abstract>`),
    );
    expect(md).toContain(`## Abstract\n\n${SUMMARY}\n\n### Author Summary\n\n${TEASER}\n\n## Introduction`);
    expect(md.match(/^## Abstract$/gm)).toHaveLength(1);
  });

  it("keeps the structure of a structured abstract, and prints no heading over an abstract without text", async () => {
    const structured = await defaultJatsToMarkdown(
      article(`<abstract><sec><title>Background</title><p>${SUMMARY}</p></sec><sec><title>Methods</title><p>${TEASER}</p></sec></abstract>`),
    );
    expect(structured).toContain(`## Abstract\n\n### Background\n\n${SUMMARY}\n\n### Methods\n\n${TEASER}\n\n## Introduction`);
    const empty = await defaultJatsToMarkdown(article(`<abstract/><abstract abstract-type="toc"><p>${TEASER}</p></abstract>`));
    expect(empty).toContain(`## Abstract\n\n${TEASER}\n\n## Introduction`);
    expect(await defaultJatsToMarkdown(article("<abstract/>"))).not.toContain("## Abstract");
  });
});
