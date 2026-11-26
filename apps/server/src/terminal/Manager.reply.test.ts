import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { it } from "@effect/vitest";
import {
  DEFAULT_TERMINAL_ID,
  TERMINAL_BRACKETED_PASTE_END,
  TERMINAL_BRACKETED_PASTE_START,
} from "@t3tools/contracts";
import type { PtyExitEvent, PtyProcess } from "@t3tools/shared/PtyAdapter";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import { expect } from "vite-plus/test";
import * as ProcessRunner from "../processRunner.ts";
import { makeWithOptions } from "./Manager.ts";

const node = Layer.mergeAll(NodeServices.layer, NodeCrypto.layer);
const services = Layer.mergeAll(node, ProcessRunner.layer.pipe(Layer.provide(node)));

it.layer(services)("terminal replies during a paste", (it) => {
  it.effect.each(["stays attached", "detaches", "reattaches"] as const)(
    "delivers one reply when the answering viewer %s after both viewers reply",
    (attachment) =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const logsDir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-terminal-replies-" });
        const writes: Array<string | Buffer> = [];
        const exitListeners = new Set<(event: PtyExitEvent) => void>();
        const pty: PtyProcess = {
          pid: 42,
          write: (data) => {
            writes.push(data);
          },
          resize: () => {},
          kill: () => {
            for (const listener of exitListeners) listener({ exitCode: 0, signal: null });
          },
          onData: () => () => {},
          onExit: (listener) => {
            exitListeners.add(listener);
            return () => {
              exitListeners.delete(listener);
            };
          },
        };
        const manager = yield* makeWithOptions({
          logsDir,
          ptyAdapter: { spawn: () => Effect.succeed(pty) },
          foregroundProcessGroup: (pid) => Effect.succeed(pid),
        });
        const target = { threadId: "thread-1", terminalId: DEFAULT_TERMINAL_ID };
        const attach = (viewerId: string) =>
          Effect.acquireRelease(
            manager.attachStream(
              { ...target, cwd: process.cwd() },
              () => Effect.void,
              undefined,
              viewerId,
            ),
            (detach) => Effect.sync(detach),
          );
        const detachFirst = yield* attach("first");
        yield* attach("second");
        yield* manager.write({ ...target, data: "\x1b[1;1R", reply: true }, "first");

        const start = TERMINAL_BRACKETED_PASTE_START + "partial";
        yield* manager.write({ ...target, data: start, bracketedPaste: "start" }, "second");
        const first = yield* manager
          .write({ ...target, data: "\x1b[2;2R", reply: true }, "first")
          .pipe(Effect.forkScoped({ startImmediately: true }));
        const second = yield* manager
          .write({ ...target, data: "\x1b[3;3R", reply: true }, "second")
          .pipe(Effect.forkScoped({ startImmediately: true }));
        if (attachment !== "stays attached") detachFirst();
        if (attachment === "reattaches") yield* attach("first");

        yield* manager.write(
          { ...target, data: TERMINAL_BRACKETED_PASTE_END, bracketedPaste: "end" },
          "second",
        );
        yield* Fiber.join(first);
        yield* Fiber.join(second);
        expect(writes).toEqual([
          "\x1b[1;1R",
          start,
          TERMINAL_BRACKETED_PASTE_END,
          attachment === "stays attached" ? "\x1b[2;2R" : "\x1b[3;3R",
        ]);
      }),
  );
});
