import { describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { defaultDirs, loadSource, mergeSources, parseCsv, provenanceWarnings, toScoreRow, type Source } from "../merge.js";
import { toCsv } from "../lib/report/csv.js";
import { QUERIES } from "../lib/queries.js";
import type { ScoreRow } from "../lib/types.js";

const rubric = QUERIES.find((q) => q.answerKey.kind === "rubric")!;
const values = QUERIES.find((q) => q.answerKey.kind === "values")!;

const LEGACY_HEADER =
  "query_id,category,condition,model,run,accuracy,evidence_quality,bullshit_score,speed_s,input_tokens,output_tokens,tool_calls,tools_used,pmids_cited,pmids_valid,pmids_fabricated,composite";

describe("legacy CSV parsing", () => {
  it("fills status, accuracy_source, total_tokens and other_citations", () => {
    const csv = `${LEGACY_HEADER}\n${rubric.id},${rubric.category},mcp,m1,1,5,3,0,2.5,100,50,2,"a,b",3,3,0,6.1\n${values.id},${values.category},mcp,m1,1,1,3,0,2.5,10,5,2,,3,3,0,6.1\n`;
    const [r, v] = parseCsv(csv).map(toScoreRow);
    expect(r!.status).toBe("ok");
    expect(r!.accuracy_source).toBe("proxy");
    expect(v!.accuracy_source).toBe("deterministic");
    expect(r!.total_tokens).toBe(150);
    expect(r!.other_citations).toBe(0);
    expect(r!.tools_used).toBe("a,b");
  });

  it("round-trips the current CSV format, keeping blanks as NaN", () => {
    const row: ScoreRow = {
      query_id: "q",
      category: "factual",
      condition: "mcp",
      model: "m",
      run: 2,
      status: "truncated",
      accuracy: Number.NaN,
      accuracy_source: "human",
      evidence_quality: 1,
      bullshit_score: 0,
      speed_s: 1,
      input_tokens: 1,
      output_tokens: 2,
      total_tokens: 7,
      tool_calls: 0,
      tools_used: "",
      pmids_cited: 0,
      pmids_valid: 0,
      pmids_fabricated: 0,
      other_citations: 4,
      composite: 3,
    };
    const back = toScoreRow(parseCsv(toCsv([row]))[0]!);
    expect(back.status).toBe("truncated");
    expect(back.accuracy).toBeNaN();
    expect(back.accuracy_source).toBe("human");
    expect(back.total_tokens).toBe(7);
    expect(back.other_citations).toBe(4);
  });
});

const mk = (id: string, over: Partial<ScoreRow> = {}): ScoreRow => ({
  query_id: id,
  category: "factual",
  condition: "mcp",
  model: "m",
  run: 1,
  status: "ok",
  accuracy: 1,
  accuracy_source: "deterministic",
  evidence_quality: 1,
  bullshit_score: 0,
  speed_s: 1,
  input_tokens: 1,
  output_tokens: 1,
  total_tokens: 2,
  tool_calls: 0,
  tools_used: "",
  pmids_cited: 0,
  pmids_valid: 0,
  pmids_fabricated: 0,
  other_citations: 0,
  composite: 1,
  ...over,
});

describe("mergeSources", () => {
  it("later dir wins a cell, a failure never displaces ok, and provenance is recorded", () => {
    const a: Source = { dir: "A", rows: [mk("x", { composite: 1 }), mk("y", { composite: 1 })] };
    const b: Source = { dir: "B", rows: [mk("x", { composite: 9 }), mk("y", { status: "provider-error" })] };
    const { rows, provenance, sources } = mergeSources([a, b], 1);
    expect(rows.find((r) => r.query_id === "x")!.composite).toBe(9);
    expect(rows.find((r) => r.query_id === "y")!.status).toBe("ok");
    expect(provenance["x|mcp|m|1"]).toBe("B");
    expect(provenance["y|mcp|m|1"]).toBe("A");
    expect(sources).toEqual(["A", "B"]);
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
