import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { BlockedUrlError, fetchPublic, isPublicAddress, MAX_REDIRECTS } from "../src/core/public-fetch";

describe("isPublicAddress", () => {
  it.each([
    "8.8.8.8",
    "93.184.215.14",
    "2606:4700:4700::1111",
    "64:ff9b::808:808", // NAT64 for 8.8.8.8
    "::ffff:8.8.8.8",
  ])("allows %s", (address) => {
    expect(isPublicAddress(address)).toBe(true);
  });

  it.each([
    "127.0.0.1",
    "10.1.2.3",
    "172.16.0.1",
    "192.168.1.1",
    "169.254.169.254", // AWS, GCP, Azure, DigitalOcean metadata
    "100.100.100.200", // Alibaba Cloud metadata
    "0.0.0.0",
    "224.0.0.1",
    "255.255.255.255",
    "::",
    "::1",
    "fe80::1",
    "fe80::1%eth0",
    "fc00::1",
    "fd12:3456::1",
    "::ffff:127.0.0.1",
    "::ffff:7f00:1",
    "::ffff:169.254.169.254",
    "64:ff9b::7f00:1", // NAT64 for 127.0.0.1
    "64:ff9b::a9fe:a9fe", // NAT64 for 169.254.169.254
    "168.63.129.16", // Azure platform endpoint
    "::ffff:0:7f00:1", // IPv4-translated 127.0.0.1
    "2001:0:4136:e378:8000:63bf:3fff:fdd2", // Teredo
    "fec0::1", // site-local
    "fd00:ec2::254", // AWS IPv6 metadata
    "not-an-ip",
  ])("refuses %s", (address) => {
    expect(isPublicAddress(address)).toBe(false);
  });
});

describe("fetchPublic", () => {
  let server: Server;
  let base: string;
  const loopbackOnly = (address: string): boolean => address === "127.0.0.1";

  beforeAll(async () => {
    server = createServer((req, res) => {
      const path = req.url ?? "/";
      if (path === "/article") {
        res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
        res.end("<html><body>article</body></html>");
      } else if (path === "/hop") {
        res.writeHead(302, { location: "/article" });
        res.end();
      } else if (path === "/to-metadata") {
        res.writeHead(302, { location: "http://169.254.169.254/latest/meta-data/" });
        res.end();
      } else if (path === "/to-file") {
        res.writeHead(302, { location: "file:///etc/passwd" });
        res.end();
      } else if (path === "/loop") {
        res.writeHead(302, { location: "/loop" });
        res.end();
      } else if (path === "/big") {
        res.writeHead(200, { "content-type": "application/pdf", "content-length": "4096" });
        res.end(Buffer.alloc(4096));
      } else if (path === "/big-chunked") {
        res.writeHead(200, { "content-type": "application/pdf" });
        res.write(Buffer.alloc(2048));
        res.end(Buffer.alloc(2048));
      } else {
        res.writeHead(404);
        res.end();
      }
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  it("refuses a loopback IP-literal URL by default, before connecting", async () => {
    await expect(fetchPublic(`${base}/article`, { timeoutMs: 5_000 })).rejects.toBeInstanceOf(BlockedUrlError);
  });

  it("refuses a host name that resolves to loopback, at connect time", async () => {
    const port = (server.address() as AddressInfo).port;
    await expect(fetchPublic(`http://localhost:${port}/article`, { timeoutMs: 5_000 })).rejects.toBeInstanceOf(
      BlockedUrlError,
    );
  });

  it("connects to a host name through the lookup hook when its address is allowed", async () => {
    const port = (server.address() as AddressInfo).port;
    const res = await fetchPublic(`http://localhost:${port}/article`, {
      timeoutMs: 5_000,
      isAllowedAddress: (address) => address === "127.0.0.1" || address === "::1",
    });
    expect(res.ok).toBe(true);
    expect(new TextDecoder().decode(res.body)).toContain("article");
  });

  it("names why a URL was refused", async () => {
    await expect(fetchPublic(`${base}/article`, { timeoutMs: 5_000 })).rejects.toMatchObject({ reason: "address" });
    await expect(fetchPublic("file:///etc/passwd", { timeoutMs: 5_000 })).rejects.toMatchObject({ reason: "protocol" });
  });

  it("refuses non-HTTP URLs", async () => {
    await expect(fetchPublic("file:///etc/passwd", { timeoutMs: 5_000 })).rejects.toBeInstanceOf(BlockedUrlError);
  });

  it("follows redirects and reports the final URL", async () => {
    const res = await fetchPublic(`${base}/hop`, { timeoutMs: 5_000, isAllowedAddress: loopbackOnly });
    expect(res.ok).toBe(true);
    expect(res.finalUrl).toBe(`${base}/article`);
    expect(res.contentType).toBe("text/html; charset=utf-8");
    expect(new TextDecoder().decode(res.body)).toContain("article");
  });

  it("checks every redirect: no hop to a metadata address or a file: URL", async () => {
    await expect(
      fetchPublic(`${base}/to-metadata`, { timeoutMs: 5_000, isAllowedAddress: loopbackOnly }),
    ).rejects.toBeInstanceOf(BlockedUrlError);
    await expect(
      fetchPublic(`${base}/to-file`, { timeoutMs: 5_000, isAllowedAddress: loopbackOnly }),
    ).rejects.toBeInstanceOf(BlockedUrlError);
  });

  it(`gives up after ${MAX_REDIRECTS} redirects`, async () => {
    await expect(
      fetchPublic(`${base}/loop`, { timeoutMs: 5_000, isAllowedAddress: loopbackOnly }),
    ).rejects.toThrow(/redirects/);
  });

  it("caps the body, whether or not the size is declared", async () => {
    const options = { timeoutMs: 5_000, isAllowedAddress: loopbackOnly, maxBytes: 1024 };
    await expect(fetchPublic(`${base}/big`, options)).rejects.toThrow(/cap/);
    await expect(fetchPublic(`${base}/big-chunked`, options)).rejects.toThrow(/cap/);
    const ok = await fetchPublic(`${base}/big`, { ...options, maxBytes: 8192 });
    expect(ok.body.byteLength).toBe(4096);
  });
});
