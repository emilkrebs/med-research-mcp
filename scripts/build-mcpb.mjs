#!/usr/bin/env node
/**
 * Build pipeline for the med-research-mcp MCPB bundle.
 *
 * 1. Bundles src/mcp/index.ts into a single self-contained CommonJS file
 *    with esbuild (mcpb/server/index.js).
 * 2. Packs mcpb/ into dist/med-research-mcp.mcpb via the @anthropic-ai/mcpb CLI.
 *
 * Usage: node scripts/build-mcpb.mjs   (wired up as `npm run build:mcpb`)
 */

import { build } from "esbuild";
import { mkdirSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { spawnSync } from "node:child_process";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(scriptDir, "..");

const serverOutDir = path.join(root, "mcpb", "server");
const distDir = path.join(root, "dist");
const entryPoint = path.join(root, "src", "mcp", "index.ts");
const outfile = path.join(serverOutDir, "index.js");
const mcpbOutfile = path.join(distDir, "med-research-mcp.mcpb");

async function main() {
  console.log("Preparing output directories…");
  mkdirSync(serverOutDir, { recursive: true });
  mkdirSync(distDir, { recursive: true });

  console.log("Bundling…");
  await bundleServer();

  const { size } = statSync(outfile);
  console.log(`Wrote mcpb/server/index.js (${(size / 1024).toFixed(1)} KB)`);

  console.log("Packing…");
  packBundle();

  console.log("Created dist/med-research-mcp.mcpb");
}

async function bundleServer() {
  try {
    await build({
      entryPoints: [entryPoint],
      outfile,
      bundle: true,
      platform: "node",
      format: "cjs",
      target: "node18",
      minify: false,
      sourcemap: false,
    });
  } catch (err) {
    console.error("esbuild bundling failed:");
    console.error(err);
    process.exit(1);
  }
}

function packBundle() {
  const result = spawnSync(
    "npx",
    ["@anthropic-ai/mcpb", "pack", "./mcpb", "./dist/med-research-mcp.mcpb"],
    { stdio: "inherit", cwd: root, shell: false },
  );

  if (result.error) {
    console.error("Failed to run mcpb pack:");
    console.error(result.error);
    process.exit(1);
  }

  if (result.status !== 0) {
    console.error(`mcpb pack exited with status ${result.status}`);
    process.exit(result.status ?? 1);
  }
}

main().catch((err) => {
  console.error("Build failed:");
  console.error(err);
  process.exit(1);
});
