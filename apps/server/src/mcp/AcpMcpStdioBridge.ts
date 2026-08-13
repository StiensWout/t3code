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
  readonly result?: unknown;
}

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

  const respondWithError = (requestId: unknown, message: string): void => {
    writeMessage({
      jsonrpc: "2.0",
      id: requestId ?? null,
      error: { code: -32603, message },
    });
  };

  const forward = async (line: string): Promise<void> => {
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      return;
    }
    const envelope = asEnvelope(parsed);
    if (envelope === null) return;
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
      if (response.status === 202 || response.status === 204) {
        await response.body?.cancel().catch(() => undefined);
        return;
      }
      const contentType = response.headers.get("content-type") ?? "";
      if (contentType.includes("text/event-stream")) {
        for await (const data of sseDataLines(response)) {
          handleServerPayload(JSON.parse(data));
        }
        return;
      }
      const text = await response.text();
      if (text.trim().length === 0) return;
      handleServerPayload(JSON.parse(text));
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
    const reader = NodeReadline.createInterface({ input: options.input });
    reader.on("line", (line) => {
      if (line.trim().length === 0) return;
      const task = forward(line).finally(() => {
        pending.delete(task);
      });
      pending.add(task);
    });
    reader.on("close", resolve);
  });
  await Promise.allSettled(pending);
}
