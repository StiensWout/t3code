/// <reference lib="dom" />
import { expect } from "e2e";

import { test, WEB } from "./t3.ts";

const PREFIX = "实现参考另附 ";
const LABEL = "Agent-Autoloop 仓库";
const URL = "https://github.com/KKKKhazix/agent-autoloop";

test(
  "Pasting rich text preserves its hyperlink in the composer",
  WEB,
  async ({ t3, app, browser, screen }) => {
    const project = await t3.project("demo");
    const thread = await t3.thread({ project, title: "Rich text paste", messages: [] });
    await t3.open(thread);

    const composer = screen.getByRole("textbox");
    await composer.tap();
    await browser.evaluate(
      async ({ plain, html }) => {
        await navigator.clipboard.write([
          new ClipboardItem({
            "text/plain": new Blob([plain], { type: "text/plain" }),
            "text/html": new Blob([html], { type: "text/html" }),
          }),
        ]);
        return null;
      },
      { plain: PREFIX + LABEL, html: `<p>${PREFIX}<a href="${URL}">${LABEL}</a></p>` },
    );
    await browser.keyboard.press("ControlOrMeta+V");

    await app.screenshot("pasted-rich-text");
    await expect(composer).toHaveText(`${PREFIX}[${LABEL}](${URL})`);
  },
);
