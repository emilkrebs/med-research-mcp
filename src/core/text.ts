/**
 * Plain text from the markup databases leave in titles and abstracts.
 *
 * PubMed's efetch XML marks up abstracts with inline elements (`<i>`, `<b>`,
 * `<sup>`, `<sub>`) and numeric character references (`&#xb1;`). Europe PMC's
 * JSON carries HTML in abstracts (`<h4>` section headings, `<p>`, `<sup>`, named
 * references such as `&copy;` and `&otimes;`), JATS and MathML, under any namespace
 * prefix (`<ns3:list-item>`, `<mml:mi>`) or none, and in titles, there sometimes
 * escaped (`&lt;i&gt;`), next to an unescaped "<" in the text itself ("p < 0.001",
 * "2.5<t<2.9").
 *
 * Inline elements keep their text, as in NCBI's own text rendering
 * (A<sub>1c</sub> → A1c), except that a superscript of digits and signs becomes
 * Unicode superscript characters, so that 10<sup>-3</sup> doesn't read as 10-3:
 * 10⁻³, kg⁻¹, ³¹P. A section heading starts a line as "Heading: ", the way
 * PubMed labels the sections of a structured abstract.
 */

import { decodeHTMLStrict } from "entities";

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

/**
 * Decode character references, numeric and named, HTML's whole set included (`&plusmn;`, `&copy;`),
 * in one pass. A name without its closing semicolon, or unknown, stays as it is.
 */
export function decodeEntities(text: string): string {
  return decodeHTMLStrict(text);
}

/** Unicode superscript for text of digits and signs only; undefined for anything else. */
function toSuperscript(text: string): string | undefined {
  const chars = [...text.trim()];
  if (chars.length === 0 || !chars.every((c) => SUPERSCRIPT[c])) return undefined;
  return chars.map((c) => SUPERSCRIPT[c]).join("");
}

/** A tag's optional namespace prefix (`mml:`, `jats:`, `ns3:`). */
const PREFIX = String.raw`(?:[a-z][\w.-]*:)?`;
/** Attributes with values, as inline tags must have them: "a<b and c>d" is text. */
const ATTRIBUTES = String.raw`(?:\s+[\w:.-]+\s*=\s*(?:"[^"]*"|'[^']*'|[^\s"'<>]+))*`;
/** Any attributes (`<h4 hidden>`), for block tags and headings, whose names don't start a "<" in the text. */
const ANY_ATTRIBUTES = String.raw`(?:\s[^<>]*?)?`;
/** Opening, closing and empty tags with one of these names; only these are removed, so a "<" in the text survives. */
const tags = (names: string, attributes = ATTRIBUTES): RegExp =>
  new RegExp(String.raw`<\/?${PREFIX}(?:${names})${attributes}\s*\/?>`, "gi");
/** An element with one of these names and its content: the name is $1, the content $2. */
const element = (names: string): RegExp =>
  new RegExp(String.raw`<(${PREFIX}(?:${names}))${ANY_ATTRIBUTES}\s*>([\s\S]*?)<\/\1\s*>`, "gi");

/** Elements that end a line: HTML and JATS (Europe PMC's preprint abstracts) blocks. */
const BLOCK_TAG = tags(
  "br|p|div|li|ul|ol|dl|dt|dd|pre|hr|blockquote|sec|list|list-item|table|table-wrap|thead|tbody|tfoot|tr|caption|fig|" +
    "disp-formula|disp-quote|boxed-text|statement|abstract|break",
  ANY_ATTRIBUTES,
);
/** Table cells: a space between them. */
const CELL_TAG = tags("td|th", ANY_ATTRIBUTES);
/** Inline elements, HTML, JATS and MathML, whose text is kept. */
const INLINE_TAG = tags(
  "a|abbr|b|big|bold|cite|code|del|em|font|i|img|ins|italic|mark|s|sc|small|span|strike|strong|sub|sup|tt|u|underline|" +
    "xref|ext-link|uri|email|named-content|styled-content|monospace|roman|sans-serif|overline|label|inline-formula|" +
    "tex-math|alternatives|graphic|inline-graphic|" +
    "math|mi|mn|mo|ms|mtext|mspace|mrow|mfrac|msqrt|mroot|mstyle|merror|mpadded|mphantom|mfenced|menclose|msub|msup|" +
    "msubsup|munder|mover|munderover|mmultiscripts|mprescripts|mtable|mtr|mtd|mlabeledtr|semantics|annotation|annotation-xml",
);
/** A section heading and its text. */
const HEADING = element("h[1-6]|title");
const SUPERSCRIPT_ELEMENT = element("sup");
/** MathML annotations: another encoding (TeX source) of the formula beside them, dropped with their content. */
const ANNOTATION = element("annotation|annotation-xml");
/** JATS alternative forms of one formula (TeX and MathML): only one is kept. */
const ALTERNATIVES = element("alternatives");
const TEX_MATH = element("tex-math");
const MATHML = new RegExp(String.raw`<${PREFIX}math\b`, "i");
/** The LaTeX document PMC wraps TeX in: `\documentclass…\begin{document}$\alpha$\end{document}`. */
const LATEX_DOCUMENT = /\\documentclass[\s\S]*?\\begin\{document\}([\s\S]*?)\\end\{document\}/g;
/** Entities for white space, which the cleanup of a heading must see before they are decoded. */
const WHITESPACE_ENTITY = /&(?:nbsp|ensp|emsp|thinsp|#160|#x0*a0);/gi;
const ANY_TAG = /<[^<>]*>/g;
/** Private-use marker for the end of a heading while lines are assembled. */
const HEADING_END = "\uE000";

/** Replace each superscript that holds only digits and signs with Unicode superscripts. */
function superscripts(markup: string, tag: RegExp): string {
  return markup.replace(SUPERSCRIPT_ELEMENT, (_match, _sup: string, inner: string) => toSuperscript(decodeEntities(inner.replace(tag, ""))) ?? inner);
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
 * Europe PMC markup without its tags: a formula keeps one of its forms, headings become "Heading: "
 * at the start of a line (a lone "Abstract" heading is dropped), blocks and line breaks become lines,
 * cells are spaced, and other tags go. Entities are left for the caller.
 */
function untag(html: string): string {
  const structured = html
    .replace(ANNOTATION, "")
    .replace(ALTERNATIVES, (_match, _tag: string, inner: string) => (MATHML.test(inner) ? inner.replace(TEX_MATH, "") : inner))
    .replace(LATEX_DOCUMENT, "$1")
    .replace(HEADING, (_match, _tag: string, inner: string) => {
      const heading = inner.replace(INLINE_TAG, "").replace(WHITESPACE_ENTITY, " ").replace(/\s+/g, " ").trim().replace(/\s*[:.]$/, "");
      // HEADING_END keeps the section's first paragraph on the heading's line.
      return heading && !/^abstract$/i.test(heading) ? `\n${heading}:${HEADING_END}` : "\n";
    })
    .replace(BLOCK_TAG, "\n")
    .replace(CELL_TAG, " ")
    .replace(new RegExp(`${HEADING_END}\\s*`, "g"), " ");
  return superscripts(structured, INLINE_TAG).replace(INLINE_TAG, "");
}

/** Text of a title or abstract from Europe PMC (see {@link untag}). */
export function htmlToText(html: string): string {
  // Markup escaped as `&lt;i&gt;` shows only once decoded, and goes the same way.
  return tidy(untag(decodeEntities(untag(html))));
}
