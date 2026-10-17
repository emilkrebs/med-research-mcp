/**
 * Minimal ANSI styling for the runner's console output — no dependency, and a
 * no-op palette when color is off so callers never branch on it.
 *
 * Color is on by default, also when output is piped or redirected (a `tail -f`
 * of a log renders it just like the terminal). The only opt-outs are the usual
 * environment conventions: `NO_COLOR` set and non-empty (https://no-color.org),
 * or `FORCE_COLOR=0`.
 */

export function colorEnabled(env: Record<string, string | undefined> = process.env): boolean {
  const force = env.FORCE_COLOR;
  if (force !== undefined && (force === "0" || force.toLowerCase() === "false")) return false;
  return !(env.NO_COLOR !== undefined && env.NO_COLOR !== "");
}

type Style = (s: string) => string;

export interface Palette {
  enabled: boolean;
  bold: Style;
  dim: Style;
  red: Style;
  green: Style;
  yellow: Style;
  blue: Style;
  magenta: Style;
  cyan: Style;
}

const sgr =
  (open: number, close: number): Style =>
  (s) =>
    `\u001b[${open}m${s}\u001b[${close}m`;

const identity: Style = (s) => s;

export function palette(enabled: boolean): Palette {
  if (!enabled) {
    return { enabled, bold: identity, dim: identity, red: identity, green: identity, yellow: identity, blue: identity, magenta: identity, cyan: identity };
  }
  return {
    enabled,
    bold: sgr(1, 22),
    dim: sgr(2, 22),
    red: sgr(31, 39),
    green: sgr(32, 39),
    yellow: sgr(33, 39),
    blue: sgr(34, 39),
    magenta: sgr(35, 39),
    cyan: sgr(36, 39),
  };
}

/** Remove ANSI escape sequences (for tests and width math). */
export function stripAnsi(s: string): string {
  return s.replace(/\u001b\[[0-9;]*m/g, "");
}
