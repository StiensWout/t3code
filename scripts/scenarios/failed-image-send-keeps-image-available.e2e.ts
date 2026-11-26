/// <reference lib="dom" />
import { expect } from "e2e";

import { pasteWideScreenshot } from "./image-compression-hold.ts";
import { test, WEB } from "./t3.ts";

declare global {
  interface Window {
    imageSendFailure: {
      readonly pending: Promise<void>;
      readonly reject: () => void;
    };
  }
}

test(
  "An image stays available after its send fails while writing a new draft",
  WEB,
  async ({ t3, app, browser, screen }) => {
    const project = await t3.project("demo");
    const thread = await t3.thread({ project, title: "Screenshots", messages: ["first"] });

    await browser.addInitScript(() => {
      const pending = Promise.withResolvers<void>();
      let reject = () => {};
      const send = WebSocket.prototype.send;
      WebSocket.prototype.send = function (data) {
        if (typeof data !== "string" || !data.includes('"type":"message.dispatch"')) {
          return send.call(this, data);
        }
        const parsed = JSON.parse(data);
        const messages = [parsed].flat();
        const isImageSend = (frame: {
          tag?: string;
          payload?: { type?: string; attachments?: unknown[] };
        }) =>
          frame.tag === "orchestration.dispatchCommand" &&
          frame.payload?.type === "message.dispatch" &&
          frame.payload.attachments?.length === 1;
        const request = messages.find(isImageSend);
        if (request === undefined) return send.call(this, data);
        const others = messages.filter((frame) => frame !== request);
        if (others.length > 0) send.call(this, JSON.stringify(others));
        reject = () => {
          this.dispatchEvent(
            new MessageEvent("message", {
              data: JSON.stringify({
                _tag: "Exit",
                requestId: request.id,
                exit: {
                  _tag: "Failure",
                  cause: [
                    {
                      _tag: "Fail",
                      error: {
                        _tag: "OrchestrationV2DispatchCommandError",
                        commandId: request.payload.commandId,
                        commandType: "message.dispatch",
                        message: "The server rejected this send.",
                      },
                    },
                  ],
                },
              }),
            }),
          );
        };
        pending.resolve();
      };
      window.imageSendFailure = { pending: pending.promise, reject: () => reject() };
    });
    await t3.open(thread);
    await screen
      .getByText("first fixture turn complete", { exact: false })
      .waitFor({ timeout: 40_000 });

    const composer = browser.locator('[data-chat-composer-form="true"]').getByRole("textbox");
    await composer.fill("");
    await pasteWideScreenshot(browser);
    await browser
      .locator(
        '[data-chat-composer-form="true"] button[aria-label="Preview screenshot.png"]:enabled',
      )
      .waitFor();
    await composer.press("Enter");
    await browser.evaluate(async () => {
      await window.imageSendFailure.pending;
      return null;
    });

    await composer.fill("Keep this new draft");
    await browser.evaluate(() => {
      window.imageSendFailure.reject();
      return null;
    });
    await screen.getByText("Your new draft was kept.", { exact: true }).waitFor();

    await app.screenshot("after-image-send-fails");
    await expect(screen.getByRole("button", "Preview screenshot.png").first()).toBeVisible();
  },
);
