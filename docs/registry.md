# Publishing to the MCP registry and other directories

The [official MCP registry](https://registry.modelcontextprotocol.io) is the list that MCP clients and directory sites crawl. A server that is not in it is invisible to those clients even when its npm package is published, so the entry is part of a release, not an optional extra.

`server.json` at the repository root describes the entry, and `package.json` carries `mcpName`, the field that ties the npm package to it. `npm run check:registry` verifies that the two agree and runs in CI before anything is published.

## What the registry verifies

- **The namespace.** `io.github.emilkrebs/…` is derived from the GitHub login that owns the repository. Publishing after `mcp-publisher login github` proves that login, which is why the namespace cannot be claimed by another account.
- **The package.** The npm package named in `server.json` must be published and must carry `mcpName` equal to `server.json`'s `name`. That field is how the registry finds the package that implements the entry.
- **The version.** The version in `server.json` must be the version that is published on npm. The registry checks the published package, so a version npm does not have is rejected.

## Publishing, step by step

Run this from a clean checkout of `main`, with the npm account that owns the package logged in.

```bash
# 1. Bump the version everywhere it is recorded. `npm version` updates
#    package.json and package-lock.json; the other manifests bump with it.
npm version 0.8.1
#    Then set the same version in server.json, mcp.json, plugin.json and
#    mcpb/manifest.json, and run `npm run check:registry` to prove it.

# 2. Publish to npm first. The registry reads this package.
npm run build
npm publish

# 3. Install the publisher, once.
brew install mcp-publisher
#    Or download the release tarball for your platform from
#    https://github.com/modelcontextprotocol/registry/releases

# 4. Prove the GitHub login that owns io.github.emilkrebs.
mcp-publisher login github

# 5. Validate server.json against the current schema, then publish it.
mcp-publisher validate server.json
mcp-publisher publish

# Later, to withdraw a version without deleting the entry:
mcp-publisher status
```

`mcp-publisher status` lists the versions the registry holds for the entry and can deprecate one. Deprecating leaves the entry in place for clients still pinned to that version and marks it as no longer current.

## The order that matters

Publish to npm first, then to the registry. The registry fetches the published package to check its `mcpName` and its version, so an entry for a version npm does not have is rejected. Doing it the other way round also leaves a window in which clients can find a version they cannot install.

## Other directories

These sites list servers independently of the official registry. Submit the same facts to each; the text below is what to paste.

### mcp.so

Use the submit form on <https://mcp.so>. The URL field takes the GitHub repository, not the npm package.

```
Name: Med Research
URL: https://github.com/emilkrebs/med-research-mcp
Short description: PubMed, Europe PMC and ChinaRxiv search with study-design and retraction labels.
Category: Science / Healthcare
```

### mcpservers.org (Awesome MCP Servers)

Use the submission form on <https://mcpservers.org/submit>.

```
Name: Med Research
URL: https://github.com/emilkrebs/med-research-mcp
Description: PubMed, Europe PMC and ChinaRxiv search with study-design and retraction labels.
Category: Science & Research
```

### PulseMCP

Use the submission form on <https://www.pulsemcp.com/submit>. PulseMCP mirrors the official registry, so after the registry publish in the previous section the server may appear there without a submission. Submit only if it has not appeared after a few days.

### Smithery

Smithery reads a `smithery.yaml` at the repository root. Add this file, then submit the repository at <https://smithery.ai>.

```yaml
startCommand:
  type: stdio
  configSchema:
    type: object
    properties: {}
  commandFunction: |-
    (config) => ({ command: "npx", args: ["-y", "med-research-mcp"] })
```

### Awesome lists

Both lists take a pull request with one line in the Science/Research section, in alphabetical order by name.

```markdown
- [med-research-mcp](https://github.com/emilkrebs/med-research-mcp) - PubMed, Europe PMC and ChinaRxiv search with study-design and retraction labels.
```

The list files are `README.md` in [punkpeye/awesome-mcp-servers](https://github.com/punkpeye/awesome-mcp-servers) and [wong2/awesome-mcp-servers](https://github.com/wong2/awesome-mcp-servers). Keep the line identical in both so the two entries do not drift.

## What not to do

- Do not publish the registry entry for a version that npm does not have. The registry rejects it, and the failed attempt makes the entry look stale.
- Do not reuse `mcpName` across packages. One package owns one registry name; a second package with the same name makes the match ambiguous.
- Do not hand-edit the registry through its API. `mcp-publisher` validates and signs the request, and a hand-made one can leave the entry in a state the tool cannot repair.
