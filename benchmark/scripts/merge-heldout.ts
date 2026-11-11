#!/usr/bin/env -S npx tsx
/**
 * Merge the staged queries of the beyond-PubMed frames into the held-out set.
 *
 *   npx tsx benchmark/scripts/merge-heldout.ts --items <dir> --cand <dir> [--dry-run]
 *   npm run merge-heldout -- --items <dir> --cand <dir>
 *
 * Query writers do not edit `queries.heldout.data.ts` or `heldout.sample.json`. Each writes one
 * staged file per stratum into `<items>/<stratum>.json` (`preprint-europepmc.json`, ...), holding the
 * dispositions of the stratum's candidates in draw order:
 *
 *   { "stratum": "preprint/europepmc",
 *     "dispositions": [
 *       { "id": "PPR1305370", "skipped": "not-primary", "note": "protocol, no results" },
 *       { "id": "PPR1282579", "used": { category, topics, prompt, answerKey, retrievalOnly, beyondPubmed, verified } } ] }
 *
 * `<cand>` holds the candidate texts `sample-heldout.ts --add-frames` wrote (`<stratum>.json`), which the
 * quotes are checked against. The format and one example per kind are in the STAGING.md next to the
 * staged files.
 *
 * The merge VALIDATES every staged file and, only if all of them pass, writes
 *   - `heldout.sample.json`: each staged stratum's dispositions (`used: "t-<category>-NN"`, or `skipped`
 *     with its reason and note), and
 *   - the region of `queries.heldout.data.ts` between the BEGIN and END markers: the queries, ids assigned
 *     in stratum order (the order of `heldout.sample.json`) and, within a stratum, in draw order.
 * It is re-runnable: the staged files are the one source of truth for the strata they cover, so the same
 * files give the same output, and an edited file replaces what an earlier merge wrote. A stratum that has
 * dispositions in the sample file but no staged file is an error (the merge would not know them). Ids are
 * final only after the last merge: a later stratum's ids shift when an earlier one gains a query.
 *
 * What is validated (`validateStaged`, `validateQuery`, `validateAgainstCandidate`; `test/heldout.test.ts`
 * holds the merged queries to the first two):
 *   - the dispositions are a prefix of the stratum's stored candidates, in draw order, by id; at most `quota`
 *     queries; no disposition after the quota-th query; a skip names a reason that applies to the frame
 *     (`SKIP_APPLIES`) and a note;
 *   - a query has exactly the fields of the example, the category and flags its frame requires, a prompt that
 *     ends in the frame's answer-format line whose field names are the `expected` ones in order (three fields:
 *     `record: <id>` first for `preprint` and `regional`, `PMID` first for `fulltext`, the id exactly the candidate's),
 *     and a source in the stratum's database that names the candidate;
 *   - every expected value but the id is a number that is in the abstract quote (`fulltext`: the first in the abstract
 *     quote, the second only in the full-text quote), and none is stated in the question;
 *   - the question contains no record id, DOI or author surname;
 *   - the quote is in the candidate's title or abstract; a full-text quote is in the candidate's full text and
 *     its figure is nowhere in the candidate's title or abstract.
 */

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { abstractNumbers } from "../lib/scoring/attribution.js";
import { parseAnswerFields } from "../lib/scoring/accuracy.js";
import {
  FRAME_RULES,
  SKIP_APPLIES,
  SKIP_REASONS,
  candidateId,
  extensionRefusal,
  queryPrefix,
  readSample,
  stratumFile,
  stratumName,
  writeSample,
  SAMPLE_PATH,
  type DrawnStratum,
  type Frame,
  type SampleFile,
  type SkipReason,
} from "./sample-heldout.js";
import { canon, normalizeText, quoteParts } from "./verify-keys.js";

export const DATA_PATH = fileURLToPath(new URL("../queries.heldout.data.ts", import.meta.url));
export const BEGIN_MARK = "// BEGIN beyond-pubmed (scripts/merge-heldout.ts writes this region from the staged files; edit those, not this)";
export const END_MARK = "// END beyond-pubmed";

/** A query as a writer stages it: everything but the id, which the merge assigns. */
export interface StagedQuery {
  category: string;
  topics: string[];
  prompt: string;
  answerKey: {
    kind: "values";
    expected: string[];
    source: { database: string; id: string; quote: string; fullTextQuote?: string };
  };
  retrievalOnly: boolean;
  beyondPubmed: true;
  verified: true;
}

