import { OrchestratorMcpFailure } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as McpManagement from "../../../mcpManagement/McpManagement.ts";
import * as ThreadCommandExecutor from "../../../orchestration-v2/ThreadCommandExecutor.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";
import * as McpToolAccess from "../../McpToolAccess.ts";
import { loadCaller } from "../../threadAccess.ts";
import { McpManagementToolkit } from "./tools.ts";

const service = McpManagement.McpManagement;
const failure = (error: { readonly message: string }) =>
  new OrchestratorMcpFailure({
    code: "orchestration_error",
    message: error.message,
  });

/** Keep a thread caller's authorization stable while the catalog mutation waits. */
const withCallerLock = <A, E, R>(update: Effect.Effect<A, E, R>) =>
  Effect.gen(function* () {
    const scope = yield* McpInvocationContext.McpInvocationContext;
    const executor = yield* ThreadCommandExecutor.ThreadCommandExecutor;
    return yield* scope.thread === undefined
      ? update
      : executor.withLock(scope.thread.threadId, update);
  });

export const layer = McpToolAccess.toLayer(McpManagementToolkit, {
  t3_mcp_list: McpToolAccess.reads(() =>
    Effect.gen(function* () {
      const caller = yield* loadCaller();
      const management = yield* service;
      const snapshot = yield* management.list.pipe(Effect.mapError(failure));
      if (
        caller.limits.runtimeMode === "full-access" &&
        caller.limits.interactionMode === "default"
      ) {
        return snapshot;
      }
      return {
        ...snapshot,
        servers: snapshot.servers.map((server) => ({
          ...server,
          transport:
            server.transport.type === "http"
              ? { type: "http" as const, origin: new URL(server.transport.url).origin }
              : { type: "stdio" as const },
        })),
      };
    }),
  ),
  t3_mcp_upsert: McpToolAccess.writesEnvironment((input, check) =>
    withCallerLock(
      check.pipe(
        Effect.andThen(service),
        Effect.flatMap((management) => management.upsert(input).pipe(Effect.mapError(failure))),
      ),
    ),
  ),
  t3_mcp_remove: McpToolAccess.writesEnvironment((input, check) =>
    withCallerLock(
      check.pipe(
        Effect.andThen(service),
        Effect.flatMap((management) => management.remove(input).pipe(Effect.mapError(failure))),
      ),
    ),
  ),
  t3_mcp_set_enabled: McpToolAccess.writesEnvironment((input, check) =>
    withCallerLock(
      check.pipe(
        Effect.andThen(service),
        Effect.flatMap((management) => management.setEnabled(input).pipe(Effect.mapError(failure))),
      ),
    ),
  ),
  t3_mcp_copy: McpToolAccess.writesEnvironment((input, check) =>
    withCallerLock(
      check.pipe(
        Effect.andThen(service),
        Effect.flatMap((management) => management.copy(input).pipe(Effect.mapError(failure))),
      ),
    ),
  ),
  t3_mcp_import_preview: McpToolAccess.reads((input) =>
    service.pipe(
      Effect.flatMap((management) => management.importPreview(input)),
      Effect.mapError(failure),
    ),
  ),
});
