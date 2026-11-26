/// <reference lib="dom" />
import { expect } from "e2e";

import { run } from "./shell.ts";
import { runPromise, test, WEB } from "./t3.ts";

const PROMPT = "Review the pull request changes";

test(
  "A failed pull request checkout does not launch a thread until the next submit",
  WEB,
  async ({ t3, app, browser, screen }) => {
    const project = await t3.project("demo");
    await runPromise(
      run("git", ["remote", "add", "origin", "https://github.com/example/demo.git"], {
        cwd: project,
      }),
    );
    await browser.addInitScript(() => {
      const send = WebSocket.prototype.send;
      WebSocket.prototype.send = function (data) {
        const request: {
          _tag: string;
          id: string;
          tag: string;
          payload: { cwd: string; initialMessage?: { text: string } };
        } | null = typeof data === "string" ? JSON.parse(data) : null;
        if (request?._tag === "Request" && request.tag === "orchestration.launchThread") {
          const prompt = request.payload.initialMessage?.text;
          if (prompt !== undefined) document.documentElement.dataset.firstLaunchPrompt ??= prompt;
        }
        if (request?._tag !== "Request" || request.tag !== "git.preparePullRequestThread") {
          return send.call(this, data);
        }
        document.documentElement.dataset.checkoutPending = "true";
        window.addEventListener(
          "scenario:fail-checkout",
          () => {
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
                          _tag: "GitManagerError",
                          operation: "preparePullRequestThread",
                          cwd: request.payload.cwd,
                          detail: "The pull request branch could not be fetched.",
                        },
                      },
                    ],
                  },
                }),
              }),
            );
          },
          { once: true },
        );
      };
    });

    await t3.open("/new?pr=example/demo/42");
    await screen.getByRole("button", "Check out", { exact: true }).tap();
    await browser.locator("html[data-checkout-pending=true]").waitFor({ state: "attached" });
    const composer = screen.getByTestId("composer-editor");
    await composer.fill(PROMPT);
    await screen.getByRole("button", "Submit message", { exact: true }).tap();

    await browser.evaluate(() => {
      window.dispatchEvent(new Event("scenario:fail-checkout"));
      return null;
    });
    await screen
      .getByText("Could not prepare the pull request checkout", { exact: true })
      .waitFor();
    await screen.getByRole("button", "Dismiss notification", { exact: true }).tap();
    const retryPrompt = "Review only the local changes";
    await composer.fill(retryPrompt);
    await screen.getByRole("button", "Submit message", { exact: true }).tap();
    await browser.locator("html[data-first-launch-prompt]").waitFor({ state: "attached" });
    await app.screenshot("first-launch-after-checkout-failure");
    await expect(
      await browser.evaluate(() => document.documentElement.dataset.firstLaunchPrompt ?? null),
    ).toBe(retryPrompt);
  },
);
