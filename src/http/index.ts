#!/usr/bin/env node
/**
 * Hosted entry point: the three literature_* tools over the MCP Streamable
 * HTTP transport, as one long-running Node process behind a TLS reverse proxy.
 *
 * Shared state (cache, NCBI rate limiter) is built once here and injected into
 * every request's server (handler.ts), so the NCBI rate limit and the cache
 * span all requests. Routing, auth, per-IP rate limiting, the global
 * concurrency cap and body limits live in this file; ./limits.ts holds the
 * primitives and ./handler.ts the transport lifecycle.
 *
 * One line per request is logged to stderr — method, path, status, duration,
 * client IP truncated to /24 (IPv4) or /48 (IPv6). Never bodies, query text,
 * tool arguments or results: queries are medical data. stdout stays clean.
 */

import { createHash, timingSafeEqual } from "node:crypto";
import { createServer as createNodeHttpServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { NcbiClient, type Cache } from "../core/index.js";
import { buildCache, createServer, packageVersion } from "../mcp/server.js";
import { handleMcpPost } from "./handler.js";
import { anonymizeIp, clientIp, ConcurrencyLimiter, TokenBucketLimiter } from "./limits.js";

const MCP_PATH = "/mcp";
const HEALTH_PATH = "/health";
/** Waiting slots beyond maxConcurrency before the server answers 503. */
const MAX_QUEUE = 100;

export interface HttpConfig {
  port: number;
  host: string;
  /** Bearer token for /mcp; undefined = anonymous access (evaluation mode). */
  token?: string;
  ratePerMin: number;
  burst: number;
  maxConcurrency: number;
  maxBodyBytes: number;
  trustProxy: boolean;
  allowedHosts: string[];
}

function intEnv(env: NodeJS.ProcessEnv, name: string, fallback: number, min = 1): number {
  const raw = env[name];
  if (raw == null || raw.trim() === "") return fallback;
  const value = Number.parseInt(raw, 10);
  return Number.isFinite(value) && value >= min ? value : fallback;
}

/** Read the HTTP configuration from the environment (see docs/hosting.md). */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): HttpConfig {
  const token = env.MED_RESEARCH_HTTP_TOKEN?.trim();
  const allowedHosts = (env.MED_RESEARCH_ALLOWED_HOSTS ?? "")
    .split(",")
    .map((h) => h.trim())
    .filter(Boolean);
  return {
    port: intEnv(env, "PORT", 8787, 0),
    host: env.HOST?.trim() || "127.0.0.1",
    ...(token ? { token } : {}),
    ratePerMin: intEnv(env, "MED_RESEARCH_HTTP_RATE_PER_MIN", 60),
    burst: intEnv(env, "MED_RESEARCH_HTTP_BURST", 20),
    maxConcurrency: intEnv(env, "MED_RESEARCH_HTTP_MAX_CONCURRENCY", 8),
    maxBodyBytes: intEnv(env, "MED_RESEARCH_HTTP_MAX_BODY_BYTES", 1_000_000),
    trustProxy: env.MED_RESEARCH_TRUST_PROXY === "1",
    allowedHosts,
  };
}

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, GET, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization, Mcp-Session-Id, MCP-Protocol-Version",
  "Access-Control-Expose-Headers": "Mcp-Session-Id",
} as const;

function sendJson(res: ServerResponse, status: number, payload: unknown, extraHeaders: Record<string, string> = {}): void {
  const body = JSON.stringify(payload);
  res.writeHead(status, { "Content-Type": "application/json", ...CORS_HEADERS, ...extraHeaders });
  res.end(body);
}

/** Constant-time bearer check. Both sides are hashed first so the length never leaks. */
function tokenMatches(provided: string, expected: string): boolean {
  const a = createHash("sha256").update(provided).digest();
  const b = createHash("sha256").update(expected).digest();
  return timingSafeEqual(a, b);
}

function isAuthorized(req: IncomingMessage, token: string): boolean {
  const header = req.headers.authorization;
  if (!header?.startsWith("Bearer ")) return false;
  return tokenMatches(header.slice("Bearer ".length).trim(), token);
}

type BodyResult = { ok: true; body: unknown } | { ok: false; status: number; message: string };

/** Read and parse a POST body, enforcing the content type and size cap. */
async function readJsonBody(req: IncomingMessage, maxBodyBytes: number): Promise<BodyResult> {
  const type = req.headers["content-type"]?.split(";")[0]?.trim().toLowerCase();
  if (type !== "application/json") {
    return { ok: false, status: 415, message: "Unsupported Media Type: POST /mcp requires application/json" };
  }

  const chunks: Buffer[] = [];
  let received = 0;
  for await (const chunk of req) {
    received += (chunk as Buffer).length;
    if (received > maxBodyBytes) {
      req.resume(); // drain so the 413 response reaches the client
      return { ok: false, status: 413, message: `Payload Too Large: body exceeds ${maxBodyBytes} bytes` };
    }
    chunks.push(chunk as Buffer);
  }

  try {
    return { ok: true, body: JSON.parse(Buffer.concat(chunks).toString("utf-8")) };
  } catch {
    return { ok: false, status: 400, message: "Bad Request: body is not valid JSON" };
  }
}

export interface HttpServerDeps {
  /** Process-wide cache, shared by every request's tool calls. */
  cache: Cache;
  /** Process-wide NCBI client, so all requests share one rate limiter. */
  ncbi: NcbiClient;
  config: HttpConfig;
}

