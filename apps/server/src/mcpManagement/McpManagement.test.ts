import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import { expect, it } from "@effect/vitest";
import {
  EnvironmentId,
  ProviderInstanceId,
  ProviderDriverKind,
  ThreadId,
  McpManagementError,
  type ManagedMcpServer,
} from "@t3tools/contracts";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";
import * as Schema from "effect/Schema";
import * as TestClock from "effect/testing/TestClock";
import { HttpClient, HttpClientResponse, HttpServerRequest, HttpServerResponse } from "effect/http";
import { vi } from "vite-plus/test";

import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as McpSessionRegistry from "../mcp/McpSessionRegistry.ts";
import type { McpThreadInvocationScope } from "../mcp/McpInvocationContext.ts";
import * as McpManagement from "./McpManagement.ts";
import * as McpOAuthClient from "./McpOAuthClient.ts";
import * as ManagedMcpHttp from "./ManagedMcpHttp.ts";

const CODEX = ProviderInstanceId.make("codex");
const CLAUDE = ProviderInstanceId.make("claudeAgent");
const THREAD = ThreadId.make("mcp-test-thread");
const ORIGIN = "https://mcp.example.test";
const CALLBACK = "http://127.0.0.1:7777/oauth/managed-mcp/callback?id=remote";
const remote: ManagedMcpServer = {
  id: "remote",
  name: "Remote tools",
  providerInstanceIds: [CODEX],
  transport: {
    type: "http",
    url: `${ORIGIN}/mcp`,
    headers: { "X-Api-Key": { value: "${MCP_API_KEY}", sensitive: true } },
    oauth: { clientId: "t3-client" },
  },
};
const stdio: ManagedMcpServer = {
  id: "local",
  name: "Local tools",
  providerInstanceIds: [CODEX],
  transport: {
    type: "stdio",
    command: "npx",
    args: ["example-mcp"],
    env: { TOKEN: { value: "private", sensitive: true } },
  },
};
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const encodeError = Schema.encodeSync(Schema.fromJsonString(McpManagementError));

