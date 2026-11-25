import * as NodeServices from "@effect/platform-node/NodeServices";
import { it as effectIt } from "@effect/vitest";
import * as HostProcess from "@t3tools/shared/HostProcess";
import { CommandAvailability, WindowsShellEnvironment } from "@t3tools/shared/shell";
import * as Effect from "effect/Effect";
// @effect-diagnostics-next-line nodeBuiltinImport:off -- Observe the existing synchronous shell probe without launching the user's login shell.
import * as NodeChildProcess from "node:child_process";
import * as NodeOS from "node:os";
import * as FileSystem from "effect/FileSystem";
import { assert, expect, it, vi } from "vite-plus/test";

import {
  fixPath,
  hydratePosixHome,
  refreshPathFromLoginShell,
  refreshWindowsPath,
} from "./os-jank.ts";

vi.mock("node:child_process", { spy: true });
vi.mock("node:os", { spy: true });

it("hydrates HOME independently of a blank process HOME", () => {
  const originalHome = process.env.HOME;
  const env: NodeJS.ProcessEnv = { HOME: " " };

  try {
    process.env.HOME = " ";
    hydratePosixHome(env);
  } finally {
    if (originalHome === undefined) {
      delete process.env.HOME;
    } else {
      process.env.HOME = originalHome;
    }
  }

  assert.equal(env.HOME, NodeOS.userInfo().homedir);
});

it("preserves an explicitly configured HOME", () => {
  const env: NodeJS.ProcessEnv = { HOME: "/custom/home" };

  hydratePosixHome(env, () => {
    throw new Error("HOME lookup should not run");
  });

  assert.equal(env.HOME, "/custom/home");
});

effectIt.effect("hydrates PATH when the desktop handoff is absent", () =>
  Effect.acquireUseRelease(
    Effect.sync(() =>
      vi
        .spyOn(NodeChildProcess, "execFileSync")
        .mockReturnValue("__T3CODE_ENV_PATH_START__\n/opt/tools/bin\n__T3CODE_ENV_PATH_END__\n"),
    ),
    (probe) =>
      Effect.gen(function* () {
        const env: NodeJS.ProcessEnv = { SHELL: "/bin/bash", PATH: "/usr/bin" };

        yield* fixPath().pipe(
          Effect.provideService(HostProcess.Platform, "linux"),
          Effect.provideService(HostProcess.Environment, env),
          Effect.provide(NodeServices.layer),
        );

        assert.equal(probe.mock.calls.length, 1);
        assert.equal(env.PATH, "/opt/tools/bin:/usr/bin");
      }),
    (probe) => Effect.sync(() => probe.mockRestore()),
  ),
);

const timedOut = (file: string) =>
  Object.assign(new Error(`spawnSync ${file} ETIMEDOUT`), { code: "ETIMEDOUT" });

effectIt.effect("waits longer for a login shell that times out at startup", () =>
  Effect.acquireUseRelease(
    Effect.sync(() =>
      vi.spyOn(NodeChildProcess, "execFileSync").mockImplementation((file, _args, options) => {
        // This profile takes 8 seconds while the machine is under load.
        if ((options?.timeout ?? 0) < 8_000) throw timedOut(String(file));
        return "__T3CODE_ENV_PATH_START__\n/opt/tools/bin\n__T3CODE_ENV_PATH_END__\n";
      }),
    ),
    () =>
      Effect.gen(function* () {
        const env: NodeJS.ProcessEnv = { SHELL: "/bin/zsh", PATH: "/usr/bin" };

        yield* fixPath().pipe(
          Effect.provideService(HostProcess.Platform, "linux"),
          Effect.provideService(HostProcess.Environment, env),
          Effect.provide(NodeServices.layer),
        );

        assert.equal(env.PATH, "/opt/tools/bin:/usr/bin");
      }),
    (probe) => Effect.sync(() => probe.mockRestore()),
  ),
);

effectIt.effect("waits longer for only one hung login shell", () =>
  Effect.acquireUseRelease(
    Effect.sync(() =>
      vi.spyOn(NodeChildProcess, "execFileSync").mockImplementation((file) => {
        throw timedOut(String(file));
      }),
    ),
    (probe) =>
      Effect.gen(function* () {
        const env: NodeJS.ProcessEnv = { SHELL: "/bin/zsh", PATH: "/usr/bin" };

        yield* fixPath().pipe(
          Effect.provideService(HostProcess.Platform, "linux"),
          Effect.provideService(HostProcess.Environment, env),
          Effect.provide(NodeServices.layer),
        );

        const timeouts = probe.mock.calls.map(([, , options]) => options?.timeout);
        assert.equal(timeouts.filter((timeout) => (timeout ?? 0) > 5_000).length, 1);
        assert.equal(env.PATH, "/usr/bin");
      }),
    (probe) => Effect.sync(() => probe.mockRestore()),
  ),
);

effectIt.effect("keeps mise's PATH record with the login shell PATH", () =>
  Effect.acquireUseRelease(
    Effect.sync(() =>
      vi
        .spyOn(NodeChildProcess, "execFileSync")
        .mockReturnValue(
          [
            "__T3CODE_ENV_PATH_START__",
            "/home/me/.local/bin:/mise/installs/claude/latest:/mise/shims",
            "__T3CODE_ENV_PATH_END__",
            "__T3CODE_ENV___MISE_DIFF_START__",
            "mise-diff",
            "__T3CODE_ENV___MISE_DIFF_END__",
          ].join("\n"),
        ),
    ),
    () =>
      Effect.gen(function* () {
        const env: NodeJS.ProcessEnv = { SHELL: "/bin/bash", PATH: "/usr/bin" };

        yield* fixPath().pipe(
          Effect.provideService(HostProcess.Platform, "linux"),
          Effect.provideService(HostProcess.Environment, env),
          Effect.provide(NodeServices.layer),
        );

        assert.equal(env.__MISE_DIFF, "mise-diff");
      }),
    (probe) => Effect.sync(() => probe.mockRestore()),
  ),
);

