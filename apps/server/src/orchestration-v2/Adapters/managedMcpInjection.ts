// The provider configuration translators are synchronous boundary functions.
// @effect-diagnostics nodeBuiltinImport:off
import * as NodeCrypto from "node:crypto";
import type { ManagedMcpRuntimeServer } from "../../mcpManagement/ManagedMcpRuntime.ts";
import { MANAGED_MCP_PROCESS_SOURCE } from "./managedMcpProcessSource.ts";

/** Claude and baseline ACP have no stdio cwd field. The wrapper owns its child. */
const STDIO_CWD_WRAPPER = `
const { spawn } = require("node:child_process");
${MANAGED_MCP_PROCESS_SOURCE}
const [cwd, command, ...args] = process.argv.slice(1);
const launch = managedMcpSpawnOptions(command, args);
const child = spawn(launch.command, launch.args, { ...launch.options, cwd, stdio: "inherit", env: process.env });
for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"]) {
  process.on(signal, () => {
    terminateManagedMcpChild(child, signal);
    const timer = setTimeout(() => terminateManagedMcpChild(child, "SIGKILL"), 5000);
    timer.unref();
  });
}
child.on("error", () => { process.exitCode = 1; });
child.on("exit", (code, signal) => { terminateManagedMcpChild(child, "SIGKILL"); process.exitCode = code ?? (signal ? 1 : 0); });
process.on("exit", () => { if (child.exitCode === null) terminateManagedMcpChild(child, "SIGTERM"); });
`;

export function managedMcpStdio(
  transport: Extract<ManagedMcpRuntimeServer["transport"], { type: "stdio" }>,
) {
  if (transport.cwd === undefined) {
    return { command: transport.command, args: [...transport.args], env: { ...transport.env } };
  }
  return {
    command: process.execPath,
    args: ["-e", STDIO_CWD_WRAPPER, "--", transport.cwd, transport.command, ...transport.args],
    env: { ...transport.env, ELECTRON_RUN_AS_NODE: "1" },
  };
}

function managedName(id: string, threadId: string | undefined, prefix: string, maxLength: number) {
  const digest = NodeCrypto.createHash("sha256")
    .update(`${threadId ?? ""}\0${id}`)
    .digest("hex")
    .slice(0, 16);
  // Hash the full identity so truncation, sanitization, and sibling threads cannot collide.
  const readable = (id.replaceAll(/[^a-zA-Z0-9_-]/g, "-") || "server").slice(
    0,
    maxLength - prefix.length - digest.length - 2,
  );
  return `${prefix}-${readable}-${digest}`;
}

/** A separate namespace keeps catalog copies independent of native MCP settings. */
export function managedMcpName(id: string, threadId?: string): string {
  return managedName(id, threadId, threadId === undefined ? "t3-managed" : "t3-code-managed", 64);
}

/** OpenCode 1 and OpenCode 2's direct tools concatenate server and tool names;
 * leave room for ordinary tool names within Chat Completions' 64-character limit. */
export function openCodeManagedMcpName(id: string, threadId: string): string {
  return managedName(id, threadId, "t3-code-m", 32);
}