/**
 * The hosted HTTP server. `main()` wires it to env vars, startup warnings and
 * signals; tests build it with a fake cache and NCBI client on port 0.
 */
export function createHttpServer(deps: HttpServerDeps): Server {
  const { config } = deps;
  const version = packageVersion();
  const rateLimiter = new TokenBucketLimiter(config.ratePerMin, config.burst);
  const concurrency = new ConcurrencyLimiter(config.maxConcurrency, MAX_QUEUE);
  // Idle-token sweep so a busy public endpoint doesn't grow the bucket map forever.
  const sweep = setInterval(() => rateLimiter.sweep(), 3_600_000);
  sweep.unref();

  const server = createNodeHttpServer((req, res) => {
    const startedAt = Date.now();
    // Logs carry only a truncated prefix (/24, /48): a full IP is personal data.
    const ip = anonymizeIp(clientIp(req, config.trustProxy));
    // Never log bodies, query text or tool arguments — queries are medical data.
    const path = req.url?.split("?")[0] ?? "/";
    res.on("finish", () => {
      console.error(`[med-research-mcp] ${req.method ?? "?"} ${path} ${res.statusCode} ${Date.now() - startedAt}ms ${ip}`);
    });

    void route(req, res).catch((err) => {
      if (!res.headersSent) {
        sendJson(res, 500, { error: "Internal Server Error" });
      } else if (!res.writableEnded) {
        res.end();
      }
      console.error("[med-research-mcp] request failed:", err);
    });
  });

  async function route(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const method = req.method ?? "GET";
    const path = req.url?.split("?")[0] ?? "/";

    if (path === HEALTH_PATH && method === "GET") {
      sendJson(res, 200, { status: "ok", name: "med-research-mcp", version });
      return;
    }

    if (path !== MCP_PATH) {
      sendJson(res, 404, { error: "Not Found" });
      return;
    }

    if (method === "OPTIONS") {
      res.writeHead(204, CORS_HEADERS);
      res.end();
      return;
    }

    if (method === "GET" || method === "DELETE") {
      sendJson(res, 405, { error: "Method Not Allowed" }, { Allow: "POST" });
      return;
    }

    if (method !== "POST") {
      sendJson(res, 405, { error: "Method Not Allowed" }, { Allow: "POST" });
      return;
    }

    // Auth first: a misconfigured or missing token fails before it can spend rate-limit tokens.
    if (config.token && !isAuthorized(req, config.token)) {
      sendJson(res, 401, { error: "Unauthorized" }, { "WWW-Authenticate": "Bearer" });
      return;
    }

    const limited = rateLimiter.take(clientIp(req, config.trustProxy));
    if (!limited.allowed) {
      sendJson(res, 429, { error: "Too Many Requests" }, { "Retry-After": String(limited.retryAfterSeconds) });
      return;
    }

    // Read the body before taking a concurrency slot, so slow uploads can't hold slots hostage.
    const body = await readJsonBody(req, config.maxBodyBytes);
    if (!body.ok) {
      sendJson(res, body.status, { error: body.message });
      return;
    }

    const release = await concurrency.acquire();
    if (!release) {
      sendJson(res, 503, { error: "Service Unavailable: concurrency queue is full" }, { "Retry-After": "5" });
      return;
    }
    try {
      // The transport writes its own response headers; pre-set CORS so browsers can read the result.
      for (const [name, value] of Object.entries(CORS_HEADERS)) res.setHeader(name, value);
      await handleMcpPost(req, res, body.body, { cache: deps.cache, ncbi: deps.ncbi, allowedHosts: config.allowedHosts });
    } finally {
      release();
    }
  }

  server.on("close", () => clearInterval(sweep));
  return server;
}

async function main(): Promise<void> {
  const config = loadConfig();

  if (!config.token) {
    console.error(
      "[med-research-mcp] WARNING: MED_RESEARCH_HTTP_TOKEN is not set — /mcp is open to anyone who can reach this port. " +
        "This is acceptable for evaluation only; set a token or firewall the port for anything else.",
    );
  }
  if (!process.env.NCBI_EMAIL) {
    console.error(
      "[med-research-mcp] NCBI_EMAIL is not set. NCBI asks for a contact email on every request; set it to avoid throttling.",
    );
  }

  // Built once and shared by every request — the whole point of the hosted entry.
  const cache: Cache = buildCache();
  const ncbi = new NcbiClient();
  const server = createHttpServer({ cache, ncbi, config });

  function shutdown(signal: string): void {
    console.error(`[med-research-mcp] ${signal} received — shutting down.`);
    server.close(); // stop accepting new connections
    server.closeIdleConnections();
    // Persistent backends (SQLite) expose close(); flush the DB before exiting.
    const maybeClose = (cache as { close?: () => void }).close;
    if (typeof maybeClose === "function") {
      try {
        maybeClose.call(cache);
      } catch (err) {
        console.error(`[med-research-mcp] error closing cache on ${signal}:`, err);
      }
    }
    process.exit(0);
  }

  for (const signal of ["SIGINT", "SIGTERM"] as const) {
    process.on(signal, () => shutdown(signal));
  }

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(config.port, config.host, () => resolve());
  });
  console.error(`[med-research-mcp] MCP server listening on http://${config.host}:${config.port}${MCP_PATH} (stateless Streamable HTTP).`);
}

const isDirectRun = process.argv[1] != null && import.meta.url === new URL(`file://${process.argv[1]}`).href;
if (isDirectRun) {
  main().catch((err) => {
    console.error("[med-research-mcp] fatal:", err);
    process.exit(1);
  });
}
