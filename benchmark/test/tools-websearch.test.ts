import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { braveSearch, webFetch, webSearchTools } from "../lib/tools/websearch.js";

function stubFetch(res: Response) {
  const fn = vi.fn(async () => res);
  vi.stubGlobal("fetch", fn);
  return fn;
}

const html = (body: string) =>
  new Response(`<!doctype html><html><head><title>T</title></head><body>${body}</body></html>`, {
    status: 200,
    headers: { "content-type": "text/html; charset=utf-8" },
  });

describe("web_fetch", () => {
  beforeEach(() => {
    process.env.BRAVE_API_KEY = "test";
  });
  afterEach(() => vi.unstubAllGlobals());

  it("is exposed alongside web_search", () => {
    expect(Object.keys(webSearchTools()).sort()).toEqual(["web_fetch", "web_search"]);
  });

  it("converts HTML to markdown", async () => {
    stubFetch(html("<article><h1>Metformin trial</h1><p>" + "Patients improved. ".repeat(40) + "</p></article>"));
    const out = await webFetch("https://example.org/a");
    expect(out.error).toBeUndefined();
    expect(String(out.content)).toContain("Metformin trial");
    expect(String(out.content)).not.toContain("<h1>");
    expect(out.truncated).toBe(false);
  });

  it("rejects non-http URLs without fetching", async () => {
    const fn = stubFetch(html("x"));
    const out = await webFetch("file:///etc/passwd");
    expect(out.error).toMatch(/http/);
    expect(fn).not.toHaveBeenCalled();
  });

  it("truncates long content with a note", async () => {
    stubFetch(html("<article><p>" + "word ".repeat(10_000) + "</p></article>"));
    const out = await webFetch("https://example.org/long");
    expect(out.truncated).toBe(true);
    expect(String(out.content)).toContain("content truncated");
  });

  it("extracts PDF text with the core's pdfToText", async () => {
    vi.doMock("../lib/core.js", async (orig) => ({
      ...(await orig<typeof import("../lib/core.js")>()),
      pdfToText: async () => "Randomized trial of creatine, n=120.",
    }));
    vi.resetModules();
    const { webFetch: fetchWithStub } = await import("../lib/tools/websearch.js");
    stubFetch(new Response("%PDF-1.4 ...", { status: 200, headers: { "content-type": "application/pdf" } }));
    const out = await fetchWithStub("https://example.org/p.pdf");
    expect(out.error).toBeUndefined();
    expect(String(out.content)).toContain("creatine");
    vi.doUnmock("../lib/core.js");
    vi.resetModules();
  });

  it("returns an unparseable PDF as { error }, not a throw", async () => {
    stubFetch(new Response("%PDF-1.4 garbage", { status: 200, headers: { "content-type": "application/pdf" } }));
    const out = await webFetch("https://example.org/broken.pdf");
    expect(out.error).toBeDefined();
  });

  it("returns HTTP errors as { error }", async () => {
    stubFetch(new Response("nope", { status: 404 }));
    const out = await webFetch("https://example.org/missing");
    expect(String(out.error)).toContain("404");
  });

  it("returns network failures as { error }", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => { throw new Error("boom"); }));
    const out = await webFetch("https://example.org/x");
    expect(String(out.error)).toContain("boom");
  });
});

describe("web_search retries", () => {
  const ok = () => new Response(JSON.stringify({ web: { results: [{ title: "T", url: "https://x.org", description: "S" }] } }), { status: 200 });
  const status = (code: number, headers: Record<string, string> = {}) => new Response("", { status: code, headers });

  /** A fetch that serves the given responses in order, and the waits the search asked for. */
  function scripted(responses: (Response | Error)[]) {
    const waits: number[] = [];
    let i = 0;
    const fetch = (async () => {
      const next = responses[i++]!;
      if (next instanceof Error) throw next;
      return next;
    }) as unknown as typeof globalThis.fetch;
    return { deps: { fetch, sleep: async (ms: number) => void waits.push(ms) }, waits, calls: () => i };
  }

  it("returns results at once when Brave answers", async () => {
    const s = scripted([ok()]);
    expect(await braveSearch("q", 6, "key", s.deps)).toEqual({ results: [{ title: "T", url: "https://x.org", snippet: "S" }] });
    expect(s.waits).toEqual([]);
  });

  it("waits out a rate limit instead of telling the model there are no results", async () => {
    const s = scripted([status(429, { "retry-after": "2" }), status(429), ok()]);
    const out = await braveSearch("q", 6, "key", s.deps);
    expect(out.results).toHaveLength(1);
    expect(out.error).toBeUndefined();
    expect(s.waits).toEqual([2000, 2000]); // Retry-After, then 1 s × 2^1
  });

  it("retries server errors and network failures with backoff, and caps a long Retry-After", async () => {
    const s = scripted([status(503, { "retry-after": "600" }), new Error("ECONNRESET"), ok()]);
    expect((await braveSearch("q", 6, "key", s.deps)).results).toHaveLength(1);
    expect(s.waits).toEqual([10_000, 2000]);
  });

  it("gives up after four attempts and reports the failure", async () => {
    const s = scripted([status(429), status(429), status(429), status(429), ok()]);
    expect(await braveSearch("q", 6, "key", s.deps)).toEqual({ error: "Brave Search returned HTTP 429", results: [] });
    expect(s.calls()).toBe(4);
    expect(s.waits).toEqual([1000, 2000, 4000]);
  });

  it("does not retry a request Brave rejects (bad key, bad query)", async () => {
    const s = scripted([status(401), ok()]);
    expect(await braveSearch("q", 6, "key", s.deps)).toEqual({ error: "Brave Search returned HTTP 401", results: [] });
    expect(s.calls()).toBe(1);
  });
});
