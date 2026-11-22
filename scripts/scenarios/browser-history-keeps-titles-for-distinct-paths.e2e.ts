// @effect-diagnostics-next-line nodeBuiltinImport:off - fixture pages for the server's browser.
import * as NodeHttp from "node:http";

import { expect } from "e2e";

import { test, WEB } from "./t3.ts";

test(
  "Browser history keeps distinct titles for URLs with and without a trailing slash",
  WEB,
  async ({ t3, app, browser, screen }) => {
    const server = NodeHttp.createServer((request, response) => {
      const title = request.url === "/notes/" ? "Notes directory" : "Notes document";
      response.writeHead(200, { "content-type": "text/html" });
      response.end(`<!doctype html><title>${title}</title>
<body style="margin:0;height:100vh" onpointerdown="document.title = 'Updated notes document'">
  ${title}
</body>`);
    });
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", resolve);
    });
    try {
      const address = server.address();
      if (address === null || typeof address === "string") throw new Error("No fixture port.");
      const host = `127.0.0.1:${address.port}`;
      const project = await t3.project("demo");
      const reading = await t3.thread({ project, title: "Read notes", messages: ["first"] });
      const history = await t3.thread({ project, title: "Check history", messages: ["second"] });
      await t3.open(reading);

      await screen.getByRole("button", "Toggle right panel").tap();
      await screen.getByRole("button", "Browser B").tap();
      const addressBar = screen.getByRole("textbox", "Search or enter URL");
      await addressBar.fill(`http://${host}/notes`);
      await browser.keyboard.press("Enter");
      await screen.getByText("Notes document", { exact: true }).waitFor();

      await addressBar.fill(`http://${host}/notes/`);
      await browser.keyboard.press("Enter");
      await screen.getByText("Notes directory", { exact: true }).waitFor();

      await screen.getByRole("button", "Back", { exact: true }).tap();
      await screen.getByText("Notes document", { exact: true }).waitFor();
      await browser.locator('canvas:has(~ textarea[aria-label="Browser page"])').tap();
      await screen.getByText("Updated notes document", { exact: true }).waitFor();

      const historyUrl = new URL(await browser.url());
      historyUrl.pathname = historyUrl.pathname.replace(/[^/]+$/, history.threadId);
      await app.open(historyUrl.pathname);
      await screen.getByRole("button", "Toggle right panel").tap();
      await screen.getByRole("button", "Browser B").tap();
      await screen.getByText("Updated notes document", { exact: true }).waitFor();

      await app.screenshot("recently-used-notes");
      const notes = screen
        .getByRole("button", /^Updated notes document/)
        .filter({ hasText: `${host}/notes ·` });
      expect(
        await notes.isVisible(),
        "The updated title belongs to the URL without the trailing slash",
      ).toBe(true);
    } finally {
      server.closeAllConnections();
      await new Promise((resolve) => server.close(resolve));
    }
  },
);
