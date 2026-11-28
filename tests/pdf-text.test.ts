import { describe, expect, it } from "vitest";
import { cleanPdfText } from "../src/core/pdf-text";

/** Text as pdf-parse returns it: each page's text, then "-- N of M --" between blank lines. */
function pdf(pages: string[][]): string {
  return pages.map((lines, i) => `${lines.join("\n")}\n\n-- ${i + 1} of ${pages.length} --\n\n`).join("").trim();
}

/** The same pages as cleanPdfText should leave them when it changes nothing: no markers, a blank line between the pages. */
const unmarked = (text: string): string => text.replace(/\n\n-- \d+ of \d+ --(\n\n|$)/g, (_, end: string) => (end ? "\n\n" : ""));

/** A page of `count` lines of prose that differ from every other line of the document. */
const prose = (page: number, count: number): string[] => Array.from({ length: count }, (_, i) => `Sentence ${page}-${i} of the article body, which is its own.`);

describe("page markers", () => {
  it("takes them out and separates the pages with a blank line", () => {
    const text = pdf([["First page.", "Second line."], ["Next page."], ["Last page."]]);
    expect(cleanPdfText(text)).toBe("First page.\nSecond line.\n\nNext page.\n\nLast page.");
  });

  it("leaves a text without markers as it was, and a page that is only noise out", () => {
    const text = "One page of text.\n\nWith a paragraph break.\n\n\nAnd a gap of two.";
    expect(cleanPdfText(text)).toBe(text);
    expect(cleanPdfText(`${text}\n\n-- 1 of 1 --`)).toBe(text);
    expect(cleanPdfText("-- 1 of 2 --\n\nBody.\n\n-- 2 of 2 --")).toBe("Body.");
  });

  it("only takes out a line that is a marker and nothing else", () => {
    const text = "See -- 3 of 5 -- in the table.\n-- 3 of 5 -- values\nThe range -- 3 of 5 --";
    expect(cleanPdfText(text)).toBe(text);
  });
});

