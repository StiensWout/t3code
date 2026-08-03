import * as NodeModule from "node:module";

import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import { HostProcessArchitecture, HostProcessPlatform } from "@t3tools/shared/hostProcess";

import * as PtyAdapter from "./PtyAdapter.ts";

export class NodePtyModuleLoadError extends Schema.TaggedErrorClass<NodePtyModuleLoadError>()(
  "NodePtyModuleLoadError",
  {
    platform: Schema.String,
    architecture: Schema.String,
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return `Failed to load node-pty for ${this.platform}-${this.architecture}.`;
  }

  /**
   * Full, user-facing explanation for the CLI to render on stderr. The
   * adapter keeps the failure typed; process-exit policy belongs to the CLI.
   */
  get diagnostic(): string {
    const causeMessage = this.cause instanceof Error ? this.cause.message : String(this.cause);
    return [
      this.message,
      `Caused by: ${causeMessage}`,
      "",
      "node-pty is the native module that powers t3 terminals. It is compiled (or a",
      "prebuild is unpacked) when t3 is installed, so this usually means the install",
      "could not produce a working binary for this machine:",
      "  - the machine is missing a C/C++ toolchain (macOS: `xcode-select --install`,",
      "    Debian/Ubuntu: `sudo apt-get install -y build-essential python3`), or",
      "  - t3 was installed with a different Node.js version or architecture than the",
      "    one running now.",
      "Fix the toolchain, then reinstall t3 (`npm install -g t3`, or clear the npx",
      "cache with `rm -rf ~/.npm/_npx` and re-run `npx t3`).",
    ].join("\n");
  }
}

type NodePtyModuleLoader = () => Promise<typeof import("node-pty")>;

let ensuredSpawnHelperPath: string | null = null;

const resolveNodePtySpawnHelperPath = Effect.gen(function* () {
  const requireForNodePty = NodeModule.createRequire(import.meta.url);
  const path = yield* Path.Path;
  const fs = yield* FileSystem.FileSystem;
  const platform = yield* HostProcessPlatform;
  const architecture = yield* HostProcessArchitecture;

  const packageJsonPath = requireForNodePty.resolve("node-pty/package.json");
  const packageDir = path.dirname(packageJsonPath);
  const candidates = [
    path.join(packageDir, "build", "Release", "spawn-helper"),
    path.join(packageDir, "build", "Debug", "spawn-helper"),
    path.join(packageDir, "prebuilds", `${platform}-${architecture}`, "spawn-helper"),
  ];

  for (const candidate of candidates) {
    if (yield* fs.exists(candidate)) {
      return candidate;
    }
  }
  return null;
}).pipe(Effect.orElseSucceed(() => null));

/**
 * Whether `mode` grants execute permission to the identified process.
 *
 * `FileSystem.access` cannot test `X_OK`, and checking only `mode & 0o111`
 * treats an owner-only helper as executable for unrelated users. Match the
 * POSIX owner/group/other class against the calling process instead.
 */
export const modeIsExecutableFor = (input: {
  mode: number;
  ownerUid: number | null;
  ownerGid: number | null;
  processUid: number | null;
  processGids: readonly number[];
}): boolean => {
  const anyExecuteBit = (input.mode & 0o111) !== 0;
  // Unknown identity, or root, which can execute a file with any execute bit.
  if (input.processUid === null || input.processUid === 0) return anyExecuteBit;
  if (input.ownerUid !== null && input.ownerUid === input.processUid) {
    return (input.mode & 0o100) !== 0;
  }
  if (input.ownerGid !== null && input.processGids.includes(input.ownerGid)) {
    return (input.mode & 0o010) !== 0;
  }
  return (input.mode & 0o001) !== 0;
};

const currentProcessIdentity = (): {
  processUid: number | null;
  processGids: readonly number[];
} => {
  const processUid = process.getuid?.() ?? null;
  const primaryGid = process.getgid?.() ?? null;
  // getgroups() omits the primary gid on some platforms, so add it explicitly.
  const supplementaryGids = process.getgroups?.() ?? [];
  return {
    processUid,
    processGids: primaryGid === null ? supplementaryGids : [primaryGid, ...supplementaryGids],
  };
};

/** `null` means metadata could not be read, not that the helper is executable. */
const readSpawnHelperExecutable = Effect.fn(function* (helperPath: string) {
  const fs = yield* FileSystem.FileSystem;
  const identity = currentProcessIdentity();
  return yield* fs.stat(helperPath).pipe(
    Effect.map((info) =>
      modeIsExecutableFor({
        mode: info.mode,
        ownerUid: Option.getOrNull(info.uid),
        ownerGid: Option.getOrNull(info.gid),
        ...identity,
      }),
    ),
    Effect.orElseSucceed(() => null),
  );
});

const ensureNodePtySpawnHelperExecutable = Effect.fn(function* () {
  const fs = yield* FileSystem.FileSystem;
  const platform = yield* HostProcessPlatform;
  if (platform === "win32") return;

  // Resolution and chmod can fail transiently. Only cache a successful repair
  // (or a confirmed executable helper) so the next spawn retries after failure.
  const helperPath = yield* resolveNodePtySpawnHelperPath;
  if (!helperPath) return;

  if (ensuredSpawnHelperPath === helperPath) return;

  // Avoid chmod and its warning entirely when the current process can execute
  // the helper. This matters for read-only package stores.
  if ((yield* readSpawnHelperExecutable(helperPath)) === true) {
    ensuredSpawnHelperPath = helperPath;
    return;
  }

  const chmodResult = yield* Effect.result(fs.chmod(helperPath, 0o755));
  if (chmodResult._tag === "Success") {
    ensuredSpawnHelperPath = helperPath;
    return;
  }

  yield* Effect.logWarning("failed to mark node-pty spawn-helper executable", {
    helperPath,
    error: chmodResult.failure,
    remedy: `chmod +x "${helperPath}"`,
  });
});

