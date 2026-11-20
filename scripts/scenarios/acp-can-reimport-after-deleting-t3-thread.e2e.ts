// @effect-diagnostics nodeBuiltinImport:off -- The scenario installs a local ACP fixture.
import * as NodePath from "node:path";

import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import { CommandId, ProviderDriverKind, ProviderInstanceId } from "@t3tools/contracts";
import { expect } from "e2e";
import * as SecureRandom from "effect/crypto/SecureRandom";
import * as Effect from "effect/Effect";

import { T3_HOME } from "../e2e.config.ts";
import { rpcClient, runPromise, test, WEB } from "./t3.ts";

const SESSION_ID = "native-conversation";
const SESSION_TITLE = "Conversation kept by the agent";
const ACP = `
import { createInterface } from "node:readline";

for await (const line of createInterface({ input: process.stdin })) {
  const { id, method, params } = JSON.parse(line);
  if (id === undefined) continue;
  const result =
    method === "initialize" ? {
      protocolVersion: 1,
      agentInfo: { name: "reimport-scenario", version: "1.0.0" },
      agentCapabilities: { loadSession: true, sessionCapabilities: { list: {} } },
      authMethods: [],
    } :
    method === "session/new" ? { sessionId: "health-probe" } :
    method === "session/load" ? {} :
    method === "session/list" ? {
      sessions: [{
        sessionId: ${JSON.stringify(SESSION_ID)},
        cwd: params.cwd,
        title: ${JSON.stringify(SESSION_TITLE)},
      }],
    } : undefined;
  process.stdout.write(JSON.stringify({
    jsonrpc: "2.0", id,
    ...(result === undefined ? { error: { code: -32601, message: "Method not found" } } : { result }),
  }) + "\\n");
}
`;

test(
  "A native ACP session can be imported again after deleting its T3 thread",
  WEB,
  async ({ t3, app, screen }) => {
    const instanceId = ProviderInstanceId.make("scenario-reimport-agent");
    const workspaceRoot = await t3.project("demo", { "reimport-agent.mjs": ACP });
    await runPromise(
      Effect.gen(function* () {
        const client = yield* rpcClient(T3_HOME, app.baseUrl ?? "");
        yield* client["server.updateSettings"]({
          patch: {},
          providerInstanceMutation: {
            operation: "upsert",
            instanceId,
            instance: {
              driver: ProviderDriverKind.make("acpRegistry"),
              displayName: "Reimport scenario agent",
              enabled: true,
              config: {
                source: "local",
                commandPath: process.execPath,
                commandArgs: [NodePath.join(workspaceRoot, "reimport-agent.mjs")],
              },
            },
          },
        });
      }).pipe(Effect.scoped),
    );

    const settings = `/settings/providers?instanceId=${instanceId}`;
    await t3.open(settings);
    await screen.getByRole("button", "List sessions", { exact: true }).tap({ timeout: 60_000 });
    await screen.getByText(SESSION_TITLE, { exact: true }).waitFor();
    const importButton = screen.getByRole("button", "Import", { exact: true });
    const imported = screen.getByRole("button", "Imported", { exact: true });
    await importButton.tap();
    await imported.waitFor({ timeout: 60_000 });

    await runPromise(
      Effect.gen(function* () {
        const client = yield* rpcClient(T3_HOME, app.baseUrl ?? "");
        const { projects } = yield* client["orchestration.getArchivedShellSnapshot"]({});
        const project = projects.find((candidate) => candidate.workspaceRoot === workspaceRoot);
        if (project === undefined) throw new Error("Could not find the scenario project");
        const listed = yield* client["server.listAcpRegistrySessions"]({
          instanceId,
          projectId: project.id,
        });
        const threadId = listed.sessions.find(
          (session) => session.sessionId === SESSION_ID,
        )?.importedThreadId;
        if (threadId == null) throw new Error("The first import did not create a thread");
        const random = yield* SecureRandom.SecureRandom;
        yield* client["orchestration.dispatchCommand"]({
          type: "thread.delete",
          commandId: CommandId.make(yield* random.uuidV4()),
          threadId,
        });
      }).pipe(Effect.scoped, Effect.provide(NodeCrypto.layer)),
    );

    await screen.getByRole("button", "Refresh", { exact: true }).tap();
    await importButton.tap({ timeout: 60_000 });
    await screen.getByRole("button", "Importing", { exact: true }).waitFor({
      state: "hidden",
      timeout: 60_000,
    });
    await app.screenshot("native-session-after-reimport");
    expect(await imported.isVisible(), "The native session can be imported again").toBe(true);
  },
);