const makeHarness = Effect.gen(function* () {
  vi.stubEnv("MCP_API_KEY", "host-signin-secret");
  yield* Effect.addFinalizer(() => Effect.sync(() => vi.unstubAllEnvs()));
  const values = new Map<string, Uint8Array>();
  const oauthProbes: Array<Headers> = [];
  const catalogWriteStarted = yield* Deferred.make<void>();
  const finishCatalogWrite = yield* Deferred.make<void>();
  let blockCatalogWrite = false;
  let blockAfterCatalogWrite = false;
  let failCatalogWrite = false;
  let rejectRefresh = false;
  const store = ServerSecretStore.ServerSecretStore.of({
    get: (name) => Effect.sync(() => Option.fromUndefinedOr(values.get(name))),
    set: (name, value) =>
      Effect.gen(function* () {
        if (name === "managed-mcp-catalog" && blockCatalogWrite) {
          if (blockAfterCatalogWrite) values.set(name, value);
          yield* Deferred.succeed(catalogWriteStarted, undefined);
          yield* Deferred.await(finishCatalogWrite);
        }
        if (name === "managed-mcp-catalog" && failCatalogWrite)
          return yield* new ServerSecretStore.SecretStorePersistError({
            resource: "test catalog",
            cause: new Error("cannot save"),
          });
        values.set(name, value);
      }),
    remove: (name) =>
      Effect.sync(() => {
        values.delete(name);
      }),
    create: () => Effect.die("unused"),
    getOrCreateRandom: () => Effect.die("unused"),
  });
  const credentials = new Map<string, McpThreadInvocationScope>();
  let credentialCounter = 0;
  const registry = McpSessionRegistry.McpSessionRegistry.of({
    issue: (input) =>
      Effect.sync(() => {
        const id = `session-${++credentialCounter}`;
        const environmentId = EnvironmentId.make("mcp-test-env");
        credentials.set(id, {
          environmentId,
          capabilities: new Set(),
          issuedAt: 0,
          requestNamespace: id,
          client: undefined,
          thread: {
            threadId: input.threadId,
            providerInstanceId: input.providerInstanceId,
            providerSessionId: id,
          },
        });
        return {
          config: {
            environmentId,
            threadId: input.threadId,
            providerInstanceId: input.providerInstanceId,
            providerSessionId: id,
            endpoint: "http://127.0.0.1:9999/mcp",
            authorizationHeader: `Bearer ${id}`,
            browserToolsAvailable: false,
          },
        };
      }),
    resolve: (token) => Effect.sync(() => credentials.get(token)),
    revokeProviderSession: (id) =>
      Effect.sync(() => {
        credentials.delete(id);
      }),
    revokeThread: (thread) =>
      Effect.sync(() => {
        for (const [id, credential] of credentials)
          if (credential.thread.threadId === thread) credentials.delete(id);
      }),
    revokeAll: Effect.sync(() => {
      credentials.clear();
    }),
    touch: () => Effect.void,
  });
  const sdkMock = vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    const url = new URL(
      typeof input === "string" ? input : input instanceof URL ? input.href : input.url,
    );
    if (url.pathname === "/mcp") oauthProbes.push(new Headers(init?.headers));
    if (url.pathname.startsWith("/.well-known/oauth-protected-resource"))
      return json({
        resource: remote.transport.type === "http" ? remote.transport.url : "",
        authorization_servers: [ORIGIN],
      });
    if (url.pathname.startsWith("/.well-known/oauth-authorization-server"))
      return json({
        issuer: ORIGIN,
        authorization_endpoint: `${ORIGIN}/authorize`,
        token_endpoint: `${ORIGIN}/token`,
        response_types_supported: ["code"],
        code_challenge_methods_supported: ["S256"],
      });
    if (url.pathname === "/token") {
      const body = new URLSearchParams(String(init?.body));
      if (rejectRefresh && body.get("grant_type") === "refresh_token")
        return json({ error: "invalid_grant" }, 400);
      return json({
        access_token: "oauth-access",
        refresh_token: "oauth-refresh",
        token_type: "Bearer",
        expires_in: 3600,
      });
    }
    return json({}, 404);
  });
  yield* Effect.addFinalizer(() => Effect.sync(() => sdkMock.mockRestore()));
  const secretLayer = Layer.succeed(ServerSecretStore.ServerSecretStore, store);
  const settingsLayer = ServerSettings.layerTest({
    providerInstances: {
      [CODEX]: {
        driver: ProviderDriverKind.make("codex"),
        config: {},
        environment: [{ name: "MCP_API_KEY", value: "initial-secret", sensitive: true }],
      },
    },
  });
  const httpLayer = ManagedMcpHttp.layer.pipe(
    Layer.provide(
      Layer.succeed(
        HttpClient.HttpClient,
        HttpClient.make((request) =>
          Effect.succeed(
            HttpClientResponse.fromWeb(
              request,
              json({
                apiKey: request.headers["x-api-key"],
                authorization: request.headers.authorization,
              }),
            ),
          ),
        ),
      ),
    ),
  );
  const layer = McpManagement.layer.pipe(
    Layer.provideMerge(
      McpOAuthClient.layer.pipe(Layer.provide(secretLayer), Layer.provide(NodeCrypto.layer)),
    ),
    Layer.provideMerge(settingsLayer),
    Layer.provide(httpLayer),
    Layer.provide(Layer.succeed(McpSessionRegistry.McpSessionRegistry, registry)),
    Layer.provide(secretLayer),
  );
  return {
    layer,
    oauthProbes,
    corruptOAuthGrants: () => {
      for (const name of values.keys())
        if (name !== "managed-mcp-catalog")
          values.set(name, new TextEncoder().encode("broken OAuth grant"));
    },
    registry,
    blockWrite: () => {
      blockCatalogWrite = true;
    },
    blockAfterWrite: () => {
      blockCatalogWrite = true;
      blockAfterCatalogWrite = true;
    },
    seedCatalog: (configuration: string) => {
      values.set("managed-mcp-catalog", new TextEncoder().encode(configuration));
    },
    writeStarted: Deferred.await(catalogWriteStarted),
    finishWrite: Deferred.succeed(finishCatalogWrite, undefined),
    failWrite: () => {
      failCatalogWrite = true;
    },
    rejectRefresh: () => {
      rejectRefresh = true;
    },
  };
});

