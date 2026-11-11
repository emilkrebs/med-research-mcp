/** Reading the whole full text through the library's paged full-text function. */

import { describe, expect, it } from "vitest";
import { readFulltext, type FulltextFetch } from "../lib/fulltext.js";
import type { FulltextInput, FulltextOutput } from "../lib/core.js";

/** A fake `fetchFulltext` serving `text` in parts of `size` characters, as the library does. */
function pager(text: string, size: number, source = "europepmc"): { fetch: FulltextFetch; calls: FulltextInput[] } {
  const calls: FulltextInput[] = [];
  const fetch: FulltextFetch = async (input) => {
    calls.push(input);
    const offset = input.offset ?? 0;
    const end = Math.min(offset + size, text.length);
    const out: FulltextOutput = {
      id: input.id,
      source: source as FulltextOutput["source"],
      fulltext: text.slice(offset, end),
      format: "markdown",
      truncated: end < text.length,
      totalChars: text.length,
      ...(end < text.length ? { nextOffset: end } : {}),
    };
    return out;
  };
  return { fetch, calls };
}

describe("readFulltext", () => {
  it("reads every part and joins them, asking for the next from nextOffset", async () => {
    const text = "Results. The median follow-up was 18 months. Adverse events were rare.";
    const { fetch, calls } = pager(text, 20);
    const result = await readFulltext("34728476", fetch);
    expect(result).toEqual({ text, source: "europepmc", format: "markdown" });
    expect(calls.map((c) => c.offset)).toEqual([undefined, 20, 40, 60]);
    expect(calls.every((c) => c.id === "34728476")).toBe(true);
  });

  it("reads a text that fits in one part with one call", async () => {
    const { fetch, calls } = pager("short text", 1000);
    expect((await readFulltext("1", fetch)).text).toBe("short text");
    expect(calls).toHaveLength(1);
  });

  it("returns no text, and the function's warning, when it only has the abstract", async () => {
    const fetch: FulltextFetch = async (input) => ({ id: input.id, source: "none", fulltext: "The abstract.", format: "markdown", truncated: false, warning: "Europe PMC has an abstract only" });
    expect(await readFulltext("1", fetch)).toEqual({ source: "none", warning: "Europe PMC has an abstract only" });
    const bare: FulltextFetch = async (input) => ({ id: input.id, source: "none", format: "markdown", truncated: false });
    expect(await readFulltext("1", bare)).toEqual({ source: "none" });
  });

  it("does not loop on a function that says there is more and gives no way on", async () => {
    const stuck: FulltextFetch = async (input) => ({ id: input.id, source: "europepmc", fulltext: "x", format: "markdown", truncated: true });
    await expect(readFulltext("1", stuck)).rejects.toThrow(/no further offset/);
    const same: FulltextFetch = async (input) => ({ id: input.id, source: "europepmc", fulltext: "x", format: "markdown", truncated: true, nextOffset: 0 });
    await expect(readFulltext("1", same)).rejects.toThrow(/no further offset/);
    const endless: FulltextFetch = async (input) => ({ id: input.id, source: "europepmc", fulltext: "x", format: "markdown", truncated: true, nextOffset: (input.offset ?? 0) + 1 });
    await expect(readFulltext("1", endless)).rejects.toThrow(/more than 40 parts/);
  });

  it("lets a network failure through, so that a key is never read as having no full text", async () => {
    const down: FulltextFetch = async () => {
      throw new Error("fetch failed");
    };
    await expect(readFulltext("1", down)).rejects.toThrow("fetch failed");
  });
});