describe("running headers and footers", () => {
  const withHeader = (pages: number, header: (n: number) => string, footer?: (n: number) => string): string =>
    pdf(Array.from({ length: pages }, (_, i) => [header(i + 1), ...prose(i + 1, 12), ...(footer ? [footer(i + 1)] : [])]));

  it("keeps the first of a line that repeats on every page, digits aside, and takes out the others", () => {
    const out = cleanPdfText(withHeader(5, (n) => `Journal of Tests \tPage ${n} of 5`, () => "Licensed under CC BY 4.0, a licence that says so"));
    expect(out.split("\n").filter((l) => l.startsWith("Journal of Tests"))).toEqual(["Journal of Tests \tPage 1 of 5"]);
    expect(out.split("\n").filter((l) => l.startsWith("Licensed under"))).toHaveLength(1);
    // The body is whole.
    for (let page = 1; page <= 5; page++) for (let i = 0; i < 12; i++) expect(out).toContain(`Sentence ${page}-${i} of the article body`);
  });

  it("takes out a header whose number is the page's own, written with a leading zero, and leaves one numbered otherwise", () => {
    const own = cleanPdfText(withHeader(12, (n) => `Frontiers in Neurology \t${String(n).padStart(2, "0")} \tfrontiersin.org`));
    expect(own.match(/Frontiers in Neurology/g)).toHaveLength(1);
    // Page numbers that start elsewhere (a journal's own pagination) can't be told from the figure labels below: left.
    const elsewhere = cleanPdfText(withHeader(5, (n) => `Journal of Tests 2024 \t${456 + n}`));
    expect(elsewhere.match(/Journal of Tests 2024/g)).toHaveLength(5);
  });

  it("leaves the labels that head the pages of an appendix, and lines that are not once a page", () => {
    const labels = cleanPdfText(withHeader(5, (n) => `Figure ${n + 10}`, () => "Caption of the figure on its page, which says so"));
    expect(labels.match(/^Figure \d+$/gm)).toHaveLength(5);
    expect(labels.match(/Caption of the figure/g)).toHaveLength(1);
    const twice = cleanPdfText(pdf(Array.from({ length: 4 }, () => ["Placebo group", "Active group", "Placebo group"])));
    expect(twice.match(/Placebo group/g)).toHaveLength(8);
  });

  it("takes out a line on at least half the pages, not on fewer", () => {
    const pages = Array.from({ length: 4 }, (_, i) => [...(i < 2 ? ["Seen on two of four pages"] : []), ...(i < 1 ? ["Seen on one of four pages"] : []), ...prose(i, 12)]);
    const out = cleanPdfText(pdf(pages));
    expect(out.match(/Seen on two of four pages/g)).toHaveLength(1);
    expect(out.match(/Seen on one of four pages/g)).toHaveLength(1);
    const three = cleanPdfText(pdf(Array.from({ length: 3 }, (_, i) => [...(i === 1 || i === 2 ? ["Seen on two of three"] : []), ...prose(i, 12)])));
    expect(three.match(/Seen on two of three/g)).toHaveLength(1);
    const oneOfThree = cleanPdfText(pdf(Array.from({ length: 3 }, (_, i) => [...(i === 1 ? ["Seen on one of three"] : []), ...prose(i, 12)])));
    expect(oneOfThree).toContain("Seen on one of three");
  });

  it("does not look for them in a PDF of fewer than three pages", () => {
    const out = cleanPdfText(withHeader(2, () => "Journal of Tests running header"));
    expect(out.match(/Journal of Tests running header/g)).toHaveLength(2);
  });

  it("leaves a line that also appears in the middle of a page, as a table's cells do", () => {
    const pages = Array.from({ length: 4 }, (_, p) => [...prose(p, 8), "Placebo group", ...prose(p + 10, 8), "Placebo group"]);
    expect(cleanPdfText(pdf(pages)).match(/Placebo group/g)).toHaveLength(8);
  });

  it("leaves lines with fewer than four letters: a page number's own line, a table's \"Yes\" and \"SD\"", () => {
    const out = cleanPdfText(withHeader(5, (n) => `- ${n} -`, () => "SD"));
    expect(out.match(/^- \d -$/gm)).toHaveLength(5);
    expect(out.match(/^SD$/gm)).toHaveLength(5);
  });

  it("keeps the first of a table header that is repeated on every page the table continues on", () => {
    const header = "Study\tN\tMean (SD)\tEffect size";
    const pages = Array.from({ length: 4 }, (_, p) => [header, ...Array.from({ length: 6 }, (_, i) => `Trial ${p}${i}\t${40 + i}\t${(p + i / 10).toFixed(1)} (0.${i})\t0.${p}${i}`)]);
    const out = cleanPdfText(pdf(pages));
    expect(out.match(/Study\tN\tMean \(SD\)\tEffect size/g)).toHaveLength(1);
    for (let p = 0; p < 4; p++) for (let i = 0; i < 6; i++) expect(out).toContain(`Trial ${p}${i}\t${40 + i}\t`);
  });

  it("leaves a stamp such as RETRACTED once, so that the text still says it", () => {
    const pages = Array.from({ length: 6 }, (_, p) => [...prose(p, 12), "RETRACTED", "RETRACTED ON 24 AUGUST 2026"]);
    const out = cleanPdfText(pdf(pages));
    expect(out.match(/^RETRACTED$/gm)).toHaveLength(1);
    expect(out.match(/^RETRACTED ON 24 AUGUST 2026$/gm)).toHaveLength(1);
  });
});

