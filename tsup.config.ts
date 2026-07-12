import { defineConfig } from "tsup";

// Dual ESM + CJS build. Explicit entry names preserve the core/ vs mcp/ split
// so the two `index` entries don't collide in the output directory.
export default defineConfig({
  entry: {
    "core/index": "src/core/index.ts",
    "core/cache": "src/core/cache.ts",
    "mcp/index": "src/mcp/index.ts",
  },
  format: ["esm", "cjs"],
  // Declarations are emitted separately by `tsc --emitDeclarationOnly` (see the
  // build script). tsup's bundled rollup-plugin-dts can't drive the TypeScript 7
  // native compiler, so we let tsc handle .d.ts directly.
  dts: false,
  target: "node18",
  outDir: "dist",
  sourcemap: true,
  clean: true,
  // The MCP entry is executable; keep its shebang and don't split it.
  splitting: false,
  shims: false,
});
