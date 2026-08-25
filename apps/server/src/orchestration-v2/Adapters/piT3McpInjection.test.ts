import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import { EnvironmentId, ProviderInstanceId, ThreadId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";

import {
  PI_T3_MCP_EXTENSION_FILENAME,
  T3_MCP_BEARER_ENV,
  T3_MCP_URL_ENV,
} from "./piT3McpExtensionSource.ts";
import {
  buildPiRpcLaunch,
  materializePiT3McpExtension,
  resolvePiLaunchArgs,
} from "./piT3McpInjection.ts";

const threadId = ThreadId.make("thread-pi-t3-mcp");

const mcpSession = {
  environmentId: EnvironmentId.make("environment-pi-t3-mcp"),
  threadId,
  providerSessionId: "mcp-session-pi",
  providerInstanceId: ProviderInstanceId.make("pi"),
  endpoint: "http://127.0.0.1:43123/mcp",
  authorizationHeader: "Bearer secret-pi-token",
  browserToolsAvailable: true,
};

describe("pi T3 MCP injection", () => {
  it("keeps native extension discovery when no MCP session exists", () => {
    const launch = buildPiRpcLaunch({
      launchArgs: ["--session-dir", "/tmp/pi-sessions"],
      environment: { PATH: "/usr/bin" },
      mcpSession: undefined,
      extensionPath: "/tmp/pi-t3-mcp-extension.ts",
    });
    assert.isFalse(launch.hasT3Mcp);
    assert.deepEqual(launch.args, ["--mode", "rpc", "--session-dir", "/tmp/pi-sessions"]);
    assert.equal(launch.env.PATH, "/usr/bin");
    assert.isUndefined(launch.env[T3_MCP_URL_ENV]);
  });

  it("adds only the namespaced T3 MCP bridge to the native Pi launch", () => {
    const launch = buildPiRpcLaunch({
      launchArgs: [
        "--extension",
        "/home/user/.pi/agent/extensions/demo.ts",
        "--session-dir",
        "/tmp/pi-sessions",
      ],
      environment: { PATH: "/usr/bin" },
      mcpSession,
      extensionPath: "/tmp/cache/pi-t3-mcp-extension.ts",
    });
    assert.deepEqual(launch.args, [
      "--mode",
      "rpc",
      "--extension",
      "/home/user/.pi/agent/extensions/demo.ts",
      "--session-dir",
      "/tmp/pi-sessions",
      "--extension",
      "/tmp/cache/pi-t3-mcp-extension.ts",
    ]);
    assert.notInclude(launch.args, "--no-extensions");
    assert.equal(launch.env[T3_MCP_URL_ENV], "http://127.0.0.1:43123/mcp");
    assert.equal(launch.env[T3_MCP_BEARER_ENV], "secret-pi-token");
  });

  it("does not register the same explicit T3 bridge twice", () => {
    const launch = buildPiRpcLaunch({
      launchArgs: ["-e", "/tmp/cache/pi-t3-mcp-extension.ts"],
      environment: {},
      mcpSession,
      extensionPath: "/tmp/cache/pi-t3-mcp-extension.ts",
    });
    assert.deepEqual(launch.args, ["--mode", "rpc", "-e", "/tmp/cache/pi-t3-mcp-extension.ts"]);
  });

  it("accepts customization flags and rejects T3-owned execution flags", () => {
    assert.deepEqual(
      resolvePiLaunchArgs(
        "--session-dir /tmp/pi --extension ./demo.ts --provider anthropic --offline --custom-flag value",
      ),
      {
        ok: true,
        args: [
          "--session-dir",
          "/tmp/pi",
          "--extension",
          "./demo.ts",
          "--provider",
          "anthropic",
          "--offline",
          "--custom-flag",
          "value",
        ],
      },
    );
    assert.deepInclude(resolvePiLaunchArgs("--mode text"), {
      ok: false,
      message: "Pi launch argument '--mode' is controlled by T3 Code and cannot be overridden.",
    });
    assert.deepInclude(resolvePiLaunchArgs("--session old.jsonl"), { ok: false });
    assert.deepInclude(resolvePiLaunchArgs("prompt pi immediately"), { ok: false });
  });

  it.effect("materializes the MCP bridge with namespaced tool registration", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const cacheDir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-pi-extensions-" });
      const mcpDest = yield* materializePiT3McpExtension(cacheDir);
      assert.isTrue(mcpDest.endsWith(PI_T3_MCP_EXTENSION_FILENAME));
      const mcpSource = yield* fs.readFileString(mcpDest);
      assert.include(mcpSource, "export default async function t3McpExtension");
      assert.include(mcpSource, "before_agent_start");
      assert.include(mcpSource, '"mcp-protocol-version"');
      assert.include(mcpSource, '"tools/call"');
      assert.include(mcpSource, "mcp__t3-code__");
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );
});
