/// <reference lib="dom" />
// @effect-diagnostics-next-line nodeBuiltinImport:off -- The fixture holds Git's HTTP request open.
import * as NodeHttp from "node:http";
import { expect } from "e2e";

import { test, WEB } from "./t3.ts";

test(
  "A delayed clone leaves the thread opened while waiting in view",
  WEB,
  async ({ t3, app, browser, screen }) => {
    const project = await t3.project("demo");
    const initial = await t3.thread({ project, title: "Initial work", messages: ["Start here"] });
    await t3.thread({ project, title: "Other work", messages: ["Continue here"] });

    const cloneName = "slow-clone-destination";
    const remote = NodeHttp.createServer();
    try {
      await new Promise<void>((resolve) => remote.listen(0, "127.0.0.1", resolve));
      const address = remote.address();
      if (!address || typeof address === "string") throw new Error("No Git fixture port");

      await browser.addInitScript((cloneName) => {
        const listen = WebSocket.prototype.addEventListener;
        WebSocket.prototype.addEventListener = function (
          this: WebSocket,
          type: string,
          listener: EventListenerOrEventListenerObject,
          options?: boolean | AddEventListenerOptions,
        ) {
          if (type !== "message" || typeof listener !== "function") {
            return listen.call(this, type, listener, options);
          }
          return listen.call(
            this,
            type,
            (event: Event) => {
              const { data } = event as MessageEvent;
              const wire = typeof data === "string" ? [JSON.parse(data)].flat() : [];
              const holdsNewProject = wire.some(
                (message) =>
                  message?._tag === "Chunk" &&
                  message.values.some(
                    (item: { kind: string; project?: { title: string } }) =>
                      item.kind === "project.updated" && item.project?.title === cloneName,
                  ),
              );
              if (holdsNewProject) {
                document.documentElement.dataset.scenarioProjectUpdate = "ready";
                document.addEventListener("release-new-project", () => listener.call(this, event), {
                  once: true,
                });
              } else {
                listener.call(this, event);
              }
            },
            options,
          );
        } as typeof WebSocket.prototype.addEventListener;
      }, cloneName);

      await t3.open(initial);
      await screen.getByText("Start here", { exact: true }).waitFor();
      await browser.keyboard.press("Control+k");
      const palette = screen.getByRole("dialog", "Command palette");
      const query = palette.getByRole("combobox");
      await query.fill("> Add project");
      await palette.getByText("Add project", { exact: true }).tap();
      await palette.getByText("Git URL", { exact: true }).tap();
      await query.fill(`http://127.0.0.1:${address.port}/${cloneName}.git`);
      await palette.getByRole("button", "Continue (Enter)").tap();
      await query.fill(`${project}/../${cloneName}`);
      await palette.getByRole("button", /^(Create & )?Clone \(/).tap();
      await palette.waitFor({ state: "hidden" });
      await browser.locator("html[data-scenario-project-update=ready]").waitFor();

      await screen.getByRole("button", /^Other work(?:,|$)/).tap();
      const current = screen.getByText("Continue here", { exact: true });
      await current.waitFor();
      const before = await browser.evaluate(() => location.pathname);
      await browser.evaluate(
        () =>
          new Promise<null>((resolve) => {
            // The UI waits up to three seconds for the project before opening its draft.
            let nextFrame: number;
            const finish = () => {
              cancelAnimationFrame(nextFrame);
              clearTimeout(timeout);
              resolve(null);
            };
            const timeout = window.setTimeout(finish, 4_000);
            const before = location.pathname;
            const watch = () => {
              if (location.pathname !== before) finish();
              else nextFrame = requestAnimationFrame(watch);
            };
            document.dispatchEvent(new Event("release-new-project"));
            nextFrame = requestAnimationFrame(watch);
          }),
      );
      await app.screenshot("thread-after-delayed-clone-project-appears");
      expect((await browser.evaluate(() => location.pathname)) === before).toBe(true);
    } finally {
      remote.close();
      remote.closeAllConnections();
    }
  },
);
