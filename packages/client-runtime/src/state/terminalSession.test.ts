import { describe, expect, it } from "vite-plus/test";

import { EnvironmentId, TerminalSessionSnapshot, ThreadId } from "@t3tools/contracts";

import {
  applyTerminalAttachStreamEvent,
  applyTerminalMetadataStreamEvent,
  combineTerminalSessionState,
  EMPTY_TERMINAL_BUFFER_STATE,
  readTerminalOutputUpdate,
  selectRunningSubprocessTerminalIds,
  terminalOutputText,
  terminalOutputRetentionBytes,
} from "./terminalSession.ts";

const TARGET = {
  environmentId: EnvironmentId.make("env-local"),
  threadId: ThreadId.make("thread-1"),
  terminalId: "term-1",
} as const;

const BASE_SNAPSHOT: TerminalSessionSnapshot = {
  threadId: TARGET.threadId,
  terminalId: TARGET.terminalId,
  cwd: "/repo",
  worktreePath: null,
  status: "running",
  pid: 123,
  history: "hello",
  exitCode: null,
  exitSignal: null,
  label: "Terminal 1",
  updatedAt: "2026-04-01T00:00:00.000Z",
};

describe("terminal session reducers", () => {
  it("retains adjacent maximum-size events after the smaller initial replay", () => {
    const retentionBytes = terminalOutputRetentionBytes(64 * 1024);
    expect(retentionBytes).toBe(512 * 1024);
    expect(terminalOutputRetentionBytes(4 * 1024 * 1024)).toBe(4 * 1024 * 1024);

    const snapshot = applyTerminalAttachStreamEvent(
      EMPTY_TERMINAL_BUFFER_STATE,
      { type: "snapshot", snapshot: { ...BASE_SNAPSHOT, history: "" } },
      retentionBytes,
    );
    const cursor = {
      resetVersion: snapshot.output.resetVersion,
      lastChunkId: snapshot.output.latestChunkId,
    };
    const first = applyTerminalAttachStreamEvent(
      snapshot,
      {
        type: "output",
        threadId: TARGET.threadId,
        terminalId: TARGET.terminalId,
        data: "a".repeat(64 * 1024),
      },
      retentionBytes,
    );
    const second = applyTerminalAttachStreamEvent(
      first,
      {
        type: "output",
        threadId: TARGET.threadId,
        terminalId: TARGET.terminalId,
        data: "b".repeat(64 * 1024),
      },
      retentionBytes,
    );

    const update = readTerminalOutputUpdate(second.output, cursor);
    if (update.type !== "append") throw new Error(`Expected append, received ${update.type}`);
    expect(update.data).toHaveLength(128 * 1024);
  });

  it("prefers live attach status over stale metadata after the attach stream starts", () => {
    const summary = applyTerminalMetadataStreamEvent([], {
      type: "snapshot",
      terminals: [
        {
          threadId: BASE_SNAPSHOT.threadId,
          terminalId: BASE_SNAPSHOT.terminalId,
          cwd: BASE_SNAPSHOT.cwd,
          worktreePath: BASE_SNAPSHOT.worktreePath,
          status: "running",
          pid: BASE_SNAPSHOT.pid,
          exitCode: BASE_SNAPSHOT.exitCode,
          exitSignal: BASE_SNAPSHOT.exitSignal,
          updatedAt: BASE_SNAPSHOT.updatedAt,
          hasRunningSubprocess: false,
          label: BASE_SNAPSHOT.label,
        },
      ],
    })[0]!;
    const attached = applyTerminalAttachStreamEvent(EMPTY_TERMINAL_BUFFER_STATE, {
      type: "error",
      threadId: TARGET.threadId,
      terminalId: TARGET.terminalId,
      message: "Terminal disconnected.",
    });

    expect(combineTerminalSessionState(summary, attached)).toMatchObject({
      status: "error",
      error: "Terminal disconnected.",
      version: 1,
    });
  });

  it("uses metadata status before an attach stream has emitted", () => {
    const summary = applyTerminalMetadataStreamEvent([], {
      type: "snapshot",
      terminals: [
        {
          threadId: BASE_SNAPSHOT.threadId,
          terminalId: BASE_SNAPSHOT.terminalId,
          cwd: BASE_SNAPSHOT.cwd,
          worktreePath: BASE_SNAPSHOT.worktreePath,
          status: "running",
          pid: BASE_SNAPSHOT.pid,
          exitCode: BASE_SNAPSHOT.exitCode,
          exitSignal: BASE_SNAPSHOT.exitSignal,
          updatedAt: BASE_SNAPSHOT.updatedAt,
          hasRunningSubprocess: false,
          label: BASE_SNAPSHOT.label,
        },
      ],
    })[0]!;

    expect(combineTerminalSessionState(summary, EMPTY_TERMINAL_BUFFER_STATE).status).toBe(
      "running",
    );
  });

  it("does not treat an idle running shell as a running subprocess", () => {
    const idleSession = {
      target: TARGET,
      state: {
        ...combineTerminalSessionState(null, EMPTY_TERMINAL_BUFFER_STATE),
        status: "running" as const,
        hasRunningSubprocess: false,
      },
    };
    const activeSession = {
      target: { ...TARGET, terminalId: "term-2" },
      state: {
        ...idleSession.state,
        hasRunningSubprocess: true,
      },
    };

    expect(selectRunningSubprocessTerminalIds([idleSession, activeSession])).toEqual(["term-2"]);
  });

  it("reduces attach snapshots and output without an imperative session manager", () => {
    const snapshot = applyTerminalAttachStreamEvent(EMPTY_TERMINAL_BUFFER_STATE, {
      type: "snapshot",
      snapshot: BASE_SNAPSHOT,
    });
    const output = applyTerminalAttachStreamEvent(
      snapshot,
      {
        type: "output",
        threadId: TARGET.threadId,
        terminalId: TARGET.terminalId,
        data: " world",
      },
      8,
    );

    expect(output).toMatchObject({
      status: "running",
      error: null,
      version: 2,
    });
    expect(output.output.retainedBytes).toBeLessThanOrEqual(8);
    expect(terminalOutputText(output.output)).toBe(" world");
  });

  it("advances repeated snapshots so renderers apply overflow resyncs", () => {
    const first = applyTerminalAttachStreamEvent(EMPTY_TERMINAL_BUFFER_STATE, {
      type: "snapshot",
      snapshot: BASE_SNAPSHOT,
    });
    const second = applyTerminalAttachStreamEvent(first, {
      type: "snapshot",
      snapshot: { ...BASE_SNAPSHOT, history: "resynced" },
    });
    const cleared = applyTerminalAttachStreamEvent(second, {
      type: "cleared",
      threadId: TARGET.threadId,
      terminalId: TARGET.terminalId,
      sequence: 1,
    });

    expect(second.version).toBe(2);
    expect(second.replayStartVersion).toBe(0);
    expect(cleared.replayStartVersion).toBe(0);
    expect(terminalOutputText(second.output)).toBe("resynced");
  });

  it("tracks replay boundaries independently from snapshots and output", () => {
    const started = applyTerminalAttachStreamEvent(EMPTY_TERMINAL_BUFFER_STATE, {
      type: "replay-start",
      threadId: TARGET.threadId,
      terminalId: TARGET.terminalId,
      sequence: 1,
    });
    const snapshot = applyTerminalAttachStreamEvent(started, {
      type: "snapshot",
      snapshot: BASE_SNAPSHOT,
    });
    const completed = applyTerminalAttachStreamEvent(snapshot, {
      type: "replay-complete",
      threadId: TARGET.threadId,
      terminalId: TARGET.terminalId,
      sequence: 1,
    });
    const reconnected = applyTerminalAttachStreamEvent(completed, {
      type: "replay-start",
      threadId: TARGET.threadId,
      terminalId: TARGET.terminalId,
      sequence: 2,
    });

    expect(completed).toMatchObject({ replayStartVersion: 1, replayCompleteVersion: 1 });
    expect(reconnected).toMatchObject({ replayStartVersion: 2, replayCompleteVersion: 1 });
  });

  it("does not make replay-start override metadata before its snapshot arrives", () => {
    const summary = applyTerminalMetadataStreamEvent([], {
      type: "snapshot",
      terminals: [
        {
          threadId: BASE_SNAPSHOT.threadId,
          terminalId: BASE_SNAPSHOT.terminalId,
          cwd: BASE_SNAPSHOT.cwd,
          worktreePath: BASE_SNAPSHOT.worktreePath,
          status: "running",
          pid: BASE_SNAPSHOT.pid,
          exitCode: BASE_SNAPSHOT.exitCode,
          exitSignal: BASE_SNAPSHOT.exitSignal,
          updatedAt: BASE_SNAPSHOT.updatedAt,
          hasRunningSubprocess: false,
          label: BASE_SNAPSHOT.label,
        },
      ],
    })[0]!;
    const started = applyTerminalAttachStreamEvent(EMPTY_TERMINAL_BUFFER_STATE, {
      type: "replay-start",
      threadId: TARGET.threadId,
      terminalId: TARGET.terminalId,
      sequence: 1,
    });

    expect(started.version).toBe(0);
    expect(started.replayStartVersion).toBe(1);
    expect(combineTerminalSessionState(summary, started).status).toBe("running");
  });

  it("reduces terminal metadata snapshots, upserts, and removals", () => {
    const initial = applyTerminalMetadataStreamEvent([], {
      type: "snapshot",
      terminals: [
        {
          threadId: BASE_SNAPSHOT.threadId,
          terminalId: BASE_SNAPSHOT.terminalId,
          cwd: BASE_SNAPSHOT.cwd,
          worktreePath: BASE_SNAPSHOT.worktreePath,
          status: BASE_SNAPSHOT.status,
          pid: BASE_SNAPSHOT.pid,
          exitCode: BASE_SNAPSHOT.exitCode,
          exitSignal: BASE_SNAPSHOT.exitSignal,
          updatedAt: BASE_SNAPSHOT.updatedAt,
          hasRunningSubprocess: false,
          label: BASE_SNAPSHOT.label,
        },
      ],
    });
    const updated = applyTerminalMetadataStreamEvent(initial, {
      type: "upsert",
      terminal: {
        ...initial[0]!,
        hasRunningSubprocess: true,
      },
    });
    const removed = applyTerminalMetadataStreamEvent(updated, {
      type: "remove",
      threadId: TARGET.threadId,
      terminalId: TARGET.terminalId,
    });

    expect(updated).toHaveLength(1);
    expect(updated[0]?.hasRunningSubprocess).toBe(true);
    expect(removed).toEqual([]);
  });

  it("caps retained output by UTF-8 byte length", () => {
    const state = applyTerminalAttachStreamEvent(
      EMPTY_TERMINAL_BUFFER_STATE,
      {
        type: "output",
        threadId: TARGET.threadId,
        terminalId: TARGET.terminalId,
        data: "🙂🙂",
      },
      4,
    );

    expect(terminalOutputText(state.output)).toBe("🙂");
    expect(state.output.retainedBytes).toBe(4);
  });

  it("clears a renderer when the byte budget cannot retain an output character", () => {
    const initial = applyTerminalAttachStreamEvent(
      EMPTY_TERMINAL_BUFFER_STATE,
      {
        type: "output",
        threadId: TARGET.threadId,
        terminalId: TARGET.terminalId,
        data: "a",
      },
      1,
    );
    const cursor = {
      resetVersion: initial.output.resetVersion,
      lastChunkId: initial.output.latestChunkId,
    };
    const dropped = applyTerminalAttachStreamEvent(
      initial,
      {
        type: "output",
        threadId: TARGET.threadId,
        terminalId: TARGET.terminalId,
        data: "🙂",
      },
      1,
    );

    expect(readTerminalOutputUpdate(dropped.output, cursor)).toMatchObject({
      type: "reset",
      data: "",
    });
  });

  it("delivers every append when multiple events reduce before the renderer reads", () => {
    const snapshot = applyTerminalAttachStreamEvent(EMPTY_TERMINAL_BUFFER_STATE, {
      type: "snapshot",
      snapshot: BASE_SNAPSHOT,
    });
    const cursor = {
      resetVersion: snapshot.output.resetVersion,
      lastChunkId: snapshot.output.latestChunkId,
    };
    const first = applyTerminalAttachStreamEvent(snapshot, {
      type: "output",
      threadId: TARGET.threadId,
      terminalId: TARGET.terminalId,
      data: " first",
    });
    const second = applyTerminalAttachStreamEvent(first, {
      type: "output",
      threadId: TARGET.threadId,
      terminalId: TARGET.terminalId,
      data: " second",
    });

    expect(readTerminalOutputUpdate(second.output, cursor)).toMatchObject({
      type: "append",
      data: " first second",
    });
  });

  it("resets a renderer that falls behind retained output", () => {
    const first = applyTerminalAttachStreamEvent(
      EMPTY_TERMINAL_BUFFER_STATE,
      {
        type: "output",
        threadId: TARGET.threadId,
        terminalId: TARGET.terminalId,
        data: "first",
      },
      6,
    );
    const staleCursor = {
      resetVersion: first.output.resetVersion,
      lastChunkId: first.output.latestChunkId,
    };
    const second = applyTerminalAttachStreamEvent(
      first,
      {
        type: "output",
        threadId: TARGET.threadId,
        terminalId: TARGET.terminalId,
        data: "second",
      },
      6,
    );
    const third = applyTerminalAttachStreamEvent(
      second,
      {
        type: "output",
        threadId: TARGET.threadId,
        terminalId: TARGET.terminalId,
        data: "third",
      },
      6,
    );

    expect(readTerminalOutputUpdate(third.output, staleCursor)).toMatchObject({
      type: "reset",
      data: "third",
    });
  });

  it("bounds chunk metadata without losing small output events", () => {
    let state = EMPTY_TERMINAL_BUFFER_STATE;
    for (let index = 0; index < 1_025; index += 1) {
      state = applyTerminalAttachStreamEvent(state, {
        type: "output",
        threadId: TARGET.threadId,
        terminalId: TARGET.terminalId,
        data: "x",
      });
    }

    expect(state.output.chunks.length).toBeLessThan(1_025);
    expect(terminalOutputText(state.output)).toBe("x".repeat(1_025));
    expect(state.output.resetVersion).toBe(1);
  });
});
