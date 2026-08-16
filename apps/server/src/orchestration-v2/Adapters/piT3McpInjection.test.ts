import { assert, describe, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { EnvironmentId, ProviderInstanceId, ThreadId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";

import {
  PI_T3_MCP_EXTENSION_FILENAME,
  T3_MCP_BEARER_ENV,
  T3_MCP_URL_ENV,
} from "./piT3McpExtensionSource.ts";
import {
  bearerTokenFromAuthorizationHeader,
  buildPiRpcLaunch,
  materializePiT3McpExtension,
  piT3McpExtensionDestPath,
} from "./piT3McpInjection.ts";

const threadId = ThreadId.make("thread-pi-t3-mcp");

const mcpSession = {
  environmentId: EnvironmentId.make("environment-pi-t3-mcp"),
  threadId,
  providerSessionId: "mcp-session-pi",
  providerInstanceId: ProviderInstanceId.make("pi"),
  endpoint: "http://127.0.0.1:43123/mcp",
  authorizationHeader: "Bearer secret-pi-token",
};

describe("pi T3 MCP injection", () => {
  it("strips the Bearer prefix for the child env", () => {
    assert.equal(bearerTokenFromAuthorizationHeader("Bearer secret-pi-token"), "secret-pi-token");
    assert.equal(bearerTokenFromAuthorizationHeader("secret-pi-token"), "secret-pi-token");
  });

  it("leaves spawn args unchanged when no MCP session exists", () => {
    const launch = buildPiRpcLaunch({
      launchArgs: "--session-dir /tmp/pi-sessions",
      environment: { PATH: "/usr/bin" },
      mcpSession: undefined,
      extensionPath: "/tmp/pi-t3-mcp-extension.ts",
    });
    assert.isFalse(launch.hasT3Mcp);
    assert.deepEqual(launch.args, ["--mode", "rpc", "--session-dir", "/tmp/pi-sessions"]);
    assert.equal(launch.env.PATH, "/usr/bin");
    assert.isUndefined(launch.env[T3_MCP_URL_ENV]);
  });

  it("appends --extension and scoped env when a session exists", () => {
    const launch = buildPiRpcLaunch({
      launchArgs: "--session-dir /tmp/pi-sessions",
      environment: { PATH: "/usr/bin" },
      mcpSession,
      extensionPath: "/tmp/cache/pi-t3-mcp-extension.ts",
    });
    assert.isTrue(launch.hasT3Mcp);
    assert.deepEqual(launch.args, [
      "--mode",
      "rpc",
      "--session-dir",
      "/tmp/pi-sessions",
      "--extension",
      "/tmp/cache/pi-t3-mcp-extension.ts",
    ]);
    assert.equal(launch.env[T3_MCP_URL_ENV], "http://127.0.0.1:43123/mcp");
    assert.equal(launch.env[T3_MCP_BEARER_ENV], "secret-pi-token");
  });

  it("does not duplicate an already-present extension path", () => {
    const launch = buildPiRpcLaunch({
      launchArgs: "--extension /tmp/cache/pi-t3-mcp-extension.ts",
      environment: {},
      mcpSession,
      extensionPath: "/tmp/cache/pi-t3-mcp-extension.ts",
    });
    assert.deepEqual(launch.args, [
      "--mode",
      "rpc",
      "--extension",
      "/tmp/cache/pi-t3-mcp-extension.ts",
    ]);
  });

  it.effect("writes the extension source to the cache directory", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const cacheDir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-pi-t3-mcp-" });
      const dest = yield* materializePiT3McpExtension(cacheDir);
      assert.equal(dest, piT3McpExtensionDestPath(cacheDir));
      assert.isTrue(dest.endsWith(PI_T3_MCP_EXTENSION_FILENAME));
      const source = yield* fs.readFileString(dest);
      assert.include(source, "export default async function t3McpExtension");
      assert.include(source, T3_MCP_URL_ENV);
      assert.include(source, '"mcp-protocol-version"');
      assert.include(source, '"tools/call"');
      const again = yield* materializePiT3McpExtension(cacheDir);
      assert.equal(again, dest);
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );
});