effectIt.effect(
  "hydrates missing JAVA_HOME and feature flags from the login shell and keeps explicit ones",
  () =>
    Effect.acquireUseRelease(
      Effect.sync(() =>
        vi
          .spyOn(NodeChildProcess, "execFileSync")
          .mockReturnValue(
            [
              "__T3CODE_ENV_PATH_START__",
              "/opt/homebrew/bin",
              "__T3CODE_ENV_PATH_END__",
              "__T3CODE_ENV_JAVA_HOME_START__",
              "/opt/homebrew/opt/openjdk@17",
              "__T3CODE_ENV_JAVA_HOME_END__",
              "__T3CODE_ENV_T3CODE_FEATURE_FLAGS_START__",
              "tanstack_source",
              "__T3CODE_ENV_T3CODE_FEATURE_FLAGS_END__",
            ].join("\n"),
          ),
      ),
      () =>
        Effect.gen(function* () {
          const missing: NodeJS.ProcessEnv = { SHELL: "/bin/zsh", PATH: "/usr/bin" };
          const explicit: NodeJS.ProcessEnv = {
            SHELL: "/bin/zsh",
            PATH: "/usr/bin",
            JAVA_HOME: "/custom/jdk",
            T3CODE_FEATURE_FLAGS: "",
          };

          for (const env of [missing, explicit]) {
            yield* fixPath().pipe(
              Effect.provideService(HostProcess.Platform, "darwin"),
              Effect.provideService(HostProcess.Environment, env),
              Effect.provide(NodeServices.layer),
            );
          }

          assert.equal(missing.JAVA_HOME, "/opt/homebrew/opt/openjdk@17");
          assert.equal(explicit.JAVA_HOME, "/custom/jdk");
          assert.equal(missing.T3CODE_FEATURE_FLAGS, "tanstack_source");
          assert.equal(explicit.T3CODE_FEATURE_FLAGS, "");
        }),
      (probe) => Effect.sync(() => probe.mockRestore()),
    ),
);

effectIt.effect("replaces a Path-spelled Windows PATH instead of adding a second key", () =>
  Effect.gen(function* () {
    const env: NodeJS.ProcessEnv = { Path: "C:\\Windows" };

    yield* fixPath().pipe(
      Effect.provideService(HostProcess.Platform, "win32"),
      Effect.provideService(HostProcess.Environment, env),
      Effect.provideService(WindowsShellEnvironment, () => Effect.succeed({ PATH: "C:\\Tools" })),
      Effect.provideService(CommandAvailability, () => Effect.succeed(true)),
      Effect.provide(NodeServices.layer),
    );

    assert.deepEqual(env, { PATH: "C:\\Tools;C:\\Windows" });
  }),
);

effectIt.effect("adds a directory an installer wrote to the registry after launch", () =>
  Effect.gen(function* () {
    const env: NodeJS.ProcessEnv = { Path: "C:\\Tools;C:\\Windows" };
    const installed = "C:\\Users\\me\\AppData\\Local\\cursor-agent";

    yield* refreshWindowsPath().pipe(
      Effect.provideService(HostProcess.Platform, "win32"),
      Effect.provideService(HostProcess.Environment, env),
      Effect.provideService(WindowsShellEnvironment, () =>
        Effect.succeed({ PATH: `C:\\Windows;${installed}` }),
      ),
    );

    assert.deepEqual(env, { PATH: `C:\\Tools;C:\\Windows;${installed}` });
  }),
);

effectIt.live("refreshes PATH from the account login shell when inherited SHELL is gone", () =>
  Effect.gen(function* () {
    if (process.platform === "win32") return;
    const fs = yield* FileSystem.FileSystem;
    const dir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-account-login-shell-" });
    const shell = `${dir}/sh`;
    const writeProfile = (path: string) =>
      fs.writeFileString(shell, `#!/bin/sh\nPATH="${path}" exec /bin/sh -c "$2"\n`);
    yield* writeProfile("/opt/original/bin:/usr/bin");
    yield* fs.chmod(shell, 0o755);
    const userInfo = NodeOS.userInfo();
    yield* Effect.acquireRelease(
      Effect.sync(() => vi.spyOn(NodeOS, "userInfo").mockReturnValue({ ...userInfo, shell })),
      (mock) => Effect.sync(() => mock.mockRestore()),
    );

    const env: NodeJS.ProcessEnv = { SHELL: `${dir}/removed-shell`, PATH: "/usr/bin" };
    yield* Effect.gen(function* () {
      yield* fixPath();
      expect(env.PATH).toBe("/opt/original/bin:/usr/bin");
      yield* writeProfile("/opt/pi/bin:/opt/original/bin:/usr/bin");
      yield* refreshPathFromLoginShell();
      expect(env.PATH).toBe("/opt/pi/bin:/opt/original/bin:/usr/bin");
    }).pipe(
      Effect.provideService(HostProcess.Platform, "linux"),
      Effect.provideService(HostProcess.Environment, env),
    );
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);
