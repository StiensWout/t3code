import { markdownMath } from "@t3tools/client-runtime/markdown-math";
import { mathjax } from "mathjax-full/js/mathjax.js";
import { TeX } from "mathjax-full/js/input/tex.js";
import { SVG } from "mathjax-full/js/output/svg.js";
import { liteAdaptor } from "mathjax-full/js/adaptors/liteAdaptor.js";
import { AssistiveMmlHandler } from "mathjax-full/js/a11y/assistive-mml.js";
import { RegisterHTMLHandler } from "mathjax-full/js/handlers/html.js";
import "mathjax-full/js/input/tex/ams/AmsConfiguration.js";
import type { NativeMarkdownTextRun } from "./nativeMarkdownText";
import type {
  MarkdownFileContextMenu,
  NativeMarkdownTextStyle,
} from "./SelectableMarkdownText.types";

const adaptor = liteAdaptor();
AssistiveMmlHandler(RegisterHTMLHandler(adaptor));
const tex = new TeX({ packages: ["base", "ams"], maxBuffer: 16_384, maxMacros: 1000 });
const renderer = mathjax.document("", { InputJax: tex, OutputJax: new SVG({ fontCache: "none" }) });
const cache = new Map<string, string | null>();
let cacheSize = 0;

function escapeHtml(text: string): string {
  return text.replace(
    /[&<>"']/g,
    (character) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[character]!,
  );
}

/** Self-contained SVG needs no font downloads, browser typesetter or network access. */
export function nativeMathSvg(source: string): string | null {
  if (cache.has(source)) {
    const cached = cache.get(source) ?? null;
    cache.delete(source);
    cache.set(source, cached);
    return cached;
  }
  const math = markdownMath(source);
  if (!math) return null;
  let svg: string | null = null;
  try {
    renderer.reset();
    tex.reset();
    const node = renderer.convert(math.tex, { display: math.display });
    const output = adaptor.outerHTML(node);
    if (!output.includes('data-mml-node="merror"')) svg = output;
  } catch {
    // Leave unsupported or malformed math as its original source.
  }
  const size = source.length + (svg?.length ?? 0);
  if (size <= 1_000_000) {
    while (cache.size >= 128 || cacheSize + size > 1_000_000) {
      const oldest = cache.entries().next().value;
      if (!oldest) break;
      cacheSize -= oldest[0].length + (oldest[1]?.length ?? 0);
      cache.delete(oldest[0]);
    }
    cache.set(source, svg);
    cacheSize += size;
  }
  return svg;
}

/** Render typed native text runs, never raw Markdown HTML, inside the math text view. */
export function nativeMathRunHtml(
  run: NativeMarkdownTextRun,
  style: NativeMarkdownTextStyle,
  menu?: MarkdownFileContextMenu,
): string {
  if (run.mathSource) {
    const math = markdownMath(run.mathSource);
    const source = escapeHtml(run.mathSource);
    const svg = nativeMathSvg(run.mathSource);
    const equation = `<span class="equation" data-source="${source}">${svg ?? source}</span>`;
    return math?.display
      ? `<span class="display"><span class="actions"><button data-copy="${source}">Copy TeX</button><button data-toggle="source" aria-expanded="false">TeX source</button></span><span class="viewport" tabindex="0" role="region" aria-label="Equation">${equation}</span><span class="source" hidden>${source}</span></span>`
      : run.href
        ? `<a href="${escapeHtml(run.href)}">${equation}</a>`
        : equation;
  }
  const heading = run.role === "heading";
  const fontSize = heading
    ? (style.headingFontSizes?.[(run.headingLevel ?? 1) - 1] ?? style.fontSize * 1.3)
    : style.fontSize;
  const color = run.href
    ? style.linkColor
    : run.code
      ? style.inlineCodeColor
      : heading || run.bold
        ? style.strongColor
        : style.color;
  const css = `color:${color};font-size:${fontSize}px;font-weight:${heading || run.bold ? 700 : 400};font-style:${run.italic ? "italic" : "normal"};font-family:${run.code ? "monospace" : "inherit"};text-decoration:${run.strikethrough ? "line-through" : "none"}`;
  const content = escapeHtml(run.text);
  if (run.href) {
    const href = escapeHtml(run.href);
    const actions = menu
      ? `<button class="file-actions" aria-label="File actions" data-menu="${escapeHtml(JSON.stringify(menu))}" data-href="${href}">⋯</button>`
      : "";
    return `<a style="${escapeHtml(css)}" href="${href}">${content}</a>${actions}`;
  }
  return `<span style="${escapeHtml(css)}">${content}</span>`;
}
