import { expect, it } from "@effect/vitest";
import {
  EnvironmentId,
  CommandId,
  MessageId,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  ThreadId,
  type ManagedMcpServer,
  type McpManagementSnapshot,
  type OrchestrationV2ThreadShell,
  type RuntimeMode,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Deferred from "effect/Deferred";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import * as Stream from "effect/Stream";

import * as McpManagement from "../../../mcpManagement/McpManagement.ts";
import * as McpOAuthClient from "../../../mcpManagement/McpOAuthClient.ts";
import * as ManagedMcpHttp from "../../../mcpManagement/ManagedMcpHttp.ts";
import * as ServerSecretStore from "../../../auth/ServerSecretStore.ts";
import * as ServerSettings from "../../../serverSettings.ts";
import * as McpSessionRegistry from "../../McpSessionRegistry.ts";
import * as ThreadCommandExecutor from "../../../orchestration-v2/ThreadCommandExecutor.ts";
import * as Orchestrator from "../../../orchestration-v2/Orchestrator.ts";
import * as ProviderAdapterRegistry from "../../../orchestration-v2/ProviderAdapterRegistry.ts";
import { CodexProviderCapabilitiesV2 } from "../../../orchestration-v2/Adapters/CodexAdapterV2.ts";
import * as ProviderReplayHarness from "../../../orchestration-v2/testkit/ProviderReplayHarness.ts";
import * as ThreadManagement from "../../../orchestration-v2/ThreadManagementService.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";
import * as McpToolAccess from "../../McpToolAccess.ts";
import { liveThreadShell } from "../../McpToolAccess.testkit.ts";
import * as Handlers from "./handlers.ts";
import { McpManagementToolkit } from "./tools.ts";

const threadId = ThreadId.make("mcp-catalog-reader");
const instanceId = ProviderInstanceId.make("codex");
const snapshot: McpManagementSnapshot = {
  revision: 3,
  servers: [
    {
      id: "http-example",
      name: "HTTP example",
      providerInstanceIds: [instanceId],
      authStatus: "connected",
      transport: {
        type: "http",
        url: "https://example.com/URL-PATH-SECRET/mcp?key=URL-QUERY-SECRET",
        headers: { Authorization: { value: "", sensitive: true, valueRedacted: true } },
        oauth: null,
      },
    },
    {
      id: "stdio-example",
      name: "Stdio example",
      providerInstanceIds: [instanceId],
      authStatus: "not-required",
      transport: { type: "stdio", command: "example", args: ["--key", "ARG-SECRET"], env: {} },
    },
  ],
  providers: [],
  sessions: [],
};

it.effect.each([
  { name: "read-only MCP client", runtimeMode: "approval-required" as RuntimeMode, client: true },
  { name: "restricted agent", runtimeMode: "approval-required" as RuntimeMode, client: false },
  { name: "full-access agent", runtimeMode: "full-access" as RuntimeMode, client: false },
])("lists only appropriate configuration for a $name", ({ runtimeMode, client }) =>
  Effect.gen(function* () {
    const dependencies = Layer.mergeAll(
      ThreadCommandExecutor.layer,
      Layer.mock(McpManagement.McpManagement)({ list: Effect.succeed(snapshot) }),
      Layer.mock(ThreadManagement.ThreadManagementService)({
        getThreadShell: () => Effect.succeed(liveThreadShell(threadId, { runtimeMode })),
      }),
      Layer.succeed(McpInvocationContext.McpInvocationContext, {
        environmentId: EnvironmentId.make("mcp-catalog-environment"),
        requestNamespace: "catalog-reader",
        issuedAt: 0,
        capabilities: new Set<McpInvocationContext.McpCapability>(),
        thread: client
          ? undefined
          : { threadId, providerSessionId: "reader", providerInstanceId: instanceId },
        client: client ? { sessionId: "reader", label: "Reader", access: "read-only" } : undefined,
      }),
    );
    const toolkit = yield* McpManagementToolkit.pipe(
      Effect.provide(
        McpToolAccess.HandlersLayer.layer(Handlers.layer).pipe(Layer.provide(dependencies)),
      ),
    );
    const result = yield* toolkit
      .handle("t3_mcp_list", {})
      .pipe(Stream.unwrap, Stream.runCollect, Effect.provide(dependencies));
    const listed = result.at(-1)?.result;
    if (runtimeMode === "full-access") {
      expect(listed).toEqual(snapshot);
    } else {
      expect(listed).toMatchObject({
        revision: 3,
        servers: [
          {
            id: "http-example",
            authStatus: "connected",
            providerInstanceIds: [instanceId],
            transport: { type: "http", origin: "https://example.com" },
          },
          { id: "stdio-example", transport: { type: "stdio" } },
        ],
      });
      expect(JSON.stringify(listed)).not.toContain("SECRET");
      expect(JSON.stringify(listed)).not.toContain("Authorization");
    }
  }),
);

const mutationNames = ["upsert", "remove", "set_enabled", "copy"] as const;
const managedServer: ManagedMcpServer = {
  id: "local",
  name: "Local",
  providerInstanceIds: [instanceId],
  transport: { type: "stdio", command: "example-mcp", args: [], env: {} },
};
const invocation = Layer.succeed(McpInvocationContext.McpInvocationContext, {
  environmentId: EnvironmentId.make("mcp-mutation-environment"),
  requestNamespace: "mcp-mutation",
  issuedAt: 0,
  capabilities: new Set<McpInvocationContext.McpCapability>(["orchestration"]),
  thread: { threadId, providerSessionId: "mutator", providerInstanceId: instanceId },
  client: undefined,
});
const callMutation = (
  toolkit: Effect.Success<typeof McpManagementToolkit>,
  mutation: (typeof mutationNames)[number],
) => {
  switch (mutation) {
    case "upsert":
      return toolkit.handle("t3_mcp_upsert", { expectedRevision: 3, server: managedServer }).pipe(
        Stream.unwrap,
        Stream.runCollect,
        Effect.map((responses) => responses.at(-1)?.result),
      );
    case "remove":
      return toolkit.handle("t3_mcp_remove", { expectedRevision: 3, id: managedServer.id }).pipe(
        Stream.unwrap,
        Stream.runCollect,
        Effect.map((responses) => responses.at(-1)?.result),
      );
    case "set_enabled":
      return toolkit
        .handle("t3_mcp_set_enabled", {
          id: managedServer.id,
          providerInstanceId: instanceId,
          enabled: false,
        })
        .pipe(
          Stream.unwrap,
          Stream.runCollect,
          Effect.map((responses) => responses.at(-1)?.result),
        );
    case "copy":
      return toolkit
        .handle("t3_mcp_copy", {
          source: instanceId,
          target: ProviderInstanceId.make("claudeAgent"),
        })
        .pipe(
          Stream.unwrap,
          Stream.runCollect,
          Effect.map((responses) => responses.at(-1)?.result),
        );
  }
};

it.effect.each(
  mutationNames.flatMap((mutation) =>
    (["downgraded", "ended"] as const).map((transition) => ({ mutation, transition })),
  ),
)(
  "refuses $mutation when its caller is $transition while waiting for its thread",
  ({ mutation, transition }) =>
    Effect.gen(function* () {
      const caller = yield* Ref.make<OrchestrationV2ThreadShell>(liveThreadShell(threadId));
      const writes = yield* Ref.make(0);
      const checked = yield* Deferred.make<void>();
      const write = Ref.update(writes, (count) => count + 1).pipe(Effect.as(snapshot));
      const dependencies = Layer.mergeAll(
        ThreadCommandExecutor.layer,
        invocation,
        Layer.mock(ThreadManagement.ThreadManagementService)({
          getThreadShell: () =>
            Ref.get(caller).pipe(Effect.tap(() => Deferred.succeed(checked, undefined))),
        }),
        Layer.mock(McpManagement.McpManagement)({
          upsert: () => write,
          remove: () => write,
          setEnabled: () => write,
          copy: () => write,
        }),
      );
      yield* Effect.gen(function* () {
        const executor = yield* ThreadCommandExecutor.ThreadCommandExecutor;
        const toolkit = yield* McpManagementToolkit;
        const held = yield* Deferred.make<void>();
        const release = yield* Deferred.make<void>();
        const holder = yield* executor
          .withLock(
            threadId,
            Deferred.succeed(held, undefined).pipe(Effect.andThen(Deferred.await(release))),
          )
          .pipe(Effect.forkChild);
        yield* Deferred.await(held);
        const pending = yield* callMutation(toolkit, mutation).pipe(Effect.forkChild);
        yield* Deferred.await(checked);
        yield* Ref.update(caller, (shell) =>
          transition === "ended"
            ? { ...shell, activeRunId: null }
            : { ...shell, runtimeMode: "approval-required" as const },
        );
        yield* Deferred.succeed(release, undefined);
        yield* Fiber.join(holder);
        const result = yield* Fiber.join(pending);
        expect(result).toMatchObject({
          code: transition === "ended" ? "parent_not_active" : "capability_denied",
        });
        expect(yield* Ref.get(writes)).toBe(0);
      }).pipe(
        Effect.provide(
          McpToolAccess.HandlersLayer.layer(Handlers.layer).pipe(Layer.provideMerge(dependencies)),
        ),
      );
    }),
);

const orchestratorLayer = Layer.mergeAll(
  ThreadCommandExecutor.layer,
  ProviderReplayHarness.layerWithRegistry(
    { name: "mcp-mutation-authorization" },
    ProviderAdapterRegistry.layerFromAdapters([
      {
        instanceId,
        driver: ProviderDriverKind.make("codex"),
        getCapabilities: () => Effect.succeed(CodexProviderCapabilitiesV2),
        planSelectionTransition: () => Effect.succeed({ type: "apply_on_next_turn" as const }),
        openSession: () => Effect.die("These commands do not launch a provider"),
      },
    ]),
    { runEffectWorker: false },
  ),
);

it.effect.each(["downgrade", "archive"] as const)(
  "serializes a real %s command with a managed mutation waiting for the catalog",
  (transition) =>
    Effect.gen(function* () {
      const values = new Map<string, Uint8Array>();
      const catalogHeld = yield* Deferred.make<void>();
      const releaseCatalog = yield* Deferred.make<void>();
      const mutationQueued = yield* Deferred.make<void>();
      let blockCatalogWrite = false;
      const managementLayer = McpManagement.layer.pipe(
        Layer.provide(
          Layer.mergeAll(
            Layer.mock(ServerSecretStore.ServerSecretStore)({
              get: (name) => Effect.sync(() => Option.fromUndefinedOr(values.get(name))),
              set: (name, value) =>
                Effect.gen(function* () {
                  if (blockCatalogWrite) {
                    yield* Deferred.succeed(catalogHeld, undefined);
                    yield* Deferred.await(releaseCatalog);
                  }
                  values.set(name, value);
                }),
            }),
            ServerSettings.layerTest({
              providerInstances: {
                [instanceId]: { driver: ProviderDriverKind.make("codex"), config: {} },
              },
            }),
            Layer.mock(McpOAuthClient.McpOAuthClient)({
              invalidate: () => Effect.void,
              changes: Stream.never,
            }),
            Layer.mock(ManagedMcpHttp.ManagedMcpHttp)({}),
            Layer.mock(McpSessionRegistry.McpSessionRegistry)({}),
          ),
        ),
      );
      yield* Effect.gen(function* () {
        const orchestrator = yield* Orchestrator.OrchestratorV2;
        const management = yield* McpManagement.McpManagement;
        const executor = yield* ThreadCommandExecutor.ThreadCommandExecutor;
        yield* orchestrator.dispatch({
          type: "thread.create",
          commandId: CommandId.make("create-mcp-caller"),
          threadId,
          projectId: ProjectId.make("mcp-caller-project"),
          title: "MCP caller",
          modelSelection: { instanceId, model: "gpt-5" },
          runtimeMode: "full-access",
          interactionMode: "default",
          branch: null,
          worktreePath: null,
          createdBy: "user",
          creationSource: "web",
        });
        yield* orchestrator.dispatch({
          type: "message.dispatch",
          commandId: CommandId.make("start-mcp-caller"),
          threadId,
          messageId: MessageId.make("mcp-caller-message"),
          text: "Manage MCPs",
          attachments: [],
          dispatchMode: { type: "start_immediately" },
          createdBy: "user",
          creationSource: "web",
        });
        yield* management.upsert({ expectedRevision: 0, server: managedServer });
        blockCatalogWrite = true;
        const owner = yield* management
          .upsert({ expectedRevision: 1, server: { ...managedServer, name: "Updated" } })
          .pipe(Effect.forkChild);
        yield* Deferred.await(catalogHeld);
        const dependencies = Layer.mergeAll(
          Layer.succeed(ThreadCommandExecutor.ThreadCommandExecutor, executor),
          invocation,
          Layer.mock(ThreadManagement.ThreadManagementService)({
            getThreadShell: orchestrator.getThreadShell,
          }),
          Layer.succeed(McpManagement.McpManagement, {
            ...management,
            setEnabled: (input) =>
              Deferred.succeed(mutationQueued, undefined).pipe(
                Effect.andThen(management.setEnabled(input)),
              ),
          }),
        );
        const mutate = Effect.gen(function* () {
          const toolkit = yield* McpManagementToolkit;
          return yield* callMutation(toolkit, "set_enabled");
        }).pipe(
          Effect.provide(
            McpToolAccess.HandlersLayer.layer(Handlers.layer).pipe(
              Layer.provideMerge(dependencies),
            ),
          ),
        );
        const pending = yield* mutate.pipe(Effect.forkChild);
        yield* Deferred.await(mutationQueued);
        const commandStarted = yield* Deferred.make<void>();
        const commandCommitted = yield* Deferred.make<void>();
        const change = yield* Deferred.succeed(commandStarted, undefined).pipe(
          Effect.andThen(
            orchestrator.dispatch(
              transition === "downgrade"
                ? {
                    type: "thread.runtime-mode.set",
                    commandId: CommandId.make("downgrade-mcp-caller"),
                    threadId,
                    runtimeMode: "approval-required",
                  }
                : {
                    type: "thread.archive",
                    commandId: CommandId.make("archive-mcp-caller"),
                    threadId,
                  },
            ),
          ),
          Effect.tap(() => Deferred.succeed(commandCommitted, undefined)),
          Effect.forkChild,
        );
        yield* Deferred.await(commandStarted);
        expect(yield* Deferred.isDone(commandCommitted)).toBe(false);
        expect(yield* orchestrator.getThreadShell(threadId)).toMatchObject({
          runtimeMode: "full-access",
          archivedAt: null,
        });
        yield* Deferred.succeed(releaseCatalog, undefined);
        yield* Fiber.join(owner);
        const result = yield* Fiber.join(pending);
        yield* Fiber.join(change);
        expect(result).toMatchObject({ revision: 3 });
        expect((yield* management.list).servers[0]?.providerInstanceIds).toEqual([]);
        const caller = yield* orchestrator.getThreadShell(threadId);
        if (transition === "downgrade") expect(caller?.runtimeMode).toBe("approval-required");
        else expect(caller?.archivedAt).not.toBeNull();
      }).pipe(Effect.provide(Layer.merge(orchestratorLayer, managementLayer)));
    }),
);
