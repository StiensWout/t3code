/// <reference lib="dom" />
import { expect } from "e2e";

import { test, WEB } from "./t3.ts";

test(
  "The open stash drops a prompt deleted in another tab",
  WEB,
  async ({ t3, app, browser, screen }) => {
    const project = await t3.project("demo");
    const thread = await t3.thread({ project, title: "Stash check", messages: ["Start"] });
    await t3.open(thread);

    const prompt = "Keep this draft for later";
    await screen.getByRole("textbox").fill(prompt);
    await browser.keyboard.press("ControlOrMeta+s");
    await screen.getByRole("button", "Stashed prompts: 1. Open stash.").tap();

    const removedPrompt = screen.getByRole("button", `Restore stashed prompt: ${prompt}`);
    await removedPrompt.waitFor();

    await browser.evaluate(async () => {
      const key = "t3code:prompt-stash:v2";
      // A separate same-origin document gives the app the browser's real storage event.
      const otherTab = document.createElement("iframe");
      otherTab.hidden = true;
      document.body.append(otherTab);
      try {
        const storage = otherTab.contentWindow?.localStorage;
        if (!storage?.getItem(key)) throw new Error("The composer did not persist the stash.");
        await new Promise<void>((resolve) => {
          const onStorage = (event: StorageEvent) => {
            if (event.key !== key) return;
            window.removeEventListener("storage", onStorage);
            resolve();
          };
          window.addEventListener("storage", onStorage);
          storage.setItem(key, JSON.stringify({ version: 2, state: { entries: [] } }));
        });
      } finally {
        otherTab.remove();
      }
      return null;
    });

    await app.screenshot("stash-after-delete-in-another-tab");
    await expect(removedPrompt).not.toBeVisible();
  },
);
