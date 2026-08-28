import {
  DEFAULT_TERMINAL_REPLAY_BYTES,
  type EnvironmentId,
  type TerminalAttachStreamEvent,
  type TerminalMetadataStreamEvent,
  type TerminalSessionSnapshot,
  type TerminalSummary,
  type ThreadId,
} from "@t3tools/contracts";

export interface TerminalOutputChunk {
  readonly id: number;
  readonly data: string;
  readonly byteLength: number;
}

export interface TerminalOutputState {
  readonly chunks: ReadonlyArray<TerminalOutputChunk>;
  readonly retainedBytes: number;
  readonly resetVersion: number;
  readonly latestChunkId: number;
}

export interface TerminalOutputCursor {
  readonly resetVersion: number;
  readonly lastChunkId: number;
}

export type TerminalOutputUpdate =
  | {
      readonly type: "none";
      readonly cursor: TerminalOutputCursor;
    }
  | {
      readonly type: "append" | "reset";
      readonly data: string;
      readonly cursor: TerminalOutputCursor;
    };

export interface TerminalSessionState {
  readonly summary: TerminalSummary | null;
  readonly output: TerminalOutputState;
  readonly status: TerminalSessionSnapshot["status"] | "closed";
  readonly error: string | null;
  readonly hasRunningSubprocess: boolean;
  readonly updatedAt: string | null;
  readonly replayStartVersion: number;
  readonly replayCompleteVersion: number;
  readonly version: number;
}

export interface TerminalBufferState {
  readonly output: TerminalOutputState;
  readonly status: TerminalSessionSnapshot["status"] | "closed";
  readonly error: string | null;
  readonly updatedAt: string | null;
  readonly replayStartVersion: number;
  readonly replayCompleteVersion: number;
  readonly version: number;
}

export interface KnownTerminalSessionTarget {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
  readonly terminalId: string;
}

export interface KnownTerminalSession {
  readonly target: KnownTerminalSessionTarget;
  readonly state: TerminalSessionState;
}

export function selectRunningSubprocessTerminalIds(
  sessions: ReadonlyArray<KnownTerminalSession>,
): ReadonlyArray<string> {
  return sessions
    .filter((session) => session.state.hasRunningSubprocess)
    .map((session) => session.target.terminalId);
}

export const EMPTY_TERMINAL_BUFFER_STATE = Object.freeze<TerminalBufferState>({
  output: Object.freeze({
    chunks: Object.freeze([]),
    retainedBytes: 0,
    resetVersion: 0,
    latestChunkId: 0,
  }),
  status: "closed",
  error: null,
  updatedAt: null,
  replayStartVersion: 0,
  replayCompleteVersion: 0,
  version: 0,
});

export const EMPTY_TERMINAL_SESSION_STATE = Object.freeze<TerminalSessionState>({
  summary: null,
  output: EMPTY_TERMINAL_BUFFER_STATE.output,
  status: "closed",
  error: null,
  hasRunningSubprocess: false,
  updatedAt: null,
  replayStartVersion: 0,
  replayCompleteVersion: 0,
  version: 0,
});

export const DEFAULT_MAX_TERMINAL_BUFFER_BYTES = DEFAULT_TERMINAL_REPLAY_BYTES;
const DEFAULT_TERMINAL_CHUNK_BYTES = 16 * 1024;
const MAX_TERMINAL_OUTPUT_CHUNKS = 1_024;
const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();

function trimBufferToBytes(buffer: string, maxBufferBytes: number): string {
  if (maxBufferBytes <= 0) {
    return "";
  }

  const encoded = textEncoder.encode(buffer);
  if (encoded.byteLength <= maxBufferBytes) {
    return buffer;
  }

  let start = encoded.byteLength - maxBufferBytes;
  while (start < encoded.length) {
    const byte = encoded[start];
    if (byte === undefined || (byte & 0b1100_0000) !== 0b1000_0000) {
      break;
    }
    start += 1;
  }

  return textDecoder.decode(encoded.subarray(start));
}