const signIn = Effect.fnUntraced(function* (service: McpManagement.McpManagement["Service"]) {
  const flow = yield* service.startOAuth({ id: remote.id, redirectUrl: CALLBACK });
  yield* service.completeOAuthRedirect({
    id: remote.id,
    state: new URL(flow.authorizationUrl).searchParams.get("state")!,
    code: "valid-code",
  });
});

it.effect(
  "provider-only header values do not block shared OAuth sign-in or either callback and remain available to the provider session",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const harness = yield* makeHarness;
        vi.stubEnv("T3_MCP_PROVIDER_ONLY_731", undefined);
        yield* Effect.gen(function* () {
          const service = yield* McpManagement.McpManagement;
          const settings = yield* ServerSettings.ServerSettingsService;
          if (remote.transport.type !== "http") return yield* Effect.die("HTTP fixture required.");
          yield* settings.updateSettings({
            providerInstances: {
              [CODEX]: {
                driver: ProviderDriverKind.make("codex"),
                config: {},
                environment: [
                  {
                    name: "T3_MCP_PROVIDER_ONLY_731",
                    value: "provider-only-secret",
                    sensitive: true,
                  },
                ],
              },
            },
          });
          yield* service.upsert({
            server: {
              ...remote,
              transport: {
                ...remote.transport,
                headers: {
                  "X-Api-Key": { value: "${T3_MCP_PROVIDER_ONLY_731}", sensitive: true },
                  "X-Literal": { value: "kept", sensitive: false },
                },
              },
            },
            expectedRevision: 0,
          });
          yield* signIn(service);
          expect(harness.oauthProbes[0]?.has("x-api-key")).toBe(false);
          expect(harness.oauthProbes[0]?.get("x-literal")).toBe("kept");
          const flow = yield* service.startOAuth({ id: remote.id, redirectUrl: CALLBACK });
          const callback = new URL(CALLBACK);
          callback.searchParams.set(
            "state",
            new URL(flow.authorizationUrl).searchParams.get("state")!,
          );
          callback.searchParams.set("code", "valid-code");
          expect(
            (yield* service.completeOAuth({ id: remote.id, callbackUrl: callback.href })).servers[0]
              ?.authStatus,
          ).toBe("connected");
          const issued = yield* harness.registry.issue({
            threadId: THREAD,
            providerInstanceId: CODEX,
          });
          expect((yield* service.resolveSession(issued.config)).servers[0]?.enabled).toBe(true);
          const response = yield* service.forward(
            remote.id,
            HttpServerRequest.fromWeb(
              new Request("http://t3.test/mcp/managed/remote", {
                headers: { authorization: issued.config.authorizationHeader },
              }),
            ),
          );
          expect(yield* Effect.promise(() => HttpServerResponse.toWeb(response).text())).toContain(
            "provider-only-secret",
          );
        }).pipe(Effect.provide(harness.layer));
      }),
    ),
);

