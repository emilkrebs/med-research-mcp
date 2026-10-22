import { afterEach, describe, expect, it, vi } from "vitest";
import { requestWithRetries } from "../src/core/request";
import { defaultHttp } from "../src/core/adapters/http";
import { NcbiClient } from "../src/core/pubmed";

const ok = (): Response => new Response(JSON.stringify({ ok: true }), { status: 200 });
const status = (code: number): Response => new Response("<html>gateway</html>", { status: code });
/** A fetch that never answers until its request is aborted. */
const hanging = (_url: string, init?: RequestInit): Promise<Response> =>
  new Promise((_resolve, reject) => init?.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError"))));
const options = { timeoutMs: 15_000, headers: {}, source: "Europe PMC" };

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("requestWithRetries", () => {
  it("retries a 502, 503 or 504 after a short wait", async () => {
    vi.useFakeTimers();
    for (const code of [502, 503, 504]) {
      const responses = [status(code), ok()];
      const fetchMock = vi.fn(async () => responses.shift()!);
      vi.stubGlobal("fetch", fetchMock);
      const pending = requestWithRetries("https://upstream.example/x", options);
      await vi.advanceTimersByTimeAsync(400);
      expect(fetchMock).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(200);
      expect((await pending).status).toBe(200);
      expect(fetchMock).toHaveBeenCalledTimes(2);
    }
  });

  it("gives up after two retries with NETWORK_ERROR, naming the service and the status", async () => {
    vi.useFakeTimers();
    const fetchMock = vi.fn(async () => status(503));
    vi.stubGlobal("fetch", fetchMock);
    const pending = requestWithRetries("https://upstream.example/x", options).catch((e: unknown) => e);
    await vi.advanceTimersByTimeAsync(2000);
    expect(await pending).toMatchObject({ code: "NETWORK_ERROR", recoverable: true, message: "Network error: Europe PMC returned HTTP 503 (attempt 3)" });
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it("doesn't retry a status that won't change, such as 404", async () => {
    const fetchMock = vi.fn(async () => status(404));
    vi.stubGlobal("fetch", fetchMock);
    await expect(requestWithRetries("https://upstream.example/x", options)).rejects.toMatchObject({
      code: "NETWORK_ERROR",
      message: "Network error: Europe PMC returned HTTP 404",
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("retries a dropped connection", async () => {
    vi.useFakeTimers();
    const fetchMock = vi.fn().mockRejectedValueOnce(new TypeError("fetch failed")).mockResolvedValueOnce(ok());
    vi.stubGlobal("fetch", fetchMock);
    const pending = requestWithRetries("https://upstream.example/x", options);
    await vi.advanceTimersByTimeAsync(600);
    expect((await pending).status).toBe(200);
  });

  it("retries a timeout with what is left of the time budget, and no more", async () => {
    vi.useFakeTimers();
    const fetchMock = vi.fn(hanging);
    vi.stubGlobal("fetch", fetchMock);
    const pending = requestWithRetries("https://upstream.example/x", options).catch((e: unknown) => e);
    await vi.advanceTimersByTimeAsync(15_000);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(500);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    // The retry gets the 4.5 s left of the 20 s budget, and the budget allows no third attempt.
    await vi.advanceTimersByTimeAsync(4_500);
    expect(await pending).toMatchObject({ code: "NETWORK_ERROR", message: "Network error: Europe PMC didn't answer within 4.5 s" });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("serves a timeout's retry when it answers", async () => {
    vi.useFakeTimers();
    const fetchMock = vi.fn(hanging).mockImplementationOnce(hanging).mockImplementationOnce(async () => ok());
    vi.stubGlobal("fetch", fetchMock);
    const pending = requestWithRetries("https://upstream.example/x", { ...options, timeoutMs: 5_000 });
    await vi.advanceTimersByTimeAsync(5_500);
    expect((await pending).status).toBe(200);
  });

  it("applies to the adapters' HTTP seam", async () => {
    vi.useFakeTimers();
    const responses = [status(502), ok()];
    vi.stubGlobal("fetch", vi.fn(async () => responses.shift()!));
    const pending = defaultHttp({ source: "Europe PMC" }).json("https://upstream.example/x");
    await vi.advanceTimersByTimeAsync(600);
    await expect(pending).resolves.toEqual({ ok: true });
  });

  it("applies to NCBI's requests, paced and holding back the queue", async () => {
    vi.useFakeTimers();
    const esearch = (id: string): Response => new Response(JSON.stringify({ esearchresult: { count: "1", idlist: [id] } }), { status: 200 });
    const responses = [status(503), esearch("1"), esearch("2")];
    const fetchMock = vi.fn(async () => responses.shift()!);
    vi.stubGlobal("fetch", fetchMock);
    const client = new NcbiClient({ email: "test@example.com" });
    const first = client.esearch({ query: "x" });
    const second = client.esearch({ query: "y" });
    await vi.advanceTimersByTimeAsync(300);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(2_000);
    expect(await first).toEqual({ count: 1, pmids: ["1"] });
    expect(await second).toEqual({ count: 1, pmids: ["2"] });
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });
});