describe("manuscript line numbers", () => {
  /** `pages` pages of `perPage` lines, each with its number after a tab, numbered on through the document; a bare number for an empty line. */
  function numbered(pages: number, perPage = 14, firstBlankAt = 5): { text: string; plain: string } {
    let n = 0;
    const out: string[][] = [];
    const plain: string[][] = [];
    for (let p = 0; p < pages; p++) {
      const page: string[] = [];
      const bare: string[] = [];
      for (let i = 0; i < perPage; i++) {
        n += 1;
        if (i === firstBlankAt) {
          page.push(String(n));
          bare.push("");
        } else {
          page.push(`Sentence ${p}-${i}, margin line ${n}\t${n}`);
          bare.push(`Sentence ${p}-${i}, margin line ${n}`);
        }
      }
      out.push([String(p + 1), ...page]);
      plain.push([String(p + 1), ...bare]);
    }
    return { text: pdf(out), plain: plain.map((lines) => lines.join("\n")).join("\n\n") };
  }

  it("takes the numbers off the lines, and turns a line that is only a number into a blank line", () => {
    const { text, plain } = numbered(4);
    // Each page's own number (the first line of each page) stays: it is one a page, not a run.
    expect(cleanPdfText(text)).toBe(plain);
    expect(plain).toContain("Sentence 0-4, margin line 5\n\nSentence 0-6, margin line 7");
  });

  it("leaves the numbers of a PDF that has runs on fewer than three pages", () => {
    const { text } = numbered(2);
    expect(cleanPdfText(text)).toBe(unmarked(text));
  });

  it("leaves a number that is not part of a run of ten", () => {
    // Page 1: a run of 9 (each one more than the one before) only.
    const pages = Array.from({ length: 4 }, (_, p) => Array.from({ length: 9 }, (_, i) => `Row label ${p}-${i}\t${i + 1}`));
    const text = pdf(pages);
    expect(cleanPdfText(text)).toBe(unmarked(text));
  });

  it("leaves a number that is not one more than the one before, as in the ticks of an axis or a column of values", () => {
    const { text } = numbered(4);
    const withAxis = pdf([
      ["Figure 1", "0", "25", "50", "75", "100", "125", "150", "175", "200", "225", "250", "Count of cases"],
      ...text.split(/\n\n-- \d+ of 4 --\n\n/).map((p) => p.split("\n")),
    ]);
    const out = cleanPdfText(withAxis);
    for (const tick of ["0", "25", "50", "75", "100", "125", "150", "175", "200", "225", "250"]) expect(out.split("\n")).toContain(tick);
  });

  it("leaves a number alone on its line among other lines of numbers: a table's cells", () => {
    const { text } = numbered(4);
    const cells = ["Characteristic", "63", "Age", "57", "Male", "40", "Female", "23", "Smoker", "13"];
    const pages = text.split(/\n\n-- \d+ of 4 --\n\n/).map((p) => p.split("\n"));
    pages[1]!.push(...cells);
    const out = cleanPdfText(pdf(pages));
    expect(out).toContain(["Characteristic", "63", "Age", "57", "Male", "40", "Female", "23", "Smoker", "13"].join("\n"));
  });

  it("takes a trailing number only off a line that has a letter before it, so a table row's numbers stay", () => {
    const rows = (p: number) => Array.from({ length: 12 }, (_, i) => `${p}.${i}\t${12 * p + i + 1}`);
    const pages = [rows(0), rows(1), rows(2), rows(3)];
    const text = pdf(pages);
    // Twelve rows a page, the last number of each one more than the one before, on every page: no letters, so numbers.
    expect(cleanPdfText(text)).toBe(unmarked(text));
  });

  it("leaves a number after spaces and not a tab", () => {
    const pages = Array.from({ length: 4 }, (_, p) => Array.from({ length: 12 }, (_, i) => `Sentence ${p}-${i} ends in ${12 * p + i + 1}`));
    const text = pdf(pages);
    expect(cleanPdfText(text)).toBe(unmarked(text));
  });

  it("leaves the numbers of a table inside a numbered document where the table's lines have none", () => {
    const { text } = numbered(4);
    const pages = text.split(/\n\n-- \d+ of 4 --\n\n/).map((p) => p.split("\n"));
    const table = ["Table 1. Baseline", "Variables Cohort IS HS p value", "N 63 38 25", "Age 57.9 (13.2) 59.3 (12.7) 55.9 (13.9) 0.330", "Gender (Male) 40 (63.5) 19 (50.0) 21 (84.0) 0.006"];
    pages[2]!.splice(6, 0, ...table);
    const out = cleanPdfText(pdf(pages));
    expect(out).toContain(table.join("\n"));
  });
});

describe("all three together, and twice", () => {
  it("cleans a text once: a second pass changes nothing", () => {
    const pages = Array.from({ length: 5 }, (_, p) => ["Journal of Tests\tPage " + (p + 1), ...Array.from({ length: 12 }, (_, i) => `Body ${p}-${i} text\t${12 * p + i + 1}`)]);
    const once = cleanPdfText(pdf(pages));
    expect(once).not.toContain("-- 1 of 5 --");
    expect(cleanPdfText(once)).toBe(once);
  });
});
