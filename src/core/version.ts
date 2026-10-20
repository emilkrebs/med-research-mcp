/**
 * The package version, the User-Agent every upstream request sends, and the
 * contact email it carries: the user's, or the project's.
 *
 * Both builds inline the version (tsup.config.ts, scripts/build-mcpb.mjs): the
 * .mcpb bundle ships without a package.json to read. package.json is read only
 * when running from source (tsx, vitest).
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";

declare const __MED_RESEARCH_VERSION__: string | undefined;

/** The package version. */
export function packageVersion(): string {
  if (typeof __MED_RESEARCH_VERSION__ !== "undefined") return __MED_RESEARCH_VERSION__;
  // __dirname exists in CJS; import.meta.dirname in ESM (see src/core/cache.ts loadSqlite).
  const moduleDir = typeof __dirname !== "undefined" ? __dirname : import.meta.dirname;
  return (JSON.parse(readFileSync(join(moduleDir, "../../package.json"), "utf-8")) as { version: string }).version;
}

/** Identifies the client to upstream APIs and publishers, with a contact URL. */
export const USER_AGENT = `med-research-mcp/${packageVersion()} (https://github.com/emilkrebs/med-research-mcp)`;

/** The `tool` name this software sends to NCBI, registered there together with PROJECT_CONTACT_EMAIL. */
export const PROJECT_TOOL = "med-research-mcp";

/**
 * The project's contact address, sent to NCBI and Unpaywall by this project's own tool when the user
 * sets no email of their own. NCBI asks for "a complete and valid e-mail address of the software
 * developer" (NBK25497) and contacts it before blocking an IP; Unpaywall requires an email on every
 * request.
 */
export const PROJECT_CONTACT_EMAIL = "hello@emilkrebs.dev";

/** A `${user_config.…}` reference an MCP host may leave in place of an empty installer field (mcpb/manifest.json). */
const PLACEHOLDER = /^\$\{[^}]*\}$/;

/** A setting's value, or undefined when it's blank or an unfilled placeholder. */
function setting(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed && !PLACEHOLDER.test(trimmed) ? trimmed : undefined;
}

/**
 * The first of the environment variables `names` that is set. A blank variable (`NCBI_EMAIL=` in a
 * .env file) counts as unset, and so does a `${…}` placeholder an MCP host left unfilled.
 */
export function envSetting(...names: string[]): string | undefined {
  for (const name of names) {
    const value = setting(process.env[name]);
    if (value) return value;
  }
  return undefined;
}

/**
 * The contact email requests from `tool` carry: `email` when code passes one (a blank one sends
 * none), else the first set of the environment variables `env`, else, for this project's own tool
 * only, PROJECT_CONTACT_EMAIL. Software built on the library sends its own tool name, and so never
 * borrows the project's address.
 */
export function contactEmail(email: string | undefined, env: readonly string[], tool: string): string | undefined {
  if (email !== undefined) return setting(email);
  return envSetting(...env) ?? (tool === PROJECT_TOOL ? PROJECT_CONTACT_EMAIL : undefined);
}
