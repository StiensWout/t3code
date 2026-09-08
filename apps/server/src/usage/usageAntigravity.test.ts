// @effect-diagnostics nodeBuiltinImport:off - the suite writes real SQLite
// conversation databases to disk, exactly as the agent does.
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeSqlite from "node:sqlite";

import { afterEach, describe, expect, it } from "@effect/vitest";

import { parseAntigravityGeneration, readAntigravityConversation } from "./usageAntigravity.ts";
import { listTranscriptFiles } from "./usageTranscriptReader.ts";

/* Minimal protobuf encoder, enough to build a CortexStepGeneratorMetadata. */

function varint(value: number | bigint): Uint8Array {
  let remaining = BigInt(value);
  const out: number[] = [];
  do {
    let byte = Number(remaining & 0x7fn);
    remaining >>= 7n;
    if (remaining > 0n) byte |= 0x80;
    out.push(byte);
  } while (remaining > 0n);
  return Uint8Array.from(out);
}

function concat(...parts: readonly Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0));
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

function field(number: number, value: number | bigint | string | Uint8Array): Uint8Array {
  if (typeof value === "number" || typeof value === "bigint") {
    return concat(varint(number << 3), varint(value));
  }
  const bytes = typeof value === "string" ? new TextEncoder().encode(value) : value;
  return concat(varint((number << 3) | 2), varint(bytes.length), bytes);
}

const CONVERSATION_ID = "41e55acb-e3e5-457b-b440-3e3fa09c95d9";
/** 2026-08-01T10:00:00Z, inside the suite's reporting window. */
const CREATED_AT_SECONDS = 1_785_578_400;

interface GenerationInput {
  readonly model?: string;
  readonly seconds?: number | bigint | null;
  readonly nanos?: number;
  readonly inputTokens?: number;
  /** `null` omits `output_tokens`, as older records do. */
  readonly outputTokens?: number | null;
  readonly thinkingTokens?: number;
  readonly responseTokens?: number;
  readonly cacheReadTokens?: number;
  readonly cacheWriteTokens?: number;
  readonly requestId?: string | null;
  readonly executionId?: string;
}

/** Shaped after a real record written by agy_acp_server 1.1.1. */
function generationRecord(input: GenerationInput = {}): Uint8Array {
  const outputTokens = input.outputTokens === undefined ? 667 : input.outputTokens;
  const usage = concat(
    field(2, input.inputTokens ?? 10957),
    outputTokens === null ? new Uint8Array() : field(3, outputTokens),
    input.cacheWriteTokens === undefined ? new Uint8Array() : field(4, input.cacheWriteTokens),
    input.cacheReadTokens === undefined ? new Uint8Array() : field(5, input.cacheReadTokens),
    field(9, input.thinkingTokens ?? 568),
    field(10, input.responseTokens ?? 99),
  );
  const seconds = input.seconds === undefined ? CREATED_AT_SECONDS : input.seconds;
  const createdAt =
    seconds === null
      ? new Uint8Array()
      : field(4, concat(field(1, seconds), field(2, input.nanos ?? 333_002_940)));
  const chatStart = concat(field(2, 18_446_744_073_709_551_615n), createdAt);
  const requestId = input.requestId === undefined ? `${CONVERSATION_ID}-1` : input.requestId;
  const model = input.model ?? "gemini-3.8-flash";
  const chatModel = concat(
    field(3, 326),
    field(4, usage),
    field(9, chatStart),
    model.length === 0 ? new Uint8Array() : field(19, model),
    field(20, concat(field(1, "trajectory_id"), field(2, CONVERSATION_ID))),
    requestId === null
      ? new Uint8Array()
      : field(20, concat(field(1, "request_id"), field(2, requestId))),
  );
  return concat(
    field(1, chatModel),
    field(2, 0),
    field(4, input.executionId ?? CONVERSATION_ID),
    field(10, 1),
  );
}

