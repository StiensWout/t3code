import * as NodeServices from "@effect/platform-node/NodeServices";
import { it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Queue from "effect/Queue";
import * as TestClock from "effect/testing/TestClock";
import { expect } from "vite-plus/test";

import { makePiRpcConnection } from "./rpc.ts";

const piWithWorker = `
const { spawn } = require("node:child_process");
const worker = spawn(process.execPath, ["-e", \`
  process.on("SIGTERM", () => {});
  process.stdout.write("ready");
  setInterval(() => {}, 60_000);
\`], { stdio: ["ignore", "pipe", "ignore"] });
process.on("SIGTERM", () => process.exit(0));
worker.stdout.once("data", () => {
  process.stdout.write(JSON.stringify({ type: "ready", workerPid: worker.pid }) + "\\n");
});
`;

it.effect.skipIf(process.platform === "win32")(
  "stops a Pi extension worker that outlives the Pi process",
  () =>
    Effect.gen(function* () {
      let workerPid: number | undefined;
      const scope = Effect.gen(function* () {
        const connection = yield* makePiRpcConnection({
          command: process.execPath,
          args: ["-e", piWithWorker],
          cwd: undefined,
          env: {},
        });
        const ready = yield* Queue.take(connection.events);
        if (typeof ready["workerPid"] !== "number") throw new Error("Worker failed to start");
        workerPid = ready["workerPid"];

        const terminating = yield* connection.terminate.pipe(
          Effect.forkScoped({ startImmediately: true }),
        );
        yield* connection.exited;
        yield* TestClock.adjust("1 second");
        yield* Fiber.join(terminating);
      }).pipe(Effect.scoped);
      yield* scope.pipe(
        Effect.andThen(
          Effect.sync(() => {
            if (workerPid === undefined) throw new Error("Missing worker PID");
            let workerAlive = true;
            try {
              process.kill(workerPid, 0);
            } catch (error) {
              if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
              workerAlive = false;
            }
            expect(workerAlive).toBe(false);
          }),
        ),
        Effect.ensuring(
          Effect.sync(() => {
            if (workerPid === undefined) return;
            try {
              process.kill(workerPid, "SIGKILL");
            } catch (error) {
              if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
            }
          }),
        ),
      );
    }).pipe(Effect.provide(NodeServices.layer)),
);