it.effect(
  "an unreadable OAuth grant requires sign-in while catalog reads and unrelated mutations remain usable",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const harness = yield* makeHarness;
        yield* Effect.gen(function* () {
          const service = yield* McpManagement.McpManagement;
          yield* service.upsert({ server: remote, expectedRevision: 0 });
          yield* signIn(service);
          expect(harness.oauthProbes[0]?.get("x-api-key")).toBe("host-signin-secret");
          yield* service.upsert({ server: stdio, expectedRevision: 1 });
          harness.corruptOAuthGrants();
          expect(
            (yield* service.list).servers.find((server) => server.id === remote.id)?.authStatus,
          ).toBe("sign-in-required");
          const updated = yield* service.setEnabled({
            id: stdio.id,
            providerInstanceId: CODEX,
            enabled: false,
          });
          expect(updated.revision).toBe(3);
          expect(
            updated.servers.find((server) => server.id === stdio.id)?.providerInstanceIds,
          ).toEqual([]);
          expect(updated.servers.find((server) => server.id === remote.id)?.authStatus).toBe(
            "sign-in-required",
          );
          const snapshot = yield* service.subscribe.pipe(Stream.take(1), Stream.runCollect);
          expect(snapshot[0]?.revision).toBe(3);
        }).pipe(Effect.provide(harness.layer));
      }),
    ),
);

it.effect("header order, secret labels and empty public client secrets preserve OAuth grants", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const harness = yield* makeHarness;
      yield* Effect.gen(function* () {
        const service = yield* McpManagement.McpManagement;
        if (remote.transport.type !== "http") return yield* Effect.die("HTTP fixture required.");
        yield* service.upsert({
          server: {
            ...remote,
            transport: {
              ...remote.transport,
              headers: {
                "X-First": { value: "one", sensitive: false },
                "X-Second": { value: "two", sensitive: false },
              },
            },
          },
          expectedRevision: 0,
        });
        yield* signIn(service);
        const reordered = yield* service.upsert({
          server: {
            ...remote,
            transport: {
              ...remote.transport,
              headers: {
                "x-second": { value: "two", sensitive: true },
                "x-first": { value: "one", sensitive: false },
              },
            },
          },
          expectedRevision: 1,
        });
        expect(reordered.servers[0]?.authStatus).toBe("connected");
        const reorderedServer = reordered.servers[0];
        if (reorderedServer?.transport.type !== "http")
          return yield* Effect.die("HTTP fixture required.");
        const blankSecret = yield* service.upsert({
          server: {
            ...reorderedServer,
            transport: {
              ...reorderedServer.transport,
              oauth: {
                ...reorderedServer.transport.oauth,
                clientSecret: { value: "", sensitive: true },
              },
            },
          },
          expectedRevision: 2,
        });
        expect(blankSecret.servers[0]?.authStatus).toBe("connected");
        const omittedSecret = yield* service.upsert({
          server: reorderedServer,
          expectedRevision: 3,
        });
        expect(omittedSecret.servers[0]?.authStatus).toBe("connected");
        const changed = yield* service.upsert({
          server: {
            ...remote,
            transport: {
              ...remote.transport,
              headers: {
                "X-First": { value: "changed", sensitive: false },
                "X-Second": { value: "two", sensitive: true },
              },
            },
          },
          expectedRevision: 4,
        });
        expect(changed.servers[0]?.authStatus).toBe("signed-out");
      }).pipe(Effect.provide(harness.layer));
    }),
  ),
);

it.effect("wire errors omit parser input and secret-bearing causes", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const harness = yield* makeHarness;
      yield* Effect.gen(function* () {
        const service = yield* McpManagement.McpManagement;
        const result = yield* service
          .importPreview({
            providerInstanceId: CODEX,
            configuration:
              '{"mcpServers":{"private-secret":{"command":123,"env":{"TOKEN":"secret-value"}}}}',
          })
          .pipe(Effect.result);
        expect(result._tag).toBe("Failure");
        if (result._tag === "Failure") {
          const encoded = encodeError(result.failure);
          expect(JSON.parse(encoded)).toEqual({
            _tag: "McpManagementError",
            operation: "import",
            reason: "invalid-config",
          });
          expect(encoded).not.toContain("private-secret");
          expect(encoded).not.toContain("secret-value");
          expect(encoded).not.toContain("cause");
        }
      }).pipe(Effect.provide(harness.layer));
    }),
  ),
);

