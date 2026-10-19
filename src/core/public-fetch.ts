/**
 * Fetching publisher and repository pages for `literature_fulltext` without
 * letting a URL reach the machine's own network.
 *
 * The URLs come from outside the server: Unpaywall's index, and whatever the
 * registrant of a DOI points doi.org at, followed through redirects. A URL that
 * resolves to a loopback, private or link-local address would let a caller read
 * internal services through the tool, including the cloud metadata endpoints
 * (169.254.169.254; 100.100.100.200 on Alibaba Cloud) that hand out credentials.
 * That matters most on a hosted deployment, so every connection is checked:
 *
 * - only http: and https:, at most {@link MAX_REDIRECTS} redirects, each hop checked;
 * - IP-literal hosts are checked before connecting;
 * - host names are checked when the connection is made, through the DNS lookup
 *   of the undici Agent, so a name can't resolve to a public address for a
 *   check and a private one for the connection (DNS rebinding);
 * - bodies are capped at {@link MAX_BODY_BYTES}.
 *
 * undici is a dependency of jsdom already; its own `fetch` is used rather than
 * the global one, whose bundled undici may be a different major version.
 */

import { lookup as dnsLookup, type LookupAddress } from "node:dns";
import { BlockList, isIP, type LookupFunction } from "node:net";
import { Agent, fetch as undiciFetch } from "undici";

/** Redirects followed before giving up; doi.org → publisher → article page is typically 2–4. */
export const MAX_REDIRECTS = 10;
/** Larger bodies are refused: full-text PDFs are a few MB, so this only stops runaway downloads. */
export const MAX_BODY_BYTES = 30 * 1024 * 1024;

/**
 * Special-purpose ranges that aren't globally reachable (IANA IPv4 and IPv6
 * Special-Purpose Address Registries, RFC 6890). BlockList also checks
 * IPv4-mapped IPv6 addresses (::ffff:a.b.c.d) against the IPv4 rules.
 */
const NON_PUBLIC = new BlockList();
for (const [network, prefix] of [
  ["0.0.0.0", 8], // "this network"
  ["10.0.0.0", 8], // private
  ["100.64.0.0", 10], // shared address space (CGNAT), incl. Alibaba Cloud metadata 100.100.100.200
  ["127.0.0.0", 8], // loopback
  ["169.254.0.0", 16], // link-local, incl. cloud metadata 169.254.169.254
  ["172.16.0.0", 12], // private
  ["192.0.0.0", 24], // IETF protocol assignments
  ["192.0.2.0", 24], // documentation (TEST-NET-1)
  ["192.88.99.0", 24], // 6to4 relay anycast (deprecated)
  ["192.168.0.0", 16], // private
  ["198.18.0.0", 15], // benchmarking
  ["198.51.100.0", 24], // documentation (TEST-NET-2)
  ["203.0.113.0", 24], // documentation (TEST-NET-3)
  ["224.0.0.0", 4], // multicast
  ["240.0.0.0", 4], // reserved, incl. broadcast
] as const) {
  NON_PUBLIC.addSubnet(network, prefix, "ipv4");
}
for (const [network, prefix] of [
  ["::", 96], // unspecified, loopback, deprecated IPv4-compatible
  ["64:ff9b:1::", 48], // local-use IPv4/IPv6 translation
  ["100::", 64], // discard-only
  ["2001:db8::", 32], // documentation
  ["2002::", 16], // 6to4 (deprecated)
  ["fc00::", 7], // unique local
  ["fe80::", 10], // link-local
  ["ff00::", 8], // multicast
] as const) {
  NON_PUBLIC.addSubnet(network, prefix, "ipv6");
}

/** The 8 groups of an IPv6 address, or null if it isn't one. */
function ipv6Groups(address: string): number[] | null {
  const bare = address.split("%")[0]!; // drop a zone id such as fe80::1%eth0
  if (isIP(bare) !== 6) return null;
  const [head = "", tail] = bare.split("::");
  const parse = (part: string): number[] =>
    part
      ? part.split(":").flatMap((g) => {
          if (!g.includes(".")) return [Number.parseInt(g, 16)];
          const [a, b, c, d] = g.split(".").map(Number) as [number, number, number, number];
          return [(a << 8) | b, (c << 8) | d];
        })
      : [];
  const left = parse(head);
  if (tail === undefined) return left;
  const right = parse(tail);
  return [...left, ...Array<number>(8 - left.length - right.length).fill(0), ...right];
}

/** The IPv4 address a NAT64 address (64:ff9b::/96, RFC 6052) translates to. */
function nat64Target(address: string): string | undefined {
  const g = ipv6Groups(address);
  if (!g || g[0] !== 0x64 || g[1] !== 0xff9b || g.slice(2, 6).some((x) => x !== 0)) return undefined;
  return [g[6]! >> 8, g[6]! & 0xff, g[7]! >> 8, g[7]! & 0xff].join(".");
}

