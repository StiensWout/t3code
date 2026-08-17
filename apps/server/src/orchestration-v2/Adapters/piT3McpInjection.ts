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
import {
  PI_T3_SUBAGENT_EXTENSION_FILENAME,
  PI_T3_SUBAGENT_EXTENSION_SOURCE,
  T3_PI_CHILD_SESSION_ROOT_ENV,
} from "./piT3SubagentExtensionSource.ts";

export {
  PI_T3_MCP_EXTENSION_FILENAME,
  PI_T3_SUBAGENT_EXTENSION_FILENAME,
  T3_MCP_BEARER_ENV,
  T3_MCP_URL_ENV,
  T3_PI_CHILD_SESSION_ROOT_ENV,
};

export function bearerTokenFromAuthorizationHeader(header: string): string {
  return header.startsWith("Bearer ") ? header.slice("Bearer ".length) : header;
}

export function piT3McpExtensionDestPath(cacheDir: string): string {
  return `${cacheDir.replace(/\\/g, "/")}/${PI_T3_MCP_EXTENSION_FILENAME}`;
}

export function piT3SubagentExtensionDestPath(cacheDir: string): string {
  return `${cacheDir.replace(/\\/g, "/")}/${PI_T3_SUBAGENT_EXTENSION_FILENAME}`;
}

export function piChildSessionRootFromLaunchArgs(launchArgs: string): string | undefined {
  const args = tokenizeCliArgs(launchArgs);
  const index = args.indexOf("--session-dir");
  const sessionDir = index >= 0 ? args[index + 1] : undefined;
  if (sessionDir === undefined || sessionDir.length === 0) return undefined;
  return `${sessionDir.replace(/\\/g, "/")}/children`;
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

export const materializePiT3SubagentExtension = Effect.fn("materializePiT3SubagentExtension")(
  function* (cacheDir: string) {
    const fs = yield* FileSystem.FileSystem;
    yield* fs.makeDirectory(cacheDir, { recursive: true });
    const dest = piT3SubagentExtensionDestPath(cacheDir);
    const existing = yield* fs.readFileString(dest).pipe(Effect.orElseSucceed(() => ""));
    if (existing !== PI_T3_SUBAGENT_EXTENSION_SOURCE) {
      yield* fs.writeFileString(dest, PI_T3_SUBAGENT_EXTENSION_SOURCE);
    }
    return dest;
  },
);

function appendExtensionArg(
  args: ReadonlyArray<string>,
  extensionPath: string | undefined,
): string[] {
  if (extensionPath === undefined) return [...args];
  const alreadyHas = args.some(
    (arg, index) => (arg === "--extension" || arg === "-e") && args[index + 1] === extensionPath,
  );
  return alreadyHas ? [...args] : [...args, "--extension", extensionPath];
}

function normalizePiPath(value: string): string {
  return value.replace(/\\/g, "/").replace(/\/+$/, "");
}

/** Official / user-installed `subagent` tool. Not the T3 override file. */
export function isConflictingPiSubagentExtensionPath(extensionPath: string): boolean {
  const normalized = normalizePiPath(extensionPath);
  if (normalized.endsWith(`/${PI_T3_SUBAGENT_EXTENSION_FILENAME}`)) return false;
  return (
    normalized.endsWith("/extensions/subagent/index.ts") ||
    normalized.endsWith("/extensions/subagent/index.js") ||
    normalized.endsWith("/examples/extensions/subagent/index.ts") ||
    normalized.endsWith("/examples/extensions/subagent/index.js")
  );
}

export function stripConflictingPiSubagentExtensionArgs(args: ReadonlyArray<string>): string[] {
  const stripped: string[] = [];
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === undefined) continue;
    const next = args[index + 1];
    if (
      (arg === "--extension" || arg === "-e") &&
      next !== undefined &&
      isConflictingPiSubagentExtensionPath(next)
    ) {
      index += 1;
      continue;
    }
    stripped.push(arg);
  }
  return stripped;
}

export function buildPiRpcLaunch(input: {
  readonly launchArgs: string;
  readonly environment: NodeJS.ProcessEnv;
  readonly mcpSession: McpProviderSessionConfig | undefined;
  readonly extensionPath: string | undefined;
  readonly subagentExtensionPath?: string | undefined;
}): {
  readonly args: ReadonlyArray<string>;
  readonly env: NodeJS.ProcessEnv;
  readonly hasT3Mcp: boolean;
} {
  const userArgs = tokenizeCliArgs(input.launchArgs);
  const hasT3Mcp = input.mcpSession !== undefined && input.extensionPath !== undefined;
  // Duplicate `subagent` registrations abort Pi. Disable discovery and drop
  // the official tool from launchArgs so only the T3 override remains.
  let args = ["--mode", "rpc"];
  if (input.subagentExtensionPath !== undefined) {
    if (!userArgs.includes("--no-extensions") && !userArgs.includes("-ne")) {
      args.push("--no-extensions");
    }
    args = appendExtensionArg(args, input.subagentExtensionPath);
    args = [...args, ...stripConflictingPiSubagentExtensionArgs(userArgs)];
  } else {
    args = [...args, ...userArgs];
  }
  if (hasT3Mcp && input.extensionPath !== undefined) {
    args = appendExtensionArg(args, input.extensionPath);
  }

  const childSessionRoot = piChildSessionRootFromLaunchArgs(input.launchArgs);
  return {
    args,
    env: {
      ...input.environment,
      ...(input.subagentExtensionPath === undefined || childSessionRoot === undefined
        ? {}
        : { [T3_PI_CHILD_SESSION_ROOT_ENV]: childSessionRoot }),
      ...(hasT3Mcp && input.mcpSession !== undefined
        ? {
            [T3_MCP_URL_ENV]: input.mcpSession.endpoint,
            [T3_MCP_BEARER_ENV]: bearerTokenFromAuthorizationHeader(
              input.mcpSession.authorizationHeader,
            ),
          }
        : {}),
    },
    hasT3Mcp,
  };
}
