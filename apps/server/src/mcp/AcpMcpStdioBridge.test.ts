// @effect-diagnostics nodeBuiltinImport:off globalTimers:off
import * as NodeStream from "node:stream";

import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";

import { callAcpMcpTool, runAcpMcpStdioBridge } from "./AcpMcpStdioBridge.ts";

function makeHarness(responder: (request: Request) => Promise<Response> | Response) {
  const input = new NodeStream.PassThrough();
  const written: Array<string> = [];
  const requests: Array<{ readonly headers: Headers; readonly body: string }> = [];
  const done = Effect.runPromise(
    runAcpMcpStdioBridge({
      endpoint: "http://127.0.0.1:1/mcp",
      authorization: "Bearer bridge-test",
      input,
      output: {
        write: (chunk: string) => {
          written.push(chunk);
        },
      },
      fetchImplementation: async (_url, init) => {
        const request = new Request("http://127.0.0.1:1/mcp", init);
        requests.push({ headers: request.headers, body: String(init?.body ?? "") });
        return responder(request);
      },
    }),
  );
  return { input, written, requests, done };
}

describe("AcpMcpStdioBridge", () => {
  it("calls one tool through a fresh authenticated MCP session", async () => {
    const requests: Array<{ readonly body: unknown; readonly headers: Headers }> = [];
    const result = await Effect.runPromise(
      callAcpMcpTool({
        endpoint: "http://127.0.0.1:1/mcp",
        authorization: "Bearer bridge-test",
        tool: "orchestrator_capabilities",
        arguments: {},
        fetchImplementation: async (_url, init) => {
          const headers = new Headers(init?.headers);
          const body: unknown = JSON.parse(String(init?.body ?? "{}"));
          requests.push({ body, headers });
          const request = body as { readonly id?: unknown; readonly method?: unknown };
          if (request.method === "notifications/initialized") {
            return new Response(null, { status: 202 });
          }
          return new Response(
            JSON.stringify({
              jsonrpc: "2.0",
              id: request.id,
              result:
                request.method === "initialize"
                  ? { protocolVersion: "2025-06-18", capabilities: {}, serverInfo: {} }
                  : { structuredContent: { providers: ["codex"] } },
            }),
            {
              headers: { "content-type": "application/json", "mcp-session-id": "session-42" },
            },
          );
        },
      }),
    );

    expect(result).toEqual({ structuredContent: { providers: ["codex"] } });
    expect(requests).toHaveLength(3);
    expect(requests[0]?.headers.get("authorization")).toBe("Bearer bridge-test");
    expect(requests[1]?.headers.get("mcp-session-id")).toBe("session-42");
    expect(requests[2]?.headers.get("mcp-protocol-version")).toBe("2025-06-18");
    expect(requests[2]?.body).toMatchObject({
      method: "tools/call",
      params: { name: "orchestrator_capabilities", arguments: {} },
    });
  });

  it("forwards requests and replays the session id and protocol version", async () => {
    const { input, written, requests, done } = makeHarness((request) => {
      const body = JSON.parse(String(requests.at(-1)?.body ?? "{}")) as { id?: number };
      void request;
      return new Response(
        JSON.stringify({
          jsonrpc: "2.0",
          id: body.id ?? null,
          result: body.id === 1 ? { protocolVersion: "2025-06-18" } : { ok: true },
        }),
        {
          status: 200,
          headers: { "content-type": "application/json", "mcp-session-id": "session-42" },
        },
      );
    });

    input.write(`${JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize" })}\n`);
    input.write(`${JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list" })}\n`);
    input.end();
    await done;

    expect(written).toHaveLength(2);
    expect(JSON.parse(written[0]!)).toMatchObject({ id: 1 });
    expect(JSON.parse(written[1]!)).toMatchObject({ id: 2, result: { ok: true } });
    expect(requests[0]?.headers.get("authorization")).toBe("Bearer bridge-test");
    expect(requests[1]?.headers.get("mcp-session-id")).toBe("session-42");
    expect(requests[1]?.headers.get("mcp-protocol-version")).toBe("2025-06-18");
  });

  it("acknowledges notifications silently and synthesizes errors for failed requests", async () => {
    let call = 0;
    const { input, written, done } = makeHarness(() => {
      call += 1;
      return call === 1
        ? new Response(null, { status: 202 })
        : new Response("upstream broke", { status: 500 });
    });

    input.write(`${JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" })}\n`);
    input.write(`${JSON.stringify({ jsonrpc: "2.0", id: 3, method: "tools/list" })}\n`);
    input.end();
    await done;

    expect(written).toHaveLength(1);
    expect(JSON.parse(written[0]!)).toMatchObject({
      id: 3,
      error: { code: -32603 },
    });
  });

  it("emits parse errors for malformed JSON-RPC input", async () => {
    const { input, written, requests, done } = makeHarness(
      () => new Response(null, { status: 202 }),
    );

    input.end("{not-json}\n");
    await done;

    expect(requests).toHaveLength(0);
    expect(JSON.parse(written[0]!)).toEqual({
      jsonrpc: "2.0",
      id: null,
      error: { code: -32700, message: "Parse error" },
    });
  });

  it("forwards SSE messages before the HTTP response closes", async () => {
    let resolveResponseController!: (
      controller: ReadableStreamDefaultController<Uint8Array>,
    ) => void;
    const responseControllerReady = new Promise<ReadableStreamDefaultController<Uint8Array>>(
      (resolve) => {
        resolveResponseController = resolve;
      },
    );
    let firstWrite: (() => void) | undefined;
    const firstWritten = new Promise<void>((resolve) => {
      firstWrite = resolve;
    });
    const input = new NodeStream.PassThrough();
    const written: Array<string> = [];
    const done = Effect.runPromise(
      runAcpMcpStdioBridge({
        endpoint: "http://127.0.0.1:1/mcp",
        authorization: "Bearer bridge-test",
        input,
        output: {
          write: (chunk) => {
            written.push(chunk);
            firstWrite?.();
          },
        },
        fetchImplementation: async () =>
          new Response(
            new ReadableStream<Uint8Array>({
              start: (controller) => {
                resolveResponseController(controller);
              },
            }),
            { headers: { "content-type": "text/event-stream" } },
          ),
      }),
    );

    input.write(`${JSON.stringify({ jsonrpc: "2.0", id: 7, method: "tools/call" })}\n`);
    const responseController = await responseControllerReady;
    responseController.enqueue(
      new TextEncoder().encode(
        'data: {"jsonrpc":"2.0","method":"notifications/progress","params":{}}\n\n',
      ),
    );
    await firstWritten;
    expect(JSON.parse(written[0]!)).toMatchObject({ method: "notifications/progress" });

    responseController.enqueue(
      new TextEncoder().encode('data: {"jsonrpc":"2.0","id":7,"result":{}}\n\n'),
    );
    responseController.close();
    input.end();
    await done;
    expect(written).toHaveLength(2);
  });

  it("forwards client responses while an SSE request is still open", async () => {
    let responseController: ReadableStreamDefaultController<Uint8Array> | undefined;
    let serverRequestWritten: (() => void) | undefined;
    const serverRequestReachedClient = new Promise<void>((resolve) => {
      serverRequestWritten = resolve;
    });
    const input = new NodeStream.PassThrough();
    const written: Array<string> = [];
    const done = Effect.runPromise(
      runAcpMcpStdioBridge({
        endpoint: "http://127.0.0.1:1/mcp",
        authorization: "Bearer bridge-test",
        input,
        output: {
          write: (chunk) => {
            written.push(chunk);
            if (JSON.parse(chunk).id === "server-request-1") serverRequestWritten?.();
          },
        },
        fetchImplementation: async (_url, init) => {
          const body = JSON.parse(String(init?.body ?? "{}")) as {
            readonly id?: unknown;
            readonly method?: unknown;
            readonly result?: unknown;
          };
          if (body.method === "tools/call") {
            return new Response(
              new ReadableStream<Uint8Array>({
                start: (controller) => {
                  responseController = controller;
                  controller.enqueue(
                    new TextEncoder().encode(
                      'data: {"jsonrpc":"2.0","id":"server-request-1","method":"elicitation/create","params":{}}\n\n',
                    ),
                  );
                },
              }),
              { headers: { "content-type": "text/event-stream" } },
            );
          }
          expect(body).toMatchObject({ id: "server-request-1", result: { action: "accept" } });
          responseController?.enqueue(
            new TextEncoder().encode('data: {"jsonrpc":"2.0","id":7,"result":{}}\n\n'),
          );
          responseController?.close();
          return new Response(null, { status: 202 });
        },
      }),
    );

    input.write(`${JSON.stringify({ jsonrpc: "2.0", id: 7, method: "tools/call" })}\n`);
    await serverRequestReachedClient;
    input.write(
      `${JSON.stringify({ jsonrpc: "2.0", id: "server-request-1", result: { action: "accept" } })}\n`,
    );
    input.end();
    await done;

    expect(written.map((line) => JSON.parse(line).id)).toEqual(["server-request-1", 7]);
  });

  it("forwards cancellation while a tool SSE response is still open", async () => {
    let resolveResponseController!: (
      controller: ReadableStreamDefaultController<Uint8Array>,
    ) => void;
    const responseControllerReady = new Promise<ReadableStreamDefaultController<Uint8Array>>(
      (resolve) => {
        resolveResponseController = resolve;
      },
    );
    const methods: Array<string> = [];
    const input = new NodeStream.PassThrough();
    const written: Array<string> = [];
    const done = Effect.runPromise(
      runAcpMcpStdioBridge({
        endpoint: "http://127.0.0.1:1/mcp",
        authorization: "Bearer bridge-test",
        input,
        output: { write: (chunk) => written.push(chunk) },
        fetchImplementation: async (_url, init) => {
          const body = JSON.parse(String(init?.body ?? "{}")) as {
            readonly method?: string;
          };
          methods.push(body.method ?? "");
          if (body.method === "tools/call") {
            return new Response(
              new ReadableStream<Uint8Array>({
                start: resolveResponseController,
              }),
              { headers: { "content-type": "text/event-stream" } },
            );
          }
          const controller = await responseControllerReady;
          controller.enqueue(
            new TextEncoder().encode('data: {"jsonrpc":"2.0","id":7,"result":{}}\n\n'),
          );
          controller.close();
          return new Response(null, { status: 202 });
        },
      }),
    );

    input.write(`${JSON.stringify({ jsonrpc: "2.0", id: 7, method: "tools/call" })}\n`);
    await responseControllerReady;
    input.write(
      `${JSON.stringify({ jsonrpc: "2.0", method: "notifications/cancelled", params: { requestId: 7 } })}\n`,
    );
    input.end();
    await done;

    expect(methods).toEqual(["tools/call", "notifications/cancelled"]);
    expect(JSON.parse(written[0]!)).toMatchObject({ id: 7, result: {} });
  });
});
