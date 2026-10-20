# Security policy

Security fixes go into the latest release. Please check that a problem still occurs on it before reporting.

## Reporting a vulnerability

Please don't open a public issue. Report it privately, either on GitHub (the repository's **Security** tab → **Report a vulnerability**) or by email to <hello@emilkrebs.dev>. Include the version, how you run the server (stdio, the `.mcpb` bundle or the HTTP server), the steps to reproduce, and what an attacker gains.

Fixes are announced in the release notes once a fixed version is out.

## What counts

- Getting `literature_fulltext` to fetch a loopback, private, link-local or cloud-metadata address, or getting around its redirect, DNS or size checks.
- Getting around the HTTP server's bearer token, rate limits or concurrency limits.
- Anything that exposes queries, results, environment variables (API keys, the proxy prefix) or another user's data.
- A vulnerable dependency, when the way the server uses it makes the vulnerability reachable.

Not security issues, so open a normal issue for them: wrong or missing search results or design labels, upstream outages and rate limits, and anything that needs `MED_RESEARCH_FULLTEXT_ALLOW_PRIVATE=1`, which turns the address check off on purpose. If you run a hosted instance, see [Security in hosting.md](https://github.com/emilkrebs/med-research-mcp/blob/main/docs/hosting.md#security).
