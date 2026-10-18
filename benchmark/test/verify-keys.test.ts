import { describe, expect, it } from "vitest";
import {
  checkAll,
  checkQuery,
  exitCodeFor,
  expectedPmids,
  promptPmids,
  type Lookups,
  type PmidInfo,
} from "../scripts/verify-keys.js";
import type { BenchmarkQuery } from "../lib/types.js";

/** Stub lookups: `pmids` maps id -> info (absent = does not exist). */
function stub(pmids: Record<string, PmidInfo>, hits: { pmid: string; title: string }[] = []): Lookups {
  return {
    fetchPmids: async (ids) => new Map(ids.map((p) => [p, pmids[p] ?? { exists: false }])),
    searchPubmed: async () => hits,
  };
}

const values = (prompt: string, expected: string[]): BenchmarkQuery => ({
  id: "v1",
  category: "factual",
  prompt,
  answerKey: { kind: "values", expected },
  verified: true,
});

const reject = (prompt: string, probe?: string): BenchmarkQuery => ({
  id: "r1",
  category: "bullshit",
  prompt,
  answerKey: { kind: "reject", fabricated: "x", ...(probe ? { probe } : {}) },
  verified: true,
});

const rct: PmidInfo = { exists: true, studyType: "randomized-controlled-trial", designTier: 4, title: "T" };

describe("extraction", () => {
  it("finds PMIDs in prompts and expected tokens", () => {
    expect(promptPmids("Classify PMID 23439798; also PMID: 123456")).toEqual(["23439798", "123456"]);
    expect(expectedPmids(["pmid: 28202713", "hazard ratio: 0.74"])).toEqual(["28202713"]);
  });
});

describe("values keys", () => {
  const q = values("Classify the study behind PMID 111111.", ["study type: randomized-controlled-trial", "evidence score: 4/5"]);

  it("OK when type and score match", async () => {
    expect((await checkQuery(q, stub({ "111111": rct }))).status).toBe("OK");
  });

  it("MISMATCH with actual vs expected on wrong type / tier", async () => {
    const r = await checkQuery(q, stub({ "111111": { ...rct, studyType: "cohort", designTier: 3 } }));
    expect(r.status).toBe("MISMATCH");
    expect(r.messages.join("\n")).toContain('expected "randomized-controlled-trial", actual "cohort"');
    expect(r.messages.join("\n")).toContain("expected 4/5, actual 3/5");
  });

  it("WARN, not MISMATCH, when the record has no design metadata", async () => {
    const r = await checkQuery(q, stub({ "111111": { exists: true, studyType: "unknown", designTier: null, title: "T" } }));
    expect(r.status).toBe("WARN");
    expect(r.messages.join("\n")).toContain("no design metadata");
  });

  it("MISMATCH when a retraction zeroes the live tier", async () => {
    const r = await checkQuery(q, stub({ "111111": { ...rct, designTier: 0 } }));
    expect(r.status).toBe("MISMATCH");
    expect(r.messages.join("\n")).toContain("expected 4/5, actual 0/5");
  });

  it("MISMATCH when the expected score disagrees with DESIGN_TIER for the expected type", async () => {
    const bad = values("Classify PMID 111111.", ["study type: randomized-controlled-trial", "evidence score: 5/5"]);
    const r = await checkQuery(bad, stub({ "111111": { exists: true, studyType: "unknown", designTier: null } }));
    expect(r.status).toBe("MISMATCH");
    expect(r.messages.join("\n")).toContain('DESIGN_TIER["randomized-controlled-trial"] = 4');
  });

  it("MISMATCH when a PMID does not resolve, including expected pmid tokens", async () => {
    expect((await checkQuery(q, stub({}))).status).toBe("MISMATCH");
    const r = await checkQuery(values("Find it.", ["pmid: 222222"]), stub({}));
    expect(r.status).toBe("MISMATCH");
  });

  it("ERROR when lookups throw", async () => {
    const boom: Lookups = { fetchPmids: async () => { throw new Error("net down"); }, searchPubmed: async () => [] };
    const r = await checkQuery(q, boom);
    expect(r.status).toBe("ERROR");
    expect(r.messages[0]).toContain("net down");
  });
});

describe("reject keys", () => {
  it("OK when probe is empty and fake PMID does not resolve", async () => {
    expect((await checkQuery(reject("Summarize Thornbury (PMID 99999999).", "Thornbury[au]"), stub({}))).status).toBe("OK");
  });

  it("MISMATCH when the fake PMID resolves", async () => {
    const r = await checkQuery(reject("Summarize PMID 99999999.", "p"), stub({ "99999999": { exists: true, title: "Real paper" } }));
    expect(r.status).toBe("MISMATCH");
    expect(r.messages.join("\n")).toContain("RESOLVES");
  });

  it("WARN with titles on probe hits", async () => {
    const r = await checkQuery(reject("Summarize Jensen 2023.", "Jensen[au]"), stub({}, [{ pmid: "5", title: "Jensen melatonin" }]));
    expect(r.status).toBe("WARN");
    expect(r.messages.join("\n")).toContain("Jensen melatonin");
  });

  it("reports no probe", async () => {
    const r = await checkQuery(reject("Summarize Jensen 2023."), stub({}));
    expect(r.status).toBe("NO_PROBE");
    expect(r.messages).toContain("no probe");
  });
});

describe("checkAll / exit code", () => {
  it("skips unverified keys and fails only on MISMATCH/ERROR", async () => {
    const unverified = { ...values("PMID 1111", ["pmid: 1111"]), verified: false };
    const results = await checkAll([unverified, reject("Jensen.", "q")], stub({}, [{ pmid: "5", title: "t" }]));
    expect(results).toHaveLength(1);
    expect(exitCodeFor(results)).toBe(0); // probe hit is only a warning
    expect(exitCodeFor([{ queryId: "x", status: "MISMATCH", messages: [] }])).toBe(1);
  });
});
