import { expect } from "e2e";

import { test, WEB } from "./t3.ts";

test(
  "File links with the same name keep their folder labels when one has a parenthesized title",
  WEB,
  async ({ t3, app, screen, browser }) => {
    const project = await t3.project("demo", {
      "client/notes.ts": "// Client notes\n",
      "server/notes.ts": "// Server notes\n",
    });
    const thread = await t3.thread({
      project,
      title: "Compare notes",
      messages: [
        "See [client/notes.ts](client/notes.ts (Client notes)) and [server/notes.ts](server/notes.ts).",
      ],
    });
    await t3.open(thread);
    await screen.getByRole("button", /^Agent See/).tap();
    const message = browser.locator("[data-user-message-body]");
    await message
      .getByRole("link", /^notes\.ts/)
      .first()
      .waitFor();

    await app.screenshot("same-file-names");
    await expect(message.getByRole("link", /notes\.ts.*client/)).toBeVisible();
  },
);