function splitOutputChunks(
  data: string,
  firstChunkId: number,
  maxChunkBytes = DEFAULT_TERMINAL_CHUNK_BYTES,
): {
  readonly chunks: ReadonlyArray<TerminalOutputChunk>;
  readonly latestChunkId: number;
  readonly byteLength: number;
} {
  if (data.length === 0) {
    return { chunks: [], latestChunkId: firstChunkId - 1, byteLength: 0 };
  }

  const encoded = textEncoder.encode(data);
  const chunks: TerminalOutputChunk[] = [];
  let offset = 0;
  let nextChunkId = firstChunkId;
  while (offset < encoded.byteLength) {
    let end = Math.min(offset + maxChunkBytes, encoded.byteLength);
    while (end < encoded.byteLength && ((encoded[end] ?? 0) & 0xc0) === 0x80) {
      end -= 1;
    }
    if (end === offset) {
      end = Math.min(offset + maxChunkBytes, encoded.byteLength);
      while (end < encoded.byteLength && ((encoded[end] ?? 0) & 0xc0) === 0x80) {
        end += 1;
      }
    }
    const bytes = encoded.subarray(offset, end);
    chunks.push({
      id: nextChunkId,
      data: textDecoder.decode(bytes),
      byteLength: bytes.byteLength,
    });
    nextChunkId += 1;
    offset = end;
  }

  return {
    chunks,
    latestChunkId: nextChunkId - 1,
    byteLength: encoded.byteLength,
  };
}

function appendOutput(
  current: TerminalOutputState,
  data: string,
  maxBufferBytes: number,
): TerminalOutputState {
  const appended = splitOutputChunks(
    data,
    current.latestChunkId + 1,
    Math.min(DEFAULT_TERMINAL_CHUNK_BYTES, Math.max(1, maxBufferBytes)),
  );
  if (appended.chunks.length === 0) return current;
  if (maxBufferBytes <= 0) {
    return {
      chunks: [],
      retainedBytes: 0,
      resetVersion: current.resetVersion + 1,
      latestChunkId: appended.latestChunkId,
    };
  }

  const chunks = [...current.chunks, ...appended.chunks];
  let retainedBytes = current.retainedBytes + appended.byteLength;
  let firstRetainedIndex = 0;
  while (retainedBytes > maxBufferBytes && firstRetainedIndex < chunks.length) {
    retainedBytes -= chunks[firstRetainedIndex]?.byteLength ?? 0;
    firstRetainedIndex += 1;
  }

  const retainedChunks = firstRetainedIndex === 0 ? chunks : chunks.slice(firstRetainedIndex);
  if (retainedChunks.length === 0) {
    return {
      chunks: [],
      retainedBytes: 0,
      resetVersion: current.resetVersion + 1,
      latestChunkId: appended.latestChunkId,
    };
  }
  if (retainedChunks.length > MAX_TERMINAL_OUTPUT_CHUNKS) {
    return resetOutput(
      {
        ...current,
        latestChunkId: appended.latestChunkId,
      },
      retainedChunks.map((chunk) => chunk.data).join(""),
      maxBufferBytes,
    );
  }

  return {
    chunks: retainedChunks,
    retainedBytes,
    resetVersion: current.resetVersion,
    latestChunkId: appended.latestChunkId,
  };
}

function resetOutput(
  current: TerminalOutputState,
  data: string,
  maxBufferBytes: number,
): TerminalOutputState {
  const retained = trimBufferToBytes(data, maxBufferBytes);
  const reset = splitOutputChunks(
    retained,
    current.latestChunkId + 1,
    Math.min(DEFAULT_TERMINAL_CHUNK_BYTES, Math.max(1, maxBufferBytes)),
  );
  return {
    chunks: reset.chunks,
    retainedBytes: reset.byteLength,
    resetVersion: current.resetVersion + 1,
    latestChunkId: reset.latestChunkId,
  };
}

export function terminalOutputText(output: TerminalOutputState): string {
  return output.chunks.map((chunk) => chunk.data).join("");
}

