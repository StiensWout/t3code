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
  PI_T3_SUBAGENT_EXTENSION_FILENAME,
  T3_PI_CHILD_SESSION_ROOT_ENV,
} from "./piT3SubagentExtensionSource.ts";
import {
  buildPiRpcLaunch,
  discoverPiUserExtensions,
  T3_PI_MCP_EXTENSION_PATH_ENV,
  materializePiT3McpExtension,
  materializePiT3SubagentExtension,
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

  it("builds one deduplicated extension launch with scoped T3 credentials", () => {
    const launch = buildPiRpcLaunch({
      launchArgs:
        "--session-dir /tmp/pi-sessions --extension /opt/pi/examples/extensions/subagent/index.ts --extension /tmp/cache/pi-t3-subagent-extension.ts --extension /home/user/.pi/agent/extensions/demo.ts",
      environment: { PATH: "/usr/bin" },
      mcpSession,
      extensionPath: "/tmp/cache/pi-t3-mcp-extension.ts",
      subagentExtensionPath: "/tmp/cache/pi-t3-subagent-extension.ts",
      discoveredExtensionPaths: ["/home/user/.pi/agent/extensions/demo.ts"],
    });
    assert.deepEqual(launch.args, [
      "--mode",
      "rpc",
      "--no-extensions",
      "--extension",
      "/tmp/cache/pi-t3-subagent-extension.ts",
      "--extension",
      "/home/user/.pi/agent/extensions/demo.ts",
      "--session-dir",
      "/tmp/pi-sessions",
      "--extension",
      "/tmp/cache/pi-t3-mcp-extension.ts",
    ]);
    assert.equal(launch.env[T3_PI_CHILD_SESSION_ROOT_ENV], "/tmp/pi-sessions/children");
    assert.equal(launch.env[T3_MCP_URL_ENV], "http://127.0.0.1:43123/mcp");
    assert.equal(launch.env[T3_MCP_BEARER_ENV], "secret-pi-token");
    assert.equal(launch.env[T3_PI_MCP_EXTENSION_PATH_ENV], "/tmp/cache/pi-t3-mcp-extension.ts");
    assert.equal(
      launch.args.filter((arg) => arg === "/tmp/cache/pi-t3-subagent-extension.ts").length,
      1,
    );
  });

  it.effect("materializes both runtime extensions", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const cacheDir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-pi-extensions-" });
      const mcpDest = yield* materializePiT3McpExtension(cacheDir);
      const subagentDest = yield* materializePiT3SubagentExtension(cacheDir);
      assert.isTrue(mcpDest.endsWith(PI_T3_MCP_EXTENSION_FILENAME));
      assert.isTrue(subagentDest.endsWith(PI_T3_SUBAGENT_EXTENSION_FILENAME));
      const mcpSource = yield* fs.readFileString(mcpDest);
      const subagentSource = yield* fs.readFileString(subagentDest);
      assert.include(mcpSource, "export default async function t3McpExtension");
      // Orchestration guidance rides the system-prompt hook, not the user
      // message, so first-turn slash commands still expand.
      assert.include(mcpSource, "before_agent_start");
      assert.include(mcpSource, '"mcp-protocol-version"');
      assert.include(mcpSource, '"tools/call"');
      assert.include(subagentSource, "export default function t3SubagentExtension");
      assert.include(subagentSource, "--session");
      assert.include(subagentSource, T3_PI_CHILD_SESSION_ROOT_ENV);
      // Children re-attach the T3 MCP extension so t3_thread_* tools survive
      // the nested spawn (T3_MCP_* env is inherited from the parent).
      assert.include(subagentSource, T3_PI_MCP_EXTENSION_PATH_ENV);
      assert.isFalse(subagentSource.includes("--no-session"));
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect("discovers user extensions from the agent dir and skips the subagent", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const home = yield* fs.makeTempDirectoryScoped({ prefix: "t3-pi-home-" });
      const extensionsDir = `${home}/.pi/agent/extensions`;
      yield* fs.makeDirectory(`${extensionsDir}/todos`, { recursive: true });
      yield* fs.makeDirectory(`${extensionsDir}/subagent`, { recursive: true });
      yield* fs.writeFileString(`${extensionsDir}/demo.ts`, "export default () => {}");
      yield* fs.writeFileString(`${extensionsDir}/subagent.ts`, "export default () => {}");
      yield* fs.writeFileString(`${extensionsDir}/todos/index.ts`, "export default () => {}");
      yield* fs.writeFileString(`${extensionsDir}/subagent/index.ts`, "export default () => {}");
      const found = yield* discoverPiUserExtensions({
        environment: { HOME: home },
        cwd: undefined,
      });
      assert.deepEqual(found, [`${extensionsDir}/demo.ts`, `${extensionsDir}/todos/index.ts`]);
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect("includes project extensions only under standing project trust", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const home = yield* fs.makeTempDirectoryScoped({ prefix: "t3-pi-home-" });
      const project = yield* fs.makeTempDirectoryScoped({ prefix: "t3-pi-project-" });
      yield* fs.makeDirectory(`${home}/.pi/agent`, { recursive: true });
      yield* fs.makeDirectory(`${project}/.pi/extensions`, { recursive: true });
      yield* fs.writeFileString(`${project}/.pi/extensions/local.ts`, "export default () => {}");
      const untrusted = yield* discoverPiUserExtensions({
        environment: { HOME: home },
        cwd: project,
      });
      assert.deepEqual(untrusted, []);
      yield* fs.writeFileString(
        `${home}/.pi/agent/settings.json`,
        '{ "defaultProjectTrust": "always" }',
      );
      const trusted = yield* discoverPiUserExtensions({
        environment: { HOME: home },
        cwd: project,
      });
      assert.deepEqual(trusted, [`${project}/.pi/extensions/local.ts`]);
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );
});
