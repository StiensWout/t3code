import { assert, expect, it } from "@effect/vitest";
import { HostProcessPlatform } from "@t3tools/shared/hostProcess";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";

import * as BunPtyAdapter from "./BunPtyAdapter.ts";

it("describes unavailable Bun PTY operations structurally", () => {
  const error = new BunPtyAdapter.BunPtyOperationUnavailableError({
    operation: "resize",
    pid: 42,
  });

  expect(error).toMatchObject({
    _tag: "BunPtyOperationUnavailableError",
    operation: "resize",
    pid: 42,
  });
  expect(error.message).toBe("Bun PTY resize is unavailable for process 42.");
});

it("replays fast Bun subprocess exits to late listeners asynchronously", async () => {
  const thenKey = ["th", "en"].join("");
  const exited = Object.defineProperty({}, thenKey, {
    value: (onFulfilled: (exitCode: number) => void) => {
      onFulfilled(7);
      return { catch: () => undefined };
    },
  }) as Promise<number>;
  const subprocess = {
    exited,
    kill: () => undefined,
    pid: 123,
    signalCode: 9,
    terminal: {
      resize: () => undefined,
      write: () => undefined,
    },
  } as unknown as Bun.Subprocess;

  const process = new BunPtyAdapter.BunPtyProcess(subprocess);
  const received: Array<{ exitCode: number; signal: number | null }> = [];
  const unsubscribed: Array<{ exitCode: number; signal: number | null }> = [];

  process.onExit((event) => {
    received.push(event);
  });
  const unsubscribe = process.onExit((event) => {
    unsubscribed.push(event);
  });
  unsubscribe();

  expect(received).toEqual([]);
  expect(unsubscribed).toEqual([]);

  await Promise.resolve();

  expect(received).toEqual([{ exitCode: 7, signal: 9 }]);
  expect(unsubscribed).toEqual([]);
});

it.effect("reports unsupported platforms with a structured startup defect", () =>
  Effect.gen(function* () {
    const exit = yield* BunPtyAdapter.make().pipe(
      Effect.provideService(HostProcessPlatform, "win32"),
      Effect.exit,
    );

    expect(Exit.isFailure(exit)).toBe(true);
    if (Exit.isFailure(exit)) {
      expect(Cause.hasDies(exit.cause)).toBe(true);
      const error = Cause.squash(exit.cause);
      assert.instanceOf(error, BunPtyAdapter.BunPtyUnsupportedPlatformError);
      expect(error).toMatchObject({
        _tag: "BunPtyUnsupportedPlatformError",
        platform: "win32",
      });
      expect(error.message).toBe(
        "Bun PTY terminal support is unavailable on win32. Please use Node.js (e.g. by running `npx t3`) instead.",
      );
    }
  }),
);
