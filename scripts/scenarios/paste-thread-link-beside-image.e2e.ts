/// <reference lib="dom" />
import { expect } from "e2e";

import { test, WEB } from "./t3.ts";

test(
  "A pasted image stays beside a restored thread link",
  WEB,
  async ({ t3, app, browser, screen }) => {
    const project = await t3.project("demo");
    const target = await t3.thread({ project, title: "Linked thread", messages: [] });
    const thread = await t3.thread({ project, title: "Paste here", messages: [] });
    await t3.open(thread);

    const composer = screen.getByRole("textbox");
    await composer.tap();
    await browser.evaluate(async (threadId) => {
      const environmentId = location.pathname.split("/")[1];
      const canvas = new OffscreenCanvas(1, 1);
      canvas.getContext("2d")?.fillRect(0, 0, 1, 1);
      const png = await canvas.convertToBlob({ type: "image/png" });
      const data = new DataTransfer();
      data.items.add(new File([png], "image.png", { type: "image/png" }));
      data.setData("text/plain", "Copied title");
      data.setData(
        "text/html",
        `<p><img src="cid:clipboard"><a href="https://app.t3.codes/threads/${environmentId}/${encodeURIComponent(threadId)}">Copied title</a></p>`,
      );
      const editor = document.querySelector('[contenteditable="true"]');
      if (!editor) throw new Error("No composer editor");
      return editor.dispatchEvent(
        new ClipboardEvent("paste", { clipboardData: data, bubbles: true, cancelable: true }),
      );
    }, target.threadId);

    await app.screenshot("pasted-thread-link-and-image");
    await expect(screen.getByRole("button", "Preview image.png")).toHaveCount(1);
    await expect(composer.getByText("Linked thread")).toBeVisible();
  },
);
