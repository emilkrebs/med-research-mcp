/** Reading the whole full text through the library's paged full-text function. */

import { describe, expect, it } from "vitest";
import { readFulltext, standingOf, type FulltextFetch } from "../lib/fulltext.js";
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

  it("returns the first part's warning with the text, whether or not there are later parts", async () => {
    const warning = 'RETRACTED: this record is flagged "retracted" (as in literature_search): do not use its findings as evidence. Linked notice: pubmed 38512453 (literature_fetch).';
    const withWarning: FulltextFetch = async (input) => ({ id: input.id, source: "europepmc", fulltext: "The text.", format: "markdown", truncated: false, warning });
    expect(await readFulltext("1", withWarning)).toEqual({ text: "The text.", source: "europepmc", format: "markdown", warning });

    // The library asks for the standing at offset 0 only; a later part carries what the records say or nothing, and the first part's is kept.
    const paged = pager("Results. The median follow-up was 18 months.", 20);
    const parts: FulltextFetch = async (input) => {
      const out = await paged.fetch(input);
      return (input.offset ?? 0) === 0 ? { ...out, warning } : { ...out, warning: `Not the first part's: ${input.offset}` };
    };
    expect(await readFulltext("1", parts)).toEqual({ text: "Results. The median follow-up was 18 months.", source: "europepmc", format: "markdown", warning });

    // A first part without a warning stays without one, whatever the later parts say.
    const late: FulltextFetch = async (input) => {
      const out = await paged.fetch(input);
      return (input.offset ?? 0) === 0 ? out : { ...out, warning: "RETRACTED: from a later part." };
    };
    expect(Object.keys(await readFulltext("1", late))).toEqual(["text", "source", "format"]);
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

describe("standingOf", () => {
  const retracted = 'RETRACTED: this record is flagged "retracted" (as in literature_search): do not use its findings as evidence.';
  const linked = "Linked notice: pubmed 38512453 (literature_fetch).";
  const notice = 'NOTICE: this record is a retraction notice (flag "notice"), not a study: its text is no evidence for a claim.';
  const concern = 'EXPRESSION OF CONCERN: one is linked to this record (flag "expression-of-concern"): read the notice before relying on its findings. Linked notices: pubmed 42781840, europepmc PMC1 (literature_fetch).';
  const translation = "Machine translation into English by ChinaRxiv, a third-party service, not the authors' wording: check numbers and claims against the original before relying on them.";

  it("returns the standing a warning opens with, with the notices linked to it, for each of the library's three", () => {
    expect(standingOf(retracted)).toBe(retracted);
    expect(standingOf(`${retracted} ${linked}`)).toBe(`${retracted} ${linked}`);
    expect(standingOf(notice)).toBe(notice);
    expect(standingOf(concern)).toBe(concern);
  });

  it("stops where the standing ends: the note on the text, or what each location answered, is not part of it", () => {
    expect(standingOf(`${retracted} ${linked} ${translation}`)).toBe(`${retracted} ${linked}`);
    expect(standingOf(`${retracted} ${notice} ${concern} No full text found; returned the abstract only.`)).toBe(`${retracted} ${notice} ${concern}`);
    expect(standingOf(`${notice} ${translation}`)).toBe(notice);
  });

  it("is undefined for a warning that does not open with a standing", () => {
    expect(standingOf(undefined)).toBeUndefined();
    expect(standingOf("")).toBeUndefined();
    expect(standingOf(translation)).toBeUndefined();
    expect(standingOf("Some other note on the text.")).toBeUndefined();
    expect(standingOf("No full text found; returned the abstract only. Europe PMC's full text couldn't be reached.")).toBeUndefined();
    // Only an opening counts: the library puts the standing first, so a word later in a note is not one.
    expect(standingOf(`${translation} ${retracted}`)).toBeUndefined();
    expect(standingOf("The article was RETRACTED: see the journal.")).toBeUndefined();
  });
});
