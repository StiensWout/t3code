import * as Effect from "effect/Effect";
import { Command, GlobalFlag } from "effect/unstable/cli";

import { ServerConfig, type StartupPresentation } from "../config.ts";
import { runServer } from "../server.ts";
import { type CliServerFlags, resolveServerConfig, sharedServerCommandFlags } from "./config.ts";

/**
 * Startup defects can otherwise be swallowed by headless logging. The CLI owns
 * process-exit policy, so render an adapter-provided diagnosis to stderr and
 * make sure a broken native install cannot exit successfully.
 */
const hasDiagnostic = (defect: unknown): defect is { readonly diagnostic: string } =>
  typeof defect === "object" &&
  defect !== null &&
  typeof (defect as { readonly diagnostic?: unknown }).diagnostic === "string";

export const reportStartupDefect = (defect: unknown) =>
  Effect.sync(() => {
    process.exitCode = 1;
    if (hasDiagnostic(defect)) {
      process.stderr.write(`${defect.diagnostic}\n`);
    }
  });

export const runServerCommand = (
  flags: CliServerFlags,
  options?: {
    readonly startupPresentation?: StartupPresentation;
    readonly forceAutoBootstrapProjectFromCwd?: boolean;
  },
) =>
  Effect.gen(function* () {
    const logLevel = yield* GlobalFlag.LogLevel;
    const config = yield* resolveServerConfig(flags, logLevel, options);
    return yield* runServer.pipe(
      Effect.provideService(ServerConfig, config),
      Effect.tapDefect(reportStartupDefect),
    );
  });

export const startCommand = Command.make("start", { ...sharedServerCommandFlags }).pipe(
  Command.withDescription("Run the T3 Code server."),
  Command.withHandler((flags) => runServerCommand(flags)),
);

export const serveCommand = Command.make("serve", { ...sharedServerCommandFlags }).pipe(
  Command.withDescription(
    "Run the T3 Code server without opening a browser and print headless pairing details.",
  ),
  Command.withHandler((flags) =>
    runServerCommand(flags, {
      startupPresentation: "headless",
      forceAutoBootstrapProjectFromCwd: false,
    }),
  ),
);
