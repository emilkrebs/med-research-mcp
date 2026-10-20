/**
 * The package version, the User-Agent every upstream request sends, and the
 * project's contact address.
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

/**
 * The project's contact address, sent to NCBI (with its tool name) and to Unpaywall when the user
 * sets no email of their own. NCBI asks for "a complete and valid e-mail address of the software
 * developer" (NBK25497) and contacts it before blocking an IP; Unpaywall requires an email on every
 * request.
 */
export const PROJECT_CONTACT_EMAIL = "hello@emilkrebs.dev";
