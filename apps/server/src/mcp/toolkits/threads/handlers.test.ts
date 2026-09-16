import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import {
  CommandId,
  EnvironmentId,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";
import { McpSchema, McpServer } from "effect/unstable/ai";

import { ServerConfig } from "../../../config.ts";
import { OrchestrationEngineLive } from "../../../orchestration/Layers/OrchestrationEngine.ts";
import { OrchestrationProjectionPipelineLive } from "../../../orchestration/Layers/ProjectionPipeline.ts";
import { OrchestrationProjectionSnapshotQueryLive } from "../../../orchestration/Layers/ProjectionSnapshotQuery.ts";
import { OrchestrationEngineService } from "../../../orchestration/Services/OrchestrationEngine.ts";
import { ProjectionSnapshotQuery } from "../../../orchestration/Services/ProjectionSnapshotQuery.ts";
import * as ThreadBackgroundLiveness from "../../../orchestration/ThreadBackgroundLiveness.ts";
import * as ThreadPlanProgress from "../../../orchestration/ThreadPlanProgress.ts";
import { OrchestrationCommandReceiptRepositoryLive } from "../../../persistence/Layers/OrchestrationCommandReceipts.ts";
import { OrchestrationEventStoreLive } from "../../../persistence/Layers/OrchestrationEventStore.ts";
import { SqlitePersistenceMemory } from "../../../persistence/Layers/Sqlite.ts";
import { RepositoryIdentityResolver } from "../../../project/RepositoryIdentityResolver.ts";
import { ThreadsToolkitRegistrationLive } from "../../McpHttpServer.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";

const threadId = ThreadId.make("calling-thread");
const otherThreadId = ThreadId.make("other-thread");
const projectId = ProjectId.make("project");
const providerInstanceId = ProviderInstanceId.make("codex");
const invocation: McpInvocationContext.McpInvocationScope = {
  environmentId: EnvironmentId.make("test-environment"),
  threadId,
  providerSessionId: "test-session",
  providerInstanceId,
  capabilities: new Set(["thread-metadata"]),
  issuedAt: 1,
};
const client = McpSchema.McpServerClient.of({
  clientId: 1,
  clientCapabilities: {},
  clientInfo: { name: "rename-test", version: "1.0.0" },
  protocolVersion: "2025-06-18",
  initializePayload: {
    protocolVersion: "2025-06-18",
    capabilities: {},
    clientInfo: { name: "rename-test", version: "1.0.0" },
  },
  getClient: Effect.die("unused"),
});

const EngineLayer = Layer.mergeAll(
  OrchestrationEngineLive.pipe(
    Layer.provide(OrchestrationProjectionSnapshotQueryLive),
    Layer.provide(OrchestrationProjectionPipelineLive),
  ),
  OrchestrationProjectionSnapshotQueryLive,
).pipe(
  Layer.provide(ThreadBackgroundLiveness.layer),
  Layer.provide(ThreadPlanProgress.layer),
  Layer.provide(OrchestrationEventStoreLive),
  Layer.provide(OrchestrationCommandReceiptRepositoryLive),
  Layer.provide(Layer.succeed(RepositoryIdentityResolver, { resolve: () => Effect.succeed(null) })),
  Layer.provide(SqlitePersistenceMemory),
);
const TestLayer = ThreadsToolkitRegistrationLive.pipe(
  Layer.provideMerge(McpServer.McpServer.layer),
  Layer.provideMerge(EngineLayer),
  Layer.provide(ServerConfig.layerTest(process.cwd(), { prefix: "t3-mcp-rename-test-" })),
  Layer.provide(NodeServices.layer),
);

const makeHarness = Effect.gen(function* () {
  const server = yield* McpServer.McpServer;
  const engine = yield* OrchestrationEngineService;
  const snapshots = yield* ProjectionSnapshotQuery;
  const createdAt = "2026-09-16T00:00:00.000Z";
  yield* engine.dispatch({
    type: "project.create",
    commandId: CommandId.make("create-project"),
    projectId,
    title: "Project",
    workspaceRoot: "/tmp/mcp-rename-test",
    createdAt,
  });
  for (const id of [threadId, otherThreadId]) {
    yield* engine.dispatch({
      type: "thread.create",
      commandId: CommandId.make(`create-${id}`),
      threadId: id,
      projectId,
      title: "Original title",
      modelSelection: { instanceId: providerInstanceId, model: "gpt-5" },
      runtimeMode: "full-access",
      interactionMode: "default",
      branch: null,
      worktreePath: null,
      createdAt,
    });
  }
  const call = (args: Record<string, unknown>, scope = invocation) =>
    server
      .callTool({ name: "rename_thread", arguments: args })
      .pipe(
        Effect.provideService(McpInvocationContext.McpInvocationContext, scope),
        Effect.provideService(McpSchema.McpServerClient, client),
      );
  const readThread = (id = threadId) =>
    snapshots.getThreadDetailById(id).pipe(Effect.map(Option.getOrThrow));
  return { server, engine, call, readThread };
});

it.effect(
  "renames only the calling thread, persists a manual title, and supports renaming again",
  () =>
    Effect.gen(function* () {
      const { server, engine, call, readThread } = yield* makeHarness;
      const tool = server.tools.find(({ tool }) => tool.name === "rename_thread")?.tool;
      expect(tool?.inputSchema.properties).toHaveProperty("title");
      expect(tool?.inputSchema.properties).not.toHaveProperty("threadId");
      expect(tool?.annotations).toMatchObject({
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: false,
      });

      const title = "CU-869y9uv0 change the button to green and keep the ticket ID";
      const before = yield* engine.latestSequence;
      // An extra target supplied by a caller cannot override the credential's thread.
      const result = yield* call({ title: `  ${title}\n`, threadId: otherThreadId });
      expect(result.isError).toBe(false);
      expect(result.structuredContent).toEqual({ threadId, title });
      expect(yield* readThread()).toMatchObject({
        title,
        titleState: { source: "manual", needsRefinement: false },
      });
      expect(yield* readThread(otherThreadId)).toMatchObject({ title: "Original title" });
      const events = yield* engine.readEvents(before).pipe(Stream.runCollect);
      expect(events).toMatchObject([
        {
          type: "thread.meta-updated",
          aggregateId: threadId,
          payload: { threadId, title, titleState: { source: "manual" } },
        },
      ]);

      expect((yield* call({ title })).isError).toBe(false);
      expect((yield* call({ title: "LIN-42 another name" })).structuredContent).toEqual({
        threadId,
        title: "LIN-42 another name",
      });
      expect(yield* readThread()).toMatchObject({ title: "LIN-42 another name" });
    }).pipe(Effect.provide(TestLayer)),
);

it.effect("keeps the agent's title when title generation or regeneration finishes late", () =>
  Effect.gen(function* () {
    const { engine, call, readThread } = yield* makeHarness;
    const requestId = CommandId.make("regenerate-title");
    yield* engine.dispatch({
      type: "thread.meta.update",
      commandId: requestId,
      threadId,
      regenerateTitle: true,
    });
    yield* call({ title: "CU-869y9uv0 chosen title" });
    yield* engine.dispatch({
      type: "thread.title.regeneration.complete",
      commandId: CommandId.make("late-regeneration"),
      threadId,
      requestId,
      title: "Unwanted regenerated title",
    });
    yield* engine.dispatch({
      type: "thread.title.generate.complete",
      commandId: CommandId.make("late-generation"),
      threadId,
      expectedTitle: "Original title",
      expectedVersion: null,
      title: "Unwanted generated title",
      needsRefinement: true,
    });
    expect(yield* readThread()).toMatchObject({
      title: "CU-869y9uv0 chosen title",
      titleState: { source: "manual", needsRefinement: false },
      titleRegeneration: null,
    });
  }).pipe(Effect.provide(TestLayer)),
);

it.effect("rejects missing, blank, and non-string titles without writing events", () =>
  Effect.gen(function* () {
    const { engine, call, readThread } = yield* makeHarness;
    const before = yield* engine.latestSequence;
    for (const args of [{}, { title: "" }, { title: " \n\t " }, { title: 42 }]) {
      expect((yield* call(args).pipe(Effect.flip))._tag).toBe("InvalidParams");
    }
    expect(yield* engine.latestSequence).toBe(before);
    expect(yield* readThread()).toMatchObject({ title: "Original title" });
  }).pipe(Effect.provide(TestLayer)),
);

it.effect(
  "reports missing permission and missing threads as tool errors without renaming another thread",
  () =>
    Effect.gen(function* () {
      const { engine, call, readThread } = yield* makeHarness;
      const before = yield* engine.latestSequence;
      const denied = yield* call(
        { title: "New title" },
        { ...invocation, capabilities: new Set(["preview"]) },
      );
      expect(denied.isError).toBe(true);
      expect(denied.content).toEqual([
        { type: "text", text: "MCP credential does not grant the thread-metadata capability." },
      ]);
      const missing = yield* call(
        { title: "New title" },
        { ...invocation, threadId: ThreadId.make("missing-thread") },
      );
      expect(missing.isError).toBe(true);
      expect(missing.content).toEqual([
        { type: "text", text: "Could not rename the current thread." },
      ]);
      expect(yield* engine.latestSequence).toBe(before);
      expect(yield* readThread()).toMatchObject({ title: "Original title" });
    }).pipe(Effect.provide(TestLayer)),
);