it.effect(
  "redacts secrets, preserves omitted secret edits, copies assignments, and rejects stale revisions",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const harness = yield* makeHarness;
        yield* Effect.gen(function* () {
          const service = yield* McpManagement.McpManagement;
          const saved = yield* service.upsert({ server: stdio, expectedRevision: 0 });
          const definition = saved.servers[0]!;
          expect(definition.transport.type).toBe("stdio");
          if (definition.transport.type === "stdio")
            expect(definition.transport.env.TOKEN).toEqual({
              value: "",
              sensitive: true,
              valueRedacted: true,
            });
          const edited = yield* service.upsert({
            server: {
              ...definition,
              name: "Renamed tools",
              transport:
                definition.transport.type === "stdio"
                  ? {
                      ...definition.transport,
                      env: { TOKEN: { value: "", sensitive: false, valueRedacted: true } },
                    }
                  : definition.transport,
            },
            expectedRevision: 1,
          });
          expect(edited.revision).toBe(2);
          expect(edited.servers[0]?.transport).toMatchObject({
            env: { TOKEN: { value: "", sensitive: true, valueRedacted: true } },
          });
          expect(
            (yield* service.upsert({ server: stdio, expectedRevision: 1 }).pipe(Effect.result))
              ._tag,
          ).toBe("Failure");
          const copied = yield* service.copy({ source: CODEX, target: CLAUDE });
          expect(copied.servers[0]?.providerInstanceIds).toEqual([CODEX, CLAUDE]);
          const issued = yield* harness.registry.issue({
            threadId: THREAD,
            providerInstanceId: CLAUDE,
          });
          const runtime = yield* service.resolveSession(issued.config);
          const transport = runtime.servers[0]?.transport;
          expect(transport?.type).toBe("stdio");
          if (transport?.type === "stdio") expect(transport.env.TOKEN).toBe("private");
          const stale = yield* service
            .remove({ id: stdio.id, expectedRevision: 1 })
            .pipe(Effect.result);
          expect(stale._tag).toBe("Failure");
          if (stale._tag === "Failure") expect(stale.failure.reason).toBe("conflict");
        }).pipe(Effect.provide(harness.layer));
      }),
    ),
);

it.effect(
  "imports JSONC with leading comments and native TOML without saving or importing native grants",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const harness = yield* makeHarness;
        yield* Effect.gen(function* () {
          const service = yield* McpManagement.McpManagement;
          const preview = yield* service.importPreview({
            providerInstanceId: CODEX,
            configuration: `// Native settings\n{ "mcpServers": { "github": { "url": "https://mcp.example.test/mcp", "headers": { "Authorization": "Bearer private" } }, "t3-code": { "url": "http://localhost/mcp" } } }`,
          });
          expect(preview.servers.map((server) => server.id)).toEqual(["github"]);
          expect(preview.warnings.some((warning) => warning.includes("skipped"))).toBe(true);
          expect((yield* service.list).servers).toEqual([]);
          const toml = yield* service.importPreview({
            providerInstanceId: CODEX,
            configuration:
              '[mcp_servers.docs]\nurl = "https://mcp.example.test/mcp"\nbearer_token_env_var = "DOCS_TOKEN"\n',
          });
          expect(toml.servers[0]?.transport).toMatchObject({
            type: "http",
            oauth: null,
            headers: { Authorization: { value: "Bearer ${DOCS_TOKEN}", sensitive: true } },
          });
        }).pipe(Effect.provide(harness.layer));
      }),
    ),
);

