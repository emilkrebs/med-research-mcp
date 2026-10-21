// Fails when the release version differs between package.json, mcpb/manifest.json,
// plugin.json and the pinned `med-research-mcp@x.y.z` in mcp.json's args.
import { readFileSync } from "node:fs";

const readJson = (file) => JSON.parse(readFileSync(new URL(`../${file}`, import.meta.url), "utf-8"));

const pinned = Object.values(readJson("mcp.json").mcpServers)
  .flatMap((server) => server.args ?? [])
  .map((arg) => /^med-research-mcp@(.+)$/.exec(arg)?.[1])
  .find(Boolean);

const versions = {
  "package.json": readJson("package.json").version,
  "mcpb/manifest.json": readJson("mcpb/manifest.json").version,
  "plugin.json": readJson("plugin.json").version,
  "mcp.json (args)": pinned,
};

for (const [file, version] of Object.entries(versions)) console.log(`${file.padEnd(20)} ${version ?? "MISSING"}`);

if (new Set(Object.values(versions)).size !== 1 || Object.values(versions).includes(undefined)) {
  console.error("Version mismatch: bump all four sources together.");
  process.exit(1);
}
