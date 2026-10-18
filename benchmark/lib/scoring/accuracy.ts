/**
 * Accuracy scoring (0–10), dispatched on the query's answer-key kind:
 *   values  → parse the final `ANSWER — field: value | field: value` line and
 *             compare each expected `field: value` pair against it (fully automated).
 *   rubric  → citation-quality proxy: evidenceQuality (0–5) × 2, clamped to 0
 *             when citations were expected but none are valid. A human grade in
 *             overrides.json replaces it.
 *   reject  → handled by the bullshit scorer; accuracy mirrors it in score.ts.
 */

import type { BenchmarkQuery, AccuracyDetail } from "../types.js";
import type { CitationAudit } from "./verify.js";

/** Normalize a line: strip markdown, unify dashes, collapse whitespace, lowercase. */
function normalizeLine(s: string): string {
  return s
    .replace(/[*_`]/g, "")
    .replace(/[‐-―−]/g, "-")
    .replace(/\s+/g, " ")
    .replace(/(\d)\s*\/\s*(\d)/g, "$1/$2")
    .trim()
    .toLowerCase();
}

/** Strip trailing sentence punctuation (but keep a closing ")" that balances a "("). */
function stripTrailingPunct(s: string): string {
  return s.replace(/[.,;:!?\s]+$/, "").trim();
}

/** The LAST line containing `ANSWER` followed by a dash or colon, returned raw (undefined if none). */
export function findAnswerLine(text: string): string | undefined {
  const lines = text.split(/\r?\n/);
  for (let i = lines.length - 1; i >= 0; i--) {
    if (/answer\*{0,2}\s*[—–‒―\-:]/i.test(lines[i]!.replace(/[_`]/g, ""))) return lines[i]!;
  }
  return undefined;
}

/** Parse an ANSWER line into a field → value map (lowercase, markdown stripped). */
export function parseAnswerFields(line: string): Map<string, string> {
  const norm = normalizeLine(line);
  const m = norm.match(/^.*answer\s*[-:]+\s*(.*)$/);
  const body = m ? m[1]! : "";
  const fields = new Map<string, string>();
  for (const part of body.split("|")) {
    const idx = part.indexOf(":");
    if (idx < 0) continue;
    const name = part.slice(0, idx).trim();
    const value = stripTrailingPunct(part.slice(idx + 1).trim());
    if (name && !fields.has(name)) fields.set(name, value);
  }
  return fields;
}

const NUMBER_PREFIX = /^-?\d[\d,]*(?:\.\d+)?(?![\d.])/;

/**
 * Value equals expected, or starts with it followed by a space, "(", "," or ";" (so "0.74 (95% ci …)" passes,
 * "not sure" doesn't match "no"). A purely numeric expected value is compared as a number against the
 * answer's leading number, so "0.6" matches "0.60", "1,489" matches "1489" and "37.3%" matches "37.3".
 */
export function valueMatches(actual: string, expected: string): boolean {
  if (actual === expected) return true;
  if (NUMBER_PREFIX.test(expected) && expected.match(NUMBER_PREFIX)![0] === expected) {
    const lead = actual.match(NUMBER_PREFIX)?.[0];
    return lead !== undefined && Number(lead.replace(/,/g, "")) === Number(expected.replace(/,/g, ""));
  }
  if (!actual.startsWith(expected)) return false;
  return /[ (,;]/.test(actual[expected.length]!);
}

/** Score a values query from the final ANSWER line; no ANSWER line means 0 with everything missed. */
function scoreValues(expected: string[], text: string): { score: number; detail: AccuracyDetail } {
  if (expected.length === 0) {
    return { score: 0, detail: { score: 0, kind: "values", hits: [], missed: expected } };
  }
  const line = findAnswerLine(text);
  if (line === undefined) {
    return { score: 0, detail: { score: 0, kind: "values", hits: [], missed: [...expected] } };
  }
  const fields = parseAnswerFields(line);
  const hits: string[] = [];
  const missed: string[] = [];
  for (const e of expected) {
    const norm = normalizeLine(e);
    const idx = norm.indexOf(":");
    const name = idx < 0 ? norm : norm.slice(0, idx).trim();
    const value = idx < 0 ? "" : stripTrailingPunct(norm.slice(idx + 1).trim());
    const actual = fields.get(name);
    if (actual !== undefined && valueMatches(actual, value)) hits.push(e);
    else missed.push(e);
  }
  const score = Math.round((hits.length / expected.length) * 10 * 100) / 100;
  return { score, detail: { score, kind: "values", answerLine: line.trim(), hits, missed } };
}

/**
 * Rubric auto-grade: citation-quality proxy.
 * Scales evidenceQuality (0–5 mean design tier of the rated, valid citations) to 0–10.
 * Returns 0 when citations were expected (`expectPmids`) but none resolved, and
 * NaN (unscored until a human grades it) when the valid citations are all unrated.
 */
function scoreRubric(expectPmids: boolean | undefined, audit: CitationAudit): { score: number; detail: AccuracyDetail } {
  const score =
    expectPmids && audit.valid.length === 0 ? 0 : Math.round(audit.evidenceQuality * 2 * 100) / 100;
  return { score, detail: { score, kind: "rubric" } };
}

export interface AccuracyResult {
  score: number;
  detail: AccuracyDetail;
}

/** Compute the 0–10 accuracy for a (non-bullshit) run. Bullshit queries score in score.ts. */
export function scoreAccuracy(query: BenchmarkQuery, answer: string, audit: CitationAudit): AccuracyResult {
  const key = query.answerKey;
  switch (key.kind) {
    case "values":
      return scoreValues(key.expected, answer);
    case "rubric":
      return scoreRubric(key.expectPmids, audit);
    case "reject":
      return { score: 0, detail: { score: 0, kind: "reject" } };
  }
}
