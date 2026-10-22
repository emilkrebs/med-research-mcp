import { describe, expect, it } from "vitest";
import { decodeEntities, htmlToText, xmlToText } from "../src/core/text";

describe("decodeEntities", () => {
  it("decodes numeric references and the XML entities in one pass", () => {
    expect(decodeEntities("31 &#xb1; 8, g&#183;kg, a &lt; b &amp; c")).toBe("31 ± 8, g·kg, a < b & c");
    expect(decodeEntities("&amp;lt;")).toBe("&lt;");
  });

  it("decodes HTML's named references, as Europe PMC records carry them (42885740, 42793933)", () => {
    expect(decodeEntities("Copyright: &copy; 2026; Sym2(W)&otimes;W&oplus;S, &plusmn; &ge; &micro;g, &Delta;, &rsquo;")).toBe(
      "Copyright: © 2026; Sym2(W)⊗W⊕S, ± ≥ µg, Δ, ’",
    );
  });

  it("leaves unknown names and a name without its semicolon as they are; an invalid code point becomes U+FFFD", () => {
    expect(decodeEntities("&unknown; MC&S; AT&T &copy 2026 &#0; &#x110000;")).toBe("&unknown; MC&S; AT&T &copy 2026 \uFFFD \uFFFD");
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
    // PMC10434578, 41330469, PPR1337432 (escaped)
    expect(htmlToText("(2.5<t<2.9, p<.05), (-0.35<r<-0.01), u<sub>1</sub><u<sub>2</sub>, 0&lt;s\\le 1")).toBe(
      "(2.5<t<2.9, p<.05), (-0.35<r<-0.01), u1<u2, 0<s\\le 1",
    );
  });

  it("decodes named references in titles and abstracts", () => {
    expect(htmlToText("Copyright: &copy; 2026 El-Deiry et al.")).toBe("Copyright: © 2026 El-Deiry et al.");
  });

  it("gives escaped line breaks, paragraphs and headings the lines unescaped ones get", () => {
    expect(htmlToText("Line one&lt;br&gt;line two")).toBe("Line one\nline two");
    expect(htmlToText("&lt;p&gt;Para one.&lt;/p&gt;&lt;p&gt;Para two.&lt;/p&gt;")).toBe("Para one.\nPara two.");
    expect(htmlToText("&lt;h4&gt;Background&lt;/h4&gt;Text.&lt;h4&gt;Methods&lt;/h4&gt;We did.")).toBe("Background: Text.\nMethods: We did.");
  });

  it("removes JATS tags under any namespace prefix, and keeps their text", () => {
    expect(htmlToText("<sec><title>Background</title><p>Text.</p></sec>")).toBe("Background: Text.");
    expect(htmlToText('<inline-formula><tex-math>x^2</tex-math></inline-formula> is <xref ref-type="bibr" rid="B1">1</xref>')).toBe("x^2 is 1");
    // PPR1310247
    expect(htmlToText('Results <ns3:list list-type="bullet"> <ns3:list-item> 1. Static. <ns3:list-item> 2. Lapse.')).toBe(
      "Results\n1. Static.\n2. Lapse.",
    );
    expect(htmlToText("<jats:p>See <jats:ext-link xlink:href=\"https://x.example\">x.example</jats:ext-link>.</jats:p>")).toBe("See x.example.");
    expect(htmlToText("<table><tr><td>Dose</td><td>10 mg</td></tr><tr><td>n</td><td>40</td></tr></table>")).toBe("Dose 10 mg\nn 40");
  });

  it("removes MathML with a prefix or without one, escaped or not", () => {
    // 40443200
    expect(htmlToText('(coeffs: a<math display="inline" altimg="urn:x-wiley:07360266" xmlns="http://www.w3.org/1998/Math/MathML" wiley:location="equation/m1.png"><mrow><mi>a</mi></mrow></math> = 2.22)')).toBe("(coeffs: aa = 2.22)");
    // 42858305
    expect(htmlToText('<mml:math id="m1" xmlns:mml="http://www.w3.org/1998/Math/MathML"><mml:mrow><mml:msub><mml:mi>O</mml:mi><mml:mn>2</mml:mn></mml:msub></mml:mrow></mml:math> plateau')).toBe("O2 plateau");
    // 40726464 (a title)
    expect(htmlToText('Infants &lt;math display="inline" xmlns="http://www.w3.org/1998/Math/MathML"&gt;&lt;mrow&gt;&lt;mo&gt;~&lt;/mo&gt;&lt;/mrow&gt;&lt;/math&gt; 5 kg')).toBe("Infants ~ 5 kg");
  });
});
