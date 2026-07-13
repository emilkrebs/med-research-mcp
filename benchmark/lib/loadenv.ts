/**
 * Load `benchmark/.env` into `process.env` as a side effect of importing this
 * module — so `cp .env.example .env` actually works, with no dotenv dependency.
 *
 * Import this FIRST in the entry point (before config/providers), because those
 * modules read `process.env` at load time. Values already set in the real
 * environment win — a shell export always overrides the file.
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const envPath = fileURLToPath(new URL("../.env", import.meta.url));

try {
  const text = readFileSync(envPath, "utf8");
  for (const raw of text.split("\n")) {
    const line = raw.trim().replace(/^export\s+/, "");
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq === -1) continue;
    const key = line.slice(0, eq).trim();
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) continue;
    if (process.env[key] !== undefined) continue; // shell wins
    let value = line.slice(eq + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    if (value) process.env[key] = value;
  }
} catch (err) {
  // No .env file is fine — keys can come from the shell instead.
  if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
    console.warn(`[benchmark] could not read ${envPath}: ${err instanceof Error ? err.message : String(err)}`);
  }
}
