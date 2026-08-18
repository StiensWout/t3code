import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
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

/** Env var telling the T3 subagent override where the MCP extension lives. */
export const T3_PI_MCP_EXTENSION_PATH_ENV = "T3_PI_MCP_EXTENSION_PATH";

function bearerTokenFromAuthorizationHeader(header: string): string {
  return header.startsWith("Bearer ") ? header.slice("Bearer ".length) : header;
}

const PiPackageSource = Schema.Union([
  Schema.String,
  Schema.Struct({
    source: Schema.String,
    autoload: Schema.optional(Schema.Boolean),
    extensions: Schema.optional(Schema.Array(Schema.String)),
  }),
]);

const PiSettingsFile = Schema.Struct({
  defaultProjectTrust: Schema.optional(Schema.String),
  packages: Schema.optional(Schema.Array(PiPackageSource)),
});

const PiPackageJson = Schema.Struct({
  pi: Schema.optional(
    Schema.Struct({
      extensions: Schema.optional(Schema.Array(Schema.String)),
    }),
  ),
});

const decodePiSettings = Schema.decodeUnknownOption(Schema.fromJsonString(PiSettingsFile));
const decodePiPackageJson = Schema.decodeUnknownOption(Schema.fromJsonString(PiPackageJson));

function piNpmPackageName(source: string): string | undefined {
  if (!source.startsWith("npm:")) return undefined;
  const spec = source.slice("npm:".length).trim();
  const name = spec.match(/^(@?[^@]+(?:\/[^@]+)?)(?:@.+)?$/)?.[1];
  return name !== undefined &&
    /^(?:@[A-Za-z0-9._~-]+\/[A-Za-z0-9._~-]+|[A-Za-z0-9._~-]+)$/.test(name)
    ? name
    : undefined;
}

function piUnfilteredPackageSource(pkg: typeof PiPackageSource.Type): string | undefined {
  if (typeof pkg === "string") return pkg;
  // Pi's object form can narrow or disable individual resources. Re-adding
  // the whole manifest would bypass that choice, so only restore packages
  // whose extension set is inherited unchanged.
  return pkg.autoload === false || pkg.extensions !== undefined ? undefined : pkg.source;
}

function piPackageExtensionPath(packageRoot: string, entry: string): string | undefined {
  const segments: Array<string> = [];
  for (const segment of entry.replace(/\\/g, "/").split("/")) {
    if (segment === "" || segment === ".") continue;
    if (segment === "..") {
      if (segments.pop() === undefined) return undefined;
      continue;
    }
    segments.push(segment);
  }
  return segments.length === 0 ? undefined : `${packageRoot}/${segments.join("/")}`;
}

/**
 * Re-discover the user's pi extensions for a `--no-extensions` spawn: the
 * subagent override forces discovery off (a second `subagent` registration
 * aborts pi), which must not cost the user every other extension they have.
 * Mirrors pi's own discovery roots and user npm package manifests:
 * `<agent dir>/extensions`, `settings.json` package `pi.extensions`, and the
 * project-local `.pi/extensions` only when the user's `defaultProjectTrust` is `always` —
 * explicit `--extension` paths bypass pi's trust prompt, so anything short
 * of standing trust must not be silently loaded. Pi's `pi-subagents` package
 * and conventional `subagent` entries are skipped in favor of the T3 override.
 */
