/// <reference lib="dom" />
import { expect } from "e2e";

import { test, WEB } from "./t3.ts";

test(
  "Pasting linked text into the composer keeps its URL",
  WEB,
  async ({ t3, app, browser, screen }) => {
    const project = await t3.project("demo");
    const thread = await t3.thread({ project, title: "Reference", messages: ["Start"] });
    await t3.open(thread);

    const composer = screen.getByTestId("composer-editor");
    await composer.tap();
    const url = "https://example.com/project";
    await browser.evaluate(async (url) => {
      await navigator.clipboard.write([
        new ClipboardItem({
          "text/plain": new Blob(["See the project repository"], { type: "text/plain" }),
          "text/html": new Blob([`<p>See the <a href="${url}">project repository</a></p>`], {
            type: "text/html",
          }),
        }),
      ]);
    }, url);
    await browser.keyboard.press("ControlOrMeta+V");

    await app.screenshot("after-paste");
    await expect(composer).toHaveText(`See the [project repository](${url})`);
  },
);
