#!/usr/bin/env node
/**
 * Keeps package.json and server.json in agreement about the MCP registry entry.
 *
 * The registry matches a published npm package to a server name through the
 * package's `mcpName`, and the schema it validates against fixes the shape of
 * server.json, so the two files can disagree only by being edited separately.
 * This check runs in CI (`npm run check:registry`) before a publish that the
 * registry would otherwise reject.
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
const pkgEntry = server.packages?.[0] ?? {};

const failures = [];
function expectEqual(actual, wanted, what) {
  if (actual !== wanted) failures.push(`${what} is ${JSON.stringify(actual)}, expected ${JSON.stringify(wanted)}`);
}

expectEqual(pkg.mcpName, server.name, "package.json mcpName and server.json name");
expectEqual(pkgEntry.identifier, pkg.name, "server.json packages[0].identifier and package.json name");
expectEqual(pkgEntry.version, pkg.version, "server.json packages[0].version and package.json version");
expectEqual(server.version, pkg.version, "server.json version and package.json version");
expectEqual(server.$schema, SCHEMA, "server.json $schema");
expectEqual(pkgEntry.transport?.type, "stdio", "server.json packages[0].transport.type");

if (typeof server.description !== "string" || server.description.length > DESCRIPTION_LIMIT) {
  failures.push(`server.json description is ${server.description?.length ?? "missing"} characters, the registry allows at most ${DESCRIPTION_LIMIT}`);
}

if (failures.length > 0) {
  for (const failure of failures) console.error(failure);
  process.exit(1);
}

console.log(`registry metadata ok (${pkg.name} ${pkg.version})`);
