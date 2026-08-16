import { assert, describe, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  CheckpointId,
  NodeId,
  ProviderInstanceId,
  ProviderSessionId,
  ProviderTurnId,
  RunAttemptId,
  RunId,
  ThreadId,
  type ChatAttachment,
  type ModelSelection,
  type OrchestrationV2AppThread,
  type OrchestrationV2ProviderThread,
  type OrchestrationV2ProviderTurn,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Queue from "effect/Queue";
import * as Schema from "effect/Schema";
import * as Sink from "effect/Sink";
import * as Stream from "effect/Stream";
import { ChildProcessSpawner } from "effect/unstable/process";

import { ServerConfig } from "../../config.ts";
import { IdAllocatorV2, layer as idAllocatorLayer } from "../IdAllocator.ts";
import {
  ProviderAdapterV2RuntimePolicy,
  type ProviderAdapterV2Event,
  type ProviderAdapterV2SessionRuntime,
} from "../ProviderAdapter.ts";
import {
  makePiAdapterV2,
  piRollbackForkEntry,
  PiProviderCapabilitiesV2,
  PI_PROVIDER,
} from "./PiAdapterV2.ts";
import { makePiRpcConnection, type PiRpcRecord } from "./PiRpc.ts";

const serverConfigLayer = ServerConfig.layerTest(process.cwd(), {
  prefix: "t3-pi-v2-adapter-",
}).pipe(Layer.provide(NodeServices.layer));

const testLayer = Layer.mergeAll(NodeServices.layer, idAllocatorLayer, serverConfigLayer);

const decodeJsonLine = Schema.decodeSync(Schema.fromJsonString(Schema.Unknown));
const encodeJsonLine = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));

const PI_INSTANCE_ID = ProviderInstanceId.make("pi");
const THREAD_ID = ThreadId.make("thread-pi-test");
const SESSION_ID = ProviderSessionId.make("provider-session-pi-test");
const FAKE_SESSION_FILE = "/fake/.pi/agent/sessions/--workspace--/0001_abc.jsonl";
/** Deliberately outside the valid pid range so a group-kill can never land. */
const FAKE_PID = 999_999_999;

const runtimePolicy = ProviderAdapterV2RuntimePolicy.make({
  runtimeMode: "full-access",
  interactionMode: "default",
  cwd: null,
});

const modelSelection = (model: string): ModelSelection => ({
  instanceId: PI_INSTANCE_ID,
  model,
});

interface FakePi {
  readonly spawner: ChildProcessSpawner.ChildProcessSpawner["Service"];
  readonly emit: (record: PiRpcRecord) => Effect.Effect<void>;
  readonly takeRequest: (type: string) => Effect.Effect<PiRpcRecord>;
  /** Data returned by the next `get_entries` acks, consumed in order. */
  readonly queueEntries: (data: unknown) => void;
}

/**
 * In-process fake `pi --mode rpc`: captures every stdin record, auto-acks
 * requests with canned data, and lets tests push protocol events to stdout.
 */
