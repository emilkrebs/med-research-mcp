/**
 * Citation attribution check — deterministic, no LLM.
 *
 * The fabrication check only asks whether a cited id exists. The more common
 * failure of an answer written from memory is a real paper cited for something
 * it doesn't say: the PMID resolves, but it is a different paper, or the year,
 * first author, design or numbers stated next to it don't match the record.
 * This module compares the text around each resolved citation with the cited
 * record (PubMed metadata + abstract, or the regional record):
 *
 *  - topic   — the record (title, abstract, MeSH) mentions one of the query's
 *              `topics`. Catches "real PMID, unrelated paper".
 *  - year    — a single year stated next to the citation is within ±1 of the
 *              record's (±1 absorbs epub-vs-print dates).
 *  - author  — "Surname et al." / "Surname and colleagues" names one of the
 *              record's authors (any position, so a wrong "first author" passes).
 *  - design  — a claimed design (meta-analysis/systematic review, randomized
 *              trial, cohort/observational) is compatible with the record's
 *              graded study type or NLM publication types.
 *  - numbers — when two or more figures (doses, durations, sample sizes, effect
 *              sizes) are stated next to the citation, at least one appears in
 *              the title/abstract.
 *
 * Every check is built to stay silent when unsure: it fires only on a clear
 * contradiction, and a check that can't be applied (no year stated, two years
 * stated, no abstract, several citations sharing one clause, …) doesn't count.
 * So the audit finds contradicted claims; it cannot prove a claim is supported.
 *
 * "Next to the citation" means: the sentence (or line) holding it. When a
 * sentence holds several citations, each one gets the clause before it plus the
 * rest of its own parenthetical or trailing descriptor ("(PMID 1, Smith 2019)",
 * "PMID 1 for 2008 and …"); citations grouped together ("PMIDs 1, 2, 3") only get
 * the topic check, because the clause can't be split between them. A citation
 * that opens its line ("PMID 123 — Smith 2019 …") gets the text after it instead.
 *
 * Known limits (each makes the check miss things, never flag more):
 *  - Abstract-only: a number reported only in the full text can't be matched,
 *    which is why the numbers check needs two figures with none found.
 *  - Lexical: unit conversions ("3 g" vs "3000 mg") and derived figures don't
 *    match; approximate figures ("~30%", "about 200") are skipped.
 *  - Sentence splitting is heuristic; a reference-list entry broken into
 *    fragments usually leaves only the topic check.
 */

import type { AttributionDetail, AttributionIssue } from "../types.js";
import type { PmidFacts } from "./verify.js";

type Check = AttributionIssue["check"];
type Verdict = { ok: true } | { ok: false; claimed: string; actual: string } | null;

/** Lowercase and strip accents, so "Muñoz" matches "Munoz". */
function fold(s: string): string {
  return s.normalize("NFKD").replace(/[̀-ͯ]/g, "").toLowerCase();
}

const escapeRe = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

// ─── Where each citation sits ────────────────────────────────────────────────

/** The literal token that marks a citation of `id` in the answer text. */
export function mentionToken(id: string): string {
  const prefixed = /^[A-Z]{3}:(\d+)$/.exec(id); // CBA:521529 → cited as "CBA:521529" or ".../CBA/521529"
  if (prefixed) return prefixed[1]!;
  const chinaxiv = /^chinaxiv-(\d{6}\.\d{4,6})$/.exec(id);
  if (chinaxiv) return chinaxiv[1]!;
  return id;
}