it.effect("previews valid import siblings and preserves anonymous HTTP transport", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const harness = yield* makeHarness;
      yield* Effect.gen(function* () {
        const service = yield* McpManagement.McpManagement;
        const preview = yield* service.importPreview({
          providerInstanceId: CODEX,
          configuration: JSON.stringify({
            mcpServers: {
              anonymous: { url: `${ORIGIN}/mcp` },
              oauth: { url: `${ORIGIN}/mcp`, oauth: { clientId: "known-client" } },
              broken: { command: 123, env: { TOKEN: "secret" } },
            },
          }),
        });
        expect(preview.servers.map((server) => server.id)).toEqual(["anonymous", "oauth"]);
        expect(preview.servers[0]?.transport).toMatchObject({ oauth: null });
        expect(preview.servers[1]?.transport).toMatchObject({
          oauth: { clientId: "known-client" },
        });
        expect(preview.warnings).toContain("broken: invalid configuration was skipped.");
      }).pipe(Effect.provide(harness.layer));
    }),
  ),
);

it.effect(
  "finishes and publishes a durable catalog commit after the requesting client disconnects",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const harness = yield* makeHarness;
        yield* Effect.gen(function* () {
          const service = yield* McpManagement.McpManagement;
          const published = yield* Deferred.make<void>();
          const watching = yield* Deferred.make<void>();
          yield* service.subscribe.pipe(
            Stream.runForEach((snapshot) =>
              snapshot.revision === 1
                ? Deferred.succeed(published, undefined)
                : Deferred.succeed(watching, undefined),
            ),
            Effect.forkChild,
          );
          yield* Deferred.await(watching);
          harness.blockAfterWrite();
          const saving = yield* service
            .upsert({ server: stdio, expectedRevision: 0 })
            .pipe(Effect.forkChild);
          yield* harness.writeStarted;
          const disconnected = yield* Fiber.interrupt(saving).pipe(
            Effect.forkChild({ startImmediately: true }),
          );
          yield* harness.finishWrite;
          yield* Fiber.join(disconnected);
          expect((yield* Fiber.await(saving))._tag).toBe("Failure");
          yield* Deferred.await(published);
          expect((yield* service.list).revision).toBe(1);
          expect((yield* service.list).servers[0]?.id).toBe(stdio.id);
        }).pipe(Effect.provide(harness.layer));
        yield* Effect.gen(function* () {
          const service = yield* McpManagement.McpManagement;
          expect((yield* service.list).revision).toBe(1);
          expect((yield* service.list).servers[0]?.id).toBe(stdio.id);
        }).pipe(Effect.provide(harness.layer));
      }),
    ),
);

it.effect("skips an MCP with missing environment input while starting valid siblings", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const harness = yield* makeHarness;
      yield* Effect.gen(function* () {
        const service = yield* McpManagement.McpManagement;
        yield* service.upsert({
          server: {
            ...stdio,
            transport: {
              ...stdio.transport,
              type: "stdio",
              command: "node",
              args: [],
              env: { TOKEN: { value: "${T3_MCP_TEST_UNSET_723}", sensitive: true } },
            },
          },
          expectedRevision: 0,
        });
        yield* service.upsert({ server: { ...stdio, id: "valid" }, expectedRevision: 1 });
        const issued = yield* harness.registry.issue({
          threadId: THREAD,
          providerInstanceId: CODEX,
        });
        const resolved = yield* service.resolveSession(issued.config);
        expect(resolved.servers.map(({ id, enabled }) => ({ id, enabled }))).toEqual([
          { id: "local", enabled: false },
          { id: "valid", enabled: true },
        ]);
        expect((yield* service.list).sessions[0]?.issues).toEqual([
          {
            serverId: "local",
            message: "Set the T3_MCP_TEST_UNSET_723 environment variable for this provider.",
          },
        ]);
      }).pipe(Effect.provide(harness.layer));
    }),
  ),
);