const makeFakePi: Effect.Effect<FakePi> = Effect.gen(function* () {
  const stdout = yield* Queue.unbounded<Uint8Array>();
  const requests = yield* Queue.unbounded<PiRpcRecord>();
  const entriesQueue: Array<unknown> = [];
  let stdinBuffer = "";

  const emit = (record: PiRpcRecord) =>
    Queue.offer(stdout, new TextEncoder().encode(`${encodeJsonLine(record)}\n`)).pipe(
      Effect.asVoid,
    );

  const respondTo = (record: PiRpcRecord): PiRpcRecord | null => {
    if (typeof record["id"] !== "string") return null;
    const base = {
      type: "response",
      id: record["id"],
      command: String(record["type"]),
      success: true,
    };
    switch (record["type"]) {
      case "get_state":
        return {
          ...base,
          data: {
            model: null,
            thinkingLevel: "medium",
            isStreaming: false,
            isCompacting: false,
            sessionFile: FAKE_SESSION_FILE,
            sessionId: "abc",
          },
        };
      case "switch_session":
        return { ...base, data: { cancelled: false } };
      case "get_entries":
        return { ...base, data: entriesQueue.shift() ?? { entries: [], leafId: null } };
      case "fork":
        return { ...base, data: { cancelled: false, message: "forked" } };
      default:
        return base;
    }
  };

  const handleStdinChunk = (chunk: Uint8Array) =>
    Effect.gen(function* () {
      stdinBuffer += new TextDecoder().decode(chunk);
      while (true) {
        const newline = stdinBuffer.indexOf("\n");
        if (newline === -1) return;
        const line = stdinBuffer.slice(0, newline);
        stdinBuffer = stdinBuffer.slice(newline + 1);
        if (line.length === 0) continue;
        const record = decodeJsonLine(line) as PiRpcRecord;
        yield* Queue.offer(requests, record);
        const response = respondTo(record);
        if (response !== null) yield* emit(response);
      }
    });

  const spawner = ChildProcessSpawner.make(() =>
    Effect.succeed(
      ChildProcessSpawner.makeHandle({
        pid: ChildProcessSpawner.ProcessId(FAKE_PID),
        exitCode: Effect.never,
        isRunning: Effect.succeed(true),
        kill: () => Effect.void,
        unref: Effect.succeed(Effect.void),
        stdin: Sink.forEach(handleStdinChunk),
        stdout: Stream.fromQueue(stdout),
        stderr: Stream.empty,
        all: Stream.empty,
        getInputFd: () => Sink.drain,
        getOutputFd: () => Stream.empty,
      }),
    ),
  );

  const takeRequest = (type: string): Effect.Effect<PiRpcRecord> =>
    Effect.gen(function* () {
      while (true) {
        const record = yield* Queue.take(requests);
        if (record["type"] === type) return record;
      }
    });

  return {
    spawner,
    emit,
    takeRequest,
    queueEntries: (data) => entriesQueue.push(data),
  } satisfies FakePi;
});

const makeAdapter = Effect.fnUntraced(function* (fake: FakePi) {
  const idAllocator = yield* IdAllocatorV2;
  const serverConfig = yield* ServerConfig;
  const fileSystem = yield* FileSystem.FileSystem;
  return makePiAdapterV2({
    instanceId: PI_INSTANCE_ID,
    settings: { enabled: true, binaryPath: "pi", launchArgs: "", customModels: [] },
    environment: {},
    spawner: fake.spawner,
    fileSystem,
    idAllocator,
    serverConfig,
  });
});

const openRuntime = Effect.fnUntraced(function* (fake: FakePi, model = "default") {
  const adapter = yield* makeAdapter(fake);
  const runtime = yield* adapter.openSession({
    threadId: THREAD_ID,
    providerSessionId: SESSION_ID,
    modelSelection: modelSelection(model),
    runtimePolicy,
  });
  const emitted = yield* Queue.unbounded<ProviderAdapterV2Event>();
  yield* runtime.events.pipe(
    Stream.runForEach((event) => Queue.offer(emitted, event)),
    Effect.forkScoped,
  );
  const takeEvent = (predicate: (event: ProviderAdapterV2Event) => boolean) =>
    Effect.gen(function* () {
      while (true) {
        const event = yield* Queue.take(emitted);
        if (predicate(event)) return event;
      }
    });
  return { runtime, takeEvent };
});

const makeAppThread = Effect.fnUntraced(function* (model: string) {
  const now = yield* DateTime.now;
  return {
    createdBy: "user",
    creationSource: "web",
    id: THREAD_ID,
    projectId: "project:fixture:pi" as OrchestrationV2AppThread["projectId"],
    title: "Pi test thread",
    providerInstanceId: PI_INSTANCE_ID,
    modelSelection: modelSelection(model),
    runtimeMode: "full-access",
    interactionMode: "default",
    branch: null,
    worktreePath: null,
    activeProviderThreadId: null,
    lineage: { parentThreadId: null, relationshipToParent: null, rootThreadId: THREAD_ID },
    forkedFrom: null,
    createdAt: now,
    updatedAt: now,
    archivedAt: null,
    settledOverride: null,
    settledAt: null,
    lastVisitedAt: null,
    deletedAt: null,
  } satisfies OrchestrationV2AppThread;
});

const startTurn = Effect.fnUntraced(function* (
  runtime: ProviderAdapterV2SessionRuntime,
  providerThread: OrchestrationV2ProviderThread,
  model = "default",
  attachments: ReadonlyArray<ChatAttachment> = [],
) {
  const appThread = yield* makeAppThread(model);
  yield* runtime.startTurn({
    appThread,
    threadId: THREAD_ID,
    runId: RunId.make("run:thread-pi-test:1"),
    runOrdinal: 1,
    providerTurnOrdinal: 1,
    attemptId: RunAttemptId.make("run-attempt:run:thread-pi-test:1:1"),
    rootNodeId: NodeId.make("node:run:thread-pi-test:1:root"),
    providerThread,
    message: {
      messageId: "message:thread-pi-test:1" as never,
      text: "Hello pi",
      attachments,
      createdBy: "user",
      creationSource: "web",
    },
    modelSelection: modelSelection(model),
    runtimePolicy,
  });
});

