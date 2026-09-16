import {
  CommandId,
  McpCapabilityUnavailableError,
  ThreadId,
  ThreadMetadataMcpAction,
  type OrchestrationCommand,
  type OrchestrationThreadShell,
  type ThreadMetadataMcpUpdateInput,
  type ThreadMetadataMcpUpdateResult,
} from "@t3tools/contracts";
import { parseChangeRequestUrl } from "@t3tools/shared/changeRequestUrl";
import {
  legacyThreadPullRequestKey,
  resolveThreadCurrentPullRequestLink,
} from "@t3tools/shared/threadPullRequests";
import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import * as OrchestrationEngine from "../orchestration/Services/OrchestrationEngine.ts";
import * as ProjectionSnapshotQuery from "../orchestration/Services/ProjectionSnapshotQuery.ts";
import * as McpInvocationContext from "./McpInvocationContext.ts";

export class ThreadMetadataThreadNotFoundError extends Schema.TaggedError<ThreadMetadataThreadNotFoundError>()(
  "ThreadMetadataThreadNotFoundError",
  { threadId: ThreadId },
) {
  override get message(): string {
    return "Thread not found in the calling project.";
  }
}

export class ThreadMetadataUpdateFailedError extends Schema.TaggedError<ThreadMetadataUpdateFailedError>()(
  "ThreadMetadataUpdateFailedError",
  { threadId: ThreadId, action: ThreadMetadataMcpAction, cause: Schema.Defect() },
) {
  override get message(): string {
    return "Could not update thread metadata.";
  }
}

export class ThreadMetadataPullRequestMismatchError extends Schema.TaggedError<ThreadMetadataPullRequestMismatchError>()(
  "ThreadMetadataPullRequestMismatchError",
  { threadId: ThreadId },
) {
  override get message(): string {
    return "Pull request repository and number must match its URL.";
  }
}

export class ThreadMetadataMcpService extends Context.Service<
  ThreadMetadataMcpService,
  {
    readonly update: (
      input: ThreadMetadataMcpUpdateInput,
    ) => Effect.Effect<
      ThreadMetadataMcpUpdateResult,
      | ThreadMetadataThreadNotFoundError
      | ThreadMetadataUpdateFailedError
      | ThreadMetadataPullRequestMismatchError
      | McpCapabilityUnavailableError,
      McpInvocationContext.McpInvocationContext
    >;
  }
>()("t3/mcp/ThreadMetadataMcpService") {}

/** Main stores multiple PR links; preserve unrelated links when adapting v2's single-link actions. */
function metadataCommand(
  commandId: CommandId,
  target: OrchestrationThreadShell,
  input: ThreadMetadataMcpUpdateInput,
): OrchestrationCommand {
  const base = { commandId, threadId: target.id };
  switch (input.action) {
    case "rename":
      return { ...base, type: "thread.meta.update", title: input.title! };
    case "regenerate_title":
      return { ...base, type: "thread.meta.update", regenerateTitle: true };
    case "link_pull_request":
      return {
        ...base,
        type: "thread.pull-request.link",
        ...legacyThreadPullRequestKey(input.pullRequest!),
        url: input.pullRequest!.url,
        source: "agent",
      };
    case "unlink_pull_request": {
      const current = resolveThreadCurrentPullRequestLink(target.pullRequests);
      return current === null
        ? // Record a receipt even for an empty unlink so a retry cannot remove a later link.
          { ...base, type: "thread.meta.update" }
        : {
            ...base,
            type: "thread.pull-request.unlink",
            host: current.host,
            repository: current.repository,
            number: current.number,
          };
    }
  }
}

const make = Effect.gen(function* () {
  const crypto = yield* Crypto.Crypto;
  const engine = yield* OrchestrationEngine.OrchestrationEngineService;
  const snapshots = yield* ProjectionSnapshotQuery.ProjectionSnapshotQuery;

  const update = Effect.fn("ThreadMetadataMcpService.update")(function* (
    input: ThreadMetadataMcpUpdateInput,
  ) {
    const scope = yield* McpInvocationContext.requireMcpCapability("thread-metadata");
    const threadId = input.threadId ?? scope.threadId;
    const getThread = Effect.fn("ThreadMetadataMcpService.getThread")(function* (id: ThreadId) {
      const thread = yield* snapshots.getThreadShellById(id).pipe(
        Effect.mapError(
          (cause) =>
            new ThreadMetadataUpdateFailedError({
              threadId: id,
              action: input.action,
              cause,
            }),
        ),
      );
      if (Option.isNone(thread)) {
        return yield* new ThreadMetadataThreadNotFoundError({ threadId: id });
      }
      return thread.value;
    });
    const parent = yield* getThread(scope.threadId);
    const target = threadId === scope.threadId ? parent : yield* getThread(threadId);
    if (target.projectId !== parent.projectId) {
      return yield* new ThreadMetadataThreadNotFoundError({ threadId });
    }
    if (input.action === "link_pull_request" && input.pullRequest !== undefined) {
      const parsed = parseChangeRequestUrl(input.pullRequest.url);
      if (
        parsed !== null &&
        (parsed.repository !== input.pullRequest.repository.toLowerCase() ||
          parsed.number !== input.pullRequest.number)
      ) {
        return yield* new ThreadMetadataPullRequestMismatchError({ threadId });
      }
    }
    const requestKey = input.clientRequestId ?? (yield* crypto.randomUUIDv4.pipe(Effect.orDie));
    const commandId = CommandId.make(
      [
        "command",
        "mcp",
        scope.providerSessionId,
        "thread-update",
        threadId,
        input.action,
        requestKey,
      ]
        .map(encodeURIComponent)
        .join(":"),
    );
    const { sequence } = yield* engine.dispatch(metadataCommand(commandId, target, input)).pipe(
      Effect.mapError(
        (cause) =>
          new ThreadMetadataUpdateFailedError({
            threadId,
            action: input.action,
            cause,
          }),
      ),
    );

    // Main receipts return a sequence, not v2's complete thread event. Return the
    // current saved metadata even on retries, while preserving the original receipt.
    const saved = yield* getThread(threadId);
    const linked = resolveThreadCurrentPullRequestLink(saved.pullRequests);
    return {
      threadId,
      action: input.action,
      commandId,
      sequence,
      title: saved.title,
      titleRegeneration: saved.titleRegeneration ?? null,
      linkedPullRequest:
        linked === null
          ? null
          : {
              projectId: saved.projectId,
              repository: linked.repository,
              number: linked.number,
              url: linked.url,
            },
      updatedAt: saved.updatedAt,
    } satisfies ThreadMetadataMcpUpdateResult;
  });

  return ThreadMetadataMcpService.of({ update });
});

export const layer = Layer.effect(ThreadMetadataMcpService, make);