const causeMentionsPosixSpawnFailure = (cause: unknown): boolean => {
  let current: unknown = cause;
  const seen = new Set<unknown>();
  while (current !== null && current !== undefined && !seen.has(current)) {
    seen.add(current);
    if (typeof current === "string") {
      return current.toLowerCase().includes("posix_spawnp failed");
    }
    if (current instanceof Error) {
      if (current.message.toLowerCase().includes("posix_spawnp failed")) return true;
      current = current.cause;
      continue;
    }
    if (typeof current === "object") {
      const value = current as { readonly message?: unknown; readonly cause?: unknown };
      if (
        typeof value.message === "string" &&
        value.message.toLowerCase().includes("posix_spawnp failed")
      ) {
        return true;
      }
      current = value.cause;
      continue;
    }
    return false;
  }
  return false;
};

/**
 * Turn the low-level node-pty failure into a structured diagnosis only when
 * the helper is known to be the cause. Other platforms and spawn failures stay
 * unchanged.
 */
export const describeSpawnFailure = (input: {
  cause: unknown;
  platform: string;
  helperPath: string | null;
  helperIsExecutable: boolean;
}): unknown => {
  if (input.platform === "win32") return input.cause;
  if (!causeMentionsPosixSpawnFailure(input.cause)) return input.cause;
  if (input.helperPath === null || input.helperIsExecutable) return input.cause;
  return new PtyAdapter.SpawnHelperNotExecutableError({
    helperPath: input.helperPath,
    cause: input.cause,
  });
};

class NodePtyProcess implements PtyAdapter.PtyProcess {
  private readonly process: import("node-pty").IPty;

  constructor(process: import("node-pty").IPty) {
    this.process = process;
  }

  get pid(): number {
    return this.process.pid;
  }

  write(data: string): void {
    this.process.write(data);
  }

  resize(cols: number, rows: number): void {
    this.process.resize(cols, rows);
  }

  kill(signal?: string): void {
    this.process.kill(signal);
  }

  onData(callback: (data: string) => void): () => void {
    const disposable = this.process.onData(callback);
    return () => {
      disposable.dispose();
    };
  }

  onExit(callback: (event: PtyAdapter.PtyExitEvent) => void): () => void {
    const disposable = this.process.onExit((event) => {
      callback({
        exitCode: event.exitCode,
        signal: event.signal ?? null,
      });
    });
    return () => {
      disposable.dispose();
    };
  }
}

export const make = Effect.fn("NodePtyAdapter.make")(function* (
  loadNodePtyModule: NodePtyModuleLoader = () => import("node-pty"),
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const platform = yield* HostProcessPlatform;
  const architecture = yield* HostProcessArchitecture;

  const nodePty = yield* Effect.tryPromise({
    try: loadNodePtyModule,
    catch: (cause) =>
      new NodePtyModuleLoadError({
        platform,
        architecture,
        cause,
      }),
  }).pipe(Effect.orDie);

  const ensureSpawnHelperExecutable = ensureNodePtySpawnHelperExecutable().pipe(
    Effect.provideService(FileSystem.FileSystem, fs),
    Effect.provideService(Path.Path, path),
    Effect.provideService(HostProcessPlatform, platform),
    Effect.provideService(HostProcessArchitecture, architecture),
  );
  const resolveSpawnHelperPath = resolveNodePtySpawnHelperPath.pipe(
    Effect.provideService(FileSystem.FileSystem, fs),
    Effect.provideService(Path.Path, path),
    Effect.provideService(HostProcessPlatform, platform),
    Effect.provideService(HostProcessArchitecture, architecture),
  );
  const spawnHelperIsExecutable = (helperPath: string) =>
    readSpawnHelperExecutable(helperPath).pipe(
      // Unknown metadata must not point users at a chmod that may not help.
      Effect.map((isExecutable) => isExecutable !== false),
      Effect.provideService(FileSystem.FileSystem, fs),
    );

  return PtyAdapter.PtyAdapter.of({
    spawn: Effect.fn("NodePtyAdapter.spawn")(function* (input) {
      yield* ensureSpawnHelperExecutable;
      const attempt = yield* Effect.result(
        Effect.try({
          try: () =>
            nodePty.spawn(input.shell, input.args ?? [], {
              cwd: input.cwd,
              cols: input.cols,
              rows: input.rows,
              env: input.env,
              name: platform === "win32" ? "xterm-color" : "xterm-256color",
            }),
          catch: (cause) =>
            new PtyAdapter.PtySpawnError({
              adapter: "node-pty",
              shell: input.shell,
              cause,
            }),
        }),
      );
      if (attempt._tag === "Success") {
        return new NodePtyProcess(attempt.success);
      }

      const spawnCause = attempt.failure.cause;
      if (platform === "win32" || !causeMentionsPosixSpawnFailure(spawnCause)) {
        return yield* attempt.failure;
      }

      const helperPath = yield* resolveSpawnHelperPath;
      const helperIsExecutable =
        helperPath === null ? true : yield* spawnHelperIsExecutable(helperPath);
      if (helperPath === null || helperIsExecutable) {
        return yield* attempt.failure;
      }
      return yield* new PtyAdapter.PtySpawnError({
        adapter: "node-pty",
        shell: input.shell,
        cause: describeSpawnFailure({
          cause: spawnCause,
          platform,
          helperPath,
          helperIsExecutable,
        }),
      });
    }),
  });
});

export const layer = Layer.effect(PtyAdapter.PtyAdapter, make());
