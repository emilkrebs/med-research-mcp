/**
 * Plain text from the markup databases leave in titles and abstracts.
 *
 * PubMed's efetch XML marks up abstracts with inline elements (`<i>`, `<b>`,
 * `<sup>`, `<sub>`) and numeric character references (`&#xb1;`). Europe PMC's
 * JSON carries HTML in abstracts (`<h4>` section headings, `<p>`, `<sup>`) and
 * in titles, there sometimes escaped (`&lt;i&gt;`), next to an unescaped "<" in
 * the text itself ("p < 0.001").
 *
 * Inline elements keep their text, as in NCBI's own text rendering
 * (A<sub>1c</sub> → A1c), except that a superscript of digits and signs becomes
 * Unicode superscript characters, so that 10<sup>-3</sup> doesn't read as 10-3:
 * 10⁻³, kg⁻¹, ³¹P. A section heading starts a line as "Heading: ", the way
 * PubMed labels the sections of a structured abstract.
 */

const SUPERSCRIPT: Readonly<Record<string, string>> = {
  "0": "⁰",
  "1": "¹",
  "2": "²",
  "3": "³",
  "4": "⁴",
  "5": "⁵",
  "6": "⁶",
  "7": "⁷",
  "8": "⁸",
  "9": "⁹",
  "+": "⁺",
  "-": "⁻",
  "−": "⁻", // minus sign
  "–": "⁻", // en dash, used as a minus
  "=": "⁼",
  "(": "⁽",
  ")": "⁾",
};

const NAMED_ENTITIES: Readonly<Record<string, string>> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " " };

/** Decode numeric character references and the XML entities (plus `&nbsp;`) in one pass; others stay as they are. */
export function decodeEntities(text: string): string {
  return text.replace(/&(?:#x([0-9a-f]+)|#(\d+)|([a-z]+));/gi, (match, hex: string | undefined, dec: string | undefined, name: string | undefined) => {
    if (name) return NAMED_ENTITIES[name.toLowerCase()] ?? match;
    const code = hex ? parseInt(hex, 16) : Number(dec);
    return code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : match;
  });
}

/** Unicode superscript for text of digits and signs only; undefined for anything else. */
function toSuperscript(text: string): string | undefined {
  const chars = [...text.trim()];
  if (chars.length === 0 || !chars.every((c) => SUPERSCRIPT[c])) return undefined;
  return chars.map((c) => SUPERSCRIPT[c]).join("");
}

/**
 * Tags Europe PMC's HTML uses, JATS names included (its preprint abstracts carry `<title>` and `<p>`).
 * Only these are removed, so an unescaped "<" in the text survives. Attributes must have values.
 */
const HTML_TAG =
  /<\/?(?:a|abbr|b|big|bold|br|code|del|div|em|font|h[1-6]|hr|i|ins|italic|li|mark|ol|p|s|sc|small|span|strike|strong|sub|sup|title|tt|u|ul|underline|mml:[a-z]+)(?:\s+[\w:.-]+\s*=\s*(?:"[^"]*"|'[^']*'|[^\s"'<>]+))*\s*\/?>/gi;
const ANY_TAG = /<[^<>]*>/g;
/** Private-use marker for the end of a heading while lines are assembled. */
const HEADING_END = "";

/** Replace each superscript that holds only digits and signs with Unicode superscripts. */
function superscripts(markup: string, tag: RegExp): string {
  return markup.replace(/<sup\b[^<>]*>([\s\S]*?)<\/sup\s*>/gi, (match, inner: string) => toSuperscript(decodeEntities(inner.replace(tag, ""))) ?? inner);
}

/** Collapse whitespace (non-breaking and thin spaces included) within lines; drop empty lines. */
function tidy(text: string): string {
  return text
    .split("\n")
    .map((line) => line.replace(/\s+/g, " ").trim())
    .filter(Boolean)
    .join("\n");
}

/**
 * Text of a well-formed XML fragment, such as the inner XML of a PubMed `AbstractText`:
 * every tag goes (a literal "<" in well-formed XML is always escaped) and the entities
 * are decoded afterwards. Returns one line.
 */
export function xmlToText(xml: string): string {
  return decodeEntities(superscripts(xml, ANY_TAG).replace(ANY_TAG, "")).replace(/\s+/g, " ").trim();
}

/**
 * Text of a title or abstract from Europe PMC: headings become "Heading: " at the start
 * of a line (a lone "Abstract" heading is dropped), paragraphs and line breaks become
 * lines, and markup escaped as `&lt;i&gt;` is removed once decoded.
 */
export function htmlToText(html: string): string {
  const structured = html
    .replace(/<(h[1-6]|title)\b[^<>]*>([\s\S]*?)<\/\1\s*>/gi, (_match, _tag: string, inner: string) => {
      const heading = decodeEntities(inner.replace(HTML_TAG, "")).replace(/\s+/g, " ").trim().replace(/\s*[:.]$/, "");
      // HEADING_END keeps the section's first paragraph on the heading's line.
      return heading && !/^abstract$/i.test(heading) ? `\n${heading}:${HEADING_END}` : "\n";
    })
    .replace(/<(?:br|p|div|li)\b[^<>]*\/?>|<\/(?:p|div|li)\s*>/gi, "\n")
    .replace(new RegExp(`${HEADING_END}\\s*`, "g"), " ");
  const text = decodeEntities(superscripts(structured, HTML_TAG).replace(HTML_TAG, ""));
  return tidy(superscripts(text, HTML_TAG).replace(HTML_TAG, ""));
}
