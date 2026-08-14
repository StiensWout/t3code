// @effect-diagnostics nodeBuiltinImport:off
import * as NodeReadline from "node:readline";

/**
 * Stdio-to-HTTP bridge for T3's MCP endpoint.
 *
 * ACP agents must support stdio MCP servers, while optional http/sse support
 * is unevenly implemented. `t3 acp-mcp-bridge` runs as the stdio MCP server an
 * ACP agent spawns and forwards each JSON-RPC line to T3's authenticated
 * streamable-HTTP endpoint: single JSON responses and SSE streams are written
 * back as newline-delimited JSON-RPC, notification acknowledgements (202/204)
 * produce no output, and the `mcp-session-id` / negotiated protocol version
 * are replayed on subsequent requests.
 */

interface JsonRpcEnvelope {
  readonly id?: unknown;
  readonly method?: unknown;
  readonly error?: unknown;
  readonly result?: unknown;
}

const MCP_PROTOCOL_VERSION = "2025-06-18";

export interface AcpMcpStdioBridgeOptions {
  readonly endpoint: string;
  readonly authorization: string;
  readonly input: NodeJS.ReadableStream;
  readonly output: { write(chunk: string): unknown };
  readonly fetchImplementation?: (url: string, init?: RequestInit) => Promise<Response>;
}

function asEnvelope(value: unknown): JsonRpcEnvelope | null {
  return typeof value === "object" && value !== null ? (value as JsonRpcEnvelope) : null;
}

function protocolVersionOf(entry: unknown): string | null {
  const result = asEnvelope(entry)?.result;
  const version =
    typeof result === "object" && result !== null
      ? (result as { readonly protocolVersion?: unknown }).protocolVersion
      : undefined;
  return typeof version === "string" && version.length > 0 ? version : null;
}

async function* sseDataLines(response: Response): AsyncGenerator<string> {
  if (response.body === null) return;
  const decoder = new TextDecoder();
  let buffered = "";
  for await (const chunk of response.body) {
    buffered += decoder.decode(chunk as Uint8Array, { stream: true });
    let separatorIndex = buffered.search(/\n\n|\r\n\r\n/u);
    while (separatorIndex !== -1) {
      const rawEvent = buffered.slice(0, separatorIndex);
      buffered = buffered.slice(separatorIndex).replace(/^(?:\r?\n){2}/u, "");
      const data = rawEvent
        .split(/\r?\n/u)
        .filter((line) => line.startsWith("data:"))
        .map((line) => line.slice("data:".length).trimStart())
        .join("\n");
      if (data.length > 0) yield data;
      separatorIndex = buffered.search(/\n\n|\r\n\r\n/u);
    }
  }
}

async function forEachResponsePayload(
  response: Response,
  handle: (payload: unknown) => void,
): Promise<void> {
  if (response.status === 202 || response.status === 204) {
    await response.body?.cancel().catch(() => undefined);
    return;
  }
  const contentType = response.headers.get("content-type") ?? "";
  if (contentType.includes("text/event-stream")) {
    for await (const data of sseDataLines(response)) {
      handle(JSON.parse(data));
    }
    return;
  }
  const text = await response.text();
  if (text.trim().length > 0) handle(JSON.parse(text));
}

async function responsePayloads(response: Response): Promise<ReadonlyArray<unknown>> {
  const payloads: Array<unknown> = [];
  await forEachResponsePayload(response, (payload) => payloads.push(payload));
  return payloads;
}

export interface AcpMcpToolCallOptions {
  readonly endpoint: string;
  readonly authorization: string;
  readonly tool: string;
  readonly arguments: Readonly<Record<string, unknown>>;
  readonly fetchImplementation?: (url: string, init?: RequestInit) => Promise<Response>;
}

/**
 * Call one MCP tool through a fresh authenticated HTTP session.
 *
 * This is the terminal fallback for ACP agents that accept `mcpServers` in
 * `session/new` but fail to expose those tools to their model. Compliant ACP
 * agents continue to use the stdio bridge above.
 */
export async function callAcpMcpTool(options: AcpMcpToolCallOptions): Promise<unknown> {
  const fetchImplementation = options.fetchImplementation ?? fetch;
  let sessionId: string | null = null;
  let protocolVersion: string | null = null;

  const send = async (message: unknown): Promise<ReadonlyArray<unknown>> => {
    const response = await fetchImplementation(options.endpoint, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
        authorization: options.authorization,
        ...(sessionId === null ? {} : { "mcp-session-id": sessionId }),
        ...(protocolVersion === null ? {} : { "mcp-protocol-version": protocolVersion }),
      },
      body: JSON.stringify(message),
    });
    sessionId = response.headers.get("mcp-session-id") ?? sessionId;
    if (!response.ok) {
      await response.body?.cancel().catch(() => undefined);
      throw new Error(`T3 Code MCP endpoint responded with HTTP ${response.status}.`);
    }
    const payloads = await responsePayloads(response);
    for (const payload of payloads) {
      protocolVersion = protocolVersionOf(payload) ?? protocolVersion;
    }
    return payloads;
  };

  const initializeId = "t3-acp-cli-initialize";
  const initialized = await send({
    jsonrpc: "2.0",
    id: initializeId,
    method: "initialize",
    params: {
      protocolVersion: MCP_PROTOCOL_VERSION,
      capabilities: {},
      clientInfo: { name: "t3-code-acp-cli", version: "0.0.0" },
    },
  });
  const initializeResponse = initialized.find((entry) => asEnvelope(entry)?.id === initializeId);
  if (initializeResponse === undefined || asEnvelope(initializeResponse)?.error !== undefined) {
    throw new Error("T3 Code MCP endpoint rejected initialization.");
  }
  await send({ jsonrpc: "2.0", method: "notifications/initialized" });

  const callId = "t3-acp-cli-tool-call";
  const responses = await send({
    jsonrpc: "2.0",
    id: callId,
    method: "tools/call",
    params: { name: options.tool, arguments: options.arguments },
  });
  const response = responses.find((entry) => asEnvelope(entry)?.id === callId);
  const envelope = asEnvelope(response);
  if (envelope === null || envelope.error !== undefined) {
    throw new Error(
      `T3 Code MCP tool call failed${envelope?.error === undefined ? "." : `: ${JSON.stringify(envelope.error)}`}`,
    );
  }
  return envelope.result;
}

