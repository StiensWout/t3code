/// <reference lib="dom" />
import { DEFAULT_TERMINAL_ID, ThreadId } from "@t3tools/contracts";
import { expect } from "e2e";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";

import { T3_HOME } from "../e2e.config.ts";
import { rpcClient, runPromise, test, WEB } from "./t3.ts";

declare global {
  interface Window {
    pasteRecoveryFailed: Promise<void>;
  }
}

test(
  "Hiding a terminal after an interrupted paste frees its shared grid",
  WEB,
  async ({ t3, app, browser, screen }) => {
    const cwd = await t3.project("demo", {
      "paste-probe.mjs": [
        "process.stdin.setRawMode(true);",
        "process.stdin.resume();",
        'process.stdout.write("\\x1b[?2004hPASTE_PROBE_READY\\r\\n");',
      ].join("\n"),
    });
    const thread = await t3.thread({ project: cwd, title: "Shared terminal", messages: ["Start"] });
    const target = { threadId: ThreadId.make(thread.threadId), terminalId: DEFAULT_TERMINAL_ID };
    const origin = app.baseUrl ?? "";
    const wideCols = 240;
    await browser.setViewport({ width: 1100, height: 800 });
    await browser.emulateMedia({ reducedMotion: "reduce" });
    await browser.addInitScript(() => {
      const recovery = Promise.withResolvers<void>();
      window.pasteRecoveryFailed = recovery.promise;
      const send = WebSocket.prototype.send;
      WebSocket.prototype.send = function (data) {
        const frame = typeof data === "string" ? JSON.parse(data) : null;
        const marker = "\x1b[201~";
        if (frame?.tag !== "terminal.write" || !frame.payload?.data?.endsWith(marker)) {
          return send.call(this, data);
        }
        // The opening chunk reaches the process. Fail the final chunk and the one recovery write.
        queueMicrotask(() => {
          this.dispatchEvent(
            new MessageEvent("message", {
              data: JSON.stringify({
                _tag: "Exit",
                requestId: frame.id,
                exit: { _tag: "Failure", cause: [{ _tag: "Interrupt", fiberId: 1 }] },
              }),
            }),
          );
          if (frame.payload.data === marker) recovery.resolve();
        });
      };
    });
    await runPromise(
      Effect.gen(function* () {
        const client = yield* rpcClient(T3_HOME, origin);
        yield* client["terminal.open"]({ ...target, cwd, cols: wideCols, rows: 60 });
        yield* client["terminal.write"]({
          ...target,
          data: `'${process.execPath}' paste-probe.mjs\r`,
        });
      }).pipe(Effect.scoped),
    );
    await t3.open(thread);
    const toggle = screen.getByRole("button", "Toggle terminal drawer");
    await toggle.tap();
    const terminal = screen.getByLabel("Terminal input");
    await terminal.focus();

    const readSnapshot = (cols?: number) =>
      runPromise(
        Effect.gen(function* () {
          const client = yield* rpcClient(T3_HOME, origin);
          const events =
            cols === undefined
              ? client["terminal.observe"](target)
              : client["terminal.attach"]({ ...target, cols, rows: 60 });
          const first = Option.getOrThrow(yield* Stream.runHead(events));
          if (first.type !== "snapshot" || first.snapshot === null)
            throw new Error("No terminal snapshot");
          return first.snapshot;
        }).pipe(Effect.scoped),
      );
    // Wait until the real PTY has enabled bracketed paste and the narrow view has reported its size.
    await expect
      .poll(async () => {
        const snapshot = await readSnapshot();
        const cols = snapshot.cols ?? wideCols;
        return snapshot.history.includes("PASTE_PROBE_READY") && cols < wideCols;
      })
      .toBe(true);
    await browser.evaluate((text) => {
      const clipboardData = new DataTransfer();
      clipboardData.setData("text/plain", text);
      document
        .querySelector('[aria-label="Terminal input"]')
        ?.dispatchEvent(
          new ClipboardEvent("paste", { clipboardData, bubbles: true, cancelable: true }),
        );
    }, "paste payload\n".repeat(5_000));
    await browser.evaluate(() => window.pasteRecoveryFailed);

    await toggle.tap();
    await terminal.waitFor({ state: "hidden" });
    await app.screenshot("terminal-drawer-hidden-after-interrupted-paste");

    // A new, wider client sees the PTY itself, including any constraint from the hidden client.
    await expect.poll(async () => (await readSnapshot(wideCols)).cols).toBe(wideCols);
  },
);
