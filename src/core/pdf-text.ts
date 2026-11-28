/**
 * Layout noise in the text pdf.js extracts from a PDF, taken out before the text is cached or kept for
 * paging, so that `totalChars` and `offset` count the text a caller reads. pdf-parse ends the text of each
 * page with a line `-- N of M --` and joins the items of a visual line with tabs. Three kinds of line are
 * layout, not article:
 *
 *   - page markers (`-- 42 of 42 --`);
 *   - manuscript line numbers: the left-margin numbering of a preprint. They come out as a line of the
 *     number alone (for an empty manuscript line) or as a tab and the number at the end of the line it
 *     belongs to ("…allosteric<TAB>1");
 *   - running headers and footers: a journal's name, a licence statement, "Page 3".
 *
 * The cleanup must never touch article content, and a table's cells come out of a PDF as lines of bare
 * numbers and as numbers at the end of a row, so every rule needs more than a line's shape:
 *
 *   - a line number counts only inside a run of at least {@link MIN_RUN} numbers on one page, each one
 *     more than the one before, and only when such runs are on at least {@link MIN_NUMBERED_PAGES} pages.
 *     A number alone, a short run (a table's row numbers, the ticks of a chart's axis) and the page
 *     numbers (one a page) stay. At the end of a line, only after text that has a letter in it;
 *   - a header or footer is a line that appears once on each of at least half the pages of a PDF of
 *     {@link MIN_PAGES} or more, every time among the first or last {@link EDGE_LINES} lines of its page and with
 *     at least {@link MIN_LETTERS} letters in it. Its digits are not compared ("Page 3" matches "Page 4"), but
 *     they must be the same every time, or the page's own number every time: the "Figure 2" and "Figure 3" that
 *     head the pages of an appendix are not running lines. Its first occurrence stays, so that a licence
 *     statement, a journal's name or a "RETRACTED" stamp is still said once, and so does a table header that
 *     is repeated on every page its table continues on.
 *
 * Where a text has no markers (`pdfToText` is injectable, and a future pdf-parse may format differently) it is
 * one page, and nothing is looked for in one page: it comes back as it was.
 *
 * Measured on 2026-11-28 on four PDFs, as pdf-parse returned them and as a call returns them: PPR1350524
 * (bioRxiv, 42 pages, line numbers) 93,678 characters to 76,246, 10.3389/fneur.2024.1391448 (Frontiers, 37
 * pages) 142,926 to 138,332, PPR1332479 (medRxiv, 31 pages, line numbers and tables) 68,912 to 55,603, PPR1336021
 * (medRxiv, 17 pages, tables) 38,241 to 33,814. Of the lines with two or more numbers in them, the only ones
 * gone were repeat copies of a header or footer, and a margin number off the end of a line. Left, because no rule
 * reaches them: 174 of PPR1350524's 838 margin numbers (runs shorter than {@link MIN_RUN}), the header of 6 of
 * the Frontiers PDF's 37 pages, which is split over several lines, and the footer of the last 4 of PPR1336021's
 * 17 pages, which differs from the others'.
 */

/** A line pdf-parse puts after the text of each page: "-- 42 of 42 --". */
const PAGE_MARKER = /^-- \d+ of \d+ --\s*$/;
/** What a margin number looks like: up to four digits, as a line of its own or after the tab at the end of a line. */
const LINE_NUMBER = /^\d{1,4}$/;
/** The fewest numbers in a run of line numbers, each one more than the one before, on one page. */
const MIN_RUN = 10;
/** The fewest pages with such a run for a PDF to count as numbered. */
const MIN_NUMBERED_PAGES = 3;
/** The fewest pages of a PDF whose running headers and footers are looked for. */
const MIN_PAGES = 3;
/** How many lines at the top and at the bottom of a page a running header or footer is among. */
const EDGE_LINES = 5;
/** The fewest letters in a running header or footer: "- 3 -", "p. 3" and the "Yes" or "SD" of a table's cells are left. */
const MIN_LETTERS = 4;

/** A line of a page; `cut` says that something was taken out of its place, so blank lines beside it merge. */
interface Line {
  text: string;
  cut: boolean;
}

const isBlank = (line: Line): boolean => line.text.trim() === "";

/** The number a line carries as a manuscript line number, if its shape allows it, and what is left of the line without it. */
function numberOf(text: string): { value: number; rest: string } | undefined {
  if (LINE_NUMBER.test(text.trim())) return { value: Number(text.trim()), rest: "" };
  const tab = text.lastIndexOf("\t");
  if (tab <= 0) return undefined;
  const tail = text.slice(tab + 1).trim();
  const rest = text.slice(0, tab).trimEnd();
  return LINE_NUMBER.test(tail) && /\p{L}/u.test(rest) ? { value: Number(tail), rest } : undefined;
}