export async function runAcpMcpStdioBridge(options: AcpMcpStdioBridgeOptions): Promise<void> {
  const fetchImplementation = options.fetchImplementation ?? fetch;
  let sessionId: string | null = null;
  let protocolVersion: string | null = null;
  const pending = new Set<Promise<void>>();

  const writeMessage = (message: unknown): void => {
    options.output.write(`${JSON.stringify(message)}\n`);
  };

  const handleServerPayload = (payload: unknown): void => {
    for (const entry of Array.isArray(payload) ? payload : [payload]) {
      protocolVersion = protocolVersionOf(entry) ?? protocolVersion;
      writeMessage(entry);
    }
  };

  const respondWithError = (requestId: unknown, message: string, code = -32603): void => {
    writeMessage({
      jsonrpc: "2.0",
      id: requestId ?? null,
      error: { code, message },
    });
  };

  const forward = async (line: string, envelope: JsonRpcEnvelope): Promise<void> => {
    try {
      const response = await fetchImplementation(options.endpoint, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          accept: "application/json, text/event-stream",
          authorization: options.authorization,
          ...(sessionId === null ? {} : { "mcp-session-id": sessionId }),
          ...(protocolVersion === null ? {} : { "mcp-protocol-version": protocolVersion }),
        },
        body: line,
      });
      sessionId = response.headers.get("mcp-session-id") ?? sessionId;
      if (!response.ok) {
        if (envelope.id !== undefined) {
          respondWithError(
            envelope.id,
            `T3 Code MCP endpoint responded with HTTP ${response.status}.`,
          );
        }
        await response.body?.cancel().catch(() => undefined);
        return;
      }
      await forEachResponsePayload(response, handleServerPayload);
    } catch (error) {
      if (envelope.id !== undefined) {
        respondWithError(
          envelope.id,
          `T3 Code MCP bridge request failed: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }
  };

  await new Promise<void>((resolve) => {
    let sessionBarrier = Promise.resolve();
    let sessionBarrierPending = false;
    const reader = NodeReadline.createInterface({ input: options.input });
    reader.on("line", (line) => {
      if (line.trim().length === 0) return;
      let parsed: unknown;
      try {
        parsed = JSON.parse(line);
      } catch {
        respondWithError(null, "Parse error", -32700);
        return;
      }
      const envelope = asEnvelope(parsed);
      if (envelope === null) return;
      const isResponse = envelope.id !== undefined && ("result" in envelope || "error" in envelope);
      const isSessionHandshake =
        envelope.method === "initialize" || envelope.method === "notifications/initialized";
      // Client responses to server-initiated SSE requests must bypass the
      // session barrier or they would deadlock the still-open HTTP exchange.
      // Only session establishment is ordered; normal MCP calls and control
      // notifications remain concurrent after initialization.
      let task: Promise<void>;
      if (isResponse) {
        task = forward(line, envelope);
      } else if (isSessionHandshake) {
        task = sessionBarrier.then(() => forward(line, envelope));
        sessionBarrier = task;
        sessionBarrierPending = true;
        void task.finally(() => {
          if (sessionBarrier === task) sessionBarrierPending = false;
        });
      } else {
        task = sessionBarrierPending
          ? sessionBarrier.then(() => forward(line, envelope))
          : forward(line, envelope);
      }
      void task.finally(() => {
        pending.delete(task);
      });
      pending.add(task);
    });
    reader.on("close", resolve);
  });
  await Promise.allSettled(pending);
}

/**
 * Argv runner for `t3 acp-mcp-bridge` and `t3 acp-mcp-call`, shared by the
 * fast-path dispatch in bin.ts and the full CLI's command handlers. Kept free
 * of heavy imports: these commands run on the ACP first-message critical path.
 */
export async function runAcpMcpCliFastPath(
  command: "acp-mcp-bridge" | "acp-mcp-call",
  args: ReadonlyArray<string>,
): Promise<void> {
  const endpoint = process.env.T3_ACP_MCP_ENDPOINT;
  const authorization = process.env.T3_ACP_MCP_AUTHORIZATION;
  if (endpoint === undefined || authorization === undefined) {
    process.stderr.write(`${command} requires T3_ACP_MCP_ENDPOINT and T3_ACP_MCP_AUTHORIZATION.\n`);
    process.exitCode = 2;
    return;
  }
  if (command === "acp-mcp-bridge") {
    await runAcpMcpStdioBridge({
      endpoint,
      authorization,
      input: process.stdin,
      output: process.stdout,
    });
    return;
  }
  const [tool, argumentsJson] = args;
  if (tool === undefined || argumentsJson === undefined) {
    process.stderr.write("acp-mcp-call requires <tool> and <arguments-json>.\n");
    process.exitCode = 2;
    return;
  }
  const parsed: unknown = JSON.parse(argumentsJson);
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    process.stderr.write("acp-mcp-call arguments must be a JSON object.\n");
    process.exitCode = 2;
    return;
  }
  const result = await callAcpMcpTool({
    endpoint,
    authorization,
    tool,
    arguments: parsed as Record<string, unknown>,
  });
  process.stdout.write(`${JSON.stringify(result)}\n`);
}