describe("parseAntigravityGeneration", () => {
  it("extracts token totals, model, timestamp, session and dedupe key", () => {
    const record = parseAntigravityGeneration(generationRecord(), "fallback");

    expect(record).toEqual({
      provider: "antigravity",
      timestampMs: CREATED_AT_SECONDS * 1000 + 333,
      model: "gemini-3.8-flash",
      sessionId: CONVERSATION_ID,
      totals: {
        uncachedInputTokens: 10957,
        cachedInputTokens: 0,
        cacheCreationTokens: 0,
        outputTokens: 667,
        reasoningTokens: 568,
      },
      reportedCostUsd: null,
      dedupeKey: `antigravity:${CONVERSATION_ID}-1`,
    });
  });

  it("treats cached and cache-written input as part of the prompt count", () => {
    const record = parseAntigravityGeneration(
      generationRecord({ inputTokens: 10000, cacheReadTokens: 8000, cacheWriteTokens: 500 }),
      "fallback",
    );

    expect(record?.totals).toEqual({
      uncachedInputTokens: 1500,
      cachedInputTokens: 8000,
      cacheCreationTokens: 500,
      outputTokens: 667,
      reasoningTokens: 568,
    });
  });

  it("rebuilds output from its halves when output_tokens is absent", () => {
    const record = parseAntigravityGeneration(
      generationRecord({ outputTokens: null, thinkingTokens: 40, responseTokens: 12 }),
      "fallback",
    );

    expect(record?.totals.outputTokens).toBe(52);
    expect(record?.totals.reasoningTokens).toBe(40);
  });

  it("falls back to the database's conversation id and skips the dedupe key", () => {
    const record = parseAntigravityGeneration(
      generationRecord({ executionId: "", requestId: null }),
      "from-file",
    );

    expect(record?.sessionId).toBe("from-file");
    expect(record?.dedupeKey).toBeNull();
  });

  it("drops records without a timestamp or model, and rejects non-protobuf bytes", () => {
    expect(parseAntigravityGeneration(generationRecord({ seconds: null }), "x")).toBeNull();
    // A negative int64 is encoded as 2^64 - n; a Date built from it would be
    // invalid and throw inside the day formatter, failing the whole scan.
    expect(
      parseAntigravityGeneration(generationRecord({ seconds: 2n ** 64n - 1n }), "x"),
    ).toBeNull();
    expect(parseAntigravityGeneration(generationRecord({ model: "" }), "x")).toBeNull();
    expect(parseAntigravityGeneration(new TextEncoder().encode("not a proto"), "x")).toBeNull();
  });
});

describe("readAntigravityConversation", () => {
  const created: string[] = [];
  afterEach(async () => {
    for (const dir of created.splice(0)) {
      await NodeFSP.rm(dir, { recursive: true, force: true });
    }
  });

  async function conversationDir(): Promise<string> {
    const dir = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "usage-antigravity-"));
    created.push(dir);
    return dir;
  }

  function createConversation(filePath: string): NodeSqlite.DatabaseSync {
    const database = new NodeSqlite.DatabaseSync(filePath);
    database.exec("PRAGMA journal_mode = WAL");
    database.exec(
      "CREATE TABLE gen_metadata (idx integer, data blob, size integer NOT NULL DEFAULT 0, PRIMARY KEY (idx))",
    );
    return database;
  }

  function insertGeneration(
    database: NodeSqlite.DatabaseSync,
    idx: number,
    data: Uint8Array,
  ): void {
    database
      .prepare("INSERT INTO gen_metadata (idx, data, size) VALUES (?, ?, ?)")
      .run(idx, data, data.length);
  }

  it("reads every generation, including rows still in the write-ahead log", async () => {
    const dir = await conversationDir();
    const filePath = NodePath.join(dir, `${CONVERSATION_ID}.db`);
    const writer = createConversation(filePath);
    insertGeneration(writer, 0, generationRecord({ requestId: `${CONVERSATION_ID}-0` }));
    writer.close();

    expect(readAntigravityConversation(filePath)?.map((record) => record.dedupeKey)).toEqual([
      `antigravity:${CONVERSATION_ID}-0`,
    ]);
    const [before] = await listTranscriptFiles(dir, 0, {
      extension: ".db",
      companionSuffixes: ["-wal"],
    });

    // The agent keeps its connection open between turns, so the second row
    // lives only in the WAL until the next checkpoint.
    const appender = new NodeSqlite.DatabaseSync(filePath);
    insertGeneration(appender, 1, generationRecord({ requestId: `${CONVERSATION_ID}-1` }));
    try {
      expect(readAntigravityConversation(filePath)?.map((record) => record.dedupeKey)).toEqual([
        `antigravity:${CONVERSATION_ID}-0`,
        `antigravity:${CONVERSATION_ID}-1`,
      ]);
      const [after] = await listTranscriptFiles(dir, 0, {
        extension: ".db",
        companionSuffixes: ["-wal"],
      });
      expect(after?.path).toBe(before?.path);
      expect(after?.size).toBeGreaterThan(before?.size ?? Number.MAX_SAFE_INTEGER);
    } finally {
      appender.close();
    }
  });

  it("distinguishes an unreadable file from a database without generations", async () => {
    const dir = await conversationDir();
    const notADatabase = NodePath.join(dir, "garbage.db");
    await NodeFSP.writeFile(notADatabase, "definitely not sqlite");
    expect(readAntigravityConversation(notADatabase)).toBeNull();

    const empty = NodePath.join(dir, "empty.db");
    new NodeSqlite.DatabaseSync(empty).close();
    expect(readAntigravityConversation(empty)).toEqual([]);
  });
});
