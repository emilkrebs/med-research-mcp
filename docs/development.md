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
| `npm run build:mcpb` | Bundle the server with esbuild and pack `dist/med-research-mcp.mcpb` for Claude Desktop (see below). |

The build uses tsup rather than plain `tsc` because it emits **both ESM and CommonJS** for every entry point (`dist/core/index.js` and `.cjs`, and so on). The MCP server runs as ESM, while CommonJS consumers `require()` `med-research-mcp/core` from the same package. A plain `tsc` build produces one module format and would break one side. Both builds inline the package version (`__MED_RESEARCH_VERSION__`, read by `src/core/version.ts`), because the `.mcpb` bundle ships without a `package.json`.

The `.mcpb` is one esbuild bundle plus two exceptions ([`scripts/build-mcpb.mjs`](../scripts/build-mcpb.mjs)). jsdom reads its own files at runtime, so it stays outside the bundle and its dependency tree, plain JavaScript, is copied into `mcpb/server/node_modules`. pdf-parse loads pdf.js's worker from a file and gets `DOMMatrix` from a native module that can't ship in a cross-platform bundle, so the worker is inlined as a data URL and `src/core/fulltext.ts` installs a small `DOMMatrix` of its own. [`scripts/smoke-mcpb.mjs`](../scripts/smoke-mcpb.mjs) checks the result end to end.

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
- **ModelScope reads the README.** Its listing takes the server config and environment variables from the README's first `mcpServers` JSON block, so that block stays the stdio config, free of comments, with `mcpServers` at the top level. Links and images use absolute URLs: ModelScope shows a relative link as plain text and drops a relative image.

## CI

[`.github/workflows/ci.yml`](../.github/workflows/ci.yml) runs on every push to `main` and every pull request, on Node 22.22.2, 24 and 26: typecheck, tests, both builds, a smoke test that unpacks the `.mcpb`, checks it answers `initialize` with the package version and resolves an HTML page and a PDF through it from a local server, and the benchmark harness's offline tests.

## Releasing

1. Make sure CI is green on `main`.
2. Set the version in `package.json` with `npm version <x.y.z> --no-git-tag-version`, then in `mcpb/manifest.json`, `plugin.json` and `mcp.json` (`build:mcpb` refuses a manifest version that differs from `package.json`). A pre-release has a suffix: `0.7.0-next.0`, `0.7.0-next.1`, …
3. Run the checks the release depends on, then commit and push to `main`, or merge a pull request with the change:

   ```bash
   npm ci
   npm run typecheck && npm test
   npm run build && npm run build:mcpb
   npm pack --dry-run   # should list dist/core, dist/mcp, dist/http, src, skills, mcpb/manifest.json
   ```

4. From `main`, create a draft GitHub release with the `.mcpb` attached. Its notes, generated from the merged pull requests, are the project's changelog: edit them on GitHub to say what changed for users, then publish the draft. For a pre-release, add `--prerelease`, so that GitHub's latest release, which the README's Claude Desktop instructions link to, stays the last release.

   ```bash
   git switch main && git pull
   npm run build:mcpb
   gh release create v<x.y.z> dist/med-research-mcp.mcpb --target main --title v<x.y.z> --generate-notes --draft
   ```

Publishing the release runs [`publish.yml`](../.github/workflows/publish.yml). It checks that the tag is `v` plus the version in `package.json` and that the release's pre-release setting matches the version, runs the typecheck and tests, and runs `npm publish` with [trusted publishing](https://docs.npmjs.com/trusted-publishers): no token, and npm adds provenance. A pre-release goes to the `next` dist-tag and any other version to `latest`. The trusted publisher on npmjs.com names the workflow file and the `publish` environment, so renaming either stops publishing until it's changed there too. A run that fails before `npm publish` has published nothing: fix the cause and re-run it, or, if the fix needs a new commit, delete the release and its tag and create them again.

Once it has published, check the package the way a client runs it, from a directory outside the repository and with no environment variables set: it must start, keep stdout clean (stdout is the MCP channel; logs go to stderr), and list three tools.

```bash
cd "$(mktemp -d)"
printf '%s\n' \
  '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"check","version":"0"}}}' \
  '{"jsonrpc":"2.0","method":"notifications/initialized"}' \
  '{"jsonrpc":"2.0","id":2,"method":"tools/list","params":{}}' \
  | npx -y med-research-mcp@<x.y.z>
```
