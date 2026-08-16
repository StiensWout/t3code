import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import { tokenizeCliArgs } from "@t3tools/shared/cliArgs";

import type { McpProviderSessionConfig } from "../../mcp/McpProviderSession.ts";
import {
  PI_T3_MCP_EXTENSION_FILENAME,
  PI_T3_MCP_EXTENSION_SOURCE,
  T3_MCP_BEARER_ENV,
  T3_MCP_URL_ENV,
} from "./piT3McpExtensionSource.ts";

export { PI_T3_MCP_EXTENSION_FILENAME, T3_MCP_BEARER_ENV, T3_MCP_URL_ENV };

export function bearerTokenFromAuthorizationHeader(header: string): string {
  return header.startsWith("Bearer ") ? header.slice("Bearer ".length) : header;
}

export function piT3McpExtensionDestPath(cacheDir: string): string {
  return `${cacheDir.replace(/\\/g, "/")}/${PI_T3_MCP_EXTENSION_FILENAME}`;
}

export const materializePiT3McpExtension = Effect.fn("materializePiT3McpExtension")(function* (
  cacheDir: string,
) {
  const fs = yield* FileSystem.FileSystem;
  yield* fs.makeDirectory(cacheDir, { recursive: true });
  const dest = piT3McpExtensionDestPath(cacheDir);
  const existing = yield* fs.readFileString(dest).pipe(Effect.orElseSucceed(() => ""));
  if (existing !== PI_T3_MCP_EXTENSION_SOURCE) {
    yield* fs.writeFileString(dest, PI_T3_MCP_EXTENSION_SOURCE);
  }
  return dest;
});

export function buildPiRpcLaunch(input: {
  readonly launchArgs: string;
  readonly environment: NodeJS.ProcessEnv;
  readonly mcpSession: McpProviderSessionConfig | undefined;
  readonly extensionPath: string | undefined;
}): {
  readonly args: ReadonlyArray<string>;
  readonly env: NodeJS.ProcessEnv;
  readonly hasT3Mcp: boolean;
} {
  const userArgs = tokenizeCliArgs(input.launchArgs);
  const hasT3Mcp = input.mcpSession !== undefined && input.extensionPath !== undefined;
  if (!hasT3Mcp || input.mcpSession === undefined || input.extensionPath === undefined) {
    return { args: ["--mode", "rpc", ...userArgs], env: input.environment, hasT3Mcp: false };
  }

  const alreadyHasExtension = userArgs.some(
    (arg, index) => arg === "--extension" && userArgs[index + 1] === input.extensionPath,
  );
  const args = alreadyHasExtension
    ? ["--mode", "rpc", ...userArgs]
    : ["--mode", "rpc", ...userArgs, "--extension", input.extensionPath];

  return {
    args,
    env: {
      ...input.environment,
      [T3_MCP_URL_ENV]: input.mcpSession.endpoint,
      [T3_MCP_BEARER_ENV]: bearerTokenFromAuthorizationHeader(input.mcpSession.authorizationHeader),
    },
    hasT3Mcp: true,
  };
}