export type StagedDisposition = { id: string; used: StagedQuery } | { id: string; skipped: SkipReason; note: string };

export interface StagedFile {
  stratum: string;
  dispositions: StagedDisposition[];
}

/** A candidate's text as `sample-heldout.ts` writes it. */
export interface CandidateText {
  id?: string;
  pmid?: string;
  title: string;
  authors?: string[];
  abstract: string;
  fulltext?: string;
  fulltextNote?: string;
}

const QUERY_KEYS = ["category", "topics", "prompt", "answerKey", "retrievalOnly", "beyondPubmed", "verified"];
const SOURCE_KEYS = ["database", "id", "quote", "fullTextQuote"];
const NUMBER = /^-?\d+(\.\d+)?$/;
const TAIL = "Finish your reply with one line in EXACTLY this format and nothing else on that line:";
/** The citation instruction of a `preprint` or `regional` prompt: the record's id is the first field of the answer line. */
export const CITE_RECORD = "Cite the record you found, and give its id exactly as the database shows it.";
/** The citation instruction of a `fulltext` prompt (a PubMed record). */
export const CITE_PMID = "Cite the PMID.";

/** The question a prompt asks, without the citation instruction and answer-format line that follow it. */
export function questionOf(prompt: string): string {
  return prompt.split(/ Cite the (?:PMID|record you found)\b/)[0]!;
}

/** The answer-format line of a prompt (its last line), without the backticks. */
export const formatLine = (prompt: string): string => prompt.split("\n").at(-1)!.replace(/^`|`$/g, "");

const escapeRe = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** The number a record id ends in: `PPR1305370` → 1305370, `CBA:633654` → 633654, `chinaxiv-202304.00908` → 202304.00908. */
export const idTail = (id: string): string | undefined => /(\d{5,}(?:\.\d+)?)$/.exec(id)?.[1];

/** Does `text` contain `id` as a record id (any separator), or its number as a number of its own? */
export function mentionsId(text: string, id: string): boolean {
  const loose = id.split(/[-:]/).map(escapeRe).join("[-:\\s]*");
  if (new RegExp(`(?<![A-Za-z0-9])${loose}(?![A-Za-z0-9])`, "i").test(text)) return true;
  const tail = idTail(id);
  return tail !== undefined && new RegExp(`(?<![\\d.])${escapeRe(tail)}(?!\\d|\\.\\d)`).test(text);
}

const fold = (s: string): string => s.normalize("NFKD").replace(/[̀-ͯ]/g, "").toLowerCase();

/**
 * Surnames an author list can be written with: the first token ("Smith JA", "LI Jianwei", "Su Haifang"), and the tokens before the
 * trailing initials ("Del Coso J" → "Del Coso"). The family name leads in every database the frames read.
 */
export function surnames(authors: string[]): string[] {
  const out = new Set<string>();
  for (const a of authors) {
    const tokens = a.split(/[\s,]+/).filter(Boolean);
    if (tokens.length === 0) continue;
    out.add(tokens[0]!);
    // "Del Coso J": the family name is what precedes the trailing initials.
    if (tokens.length > 2 && /^[A-Z]{1,3}$/.test(tokens.at(-1)!)) out.add(tokens.slice(0, -1).join(" "));
  }
  return [...out];
}

/**
 * The surnames of `authors` that the question names. A surname of four letters or more is a whole word, any case;
 * a shorter one ("Li", "Wu", "He") only as "Li et al", "Li's" or "by Li", since it is also a word.
 */
export function namedAuthors(question: string, authors: string[]): string[] {
  const text = fold(question);
  return surnames(authors).filter((name) => {
    const n = fold(name).trim();
    if (n.length < 2) return false;
    const word = escapeRe(n).replace(/\s+/g, "\\s+");
    if (n.replace(/[^a-z]/g, "").length >= 4) return new RegExp(`(?<![a-z])${word}(?![a-z])`).test(text);
    return new RegExp(`(?<![a-z])${word}(?:\\s+et\\s+al|'s\\b|\\s+and\\s+colleagues)|\\bby\\s+${word}(?![a-z])`).test(text);
  });
}