describe("PiAdapterV2", () => {
  it("keeps the rollback capability triple consistent with CommandPolicy", () => {
    // ensureRollback rejects rollback commands unless all three hold, so a
    // partially-enabled combination is user-visibly broken, not conservative.
    assert.isTrue(PiProviderCapabilitiesV2.threads.canRollbackThread);
    assert.isTrue(PiProviderCapabilitiesV2.checkpointing.providerCanRollbackConversation);
    assert.isTrue(PiProviderCapabilitiesV2.checkpointing.providerRollbackReturnsSnapshot);
  });

  it("declares Pi-honest capabilities", () => {
    assert.isTrue(PiProviderCapabilitiesV2.turns.supportsActiveSteering);
    assert.isFalse(PiProviderCapabilitiesV2.turns.supportsSteeringByInterruptRestart);
    assert.equal(PiProviderCapabilitiesV2.turns.terminalStatusQuality, "strong");
    assert.isFalse(PiProviderCapabilitiesV2.approvals.supportsCommandApproval);
    assert.isFalse(PiProviderCapabilitiesV2.tools.supportsMcpTools);
    assert.equal(PiProviderCapabilitiesV2.identity.nativeThreadIds, "strong");
  });

  it.effect("registers the thread from get_state and resumes via switch_session", () =>
    Effect.gen(function* () {
      const fake = yield* makeFakePi;
      const { runtime } = yield* openRuntime(fake);
      const providerThread = yield* runtime.ensureThread({
        threadId: THREAD_ID,
        modelSelection: modelSelection("default"),
        runtimePolicy,
      });
      assert.equal(providerThread.nativeThreadRef?.nativeId, FAKE_SESSION_FILE);
      assert.equal(providerThread.driver, PI_PROVIDER);

      yield* runtime.resumeThread({ providerThread });
      const switchRequest = yield* fake.takeRequest("switch_session");
      assert.equal(switchRequest["sessionPath"], FAKE_SESSION_FILE);
    }).pipe(Effect.scoped, Effect.provide(testLayer)),
  );

  it.effect("keeps the thread usable when an attachment cannot be read", () =>
    Effect.gen(function* () {
      const fake = yield* makeFakePi;
      const { runtime } = yield* openRuntime(fake);
      const providerThread = yield* runtime.ensureThread({
        threadId: THREAD_ID,
        modelSelection: modelSelection("default"),
        runtimePolicy,
      });

      yield* startTurn(runtime, providerThread, "default", [
        {
          type: "image",
          id: "missingpiattachment",
          name: "missing.png",
          mimeType: "image/png",
          sizeBytes: 1,
        },
      ]).pipe(Effect.flip);

      // The failed turn was never installed, so the next one still starts.
      yield* startTurn(runtime, providerThread);
      const prompt = yield* fake.takeRequest("prompt");
      assert.equal(prompt["message"], "Hello pi");
    }).pipe(Effect.scoped, Effect.provide(testLayer)),
  );

  it.effect("streams assistant text and settles a completed turn on agent_settled", () =>
    Effect.gen(function* () {
      const fake = yield* makeFakePi;
      const { runtime, takeEvent } = yield* openRuntime(fake);
      const providerThread = yield* runtime.ensureThread({
        threadId: THREAD_ID,
        modelSelection: modelSelection("default"),
        runtimePolicy,
      });
      yield* startTurn(runtime, providerThread);
      const prompt = yield* fake.takeRequest("prompt");
      assert.equal(prompt["message"], "Hello pi");
      // Fire-and-forget: extension slash commands can hold the ack open on a
      // user dialog, so the prompt must carry no correlation id to await.
      assert.equal(prompt["id"], undefined);

      yield* fake.emit({ type: "agent_start" });
      yield* fake.emit({ type: "message_start", message: { role: "assistant" } });
      yield* fake.emit({
        type: "message_update",
        assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "Hel" },
      });
      yield* fake.emit({
        type: "message_update",
        assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "lo" },
      });
      yield* fake.emit({
        type: "message_update",
        assistantMessageEvent: { type: "text_end", contentIndex: 0, content: "Hello" },
      });
      yield* fake.emit({
        type: "message_end",
        message: {
          role: "assistant",
          content: [{ type: "text", text: "Hello" }],
          stopReason: "stop",
        },
      });
      yield* fake.emit({ type: "agent_end", messages: [], willRetry: false });
      yield* fake.emit({ type: "agent_settled" });

      const assistantItem = yield* takeEvent(
        (event) =>
          event.type === "turn_item.updated" &&
          event.turnItem.type === "assistant_message" &&
          event.turnItem.streaming === false,
      );
      assert.isTrue(
        assistantItem.type === "turn_item.updated" &&
          assistantItem.turnItem.type === "assistant_message" &&
          assistantItem.turnItem.text === "Hello",
      );
      const terminal = yield* takeEvent((event) => event.type === "turn.terminal");
      assert.isTrue(terminal.type === "turn.terminal" && terminal.status === "completed");
    }).pipe(Effect.scoped, Effect.provide(testLayer)),
  );

  it.effect("syncs the thread title into pi's session name before prompting", () =>
    Effect.gen(function* () {
      const fake = yield* makeFakePi;
      const { runtime } = yield* openRuntime(fake);
      const providerThread = yield* runtime.ensureThread({
        threadId: THREAD_ID,
        modelSelection: modelSelection("default"),
        runtimePolicy,
      });
      yield* startTurn(runtime, providerThread);
      // takeRequest discards preceding records, so this also proves ordering.
      const setName = yield* fake.takeRequest("set_session_name");
      assert.equal(setName["name"], "Pi test thread");
      yield* fake.takeRequest("prompt");
    }).pipe(Effect.scoped, Effect.provide(testLayer)),
  );

  it.effect("captures session-tree refs at turn boundaries and rolls back via fork", () =>
    Effect.gen(function* () {
      const fake = yield* makeFakePi;
      // First get_entries ack baselines the leaf during ensureThread; the
      // second answers the finalize capture with this turn's user entry.
      fake.queueEntries({ entries: [], leafId: "leaf-0" });
      fake.queueEntries({
        entries: [{ type: "message", id: "u1", message: { role: "user" } }],
        leafId: "a1",
      });
      const { runtime, takeEvent } = yield* openRuntime(fake);
      const providerThread = yield* runtime.ensureThread({
        threadId: THREAD_ID,
        modelSelection: modelSelection("default"),
        runtimePolicy,
      });
      yield* startTurn(runtime, providerThread);
      yield* fake.takeRequest("prompt");
      yield* fake.emit({ type: "agent_start" });
      yield* fake.emit({ type: "agent_settled" });
      const finalTurn = yield* takeEvent(
        (event) =>
          event.type === "provider_turn.updated" && event.providerTurn.status === "completed",
      );
      yield* takeEvent((event) => event.type === "turn.terminal");
      assert.isTrue(
        finalTurn.type === "provider_turn.updated" &&
          finalTurn.providerTurn.nativeTurnRef?.nativeId === "u1" &&
          finalTurn.providerTurn.nativeTurnRef.strength === "strong",
      );

      const turnRef = (ordinal: number, nativeId: string): OrchestrationV2ProviderTurn => ({
        id: ProviderTurnId.make(`provider-turn:test:${ordinal}`),
        providerThreadId: providerThread.id,
        nodeId: NodeId.make(`node:test:${ordinal}`),
        runAttemptId: null,
        nativeTurnRef: { driver: PI_PROVIDER, nativeId, strength: "strong" },
        ordinal,
        status: "completed",
        startedAt: null,
        completedAt: null,
      });
      yield* runtime.rollbackThread({
        providerThread,
        target: {
          type: "provider_turn",
          checkpointId: CheckpointId.make("checkpoint:test:1"),
          appRunOrdinal: 1,
          providerTurn: turnRef(1, "u1"),
        },
        providerThreadTurns: [turnRef(1, "u1"), turnRef(2, "u2")],
      });
      const fork = yield* fake.takeRequest("fork");
      assert.equal(fork["entryId"], "u2");
    }).pipe(Effect.scoped, Effect.provide(testLayer)),
  );

  it("resolves rollback fork entries from captured turn refs", () => {
    const turn = (ordinal: number, ref: OrchestrationV2ProviderTurn["nativeTurnRef"]) =>
      ({ ordinal, nativeTurnRef: ref }) as OrchestrationV2ProviderTurn;
    const strong = (nativeId: string) =>
      ({ driver: PI_PROVIDER, nativeId, strength: "strong" }) as const;
    const weak = (nativeId: string) =>
      ({ driver: PI_PROVIDER, nativeId, strength: "weak" }) as const;
    // No turns after the target: nothing to discard.
    assert.isNull(
      piRollbackForkEntry({
        target: { type: "provider_turn", providerTurn: turn(2, strong("u2")) },
        providerThreadTurns: [turn(1, strong("u1")), turn(2, strong("u2"))],
      }),
    );
    // Boundary turn without a captured (strong) entry ref cannot roll back.
    assert.isUndefined(
      piRollbackForkEntry({
        target: { type: "provider_turn", providerTurn: turn(1, strong("u1")) },
        providerThreadTurns: [turn(1, strong("u1")), turn(2, weak("synthetic"))],
      }),
    );
    // thread_start discards everything from the first captured turn.
    assert.equal(
      piRollbackForkEntry({
        target: { type: "thread_start" },
        providerThreadTurns: [turn(2, strong("u2")), turn(1, strong("u1"))],
      }),
      "u1",
    );
  });

  it.effect("presents tools aborted by Stop as interrupted, not failed", () =>
    Effect.gen(function* () {
      const fake = yield* makeFakePi;
      const { runtime, takeEvent } = yield* openRuntime(fake);
      const providerThread = yield* runtime.ensureThread({
        threadId: THREAD_ID,
        modelSelection: modelSelection("default"),
        runtimePolicy,
      });
      yield* startTurn(runtime, providerThread);
      yield* fake.takeRequest("prompt");
      yield* fake.emit({ type: "agent_start" });
      yield* fake.emit({
        type: "tool_execution_start",
        toolCallId: "call_sleep",
        toolName: "bash",
        args: { command: "sleep 30" },
      });
      const running = yield* takeEvent(
        (event) =>
          event.type === "provider_turn.updated" && event.providerTurn.status === "running",
      );
      const providerTurnId =
        running.type === "provider_turn.updated" ? running.providerTurn.id : undefined;

      yield* runtime.interruptTurn({ providerThread, providerTurnId: providerTurnId! });
      yield* fake.takeRequest("abort");
      // Pi reports the aborted tool as an error end before settling.
      yield* fake.emit({
        type: "tool_execution_end",
        toolCallId: "call_sleep",
        toolName: "bash",
        isError: true,
        result: { content: [{ type: "text", text: "Command aborted" }] },
      });
      yield* fake.emit({ type: "agent_settled" });

      const toolItem = yield* takeEvent(
        (event) =>
          event.type === "turn_item.updated" &&
          event.turnItem.type === "command_execution" &&
          event.turnItem.status !== "running",
      );
      assert.isTrue(
        toolItem.type === "turn_item.updated" && toolItem.turnItem.status === "interrupted",
      );
      const terminal = yield* takeEvent((event) => event.type === "turn.terminal");
      assert.isTrue(terminal.type === "turn.terminal" && terminal.status === "interrupted");
    }).pipe(Effect.scoped, Effect.provide(testLayer)),
  );

  it.effect("projects the subagent extension's tasks as native subagents", () =>
    Effect.gen(function* () {
      const fake = yield* makeFakePi;
      const { runtime, takeEvent } = yield* openRuntime(fake);
      const providerThread = yield* runtime.ensureThread({
        threadId: THREAD_ID,
        modelSelection: modelSelection("default"),
        runtimePolicy,
      });
      yield* startTurn(runtime, providerThread);
      yield* fake.takeRequest("prompt");
      yield* fake.emit({ type: "agent_start" });
      yield* fake.emit({
        type: "tool_execution_start",
        toolCallId: "call_sub",
        toolName: "subagent",
        args: { tasks: [{ agent: "scout", task: "map the repo" }] },
      });
      yield* fake.emit({
        type: "tool_execution_update",
        toolCallId: "call_sub",
        toolName: "subagent",
        partialResult: {
          content: [{ type: "text", text: "(running...)" }],
          details: {
            mode: "parallel",
            results: [
              {
                agent: "scout",
                task: "map the repo",
                exitCode: 0,
                stderr: "",
                messages: [
                  { role: "assistant", content: [{ type: "text", text: "scanning files" }] },
                ],
              },
            ],
          },
        },
      });
      const running = yield* takeEvent(
        (event) => event.type === "subagent.updated" && event.subagent.status === "running",
      );
      assert.isTrue(
        running.type === "subagent.updated" &&
          running.subagent.title === "scout" &&
          running.subagent.prompt === "map the repo" &&
          running.subagent.progress === "scanning files",
      );
      yield* fake.emit({
        type: "tool_execution_end",
        toolCallId: "call_sub",
        toolName: "subagent",
        isError: false,
        result: {
          content: [{ type: "text", text: "done" }],
          details: {
            mode: "parallel",
            results: [
              {
                agent: "scout",
                task: "map the repo",
                exitCode: 0,
                stopReason: "stop",
                stderr: "",
                messages: [
                  { role: "assistant", content: [{ type: "text", text: "repo has one file" }] },
                ],
              },
              {
                agent: "worker",
                task: "broken task",
                exitCode: 1,
                stderr: "boom",
                messages: [],
              },
            ],
          },
        },
      });
      const doneCard = yield* takeEvent(
        (event) => event.type === "subagent.updated" && event.subagent.status === "completed",
      );
      assert.isTrue(
        doneCard.type === "subagent.updated" && doneCard.subagent.result === "repo has one file",
      );
      const failedCard = yield* takeEvent(
        (event) => event.type === "subagent.updated" && event.subagent.status === "failed",
      );
      assert.isTrue(
        failedCard.type === "subagent.updated" &&
          failedCard.subagent.title === "worker" &&
          failedCard.subagent.result === "boom",
      );
      const subagentItem = yield* takeEvent(
        (event) => event.type === "turn_item.updated" && event.turnItem.type === "subagent",
      );
      assert.equal(subagentItem.type, "turn_item.updated");
    }).pipe(Effect.scoped, Effect.provide(testLayer)),
  );

  it.effect("settles a command-only prompt from its deferred ack and idle probe", () =>
    Effect.gen(function* () {
      const fake = yield* makeFakePi;
      const { runtime, takeEvent } = yield* openRuntime(fake);
      const providerThread = yield* runtime.ensureThread({
        threadId: THREAD_ID,
        modelSelection: modelSelection("default"),
        runtimePolicy,
      });
      yield* startTurn(runtime, providerThread);
      yield* fake.takeRequest("prompt");
      // A pure extension command: dialog + notify, then the deferred ack —
      // pi emits no agent_start/agent_settled at all.
      yield* fake.emit({
        type: "extension_ui_request",
        id: "ui-cmd",
        method: "notify",
        message: "done",
        notifyType: "info",
      });
      yield* fake.emit({ type: "response", command: "prompt", success: true });
      // The adapter probes get_state (auto-acked idle by the fake), then
      // settles the turn as completed.
      const terminal = yield* takeEvent((event) => event.type === "turn.terminal");
      assert.isTrue(terminal.type === "turn.terminal" && terminal.status === "completed");
    }).pipe(Effect.scoped, Effect.provide(testLayer)),
  );

  it.effect("fails the turn when pi rejects a fire-and-forget prompt", () =>
    Effect.gen(function* () {
      const fake = yield* makeFakePi;
      const { runtime, takeEvent } = yield* openRuntime(fake);
      const providerThread = yield* runtime.ensureThread({
        threadId: THREAD_ID,
        modelSelection: modelSelection("default"),
        runtimePolicy,
      });
      yield* startTurn(runtime, providerThread);
      yield* fake.takeRequest("prompt");
      yield* fake.emit({ type: "response", command: "prompt", success: false, error: "boom" });

      const terminal = yield* takeEvent((event) => event.type === "turn.terminal");
      assert.isTrue(terminal.type === "turn.terminal" && terminal.status === "failed");
      assert.isTrue(
        terminal.type === "turn.terminal" &&
          terminal.status === "failed" &&
          terminal.failure.message === "boom",
      );
    }).pipe(Effect.scoped, Effect.provide(testLayer)),
  );

  it.effect("keeps the turn open across agent_end and fails it on final retry failure", () =>
    Effect.gen(function* () {
      const fake = yield* makeFakePi;
      const { runtime, takeEvent } = yield* openRuntime(fake);
      const providerThread = yield* runtime.ensureThread({
        threadId: THREAD_ID,
        modelSelection: modelSelection("default"),
        runtimePolicy,
      });
      yield* startTurn(runtime, providerThread);
      yield* fake.takeRequest("prompt");

      yield* fake.emit({ type: "agent_start" });
      yield* fake.emit({ type: "agent_end", messages: [], willRetry: true });
      yield* fake.emit({
        type: "auto_retry_end",
        success: false,
        attempt: 3,
        finalError: "529 overloaded",
      });
      yield* fake.emit({ type: "agent_settled" });

      const terminal = yield* takeEvent((event) => event.type === "turn.terminal");
      assert.isTrue(terminal.type === "turn.terminal" && terminal.status === "failed");
      assert.isTrue(
        terminal.type === "turn.terminal" &&
          terminal.status === "failed" &&
          terminal.failure.message.includes("overloaded"),
      );
    }).pipe(Effect.scoped, Effect.provide(testLayer)),
  );

  it.effect("interrupts with abort and settles the turn as interrupted", () =>
    Effect.gen(function* () {
      const fake = yield* makeFakePi;
      const { runtime, takeEvent } = yield* openRuntime(fake);
      const providerThread = yield* runtime.ensureThread({
        threadId: THREAD_ID,
        modelSelection: modelSelection("default"),
        runtimePolicy,
      });
      yield* startTurn(runtime, providerThread);
      yield* fake.takeRequest("prompt");
      yield* fake.emit({ type: "agent_start" });

      const running = yield* takeEvent(
        (event) =>
          event.type === "provider_turn.updated" && event.providerTurn.status === "running",
      );
      assert.equal(running.type, "provider_turn.updated");
      const providerTurnId =
        running.type === "provider_turn.updated" ? running.providerTurn.id : undefined;
      assert.isDefined(providerTurnId);

      yield* runtime.interruptTurn({ providerThread, providerTurnId: providerTurnId! });
      yield* fake.takeRequest("abort");
      yield* fake.emit({ type: "agent_settled" });

      const terminal = yield* takeEvent((event) => event.type === "turn.terminal");
      assert.isTrue(terminal.type === "turn.terminal" && terminal.status === "interrupted");
    }).pipe(Effect.scoped, Effect.provide(testLayer)),
  );

  it.effect(
    "applies an explicit model before prompting and skips set_model for the Pi default",
    () =>
      Effect.gen(function* () {
        const fake = yield* makeFakePi;
        const { runtime } = yield* openRuntime(fake, "anthropic/claude-sonnet-5");
        const providerThread = yield* runtime.ensureThread({
          threadId: THREAD_ID,
          modelSelection: modelSelection("anthropic/claude-sonnet-5"),
          runtimePolicy,
        });
        yield* startTurn(runtime, providerThread, "anthropic/claude-sonnet-5");
        const setModel = yield* fake.takeRequest("set_model");
        assert.equal(setModel["provider"], "anthropic");
        assert.equal(setModel["modelId"], "claude-sonnet-5");
        yield* fake.takeRequest("prompt");
      }).pipe(Effect.scoped, Effect.provide(testLayer)),
  );

  it.effect("bridges extension select dialogs to runtime requests and answers them", () =>
    Effect.gen(function* () {
      const fake = yield* makeFakePi;
      const { runtime, takeEvent } = yield* openRuntime(fake);
      const providerThread = yield* runtime.ensureThread({
        threadId: THREAD_ID,
        modelSelection: modelSelection("default"),
        runtimePolicy,
      });
      yield* startTurn(runtime, providerThread);
      yield* fake.takeRequest("prompt");
      yield* fake.emit({ type: "agent_start" });
      yield* fake.emit({
        type: "extension_ui_request",
        id: "ui-1",
        method: "select",
        title: "Pick one",
        options: ["Allow", "Block"],
      });

      const pending = yield* takeEvent(
        (event) =>
          event.type === "runtime_request.updated" && event.runtimeRequest.status === "pending",
      );
      assert.isTrue(
        pending.type === "runtime_request.updated" && pending.runtimeRequest.kind === "user_input",
      );
      const requestItem = yield* takeEvent(
        (event) =>
          event.type === "turn_item.updated" && event.turnItem.type === "user_input_request",
      );
      assert.isTrue(
        requestItem.type === "turn_item.updated" &&
          requestItem.turnItem.type === "user_input_request" &&
          requestItem.turnItem.questions[0]?.options.length === 2,
      );

      const requestId =
        pending.type === "runtime_request.updated" ? pending.runtimeRequest.id : undefined;
      yield* runtime.respondToRuntimeRequest({
        requestId: requestId!,
        answers: { "ui-1": "Allow" },
      });
      const uiResponse = yield* fake.takeRequest("extension_ui_response");
      assert.equal(uiResponse["id"], "ui-1");
      assert.equal(uiResponse["value"], "Allow");

      const resolved = yield* takeEvent(
        (event) =>
          event.type === "runtime_request.updated" && event.runtimeRequest.status === "resolved",
      );
      assert.equal(resolved.type, "runtime_request.updated");
    }).pipe(Effect.scoped, Effect.provide(testLayer)),
  );

  it.effect("cancels unanswered extension dialogs when the turn settles", () =>
    Effect.gen(function* () {
      const fake = yield* makeFakePi;
      const { runtime, takeEvent } = yield* openRuntime(fake);
      const providerThread = yield* runtime.ensureThread({
        threadId: THREAD_ID,
        modelSelection: modelSelection("default"),
        runtimePolicy,
      });
      yield* startTurn(runtime, providerThread);
      yield* fake.takeRequest("prompt");
      yield* fake.emit({ type: "agent_start" });
      yield* fake.emit({
        type: "extension_ui_request",
        id: "ui-2",
        method: "confirm",
        title: "Continue?",
        message: "Really continue?",
      });
      yield* takeEvent(
        (event) =>
          event.type === "runtime_request.updated" && event.runtimeRequest.status === "pending",
      );
      yield* fake.emit({ type: "agent_settled" });

      const cancelledResponse = yield* fake.takeRequest("extension_ui_response");
      assert.equal(cancelledResponse["id"], "ui-2");
      assert.equal(cancelledResponse["cancelled"], true);
      const cancelled = yield* takeEvent(
        (event) =>
          event.type === "runtime_request.updated" && event.runtimeRequest.status === "cancelled",
      );
      assert.equal(cancelled.type, "runtime_request.updated");
    }).pipe(Effect.scoped, Effect.provide(testLayer)),
  );

  it.effect("steers the active turn through pi's native steer command", () =>
    Effect.gen(function* () {
      const fake = yield* makeFakePi;
      const { runtime, takeEvent } = yield* openRuntime(fake);
      const providerThread = yield* runtime.ensureThread({
        threadId: THREAD_ID,
        modelSelection: modelSelection("default"),
        runtimePolicy,
      });
      yield* startTurn(runtime, providerThread);
      yield* fake.takeRequest("prompt");
      const running = yield* takeEvent(
        (event) =>
          event.type === "provider_turn.updated" && event.providerTurn.status === "running",
      );
      const providerTurnId =
        running.type === "provider_turn.updated" ? running.providerTurn.id : undefined;

      yield* runtime.steerTurn({
        threadId: THREAD_ID,
        runId: RunId.make("run:thread-pi-test:1"),
        providerThread,
        providerTurnId: providerTurnId!,
        message: {
          messageId: "message:thread-pi-test:steer" as never,
          text: "Focus on tests",
          attachments: [],
          createdBy: "user",
          creationSource: "web",
        },
      });
      const steer = yield* fake.takeRequest("steer");
      assert.equal(steer["message"], "Focus on tests");
    }).pipe(Effect.scoped, Effect.provide(testLayer)),
  );
});

