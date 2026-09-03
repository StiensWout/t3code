/**
 * Short-lived Codex app-server for account-level requests such as rate limits
 * and reset credits. Nothing thread-bound is needed: the process reads the
 * configured Codex home, answers, and exits when the scope closes.
 *
 * @module provider/Layers/codexAccountClient
 */
import { resolveSpawnCommand } from "@t3tools/shared/shell";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";
import * as CodexClient from "effect-codex-app-server/client";
import * as CodexErrors from "effect-codex-app-server/errors";

import { expandHomePath } from "../../pathExpansion.ts";
import { codexAppServerArgs } from "./codexLaunchArgs.ts";

export interface CodexAccountClientOptions {
  readonly binaryPath: string;
  readonly homePath?: string | undefined;
  readonly launchArgs?: string | undefined;
  readonly environment?: NodeJS.ProcessEnv | undefined;
  readonly cwd: string;
}

const FORCE_KILL_AFTER = "2 seconds" as const;

export const withCodexAccountClient = <A, E>(
  options: CodexAccountClientOptions,
  use: (client: CodexClient.CodexAppServerClient["Service"]) => Effect.Effect<A, E>,
) =>
  Effect.scoped(
    Effect.gen(function* () {
      const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
      // `~` is not shell-expanded for spawned env vars; mirror the session runtime.
      const resolvedHomePath = options.homePath ? expandHomePath(options.homePath) : undefined;
      const env = {
        ...options.environment,
        ...(resolvedHomePath ? { CODEX_HOME: resolvedHomePath } : {}),
      };
      const extendEnv = options.environment === undefined;
      const spawnCommand = yield* resolveSpawnCommand(
        options.binaryPath,
        codexAppServerArgs(options.launchArgs),
        { env, extendEnv },
      );
      const child = yield* spawner
        .spawn(
          ChildProcess.make(spawnCommand.command, spawnCommand.args, {
            cwd: options.cwd,
            env,
            extendEnv,
            forceKillAfter: FORCE_KILL_AFTER,
            shell: spawnCommand.shell,
          }),
        )
        .pipe(
          Effect.mapError(
            (cause) =>
              new CodexErrors.CodexAppServerSpawnError({
                command: `${options.binaryPath} app-server`,
                cause,
              }),
          ),
        );
      const clientContext = yield* Layer.build(CodexClient.layerChildProcess(child));
      const client = yield* Effect.service(CodexClient.CodexAppServerClient).pipe(
        Effect.provide(clientContext),
      );
      yield* client.request("initialize", {
        clientInfo: { name: "t3code_desktop", title: "T3 Code Desktop", version: "0.1.0" },
        capabilities: { experimentalApi: true },
      });
      yield* client.notify("initialized", undefined);
      return yield* use(client);
    }),
  );