export const discoverPiUserExtensions = Effect.fn("discoverPiUserExtensions")(function* (input: {
  readonly environment: NodeJS.ProcessEnv;
  readonly cwd: string | undefined;
}) {
  const fs = yield* FileSystem.FileSystem;
  const home = input.environment["HOME"] ?? input.environment["USERPROFILE"];
  const agentDir =
    input.environment["PI_CODING_AGENT_DIR"] ??
    (home === undefined ? undefined : `${normalizePiPath(home)}/.pi/agent`);
  const normalizedAgentDir = agentDir === undefined ? undefined : normalizePiPath(agentDir);
  const settingsRaw =
    normalizedAgentDir === undefined
      ? ""
      : yield* fs
          .readFileString(`${normalizedAgentDir}/settings.json`)
          .pipe(Effect.orElseSucceed(() => ""));
  const settings = Option.getOrUndefined(decodePiSettings(settingsRaw));
  const roots: Array<string> = [];
  if (normalizedAgentDir !== undefined) roots.push(`${normalizedAgentDir}/extensions`);
  if (
    normalizedAgentDir !== undefined &&
    input.cwd !== undefined &&
    settings?.defaultProjectTrust === "always"
  ) {
    roots.push(`${normalizePiPath(input.cwd)}/.pi/extensions`);
  }
  const found: Array<string> = [];
  const addFound = (path: string) => {
    if (!isConflictingPiSubagentExtensionPath(path) && !found.includes(path)) found.push(path);
  };
  for (const root of roots) {
    const entries = yield* fs
      .readDirectory(root)
      .pipe(Effect.orElseSucceed(() => [] as Array<string>));
    for (const entry of entries.toSorted()) {
      if (entry === "subagent" || entry === "subagent.ts") continue;
      const path = `${root}/${entry}`;
      if (entry.endsWith(".ts") || entry.endsWith(".js")) {
        addFound(path);
        continue;
      }
      for (const indexPath of [`${path}/index.ts`, `${path}/index.js`]) {
        const hasIndex = yield* fs.exists(indexPath).pipe(Effect.orElseSucceed(() => false));
        if (hasIndex) {
          addFound(indexPath);
          break;
        }
      }
    }
  }
  if (normalizedAgentDir !== undefined) {
    for (const pkg of settings?.packages ?? []) {
      const source = piUnfilteredPackageSource(pkg);
      const packageName = source === undefined ? undefined : piNpmPackageName(source);
      if (packageName === undefined || packageName === "pi-subagents") continue;
      const packageRoot = `${normalizedAgentDir}/npm/node_modules/${packageName}`;
      const packageJsonRaw = yield* fs
        .readFileString(`${packageRoot}/package.json`)
        .pipe(Effect.orElseSucceed(() => ""));
      const packageJson = Option.getOrUndefined(decodePiPackageJson(packageJsonRaw));
      for (const entry of packageJson?.pi?.extensions ?? []) {
        const extensionPath = piPackageExtensionPath(packageRoot, entry);
        if (extensionPath === undefined) continue;
        const exists = yield* fs.exists(extensionPath).pipe(Effect.orElseSucceed(() => false));
        if (exists) addFound(extensionPath);
      }
    }
  }
  return found;
});

function piT3McpExtensionDestPath(cacheDir: string): string {
  return `${cacheDir.replace(/\\/g, "/")}/${PI_T3_MCP_EXTENSION_FILENAME}`;
}

function piT3SubagentExtensionDestPath(cacheDir: string): string {
  return `${cacheDir.replace(/\\/g, "/")}/${PI_T3_SUBAGENT_EXTENSION_FILENAME}`;
}

function piChildSessionRootFromLaunchArgs(launchArgs: string): string | undefined {
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
  return extensionPath === undefined ? [...args] : [...args, "--extension", extensionPath];
}

function normalizePiPath(value: string): string {
  return value.replace(/\\/g, "/").replace(/\/+$/, "");
}

/** Official / user-installed `subagent` tool. Not the T3 override file. */
function isConflictingPiSubagentExtensionPath(extensionPath: string): boolean {
  const normalized = normalizePiPath(extensionPath);
  if (normalized.endsWith(`/${PI_T3_SUBAGENT_EXTENSION_FILENAME}`)) return false;
  return (
    normalized.endsWith("/extensions/subagent/index.ts") ||
    normalized.endsWith("/extensions/subagent/index.js") ||
    normalized.endsWith("/examples/extensions/subagent/index.ts") ||
    normalized.endsWith("/examples/extensions/subagent/index.js")
  );
}

function stripConflictingPiSubagentExtensionArgs(args: ReadonlyArray<string>): string[] {
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

function deduplicatePiExtensionArgs(args: ReadonlyArray<string>): string[] {
  const seen = new Set<string>();
  const deduplicated: Array<string> = [];
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === undefined) continue;
    const extensionPath = args[index + 1];
    if ((arg === "--extension" || arg === "-e") && extensionPath !== undefined) {
      index += 1;
      const normalized = normalizePiPath(extensionPath);
      if (seen.has(normalized)) continue;
      seen.add(normalized);
      deduplicated.push(arg, extensionPath);
      continue;
    }
    deduplicated.push(arg);
  }
  return deduplicated;
}

export function buildPiRpcLaunch(input: {
  readonly launchArgs: string;
  readonly environment: NodeJS.ProcessEnv;
  readonly mcpSession: McpProviderSessionConfig | undefined;
  readonly extensionPath: string | undefined;
  readonly subagentExtensionPath?: string | undefined;
  /** User extensions re-added around the `--no-extensions` subagent spawn. */
  readonly discoveredExtensionPaths?: ReadonlyArray<string> | undefined;
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
    for (const discovered of input.discoveredExtensionPaths ?? []) {
      args = appendExtensionArg(args, discovered);
    }
    args = [...args, ...stripConflictingPiSubagentExtensionArgs(userArgs)];
  } else {
    args = [...args, ...userArgs];
  }
  if (hasT3Mcp && input.extensionPath !== undefined) {
    args = appendExtensionArg(args, input.extensionPath);
  }
  args = deduplicatePiExtensionArgs(args);

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
            // The subagent override passes this through to child spawns so
            // native children get the T3 tools too (env is inherited).
            ...(input.extensionPath === undefined
              ? {}
              : { [T3_PI_MCP_EXTENSION_PATH_ENV]: input.extensionPath }),
          }
        : {}),
    },
    hasT3Mcp,
  };
}
