import { describe, expect, it } from "vitest";
import { decodeEntities, htmlToText, xmlToText } from "../src/core/text";

describe("decodeEntities", () => {
  it("decodes numeric references and the XML entities in one pass", () => {
    expect(decodeEntities("31 &#xb1; 8, g&#183;kg, a &lt; b &amp; c")).toBe("31 ± 8, g·kg, a < b & c");
    expect(decodeEntities("&amp;lt;")).toBe("&lt;");
  });

  it("leaves unknown names and invalid code points as they are", () => {
    expect(decodeEntities("&unknown; &#0; &#x110000;")).toBe("&unknown; &#0; &#x110000;");
  });
});

describe("xmlToText", () => {
  it("keeps inline text and makes numeric superscripts superscript characters", () => {
    expect(xmlToText("10<sup>&#x2212;3</sup> and <sup>31</sup>P, CD4<sup>+</sup>, Ca<sup>2+</sup>")).toBe("10⁻³ and ³¹P, CD4⁺, Ca²⁺");
  });

  it("keeps any other superscript as plain text", () => {
    expect(xmlToText("Ovid<sup>®</sup>, trial<sup>a</sup>, 10<sup>1.5</sup>")).toBe("Ovid®, triala, 101.5");
  });

  it("removes every tag, MathML included, and collapses whitespace", () => {
    expect(xmlToText("<mml:math><mml:mi>x</mml:mi></mml:math>\n  is   <i>x</i>")).toBe("x is x");
  });
});

describe("htmlToText (Europe PMC)", () => {
  it("turns section headings into labeled lines", () => {
    expect(htmlToText("<h4>Background</h4>Semaglutide lowers weight.<h4>Results:</h4>Lean mass fell (p < 0.001).")).toBe(
      "Background: Semaglutide lowers weight.\nResults: Lean mass fell (p < 0.001).",
    );
  });

  it("drops a lone Abstract heading and keeps a following paragraph on a heading's line", () => {
    expect(htmlToText("<title>Abstract</title>  <p>IgA nephropathy is common.</p><title>Methods</title><p>We sequenced.</p>")).toBe(
      "IgA nephropathy is common.\nMethods: We sequenced.",
    );
  });

  it("removes markup, escaped or not, and keeps an unescaped < or > in the text", () => {
    expect(htmlToText("&lt;i&gt;Akkermansia muciniphila&lt;/i&gt; in cardiovascular diseases")).toBe("Akkermansia muciniphila in cardiovascular diseases");
    expect(htmlToText('The <em>Mucin</em> Paradox <span class="x">of</span> CO <sub>2</sub>')).toBe("The Mucin Paradox of CO 2");
    expect(htmlToText("p < 0.001 and > 10% weight loss, I<sup>2</sup> 88%, R<sup>2</sup>")).toBe("p < 0.001 and > 10% weight loss, I² 88%, R²");
    expect(htmlToText("a<b and c>d")).toBe("a<b and c>d");
  });
});
