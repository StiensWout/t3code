import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { Argument, Command } from "effect/unstable/cli";

import { callAcpMcpTool, runAcpMcpStdioBridge } from "../mcp/AcpMcpStdioBridge.ts";

function acpMcpEnvironment(): { readonly endpoint: string; readonly authorization: string } | null {
  const endpoint = process.env.T3_ACP_MCP_ENDPOINT;
  const authorization = process.env.T3_ACP_MCP_AUTHORIZATION;
  return endpoint === undefined || authorization === undefined ? null : { endpoint, authorization };
}

const decodeArgumentsJson = Schema.decodeUnknownSync(
  Schema.fromJsonString(Schema.Record(Schema.String, Schema.Unknown)),
);
const encodeUnknownJson = Schema.encodeUnknownSync(Schema.fromJsonString(Schema.Unknown));

/**
 * `t3 acp-mcp-bridge` — internal stdio MCP server that ACP agents spawn.
 *
 * The T3 server injects this command (with per-session endpoint and
 * credential environment variables) into `session/new` so every ACP agent
 * reaches the t3-code toolkit through ACP's required stdio MCP transport.
 * The credential stays in the environment, never on the command line.
 */
export const acpMcpBridgeCommand = Command.make("acp-mcp-bridge").pipe(
  Command.withDescription("Bridge T3 Code's MCP endpoint to stdio for ACP agents."),
  Command.withHidden,
  Command.withHandler(() =>
    Effect.promise(async () => {
      const environment = acpMcpEnvironment();
      if (environment === null) {
        process.stderr.write(
          "acp-mcp-bridge requires T3_ACP_MCP_ENDPOINT and T3_ACP_MCP_AUTHORIZATION.\n",
        );
        process.exitCode = 2;
        return;
      }
      await runAcpMcpStdioBridge({
        ...environment,
        input: process.stdin,
        output: process.stdout,
      });
    }),
  ),
);

/** Terminal fallback for ACP agents that do not expose injected MCP servers. */
export const acpMcpCallCommand = Command.make("acp-mcp-call", {
  tool: Argument.string("tool"),
  argumentsJson: Argument.string("arguments-json"),
}).pipe(
  Command.withDescription("Call one T3 Code MCP tool from an ACP agent terminal."),
  Command.withHidden,
  Command.withHandler(({ tool, argumentsJson }) =>
    Effect.promise(async () => {
      const environment = acpMcpEnvironment();
      if (environment === null) {
        throw new Error("acp-mcp-call requires T3_ACP_MCP_ENDPOINT and T3_ACP_MCP_AUTHORIZATION.");
      }
      const parsed = decodeArgumentsJson(argumentsJson);
      const result = await callAcpMcpTool({
        ...environment,
        tool,
        arguments: parsed,
      });
      process.stdout.write(`${encodeUnknownJson(result)}\n`);
    }),
  ),
);
