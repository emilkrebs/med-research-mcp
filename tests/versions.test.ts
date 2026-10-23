import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const readJson = (file: string) => JSON.parse(readFileSync(new URL(`../${file}`, import.meta.url), "utf-8"));

describe("release version", () => {
  it("is the same in package.json, mcpb/manifest.json and plugin.json", () => {
    const { version } = readJson("package.json");
    expect({
      "mcpb/manifest.json": readJson("mcpb/manifest.json").version,
      "plugin.json": readJson("plugin.json").version,
    }).toEqual({ "mcpb/manifest.json": version, "plugin.json": version });
  });

  it("pins the version in mcp.json and passes no other package to npx", () => {
    // npx takes the first positional as the package, so one stray argument runs another package:
    // a "2" once would have run npm's "2" and never started the server. A regex over @version
    // alone matched the pin and missed it (2026-10-23), so the whole list is compared here.
    const { version } = readJson("package.json");
    const servers = Object.values<{ command?: string; args?: string[] }>(readJson("mcp.json").mcpServers);
    expect(servers).toHaveLength(1);
    expect(servers[0].command).toBe("npx");
    expect(servers[0].args).toEqual(["-y", `med-research-mcp@${version}`]);
  });
});
