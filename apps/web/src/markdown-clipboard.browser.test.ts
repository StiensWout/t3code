import { describe, expect, it } from "vite-plus/test";

import { restoreClipboardLinks } from "./markdown-clipboard";

describe("restoreClipboardLinks", () => {
  it.each([
    {
      name: "uses link positions when the same label also appears as prose",
      plain: "Docs Docs\n\nDocs",
      html: '<p>Docs <a href="https://example.com/one"><b>Docs</b></a></p><p><a href="https://example.com/two">Docs</a></p>',
      expected: "Docs [Docs](https://example.com/one)\n\n[Docs](https://example.com/two)",
    },
    {
      name: "escapes Markdown punctuation and keeps unsupported destinations as text",
      plain: " [Docs] & other ",
      html: '<a href="https://example.com/wiki/(docs)">[Docs]</a> &amp; <a href="/relative">other</a>',
      expected: " [\\[Docs\\]](https://example.com/wiki/\\(docs\\)) & other ",
    },
  ])("$name", ({ plain, html, expected }) => {
    expect(restoreClipboardLinks(plain, html)).toBe(expected);
  });
});