it.effect(
  "retains unsupported assignments for editing, drops removed providers, and disables external OpenCode sessions",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const harness = yield* makeHarness;
        yield* Effect.gen(function* () {
          const service = yield* McpManagement.McpManagement;
          const settings = yield* ServerSettings.ServerSettingsService;
          const opencode = ProviderInstanceId.make("opencode");
          yield* service.upsert({
            server: { ...stdio, providerInstanceIds: [CODEX, opencode] },
            expectedRevision: 0,
          });
          yield* settings.updateSettings({
            providerInstances: {
              [opencode]: {
                driver: ProviderDriverKind.make("opencode"),
                config: { serverUrl: "https://external.example.test" },
                environment: [],
              },
            },
          });
          const saved = yield* service.upsert({
            server: {
              ...stdio,
              name: "Still editable",
              providerInstanceIds: [CODEX, opencode, ProviderInstanceId.make("removed-provider")],
            },
            expectedRevision: 1,
          });
          expect(saved.servers[0]?.providerInstanceIds).toEqual([CODEX, opencode]);
          const issued = yield* harness.registry.issue({
            threadId: THREAD,
            providerInstanceId: opencode,
          });
          expect((yield* service.resolveSession(issued.config)).servers[0]?.enabled).toBe(false);
          expect((yield* service.list).sessions[0]?.issues).toEqual([
            { serverId: "local", message: "Managed MCPs require a T3-owned OpenCode server." },
          ]);
          const disabled = yield* service.setEnabled({
            id: stdio.id,
            providerInstanceId: opencode,
            enabled: false,
          });
          expect(disabled.servers[0]?.providerInstanceIds).toEqual([CODEX]);
        }).pipe(Effect.provide(harness.layer));
      }),
    ),
);

it.effect(
  "corrupt catalog storage does not prevent service boot or provider start and cannot be overwritten",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const harness = yield* makeHarness;
        harness.seedCatalog("not valid JSON private-input");
        yield* Effect.gen(function* () {
          const service = yield* McpManagement.McpManagement;
          const failed = yield* service.list.pipe(Effect.result);
          expect(failed._tag).toBe("Failure");
          if (failed._tag === "Failure") expect(failed.failure.reason).toBe("storage");
          const issued = yield* harness.registry.issue({
            threadId: THREAD,
            providerInstanceId: CODEX,
          });
          expect((yield* service.resolveSession(issued.config)).servers).toEqual([]);
          expect(
            (yield* service.upsert({ server: stdio, expectedRevision: 0 }).pipe(Effect.result))
              ._tag,
          ).toBe("Failure");
        }).pipe(Effect.provide(harness.layer));
        yield* Effect.gen(function* () {
          const service = yield* McpManagement.McpManagement;
          expect((yield* service.list.pipe(Effect.result))._tag).toBe("Failure");
        }).pipe(Effect.provide(harness.layer));
      }),
    ),
);

it.effect(
  "freezes provider headers and assignments for the session and shows configuration changes awaiting restart",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const harness = yield* makeHarness;
        yield* Effect.gen(function* () {
          const service = yield* McpManagement.McpManagement;
          const settings = yield* ServerSettings.ServerSettingsService;
          yield* service.upsert({ server: remote, expectedRevision: 0 });
          yield* signIn(service);
          const issued = yield* harness.registry.issue({
            threadId: THREAD,
            providerInstanceId: CODEX,
          });
          const runtime = yield* service.resolveSession(issued.config);
          expect(runtime.servers[0]?.transport).toMatchObject({
            type: "http",
            url: "http://127.0.0.1:9999/mcp/managed/remote",
            headers: { Authorization: issued.config.authorizationHeader },
          });
          yield* settings.updateSettings({
            providerInstances: {
              [CODEX]: {
                driver: ProviderDriverKind.make("codex"),
                config: {},
                environment: [{ name: "MCP_API_KEY", value: "changed-secret", sensitive: true }],
              },
            },
          });
          yield* service.setEnabled({ id: remote.id, providerInstanceId: CODEX, enabled: false });
          const snapshot = yield* service.list;
          expect(snapshot.sessions[0]?.revision).toBe(1);
          expect(snapshot.revision).toBe(2);
          const response = yield* service.forward(
            remote.id,
            HttpServerRequest.fromWeb(
              new Request("http://t3.test/mcp/managed/remote", {
                headers: { authorization: issued.config.authorizationHeader },
              }),
            ),
          );
          const body = yield* Effect.promise(() => HttpServerResponse.toWeb(response).text());
          expect(body).toContain("initial-secret");
          expect(body).not.toContain("changed-secret");
          yield* service.releaseSession(THREAD, issued.config.providerSessionId);
          expect(
            (yield* service
              .forward(
                remote.id,
                HttpServerRequest.fromWeb(
                  new Request("http://t3.test/mcp/managed/remote", {
                    headers: { authorization: issued.config.authorizationHeader },
                  }),
                ),
              )
              .pipe(Effect.result))._tag,
          ).toBe("Failure");
        }).pipe(Effect.provide(harness.layer));
      }),
    ),
);

