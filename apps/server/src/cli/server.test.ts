import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import { vi } from "vite-plus/test";

import * as NodePtyAdapter from "../terminal/NodePtyAdapter.ts";
import { reportStartupDefect } from "./server.ts";

it.effect("renders native startup diagnostics to stderr and sets a non-zero exit code", () =>
  Effect.gen(function* () {
    const previousExitCode = process.exitCode;
    const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    const error = new NodePtyAdapter.NodePtyModuleLoadError({
      platform: "linux",
      architecture: "x64",
      cause: new Error("native binding could not be loaded"),
    });

    try {
      yield* reportStartupDefect(error);

      assert.equal(process.exitCode, 1);
      assert.equal(stderr.mock.calls.length, 1);
      assert.include(String(stderr.mock.calls[0]?.[0] ?? ""), "native binding could not be loaded");
      assert.include(String(stderr.mock.calls[0]?.[0] ?? ""), "reinstall t3");
    } finally {
      stderr.mockRestore();
      process.exitCode = previousExitCode;
    }
  }),
);
