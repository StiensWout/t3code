/// <reference lib="dom" />
import { expect } from "e2e";

import { test, WEB } from "./t3.ts";

test(
  "Pasting a thread link after a dedented list code block creates a thread chip",
  WEB,
  async ({ t3, app, screen, browser }) => {
    const project = await t3.project("demo");
    const target = await t3.thread({
      project,
      title: "Release checklist",
      messages: ["Start the checklist"],
    });
    const source = await t3.thread({ project, title: "Draft", messages: ["Start"] });
    await t3.open(source);

    const composer = screen.getByRole("textbox");
    await composer.tap();
    await browser.evaluate(async (threadId) => {
      const environmentId = location.pathname.split("/")[1];
      const url = `https://app.t3.codes/threads/${environmentId}/${encodeURIComponent(threadId)}`;
      await navigator.clipboard.writeText(`- \`\`\`sh\n  echo ready\n\n${url}`);
      return null;
    }, target.threadId);
    await browser.keyboard.press("Control+v");

    await app.screenshot("pasted-thread-reference");
    await expect(composer).toContainText("Release checklist");
  },
);