export function readTerminalOutputUpdate(
  output: TerminalOutputState,
  cursor: TerminalOutputCursor,
): TerminalOutputUpdate {
  const nextCursor = {
    resetVersion: output.resetVersion,
    lastChunkId: output.latestChunkId,
  };
  const firstChunk = output.chunks[0];
  if (
    cursor.resetVersion !== output.resetVersion ||
    (firstChunk !== undefined && firstChunk.id > cursor.lastChunkId + 1)
  ) {
    return { type: "reset", data: terminalOutputText(output), cursor: nextCursor };
  }

  const appended = output.chunks.filter((chunk) => chunk.id > cursor.lastChunkId);
  if (appended.length === 0) {
    return { type: "none", cursor: nextCursor };
  }
  return {
    type: "append",
    data: appended.map((chunk) => chunk.data).join(""),
    cursor: nextCursor,
  };
}

export function terminalBufferStateFromSnapshot(
  snapshot: TerminalSessionSnapshot,
  maxBufferBytes: number,
  current: TerminalBufferState = EMPTY_TERMINAL_BUFFER_STATE,
): TerminalBufferState {
  return {
    output: resetOutput(current.output, snapshot.history, maxBufferBytes),
    status: snapshot.status,
    error: null,
    updatedAt: snapshot.updatedAt,
    replayStartVersion: current.replayStartVersion + 1,
    replayCompleteVersion: current.replayCompleteVersion,
    version: current.version + 1,
  };
}

function latestTimestamp(left: string | null, right: string | null): string | null {
  if (left === null) return right;
  if (right === null) return left;
  return Date.parse(left) >= Date.parse(right) ? left : right;
}

export function combineTerminalSessionState(
  summary: TerminalSummary | null,
  buffer: TerminalBufferState,
): TerminalSessionState {
  return {
    summary,
    output: buffer.output,
    status: buffer.version > 0 ? buffer.status : (summary?.status ?? buffer.status),
    error: buffer.error,
    hasRunningSubprocess: summary?.hasRunningSubprocess ?? false,
    updatedAt: latestTimestamp(summary?.updatedAt ?? null, buffer.updatedAt),
    replayStartVersion: buffer.replayStartVersion,
    replayCompleteVersion: buffer.replayCompleteVersion,
    version: buffer.version,
  };
}

export function applyTerminalAttachStreamEvent(
  current: TerminalBufferState,
  event: TerminalAttachStreamEvent,
  maxBufferBytes = DEFAULT_MAX_TERMINAL_BUFFER_BYTES,
): TerminalBufferState {
  switch (event.type) {
    case "snapshot":
    case "restarted":
      return terminalBufferStateFromSnapshot(event.snapshot, maxBufferBytes, current);
    case "output":
      return {
        ...current,
        output: appendOutput(current.output, event.data, maxBufferBytes),
        status: current.status === "closed" ? "running" : current.status,
        error: null,
        version: current.version + 1,
      };
    case "replay-complete":
      return {
        ...current,
        replayCompleteVersion: current.replayCompleteVersion + 1,
        version: current.version + 1,
      };
    case "cleared":
      return {
        ...current,
        output: resetOutput(current.output, "", maxBufferBytes),
        error: null,
        version: current.version + 1,
      };
    case "exited":
      return {
        ...current,
        status: "exited",
        error: null,
        version: current.version + 1,
      };
    case "closed":
      return {
        ...current,
        status: "closed",
        error: null,
        version: current.version + 1,
      };
    case "error":
      return {
        ...current,
        status: "error",
        error: event.message,
        version: current.version + 1,
      };
    case "activity":
      return current;
  }
}

export function applyTerminalMetadataStreamEvent(
  current: ReadonlyArray<TerminalSummary>,
  event: TerminalMetadataStreamEvent,
): ReadonlyArray<TerminalSummary> {
  if (event.type === "snapshot") {
    return event.terminals;
  }
  if (event.type === "remove") {
    return current.filter(
      (terminal) =>
        terminal.threadId !== event.threadId || terminal.terminalId !== event.terminalId,
    );
  }
  const next = current.filter(
    (terminal) =>
      terminal.threadId !== event.terminal.threadId ||
      terminal.terminalId !== event.terminal.terminalId,
  );
  return [...next, event.terminal];
}
