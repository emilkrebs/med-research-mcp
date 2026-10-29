# Hosting med-research-mcp over HTTP

`src/http/index.ts` serves the same three tools as the stdio server
(`literature_search`, `literature_fetch`, `literature_fulltext`) over the MCP
[Streamable HTTP transport](https://modelcontextprotocol.io/specification/2025-06-18/basic/transports#streamable-http),
as one long-running Node process meant to sit behind a TLS reverse proxy.

The transport is **stateless**: no sessions, no SSE. Every `POST /mcp` gets a
fresh transport and a fresh `McpServer`, answers with a single
`application/json` body (`enableJsonResponse`, so proxies and CDNs never
buffer a stream), and is torn down with the response. What is shared between
requests — built once at startup — is the cache and the `NcbiClient` rate
limiter, so all requests together respect NCBI's limit.

There is no public instance; this page is for running your own. A shared
instance is convenient for a team, but it has no institutional proxy (see
[below](#environment-variables)) and all its users share one set of upstream
rate limits.

## Privacy

The hosted endpoint is designed to know as little as possible:

- **No query logging.** Request logs contain only method, path, status,
  duration and a truncated client IP (IPv4 /24, IPv6 /48). Bodies, query text,
  tool arguments and results are never logged — queries are medical data.
  The full IP is held only in memory, for per-IP rate limiting, and idle
  entries are swept hourly.
- **No accounts.** Access control is a single shared bearer token, or none.
- **No storage.** The default cache backend is in-memory and dies with the
  process. If you run your own instance you can opt in to a persistent SQLite
  cache ([below](#persistent-cache-sqlite)); it holds public article records
  keyed by ID, never query text or client IPs, but the set of cached IDs does
  show which articles have been looked up. Leave it off on an instance where
  that matters.
- **Queries leave the server.** Answering a tool call means sending its query
  or ids to the databases: NCBI, EMBL-EBI (Europe PMC), ChinaRxiv, and for full
  texts Unpaywall, doi.org and publishers; requests to NCBI, ChinaRxiv and
  Unpaywall carry the operator's contact email if one is set, and those to NCBI
  and Unpaywall otherwise the project's. `MED_RESEARCH_UNPAYWALL=0` keeps DOIs
  from Unpaywall, at the cost of the open-access copies only it knows.
  Tell your users, and see [compliance.md](compliance.md#data-flows) for what
  each service receives.

### A privacy notice for your instance

Whoever runs an instance decides why and how it processes requests, so under
the GDPR (Art. 13) the operator owes its users a privacy notice. The project
can't write it for you, because it depends on who you are, where you host and
what your reverse proxy logs. This template covers what the server itself does;
fill in the brackets and check it with your data-protection contact.

> **Who is responsible:** [operator name, address, email].
>
> **What this server receives:** your tool calls (search text, article ids,
> DOIs) and your IP address.
>
> **Why, and on what basis:** to answer your requests, and to protect the
> service from abuse by rate-limiting per IP address (legitimate interest,
> Art. 6(1)(f) GDPR).
>
> **How long:** query text and results are not logged or stored. Request logs
> hold method, path, status, duration and your IP address shortened to /24
> (IPv6: /48), kept for [N days]. Your full IP address is held in memory for
> rate limiting only and dropped about one to two hours after your last
> request. Cached article records hold no query text or IP addresses.
>
> **Who else receives your queries:** to answer a call, the server sends its
> query or ids, from the server's IP address, to NCBI/NLM (USA; PubMed),
> EMBL-EBI (UK; Europe PMC) and ChinaRxiv (chinarxiv.org), and for full texts
> to Unpaywall/OpenAlex (USA) [drop if `MED_RESEARCH_UNPAYWALL=0`], the doi.org
> resolver and the publisher or repository sites it points to. [With
> `NCBI_EMAIL` set:] Requests to NCBI, ChinaRxiv and Unpaywall include our
> contact email. [Without it:] Requests to NCBI and Unpaywall include the
> med-research-mcp project's contact address. Each handles
> requests under its own privacy policy, and some are outside the EU/EEA. Our
> hosting provider [name, country] processes connection data.
>
> **Your rights:** access, erasure and objection (Arts. 15–21 GDPR), and a
> complaint to your supervisory authority.
>
> **Don't enter information that identifies a person.**

## Security

- **Authentication.** Set `MED_RESEARCH_HTTP_TOKEN` for anything but a quick
  evaluation; without it, anyone who can reach the port can use the server and
  its upstream rate limits.
- **Full-text fetches can't reach your network** (never set
  `MED_RESEARCH_FULLTEXT_ALLOW_PRIVATE` on a shared server; it turns this off).
  `literature_fulltext` fetches
  URLs chosen by Unpaywall and by DOI registrants. It refuses loopback,
  private, link-local, CGNAT and reserved addresses, including the cloud
  metadata endpoints (`169.254.169.254`, Alibaba Cloud's `100.100.100.200`),
  checks every redirect, checks host names at connect time so DNS rebinding
  can't get around it, and refuses bodies over 30 MB
  ([how-it-works.md](how-it-works.md#literature_fulltext)). As defense in depth,
  restrict the host's outbound traffic to the public internet too, e.g. block
  the metadata endpoint with a firewall rule or IMDSv2-only settings.
- **Dependencies.** Rebuild the image when dependencies get security fixes;
  `npm audit` lists known advisories.

## Endpoints

| Route | Purpose |
| --- | --- |
| `POST /mcp` | JSON-RPC (MCP Streamable HTTP, stateless, JSON responses) |
| `GET /health` | `{"status":"ok","name":"med-research-mcp","version":"…"}` |
| `OPTIONS /mcp` | CORS preflight, 204 |
| `GET` / `DELETE /mcp` | 405 with `Allow: POST` |

CORS is open (`Access-Control-Allow-Origin: *`); browser clients must send
`Accept: application/json, text/event-stream` on POSTs, as the MCP spec
requires.

## Deploy

Requires Node.js 22.22.2 or later on 22, 24.15.0 or later on 24, or 26+.

```bash
git clone https://github.com/emilkrebs/med-research-mcp.git
cd med-research-mcp
npm ci                   # full install: tsc (TS 7) and tsup need their optional platform binaries
npm run build
npm prune --omit=dev     # drop build tooling; better-sqlite3 stays for the optional persistent cache

NCBI_EMAIL=you@example.com \
MED_RESEARCH_HTTP_TOKEN=$(openssl rand -hex 32) \
npm run start:http       # listens on 127.0.0.1:8787
```

Put a TLS-terminating reverse proxy in front. With Caddy
([deploy/Caddyfile](../deploy/Caddyfile)):

```caddy
mcp.example.com {
	reverse_proxy 127.0.0.1:8787
}
```

Caddy obtains and renews the certificate automatically. Then configure the MCP
client with the URL and token:

```json
{
  "mcpServers": {
    "med-research-mcp": {
      "type": "http",
      "url": "https://mcp.example.com/mcp",
      "headers": { "Authorization": "Bearer <the-token>" }
    }
  }
}
```

### Docker

```bash
docker build -t med-research-mcp .
docker run -d --name med-research-mcp \
  -e NCBI_EMAIL=you@example.com \
  -e MED_RESEARCH_HTTP_TOKEN=<token> \
  -p 127.0.0.1:8787:8787 \
  med-research-mcp
```

The image runs as the `node` user, sets `HOST=0.0.0.0` (the default loopback
bind would be unreachable outside the container), exposes 8787 and health
checks `GET /health`. Keep the port on loopback and proxy to it, or publish it
as you see fit. The cache is in-memory unless you enable the SQLite backend
below.

## Persistent cache (SQLite)

By default the cache starts empty on every restart. To keep it across restarts
and deploys, switch to the SQLite backend:

```bash
MED_RESEARCH_CACHE_BACKEND=sqlite \
MED_RESEARCH_CACHE_PATH=/var/lib/med-research-mcp/cache.db \
NCBI_EMAIL=you@example.com \
MED_RESEARCH_HTTP_TOKEN=<token> \
npm run start:http
```

The directory must exist and be writable by the service user. With Docker,
keep the file on a volume (the image creates `/data`, owned by `node`):

```bash
docker run -d --name med-research-mcp \
  -e NCBI_EMAIL=you@example.com \
  -e MED_RESEARCH_HTTP_TOKEN=<token> \
  -e MED_RESEARCH_CACHE_BACKEND=sqlite \
  -e MED_RESEARCH_CACHE_PATH=/data/cache.db \
  -v med-research-cache:/data \
  -p 127.0.0.1:8787:8787 \
  med-research-mcp
```

A bind mount instead of a named volume must be writable by uid 1000 (`node`).

- **Check the startup log.** If SQLite can't be used (the module fails to load,
  or the path isn't writable) the server logs `… — using in-memory cache.` and
  keeps running with the in-memory cache, so a misconfiguration doesn't stop
  the service, it just loses persistence.
- **No compiler needed on common platforms.** `better-sqlite3` ships prebuilt
  binaries for Linux (x64 and arm64, glibc and musl), macOS and Windows.
  Other platforms compile it from source.
- **One instance per cache file.** The rate limiters are per-process anyway, so
  this is a single-host setup. Don't share the file between replicas.
- **Expiry.** Summaries expire after 7 days and full texts after 30; abstracts
  never do. Expired rows are removed on startup and then hourly. Because
  abstracts are kept, the file grows with the number of distinct articles
  served. It is only a cache: stop the server and delete the file to reset it.

## Environment variables

HTTP-specific (the [README configuration table](../README.md#configuration)
lists the rest):

| Variable | Default | Description |
| --- | --- | --- |
| `PORT` | `8787` | Port to listen on. |
| `HOST` | `127.0.0.1` | Address to bind. The Docker image overrides it to `0.0.0.0`. |
| `MED_RESEARCH_HTTP_TOKEN` | unset | Bearer token required on `/mcp` (`Authorization: Bearer …`, compared with `crypto.timingSafeEqual`). **Unset = anonymous access** (evaluation mode); a startup warning says so. |
| `MED_RESEARCH_HTTP_RATE_PER_MIN` | `60` | Per-IP sustained request rate on `/mcp`. |
| `MED_RESEARCH_HTTP_BURST` | `20` | Extra tokens a client may spend immediately (see below). |
| `MED_RESEARCH_HTTP_MAX_CONCURRENCY` | `8` | Requests being processed at once, process-wide. |
| `MED_RESEARCH_HTTP_MAX_BODY_BYTES` | `1000000` | Maximum POST body size → 413 beyond. |
| `MED_RESEARCH_TRUST_PROXY` | `0` | `1` = take the client IP from the last `X-Forwarded-For` entry, the one your reverse proxy added (earlier entries can come from the client). Set it only when a reverse proxy always sits in front; otherwise the socket address is used. |
| `MED_RESEARCH_ALLOWED_HOSTS` | unset | Comma-separated `Host` header allowlist; when set, DNS-rebinding protection is enabled. |

Relevant non-HTTP variables, unchanged: `NCBI_EMAIL` (recommended),
`NCBI_API_KEY`, `MED_RESEARCH_UNPAYWALL_EMAIL`, `MED_RESEARCH_UNPAYWALL` (`0`
turns Unpaywall off), `MED_RESEARCH_CHINAXIV_EMAIL`,
`MED_RESEARCH_FULLTEXT_MAX_CHARS`, `MED_RESEARCH_CACHE_BACKEND`,
`MED_RESEARCH_CACHE_PATH` (see [Persistent cache](#persistent-cache-sqlite)).

**Leave `MED_RESEARCH_PROXY_PREFIX` unset on a hosted instance.** An
institution's subscriptions are licensed to its members, not to everyone who
can reach your server. For the same reason, **don't host on a network with
IP-based subscription access** (a campus network, say): the direct route
(`https://doi.org/<DOI>`) returns whatever publishers serve the server's IP
address, and on such a network that includes licensed full texts. On an
ordinary cloud host, full texts come from open-access copies and free-to-read
publisher pages.

## Rate-limit model

- **Per-IP token bucket on `/mcp` only.** Capacity is `rate + burst` tokens,
  refilled continuously at `rate` per minute: a new client can fire
  60 + 20 = 80 requests immediately (with the defaults) and then sustains
  60/min. Rejections return **429** with a `Retry-After` header. The client IP
  is the socket address, or the last `X-Forwarded-For` entry (the one the
  reverse proxy added) when `MED_RESEARCH_TRUST_PROXY=1`. Buckets are in-memory and per-process; idle
  entries are swept hourly.
- **Global concurrency cap.** At most `MED_RESEARCH_HTTP_MAX_CONCURRENCY`
  requests (default 8) are processed at once, so upstream rate limits and
  memory stay bounded. Up to 100 further requests queue; beyond that the
  server answers **503** with `Retry-After: 5`.
- **Body cap.** Bodies over `MED_RESEARCH_HTTP_MAX_BODY_BYTES` (default 1 MB)
  get **413**; non-`application/json` POSTs get **415**.
- **Call budget.** A `literature_search` or `literature_fetch` call's database
  requests must finish within 30 seconds, retries and waiting in the NCBI queue
  included, so the call answers before a gateway in front of the server gives up
  (nginx's `proxy_read_timeout`, for one, defaults to 60 s). A database that runs
  out of time becomes a warning, or, when no database answered, the error
  `TIMEOUT`.
  `literature_fulltext` has no budget: its pages are fetched with their own
  timeout, and its fallback needs the abstract. The stdio server sets none.

## Operations

- Logs go to **stderr** only, one line per request: method, path, status,
  duration in ms, client IP truncated to /24 (IPv4) or /48 (IPv6) — `invalid`
  if it isn't an IP. stdout stays clean.
- `SIGINT`/`SIGTERM` stop accepting connections, close the HTTP server and
  flush the cache backend before exiting 0.
- With the SQLite cache, expired rows are swept hourly; a failed sweep is
  logged to stderr and retried on the next tick.
- `GET /health` is suitable for load-balancer and container health checks.
