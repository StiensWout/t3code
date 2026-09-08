import type {
  TerminalAttachInput,
  TerminalAttachStreamEvent,
  TerminalError,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Queue from "effect/Queue";
import * as Stream from "effect/Stream";

import * as TerminalManager from "./Manager.ts";

/** Backpressure preserves output and replay boundaries, including the final bytes before close. */
export function terminalAttachStream(input: TerminalAttachInput) {
  return Stream.callback<TerminalAttachStreamEvent, TerminalError, TerminalManager.TerminalManager>(
    (queue) =>
      Effect.gen(function* () {
        const manager = yield* TerminalManager.TerminalManager;
        return yield* Effect.acquireRelease(
          manager
            .attachStream(input, (event) =>
              Queue.offer(queue, event).pipe(Effect.asVoid, Effect.ignore),
            )
            .pipe(Effect.interruptible),
          (unsubscribe) => Effect.sync(unsubscribe),
        );
      }),
    { bufferSize: 32, strategy: "suspend" },
  );
}
