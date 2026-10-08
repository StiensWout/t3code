/**
 * Source for the T3-owned Pi extension that consumes T3's HTTP MCP server.
 *
 * Pi core has no MCP client. This file is TypeScript that Pi itself loads via
 * `--extension`. It is written to a cache path at session open so packaged
 * AppImage builds do not need a sibling .ts file next to the bundled server.
 *
 * Do not import t3code modules from the string body. The Pi process resolves
 * `@earendil-works/pi-coding-agent` and `typebox` from the user's pi install.
 */
import { T3_CODE_ORCHESTRATION_INSTRUCTIONS } from "../../provider/T3OrchestrationInstructions.ts";
import { MANAGED_MCP_PROCESS_SOURCE } from "./managedMcpProcessSource.ts";

export const PI_T3_MCP_EXTENSION_FILENAME = "pi-t3-mcp-extension.ts";

export const T3_MCP_URL_ENV = "T3_MCP_URL";
export const T3_MCP_BEARER_ENV = "T3_MCP_BEARER_TOKEN";
export const T3_PI_RUNTIME_MODE_ENV = "T3_PI_RUNTIME_MODE";
export const T3_MANAGED_MCP_ENV = "T3_MANAGED_MCP_SERVERS";

/**
 * Pi tools whose confirmations the bridge raises as file-change approvals.
 * Auto-accept edits skips them; the adapter keys the approval kind off them.
 */
export const PI_FILE_CHANGE_TOOLS = ["edit", "write"] as const;

