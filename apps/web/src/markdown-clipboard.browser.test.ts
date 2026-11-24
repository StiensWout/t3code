import { describe, expect, it } from "vite-plus/test";

import { restoreClipboardLinks } from "./markdown-clipboard";

describe("restoreClipboardLinks", () => {
  it.each([
    {
      name: "matches repeated text by position and preserves plain-text line breaks",
      plain: "guide\n\nguide and guide",
      html: '<p>guide</p><p><a href="https://example.com/start">guide</a> and <a href="https://example.com/end">guide</a></p>',
      expected: "guide\n\n[guide](https://example.com/start) and [guide](https://example.com/end)",
    },
    {
      name: "escapes Markdown and keeps link labels for unsupported destinations",
      plain: "See 选项 [A] and local",
      html: '<p>See <a data-markdown-copy="wrong" href="https://example.com/a(b)"><b>选项</b> [A]</a> and <a href="/local">local</a></p>',
      expected: "See [选项 \\[A\\]](https://example.com/a\\(b\\)) and local",
    },
  ])("$name", ({ plain, html, expected }) => {
    expect(restoreClipboardLinks(plain, html)).toBe(expected);
  });
});
