# Development

```bash
git clone https://github.com/emilkrebs/med-research-mcp.git
cd med-research-mcp
npm install
npm test
```

Requires Node.js 22.22.2 or later on 22, 24.15.0 or later on 24, or 26+ (the floor comes from jsdom).

| Script | Description |
| --- | --- |
| `npm run dev` | Run the MCP server with `tsx watch`, restarting on change. |
| `npm run dev:http` | Same for the hosted HTTP entry (`src/http/index.ts`). |
| `npm run build` | Build `dist/`: [tsup](https://tsup.egoist.dev/) for the JavaScript, `tsc --emitDeclarationOnly` for the type declarations. |
| `npm start` | Run the built server (`node dist/mcp/index.js`). |
| `npm run start:http` | Run the built HTTP server (`node dist/http/index.js`); see [hosting.md](hosting.md). |
| `npm test` | Run the test suite with [vitest](https://vitest.dev/). `npm run test:watch` re-runs on change. |
| `npm run typecheck` | Type-check without emitting. |
| `npm run build:mcpb` | Bundle the server with esbuild and pack `dist/med-research-mcp.mcpb` for Claude Desktop. |

The build uses tsup rather than plain `tsc` because it emits **both ESM and CommonJS** for every entry point (`dist/core/index.js` and `.cjs`, and so on). The MCP server runs as ESM, while CommonJS consumers `require()` `med-research-mcp/core` from the same package. A plain `tsc` build produces one module format and would break one side. Both builds inline the package version (`__MED_RESEARCH_VERSION__`, read by `src/core/version.ts`), because the `.mcpb` bundle ships without a `package.json`.

## Layout

| Path | Contents |
| --- | --- |
| `src/core/` | The library: search, adapters, grader, full text, cache. No MCP dependency. See [how-it-works.md](how-it-works.md#architecture). |
| `src/mcp/` | The MCP server (`server.ts`) and its stdio entry (`index.ts`). |
| `src/http/` | The Streamable HTTP entry for hosted deployments. |
| `skills/` | The agent skills, shipped in the npm package. |
| `mcpb/` | The Claude Desktop bundle's manifest and icon. |
| `tests/` | Unit tests. They make no network calls, except to a local test server. |
| `benchmark/` | The answer-quality benchmark, a separate package. See [benchmark/README.md](../benchmark/README.md). |

## Conventions

- **Scientific claims need primary sources.** Every mapping in the grader, and every claim in the skills, cites a source that was checked, not recalled. [Changing the grader](how-it-works.md#changing-the-grader) has the rules.
- **Upstream calls identify themselves.** Requests send the `User-Agent` from `src/core/version.ts` and the contact emails the databases ask for.
- **Tests stay offline.** Adapters and the full-text resolver take injectable HTTP seams; use them instead of the network.
- **Keep the docs in sync.** A change to a tool's behavior usually touches the tool description in `src/mcp/server.ts`, [tools.md](tools.md), [how-it-works.md](how-it-works.md) and the [`med-research`](../skills/med-research/SKILL.md) skill.

## CI

[`.github/workflows/ci.yml`](../.github/workflows/ci.yml) runs on every push to `main` and every pull request, on Node 22.22.2, 24 and 26: typecheck, tests, both builds, a smoke test that unpacks the `.mcpb` and checks it answers `initialize` with the package version, and the benchmark harness's offline tests.

## Releasing

See [publishing.md](publishing.md).
