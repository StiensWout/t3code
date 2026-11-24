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
    {
      name: "retains plain ordered and bulleted list markers",
      plain: "3. Docs\r\n  • More",
      html: '<ol start="3"><li><a href="https://example.com">Docs</a><ul><li><a href="https://example.org">More</a></li></ul></li></ol>',
      expected: "3. [Docs](https://example.com)\r\n  • [More](https://example.org)",
    },
    {
      name: "retains a literal number in a partially copied list",
      plain: "2024. Docs\n2. More",
      html: '<ol><li>2024. <a href="https://example.com">Docs</a></li><li><a href="https://example.org">More</a></li></ol>',
      expected: "2024. [Docs](https://example.com)\n2. [More](https://example.org)",
    },
    {
      name: "keeps a literal bang from turning a restored link into an image",
      plain: "!Docs",
      html: '!<a href="https://example.com">Docs</a>',
      expected: "\\![Docs](https://example.com)",
    },
    {
      name: "keeps a literal backslash from escaping the link opener",
      plain: "\\Docs",
      html: '\\<a href="https://example.com">Docs</a>',
      expected: "\\\\[Docs](https://example.com)",
    },
    {
      name: "ignores document metadata and preserves a destination across a line break",
      plain: "line one\ntwo",
      html: '<html><head><title>Document</title><style>p { color: red }</style></head><body><noscript>Fallback</noscript><script>ignored()</script><a href="https://example.com">line one<br>two</a></body></html>',
      expected: "[line one two](https://example.com)",
    },
  ])("$name", ({ plain, html, expected }) => {
    expect(restoreClipboardLinks(plain, html)).toBe(expected);
  });
});
