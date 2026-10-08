// Provider launch contracts are exercised with an owned fixture subprocess.
// @effect-diagnostics nodeBuiltinImport:off
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodeUtil from "node:util";
import { describe, it, assert } from "@effect/vitest";
import { EnvironmentId, ProviderInstanceId, ThreadId } from "@t3tools/contracts";

import { setMcpProviderSession, clearMcpProviderSession } from "../../mcp/McpProviderSession.ts";
import { codexThreadRuntimeParams } from "./CodexAdapterV2.ts";
import { claudeMcpQueryOverrides } from "./ClaudeAdapterV2.ts";
import { cursorMcpServers } from "./CursorAdapterV2.ts";
import { buildPiRpcLaunch } from "./piT3McpInjection.ts";
import { T3_MANAGED_MCP_ENV } from "./piT3McpExtensionSource.ts";
import { managedMcpName, managedMcpStdio } from "./managedMcpInjection.ts";

describe("managed MCP provider configuration", () => {
  it("runs a cwd-specific stdio server with literal arguments and its configured environment", async () => {
    const cwd = NodeFS.realpathSync(NodeOS.tmpdir());
    const values = ["argument with spaces", "$(must-stay-literal)", 'quote"value', "semi;colon"];
    const config = managedMcpStdio({
      type: "stdio",
      command: process.execPath,
      args: [
        "-e",
        "process.stdout.write(JSON.stringify({ cwd: process.cwd(), args: process.argv.slice(1), key: process.env.MCP_TEST_KEY }))",
        "--",
        ...values,
      ],
      env: { MCP_TEST_KEY: "fixture-key" },
      cwd,
    });
    const result = await NodeUtil.promisify(NodeChildProcess.execFile)(
      config.command,
      config.args,
      {
        env: { ...process.env, ...config.env },
      },
    );
    assert.deepEqual(JSON.parse(result.stdout), { cwd, args: values, key: "fixture-key" });
  });

  it("adds assigned transports beside T3 tools without preapproving third-party tools", () => {
    const threadId = ThreadId.make("managed-injection");
    const session = {
      environmentId: EnvironmentId.make("managed-environment"),
      threadId,
      providerSessionId: "managed-session",
      providerInstanceId: ProviderInstanceId.make("codex"),
      endpoint: "http://127.0.0.1:1/t3",
      authorizationHeader: "Bearer t3-secret",
      browserToolsAvailable: false,
      managedMcp: {
        revision: 4,
        servers: [
          {
            id: "remote",
            enabled: true,
            transport: {
              type: "http" as const,
              url: "https://mcp.example.test",
              headers: { "X-Key": "private" },
            },
          },
          {
            id: "local",
            enabled: true,
            transport: {
              type: "stdio" as const,
              command: "test-server",
              args: ["--read-only"],
              env: { KEY: "private" },
            },
          },
          {
            id: "disabled",
            enabled: false,
            transport: { type: "http" as const, url: "https://disabled.example.test", headers: {} },
          },
        ],
      },
    };
    setMcpProviderSession(session);
    try {
      const remote = managedMcpName("remote");
      const local = managedMcpName("local");
      const disabled = managedMcpName("disabled");
      assert.match(remote, /^t3-managed-remote-[a-f0-9]{16}$/);
      assert.match(
        managedMcpName("Catalog id / unsafe", "thread"),
        /^t3-code-managed-Catalog-id---unsafe-[a-f0-9]{16}$/,
      );
      const longName = managedMcpName("a".repeat(64), threadId);
      assert.isAtMost(longName.length, 64);
      assert.notEqual(longName, managedMcpName("a".repeat(63) + "b", threadId));
      assert.notEqual(longName, managedMcpName("a".repeat(64), "sibling"));
      const expected = {
        [remote]: {
          type: "http" as const,
          url: "https://mcp.example.test",
          headers: { "X-Key": "private" },
        },
        [local]: {
          type: "stdio" as const,
          command: "test-server",
          args: ["--read-only"],
          env: { KEY: "private" },
        },
      };
      const claude = claudeMcpQueryOverrides({
        threadId,
        readOnlySandbox: false,
        disallowedTools: ["Bash"],
      });
      assert.deepInclude(claude.mcpServers, expected);
      assert.isUndefined(claude.mcpServers?.[disabled]);
      assert.deepEqual(claude.allowedTools, ["mcp__t3-code__*"]);
      assert.deepEqual(claude.disallowedTools, ["Bash", `mcp__${disabled}__*`]);
      const cursor = cursorMcpServers(threadId);
      assert.deepInclude(cursor, expected);
      assert.isUndefined(cursor?.[disabled]);
      assert.deepEqual(cursor?.["t3-code"], {
        type: "http",
        url: session.endpoint,
        headers: { Authorization: session.authorizationHeader },
      });
      assert.deepInclude(codexThreadRuntimeParams({ threadId }).config.mcp_servers, {
        [remote]: {
          enabled: true,
          url: "https://mcp.example.test",
          http_headers: { "X-Key": "private" },
        },
        [local]: {
          enabled: true,
          command: "test-server",
          args: ["--read-only"],
          env: { KEY: "private" },
        },
        [disabled]: { enabled: false, url: "https://disabled.example.test", http_headers: {} },
      });
      const pi = buildPiRpcLaunch({
        launchArgs: [],
        environment: { [T3_MANAGED_MCP_ENV]: "stale" },
        mcpSession: session,
        extensionPath: "/tmp/extension.ts",
      });
      assert.deepEqual(
        JSON.parse(pi.env[T3_MANAGED_MCP_ENV]!),
        session.managedMcp.servers
          .filter((entry) => entry.enabled)
          .map((entry) => ({ name: managedMcpName(entry.id), transport: entry.transport })),
      );
      const noPiMcp = buildPiRpcLaunch({
        launchArgs: [],
        environment: pi.env,
        mcpSession: undefined,
        extensionPath: "/tmp/extension.ts",
      });
      assert.isUndefined(noPiMcp.env[T3_MANAGED_MCP_ENV]);
    } finally {
      clearMcpProviderSession(threadId);
    }
  });
});
