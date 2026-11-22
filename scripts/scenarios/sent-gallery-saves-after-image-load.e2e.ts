/// <reference lib="dom" />
import { expect } from "e2e";

import { test, WEB } from "./t3.ts";

test(
  "An open sent image preview can save after the server image loads",
  WEB,
  async ({ t3, app, browser, screen }) => {
    const project = await t3.project("gallery");
    const thread = await t3.thread({ project, title: "Image preview", messages: ["Start"] });
    const assets = /\/api\/assets\//;
    const release = Promise.withResolvers<void>();
    await browser.route(assets, async (route) => {
      await release.promise;
      await route.continue();
    });

    try {
      await t3.open(thread);
      await screen.getByText("first fixture turn complete", { exact: false }).waitFor();
      const composer = screen.getByRole("textbox");
      await composer.fill("Save this picture");
      await browser.evaluate(async () => {
        const canvas = new OffscreenCanvas(128, 128);
        const context = canvas.getContext("2d")!;
        context.fillStyle = "#ff0000";
        context.fillRect(0, 0, canvas.width, canvas.height);
        const png = await canvas.convertToBlob({ type: "image/png" });
        const clipboardData = new DataTransfer();
        clipboardData.items.add(new File([png], "gallery.png", { type: "image/png" }));
        const editor = document.querySelector('[contenteditable="true"]');
        if (!editor) throw new Error("No composer editor to paste into");
        editor.dispatchEvent(
          new ClipboardEvent("paste", { clipboardData, bubbles: true, cancelable: true }),
        );
        return null;
      });
      await composer.getByRole("button", /Image attachment, gallery\.png/).waitFor();
      await composer.press("Enter");

      await screen.getByRole("button", "Preview gallery.png", { exact: true }).tap();
      const gallery = screen.getByRole("dialog", "Expanded image preview");
      await gallery.getByRole("img", "gallery.png").waitFor();
      release.resolve();

      // Wait for the timeline underneath the dialog to switch to the loaded server copy.
      await browser
        .locator('[data-message-role="user"] img[alt="gallery.png"][src*="/api/assets/"]')
        .waitFor({ state: "attached" });
      await browser.evaluate(() => {
        const image = document.querySelector('[role="dialog"] img[alt="gallery.png"]');
        if (!image) throw new Error("The expanded image is missing");
        image.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true }));
        return null;
      });
      const save = browser.locator("[data-context-menu] button").filter({
        hasText: "Save image",
      });
      await save.waitFor();
      const outcomes = [
        browser
          .waitForDownload(() => save.tap(), { timeout: 10_000 })
          .then((download) => download.suggestedFilename),
        screen
          .getByText("Could not save image", { exact: true })
          .waitFor({ timeout: 12_000 })
          .then(() => "Could not save image"),
      ];

      const result = await Promise.any(outcomes)
        .then(async (outcome) => {
          await app.screenshot("save-from-open-image-preview");
          return outcome;
        })
        .finally(async () => {
          // The runner tracks both steps until they settle.
          await Promise.allSettled(outcomes);
        });
      expect(result).toBe("gallery.png");
    } finally {
      release.resolve();
      await browser.unroute(assets);
    }
  },
);
