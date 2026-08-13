// @effect-diagnostics nodeBuiltinImport:off globalTimers:off
import * as NodeStream from "node:stream";

import { describe, expect, it } from "@effect/vitest";

import { callAcpMcpTool, runAcpMcpStdioBridge } from "./AcpMcpStdioBridge.ts";

function makeHarness(responder: (request: Request) => Promise<Response> | Response) {
  const input = new NodeStream.PassThrough();
  const written: Array<string> = [];
  const requests: Array<{ readonly headers: Headers; readonly body: string }> = [];
  const done = runAcpMcpStdioBridge({
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
  });
  return { input, written, requests, done };
}

describe("AcpMcpStdioBridge", () => {
  it("calls one tool through a fresh authenticated MCP session", async () => {
    const requests: Array<{ readonly body: unknown; readonly headers: Headers }> = [];
    const result = await callAcpMcpTool({
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
    });

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
    await new Promise((resolve) => setTimeout(resolve, 20));
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

  it("emits every message from an SSE response and nothing for notifications", async () => {
    const { input, written, done } = makeHarness((request) => {
      const body = JSON.parse(
        String((request as unknown as { _bodyText?: string })._bodyText ?? "{}"),
      ) as { id?: number };
      void body;
      const hasId = request.headers.get("x-probe") !== null;
      void hasId;
      return new Response(
        [
          'data: {"jsonrpc":"2.0","method":"notifications/progress","params":{}}',
          "",
          'data: {"jsonrpc":"2.0","id":7,"result":{"content":[]}}',
          "",
          "",
        ].join("\n"),
        { status: 200, headers: { "content-type": "text/event-stream" } },
      );
    });

    input.write(`${JSON.stringify({ jsonrpc: "2.0", id: 7, method: "tools/call" })}\n`);
    input.end();
    await done;

    expect(written).toHaveLength(2);
    expect(JSON.parse(written[0]!)).toMatchObject({ method: "notifications/progress" });
    expect(JSON.parse(written[1]!)).toMatchObject({ id: 7 });
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
    await new Promise((resolve) => setTimeout(resolve, 20));
    input.write(`${JSON.stringify({ jsonrpc: "2.0", id: 3, method: "tools/list" })}\n`);
    input.end();
    await done;

    expect(written).toHaveLength(1);
    expect(JSON.parse(written[0]!)).toMatchObject({
      id: 3,
      error: { code: -32603 },
    });
  });
});
