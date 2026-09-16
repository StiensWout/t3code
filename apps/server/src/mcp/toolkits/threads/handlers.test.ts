import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import {
  CommandId,
  EnvironmentId,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  ThreadMetadataMcpUpdateResult,
} from "@t3tools/contracts";
import * as Crypto from "effect/Crypto";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
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

const decodeResult = Schema.decodeUnknownEffect(ThreadMetadataMcpUpdateResult);
const threadId = ThreadId.make("calling-thread");
const foreignThreadId = ThreadId.make("foreign-thread");
const foreignProjectId = ProjectId.make("foreign-project");
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
  Layer.provide(SqlitePersistenceMemory),
);
const TestDependencies = Layer.mergeAll(McpServer.McpServer.layer, EngineLayer).pipe(
  Layer.provide(ServerConfig.layerTest(process.cwd(), { prefix: "t3-mcp-rename-test-" })),
  Layer.provide(NodeServices.layer),
);
const TestLayer = ThreadsToolkitRegistrationLive.pipe(
  Layer.provideMerge(TestDependencies),
  Layer.provide(Layer.succeed(RepositoryIdentityResolver, { resolve: () => Effect.succeed(null) })),
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
  yield* engine.dispatch({
    type: "project.create",
    commandId: CommandId.make("create-foreign-project"),
    projectId: foreignProjectId,
    title: "Foreign project",
    workspaceRoot: "/tmp/mcp-metadata-foreign-test",
    createdAt,
  });
  for (const id of [threadId, otherThreadId, foreignThreadId]) {
    yield* engine.dispatch({
      type: "thread.create",
      commandId: CommandId.make(`create-${id}`),
      threadId: id,
      projectId: id === foreignThreadId ? foreignProjectId : projectId,
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
      .callTool({ name: "t3_thread_update", arguments: args })
      .pipe(
        Effect.provideService(McpInvocationContext.McpInvocationContext, scope),
        Effect.provideService(McpSchema.McpServerClient, client),
      );
  const readThread = (id = threadId) =>
    snapshots.getThreadDetailById(id).pipe(Effect.map(Option.getOrThrow));
  const update = Effect.fn("updateThreadMetadata")(function* (
    args: Record<string, unknown>,
    scope = invocation,
  ) {
    const result = yield* call(args, scope);
    expect(result.isError).toBe(false);
    return yield* decodeResult(result.structuredContent);
  });
  return { server, engine, call, update, readThread };
});

it.effect("ports the object-root tool contract and persists a convention title as manual", () =>
  Effect.gen(function* () {
    const { server, engine, update, readThread } = yield* makeHarness;
    const tool = server.tools.find(({ tool }) => tool.name === "t3_thread_update")?.tool;
    expect(tool?.inputSchema).toMatchObject({ type: "object" });
    expect(tool?.inputSchema.properties).toHaveProperty("threadId");
    expect(tool?.annotations).toMatchObject({
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: false,
      openWorldHint: false,
    });
    const title = "CU-869y9uv0 change the button to green and keep the ticket ID";
    const before = yield* engine.latestSequence;
    const result = yield* update({ action: "rename", title: `  ${title}\n` });
    expect(result).toMatchObject({
      threadId,
      action: "rename",
      title,
      titleRegeneration: null,
      linkedPullRequest: null,
    });
    expect(result.sequence).toBeGreaterThan(before);
    expect(yield* readThread()).toMatchObject({
      title,
      titleState: { source: "manual", needsRefinement: false },
    });
    expect(yield* readThread(otherThreadId)).toMatchObject({ title: "Original title" });
    expect(yield* engine.readEvents(before).pipe(Stream.runCollect)).toMatchObject([
      {
        type: "thread.meta-updated",
        aggregateId: threadId,
        payload: { threadId, title, titleState: { source: "manual" } },
      },
    ]);
    expect((yield* update({ action: "rename", title: "LIN-42 another name" })).title).toBe(
      "LIN-42 another name",
    );
    const longTitle = "x".repeat(1024);
    expect((yield* update({ action: "rename", title: longTitle })).title).toBe(longTitle);
    expect((yield* readThread()).title).toBe(longTitle);
  }).pipe(Effect.provide(TestLayer)),
);

it.effect("updates another thread only within the calling project", () =>
  Effect.gen(function* () {
    const { engine, call, update, readThread } = yield* makeHarness;
    expect(
      yield* update({ action: "rename", threadId: otherThreadId, title: "Sibling title" }),
    ).toMatchObject({ threadId: otherThreadId, title: "Sibling title" });
    expect(yield* readThread(otherThreadId)).toMatchObject({ title: "Sibling title" });
    const before = yield* engine.latestSequence;
    for (const target of [foreignThreadId, ThreadId.make("missing-thread")]) {
      const result = yield* call({ action: "rename", threadId: target, title: "Denied title" });
      expect(result.isError).toBe(true);
      expect(result.content).toEqual([
        { type: "text", text: "Thread not found in the calling project." },
      ]);
    }
    const missingCaller = yield* call(
      { action: "rename", threadId: otherThreadId, title: "Denied title" },
      { ...invocation, threadId: ThreadId.make("missing-caller") },
    );
    expect(missingCaller.isError).toBe(true);
    expect(yield* engine.latestSequence).toBe(before);
    expect(yield* readThread()).toMatchObject({ title: "Original title" });
    expect(yield* readThread(foreignThreadId)).toMatchObject({ title: "Original title" });
  }).pipe(Effect.provide(TestLayer)),
);

it.effect(
  "deduplicates concurrent retry keys and reports current metadata with the original receipt",
  () =>
    Effect.gen(function* () {
      const { engine, update, readThread } = yield* makeHarness;
      const input = { action: "rename", title: "First title", clientRequestId: "rename-🚀" };
      const before = yield* engine.latestSequence;
      const [first, repeated] = yield* Effect.all([update(input), update(input)], {
        concurrency: "unbounded",
      });
      expect(repeated).toEqual(first);
      expect(yield* engine.readEvents(before).pipe(Stream.runCollect)).toHaveLength(1);
      yield* update({ action: "rename", title: "Later title" });
      const after = yield* engine.latestSequence;
      expect(yield* update(input)).toMatchObject({
        commandId: first.commandId,
        sequence: first.sequence,
        title: "Later title",
      });
      expect(yield* engine.latestSequence).toBe(after);
      expect(yield* readThread()).toMatchObject({ title: "Later title" });
      const sibling = yield* update({ ...input, threadId: otherThreadId });
      expect(sibling.commandId).not.toBe(first.commandId);
      const nextSession = yield* update(input, {
        ...invocation,
        providerSessionId: "next-session",
      });
      expect(nextSession.commandId).not.toBe(first.commandId);
      expect(nextSession.title).toBe("First title");
    }).pipe(Effect.provide(TestLayer)),
);

it.effect(
  "regenerates once per retry key and keeps a later manual title against late completion",
  () =>
    Effect.gen(function* () {
      const { engine, update, readThread } = yield* makeHarness;
      const input = { action: "regenerate_title", clientRequestId: "shared-key" };
      const regeneration = yield* update(input);
      expect(regeneration.titleRegeneration).toMatchObject({ requestId: regeneration.commandId });
      expect(yield* update(input)).toEqual(regeneration);
      const renamed = yield* update({
        action: "rename",
        title: "CU-869y9uv0 chosen title",
        clientRequestId: "shared-key",
      });
      expect(renamed.commandId).not.toBe(regeneration.commandId);
      yield* engine.dispatch({
        type: "thread.title.regeneration.complete",
        commandId: CommandId.make("late-regeneration"),
        threadId,
        requestId: regeneration.commandId,
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
      const before = yield* engine.latestSequence;
      expect(yield* update(input)).toMatchObject({
        commandId: regeneration.commandId,
        sequence: regeneration.sequence,
        titleRegeneration: null,
      });
      expect(yield* engine.latestSequence).toBe(before);
    }).pipe(Effect.provide(TestLayer)),
);

it.effect("links and unlinks the current PR while preserving other links and durable retries", () =>
  Effect.gen(function* () {
    const { engine, update, readThread } = yield* makeHarness;
    const firstPr = {
      repository: "pingdotgg/t3code",
      number: 8690,
      url: "https://github.com/pingdotgg/t3code/pull/8690",
    };
    const secondPr = {
      ...firstPr,
      number: 11968,
      url: "https://github.com/pingdotgg/t3code/pull/11968",
    };
    const linked = yield* update({
      action: "link_pull_request",
      pullRequest: firstPr,
      clientRequestId: "link-pr",
    });
    expect(linked.linkedPullRequest).toMatchObject(firstPr);
    expect((yield* readThread()).pullRequests).toMatchObject([
      { ...firstPr, host: "github.com", source: "agent" },
    ]);
    expect(
      yield* update({
        action: "link_pull_request",
        pullRequest: firstPr,
        clientRequestId: "link-pr",
      }),
    ).toEqual(linked);
    yield* update({ action: "link_pull_request", pullRequest: secondPr });
    expect((yield* readThread()).pullRequests).toHaveLength(2);
    const unlinked = yield* update({ action: "unlink_pull_request", clientRequestId: "unlink-pr" });
    expect(unlinked.linkedPullRequest).not.toBeNull();
    expect((yield* readThread()).pullRequests).toHaveLength(1);
    expect(yield* update({ action: "unlink_pull_request", clientRequestId: "unlink-pr" })).toEqual(
      unlinked,
    );
    expect((yield* readThread()).pullRequests).toHaveLength(1);
    expect((yield* update({ action: "unlink_pull_request" })).linkedPullRequest).toBeNull();
    expect((yield* readThread()).pullRequests).toEqual([]);
    const emptyUnlink = yield* update({
      action: "unlink_pull_request",
      clientRequestId: "empty-unlink",
    });
    expect(emptyUnlink.linkedPullRequest).toBeNull();
    const after = yield* engine.latestSequence;
    expect(
      yield* update({
        action: "link_pull_request",
        pullRequest: firstPr,
        clientRequestId: "link-pr",
      }),
    ).toMatchObject({
      commandId: linked.commandId,
      sequence: linked.sequence,
      linkedPullRequest: null,
    });
    expect(yield* engine.latestSequence).toBe(after);
    yield* update({ action: "link_pull_request", pullRequest: secondPr });
    const retriedEmptyUnlink = yield* update({
      action: "unlink_pull_request",
      clientRequestId: "empty-unlink",
    });
    expect(retriedEmptyUnlink).toMatchObject({
      commandId: emptyUnlink.commandId,
      sequence: emptyUnlink.sequence,
      linkedPullRequest: secondPr,
    });
    expect((yield* readThread()).pullRequests).toHaveLength(1);
  }).pipe(Effect.provide(TestLayer)),
);

it.effect("an empty unlink preserves a PR linked after its snapshot was read", () =>
  Effect.gen(function* () {
    const crypto = yield* Crypto.Crypto;
    const requestKey = yield* crypto.randomUUIDv4;
    const snapshotRead = yield* Deferred.make<void>();
    const resumeUnlink = yield* Deferred.make<void>();
    const gatedCrypto = {
      ...crypto,
      randomUUIDv4: Effect.gen(function* () {
        yield* Deferred.succeed(snapshotRead, undefined);
        yield* Deferred.await(resumeUnlink);
        return requestKey;
      }),
    };
    yield* Effect.gen(function* () {
      const { engine, update, readThread } = yield* makeHarness;
      const unlink = yield* update({ action: "unlink_pull_request" }).pipe(Effect.forkChild);
      yield* Deferred.await(snapshotRead);
      const pr = {
        host: "github.com",
        repository: "pingdotgg/t3code",
        number: 11968,
        url: "https://github.com/pingdotgg/t3code/pull/11968",
      };
      yield* engine.dispatch({
        type: "thread.pull-request.link",
        commandId: CommandId.make("concurrent-link"),
        threadId,
        ...pr,
        source: "agent",
      });
      yield* Deferred.succeed(resumeUnlink, undefined);
      const result = yield* Fiber.join(unlink);
      expect(result.linkedPullRequest).toMatchObject({
        repository: pr.repository,
        number: pr.number,
      });
      expect((yield* readThread()).pullRequests).toMatchObject([pr]);
      const beforeRetry = yield* engine.latestSequence;
      expect(yield* update({ action: "unlink_pull_request", clientRequestId: requestKey })).toEqual(
        result,
      );
      expect(yield* engine.latestSequence).toBe(beforeRetry);
    }).pipe(
      Effect.provide(
        ThreadsToolkitRegistrationLive.pipe(
          Layer.provide(Layer.succeed(Crypto.Crypto, gatedCrypto)),
          Layer.provideMerge(TestDependencies),
          Layer.provide(
            Layer.succeed(RepositoryIdentityResolver, {
              resolve: (rootPath) =>
                Effect.succeed({
                  provider: "github",
                  canonicalKey: "github.com/pingdotgg/t3code",
                  locator: {
                    source: "git-remote",
                    remoteName: "origin",
                    remoteUrl: "https://github.com/pingdotgg/t3code.git",
                  },
                  rootPath,
                  owner: "pingdotgg",
                  name: "t3code",
                }),
            }),
          ),
        ),
      ),
    );
  }).pipe(Effect.provide(NodeServices.layer)),
);

it.effect("validates known PR URL identities and supports self-hosted repository paths", () =>
  Effect.gen(function* () {
    const { engine, call, update, readThread } = yield* makeHarness;
    const before = yield* engine.latestSequence;
    for (const pullRequest of [
      {
        repository: "other/repo",
        number: 11968,
        url: "https://github.com/pingdotgg/t3code/pull/11968",
      },
      {
        repository: "pingdotgg/t3code",
        number: 42,
        url: "https://github.com/pingdotgg/t3code/pull/11968",
      },
      { repository: "other/repo", number: 42, url: "https://git.example/team/repo/pulls/42" },
    ]) {
      const result = yield* call({ action: "link_pull_request", pullRequest });
      expect(result.isError).toBe(true);
      expect(result.content).toEqual([
        { type: "text", text: "Pull request repository and number must match its URL." },
      ]);
    }
    expect(yield* engine.latestSequence).toBe(before);
    expect((yield* readThread()).pullRequests).toEqual([]);
    for (const pullRequest of [
      {
        repository: "PingDotGG/T3Code",
        number: 11968,
        url: "https://github.com/pingdotgg/t3code/pull/11968",
      },
      {
        repository: "group/subgroup/repo",
        number: 42,
        url: "https://git.example/group/subgroup/repo/-/merge_requests/42",
      },
      { repository: "team/repo", number: 42, url: "https://git.example:8443/team/repo/pulls/42" },
      {
        repository: "org/project/_git/repo",
        number: 42,
        url: "https://dev.azure.com/org/project/_git/repo/pullrequest/42",
      },
      { repository: "team/repo", number: 42, url: "https://custom.example/review/42" },
    ]) {
      const result = yield* update({ action: "link_pull_request", pullRequest });
      expect(result.linkedPullRequest?.number).toBe(pullRequest.number);
      expect((yield* readThread()).pullRequests.some((link) => link.url === pullRequest.url)).toBe(
        true,
      );
    }
  }).pipe(Effect.provide(TestLayer)),
);

it.effect("rejects invalid action inputs and missing permission without writing events", () =>
  Effect.gen(function* () {
    const { engine, call, readThread } = yield* makeHarness;
    const before = yield* engine.latestSequence;
    for (const args of [
      {},
      { action: "rename" },
      { action: "rename", title: " \n\t " },
      { action: "rename", title: 42 },
      { action: "link_pull_request" },
      { action: "regenerate_title", title: "Unexpected" },
      { action: "unlink_pull_request", title: "Unexpected" },
    ]) {
      expect((yield* call(args).pipe(Effect.flip))._tag).toBe("InvalidParams");
    }
    const denied = yield* call(
      { action: "rename", title: "New title" },
      { ...invocation, capabilities: new Set(["preview"]) },
    );
    expect(denied.isError).toBe(true);
    expect(denied.content).toEqual([
      { type: "text", text: "MCP credential does not grant the thread-metadata capability." },
    ]);
    expect(yield* engine.latestSequence).toBe(before);
    expect(yield* readThread()).toMatchObject({ title: "Original title" });
  }).pipe(Effect.provide(TestLayer)),
);
