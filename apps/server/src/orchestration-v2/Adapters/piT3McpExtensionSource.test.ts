import * as NodeModule from "node:module";
import * as NodeVM from "node:vm";
import { assert, describe, it } from "@effect/vitest";

import { PI_T3_MCP_EXTENSION_SOURCE } from "./piT3McpExtensionSource.ts";

type RequestHook = (
  event: { payload: unknown },
  ctx: { model: { provider: string } },
) => Record<string, unknown> | undefined;

interface RegisteredTool {
  readonly name: string;
  readonly description: string;
  readonly parameters: unknown;
  readonly promptSnippet?: string;
  readonly promptGuidelines?: ReadonlyArray<string>;
  readonly execute: (
    id: string,
    args: Record<string, unknown>,
    signal?: AbortSignal,
  ) => Promise<{
    readonly content: ReadonlyArray<{ readonly type: string; readonly text: string }>;
  }>;
}

type AgentStartHook = (
  event: { systemPrompt: string },
  ctx: { ui: { notify: (message: string, severity: string) => void } },
) => Promise<{ systemPrompt: string }>;

async function loadMcpBridge(
  options: {
    readonly native?: boolean;
    readonly nativeConnected?: boolean;
    readonly toolSearchDisabled?: boolean;
  } = {},
) {
  const handlers = new Map<string, AgentStartHook>();
  const tools: RegisteredTool[] = [];
  const requests: Array<{ readonly method: string; readonly params?: unknown }> = [];
  const servers: Array<{ readonly name: string; readonly config: Record<string, unknown> }> = [];
  const catalog = [
    { name: "orchestrator_capabilities", description: "Discover available providers and models." },
    { name: "delegate_task", description: "Delegate work to another agent." },
    { name: "task_status", description: "Check delegated work." },
    { name: "preview_snapshot", description: "Inspect the collaborative browser." },
  ].map((tool) => ({ ...tool, inputSchema: { type: "object", properties: {} } }));
  const source = NodeModule.stripTypeScriptTypes(
    PI_T3_MCP_EXTENSION_SOURCE.replace('import { Type } from "typebox";', "").replace(
      "export default async function",
      "async function",
    ),
  );
  await NodeVM.runInNewContext(`${source}\nt3McpExtension(pi)`, {
    process: {
      env: { T3_MCP_URL: "http://fixture.invalid/mcp", T3_MCP_BEARER_TOKEN: "fixture-token" },
    },
    AbortSignal,
    Type: { Unsafe: (schema: unknown) => schema },
    fetch: async (_url: string, options: { body: string }) => {
      const request = JSON.parse(options.body) as { id: number; method: string; params?: unknown };
      requests.push(request);
      const result =
        request.method === "tools/list"
          ? { tools: catalog }
          : request.method === "tools/call"
            ? { content: [{ type: "text", text: "browser snapshot" }] }
            : {};
      return new Response(JSON.stringify({ jsonrpc: "2.0", id: request.id, result }), {
        headers: { "content-type": "application/json" },
      });
    },
    pi: {
      on: (name: string, handler: AgentStartHook) => handlers.set(name, handler),
      registerTool: (tool: RegisteredTool) => tools.push(tool),
      getAllTools: () =>
        options.nativeConnected && !options.toolSearchDisabled
          ? [{ name: "tool_search", sourceInfo: { path: "builtin:tool-search" } }]
          : [],
      getCommands: () =>
        options.nativeConnected ? [{ name: "mcp", sourceInfo: { path: "builtin:mcp" } }] : [],
      ...(options.native
        ? {
            registerMcpServer: (name: string, config: Record<string, unknown>) =>
              servers.push({ name, config }),
            unregisterMcpServer: () => servers.splice(0),
          }
        : {}),
    },
  });
  return { handlers, tools, requests, servers };
}

describe("Pi MCP tool exposure", () => {
  it("lets native Pi discover optional tools without duplicating their declarations or transport", async () => {
    const bridge = await loadMcpBridge({ native: true, nativeConnected: true });
    await bridge.handlers.get("session_start")!(
      { systemPrompt: "" },
      { ui: { notify: () => undefined } },
    );
    const start = bridge.handlers.get("before_agent_start");
    assert.isDefined(start);
    const prompt = await start!(
      { systemPrompt: "Pi system prompt" },
      { ui: { notify: () => undefined } },
    );
    assert.include(prompt.systemPrompt, "orchestrator_capabilities");
    assert.equal(bridge.tools.length, 0);
    assert.equal(bridge.requests.length, 0);
    assert.equal(bridge.servers.length, 1);
    assert.equal(bridge.servers[0]?.name, "t3-code");
    assert.deepEqual(JSON.parse(JSON.stringify(bridge.servers[0]?.config)), {
      url: "http://fixture.invalid/mcp",
      headers: { authorization: "Bearer fixture-token" },
      exposure: "deferred",
      toolExposure: {
        orchestrator_capabilities: "direct",
        delegate_task: "direct",
        task_status: "direct",
      },
    });
  });

  it.each(["legacy Pi", "disabled native MCP", "disabled tool search"])(
    "keeps tool execution available with %s",
    async (mode) => {
      const bridge = await loadMcpBridge({
        native: mode !== "legacy Pi",
        nativeConnected: mode === "disabled tool search",
        toolSearchDisabled: mode === "disabled tool search",
      });
      if (mode !== "legacy Pi") {
        const start = bridge.handlers.get("session_start");
        await start!({ systemPrompt: "Pi system prompt" }, { ui: { notify: () => undefined } });
      }
      assert.equal(bridge.tools.length, 4);
      const tool = bridge.tools.find((tool) => tool.name === "mcp__t3-code__preview_snapshot");
      assert.isDefined(tool);
      const controller = new AbortController();
      const result = await tool!.execute("call-1", { depth: 2 }, controller.signal);
      assert.equal(result.content[0]?.text, "browser snapshot");
      assert.deepEqual(JSON.parse(JSON.stringify(bridge.requests.at(-1))), {
        jsonrpc: "2.0",
        id: 3,
        method: "tools/call",
        params: { name: "preview_snapshot", arguments: { depth: 2 } },
      });
      assert.isUndefined(tool?.promptSnippet);
      assert.isUndefined(tool?.promptGuidelines);
    },
  );
});

async function loadRequestHook(): Promise<RequestHook> {
  const handlers = new Map<string, RequestHook>();
  // Execute the shipped extension with MCP disabled; this path needs no Typebox.
  const source = NodeModule.stripTypeScriptTypes(
    PI_T3_MCP_EXTENSION_SOURCE.replace('import { Type } from "typebox";', "").replace(
      "export default async function",
      "async function",
    ),
  );
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
