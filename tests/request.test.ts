import { afterEach, describe, expect, it, vi } from "vitest";
import { requestWithRetries, withDeadline } from "../src/core/request";
import { defaultHttp } from "../src/core/adapters/http";
import { NcbiClient } from "../src/core/pubmed";

const ok = (): Response => new Response(JSON.stringify({ ok: true }), { status: 200 });
const status = (code: number): Response => new Response("<html>gateway</html>", { status: code });
/** A fetch that never answers until its request is aborted. */
const hanging = (_url: string, init?: RequestInit): Promise<Response> =>
  new Promise((_resolve, reject) => init?.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError"))));
/** A response whose body sends a first chunk, then stalls until the request is aborted. */
const stalling = (_url: string, init?: RequestInit): Promise<Response> =>
  Promise.resolve(
    new Response(
      new ReadableStream({
        start(controller) {
          controller.enqueue(new TextEncoder().encode('{"ok":'));
          init?.signal?.addEventListener("abort", () => controller.error(new DOMException("aborted", "AbortError")));
        },
      }),
      { status: 200 },
    ),
  );
/** A response whose body breaks off after a first chunk, as undici's does when the connection drops. */
const brokenOff = (): Promise<Response> =>
  Promise.resolve(
    new Response(
      new ReadableStream({
        start(controller) {
          controller.enqueue(new TextEncoder().encode('{"ok":'));
          controller.error(new TypeError("terminated"));
        },
      }),
      { status: 200 },
    ),
  );
const OK_BODY = JSON.stringify({ ok: true });
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
      expect(await pending).toBe(OK_BODY);
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
    expect(await pending).toBe(OK_BODY);
  });

  it("retries a body that breaks off", async () => {
    vi.useFakeTimers();
    const fetchMock = vi.fn(brokenOff).mockImplementationOnce(brokenOff).mockImplementationOnce(async () => ok());
    vi.stubGlobal("fetch", fetchMock);
    const pending = requestWithRetries("https://upstream.example/x", options);
    await vi.advanceTimersByTimeAsync(600);
    expect(await pending).toBe(OK_BODY);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("times out a body that stalls after the headers, and retries it", async () => {
    vi.useFakeTimers();
    const fetchMock = vi.fn(stalling).mockImplementationOnce(stalling).mockImplementationOnce(async () => ok());
    vi.stubGlobal("fetch", fetchMock);
    const pending = requestWithRetries("https://upstream.example/x", { ...options, timeoutMs: 5_000 });
    await vi.advanceTimersByTimeAsync(4_900);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(700);
    expect(await pending).toBe(OK_BODY);
    expect(fetchMock).toHaveBeenCalledTimes(2);
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
    expect(await pending).toBe(OK_BODY);
  });

  describe("within a call's deadline", () => {
    it("cuts every attempt, the first included, to what is left of the call, and sends none once too little is left", async () => {
      vi.useFakeTimers();
      const fetchMock = vi.fn(hanging);
      vi.stubGlobal("fetch", fetchMock);
      const call = withDeadline(8_000, async () => {
        const first = await requestWithRetries("https://upstream.example/a", options).catch((e: unknown) => e);
        const second = await requestWithRetries("https://upstream.example/b", options).catch((e: unknown) => e);
        return [first, second];
      });
      await vi.advanceTimersByTimeAsync(8_000);
      const [first, second] = await call;
      // 8 s instead of 15, and no retry: it would start with less than 2 s left.
      expect(first).toMatchObject({ code: "NETWORK_ERROR", message: "Network error: Europe PMC didn't answer within 8 s" });
      expect(second).toMatchObject({ code: "TIMEOUT", message: "Europe PMC wasn't asked: the call ran out of time" });
      expect(fetchMock).toHaveBeenCalledTimes(1);
    });

    it("doesn't send an NCBI request whose call ran out of time while it waited in the queue", async () => {
      vi.useFakeTimers();
      const esearch = new Response(JSON.stringify({ esearchresult: { count: "1", idlist: ["1"] } }), { status: 200 });
      const fetchMock = vi.fn(hanging).mockImplementationOnce(hanging).mockImplementationOnce(hanging).mockImplementationOnce(async () => esearch);
      vi.stubGlobal("fetch", fetchMock);
      const client = new NcbiClient({ email: "test@example.com" });
      // A call without a deadline whose request times out and is retried, holding the queue for about 20 s.
      const slow = client.esearch({ query: "slow" }).catch((e: unknown) => e);
      const bounded = withDeadline(10_000, () => client.esearch({ query: "bounded" })).catch((e: unknown) => e);
      await vi.advanceTimersByTimeAsync(21_000);
      expect(await slow).toMatchObject({ code: "NETWORK_ERROR" });
      // Its turn came after its deadline: it fails without being sent.
      expect(await bounded).toMatchObject({ code: "TIMEOUT", message: "PubMed wasn't asked: the call ran out of time" });
      expect(fetchMock).toHaveBeenCalledTimes(2);
    });

    it("keeps the earlier deadline when nested", async () => {
      vi.useFakeTimers();
      vi.stubGlobal("fetch", vi.fn(hanging));
      const call = withDeadline(4_000, () => withDeadline(60_000, () => requestWithRetries("https://upstream.example/x", options).catch((e: unknown) => e)));
      await vi.advanceTimersByTimeAsync(4_000);
      expect(await call).toMatchObject({ message: "Network error: Europe PMC didn't answer within 4 s" });
    });
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
    expect(await first).toEqual({ count: 1, pmids: ["1"], more: false });
    expect(await second).toEqual({ count: 1, pmids: ["2"], more: false });
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });
});
