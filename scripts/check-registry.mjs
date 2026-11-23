// Guards the identity contract between package.json and server.json.
// The official MCP registry proves npm ownership from package.json's mcpName
// and rejects a server.json whose name, identifier, version, schema, transport
// or description length disagrees. Dependency-free: runs before npm ci.
import { readFileSync } from "node:fs";

const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf-8"));
const server = JSON.parse(readFileSync(new URL("../server.json", import.meta.url), "utf-8"));
const SCHEMA = "https://static.modelcontextprotocol.io/schemas/2025-12-11/server.schema.json";

const errors = [];
const check = (ok, message) => {
  if (!ok) errors.push(message);
};

check(pkg.mcpName === server.name, `package.json mcpName (${pkg.mcpName}) must equal server.json name (${server.name})`);
const p = server.packages?.[0];
check(p?.identifier === pkg.name, `server.json packages[0].identifier (${p?.identifier}) must equal package.json name (${pkg.name})`);
check(
  server.version === pkg.version && p?.version === pkg.version,
  `versions must match: package.json ${pkg.version}, server.json ${server.version}, packages[0] ${p?.version}`,
);
check(server.$schema === SCHEMA, `server.json $schema must be the pinned schema URL (${SCHEMA})`);
check(p?.transport?.type === "stdio", `packages[0].transport.type must be "stdio" (got ${p?.transport?.type})`);
check(
  typeof server.description === "string" && server.description.length <= 100,
  `server.json description must be a string of at most 100 characters (got ${server.description?.length})`,
);

if (errors.length) {
  for (const e of errors) console.error(`check-registry: ${e}`);
  process.exit(1);
}
console.log(`check-registry: OK (${server.name}@${server.version}, description ${server.description.length}/100)`);
