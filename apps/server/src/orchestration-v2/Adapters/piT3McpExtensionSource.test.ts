// This executes the generated provider extension against an owned fixture subprocess.
// @effect-diagnostics nodeBuiltinImport:off
import * as NodeModule from "node:module";
import * as NodeVM from "node:vm";
import * as NodeHttp from "node:http";
import * as NodeCrypto from "node:crypto";
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodeStringDecoder from "node:string_decoder";
import { assert, describe, it, expect } from "@effect/vitest";
import { HostProcessPlatform } from "@t3tools/shared/hostProcess";
import * as Effect from "effect/Effect";

import { PI_T3_MCP_EXTENSION_SOURCE } from "./piT3McpExtensionSource.ts";
import { managedMcpName } from "./managedMcpInjection.ts";

type RequestHook = (
  event: { payload: unknown },
  ctx: { model: { provider: string } },
) => Record<string, unknown> | undefined;

function executableExtension() {
  return NodeModule.stripTypeScriptTypes(
    PI_T3_MCP_EXTENSION_SOURCE.replace('import { Type } from "typebox";', "")
      .replace('import { spawn } from "node:child_process";', "")
      .replace('import { StringDecoder } from "node:string_decoder";', "")
      .replace('import { createHash } from "node:crypto";', "")
      .replace("export default async function", "async function"),
  );
}

async function listenFixture(handler: NodeHttp.RequestListener) {
  const server = NodeHttp.createServer(handler);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("Missing fixture address");
  return { server, url: `http://127.0.0.1:${address.port}` };
}

