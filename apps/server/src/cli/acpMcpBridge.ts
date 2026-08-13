import * as Effect from "effect/Effect";
import { Command } from "effect/unstable/cli";

import { runAcpMcpStdioBridge } from "../mcp/AcpMcpStdioBridge.ts";

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
      const endpoint = process.env.T3_ACP_MCP_ENDPOINT;
      const authorization = process.env.T3_ACP_MCP_AUTHORIZATION;
      if (endpoint === undefined || authorization === undefined) {
        process.stderr.write(
          "acp-mcp-bridge requires T3_ACP_MCP_ENDPOINT and T3_ACP_MCP_AUTHORIZATION.\n",
        );
        process.exitCode = 2;
        return;
      }
      await runAcpMcpStdioBridge({
        endpoint,
        authorization,
        input: process.stdin,
        output: process.stdout,
      });
    }),
  ),
);
