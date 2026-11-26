/// <reference lib="dom" />
import { expect } from "e2e";

import { test, WEB } from "./t3.ts";

declare global {
  interface Window {
    keptImageRead: { readonly requested: Promise<void>; readonly release: () => void };
  }
}

test(
  "Removing an image that already failed lets the waiting message send with the kept image",
  WEB,
  async ({ t3, browser, screen }) => {
    await browser.addInitScript(() => {
      const requested = Promise.withResolvers<void>();
      const released = Promise.withResolvers<void>();
      const read = File.prototype.arrayBuffer;
      File.prototype.arrayBuffer = async function () {
        if (this.name === "good.png") {
          requested.resolve();
          await released.promise;
        }
        return read.call(this);
      };
      window.keptImageRead = { requested: requested.promise, release: released.resolve };
    });
    const project = await t3.project("demo");
    const thread = await t3.thread({ project, title: "Image notes", messages: ["first"] });
    await t3.open(thread);
    await screen
      .getByText("first fixture turn complete", { exact: false })
      .waitFor({ timeout: 40_000 });

    const composer = screen.getByRole("textbox");
    await composer.fill("Use the remaining screenshot");
    await browser.evaluate(async () => {
      const canvas = new OffscreenCanvas(20, 20);
      canvas.getContext("2d")!.fillRect(0, 0, 20, 20);
      const clipboardData = new DataTransfer();
      clipboardData.items.add(
        new File(["incomplete image"], "broken.heic", { type: "image/heic" }),
      );
      clipboardData.items.add(
        new File([await canvas.convertToBlob({ type: "image/png" })], "good.png", {
          type: "image/png",
        }),
      );
      const editor = document.querySelector('[contenteditable="true"]');
      if (!editor) throw new Error("No composer editor to paste into");
      editor.dispatchEvent(
        new ClipboardEvent("paste", { clipboardData, bubbles: true, cancelable: true }),
      );
      // Intake only reads the second image's bytes after the earlier HEIC has failed.
      await window.keptImageRead.requested;
      return null;
    });

    await screen.getByRole("button", "Remove broken.heic").tap();
    await composer.press("Enter");
    await browser.evaluate(() => {
      window.keptImageRead.release();
      return null;
    });

    await expect(
      browser
        .locator('[data-message-role="user"]:has([aria-label="Preview good.png"])')
        .filter({ hasText: "Use the remaining screenshot" }),
    ).toBeVisible();
  },
);
