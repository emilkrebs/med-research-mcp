import { describe, expect, it } from "vitest";
import { pubmedTools } from "../lib/tools/pubmed.js";
import type { GradedArticle } from "../lib/core.js";

const article: GradedArticle = {
  pmid: "27633186",
  title: "Semaglutide and Cardiovascular Outcomes in Patients with Type 2 Diabetes",
  authors: ["Marso SP"],
  journal: "The New England journal of medicine",
  pubDate: "2016 Nov 10",
  publicationTypes: ["Journal Article", "Randomized Controlled Trial"],
  meshHeadings: ["Humans"],
  abstract: "We randomly assigned 3297 patients.",
  studyType: "randomized-controlled-trial",
  designTier: 4,
  flags: ["corrected"],
};

type Execute = (input: unknown, options: { toolCallId: string; messages: never[] }) => Promise<string>;
const run = (tool: unknown, input: unknown): Promise<string> => (tool as { execute: Execute }).execute(input, { toolCallId: "t", messages: [] });

describe("pubmedTools (the plain PubMed baseline)", () => {
  it("offers a search and a fetch tool, and nothing the MCP adds", () => {
    const tools = pubmedTools({ search: async () => ({ articles: [], total: 0, query: "", page: 1, maxResults: 10 }) });
    expect(Object.keys(tools).sort()).toEqual(["pubmed_fetch", "pubmed_search"]);
    const text = JSON.stringify(tools);
    expect(text).not.toMatch(/designTier|studyType|europepmc|chinaxiv|full text/i);
  });

  it("returns PubMed's records without the design label, tier or flags", async () => {
    const seen: unknown[] = [];
    const tools = pubmedTools({
      search: async (input) => {
        seen.push(input);
        return { articles: [article], total: 1, query: input.query, page: 1, maxResults: input.maxResults ?? 10, nextPage: 2, warnings: ["w"] };
      },
    });
    const out = JSON.parse(await run(tools.pubmed_search, { query: "semaglutide[tiab]", maxResults: 5, sort: "date", dateRange: { from: "2016" } }));
    expect(seen).toEqual([{ query: "semaglutide[tiab]", maxResults: 5, sort: "date", dateRange: { from: "2016" } }]);
    expect(out.total).toBe(1);
    expect(out.nextPage).toBe(2);
    expect(out.warnings).toEqual(["w"]);
    const [record] = out.articles;
    expect(record.pmid).toBe("27633186");
    expect(record.publicationTypes).toContain("Randomized Controlled Trial"); // PubMed's own tag stays
    expect(record.abstract).toContain("3297");
    for (const added of ["studyType", "designTier", "flags"]) expect(added in record).toBe(false);
  });

  it("defaults to 10 results and passes no option the model didn't set", async () => {
    const seen: unknown[] = [];
    const tools = pubmedTools({ search: async (input) => (seen.push(input), { articles: [], total: 0, query: input.query, page: 1, maxResults: 10 }) });
    await run(tools.pubmed_search, { query: "x" });
    expect(seen).toEqual([{ query: "x", maxResults: 10 }]);
  });

  it("fetches records by PMID", async () => {
    const { studyType: _s, designTier: _d, flags: _f, ...raw } = article;
    const tools = pubmedTools({ fetch: async ({ ids }) => ({ articles: ids.includes(raw.pmid) ? [raw] : [], missing: ids.filter((i) => i !== raw.pmid) }) });
    const out = JSON.parse(await run(tools.pubmed_fetch, { pmids: ["27633186", "99999999"] }));
    expect(out.articles.map((a: { pmid: string }) => a.pmid)).toEqual(["27633186"]);
    expect(out.missing).toEqual(["99999999"]);
  });

  it("hands an error to the model as text instead of failing the run", async () => {
    const tools = pubmedTools({
      search: async () => {
        throw new Error("Query too broad (QUERY_TOO_BROAD)");
      },
      fetch: async () => {
        throw new Error("PubMed unreachable");
      },
    });
    expect(await run(tools.pubmed_search, { query: "cancer" })).toBe("Error: Query too broad (QUERY_TOO_BROAD)");
    expect(await run(tools.pubmed_fetch, { pmids: ["1"] })).toBe("Error: PubMed unreachable");
  });
});
