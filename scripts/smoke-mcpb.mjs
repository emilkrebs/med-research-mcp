#!/usr/bin/env node
/**
 * End-to-end check of an unpacked .mcpb, run by CI after `npm run build:mcpb`:
 *
 *   node scripts/smoke-mcpb.mjs <unpacked-dir>/server/index.js
 *
 * Starts the bundled server the way Claude Desktop does (stdio, outside the
 * repository), checks `initialize` reports the package version, then resolves
 * an HTML page and a PDF through `literature_fulltext`'s proxy route from a
 * local server. That exercises the parts a bundle can break: jsdom and
 * Readability for HTML, pdf.js and its inlined worker for PDF. No network:
 * without a contact email the Unpaywall lookup is skipped, and the address
 * check is opted out for the local server with MED_RESEARCH_FULLTEXT_ALLOW_PRIVATE.
 */

import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const entry = path.resolve(process.argv[2] ?? "");
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const { version } = JSON.parse(readFileSync(path.join(root, "package.json"), "utf-8"));

const SENTENCE = "Participants received 5 g of creatine daily for six weeks, and memory scores were measured at baseline and follow-up.";

const html = `<!doctype html><html><head><title>Smoke test</title></head><body><article>
<h1>Creatine and memory: a randomised trial</h1>
${Array.from({ length: 8 }, () => `<p>${SENTENCE}</p>`).join("\n")}
</article></body></html>`;

/** A one-page PDF with enough text to pass the 500-character stub threshold. */
function pdf() {
  const lines = Array.from({ length: 8 }, (_, i) => `BT /F1 10 Tf 40 ${740 - i * 16} Td (${SENTENCE}) Tj ET`).join("\n");
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>",
    `<< /Length ${lines.length} >>\nstream\n${lines}\nendstream`,
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
  ];
  let out = "%PDF-1.4\n";
  const offsets = objects.map((body, i) => {
    const offset = out.length;
    out += `${i + 1} 0 obj\n${body}\nendobj\n`;
    return offset;
  });
  const xref = out.length;
  out += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const offset of offsets) out += `${String(offset).padStart(10, "0")} 00000 n \n`;
  out += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(out, "latin1");
}

const server = createServer((req, res) => {
  if (req.url === "/proxy/10.1000/smoke-html") {
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    res.end(html);
  } else if (req.url === "/proxy/10.1000/smoke-pdf") {
    res.writeHead(200, { "content-type": "application/pdf" });
    res.end(pdf());
  } else {
    res.writeHead(404);
    res.end();
  }
});
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const port = server.address().port;

const env = { ...process.env };
for (const name of ["NCBI_EMAIL", "NCBI_API_KEY", "MED_RESEARCH_UNPAYWALL_EMAIL", "MED_RESEARCH_CHINAXIV_EMAIL"]) delete env[name];
env.MED_RESEARCH_PROXY_PREFIX = `http://127.0.0.1:${port}/proxy`;
env.MED_RESEARCH_FULLTEXT_ALLOW_PRIVATE = "1";

const child = spawn(process.execPath, [entry], { cwd: tmpdir(), env, stdio: ["pipe", "pipe", "inherit"] });
const pending = new Map();
let buffered = "";
child.stdout.on("data", (chunk) => {
  buffered += chunk;
  let newline;
  while ((newline = buffered.indexOf("\n")) >= 0) {
    const line = buffered.slice(0, newline).trim();
    buffered = buffered.slice(newline + 1);
    if (!line) continue;
    const message = JSON.parse(line);
    pending.get(message.id)?.(message);
  }
});

let nextId = 1;
function request(method, params) {
  const id = nextId++;
  child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
  return new Promise((resolve) => pending.set(id, resolve));
}

const failures = [];
const timer = setTimeout(() => {
  console.error("smoke test timed out");
  process.exit(1);
}, 60_000);

try {
  const init = await request("initialize", {
    protocolVersion: "2025-06-18",
    capabilities: {},
    clientInfo: { name: "smoke", version: "0" },
  });
  if (init.result?.serverInfo?.version !== version) failures.push(`initialize: version ${init.result?.serverInfo?.version}, expected ${version}`);
  child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" })}\n`);

  for (const [doi, format] of [
    ["10.1000/smoke-html", "markdown"],
    ["10.1000/smoke-pdf", "pdf"],
  ]) {
    const response = await request("tools/call", { name: "literature_fulltext", arguments: { id: "1", doi } });
    const result = JSON.parse(response.result?.content?.[0]?.text ?? "{}");
    const ok = result.source === "proxy" && result.format === format && result.fulltext?.includes("5 g of creatine daily");
    console.log(`${ok ? "ok  " : "FAIL"} ${format}: source=${result.source} format=${result.format} chars=${result.fulltext?.length ?? 0}`);
    if (!ok) failures.push(`${format}: ${JSON.stringify(result).slice(0, 300)}`);
  }
} finally {
  clearTimeout(timer);
  child.kill();
  server.close();
}

if (failures.length > 0) {
  console.error(failures.join("\n"));
  process.exit(1);
}
console.log(`ok   ${path.relative(process.cwd(), entry)} answers as med-research-mcp ${version} and extracts HTML and PDF`);