describe("PiRpc framing", () => {
  it.effect("reassembles records across chunk boundaries and strips CR", () =>
    Effect.gen(function* () {
      const stdout = yield* Queue.unbounded<Uint8Array>();
      const spawner = ChildProcessSpawner.make(() =>
        Effect.succeed(
          ChildProcessSpawner.makeHandle({
            pid: ChildProcessSpawner.ProcessId(FAKE_PID),
            exitCode: Effect.never,
            isRunning: Effect.succeed(true),
            kill: () => Effect.void,
            unref: Effect.succeed(Effect.void),
            stdin: Sink.drain,
            stdout: Stream.fromQueue(stdout),
            stderr: Stream.empty,
            all: Stream.empty,
            getInputFd: () => Sink.drain,
            getOutputFd: () => Stream.empty,
          }),
        ),
      );
      const connection = yield* makePiRpcConnection({
        command: "pi",
        args: ["--mode", "rpc"],
        cwd: undefined,
        env: {},
      }).pipe(Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner));

      const push = (text: string) =>
        Queue.offer(stdout, new TextEncoder().encode(text)).pipe(Effect.asVoid);
      yield* push('{"type":"agent_');
      yield* push('start"}\r\n{"type":"agent_settled"}\nnot json\n{"type":"queue_update"}\n');

      const first = yield* Queue.take(connection.events);
      assert.equal(first["type"], "agent_start");
      const second = yield* Queue.take(connection.events);
      assert.equal(second["type"], "agent_settled");
      const third = yield* Queue.take(connection.events);
      assert.equal(third["type"], "queue_update");
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );
});
