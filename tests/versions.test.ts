import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const readJson = (file: string) => JSON.parse(readFileSync(new URL(`../${file}`, import.meta.url), "utf-8"));

describe("release version", () => {
  it("is the same in package.json, mcpb/manifest.json, plugin.json and the mcp.json pin", () => {
    const pinned = Object.values<{ args?: string[] }>(readJson("mcp.json").mcpServers)
      .flatMap((server) => server.args ?? [])
      .map((arg) => /^med-research-mcp@(.+)$/.exec(arg)?.[1])
      .find(Boolean);

    const { version } = readJson("package.json");
    expect({
      "mcpb/manifest.json": readJson("mcpb/manifest.json").version,
      "plugin.json": readJson("plugin.json").version,
      "mcp.json args": pinned,
    }).toEqual({ "mcpb/manifest.json": version, "plugin.json": version, "mcp.json args": version });
  });
});
