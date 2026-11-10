/**
 * Leak guard: nothing a model is shown before it answers may contain a benchmark query or its answer.
 *
 * The first version of the `med-research` skill taught its workflow with three worked examples that
 * were benchmark queries (one with its answer), and the `literature_fetch` description used the answer
 * record of another query as its example id. A condition whose prompt contains the test items is not
 * being tested on them. These checks keep the two apart for both query sets.
 */

import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createServer, LRUBackend } from "../lib/core.js";
import { SKILL_TEXT, SYSTEM_PROMPT } from "../lib/config.js";
import { QUERIES } from "../lib/queries.js";
import { pubmedTools } from "../lib/tools/pubmed.js";
import type { BenchmarkQuery } from "../lib/types.js";

const SKILLS_DIR = fileURLToPath(new URL("../../skills", import.meta.url));

/** Every shipped skill, by name. Only `med-research` is injected by the benchmark; a user's model can load any. */
const SKILLS: Record<string, string> = Object.fromEntries(
  readdirSync(SKILLS_DIR).map((name) => [name, readFileSync(join(SKILLS_DIR, name, "SKILL.md"), "utf-8")]),
);

/** The tool names, descriptions and schemas the MCP server hands a model, as one string. */
async function mcpToolText(): Promise<string> {
  const server = createServer({ cache: new LRUBackend() });
  const client = new Client({ name: "leak-test", version: "0.0.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  const { tools } = await client.listTools();
  await client.close();
  await server.close();
  return JSON.stringify(tools);
}

const norm = (s: string): string => s.toLowerCase().replace(/\s+/g, " ").trim();

/** The ids that are a query's answer or its subject record. */
export function answerIds(q: BenchmarkQuery): string[] {
  const key = q.answerKey;
  const ids = new Set<string>();
  for (const m of q.prompt.matchAll(/\bPMID[\s:]*(\d{6,9})\b/gi)) ids.add(m[1]!);
  if (key.kind === "values") {
    for (const token of key.expected) {
      const m = /^\s*pmid\s*:\s*(\d+)\s*$/i.exec(token);
      if (m) ids.add(m[1]!);
    }
    if (key.source) {
      ids.add(key.source.id);
      // "CBA:521529" is also cited as ".../CBA/521529"; "chinaxiv-202608.00133" as "202608.00133".
      const tail = /(\d{6,}(?:\.\d+)?)$/.exec(key.source.id);
      if (tail) ids.add(tail[1]!);
    }
  }
  if (key.kind === "accept") ids.add(key.pmid);
  return [...ids];
}

/** The question a prompt asks, without the answer-format instructions that follow it. */
export function question(q: BenchmarkQuery): string {
  return q.prompt.split(/\s+(?:Finish your reply|Cite the (?:PMID|record))/)[0]!.trim();
}

const STOPWORDS = new Set("the and for which has have why what does did are was were with that this from how its into than you can any all not per".split(" "));

/** Content words of a sentence, for a rough similarity. */
function words(s: string): Set<string> {
  return new Set((s.toLowerCase().match(/[a-z][a-z0-9-]{2,}/g) ?? []).filter((w) => !STOPWORDS.has(w)));
}

/** Jaccard overlap of the content words of two sentences, 0–1. */
export function overlap(a: string, b: string): number {
  const x = words(a);
  const y = words(b);
  const shared = [...x].filter((w) => y.has(w)).length;
  return shared === 0 ? 0 : shared / (x.size + y.size - shared);
}

/** The worked examples of a skill: its quoted questions (`> "…"`). */
export function workedExamples(skill: string): string[] {
  return [...skill.matchAll(/^>\s*"(.+)"\s*$/gm)].map((m) => m[1]!);
}

/** Queries that a text gives away, with the reason. */
export function leaks(text: string, queries: BenchmarkQuery[]): string[] {
  const found: string[] = [];
  const flat = norm(text);
  const examples = workedExamples(text);
  for (const q of queries) {
    for (const id of answerIds(q)) {
      if (new RegExp(`(?<![\\d.])${id.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?![\\d])`).test(text)) found.push(`${q.id}: contains its record id ${id}`);
    }
    const asked = question(q);
    if (asked.length >= 25 && flat.includes(norm(asked))) found.push(`${q.id}: contains its question verbatim`);
    for (const example of examples) {
      if (overlap(example, asked) >= 0.5) found.push(`${q.id}: worked example "${example}" paraphrases its question`);
    }
  }
  return found;
}

describe("the leak guard itself", () => {
  const byId = (id: string): BenchmarkQuery => QUERIES.find((q) => q.id === id)!;

  it("catches the three examples the first skill used, and the old tool-description id", () => {
    const oldSkill = [
      '> "What study design is PMID 36615805, and how strong is that design?"',
      'Answer: *"Systematic review and meta-analysis of 21 randomized controlled trials: design tier 5 of 5 (PMID 36615805)."*',
      '> "Compare DORAs vs trazodone for sleep quality. Which has stronger evidence, and why?"',
      '> "Summarize the 2023 Jensen trial on melatonin and REM sleep."',
    ].join("\n\n");
    const found = leaks(oldSkill, QUERIES).join("\n");
    expect(found).toContain("factual-01: contains its record id 36615805");
    expect(found).toContain("synthesis-01: worked example");
    expect(found).toContain("bullshit-01: contains its question verbatim");
    expect(leaks("PMIDs or prefixed ids (e.g. CBA:521529, PPR… preprints)", QUERIES)).toEqual(["edge-case-03: contains its record id CBA:521529", "edge-case-03: contains its record id 521529"]);
    expect(leaks("see https://europepmc.org/article/CBA/521529", [byId("edge-case-03")])).toEqual(["edge-case-03: contains its record id 521529"]);
  });

  it("does not fire on an unrelated question, a longer number, or a shared opening word", () => {
    expect(leaks('> "Compare glucosamine vs chondroitin for knee osteoarthritis pain. Which has stronger evidence, and why?"', QUERIES)).toEqual([]);
    expect(leaks("a count of 136615805 records, 366158051 of them new, version 1.36615805", [byId("factual-01")])).toEqual([]);
    const asked = question(byId("synthesis-01"));
    expect(overlap("Compare DORAs vs trazodone for sleep quality. Which has stronger evidence, and why?", asked)).toBeGreaterThanOrEqual(0.5);
    expect(overlap("Compare glucosamine vs chondroitin for knee osteoarthritis pain. Which has stronger evidence, and why?", asked)).toBeLessThan(0.3);
  });

  it("reads answer ids from prompts, expected tokens, sources and control keys", () => {
    expect(answerIds(byId("factual-01"))).toEqual(["36615805"]);
    expect(answerIds(byId("drill-down-03"))).toEqual(["27633186"]);
    expect(answerIds(byId("edge-case-06")).sort()).toEqual(["202608.00133", "chinaxiv-202608.00133"]);
    expect(answerIds({ id: "c", category: "control", prompt: "Summarize the 2012 Shenoy trial.", answerKey: { kind: "accept", pmid: "23326093", author: "Shenoy", year: 2012 }, verified: true })).toEqual(["23326093"]);
    expect(question(byId("drill-down-03"))).toBe(
      "The SUSTAIN-6 semaglutide cardiovascular outcomes trial: what was its primary composite endpoint, and what hazard ratio did it report for that endpoint?",
    );
  });
});

describe("nothing shown to a model contains a benchmark query or its answer", () => {
  it("the system prompt and the skill injected in condition D", () => {
    expect(leaks(SYSTEM_PROMPT, QUERIES)).toEqual([]);
    expect(leaks(SKILL_TEXT, QUERIES)).toEqual([]);
    // The skill does teach by example: the guard has something to look at.
    expect(workedExamples(SKILL_TEXT).length).toBeGreaterThanOrEqual(3);
  });

  it.each(Object.keys(SKILLS))("the shipped skill %s", (name) => {
    expect(leaks(SKILLS[name]!, QUERIES)).toEqual([]);
  });

  it("the MCP server's tool names, descriptions and schemas", async () => {
    const text = await mcpToolText();
    expect(text).toContain("literature_search");
    expect(leaks(text, QUERIES)).toEqual([]);
  });

  it("the plain PubMed baseline's tool descriptions", () => {
    const text = Object.values(pubmedTools()).map((t) => (t as { description?: string }).description ?? "").join("\n");
    expect(text).toContain("PubMed");
    expect(leaks(text, QUERIES)).toEqual([]);
  });
});
