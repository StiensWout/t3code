/// <reference lib="dom" />
import { expect } from "e2e";

import { test, WEB } from "./t3.ts";

test(
  "A branch created in the previous project does not move the draft back",
  WEB,
  async ({ t3, app, browser, screen }) => {
    await t3.project("first-repository");
    await t3.project("second-repository");

    await browser.addInitScript(() => {
      const send = WebSocket.prototype.send;
      WebSocket.prototype.send = function (data) {
        if (typeof data === "string" && data.includes("vcs.createRef")) {
          const request = JSON.parse(data);
          if (request._tag === "Request" && request.tag === "vcs.createRef") {
            document.documentElement.dataset.scenarioCreateBranch = "pending";
            document.addEventListener(
              "release-create-branch",
              () =>
                this.dispatchEvent(
                  new MessageEvent("message", {
                    data: JSON.stringify({
                      _tag: "Exit",
                      requestId: request.id,
                      exit: { _tag: "Success", value: { refName: request.payload.refName } },
                    }),
                  }),
                ),
              { once: true },
            );
            return;
          }
        }
        return send.call(this, data);
      };
    });

    await browser.setViewport({ width: 1920, height: 1000 });
    await t3.open();
    const project = browser.locator("[data-draft-project-trigger]");
    const selectProject = async (name: string) => {
      await project.tap();
      await screen.getByRole("option", name, { exact: true }).tap();
      await project.getByText(name, { exact: true }).waitFor();
    };
    await selectProject("first-repository");
    await screen.getByTestId("composer-editor").fill("Keep this draft in the next project");

    await browser
      .locator('[data-slot="combobox-trigger"][aria-label^="Branch:"]:visible')
      .first()
      .click();
    await screen.getByPlaceholder("Search refs...").fill("release-notes");
    await screen.getByRole("option", 'Create new ref "release-notes"', { exact: true }).tap();
    await browser.locator("html[data-scenario-create-branch=pending]").waitFor();
    await selectProject("second-repository");

    await browser.evaluate(async () => {
      document.dispatchEvent(new Event("release-create-branch"));
      await new Promise<void>((resolve) =>
        requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
      );
      return null;
    });
    await app.screenshot("draft-project-after-branch-creation");
    await expect(project).toHaveText("second-repository");
  },
);
