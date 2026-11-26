/// <reference lib="dom" />
import { expect } from "e2e";

import { test, WEB } from "./t3.ts";

declare global {
  interface Window {
    brokenImageHold: {
      readonly requested: Promise<void>;
      readonly release: () => void;
    };
  }
}

test(
  "Removing a broken image while it prepares lets a send wait for the remaining image",
  WEB,
  async ({ t3, app, browser, screen }) => {
    const project = await t3.project("demo");
    const thread = await t3.thread({ project, title: "Image notes", messages: ["first"] });
    await browser.addInitScript(() => {
      const requested = Promise.withResolvers<void>();
      const released = Promise.withResolvers<void>();
      const slice = File.prototype.slice;
      File.prototype.slice = function (...args) {
        const part = slice.apply(this, args);
        if (this.name !== "broken.heic") return part;
        const read = part.arrayBuffer.bind(part);
        part.arrayBuffer = async () => {
          requested.resolve();
          await released.promise;
          return read();
        };
        return part;
      };
      window.brokenImageHold = { requested: requested.promise, release: released.resolve };
    });
    await t3.open(thread);
    await screen
      .getByText("first fixture turn complete", { exact: false })
      .waitFor({ timeout: 40_000 });
    const composer = screen.getByRole("textbox");
    await composer.fill("Use the remaining screenshot");
    await browser.evaluate(async () => {
      const canvas = new OffscreenCanvas(2200, 20);
      canvas.getContext("2d")!.fillRect(0, 0, 2200, 20);
      const clipboard = new DataTransfer();
      clipboard.items.add(new File(["incomplete image"], "broken.heic", { type: "image/heic" }));
      clipboard.items.add(
        new File([await canvas.convertToBlob({ type: "image/png" })], "good.png", {
          type: "image/png",
        }),
      );
      const editor = document.querySelector('[contenteditable="true"]');
      if (!editor) throw new Error("No composer editor to paste into");
      editor.dispatchEvent(
        new ClipboardEvent("paste", { clipboardData: clipboard, bubbles: true, cancelable: true }),
      );
      await window.brokenImageHold.requested;
      return null;
    });
    await screen.getByRole("button", "Remove broken.heic").tap();
    await composer.press("Enter");

    await browser.evaluate(() => {
      window.brokenImageHold.release();
      return null;
    });
    await browser.locator('button[aria-label="Preview good.png"]:enabled').first().waitFor();

    await app.screenshot("after-remaining-image-finishes");
    await expect(
      browser
        .locator('[data-message-role="user"]')
        .filter({ hasText: "Use the remaining screenshot" }),
    ).toBeVisible();
  },
);
