import { describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { defaultDirs, loadSource, mergeSources, parseCsv, provenanceWarnings, toScoreRow, type Source } from "../merge.js";
import { toCsv } from "../lib/report/csv.js";
import { QUERIES } from "../lib/queries.js";
import type { ScoreRow } from "../lib/types.js";
import { scoreRow } from "./helpers.js";

const rubric = QUERIES.find((q) => q.answerKey.kind === "rubric")!;
const values = QUERIES.find((q) => q.answerKey.kind === "values")!;
const reject = QUERIES.find((q) => q.answerKey.kind === "reject")!;

/** The scores.csv header written before scorer v8. */
const LEGACY_HEADER =
  "query_id,category,condition,model,run,status,accuracy,accuracy_source,evidence_quality,bullshit_score,speed_s,input_tokens,output_tokens,tool_calls,tools_used,pmids_cited,pmids_valid,pmids_fabricated,composite";

describe("legacy CSV parsing", () => {
  const line = (id: string, category: string, status: string, accuracy: string, source: string, bs: string) =>
    `${id},${category},mcp,m1,1,${status},${accuracy},${source},3,${bs},2.5,100,50,2,"a,b",3,3,0,6.1`;
  const csv = [
    LEGACY_HEADER,
    line(rubric.id, rubric.category, "ok", "5", "proxy", "1"),
    line(values.id, values.category, "ok", "10", "deterministic", "1"),
    line(reject.id, reject.category, "ok", "10", "reject", "1"),
    line(values.id, values.category, "truncated", "0", "deterministic", "0"),
    line(values.id, values.category, "provider-error", "0", "deterministic", "0"),
  ].join("\n");
  const [r, v, b, failed, missing] = parseCsv(`${csv}\n`).map(toScoreRow);

  it("reads the citation proxy as unscored: a legacy rubric accuracy is not an accuracy", () => {
    expect(r!.accuracy_source).toBe("ungraded");
    expect(r!.accuracy).toBeNaN();
    expect(r!.key_kind).toBe("rubric");
  });

  it("keeps ground-truth accuracy, and the premise score only where it is one", () => {
    expect(v!.accuracy).toBe(10);
    expect(v!.accuracy_source).toBe("deterministic");
    expect(v!.bullshit_score).toBeNaN(); // was citation integrity on ordinary queries
    expect(b!.key_kind).toBe("reject");
    expect(b!.bullshit_score).toBe(1);
  });

  it("maps old statuses: `truncated` is a failure scored 0, a provider error is missing", () => {
    expect(failed!.status).toBe("no-answer");
    expect(failed!.accuracy).toBe(0);
    expect(failed!.accuracy_source).toBe("failed");
    expect(missing!.status).toBe("provider-error");
    expect(missing!.accuracy).toBeNaN();
  });

  it("fills the columns the old file lacks and ignores its composite", () => {
    expect(r!.status).toBe("ok");
    expect(r!.split).toBe("dev");
    expect(r!.total_tokens).toBe(150);
    expect(r!.other_citations).toBe(0);
    expect(r!.pmids_off_topic).toBe(0);
    expect(r!.tools_used).toBe("a,b");
    expect("composite" in r!).toBe(false);
  });
});

describe("current CSV format", () => {
  it("round-trips every column, keeping blanks as NaN", () => {
    const rows: ScoreRow[] = [
      scoreRow({ query_id: "q", run: 2, split: "test", retrieval_only: true, beyond_pubmed: true, pmids_fabricated: 2, pmids_off_topic: 1, other_citations: 4, citations_checked: 3, citations_misattributed: 1 }),
      scoreRow({ query_id: "r", key_kind: "rubric", accuracy: 7.5, accuracy_source: "human", accuracy_graders: 2 }),
      scoreRow({ query_id: "u", key_kind: "rubric", accuracy: Number.NaN, accuracy_source: "ungraded" }),
      scoreRow({ query_id: "c", key_kind: "accept", category: "control", accuracy: 10, accuracy_source: "accept", bullshit_score: 1 }),
      scoreRow({ query_id: "t", status: "timeout", accuracy: 0, accuracy_source: "failed", evidence_quality: Number.NaN }),
      scoreRow({ query_id: "p", status: "provider-error", accuracy: Number.NaN, evidence_quality: Number.NaN }),
    ];
    expect(parseCsv(toCsv(rows)).map(toScoreRow)).toEqual(rows);
  });
});

describe("the beyond_pubmed column", () => {
  const header = toCsv([scoreRow()]).split("\n")[0]!;

  it("is written right after retrieval_only and read back as a boolean", () => {
    const cols = header.split(",");
    expect(cols.indexOf("beyond_pubmed")).toBe(cols.indexOf("retrieval_only") + 1);
    const rows = [scoreRow({ query_id: "a", beyond_pubmed: true }), scoreRow({ query_id: "b", beyond_pubmed: false })];
    const back = parseCsv(toCsv(rows)).map(toScoreRow);
    expect(back.map((r) => r.beyond_pubmed)).toEqual([true, false]);
    expect(back).toEqual(rows);
  });

  it("an older CSV without the column reads as the catalog says: false for every query the catalog has", () => {
    const old = header
      .split(",")
      .filter((c) => c !== "beyond_pubmed");
    const cells = (id: string): string =>
      old
        .map((c) => ({ query_id: id, category: "factual", split: "dev", key_kind: "values", retrieval_only: "false", condition: "mcp", model: "m1", run: "1", status: "ok", accuracy: "10", accuracy_source: "deterministic", tools_used: "" })[c as string] ?? "1")
        .join(",");
    const [known, unknown] = parseCsv(`${old.join(",")}\n${cells(values.id)}\n${cells("t-retired-99")}\n`).map(toScoreRow);
    expect(known!.beyond_pubmed).toBe(false);
    expect(unknown!.beyond_pubmed).toBe(false);
    expect(known!.accuracy).toBe(10);
  });

  it("a cell wins over the catalog, and an empty cell falls back to it", () => {
    const base = parseCsv(toCsv([scoreRow({ query_id: values.id, beyond_pubmed: true })])).map((r) => r)[0]!;
    expect(toScoreRow(base).beyond_pubmed).toBe(true);
    expect(toScoreRow({ ...base, beyond_pubmed: "false" }).beyond_pubmed).toBe(false);
    expect(toScoreRow({ ...base, beyond_pubmed: "" }).beyond_pubmed).toBe(false); // the catalog's query is not beyond PubMed
  });
});

const mk = (id: string, over: Partial<ScoreRow> = {}): ScoreRow => scoreRow({ query_id: id, model: "m", ...over });

describe("mergeSources", () => {
  it("later dir wins a cell, a missing run never displaces data, and provenance is recorded", () => {
    const a: Source = { dir: "A", rows: [mk("x", { accuracy: 1 }), mk("y", { accuracy: 1 })] };
    const b: Source = { dir: "B", rows: [mk("x", { accuracy: 9 }), mk("y", { status: "provider-error", accuracy: Number.NaN })] };
    const { rows, provenance, sources } = mergeSources([a, b], 1);
    expect(rows.find((r) => r.query_id === "x")!.accuracy).toBe(9);
    expect(rows.find((r) => r.query_id === "y")!.status).toBe("ok");
    expect(provenance["x|mcp|m|1"]).toBe("B");
    expect(provenance["y|mcp|m|1"]).toBe("A");
    expect(sources).toEqual(["A", "B"]);
  });

  it("a later failure is a result and replaces an earlier answer: no best-of-N", () => {
    const a: Source = { dir: "A", rows: [mk("x", { accuracy: 10 }), mk("y", { status: "timeout", accuracy: 0, accuracy_source: "failed" })] };
    const b: Source = { dir: "B", rows: [mk("x", { status: "no-answer", accuracy: 0, accuracy_source: "failed" }), mk("y", { status: "scoring-error", accuracy: Number.NaN })] };
    const { rows } = mergeSources([a, b], 1);
    expect(rows.find((r) => r.query_id === "x")!.status).toBe("no-answer");
    expect(rows.find((r) => r.query_id === "y")!.status).toBe("timeout");
  });

  it("skips dirs below --min-rows", () => {
    const { rows } = mergeSources([{ dir: "smoke", rows: [mk("x")] }], 2);
    expect(rows).toHaveLength(0);
  });

  it("warns on differing commits, scorer versions and answer-key versions", () => {
    const man = (commit: string, scorer: number, v: number) => ({
      git: { commit, dirty: false },
      scorer_version: scorer,
      queries: [{ id: "q1", answerKeyVersion: v }],
    });
    const w = provenanceWarnings([
      { dir: "A", manifest: man("aaa", 1, 1) },
      { dir: "B", manifest: man("bbb", 2, 2) },
      { dir: "C" },
    ]).join("\n");
    expect(w).toMatch(/different MCP commits/);
    expect(w).toMatch(/scorer versions/);
    expect(w).toMatch(/answer-key versions for: q1/);
    expect(w).toMatch(/no manifest.*C/);
    expect(provenanceWarnings([{ dir: "A", manifest: man("a", 2, 1) }, { dir: "B", manifest: man("a", 2, 1) }])).toEqual([]);
  });

  it("compares the scorer version the rows carry now, not the one the run started with", () => {
    const run = { git: { commit: "a", dirty: false }, scorer_version: 4, queries: [{ id: "q1", answerKeyVersion: 1 }] };
    const rescored = { ...run, rescored: { at: "2026-11-09T00:00:00Z", scorer_version: 8, harness_commit: "b", harness_dirty: false } };
    // Same run-time version, but one dir was scored again since: the rows differ.
    expect(provenanceWarnings([{ dir: "A", manifest: run }, { dir: "B", manifest: rescored }]).join("\n")).toMatch(/scorer versions: 4 \(A\) vs 8 \(B\)/);
    // Different run-time versions, both scored again with the current one: comparable.
    expect(provenanceWarnings([{ dir: "A", manifest: rescored }, { dir: "B", manifest: { ...rescored, scorer_version: 7 } }])).toEqual([]);
  });
});

describe("directory discovery", () => {
  it("excludes `combined` and reads csv + manifest", () => {
    const root = mkdtempSync(join(tmpdir(), "merge-"));
    for (const d of ["2026-01-01", "combined", "2026-02-01"]) mkdirSync(join(root, d));
    writeFileSync(join(root, "2026-01-01", "scores.csv"), toCsv([mk("x")]));
    writeFileSync(join(root, "2026-01-01", "manifest.json"), JSON.stringify({ scorer_version: 2 }));
    expect(defaultDirs(root).map((d) => d.split("/").pop())).toEqual(["2026-01-01", "2026-02-01"]);
    const s = loadSource(join(root, "2026-01-01"))!;
    expect(s.rows).toHaveLength(1);
    expect(s.manifest?.scorer_version).toBe(2);
    expect(loadSource(join(root, "2026-02-01"))).toBeUndefined();
  });
});
