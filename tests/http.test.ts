/**
 * HTTP transport tests. The server listens on port 0 with an in-memory cache
 * and an NCBI client that is never exercised (initialize and tools/list don't
 * hit the network), so the suite stays offline.
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import { request, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { LRUBackend, NcbiClient } from "../src/core/index.js";
import { packageVersion } from "../src/mcp/server.js";
import { createHttpServer, loadConfig, type HttpConfig } from "../src/http/index.js";

const VERSION = packageVersion();
const TOOL_NAMES = ["literature_fetch", "literature_fulltext", "literature_search"];

const BASE_CONFIG: HttpConfig = {
  port: 0,
  host: "127.0.0.1",
  ratePerMin: 60,
  burst: 20,
  maxConcurrency: 8,
  maxBodyBytes: 1_000_000,
  trustProxy: false,
  allowedHosts: [],
};

interface RunningServer {
  server: Server;
  url: string;
}

async function startServer(overrides: Partial<HttpConfig> = {}): Promise<RunningServer> {
  const server = createHttpServer({
    cache: new LRUBackend(),
    ncbi: new NcbiClient({ email: "tests@example.com" }),
    config: { ...BASE_CONFIG, ...overrides },
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return { server, url: `http://127.0.0.1:${port}` };
}

function rpc(url: string, body: unknown, headers: Record<string, string> = {}, signal?: AbortSignal): Promise<Response> {
  return fetch(`${url}/mcp`, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json, text/event-stream", ...headers },
    body: JSON.stringify(body),
    signal,
  });
}

const INITIALIZE = {
  jsonrpc: "2.0",
  id: 1,
  method: "initialize",
  params: {
    protocolVersion: "2025-06-18",
    capabilities: {},
    clientInfo: { name: "vitest", version: "1" },
  },
} as const;

const running: Server[] = [];
afterEach(async () => {
  await Promise.all(running.splice(0).map((s) => new Promise<void>((r) => s.close(() => r()))));
});

describe("http transport", () => {
  it("initialize returns serverInfo with name and version", async () => {
    const { server, url } = await startServer();
    running.push(server);

    const res = await rpc(url, INITIALIZE);
    expect(res.status).toBe(200);
    const data = (await res.json()) as { result: { serverInfo: { name: string; version: string } } };
    expect(data.result.serverInfo.name).toBe("med-research-mcp");
    expect(data.result.serverInfo.version).toBe(VERSION);
  });

  it("tools/list returns exactly the three tool names", async () => {
    const { server, url } = await startServer();
    running.push(server);

    const res = await rpc(url, { jsonrpc: "2.0", id: 2, method: "tools/list", params: {} });
    expect(res.status).toBe(200);
    const data = (await res.json()) as { result: { tools: Array<{ name: string }> } };
    expect(data.result.tools.map((t) => t.name).sort()).toEqual(TOOL_NAMES);
  });

  it("GET /health returns 200 with the version", async () => {
    const { server, url } = await startServer();
    running.push(server);

    const res = await fetch(`${url}/health`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ status: "ok", name: "med-research-mcp", version: VERSION });
  });

  it("with a token set: missing header → 401, wrong token → 401, correct token → 200", async () => {
    const { server, url } = await startServer({ token: "s3cr3t-test-token" });
    running.push(server);

    const missing = await rpc(url, INITIALIZE);
    expect(missing.status).toBe(401);

    const wrong = await rpc(url, INITIALIZE, { authorization: "Bearer nope" });
    expect(wrong.status).toBe(401);

    const right = await rpc(url, INITIALIZE, { authorization: "Bearer s3cr3t-test-token" });
    expect(right.status).toBe(200);
    const data = (await right.json()) as { result: { serverInfo: { name: string } } };
    expect(data.result.serverInfo.name).toBe("med-research-mcp");
  });

  it("a burst above rate + burst → 429 with Retry-After", async () => {
    const { server, url } = await startServer({ ratePerMin: 5, burst: 2 }); // capacity 7
    running.push(server);

    const results = await Promise.all(Array.from({ length: 8 }, (_, i) => rpc(url, { ...INITIALIZE, id: i })));
    const statuses = results.map((r) => r.status);
    expect(statuses.filter((s) => s === 200)).toHaveLength(7);

    const rejected = results.find((r) => r.status === 429);
    expect(rejected).toBeDefined();
    expect(Number(rejected!.headers.get("retry-after"))).toBeGreaterThanOrEqual(1);
  });

  it("OPTIONS /mcp → 204 with CORS headers", async () => {
    const { server, url } = await startServer();
    running.push(server);

    const res = await fetch(`${url}/mcp`, { method: "OPTIONS" });
    expect(res.status).toBe(204);
    expect(res.headers.get("access-control-allow-origin")).toBe("*");
    expect(res.headers.get("access-control-allow-methods")).toBe("POST, GET, OPTIONS");
    expect(res.headers.get("access-control-allow-headers")).toBe(
      "Content-Type, Authorization, Mcp-Session-Id, MCP-Protocol-Version",
    );
    expect(res.headers.get("access-control-expose-headers")).toBe("Mcp-Session-Id");
  });

  it("a successful POST /mcp carries CORS headers", async () => {
    const { server, url } = await startServer();
    running.push(server);

    const res = await rpc(url, INITIALIZE);
    expect(res.status).toBe(200);
    expect(res.headers.get("access-control-allow-origin")).toBe("*");
    expect(res.headers.get("access-control-expose-headers")).toBe("Mcp-Session-Id");
  });

  it("a slow, unfinished body does not hold a concurrency slot", async () => {
    const { server, url } = await startServer({ maxConcurrency: 1 });
    running.push(server);

    const { port } = server.address() as AddressInfo;
    const slow = request({
      host: "127.0.0.1",
      port,
      path: "/mcp",
      method: "POST",
      headers: { "content-type": "application/json", "content-length": "1000" },
    });
    slow.on("error", () => {});
    slow.write("{");
    await new Promise((r) => setTimeout(r, 50));

    try {
      const res = await rpc(url, INITIALIZE, {}, AbortSignal.timeout(2_000));
      expect(res.status).toBe(200);
    } finally {
      slow.destroy();
    }
  });

  it("GET /mcp → 405 with Allow: POST", async () => {
    const { server, url } = await startServer();
    running.push(server);

    const res = await fetch(`${url}/mcp`);
    expect(res.status).toBe(405);
    expect(res.headers.get("allow")).toBe("POST");
  });

  it("an oversized body → 413", async () => {
    const { server, url } = await startServer({ maxBodyBytes: 64 });
    running.push(server);

    const res = await rpc(url, INITIALIZE); // the initialize body is far over 64 bytes
    expect(res.status).toBe(413);
  });

  it("rejects a non-JSON POST with 415", async () => {
    const { server, url } = await startServer();
    running.push(server);

    const res = await fetch(`${url}/mcp`, { method: "POST", headers: { "content-type": "text/plain" }, body: "hello" });
    expect(res.status).toBe(415);
  });

  it("no log line contains the query text from the request body", async () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const { server, url } = await startServer();
      running.push(server);

      const marker = "SECRET-QUERY-MARKER-9f3b7c";
      await rpc(url, { ...INITIALIZE, params: { ...INITIALIZE.params, clientInfo: { name: marker, version: "1" } } });
      await new Promise((r) => setTimeout(r, 20)); // let the res finish log line flush

      const lines = spy.mock.calls.map((call) => call.map(String).join(" "));
      expect(lines.some((l) => l.includes("POST /mcp 200"))).toBe(true);
      expect(lines.every((l) => !l.includes(marker))).toBe(true);
      // The client IP is truncated to /24 — the full address never reaches the log.
      expect(lines.some((l) => l.endsWith(" 127.0.0.0/24"))).toBe(true);
      expect(lines.every((l) => !l.includes("127.0.0.1 ") && !l.endsWith("127.0.0.1"))).toBe(true);
    } finally {
      spy.mockRestore();
    }
  });
});

describe("loadConfig", () => {
  it("applies defaults", () => {
    const config = loadConfig({});
    expect(config).toEqual({
      port: 8787,
      host: "127.0.0.1",
      ratePerMin: 60,
      burst: 20,
      maxConcurrency: 8,
      maxBodyBytes: 1_000_000,
      trustProxy: false,
      allowedHosts: [],
    });
  });

  it("parses the documented env vars", () => {
    const config = loadConfig({
      PORT: "9000",
      HOST: "0.0.0.0",
      MED_RESEARCH_HTTP_TOKEN: "tok",
      MED_RESEARCH_HTTP_RATE_PER_MIN: "30",
      MED_RESEARCH_HTTP_BURST: "5",
      MED_RESEARCH_HTTP_MAX_CONCURRENCY: "4",
      MED_RESEARCH_HTTP_MAX_BODY_BYTES: "2048",
      MED_RESEARCH_TRUST_PROXY: "1",
      MED_RESEARCH_ALLOWED_HOSTS: "mcp.example.com, localhost:8787 ",
    });
    expect(config).toEqual({
      port: 9000,
      host: "0.0.0.0",
      token: "tok",
      ratePerMin: 30,
      burst: 5,
      maxConcurrency: 4,
      maxBodyBytes: 2048,
      trustProxy: true,
      allowedHosts: ["mcp.example.com", "localhost:8787"],
    });
  });
});