export const PI_T3_MCP_EXTENSION_SOURCE = `\
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { spawn } from "node:child_process";
import { StringDecoder } from "node:string_decoder";
import { createHash } from "node:crypto";

${MANAGED_MCP_PROCESS_SOURCE}

const URL_ENV = ${JSON.stringify(T3_MCP_URL_ENV)};
const TOKEN_ENV = ${JSON.stringify(T3_MCP_BEARER_ENV)};
const RUNTIME_MODE_ENV = ${JSON.stringify(T3_PI_RUNTIME_MODE_ENV)};
const MANAGED_ENV = ${JSON.stringify(T3_MANAGED_MCP_ENV)};
const ORCHESTRATION_INSTRUCTIONS = ${JSON.stringify(T3_CODE_ORCHESTRATION_INSTRUCTIONS.trim())};
const PROTOCOL = "2025-06-18";
const HTTP_PROTOCOLS = new Set(["2025-03-26", PROTOCOL]);
const READ_ONLY_TOOLS = new Set(["read", "grep", "find", "ls"]);
const FILE_CHANGE_TOOLS = new Set(${JSON.stringify(PI_FILE_CHANGE_TOOLS)});

type RuntimeMode = "approval-required" | "auto-accept-edits" | "auto" | "full-access";

type JsonRpcResponse = {
  readonly id?: number | string;
  readonly result?: unknown;
  readonly error?: { readonly message?: string };
};

type McpTool = {
  readonly name: string;
  readonly description?: string;
  readonly inputSchema?: Record<string, unknown>;
};

function env(name: string): string | undefined {
  const value = process.env[name];
  return value && value.length > 0 ? value : undefined;
}

function runtimeMode(): RuntimeMode {
  const value = env(RUNTIME_MODE_ENV);
  return value === "approval-required" ||
    value === "auto-accept-edits" ||
    value === "auto" ||
    value === "full-access"
    ? value
    : "full-access";
}

function toolInputSummary(input: unknown): string {
  try {
    return JSON.stringify(input, null, 2).slice(0, 4_000);
  } catch {
    return String(input).slice(0, 4_000);
  }
}

function parseSseOrJson(body: string, contentType: string): JsonRpcResponse {
  if (contentType.includes("text/event-stream")) {
    for (const line of body.split("\\n")) {
      const trimmed = line.startsWith("data:") ? line.slice(5).trim() : "";
      if (trimmed.length === 0) continue;
      const parsed = JSON.parse(trimmed) as JsonRpcResponse;
      if (parsed.id !== undefined || parsed.result !== undefined || parsed.error !== undefined) {
        return parsed;
      }
    }
    throw new Error("MCP SSE response had no JSON-RPC payload.");
  }
  return JSON.parse(body) as JsonRpcResponse;
}

async function readMcpResponse(response: Response, id: number): Promise<JsonRpcResponse> {
  if (!response.headers.get("content-type")?.includes("text/event-stream")) {
    return parseSseOrJson(await response.text(), "application/json");
  }
  const reader = response.body?.getReader();
  if (reader === undefined) throw new Error("MCP SSE response is empty.");
  const decoder = new TextDecoder();
  let buffer = "";
  try {
    while (true) {
      const { value, done } = await reader.read();
      buffer += decoder.decode(value, { stream: !done });
      if (buffer.length > 16_777_216) throw new Error("MCP response is too large.");
      let boundary: number;
      while ((boundary = buffer.search(/\\r?\\n\\r?\\n/)) >= 0) {
        const event = buffer.slice(0, boundary);
        buffer = buffer.slice(boundary).replace(/^\\r?\\n\\r?\\n/, "");
        const data = event.split(/\\r?\\n/).filter((line) => line.startsWith("data:")).map((line) => line.slice(5).trimStart()).join("\\n");
        if (!data) continue;
        const parsed = JSON.parse(data) as JsonRpcResponse;
        if (parsed.id === id) return parsed;
      }
      if (done) throw new Error("MCP SSE response ended before the request completed.");
    }
  } finally {
    await reader.cancel().catch(() => undefined);
  }
}

function jsonSchemaToTypebox(schema: Record<string, unknown> | undefined) {
  const unsafe = (Type as { Unsafe?: (value: unknown) => unknown }).Unsafe;
  if (typeof unsafe === "function" && schema !== undefined) {
    return unsafe(schema);
  }
  return Type.Object({}, { additionalProperties: true });
}

/** Preserve readable identities within the provider's 64-character tool-name limit. */
function managedToolName(server: string, tool: string): string {
  const qualified = \`mcp__\${server}__\${tool}\`;
  if (qualified.length <= 64) return qualified;
  const hash = createHash("sha256").update(JSON.stringify([server, tool])).digest("hex").slice(0, 16);
  return \`mcp__\${server.slice(0, 24)}__\${tool.slice(0, 15)}_\${hash}\`;
}

function formatMcpContent(result: unknown): string {
  if (result === null || result === undefined) return "";
  if (typeof result !== "object") return String(result);
  const record = result as {
    readonly content?: ReadonlyArray<{ readonly type?: string; readonly text?: string }>;
    readonly structuredContent?: unknown;
    readonly isError?: boolean;
  };
  const texts: string[] = [];
  if (Array.isArray(record.content)) {
    for (const part of record.content) {
      if (part?.type === "text" && typeof part.text === "string") texts.push(part.text);
    }
  }
  // Most T3 tools mirror structuredContent in a text block. Repeating it would
  // leave T3's own output parsing two JSON documents instead of one.
  if (record.structuredContent !== undefined) {
    const structured = JSON.stringify(record.structuredContent);
    if (!texts.includes(structured)) texts.push(structured);
  }
  if (texts.length > 0) return texts.join("\\n");
  return JSON.stringify(result);
}

function isMcpToolError(result: unknown): boolean {
  return (
    typeof result === "object" &&
    result !== null &&
    "isError" in result &&
    result.isError === true
  );
}

function createMcpClient(endpoint: string, token: string, configuredHeaders: Record<string, string> = {}) {
  let nextId = 1;
  let sessionId: string | undefined;
  let protocolVersion = PROTOCOL;

  const headers = (): Record<string, string> => {
    const next: Record<string, string> = {
      ...Object.fromEntries(new Headers(configuredHeaders)),
      accept: "application/json, text/event-stream",
      ...(token ? { authorization: token.startsWith("Bearer ") ? token : \`Bearer \${token}\` } : {}),
      "content-type": "application/json",
      // Every request after initialize uses the server's negotiated version.
      "mcp-protocol-version": protocolVersion,
    };
    if (sessionId !== undefined) next["mcp-session-id"] = sessionId;
    return next;
  };

  const request = async (method: string, params?: unknown, signal?: AbortSignal) => {
    const id = nextId++;
    const response = await fetch(endpoint, {
      method: "POST",
      redirect: "manual",
      headers: headers(),
      body: JSON.stringify({ jsonrpc: "2.0", id, method, params }),
      signal,
    });
    const nextSession = response.headers.get("mcp-session-id");
    if (nextSession) sessionId = nextSession;
    if (!response.ok) {
      await response.body?.cancel();
      throw new Error(\`MCP \${method} failed (\${response.status}).\`);
    }
    const parsed = await readMcpResponse(response, id);
    if (parsed.error) {
      throw new Error(parsed.error.message ?? \`MCP \${method} returned an error\`);
    }
    return parsed.result;
  };

  const notify = async (method: string, params?: unknown, signal?: AbortSignal) => {
    const response = await fetch(endpoint, {
      method: "POST",
      redirect: "manual",
      headers: headers(),
      body: JSON.stringify({ jsonrpc: "2.0", method, params }),
      signal,
    });
    await response.body?.cancel();
  };

  return {
    async connect(signal?: AbortSignal) {
      const initialized = await request(
        "initialize",
        {
          protocolVersion: PROTOCOL,
          capabilities: {},
          clientInfo: { name: "t3-pi-mcp", version: "1.0.0" },
        },
        signal,
      );
      const negotiated = initialized !== null && typeof initialized === "object" && "protocolVersion" in initialized
        ? initialized.protocolVersion
        : undefined;
      if (typeof negotiated !== "string" || !HTTP_PROTOCOLS.has(negotiated)) {
        throw new Error("MCP server negotiated an unsupported HTTP protocol version.");
      }
      protocolVersion = negotiated;
      await notify("notifications/initialized", {}, signal).catch(() => undefined);
    },
    async listTools(signal?: AbortSignal) {
      const tools: McpTool[] = [];
      let cursor: string | undefined;
      do {
        const result = (await request(
          "tools/list",
          cursor === undefined ? {} : { cursor },
          signal,
        )) as { tools?: McpTool[]; nextCursor?: string } | undefined;
        tools.push(...(result?.tools ?? []));
        cursor = result?.nextCursor;
      } while (cursor);
      return tools;
    },
    async callTool(name: string, args: Record<string, unknown>, signal?: AbortSignal) {
      return request("tools/call", { name, arguments: args }, signal);
    },
    async close() {
      if (sessionId === undefined) return;
      await fetch(endpoint, { method: "DELETE", redirect: "manual", headers: headers(), signal: AbortSignal.timeout(5_000) }).catch(() => undefined);
      sessionId = undefined;
    },
  };
}

type StdioConfig = { command: string; args: string[]; env: Record<string, string>; cwd?: string };

/** One child belongs to one extension session. Pending calls fail on close or child failure. */
function createStdioMcpClient(config: StdioConfig): ReturnType<typeof createMcpClient> {
  const launch = managedMcpSpawnOptions(config.command, config.args);
  const environment = { ...process.env };
  // The third-party process gets its own configured secrets, not the other
  // catalog entries or the authenticated T3 orchestration credential.
  for (const key of [URL_ENV, TOKEN_ENV, MANAGED_ENV, RUNTIME_MODE_ENV]) delete environment[key];
  const child = spawn(launch.command, launch.args, {
    ...launch.options,
    cwd: config.cwd,
    env: { ...environment, ...config.env },
    stdio: ["pipe", "pipe", "pipe"],
  });
  child.stderr.resume();
  const decoder = new StringDecoder("utf8");
  let buffer = "";
  let nextId = 1;
  let closed = false;
  let killTimer: ReturnType<typeof setTimeout> | undefined;
  const pending = new Map<number, { resolve(value: unknown): void; reject(error: Error): void }>();
  const failAll = (error: Error) => {
    for (const entry of pending.values()) entry.reject(error);
    pending.clear();
  };
  const exitCleanup = () => { terminateManagedMcpChild(child, "SIGKILL"); };
  process.once("exit", exitCleanup);
  const stop = () => {
    if (closed) return;
    closed = true;
    failAll(new Error("Managed MCP connection closed."));
    child.stdin.end();
    terminateManagedMcpChild(child, "SIGTERM");
    killTimer = setTimeout(() => terminateManagedMcpChild(child, "SIGKILL"), 5_000);
    killTimer.unref();
  };
  const signals = ["SIGINT", "SIGTERM", "SIGHUP"] as const;
  const handlers = signals.map((signal) => {
    const handler = () => {
      stop();
      terminateManagedMcpChild(child, "SIGKILL");
      process.removeListener(signal, handler);
      process.kill(process.pid, signal);
    };
    process.once(signal, handler);
    return { signal, handler };
  });
  const removeHandlers = () => {
    process.removeListener("exit", exitCleanup);
    for (const { signal, handler } of handlers) process.removeListener(signal, handler);
  };
  child.once("error", (error) => { failAll(error); stop(); removeHandlers(); });
  child.once("exit", () => {
    if (killTimer !== undefined) clearTimeout(killTimer);
    closed = true;
    terminateManagedMcpChild(child, "SIGKILL");
    failAll(new Error("Managed MCP process exited."));
    removeHandlers();
  });
  const write = (message: unknown) => {
    child.stdin.write(JSON.stringify(message) + "\\n", (error) => {
      if (error) { failAll(error); stop(); }
    });
  };
  child.stdin.on("error", (error) => { failAll(error); stop(); });
  child.stdout.on("data", (chunk: Buffer) => {
    buffer += decoder.write(chunk);
    if (buffer.length > 16_777_216) { failAll(new Error("Managed MCP response is too large.")); stop(); return; }
    let index: number;
    while ((index = buffer.indexOf("\\n")) >= 0) {
      const line = buffer.slice(0, index);
      buffer = buffer.slice(index + 1);
      if (line.trim().length === 0) continue;
      try {
        const message = JSON.parse(line) as JsonRpcResponse & { method?: string };
        if (message.method !== undefined) {
          if (message.id !== undefined) write({ jsonrpc: "2.0", id: message.id, error: { code: -32601, message: "Client requests are not supported." } });
          continue;
        }
        const entry = typeof message.id === "number" ? pending.get(message.id) : undefined;
        if (entry === undefined) continue;
        pending.delete(message.id as number);
        if (message.error) entry.reject(new Error(message.error.message ?? "Managed MCP request failed."));
        else entry.resolve(message.result);
      } catch { failAll(new Error("Managed MCP emitted invalid JSON.")); stop(); }
    }
  });
  const request = (method: string, params: unknown, signal?: AbortSignal): Promise<unknown> => {
    if (closed) return Promise.reject(new Error("Managed MCP connection is closed."));
    if (signal?.aborted) return Promise.reject(new Error("Managed MCP request cancelled."));
    const id = nextId++;
    return new Promise((resolve, reject) => {
      const onAbort = () => {
        pending.delete(id);
        write({ jsonrpc: "2.0", method: "notifications/cancelled", params: { requestId: id, reason: "Cancelled" } });
        reject(new Error("Managed MCP request cancelled."));
      };
      const cleanup = () => signal?.removeEventListener("abort", onAbort);
      pending.set(id, {
        resolve(value) { cleanup(); resolve(value); },
        reject(error) { cleanup(); reject(error); },
      });
      signal?.addEventListener("abort", onAbort, { once: true });
      write({ jsonrpc: "2.0", id, method, params });
    });
  };
  return {
    async connect(signal) {
      await request("initialize", { protocolVersion: PROTOCOL, capabilities: {}, clientInfo: { name: "t3-pi-mcp", version: "1.0.0" } }, signal);
      write({ jsonrpc: "2.0", method: "notifications/initialized" });
    },
    async listTools(signal) {
      const tools: McpTool[] = [];
      let cursor: string | undefined;
      do {
        const result = await request("tools/list", cursor ? { cursor } : {}, signal) as { tools?: McpTool[]; nextCursor?: string };
        tools.push(...(result.tools ?? []));
        cursor = result.nextCursor;
      } while (cursor);
      return tools;
    },
    async callTool(name, args, signal) { return request("tools/call", { name, arguments: args }, signal); },
    async close() { stop(); },
  };
}

export default async function t3McpExtension(pi: ExtensionAPI) {
  // Workaround for an upstream Pi context-budgeting bug: pi-ai reuses the
  // previous response's usage even when a fork's instructions/tools differ,
  // then reserves almost all remaining context for output. OpenRouter can
  // reject even a short conversation. Remove this cap when Pi accounts for
  // the current request prefix reliably (api/simple-options + utils/estimate).
  pi.on("before_provider_request", (event, ctx) => {
    if (ctx.model?.provider !== "openrouter") return;
    const payload = event.payload;
    if (typeof payload !== "object" || payload === null || Array.isArray(payload)) return;
    const replacement = { ...payload } as Record<string, unknown>;
    let changed = false;
    for (const key of ["max_tokens", "max_completion_tokens"]) {
      const limit = replacement[key];
      if (typeof limit === "number" && Number.isFinite(limit) && limit > 32_768) {
        replacement[key] = 32_768;
        changed = true;
      }
    }
    if (changed) return replacement;
  });

  // Pi deliberately leaves permission policy to extensions. T3's injected
  // bridge uses Pi's public blocking tool hook so the shared runtime modes
  // keep their normal meaning without replacing or shadowing Pi's runtime.
  pi.on("tool_call", async (event, ctx) => {
    const mode = runtimeMode();
    if (mode === "full-access" || READ_ONLY_TOOLS.has(event.toolName)) return;
    if (mode === "auto-accept-edits" && FILE_CHANGE_TOOLS.has(event.toolName)) {
      return;
    }
    const approved = await ctx.ui.confirm(
      \`Allow \${event.toolName}?\`,
      toolInputSummary(event.input),
    );
    if (!approved) {
      return { block: true, reason: \`\${event.toolName} was declined in T3 Code.\` };
    }
  });

  const endpoint = env(URL_ENV);
  const token = env(TOKEN_ENV);
  if (endpoint === undefined || token === undefined) {
    pi.on("session_start", async (_event, ctx) => {
      ctx.ui.notify(
        "t3-code MCP unavailable: T3_MCP_URL or T3_MCP_BEARER_TOKEN is missing.",
        "warning",
      );
    });
    return;
  }

  type ManagedServer = {
    name: string;
    transport: ({ type: "stdio" } & StdioConfig) | { type: "http"; url: string; headers: Record<string, string> };
  };
  const managed = JSON.parse(env(MANAGED_ENV) ?? "[]") as ManagedServer[];
  // Keep catalog secrets in the clients, away from Pi's later shell children.
  delete process.env[MANAGED_ENV];
  const servers: ManagedServer[] = [
    { name: "t3-code", transport: { type: "http", url: endpoint, headers: { authorization: token.startsWith("Bearer ") ? token : "Bearer " + token } } },
    ...managed,
  ];
  const clients = new Map<string, ReturnType<typeof createMcpClient>>();
  const ready = new Set<string>();
  let stopped = false;
  let started: Promise<void> | undefined;
  pi.on("session_shutdown", async () => {
    stopped = true;
    await Promise.allSettled([...clients.values()].map((client) => client.close()));
    clients.clear();
  });

  const ensureStarted = () => {
    if (stopped) return Promise.resolve();
    if (started !== undefined) return started;
    const attempt = (async () => {
      const results = await Promise.allSettled(servers.map(async (server) => {
        if (ready.has(server.name) || stopped) return;
        const client = server.transport.type === "stdio"
          ? createStdioMcpClient(server.transport)
          : createMcpClient(server.transport.url, "", server.transport.headers);
        clients.set(server.name, client);
        try {
          const signal = AbortSignal.timeout(10_000);
          await client.connect(signal);
          const tools = await client.listTools(signal);
          if (stopped) { await client.close(); return; }
          for (const tool of tools) {
            const name = tool.name;
            const registeredName = server.name === "t3-code" ? "mcp__t3-code__" + name : managedToolName(server.name, name);
            const description = tool.description ?? name;
            pi.registerTool({
              name: registeredName,
              label: name,
              description,
              promptSnippet: description.split("\\n")[0] ?? name,
              ...(server.name === "t3-code" ? { promptGuidelines: [
                \`Use \${registeredName} from the t3-code MCP server when the user asks for T3 orchestration that this tool covers.\`,
              ] } : {}),
              parameters: jsonSchemaToTypebox(tool.inputSchema),
              async execute(_toolCallId, params, signal) {
                const result = await client.callTool(name, (params ?? {}) as Record<string, unknown>, signal);
                return {
                  content: [{ type: "text", text: formatMcpContent(result) }],
                  details: { server: server.name, tool: name },
                  ...(isMcpToolError(result) ? { isError: true } : {}),
                };
              },
            });
          }
          ready.add(server.name);
        } catch (error) {
          await client.close();
          clients.delete(server.name);
          throw error;
        }
      }));
      const failure = results.find((result) => result.status === "rejected");
      if (failure?.status === "rejected") throw failure.reason;
    })();
    started = attempt;
    void attempt.catch(() => {
      if (started === attempt) started = undefined;
    });
    return attempt;
  };

  // Await here so tools exist before session_start and the first prompt.
  // session_start is a retry if the process later reloads the extension.
  // Best effort during extension load. A failed first connection is retried
  // below on session_start instead of pinning this process to the failure.
  await ensureStarted().catch(() => undefined);

  pi.on("session_start", async (_event, ctx) => {
    try {
      await ensureStarted();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      ctx.ui.notify(\`MCP unavailable: \${message}\`, "warning");
    }
  });

  // Deliver orchestration guidance through pi's real system-prompt channel.
  // Wrapping the first user message instead would stop it from starting
  // with "/" and silently break slash-command expansion.
  pi.on("before_agent_start", (event) => ({
    systemPrompt: event.systemPrompt + "\\n\\n" + ORCHESTRATION_INSTRUCTIONS,
  }));
}
`;