/** The runs of line numbers on one page that are long enough, as the indexes of their lines. */
function numberRuns(page: Line[]): number[][] {
  const runs: number[][] = [];
  let run: number[] = [];
  let last = -1;
  const close = (): void => {
    if (run.length >= MIN_RUN) runs.push(run);
    run = [];
  };
  page.forEach((line, index) => {
    const found = numberOf(line.text);
    if (!found) return;
    if (run.length > 0 && found.value === last + 1) run.push(index);
    else {
      close();
      run = [index];
    }
    last = found.value;
  });
  close();
  return runs;
}

/** Takes the manuscript line numbers out of the pages, when enough pages have them. */
function removeLineNumbers(pages: Line[][]): void {
  const runs = pages.map(numberRuns);
  if (runs.filter((r) => r.length > 0).length < MIN_NUMBERED_PAGES) return;
  pages.forEach((page, p) => {
    for (const index of runs[p]!.flat()) {
      const line = page[index]!;
      // An empty manuscript line is a gap between paragraphs: it stays as a blank line.
      line.text = numberOf(line.text)!.rest;
      if (line.text === "") line.cut = true;
    }
  });
}

/** A line that might be a running header or footer: where it stands on its page, and the text it has there. */
interface Occurrence {
  page: number;
  index: number;
  text: string;
  atEdge: boolean;
}

/**
 * Takes the running headers and footers out of the pages, all but the first of each. Lines count as the same when
 * only their digits differ ("Page 3", "Page 4"), but a group of such lines is a running line only when it is
 * once a page, always at the edge of the page, and either identical in every digit (a licence statement, a
 * date and DOI) or numbered with the page's own number every time ("Frontiers in Neurology 02"): the "Figure 2" and
 * "Figure 3" that head the pages of an appendix, and the rows of a table that continues over pages, differ in digits
 * in no such way, and stay.
 */
function removeRunningLines(pages: Line[][]): void {
  if (pages.length < MIN_PAGES) return;
  const groups = new Map<string, Occurrence[]>();
  pages.forEach((page, p) => {
    const filled = page.flatMap((line, index) => (isBlank(line) ? [] : [index]));
    filled.forEach((index, position) => {
      const text = page[index]!.text.replace(/\s+/g, " ").trim();
      if ((text.match(/\p{L}/gu)?.length ?? 0) < MIN_LETTERS) return;
      const key = text.replace(/\d+/g, "#");
      const atEdge = position < EDGE_LINES || position >= filled.length - EDGE_LINES;
      const group = groups.get(key) ?? [];
      group.push({ page: p, index, text, atEdge });
      groups.set(key, group);
    });
  });
  for (const group of groups.values()) {
    if (!group.every((o) => o.atEdge) || new Set(group.map((o) => o.page)).size !== group.length) continue;
    if (group.length * 2 < pages.length) continue;
    const identical = group.every((o) => o.text === group[0]!.text);
    const pageNumbered = group.every((o) => (o.text.match(/\d+/g) ?? []).some((n) => Number(n) === o.page + 1));
    if (!identical && !pageNumbered) continue;
    for (const o of group.slice(1)) pages[o.page]![o.index] = { text: "", cut: true };
  }
}

/** A page's lines as text: blank lines beside a cut become one, and the page starts and ends with a line that has text. */
function pageText(page: Line[]): string {
  const out: string[] = [];
  for (let i = 0; i < page.length; ) {
    if (!isBlank(page[i]!)) {
      out.push(page[i]!.text);
      i += 1;
      continue;
    }
    let end = i;
    while (end < page.length && isBlank(page[end]!)) end += 1;
    const cut = page.slice(i, end).some((line) => line.cut);
    if (cut) out.push("");
    else out.push(...page.slice(i, end).map((line) => line.text));
    i = end;
  }
  return out.join("\n").trim();
}

/**
 * The text of a PDF without page markers, manuscript line numbers, and running headers and footers (see the
 * header of this file for what each is, and for what is left alone). The pages that remain are separated by
 * a blank line.
 */
export function cleanPdfText(text: string): string {
  const pages: Line[][] = [[]];
  for (const raw of text.split("\n")) {
    if (PAGE_MARKER.test(raw)) pages.push([]);
    else pages[pages.length - 1]!.push({ text: raw, cut: false });
  }
  // The text ends with the last page's marker: nothing follows it.
  if (pages.length > 1 && pages[pages.length - 1]!.every(isBlank)) pages.pop();

  removeLineNumbers(pages);
  removeRunningLines(pages);
  return pages
    .map(pageText)
    .filter((page) => page !== "")
    .join("\n\n");
}
