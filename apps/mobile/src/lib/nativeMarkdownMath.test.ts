import { describe, expect, it } from "vite-plus/test";
import { parseNativeMarkdownMath } from "../../modules/t3-markdown-text/src/nativeMarkdownMath";
import {
  nativeMathSvg,
  nativeMathRunHtml,
} from "../../modules/t3-markdown-text/src/nativeMathHtml";
import { nativeMarkdownDocumentRuns } from "../../modules/t3-markdown-text/src/nativeMarkdownText";

describe("native math", () => {
  it("uses shared math recognition and keeps code and currency literal", () => {
    let input = "";
    const source = String.raw`Use \(x_i\), keep ` + "`$code$` and pay $20 or $30.";
    const tree = parseNativeMarkdownMath(source, (markdown) => {
      input = markdown;
      return { type: "paragraph", children: [{ type: "text", content: ":t3-math-0:" }] };
    });
    expect(input).toContain(":t3-math-0:");
    expect(input).toContain("`$code$`");
    expect(input).toContain("$20 or $30");
    expect(nativeMarkdownDocumentRuns(tree)).toEqual([
      { text: String.raw`\(x_i\)`, mathSource: String.raw`\(x_i\)` },
    ]);
  });

  it.each([
    String.raw`$x_i^2+\alpha$`,
    String.raw`\(\frac{a}{b}\)`,
    String.raw`$$\begin{pmatrix}1&2\\3&4\end{pmatrix}$$`,
    String.raw`\[\begin{aligned}x&=1\\y&=2\end{aligned}\]`,
  ])("produces a self-contained equation for %s", (source) => {
    const svg = nativeMathSvg(source);
    expect(svg).toContain("<svg");
    expect(svg).toContain("<path");
    expect(svg).not.toContain("<use");
    expect(svg).not.toContain("merror");
    expect(svg).toContain("<math");
  });

  it("falls back for malformed expressions and isolates macros", () => {
    expect(nativeMathSvg(String.raw`$\frac{$`)).toBeNull();
    nativeMathSvg(String.raw`$\gdef\privateMacro{x}\privateMacro$`);
    expect(nativeMathSvg(String.raw`$\privateMacro$`)).toBeNull();
  });

  it("keeps original TeX in the selection-copy contract", () => {
    const source = String.raw`\[x < y\]`;
    const html = nativeMathRunHtml(
      { text: source, mathSource: source },
      {
        color: "#fff",
        strongColor: "#fff",
        mutedColor: "#aaa",
        linkColor: "#acf",
        inlineCodeColor: "#fff",
        codeColor: "#fff",
        codeBackgroundColor: "#111",
        codeBlockBackgroundColor: "#111",
        fileTextColor: "#fff",
        skillTextColor: "#fff",
        quoteMarkerColor: "#888",
        dividerColor: "#444",
        fontSize: 15,
        lineHeight: 22,
        fontFamily: "system-ui",
        headingFontFamily: "system-ui",
        boldFontFamily: "system-ui",
      },
    );
    expect(html).toContain('data-source="\\[x &lt; y\\]"');
    expect(html).toContain('data-copy="\\[x &lt; y\\]"');
  });
});
