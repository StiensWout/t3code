import { CommandId } from "@t3tools/contracts";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";

import * as OrchestrationEngine from "../../../orchestration/Services/OrchestrationEngine.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";
import * as ThreadsTools from "./tools.ts";

const make = Effect.gen(function* () {
  const engine = yield* OrchestrationEngine.OrchestrationEngineService;
  const crypto = yield* Crypto.Crypto;

  return ThreadsTools.ThreadsToolkit.of({
    rename_thread: Effect.fn("ThreadsToolkit.renameThread")(function* ({ title }) {
      const { threadId } = yield* McpInvocationContext.requireMcpCapability("thread-metadata");
      const uuid = yield* crypto.randomUUIDv4.pipe(Effect.orDie);
      yield* engine
        .dispatch({
          type: "thread.meta.update",
          commandId: CommandId.make(`server:mcp-thread-rename:${threadId}:${uuid}`),
          threadId,
          title,
        })
        .pipe(
          Effect.mapError((cause) => new ThreadsTools.ThreadRenameFailedError({ threadId, cause })),
        );
      return { threadId, title };
    }),
  });
});

export const ThreadsToolkitHandlersLive = ThreadsTools.ThreadsToolkit.toLayer(make);
