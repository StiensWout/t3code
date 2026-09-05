import { createHighlighterCore } from "shiki/core";
import { createOnigurumaEngine } from "shiki/engine/oniguruma";
import type { MarkdownHighlightRequest, MarkdownHighlightResponse } from "./markdownHighlighting";

// Core avoids bundling every grammar into the worker. The renderer supplies
// Pierre's resolved definitions, while WASM tokenization stays in this thread.
let highlighterPromise: ReturnType<typeof createHighlighterCore> | undefined;

self.addEventListener("message", async (event: MessageEvent<MarkdownHighlightRequest>) => {
  const { id, code, language, themeName, resolvedLanguages, resolvedThemes } = event.data;
  let html: string | null = null;
  try {
    const highlighter = await (highlighterPromise ??= createHighlighterCore({
      themes: [],
      langs: [],
      engine: createOnigurumaEngine(import("shiki/wasm")),
    }));
    for (const theme of resolvedThemes ?? []) highlighter.loadThemeSync(theme);
    for (const language of resolvedLanguages ?? []) highlighter.loadLanguageSync(language.data);
    try {
      html = highlighter.codeToHtml(code, { lang: language, theme: themeName });
    } catch {
      html = highlighter.codeToHtml(code, { lang: "text", theme: themeName });
    }
  } catch (cause) {
    console.warn("Markdown highlighting failed", cause);
    // The client replaces a failed worker and retries on a later update.
  }
  self.postMessage({ id, html } satisfies MarkdownHighlightResponse, { transfer: [] });
});
