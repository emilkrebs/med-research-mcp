#!/usr/bin/env node
/**
 * Build pipeline for the med-research-mcp MCPB bundle.
 *
 * 1. Bundles src/mcp/index.ts into one CommonJS file with esbuild
 *    (mcpb/server/index.js). Two dependencies can't be bundled:
 *    - jsdom reads its own files at runtime (a default stylesheet, a sync-XHR
 *      worker), so it stays external and its dependency tree, all plain
 *      JavaScript, is copied from node_modules into mcpb/server/node_modules;
 *    - pdf-parse loads pdf.js's worker from a file next to itself and gets
 *      DOMMatrix from @napi-rs/canvas, a native module that can't ship in a
 *      cross-platform bundle. The worker is inlined as a data URL instead
 *      (__MED_RESEARCH_PDF_WORKER__), and src/core/fulltext.ts then installs a
 *      DOMMatrix of its own.
 * 2. Packs mcpb/ into dist/med-research-mcp.mcpb via the @anthropic-ai/mcpb CLI.
 *
 * Usage: node scripts/build-mcpb.mjs   (wired up as `npm run build:mcpb`)
 */

import { build } from "esbuild";
import { cpSync, mkdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { execFileSync, spawnSync } from "node:child_process";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(scriptDir, "..");

const serverOutDir = path.join(root, "mcpb", "server");
const distDir = path.join(root, "dist");
const entryPoint = path.join(root, "src", "mcp", "index.ts");
const outfile = path.join(serverOutDir, "index.js");
const mcpbOutfile = path.join(distDir, "med-research-mcp.mcpb");

const readJson = (file) => JSON.parse(readFileSync(path.join(root, file), "utf-8"));
const { version } = readJson("package.json");

async function main() {
  const manifestVersion = readJson("mcpb/manifest.json").version;
  if (manifestVersion !== version) {
    console.error(`mcpb/manifest.json version ${manifestVersion} doesn't match package.json version ${version}.`);
    process.exit(1);
  }

  console.log("Preparing output directories…");
  mkdirSync(serverOutDir, { recursive: true });
  mkdirSync(distDir, { recursive: true });

  console.log("Bundling…");
  await bundleServer();

  const { size } = statSync(outfile);
  console.log(`Wrote mcpb/server/index.js (${(size / 1024).toFixed(1)} KB)`);

  console.log("Copying jsdom and its dependencies…");
  const copied = copyDependencyTree("jsdom");
  console.log(`Copied ${copied} packages to mcpb/server/node_modules`);

  console.log("Packing…");
  packBundle();

  console.log("Created dist/med-research-mcp.mcpb");
}

/** pdf.js's worker, from the pdfjs-dist that pdf-parse itself resolves, as a data URL. */
function pdfWorkerDataUrl() {
  const fromPdfParse = createRequire(createRequire(path.join(root, "package.json")).resolve("pdf-parse"));
  const worker = fromPdfParse.resolve("pdfjs-dist/legacy/build/pdf.worker.mjs");
  return `data:text/javascript;base64,${readFileSync(worker).toString("base64")}`;
}

/**
 * Copy a package and everything it depends on from the installed node_modules
 * (so the versions are the lockfile's) into mcpb/server/node_modules, keeping
 * the layout so Node resolves them from the bundle. Source maps and type
 * declarations are left out; licences stay.
 */
function copyDependencyTree(name) {
  const target = path.join(serverOutDir, "node_modules");
  rmSync(target, { recursive: true, force: true });
  const nodes = JSON.parse(
    execFileSync("npm", ["query", `#${name}, #${name} *`, "--json"], { cwd: root, encoding: "utf-8", maxBuffer: 64 * 1024 * 1024 }),
  );
  const locations = [...new Set(nodes.filter((n) => !n.dev && n.location.startsWith("node_modules/")).map((n) => n.location))];
  for (const location of locations) {
    cpSync(path.join(root, location), path.join(serverOutDir, location), {
      recursive: true,
      filter: (source) => !/\.(map|d\.ts|d\.mts|d\.cts)$/.test(source),
    });
  }
  return locations.length;
}

async function bundleServer() {
  try {
    await build({
      entryPoints: [entryPoint],
      outfile,
      bundle: true,
      platform: "node",
      format: "cjs",
      target: "node22",
      external: ["jsdom", "@napi-rs/canvas"],
      define: {
        // The bundle ships without package.json; src/core/version.ts reads this instead.
        __MED_RESEARCH_VERSION__: JSON.stringify(version),
        __MED_RESEARCH_PDF_WORKER__: JSON.stringify(pdfWorkerDataUrl()),
      },
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
