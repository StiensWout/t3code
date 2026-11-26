/// <reference lib="dom" />
import { expect } from "e2e";

import { test, WEB } from "./t3.ts";

declare global {
  interface Window {
    heldWorkspaceDefault: Promise<() => Promise<void>>;
  }
}

test(
  "Choosing the current checkout keeps it when the project workspace default arrives",
  WEB,
  async ({ t3, app, browser, screen }) => {
    await t3.project("demo", {
      "t3.json": JSON.stringify({ defaultThreadEnvMode: "worktree" }),
    });
    await browser.addInitScript(() => {
      const hold = Promise.withResolvers<() => Promise<void>>();
      window.heldWorkspaceDefault = hold.promise;
      const send = WebSocket.prototype.send;
      WebSocket.prototype.send = function (data) {
        const request = typeof data === "string" ? JSON.parse(data) : null;
        if (
          request?._tag !== "Request" ||
          request.tag !== "projects.readFile" ||
          request.payload.relativePath !== "t3.json"
        ) {
          return send.call(this, data);
        }
        WebSocket.prototype.send = send;
        hold.resolve(() => {
          const received = Promise.withResolvers<void>();
          const onReply = (event: MessageEvent<string>) => {
            const messages = [JSON.parse(event.data)].flat();
            if (
              !messages.some((reply) => reply._tag === "Exit" && reply.requestId === request.id)
            ) {
              return;
            }
            this.removeEventListener("message", onReply);
            received.resolve();
          };
          this.addEventListener("message", onReply);
          send.call(this, data);
          return received.promise;
        });
      };
    });

    await t3.open();
    const workspace = screen.getByRole("combobox", "Workspace", { exact: true });
    await workspace.getByText("Current checkout").waitFor();
    await workspace.tap();
    await screen.getByRole("option", "Current checkout", { exact: true }).tap();
    await browser.evaluate(async () => {
      const release = await window.heldWorkspaceDefault;
      await release();
      await new Promise<void>((resolve) =>
        requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
      );
      return null;
    });

    await app.screenshot("workspace-after-project-default");
    await expect(workspace).toHaveText("Current checkout");
  },
);