function closeFixture(server: NodeHttp.Server) {
  server.closeAllConnections();
  return new Promise<void>((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  );
}

async function loadRequestHook(): Promise<RequestHook> {
  const handlers = new Map<string, RequestHook>();
  // Execute the shipped extension with MCP disabled; this path needs no Typebox.
  const source = executableExtension();
  await NodeVM.runInNewContext(`${source}\nt3McpExtension(pi)`, {
    process: { env: {} },
    pi: { on: (name: string, handler: RequestHook) => handlers.set(name, handler) },
  });
  const hook = handlers.get("before_provider_request");
  assert.isDefined(hook);
  return hook!;
}

describe("Pi upstream output-budget workaround", () => {
  it.each(["max_tokens", "max_completion_tokens"])(
    "caps %s without changing the conversation or tools",
    async (key) => {
      const hook = await loadRequestHook();
      const payload = {
        model: "moonshotai/kimi-k2.6",
        messages: [{ role: "user", content: "hello" }],
        tools: [{ type: "function", function: { name: "read" } }],
        [key]: 231_969,
      };
      const result = hook({ payload }, { model: { provider: "openrouter" } });
      assert.equal(result?.[key], 32_768);
      assert.strictEqual(result?.messages, payload.messages);
      assert.strictEqual(result?.tools, payload.tools);
      assert.equal(result?.model, payload.model);
      assert.equal(payload[key], 231_969);
    },
  );

  it("preserves smaller budgets and other providers' payloads", async () => {
    const hook = await loadRequestHook();
    for (const payload of [{ max_tokens: 8192 }, { max_completion_tokens: 32_768 }, {}, null]) {
      assert.isUndefined(hook({ payload }, { model: { provider: "openrouter" } }));
    }
    assert.isUndefined(
      hook({ payload: { max_tokens: 231_969 } }, { model: { provider: "anthropic" } }),
    );
  });
});

interface TestMcpClient {
  connect(signal?: AbortSignal): Promise<void>;
  listTools(
    signal?: AbortSignal,
  ): Promise<ReadonlyArray<{ name: string; inputSchema?: Record<string, unknown> }>>;
  callTool(name: string, args: Record<string, unknown>, signal?: AbortSignal): Promise<unknown>;
  close(): Promise<void>;
}

describe("Pi managed MCP connections", () => {
  it.each(["initialize", "notifications/initialized", "tools/list", "tools/call", "DELETE"])(
    "does not forward managed credentials or bodies through an HTTP %s redirect",
    async (redirectMethod) => {
      const redirectedRequests: Array<NodeHttp.IncomingHttpHeaders> = [];
      const target = await listenFixture((request, response) => {
        redirectedRequests.push(request.headers);
        request.resume();
        response.writeHead(200, { "content-type": "application/json" });
        response.end(JSON.stringify({ jsonrpc: "2.0", id: 1, result: {} }));
      });
      let origin: Awaited<ReturnType<typeof listenFixture>> | undefined;
      let client: TestMcpClient | undefined;
      const originMethods: string[] = [];
      try {
        origin = await listenFixture((request, response) => {
          let body = "";
          request.setEncoding("utf8");
          request.on("data", (chunk: string) => {
            body += chunk;
          });
          request.on("end", () => {
            const message = body ? JSON.parse(body) : {};
            const method = request.method === "DELETE" ? "DELETE" : String(message.method);
            originMethods.push(method);
            if (method === redirectMethod) {
              response.writeHead(307, { location: `${target.url}/collect` });
              response.end();
              return;
            }
            if (method === "DELETE" || message.id === undefined) {
              response.writeHead(204);
              response.end();
              return;
            }
            response.writeHead(200, {
              "content-type": "application/json",
              "mcp-session-id": "fixture-session",
            });
            response.end(
              JSON.stringify({
                jsonrpc: "2.0",
                id: message.id,
                result: {
                  protocolVersion: "2025-06-18",
                  capabilities: {},
                  serverInfo: { name: "fixture", version: "1" },
                },
              }),
            );
          });
        });
        client = NodeVM.runInNewContext(
          executableExtension() +
            '\ncreateMcpClient(endpoint, "", { "X-Api-Key": "fixture-secret", authorization: "Bearer fixture-token" })',
          {
            endpoint: `${origin.url}/mcp`,
            process: { env: {} },
            TextDecoder,
            Headers,
            AbortSignal,
            fetch,
          },
        );
        if (redirectMethod === "initialize") {
          await expect(client!.connect()).rejects.toThrow("307");
        } else {
          await client!.connect();
          if (redirectMethod === "tools/list")
            await expect(client!.listTools()).rejects.toThrow("307");
          if (redirectMethod === "tools/call")
            await expect(client!.callTool("private", { secret: "fixture-body" })).rejects.toThrow(
              "307",
            );
          if (redirectMethod === "DELETE") await client!.close();
        }
        assert.include(originMethods, redirectMethod);
        assert.deepEqual(redirectedRequests, []);
      } finally {
        await client?.close();
        if (origin !== undefined) await closeFixture(origin.server);
        await closeFixture(target.server);
      }
    },
  );

  it("registers bounded distinct aliases, dispatches original tool names, and keeps catalog secrets out of shell children", async () => {
    const serverName = managedMcpName("github-production");
    const names = [
      "pull_request_read",
      "pull_request_read_" + "x".repeat(80) + "a",
      "pull_request_read_" + "x".repeat(80) + "b",
    ];
    const agentEnvironment: NodeJS.ProcessEnv = {
      T3_MCP_URL: "https://fixture.test/t3",
      T3_MCP_BEARER_TOKEN: "fixture-t3-token",
      T3_MANAGED_MCP_SERVERS: JSON.stringify([
        {
          name: serverName,
          transport: {
            type: "http",
            url: "https://fixture.test/managed",
            headers: { "X-Managed-Key": "fixture-private-key" },
          },
        },
      ]),
    };
    const tools = new Map<string, { execute(id: string, params: unknown): Promise<unknown> }>();
    const handlers = new Map<string, () => Promise<void>>();
    const requests: Array<{ endpoint: string; method: string; key: string | null; tool?: string }> =
      [];
    await NodeVM.runInNewContext(executableExtension() + "\nt3McpExtension(pi)", {
      process: { env: agentEnvironment },
      createHash: NodeCrypto.createHash,
      TextDecoder,
      Headers,
      AbortSignal,
      Type: { Unsafe: (schema: unknown) => schema, Object: () => ({}) },
      pi: {
        on: (name: string, handler: () => Promise<void>) => handlers.set(name, handler),
        registerTool: (tool: {
          name: string;
          execute(id: string, params: unknown): Promise<unknown>;
        }) => tools.set(tool.name, tool),
      },
      fetch: async (endpoint: string, init: RequestInit) => {
        if (init.method === "DELETE") return new Response(null, { status: 204 });
        const message = JSON.parse(String(init.body));
        requests.push({
          endpoint,
          method: message.method,
          key: new Headers(init.headers).get("x-managed-key"),
          ...(message.method === "tools/call" ? { tool: String(message.params.name) } : {}),
        });
        if (message.id === undefined) return new Response(null, { status: 202 });
        const result =
          message.method === "initialize"
            ? {
                protocolVersion: "2025-06-18",
                capabilities: { tools: {} },
                serverInfo: { name: "fixture", version: "1" },
              }
            : message.method === "tools/list"
              ? {
                  tools: endpoint.endsWith("/managed")
                    ? names.map((name) => ({ name }))
                    : [{ name: "echo" }],
                }
              : { content: [{ type: "text", text: "echoed" }] };
        return new Response(JSON.stringify({ jsonrpc: "2.0", id: message.id, result }), {
          headers: { "content-type": "application/json", "mcp-session-id": "fixture-session" },
        });
      },
    });
    try {
      assert.isUndefined(agentEnvironment.T3_MANAGED_MCP_SERVERS);
      const shellOutput = await new Promise<string>((resolve, reject) => {
        NodeChildProcess.execFile(
          process.execPath,
          [
            "-e",
            "process.stdout.write(JSON.stringify({catalog:process.env.T3_MANAGED_MCP_SERVERS ?? null}))",
          ],
          { env: agentEnvironment },
          (error, stdout) => {
            if (error) reject(error);
            else resolve(stdout);
          },
        );
      });
      assert.deepEqual(JSON.parse(shellOutput), { catalog: null });
      const managedTools = [...tools.entries()].filter(([name]) =>
        name.startsWith("mcp__t3-managed-"),
      );
      assert.equal(managedTools.length, names.length);
      assert.isTrue(managedTools.every(([name]) => name.length <= 64));
      assert.isTrue(managedTools.every(([name]) => name.includes("pull_request_re")));
      for (const [, tool] of managedTools) await tool.execute("fixture-call", {});
      assert.deepEqual(
        requests.filter(
          (request) => request.endpoint.endsWith("/managed") && request.method === "tools/call",
        ),
        names.map((tool) => ({
          endpoint: "https://fixture.test/managed",
          method: "tools/call",
          key: "fixture-private-key",
          tool,
        })),
      );
    } finally {
      await handlers.get("session_shutdown")?.();
    }
  });

  it.effect(
    "discovers stdio tools, forwards cancellation, and closes its child and pending calls",
    () =>
      Effect.gen(function* () {
        const platform = yield* HostProcessPlatform;
        yield* Effect.promise(async () => {
          const cwd = NodeFS.realpathSync(NodeOS.tmpdir());
          const server = `
const readline = require("node:readline");
let cancelled = false;
readline.createInterface({ input: process.stdin }).on("line", (line) => {
  const message = JSON.parse(line);
  if (message.method === "notifications/cancelled") { cancelled = true; return; }
  if (message.id === undefined) return;
  let result = {};
  if (message.method === "initialize") result = { protocolVersion: "2025-06-18", capabilities: {}, serverInfo: { name: "fixture", version: "1" } };
  if (message.method === "tools/list") result = { tools: [{ name: "echo", inputSchema: { type: "object" } }, { name: "hold" }] };
  if (message.method === "tools/call") {
    if (message.params.name === "hold") return;
    result = { content: [{ type: "text", text: JSON.stringify({ args: message.params.arguments, cwd: process.cwd(), key: process.env.MCP_TEST_KEY, cancelled, inheritedT3Secret: process.env.T3_MCP_BEARER_TOKEN !== undefined || process.env.T3_MANAGED_MCP_SERVERS !== undefined }) }] };
  }
  process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: message.id, result }) + "\\n");
});`;
          let child: NodeChildProcess.ChildProcessWithoutNullStreams | undefined;
          const client: TestMcpClient = NodeVM.runInNewContext(
            executableExtension() + "\ncreateStdioMcpClient(config)",
            {
              process: {
                env: {
                  T3_MCP_BEARER_TOKEN: "fixture-private",
                  T3_MANAGED_MCP_SERVERS: "fixture-catalog",
                },
                platform,
                pid: process.pid,
                once: process.once.bind(process),
                removeListener: process.removeListener.bind(process),
                kill: process.kill.bind(process),
              },
              StringDecoder: NodeStringDecoder.StringDecoder,
              setTimeout,
              clearTimeout,
              config: {
                command: process.execPath,
                args: ["-e", server],
                env: { MCP_TEST_KEY: "fixture-key" },
                cwd,
              },
              spawn: (...args: Parameters<typeof NodeChildProcess.spawn>) => {
                const spawned = NodeChildProcess.spawn(...args);
                child = spawned as NodeChildProcess.ChildProcessWithoutNullStreams;
                return spawned;
              },
            },
          );
          try {
            await client.connect();
            assert.deepEqual(await client.listTools(), [
              { name: "echo", inputSchema: { type: "object" } },
              { name: "hold" },
            ]);
            const controller = new AbortController();
            const cancelled = client.callTool("hold", {}, controller.signal);
            controller.abort();
            await expect(cancelled).rejects.toThrow("cancelled");
            const result = (await client.callTool("echo", { value: "hello" })) as {
              content: Array<{ text: string }>;
            };
            assert.deepEqual(JSON.parse(result.content[0]!.text), {
              args: { value: "hello" },
              cwd,
              key: "fixture-key",
              cancelled: true,
              inheritedT3Secret: false,
            });
            const pending = client.callTool("hold", {});
            const rejected = expect(pending).rejects.toThrow("closed");
            const exited = new Promise<void>((resolve) => child!.once("close", () => resolve()));
            await client.close();
            await rejected;
            await exited;
            assert.isNotNull(child!.signalCode);
          } finally {
            await client.close();
          }
        });
      }),
  );

  it.each(["2025-06-18", "2025-03-26"])(
    "uses negotiated HTTP protocol %s and consumes SSE results without waiting for the stream to end",
    async (protocolVersion) => {
      const requests: Array<{ method: string; headers: Headers }> = [];
      let cancelledStreams = 0;
      const client: TestMcpClient = NodeVM.runInNewContext(
        executableExtension() +
          '\ncreateMcpClient("https://fixture.test/mcp", "", { "X-Key": "fixture-key" })',
        {
          process: { env: {} },
          TextDecoder,
          Headers,
          AbortSignal,
          fetch: async (_endpoint: string, init: RequestInit) => {
            const headers = new Headers(init.headers);
            if (init.method === "DELETE") {
              requests.push({ method: "DELETE", headers });
              return new Response(null, { status: 204 });
            }
            const message = JSON.parse(String(init.body));
            requests.push({ method: message.method, headers });
            if (
              message.method !== "initialize" &&
              headers.get("mcp-protocol-version") !== protocolVersion
            ) {
              return new Response("Unsupported protocol version", { status: 400 });
            }
            if (message.id === undefined) return new Response(null, { status: 202 });
            const result =
              message.method === "initialize"
                ? {
                    protocolVersion,
                    capabilities: { tools: {} },
                    serverInfo: { name: "fixture", version: "1" },
                  }
                : message.method === "tools/list"
                  ? { tools: [{ name: "echo" }] }
                  : { content: [{ type: "text", text: "echoed" }] };
            return new Response(
              new ReadableStream({
                start(controller) {
                  controller.enqueue(
                    new TextEncoder().encode(
                      "data: " +
                        JSON.stringify({ jsonrpc: "2.0", id: message.id, result }) +
                        "\n\n",
                    ),
                  );
                },
                cancel() {
                  cancelledStreams += 1;
                },
              }),
              {
                headers: {
                  "content-type": "text/event-stream",
                  "mcp-session-id": "fixture-session",
                },
              },
            );
          },
        },
      );
      await client.connect();
      assert.deepEqual(await client.listTools(), [{ name: "echo" }]);
      assert.deepEqual(await client.callTool("echo", {}), {
        content: [{ type: "text", text: "echoed" }],
      });
      await client.close();
      assert.equal(cancelledStreams, 3);
      assert.deepEqual(
        requests.map((request) => request.method),
        ["initialize", "notifications/initialized", "tools/list", "tools/call", "DELETE"],
      );
      assert.isTrue(
        requests
          .slice(1)
          .every((request) => request.headers.get("mcp-protocol-version") === protocolVersion),
      );
      assert.isTrue(requests.every((request) => request.headers.get("x-key") === "fixture-key"));
      assert.equal(requests.at(-1)?.method, "DELETE");
      assert.equal(requests.at(-1)?.headers.get("mcp-session-id"), "fixture-session");
    },
  );

  it.each(["2025-11-25", undefined])(
    "rejects unsupported negotiated HTTP protocol %s before listing tools",
    async (protocolVersion) => {
      const requests: string[] = [];
      const client: TestMcpClient = NodeVM.runInNewContext(
        executableExtension() + '\ncreateMcpClient("https://fixture.test/mcp", "")',
        {
          process: { env: {} },
          TextDecoder,
          Headers,
          AbortSignal,
          fetch: async (_endpoint: string, init: RequestInit) => {
            const message = JSON.parse(String(init.body));
            requests.push(message.method);
            return new Response(
              JSON.stringify({ jsonrpc: "2.0", id: message.id, result: { protocolVersion } }),
              {
                headers: { "content-type": "application/json" },
              },
            );
          },
        },
      );
      await expect(client.connect()).rejects.toThrow("unsupported HTTP protocol version");
      assert.deepEqual(requests, ["initialize"]);
    },
  );
});
