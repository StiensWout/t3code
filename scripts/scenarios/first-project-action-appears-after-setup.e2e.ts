/// <reference lib="dom" />
import { expect } from "e2e";
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";

import { test, WEB } from "./t3.ts";

test(
  "Thread Details discovers the first shared action after setup writes it",
  WEB,
  async ({ t3, app, browser, screen }) => {
    const project = await t3.project("demo");
    const thread = await t3.thread({ project, title: "Project setup", messages: ["Start"] });
    await browser.setViewport({ width: 1920, height: 1000 });

    await browser.addInitScript(() => {
      const reads = new Set<string>();
      const watched = new WeakSet<WebSocket>();
      const send = WebSocket.prototype.send;
      WebSocket.prototype.send = function (data) {
        if (typeof data === "string") {
          for (const request of [JSON.parse(data)].flat()) {
            if (
              request?.tag === "projects.readFile" &&
              request.payload?.relativePath === "t3.json"
            ) {
              reads.add(String(request.id));
            }
          }
        }
        if (!watched.has(this)) {
          watched.add(this);
          this.addEventListener("message", (event) => {
            if (typeof event.data !== "string") return;
            for (const response of [JSON.parse(event.data)].flat()) {
              if (response?._tag === "Exit" && reads.has(String(response.requestId))) {
                document.documentElement.dataset.projectConfigRead = "done";
              }
            }
          });
        }
        return send.call(this, data);
      };
    });

    await t3.open(thread);
    const add = screen.getByRole("button", "Add project script", { exact: true });
    await add.waitFor();
    await browser.locator('html[data-project-config-read="done"]').waitFor({ state: "attached" });
    await NodeFSP.writeFile(
      NodePath.join(project, "t3.json"),
      JSON.stringify({ scripts: [{ name: "Shared build", command: "echo build" }] }),
    );

    await add.tap();
    await app.screenshot("first-action-after-setup");
    await expect(screen.getByText("Shared build", { exact: true })).toBeVisible();
  },
);
