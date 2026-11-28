import { expect } from "e2e";

import { test, WEB } from "./t3.ts";

test(
  "Indented code does not add a folder to a file chip",
  WEB,
  async ({ t3, app, browser, screen }) => {
    const project = await t3.project("demo", {
      "src/index.ts": "export {};",
      "fixtures/index.ts": "export {};",
      "examples/index.ts": "export {};",
    });
    const thread = await t3.thread({
      project,
      title: "File links beside an example",
      messages: [
        "Open [index.ts](src/index.ts).\n\n    [index.ts](fixtures/index.ts)\n    `examples/index.ts`",
      ],
    });
    await t3.open(thread);
    await screen.getByRole("button", /^Agent Open/).tap();

    const chip = browser
      .locator('[data-user-message-body] [data-markdown-copy="[index.ts](src/index.ts)"]')
      .first();
    await chip.waitFor();
    await app.screenshot("file-chip-after-code-example");
    await expect(chip).toHaveText("index.ts");
  },
);
