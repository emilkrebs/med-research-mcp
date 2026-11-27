#!/usr/bin/env node
/**
 * Keeps package.json and server.json in agreement about the MCP registry entry.
 *
 * The registry matches a published npm package to a server name through the
 * package's `mcpName`, and the schema it validates against fixes the shape of
 * server.json, so the two files can disagree only by being edited separately.
 * This check runs in CI (`npm run check:registry`) and in the release job before
 * `npm publish`, so a server.json the registry would reject fails before the
 * version is on npm rather than at `mcp-publisher publish`.
 *
 * It checks what the registry needs from this project, not the whole schema:
 * every entry in `packages` is this npm package, at this version, over stdio.
 */

import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const readJson = (file) => JSON.parse(readFileSync(path.join(root, file), "utf-8"));

const SCHEMA = "https://static.modelcontextprotocol.io/schemas/2025-12-11/server.schema.json";
const DESCRIPTION_LIMIT = 100;

const pkg = readJson("package.json");
const server = readJson("server.json");

const failures = [];
function expectEqual(actual, wanted, what) {
  if (actual !== wanted) failures.push(`${what} is ${JSON.stringify(actual)}, expected ${JSON.stringify(wanted)}`);
}
function expectNonEmptyString(value, what) {
  if (typeof value !== "string" || value.trim() === "") failures.push(`${what} is ${JSON.stringify(value)}, expected a non-empty string`);
}

expectEqual(server.$schema, SCHEMA, "server.json $schema");
expectNonEmptyString(pkg.mcpName, "package.json mcpName");
expectNonEmptyString(server.name, "server.json name");
expectEqual(pkg.mcpName, server.name, "package.json mcpName and server.json name");
expectEqual(server.version, pkg.version, "server.json version and package.json version");
// The project site is the one homepage users should land on, so it cannot drift
// between what npm shows and what the registry lists.
expectEqual(server.websiteUrl, pkg.homepage, "server.json websiteUrl and package.json homepage");

const { description } = server;
if (typeof description !== "string" || description.trim() === "" || description.length > DESCRIPTION_LIMIT) {
  const length = typeof description === "string" ? `${description.length} characters` : "missing";
  failures.push(`server.json description is ${length}, the registry requires 1 to ${DESCRIPTION_LIMIT}`);
}

if (!Array.isArray(server.packages) || server.packages.length === 0) {
  failures.push("server.json packages is missing or empty, expected the npm package");
} else {
  server.packages.forEach((entry, i) => {
    const at = `server.json packages[${i}]`;
    expectEqual(entry?.registryType, "npm", `${at}.registryType`);
    expectEqual(entry?.identifier, pkg.name, `${at}.identifier and package.json name`);
    expectEqual(entry?.version, pkg.version, `${at}.version and package.json version`);
    expectEqual(entry?.transport?.type, "stdio", `${at}.transport.type`);
  });
}

if (failures.length > 0) {
  for (const failure of failures) console.error(failure);
  process.exit(1);
}

console.log(`registry metadata ok (${pkg.name} ${pkg.version})`);