const ABBREVIATION = /(?:\bet al|\be\.g|\bi\.e|\bvs|\bapprox|\bfig|\bno|\bdr|\bref|\bvol|\bpp|\bca|\bcf|\bincl)$/i;
/** "Smith J." — a surname followed by an initial, not a sentence end. */
const INITIAL = /\b[A-Z][\p{L}'’-]+,?\s+(?:[A-Z]\.?\s?)*[A-Z]$/u;

/** [start, end) ranges of the sentences in `text`, never crossing a newline. */
export function sentenceRanges(text: string): [number, number][] {
  const out: [number, number][] = [];
  let lineStart = 0;
  for (const line of text.split("\n")) {
    let start = lineStart;
    const re = /[.!?](?=\s+["'(\[*]?[A-Z0-9])/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(line))) {
      const before = line.slice(0, m.index);
      if (ABBREVIATION.test(before) || INITIAL.test(before)) continue;
      out.push([start, lineStart + m.index + 1]);
      start = lineStart + m.index + 1;
    }
    out.push([start, lineStart + line.length]);
    lineStart += line.length + 1;
  }
  return out;
}

interface Mention {
  id: string;
  start: number;
  end: number;
}

/** Text between two citations that only separates them ("; ", ", PMID ", " and "). */
const SEPARATOR =
  /^[\s,;:&()[\]/.\-–—]*(?:(?:and|PMIDs?|PubMed(?:\s*IDs?)?|CBA|ChinaXiv|see|also)[\s,;:&()[\]/.\-–—]*)*$/i;

/**
 * Text right after a citation that still belongs to it: up to the bracket that
 * closes its parenthetical ("(PMID 1, Smith et al. 2019)"), when no new bracket
 * opens first. Empty when the citation isn't followed by such a remainder.
 */
function closingTail(after: string): string {
  const close = after.search(/[)\]]/);
  if (close < 0) return "";
  return /[([]/.test(after.slice(0, close)) ? "" : after.slice(0, close);
}

/**
 * Divide the text between two citations into the earlier citation's tail and the
 * later one's head. Claims usually precede their citation ("… found X (PMID 2)"),
 * but a citation's own parenthetical ("(PMID 1, Smith 2019, n = 126) and …") and a
 * trailing descriptor ("PMID 1 for 2008 and PMID 2 for 2014") belong to the earlier one.
 */
function splitGap(gap: string): { tail: string; head: string } {
  const tail = closingTail(gap);
  if (tail !== "" || /^\s*[)\]]/.test(gap)) {
    const cut = gap.search(/[)\]]/) + 1;
    return { tail, head: gap.slice(cut) };
  }
  const conj = /\s+and\s+|;/.exec(gap);
  if (conj && !/[([]/.test(gap.slice(0, conj.index))) {
    return { tail: gap.slice(0, conj.index), head: gap.slice(conj.index + conj[0].length) };
  }
  return { tail: "", head: gap };
}

/** One citation cluster with the claim text attached to it. */
interface Attached {
  ids: string[];
  segment: string;
}

/** Find every citation mention, group adjacent ones, and attach each group's claim text. */
function attach(text: string, ids: string[]): Attached[] {
  const mentions: Mention[] = [];
  for (const id of new Set(ids)) {
    const token = mentionToken(id);
    const re = new RegExp(`(?<![\\w.])${escapeRe(token)}(?![\\w]|\\.\\d)`, "g");
    for (const m of text.matchAll(re)) mentions.push({ id, start: m.index, end: m.index + m[0].length });
  }
  mentions.sort((a, b) => a.start - b.start);

  const out: Attached[] = [];
  for (const [uStart, uEnd] of sentenceRanges(text)) {
    const inUnit = mentions.filter((m) => m.start >= uStart && m.end <= uEnd);
    const clusters: Mention[][] = [];
    for (const m of inUnit) {
      const last = clusters.at(-1);
      if (last && SEPARATOR.test(text.slice(last.at(-1)!.end, m.start))) last.push(m);
      else clusters.push([m]);
    }
    // Split the text between consecutive clusters into the earlier one's tail and the later one's head.
    const gaps = clusters.slice(1).map((c, i) => splitGap(text.slice(clusters[i]!.at(-1)!.end, c[0]!.start)));
    clusters.forEach((cluster, i) => {
      const end = cluster.at(-1)!.end;
      const head = i === 0 ? text.slice(uStart, cluster[0]!.start) : gaps[i - 1]!.head;
      const tail = i < gaps.length ? gaps[i]!.tail : closingTail(text.slice(end, uEnd));
      // A citation that opens its line ("- PMID 123: Smith 2019 …") is described after it.
      const opensLine = i === 0 && !/[A-Za-z]{2,}/.test(head.replace(/\b(?:PMIDs?|PubMed|CBA|ChinaXiv)\b/gi, ""));
      const nextStart = i === clusters.length - 1 ? uEnd : clusters[i + 1]![0]!.start;
      const segment = opensLine ? text.slice(end, nextStart) : `${head} ${tail}`;
      out.push({ ids: [...new Set(cluster.map((m) => m.id))], segment });
    });
  }
  return out;
}

// ─── The checks ──────────────────────────────────────────────────────────────

function checkTopic(f: PmidFacts, topics: string[] | undefined): Verdict {
  if (!topics || topics.length === 0) return null;
  const hay = fold(`${f.title} ${f.abstract} ${(f.meshHeadings ?? []).join(" ")}`);
  if (topics.some((t) => new RegExp(`\\b${escapeRe(fold(t))}`).test(hay))) return { ok: true };
  // A record without an abstract is judged on its title alone: too thin to call it off-topic.
  if (f.abstract.trim() === "") return null;
  return { ok: false, claimed: `query topic: ${topics.join(" / ")}`, actual: f.title };
}

const YEAR_RE = /\b(19[5-9]\d|20[0-4]\d)\b/g;
const YEAR_RANGE = /\b(?:19|20)\d\d\s*(?:-|–|—|to|through)\s*(?:19|20)?\d\d\b/i;
const YEAR_NOT_PUBLICATION = /(?:since|until|till|through|before|after|between|from|up to|as of)\s+(?:\w+\s+)?$/i;

function checkYear(f: PmidFacts, seg: string): Verdict {
  if (f.pubYear === undefined || YEAR_RANGE.test(seg)) return null;
  const years = new Set<number>();
  for (const m of seg.matchAll(YEAR_RE)) {
    if (YEAR_NOT_PUBLICATION.test(seg.slice(Math.max(0, m.index - 24), m.index))) return null;
    years.add(Number(m[1]));
  }
  if (years.size !== 1) return null;
  const year = [...years][0]!;
  return Math.abs(year - f.pubYear) <= 1 ? { ok: true } : { ok: false, claimed: String(year), actual: String(f.pubYear) };
}

/** "Smith et al.", "Wilkinson MJ et al.", "Smith and colleagues" — the surname needs a lowercase letter, so initials aren't read as one. */
const AUTHOR_RE = /\b([A-Z][\p{Ll}'’][\p{L}'’-]*)(?:\s+[A-Z]{1,3}\.?)?\s+(?:et\s+al\b|and\s+colleagues\b|and\s+co-?workers\b)/gu;

function checkAuthor(f: PmidFacts, seg: string): Verdict {
  const authors = f.authors ?? [];
  if (authors.length === 0) return null;
  const names = new Set([...seg.matchAll(AUTHOR_RE)].map((m) => m[1]!));
  if (names.size !== 1) return null;
  const claimed = [...names][0]!;
  const want = fold(claimed).replace(/[^a-z]/g, "");
  const hit = authors.some((a) => {
    const tokens = fold(a).split(/[^a-z]+/).filter(Boolean);
    return tokens.includes(want) || tokens.join("").includes(want);
  });
  return hit ? { ok: true } : { ok: false, claimed: `${claimed} et al.`, actual: authors.slice(0, 3).join(", ") };
}

type DesignClaim = "synthesis" | "rct" | "observational";

const SYNTHESIS_RE = /meta-?\s?analy|systematic review|pooled analysis|umbrella review/i;
const RCT_RE = /(?<!non-?|quasi-?|not\s)\brandomi[sz]ed\b|\bRCTs?\b|placebo-controlled|double-blind/i;
const OBSERVATIONAL_RE = /\bcohort\b|\bobservational\b|case-control|cross-sectional/i;

/** The single design the clause asserts, or undefined when it asserts none or several. */
export function claimedDesign(seg: string): DesignClaim | undefined {
  if (SYNTHESIS_RE.test(seg)) return "synthesis"; // "a meta-analysis of RCTs / of cohort studies"
  const rct = RCT_RE.test(seg);
  const obs = OBSERVATIONAL_RE.test(seg);
  if (rct && !obs) return "rct";
  if (obs && !rct) return "observational";
  return undefined;
}

const SYNTHESIS_TYPES = new Set(["meta-analysis", "systematic-review"]);
const OBSERVATIONAL_TYPES = new Set(["cohort", "case-control", "cross-sectional"]);

function checkDesign(f: PmidFacts, seg: string): Verdict {
  const claim = claimedDesign(seg);
  if (!claim) return null;
  const tags = (f.publicationTypes ?? []).join("|").toLowerCase();
  const isSynthesis = SYNTHESIS_TYPES.has(f.studyType) || /meta-analysis|systematic review/.test(tags);
  const isRct = f.studyType === "randomized-controlled-trial" || /randomized controlled trial/.test(tags);
  const isObservational = OBSERVATIONAL_TYPES.has(f.studyType) || /observational study/.test(tags);
  // Only a record whose design is clearly something else contradicts the claim.
  const clearlyOther = (allowed: boolean, contradicting: string[]): boolean =>
    !allowed && contradicting.includes(f.studyType);
  let contradicted: boolean;
  switch (claim) {
    case "synthesis":
      contradicted = clearlyOther(isSynthesis, [
        "randomized-controlled-trial",
        "non-randomized-trial",
        "cohort",
        "case-control",
        "cross-sectional",
        "case-report",
        "animal-study",
        "in-vitro",
      ]);
      break;
    case "rct":
      // "RCTs show … (meta-analysis of RCTs)" is a fair summary, so syntheses pass.
      contradicted = clearlyOther(isRct || isSynthesis, ["cohort", "case-control", "cross-sectional", "case-report", "review", "animal-study", "in-vitro"]);
      break;
    case "observational":
      contradicted = clearlyOther(isObservational || isSynthesis, ["randomized-controlled-trial", "case-report", "animal-study", "in-vitro"]);
      break;
  }
  const label = { synthesis: "meta-analysis / systematic review", rct: "randomized trial", observational: "observational study" }[claim];
  return contradicted ? { ok: false, claimed: label, actual: f.studyType } : { ok: true };
}

const QUANTITY_RE =
  /(?<![\w.,])(\d{1,3}(?:,\d{3})+|\d+(?:\.\d+)?)\s*(?:%|(?:mg|mcg|µg|μg|g|kg|iu|percent|weeks?|wks?|months?|days?|years?|hours?|hrs?|participants|patients|subjects|adults|people|individuals|women|men|children|volunteers|athletes|cases|trials|studies|rcts)\b)/gi;
const STAT_RE =
  /\b(?:HR|OR|RR|SMD|WMD|MD|hazard ratio|odds ratio|risk ratio|relative risk|hedges'?\s*g|cohen'?s\s*d|g)\s*(?:of|=|:|was)?\s*([-−]?\d+(?:\.\d+)?)/gi;
const SAMPLE_RE = /\bn\s*=\s*(\d{1,3}(?:,\d{3})+|\d+)/gi;
const APPROXIMATE = /(?:~|≈|about|approximately|approx\.?|around|roughly|nearly|almost|over|more than|less than|fewer than|up to|at least|>|<|≥|≤)\s*$/i;

/** Canonical form of a number for comparison: no thousands separators, no sign, no trailing zeros. */
const canon = (raw: string): string => String(Math.abs(Number(raw.replace(/,/g, "").replace("−", "-"))));

/** Figures stated in a claim, approximate ones excluded. */
export function claimedNumbers(seg: string): string[] {
  const out = new Set<string>();
  for (const re of [QUANTITY_RE, STAT_RE, SAMPLE_RE]) {
    for (const m of seg.matchAll(re)) {
      const at = m.index + m[0].indexOf(m[1]!);
      if (APPROXIMATE.test(seg.slice(Math.max(0, at - 16), at))) continue;
      out.add(canon(m[1]!));
    }
  }
  return [...out];
}

const ONES = ["zero", "one", "two", "three", "four", "five", "six", "seven", "eight", "nine", "ten", "eleven", "twelve", "thirteen", "fourteen", "fifteen", "sixteen", "seventeen", "eighteen", "nineteen"];
const TENS = ["", "", "twenty", "thirty", "forty", "fifty", "sixty", "seventy", "eighty", "ninety"];

/** Every number in an abstract, including spelled-out ones ("Sixty-three", "Fortyfour", "One hundred and one"). */
export function abstractNumbers(text: string): Set<string> {
  const out = new Set<string>();
  const t = fold(text).replace(/(\d)[  ,](\d{3})\b/g, "$1$2");
  for (const m of t.matchAll(/[-−]?\d+(?:\.\d+)?/g)) out.add(canon(m[0]));
  const below100 = `(?:(${TENS.slice(2).join("|")})[\\s-]?(${ONES.slice(1, 10).join("|")})?|(${ONES.join("|")}))`;
  const re = new RegExp(`\\b(?:(${ONES.slice(1, 10).join("|")})\\s+hundred(?:\\s+(?:and\\s+)?${below100})?|${below100})\\b`, "g");
  for (const m of t.matchAll(re)) {
    const small = (tens?: string, unit?: string, single?: string): number =>
      single ? ONES.indexOf(single) : TENS.indexOf(tens ?? "") * 10 + (unit ? ONES.indexOf(unit) : 0);
    if (m[1]) out.add(String(ONES.indexOf(m[1]) * 100 + (m[2] || m[4] ? small(m[2], m[3], m[4]) : 0)));
    else out.add(String(small(m[5], m[6], m[7])));
  }
  return out;
}

function checkNumbers(f: PmidFacts, seg: string): Verdict {
  if (f.abstract.trim() === "") return null;
  const claimed = claimedNumbers(seg);
  if (claimed.length < 2) return null;
  const present = abstractNumbers(`${f.title} ${f.abstract}`);
  return claimed.some((n) => present.has(n))
    ? { ok: true }
    : { ok: false, claimed: claimed.join(", "), actual: "none of these figures appear in the abstract" };
}

// ─── Entry point ─────────────────────────────────────────────────────────────

/**
 * Audit every resolved citation in `text`. `valid` are the resolved records;
 * `allIds` every cited id (valid, fabricated, echoed) so clause boundaries see
 * all citations, not just the resolved ones.
 */
export function checkAttribution(text: string, valid: PmidFacts[], allIds: string[], topics?: string[]): AttributionDetail {
  const clean = text.replace(/\*\*|__|`/g, "");
  const attached = attach(clean, [...allIds, ...valid.map((f) => f.pmid)]);
  const issues: AttributionIssue[] = [];
  let checked = 0;
  let misattributed = 0;

  for (const f of valid) {
    const verdicts: [Check, Verdict][] = [["topic", checkTopic(f, topics)]];
    for (const a of attached.filter((x) => x.ids.includes(f.pmid))) {
      if (a.ids.length > 1) continue; // a shared clause can't be pinned on one citation
      verdicts.push(["year", checkYear(f, a.segment)]);
      verdicts.push(["author", checkAuthor(f, a.segment)]);
      verdicts.push(["design", checkDesign(f, a.segment)]);
      verdicts.push(["numbers", checkNumbers(f, a.segment)]);
    }
    const applied = verdicts.filter((v): v is [Check, NonNullable<Verdict>] => v[1] !== null);
    if (applied.length === 0) continue;
    checked++;
    const failed = applied.filter((v) => !v[1].ok);
    if (failed.length === 0) continue;
    misattributed++;
    const seen = new Set<Check>();
    for (const [check, v] of failed) {
      if (v.ok || seen.has(check)) continue;
      seen.add(check);
      issues.push({ id: f.pmid, check, claimed: v.claimed, actual: v.actual });
    }
  }
  return { checked, misattributed, issues };
}