function stagedKeys(o: Record<string, unknown>, allowed: string[], where: string, errors: string[]): void {
  for (const k of Object.keys(o)) if (!allowed.includes(k)) errors.push(`${where}: unknown field "${k}" (fields: ${allowed.join(", ")})`);
}

/**
 * Check a staged query against its frame and candidate id, without any text: the checks the heldout test repeats on the merged
 * queries. Returns the errors found (empty when the query is well formed).
 */
export function validateQuery(q: unknown, frame: Frame, database: string, id: string): string[] {
  const errors: string[] = [];
  const rule = FRAME_RULES[frame];
  if (typeof q !== "object" || q === null || Array.isArray(q)) return ["`used` is not an object"];
  const o = q as Record<string, unknown>;
  stagedKeys(o, QUERY_KEYS, "query", errors);
  if (o.category !== rule.category) errors.push(`category must be "${rule.category}" for a ${frame} stratum, not ${JSON.stringify(o.category)}`);
  if (o.beyondPubmed !== true) errors.push("beyondPubmed must be true");
  if (o.retrievalOnly !== rule.retrievalOnly) errors.push(`retrievalOnly must be ${rule.retrievalOnly} for a ${frame} stratum`);
  if (o.verified !== true) errors.push("verified must be true (the key is checked by verify-keys, which the writer runs)");
  if (!Array.isArray(o.topics) || o.topics.length === 0 || o.topics.some((t) => typeof t !== "string" || t.trim() === "")) {
    errors.push("topics must be a non-empty array of non-empty strings");
  }
  const prompt = o.prompt;
  const key = o.answerKey as { kind?: unknown; expected?: unknown; source?: unknown } | undefined;
  if (typeof prompt !== "string") errors.push("prompt must be a string");
  if (typeof key !== "object" || key === null || key.kind !== "values") return [...errors, "answerKey must be { kind: \"values\", expected, source }"];
  stagedKeys(key as Record<string, unknown>, ["kind", "expected", "source"], "answerKey", errors);
  const expected = key.expected;
  if (!Array.isArray(expected) || expected.some((e) => typeof e !== "string" || !e.includes(":"))) return [...errors, "answerKey.expected must be an array of \"field: value\" strings"];
  const source = key.source as Record<string, unknown> | undefined;
  if (typeof source !== "object" || source === null) return [...errors, "answerKey.source is required: { database, id, quote }"];
  stagedKeys(source, SOURCE_KEYS, "source", errors);
  if (typeof source.quote !== "string" || source.quote.trim() === "") errors.push("source.quote must be the verbatim passage of the abstract");
  if (source.database !== database) errors.push(`source.database must be "${database}" for this stratum, not ${JSON.stringify(source.database)}`);
  if (source.id !== id) errors.push(`source.id must be the candidate's id ${id}, not ${JSON.stringify(source.id)}`);
  const fullTextQuote = source.fullTextQuote;
  if (frame === "fulltext" && (typeof fullTextQuote !== "string" || fullTextQuote.trim() === "")) errors.push("source.fullTextQuote is required for a fulltext query");
  if (frame !== "fulltext" && fullTextQuote !== undefined) errors.push("source.fullTextQuote is for fulltext queries only");
  if (typeof prompt !== "string" || typeof source.quote !== "string") return errors;

  // The prompt: a question, then the frame's instruction and format line.
  const names = (expected as string[]).map((e) => e.slice(0, e.indexOf(":")).trim());
  const values = (expected as string[]).map((e) => e.slice(e.indexOf(":") + 1).trim());
  const fulltextFrame = frame === "fulltext";
  const cite = fulltextFrame ? CITE_PMID : CITE_RECORD;
  // The first field is the record's id: the PMID of a PubMed record, `record` for one outside PubMed.
  const first = fulltextFrame ? "PMID: <number>" : "record: <id>";
  const placeholder = "<(?:number|value|percent)>";
  const field = "[^|:<>`\\n]+";
  const re = new RegExp(`^(.+) ${escapeRe(cite)} ${escapeRe(TAIL)}\\n\`ANSWER — ${escapeRe(first)} \\| ${field}: ${placeholder} \\| ${field}: ${placeholder}\`$`, "s");
  if (!re.test(prompt)) {
    errors.push(`prompt must be "<question> ${cite} ${TAIL}\\n\`ANSWER — ${first} | a: <number> | b: <number>\`"`);
    return errors;
  }
  if (expected.length !== 3) {
    errors.push(`expected must have 3 fields (${fulltextFrame ? "pmid, the abstract number, the full-text figure" : "record, then two numbers"})`);
  }
  const formatNames = [...parseAnswerFields(formatLine(prompt)).keys()];
  if (JSON.stringify(formatNames) !== JSON.stringify(names.map((n) => n.toLowerCase()))) {
    errors.push(`the format line's fields (${formatNames.join(", ")}) must be the expected fields (${names.join(", ")}), in that order, lowercase`);
  }
  if (new Set(names).size !== names.length) errors.push("expected field names must differ");
  if (names.some((n) => n !== n.toLowerCase() || n === "")) errors.push("expected field names must be lowercase");

  // The numbers.
  const quote = quoteParts(source.quote).join(" ").replace(/[‐-―]/g, "-");
  const inQuote = abstractNumbers(quote);
  const inFull = abstractNumbers(typeof fullTextQuote === "string" ? quoteParts(fullTextQuote).join(" ").replace(/[‐-―]/g, "-") : "");
  const question = questionOf(prompt);
  const idField = fulltextFrame ? `pmid: ${id}` : `record: ${id}`;
  if (expected[0] !== idField) errors.push(`the first expected field must be "${idField}"${fulltextFrame ? "" : ", the id exactly as the database shows it"}`);
  for (const [i, value] of values.entries()) {
    if (i < 1) continue;
    if (!NUMBER.test(value)) {
      errors.push(`expected "${expected[i]}" must be a plain number`);
      continue;
    }
    const c = canon(value);
    const isFullTextFigure = fulltextFrame && i === 2;
    if (isFullTextFigure) {
      if (!inFull.has(c)) errors.push(`expected "${expected[i]}" must be a number of source.fullTextQuote`);
      if (inQuote.has(c)) errors.push(`expected "${expected[i]}" is also in source.quote: the full-text figure must be one the abstract does not state`);
    } else if (!inQuote.has(c)) errors.push(`expected "${expected[i]}" must be a number of source.quote`);
    if (new RegExp(`(?<![\\d.])${escapeRe(value.replace(/^-/, ""))}(?!\\d|\\.\\d)`).test(question)) errors.push(`expected "${expected[i]}" is stated in the question`);
  }

  // The question must not give the record away.
  if (/\bPMID\b|\bdoi\b|10\.\d{4,}\//i.test(question)) errors.push("the question names a PMID or a DOI");
  if (mentionsId(question, id) || /\bPPR\d{3,}\b|\bCBA\s*[:#]\s*\d|\bchinaxiv[-:]\s*\d/i.test(question)) errors.push(`the question contains a record id (${id})`);
  if (/\bet al\b/i.test(question)) errors.push('the question names authors ("et al"): describe the study, not who wrote it');
  return errors;
}

/** Check the staged query against the candidate's text. */
export function validateAgainstCandidate(q: StagedQuery, text: CandidateText): string[] {
  const errors: string[] = [];
  if (text.title === "(not found)") return [`the candidate's text could not be fetched (title "(not found)"): write it again with sample-heldout.ts --candidates`];
  const source = q.answerKey.source;
  const record = normalizeText(`${text.title} ${text.abstract}`);
  for (const part of quoteParts(source.quote)) {
    if (!record.includes(normalizeText(part))) errors.push(`source.quote is not in the candidate's title or abstract: "${part.slice(0, 80)}"`);
  }
  if (source.fullTextQuote !== undefined) {
    if (text.fulltext === undefined) errors.push(`the candidate has no full text (${text.fulltextNote ?? "no note"}): skip it as no-fulltext`);
    else {
      const body = normalizeText(text.fulltext);
      for (const part of quoteParts(source.fullTextQuote)) {
        if (!body.includes(normalizeText(part))) errors.push(`source.fullTextQuote is not in the candidate's full text: "${part.slice(0, 80)}"`);
      }
      const figure = q.answerKey.expected[2]?.split(":").slice(1).join(":").trim();
      if (figure !== undefined && NUMBER.test(figure) && abstractNumbers(`${text.title} ${text.abstract}`).has(canon(figure))) {
        errors.push(`the full-text figure ${figure} is also a number in the candidate's title or abstract`);
      }
    }
  }
  const named = namedAuthors(questionOf(q.prompt), text.authors ?? []);
  if (named.length > 0) errors.push(`the question names an author: ${named.join(", ")}`);
  return errors;
}

/** The skip fields every disposition shares; used by the staged check and the heldout test. */
export function validateSkip(frame: Frame, skipped: unknown, note: unknown): string[] {
  const errors: string[] = [];
  if (typeof skipped !== "string" || !(skipped in SKIP_REASONS)) return [`skipped must be one of ${Object.keys(SKIP_REASONS).join(", ")}`];
  if (!SKIP_APPLIES[skipped as SkipReason].includes(frame)) errors.push(`"${skipped}" does not apply to a ${frame} stratum (it applies to ${SKIP_APPLIES[skipped as SkipReason].join(", ")})`);
  if (typeof note !== "string" || note.trim().length <= 5) errors.push("a skip needs a note saying what is wrong with this candidate (more than five characters)");
  return errors;
}

/** Validate one staged file against its stored stratum. `text` is the candidate texts, by id. Returns the errors. */
export function validateStaged(staged: unknown, stratum: DrawnStratum, texts: Map<string, CandidateText>): string[] {
  const errors: string[] = [];
  const name = stratumName(stratum);
  const at = (i: number, id: string) => `${name} #${i + 1} ${id}`;
  if (typeof staged !== "object" || staged === null) return [`${name}: the staged file is not an object`];
  const file = staged as { stratum?: unknown; dispositions?: unknown };
  if (file.stratum !== name) errors.push(`${name}: "stratum" must be "${name}", not ${JSON.stringify(file.stratum)}`);
  if (!Array.isArray(file.dispositions)) return [...errors, `${name}: "dispositions" must be an array`];
  const rule = FRAME_RULES[stratum.frame];
  const stored = stratum.candidates.map(candidateId);
  if (file.dispositions.length > stored.length) errors.push(`${name}: ${file.dispositions.length} dispositions for ${stored.length} stored candidates (extend the stratum first)`);

  let used = 0;
  for (const [i, d] of (file.dispositions as Record<string, unknown>[]).entries()) {
    const id = String(d.id);
    const where = at(i, id);
    if (id !== stored[i]) {
      errors.push(`${where}: dispositions must be a prefix of the stored candidates in draw order; candidate #${i + 1} is ${stored[i] ?? "(none)"}`);
      continue;
    }
    if (used >= rule.quota) errors.push(`${where}: the quota of ${rule.quota} queries was met before this candidate, so it must have no disposition`);
    if (("used" in d) === ("skipped" in d)) {
      errors.push(`${where}: exactly one of "used" and "skipped"`);
      continue;
    }
    if ("skipped" in d) {
      stagedKeys(d, ["id", "skipped", "note"], where, errors);
      errors.push(...validateSkip(stratum.frame, d.skipped, d.note).map((e) => `${where}: ${e}`));
      continue;
    }
    stagedKeys(d, ["id", "used"], where, errors);
    used++;
    const found = validateQuery(d.used, stratum.frame, stratum.database, id);
    errors.push(...found.map((e) => `${where}: ${e}`));
    const text = texts.get(id);
    if (found.length === 0) {
      if (!text) errors.push(`${where}: no candidate text for ${id} (is the candidate file current?)`);
      else errors.push(...validateAgainstCandidate(d.used as StagedQuery, text).map((e) => `${where}: ${e}`));
    }
  }
  return errors;
}

/** The queries of the staged strata, ids assigned in stratum order (the order of the sample file) and draw order. */
export interface MergedQuery extends StagedQuery {
  id: string;
  stratum: string;
}

export function assignIds(strata: DrawnStratum[], staged: Map<string, StagedFile>): { queries: MergedQuery[]; strata: DrawnStratum[] } {
  const counters = new Map<Frame, number>();
  const queries: MergedQuery[] = [];
  const out: DrawnStratum[] = strata.map((s) => {
    const file = staged.get(stratumName(s));
    if (!file || s.frame === "lookup") return s;
    const candidates = s.candidates.map((c, i) => {
      const base = c.pmid !== undefined ? { pmid: c.pmid } : { id: c.id! };
      const d = file.dispositions[i];
      if (!d) return base;
      if ("skipped" in d) return { ...base, skipped: d.skipped, note: d.note };
      const n = (counters.get(s.frame) ?? 0) + 1;
      counters.set(s.frame, n);
      const id = `${queryPrefix(s.frame)}${String(n).padStart(2, "0")}`;
      queries.push({ id, stratum: stratumName(s), ...d.used });
      return { ...base, used: id };
    });
    return { ...s, candidates };
  });
  return { queries, strata: out };
}

const arr = (xs: string[]): string => `[${xs.map((x) => JSON.stringify(x)).join(", ")}]`;

/** A query as a TypeScript object literal, in the style of the rest of the file. */
export function formatQuery(q: MergedQuery): string {
  const s = q.answerKey.source;
  const lines = [
    "  {",
    `    id: ${JSON.stringify(q.id)},`,
    `    category: ${JSON.stringify(q.category)},`,
    `    topics: ${arr(q.topics)},`,
    "    prompt:",
    `      ${JSON.stringify(q.prompt)},`,
    "    answerKey: {",
    '      kind: "values",',
    `      expected: ${arr(q.answerKey.expected)},`,
    "      source: {",
    `        database: ${JSON.stringify(s.database)},`,
    `        id: ${JSON.stringify(s.id)},`,
    `        quote: ${JSON.stringify(s.quote)},`,
    ...(s.fullTextQuote !== undefined ? [`        fullTextQuote: ${JSON.stringify(s.fullTextQuote)},`] : []),
    "      },",
    "    },",
    ...(q.retrievalOnly ? ["    retrievalOnly: true,"] : []),
    "    beyondPubmed: true,",
    "    verified: true,",
    "  },",
  ];
  return lines.join("\n");
}

/** The text between the markers, from the queries (a comment per stratum). */
export function formatRegion(queries: MergedQuery[]): string {
  const out: string[] = [`  ${BEGIN_MARK}`];
  let stratum: string | undefined;
  for (const q of queries) {
    if (q.stratum !== stratum) {
      stratum = q.stratum;
      out.push(`  // ─── ${q.category} · ${q.stratum.split("/")[1]} ───`);
    }
    out.push(formatQuery(q));
  }
  out.push(`  ${END_MARK}`);
  return out.join("\n");
}

/** The data file with its beyond-PubMed region replaced. */
export function replaceRegion(source: string, queries: MergedQuery[]): string {
  const begin = source.indexOf(BEGIN_MARK);
  const end = source.indexOf(END_MARK);
  if (begin < 0 || end < begin) throw new Error("queries.heldout.data.ts has no BEGIN/END beyond-pubmed markers");
  const from = source.lastIndexOf("\n", begin) + 1;
  const to = source.indexOf("\n", end);
  return `${source.slice(0, from)}${formatRegion(queries)}${source.slice(to < 0 ? source.length : to)}`;
}

/** Candidate texts of one stratum by record id. */
export function loadTexts(candDir: string, name: string): Map<string, CandidateText> {
  const file = join(candDir, stratumFile(name));
  if (!existsSync(file)) return new Map();
  const rows = JSON.parse(readFileSync(file, "utf-8")) as CandidateText[];
  return new Map(rows.map((r) => [String(r.id ?? r.pmid), r] as const));
}

interface MergeResult {
  errors: string[];
  report: string[];
  queries: MergedQuery[];
  sample?: SampleFile;
}

/** Validate every staged file under `itemsDir` and build the merged state, writing nothing. */
export function plan(sample: SampleFile, itemsDir: string, candDir: string): MergeResult {
  const errors: string[] = [];
  const report: string[] = [];
  const staged = new Map<string, StagedFile>();
  for (const s of sample.strata) {
    const name = stratumName(s);
    if (s.frame === "lookup") continue;
    const file = join(itemsDir, stratumFile(name));
    const decided = s.candidates.some((c) => c.used !== undefined || c.skipped !== undefined);
    if (!existsSync(file)) {
      if (decided) errors.push(`${name}: the sample file has dispositions but ${file} does not exist; the merge rebuilds them from the staged file`);
      report.push(`${name.padEnd(28)} no staged file`);
      continue;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(readFileSync(file, "utf-8"));
    } catch (err) {
      errors.push(`${name}: ${file} is not valid JSON: ${err instanceof Error ? err.message : String(err)}`);
      continue;
    }
    const texts = loadTexts(candDir, name);
    if (texts.size === 0) errors.push(`${name}: no candidate texts in ${join(candDir, stratumFile(name))}`);
    const stored = s.candidates.map(candidateId);
    const missing = stored.filter((id) => !texts.has(id));
    if (texts.size > 0 && missing.length > 0) errors.push(`${name}: the candidate file lacks ${missing.slice(0, 3).join(", ")}${missing.length > 3 ? ", ..." : ""}: write it again with sample-heldout.ts --candidates ${name} --cand-dir <dir>`);
    errors.push(...validateStaged(parsed, s, texts));
    staged.set(name, parsed as StagedFile);
  }
  if (errors.length > 0) return { errors, report, queries: [] };

  const { queries, strata } = assignIds(sample.strata, staged);
  const dup = queries.filter((q, i) => queries.findIndex((x) => x.prompt === q.prompt) !== i);
  for (const q of dup) errors.push(`${q.id}: the same prompt is used twice`);
  const ids = queries.map((q) => q.answerKey.source.id);
  for (const id of ids.filter((x, i) => ids.indexOf(x) !== i)) errors.push(`record ${id} has two queries`);

  for (const s of strata) {
    if (s.frame === "lookup" || !staged.has(stratumName(s))) continue;
    const rule = FRAME_RULES[s.frame];
    const n = s.candidates.filter((c) => c.used !== undefined).length;
    const skipped = s.candidates.filter((c) => c.skipped !== undefined).length;
    const left = s.candidates.filter((c) => c.used === undefined && c.skipped === undefined).length;
    const refusal = n < rule.quota && left === 0 ? extensionRefusal(s) : undefined;
    const status =
      n >= rule.quota
        ? "quota met"
        : left > 0
          ? `${rule.quota - n} to write, ${left} candidates left`
          : refusal
            ? `candidates ran out and the stratum cannot be extended: ${refusal}`
            : `candidates ran out: extend the stratum (sample-heldout.ts --extend ${stratumName(s)} --cand-dir <dir>)`;
    report.push(`${stratumName(s).padEnd(28)} ${String(n).padStart(2)}/${rule.quota} queries, ${skipped} skipped; ${status}`);
  }
  return { errors, report, queries, sample: { ...sample, strata } };
}

export function mergeInto(itemsDir: string, candDir: string, opts: { dryRun?: boolean; samplePath?: string; dataPath?: string } = {}): MergeResult {
  const samplePath = opts.samplePath ?? SAMPLE_PATH;
  const dataPath = opts.dataPath ?? DATA_PATH;
  const result = plan(readSample(samplePath), itemsDir, candDir);
  if (result.errors.length > 0 || opts.dryRun || !result.sample) return result;
  writeSample(result.sample, samplePath);
  writeFileSync(dataPath, replaceRegion(readFileSync(dataPath, "utf-8"), result.queries));
  return result;
}

function main(): void {
  const args = process.argv.slice(2);
  const flag = (name: string): string | undefined => {
    const i = args.indexOf(name);
    return i >= 0 ? args[i + 1] : undefined;
  };
  const items = flag("--items");
  const cand = flag("--cand");
  if (!items || !cand) {
    console.error("Usage: npx tsx benchmark/scripts/merge-heldout.ts --items <dir> --cand <dir> [--dry-run]");
    process.exitCode = 2;
    return;
  }
  const dryRun = args.includes("--dry-run");
  const result = mergeInto(resolve(items), resolve(cand), { dryRun });
  for (const line of result.report) console.log(line);
  if (result.errors.length > 0) {
    console.error(`\n${result.errors.length} problem(s); nothing was written:`);
    for (const e of result.errors) console.error(`  ✗ ${e}`);
    process.exitCode = 1;
    return;
  }
  console.log(`\n${result.queries.length} queries ${dryRun ? "validated (dry run, nothing written)" : "written to queries.heldout.data.ts and heldout.sample.json"}: ${result.queries.map((q) => q.id).join(", ") || "none"}`);
}

// Only run when executed directly, so tests can import the pure parts.
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