/** Whether an IP address is globally reachable, i.e. safe to fetch from on a server. */
export function isPublicAddress(address: string): boolean {
  const family = isIP(address.split("%")[0]!);
  if (family === 4) return !NON_PUBLIC.check(address, "ipv4");
  if (family === 6) {
    const v4 = nat64Target(address);
    return v4 ? isPublicAddress(v4) : !NON_PUBLIC.check(address, "ipv6");
  }
  return false;
}

/** Thrown when a URL or its address is refused; the full-text resolver treats it as "no text here". */
export class BlockedUrlError extends Error {
  override readonly name = "BlockedUrlError";
}

/** DNS lookup that fails when any resolved address is refused. Handles `all: true` (Happy Eyeballs). */
function guardedLookup(isAllowed: (address: string) => boolean): LookupFunction {
  return (hostname, options, callback) => {
    dnsLookup(hostname, { ...options, all: true }, (err, addresses: LookupAddress[]) => {
      if (err) return callback(err, "", 0);
      const refused = addresses.find((a) => !isAllowed(a.address));
      if (refused || addresses.length === 0) {
        const reason = refused ? `resolves to ${refused.address}, not a public address` : "has no address";
        return callback(new BlockedUrlError(`Refusing to connect: ${hostname} ${reason}`), "", 0);
      }
      if (options.all) return callback(null, addresses);
      callback(null, addresses[0]!.address, addresses[0]!.family);
    });
  };
}

const agents = new Map<(address: string) => boolean, Agent>();

function agentFor(isAllowed: (address: string) => boolean): Agent {
  let agent = agents.get(isAllowed);
  if (!agent) {
    agent = new Agent({ connect: { lookup: guardedLookup(isAllowed) } });
    agents.set(isAllowed, agent);
  }
  return agent;
}

/** Refuse non-HTTP URLs and IP-literal hosts that aren't allowed (the lookup hook never sees those). */
function checkUrl(url: URL, isAllowed: (address: string) => boolean): void {
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new BlockedUrlError(`Refusing to fetch ${url.protocol} URL`);
  }
  const host = url.hostname.replace(/^\[|\]$/g, "");
  if (isIP(host) && !isAllowed(host)) {
    throw new BlockedUrlError(`Refusing to connect: ${host} is not a public address`);
  }
}

export interface PublicFetchOptions {
  timeoutMs: number;
  headers?: Record<string, string>;
  /** Default {@link MAX_BODY_BYTES}. */
  maxBytes?: number;
  /** Which resolved addresses may be connected to. Default {@link isPublicAddress}; tests allow loopback. */
  isAllowedAddress?: (address: string) => boolean;
}

export interface PublicResponse {
  ok: boolean;
  status: number;
  /** Lower-cased Content-Type header, "" when absent. */
  contentType: string;
  /** URL after redirects. */
  finalUrl: string;
  body: Uint8Array;
}

/**
 * GET a URL that came from outside the server, following redirects, and return
 * the body. Throws {@link BlockedUrlError} for a refused URL or address, and on
 * too many redirects or an oversized body.
 */
export async function fetchPublic(url: string, options: PublicFetchOptions): Promise<PublicResponse> {
  const isAllowed = options.isAllowedAddress ?? isPublicAddress;
  const maxBytes = options.maxBytes ?? MAX_BODY_BYTES;
  const dispatcher = agentFor(isAllowed);
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), options.timeoutMs);
  try {
    let current = new URL(url);
    for (let hop = 0; ; hop += 1) {
      checkUrl(current, isAllowed);
      const res = await undiciFetch(current, {
        dispatcher,
        redirect: "manual",
        signal: ac.signal,
        ...(options.headers ? { headers: options.headers } : {}),
      }).catch((err: unknown) => {
        // undici reports a refused lookup as `TypeError: fetch failed` with the refusal as its cause.
        const cause = (err as { cause?: unknown }).cause;
        throw cause instanceof BlockedUrlError ? cause : err;
      });
      const location = res.headers.get("location");
      if (res.status >= 300 && res.status < 400 && location) {
        await res.body?.cancel();
        if (hop >= MAX_REDIRECTS) throw new BlockedUrlError(`More than ${MAX_REDIRECTS} redirects`);
        current = new URL(location, current);
        continue;
      }

      const declared = Number(res.headers.get("content-length"));
      if (Number.isFinite(declared) && declared > maxBytes) {
        await res.body?.cancel();
        throw new BlockedUrlError(`Response of ${declared} bytes exceeds the ${maxBytes}-byte cap`);
      }
      const chunks: Uint8Array[] = [];
      let received = 0;
      if (res.body) {
        for await (const chunk of res.body) {
          received += chunk.byteLength;
          if (received > maxBytes) throw new BlockedUrlError(`Response exceeds the ${maxBytes}-byte cap`);
          chunks.push(chunk);
        }
      }
      const body = new Uint8Array(received);
      let offset = 0;
      for (const chunk of chunks) {
        body.set(chunk, offset);
        offset += chunk.byteLength;
      }
      return {
        ok: res.ok,
        status: res.status,
        contentType: (res.headers.get("content-type") ?? "").toLowerCase(),
        finalUrl: current.href,
        body,
      };
    }
  } finally {
    clearTimeout(timer);
  }
}