it.effect(
  "blocks sign-in during the catalog persistence gap and preserves the previous catalog on save failure",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const harness = yield* makeHarness;
        yield* Effect.gen(function* () {
          const service = yield* McpManagement.McpManagement;
          yield* service.upsert({ server: remote, expectedRevision: 0 });
          harness.blockWrite();
          const changed = {
            ...remote,
            transport: { ...remote.transport, url: `${ORIGIN}/changed` },
          };
          const fiber = yield* service
            .upsert({ server: changed, expectedRevision: 1 })
            .pipe(Effect.result, Effect.forkChild);
          yield* harness.writeStarted;
          const started = yield* service
            .startOAuth({ id: remote.id, redirectUrl: CALLBACK })
            .pipe(Effect.result);
          expect(started._tag).toBe("Failure");
          harness.failWrite();
          yield* harness.finishWrite;
          expect((yield* Fiber.join(fiber))._tag).toBe("Failure");
          const snapshot = yield* service.list;
          expect(snapshot.revision).toBe(1);
          expect(snapshot.servers[0]?.transport).toMatchObject({ url: `${ORIGIN}/mcp` });
        }).pipe(Effect.provide(harness.layer));
      }),
    ),
);

it.effect("publishes OAuth expiry and rejected refresh grants to subscribed clients", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const harness = yield* makeHarness;
      yield* Effect.gen(function* () {
        const service = yield* McpManagement.McpManagement;
        const oauth = yield* McpOAuthClient.McpOAuthClient;
        yield* service.upsert({ server: remote, expectedRevision: 0 });
        yield* service.startOAuth({ id: remote.id, redirectUrl: CALLBACK });
        const expired = yield* Deferred.make<void>();
        const signInRequired = yield* Deferred.make<void>();
        const initial = yield* Deferred.make<void>();
        yield* service.subscribe.pipe(
          Stream.runForEach((snapshot) =>
            Effect.gen(function* () {
              yield* Deferred.succeed(initial, undefined);
              if (snapshot.servers[0]?.authStatus === "signed-out")
                yield* Deferred.succeed(expired, undefined);
              if (snapshot.servers[0]?.authStatus === "sign-in-required")
                yield* Deferred.succeed(signInRequired, undefined);
            }),
          ),
          Effect.forkScoped,
        );
        yield* Deferred.await(initial);
        yield* TestClock.adjust(300_001);
        yield* Deferred.await(expired);
        yield* signIn(service);
        harness.rejectRefresh();
        expect(
          (yield* oauth
            .accessToken({ id: remote.id, url: `${ORIGIN}/mcp` }, "oauth-access")
            .pipe(Effect.result))._tag,
        ).toBe("Failure");
        yield* Deferred.await(signInRequired);
      }).pipe(Effect.provide(harness.layer));
    }),
  ),
);
