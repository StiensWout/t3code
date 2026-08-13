import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import { ChildProcessSpawner } from "effect/unstable/process";

import {
  makeAcpClientTerminals,
  resolveEmbeddedTerminalContent,
  type AcpClientTerminals,
} from "./AcpClientTerminals.ts";

const withTerminals = <A, E>(use: (terminals: AcpClientTerminals) => Effect.Effect<A, E>) =>
  Effect.gen(function* () {
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
    const terminals = yield* makeAcpClientTerminals({
      spawner,
      defaultCwd: process.cwd(),
    });
    return yield* use(terminals).pipe(Effect.ensuring(terminals.disposeAll));
  }).pipe(Effect.provide(NodeServices.layer), Effect.scoped);

describe("AcpClientTerminals", () => {
  it.effect("runs a command, buffers output, and reports the exit status", () =>
    withTerminals((terminals) =>
      Effect.gen(function* () {
        const created = yield* terminals.create({
          sessionId: "session",
          command: process.execPath,
          args: ["-e", "console.log('hello from acp'); process.exit(3);"],
        });

        const exit = yield* terminals.waitForExit({
          sessionId: "session",
          terminalId: created.terminalId,
        });
        expect(exit.exitCode).toBe(3);

        const output = yield* terminals.output({
          sessionId: "session",
          terminalId: created.terminalId,
        });
        expect(output.output).toContain("hello from acp");
        expect(output.truncated).toBe(false);
        expect(output.exitStatus?.exitCode).toBe(3);
      }),
    ),
  );

  it.effect("truncates buffered output from the beginning at the byte limit", () =>
    withTerminals((terminals) =>
      Effect.gen(function* () {
        const created = yield* terminals.create({
          sessionId: "session",
          command: process.execPath,
          args: ["-e", "process.stdout.write('a'.repeat(64) + 'TAIL');"],
          outputByteLimit: 16,
        });
        yield* terminals.waitForExit({ sessionId: "session", terminalId: created.terminalId });

        const output = yield* terminals.output({
          sessionId: "session",
          terminalId: created.terminalId,
        });
        expect(output.truncated).toBe(true);
        expect(output.output.endsWith("TAIL")).toBe(true);
        expect(output.output.length).toBeLessThanOrEqual(16);
      }),
    ),
  );

  it.effect("kills long-running commands and rejects released terminal handles", () =>
    withTerminals((terminals) =>
      Effect.gen(function* () {
        const created = yield* terminals.create({
          sessionId: "session",
          command: process.execPath,
          args: ["-e", "setInterval(() => {}, 1000);"],
        });
        yield* terminals.kill({ sessionId: "session", terminalId: created.terminalId });
        const exit = yield* terminals.waitForExit({
          sessionId: "session",
          terminalId: created.terminalId,
        });
        expect(exit.exitCode === 0 ? null : exit.exitCode).not.toBe(0);

        yield* terminals.release({ sessionId: "session", terminalId: created.terminalId });
        const rejected = yield* Effect.flip(
          terminals.output({ sessionId: "session", terminalId: created.terminalId }),
        );
        expect(rejected.message).toContain("unknown terminal ID");

        // Embedded tool-call content still renders released terminals.
        expect(terminals.readOutputSnapshot(created.terminalId)).toBeDefined();
      }),
    ),
  );
});

describe("resolveEmbeddedTerminalContent", () => {
  it("rewrites terminal content into text from the buffered snapshot", () => {
    const notification = {
      sessionId: "session",
      update: {
        sessionUpdate: "tool_call_update" as const,
        toolCallId: "call-1",
        content: [
          { type: "content" as const, content: { type: "text" as const, text: "before" } },
          { type: "terminal" as const, terminalId: "t3-term-1" },
          { type: "terminal" as const, terminalId: "t3-term-unknown" },
        ],
      },
    };

    const resolved = resolveEmbeddedTerminalContent(notification, (terminalId) =>
      terminalId === "t3-term-1"
        ? { output: "compiled 3 files", truncated: false, exitStatus: undefined }
        : undefined,
    );

    expect(resolved.update).toMatchObject({
      content: [
        { type: "content", content: { type: "text", text: "before" } },
        { type: "content", content: { type: "text", text: "compiled 3 files" } },
        { type: "content", content: { type: "text", text: "[terminal t3-term-unknown]" } },
      ],
    });
  });

  it("returns non-terminal notifications unchanged", () => {
    const notification = {
      sessionId: "session",
      update: {
        sessionUpdate: "agent_message_chunk" as const,
        content: { type: "text" as const, text: "hi" },
      },
    };
    expect(resolveEmbeddedTerminalContent(notification, () => undefined)).toBe(notification);
  });
});
