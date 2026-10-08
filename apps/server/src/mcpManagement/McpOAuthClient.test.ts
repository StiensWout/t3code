import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Deferred from "effect/Deferred";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";
import { vi } from "vite-plus/test";

import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import * as McpOAuthClient from "./McpOAuthClient.ts";

const ORIGIN = "https://mcp.example.test";
const TARGET = { id: "test-server", url: `${ORIGIN}/mcp` };
const CALLBACK = "http://127.0.0.1:7777/oauth/mcp/callback";
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const callbackState = (flow: { readonly authorizationUrl: string }) =>
  new URL(flow.authorizationUrl).searchParams.get("state")!;

const makeHarness = Effect.gen(function* () {
  const bytes = new Map<string, Uint8Array>();
  const registrations: unknown[] = [];
  const exchanges: URLSearchParams[] = [];
  const refreshRequests: URLSearchParams[] = [];
  const requests: Array<{ url: string; headers: Headers }> = [];
  let customDiscovery = false;
  let failResourceProbe = false;
  let blockedPreparation: "probe" | "discovery" | "registration" | undefined;
  const preparationStarted = Promise.withResolvers<void>();
  let blockGrantWrite = false;
  const grantWriteStarted = yield* Deferred.make<void>();
  const finishGrantWrite = yield* Deferred.make<void>();
  const refreshStarted = Promise.withResolvers<void>();
  const refreshResponse = Promise.withResolvers<Response>();
  let blockRefresh = false;
  let blockExchange = false;
  let exchangeTokens: { refresh_token?: string; expires_in?: number } = {
    refresh_token: "refresh-grant",
    expires_in: 3600,
  };
  const exchangeStarted = Promise.withResolvers<void>();
  const exchangeResponse = Promise.withResolvers<Response>();
  const mock = vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    const url = new URL(
      typeof input === "string" ? input : input instanceof URL ? input.href : input.url,
    );
    requests.push({ url: url.href, headers: new Headers(init?.headers) });
    if (
      (blockedPreparation === "probe" && url.href === TARGET.url) ||
      (blockedPreparation === "discovery" &&
        url.pathname.startsWith("/.well-known/oauth-protected-resource")) ||
      (blockedPreparation === "registration" && url.pathname === "/register")
    ) {
      preparationStarted.resolve();
      return new Promise<Response>((_resolve, reject) => {
        if (init?.signal?.aborted) return reject(new Error("request aborted"));
        init?.signal?.addEventListener("abort", () => reject(new Error("request aborted")), {
          once: true,
        });
      });
    }
    if (failResourceProbe && url.href === TARGET.url)
      throw new TypeError("Resource GET is unavailable.");
    if (customDiscovery && url.href === TARGET.url)
      return new Response(null, {
        status: 401,
        headers: {
          "WWW-Authenticate":
            'Bearer resource_metadata="https://metadata.example.test/custom", scope="tools:custom"',
        },
      });
    if (customDiscovery && url.href === "https://metadata.example.test/custom")
      return json({ resource: TARGET.url, authorization_servers: ["https://auth.example.test"] });
    if (url.pathname.startsWith("/.well-known/oauth-protected-resource"))
      return json({
        resource: TARGET.url,
        authorization_servers: [ORIGIN],
        scopes_supported: ["tools:read"],
      });
    if (url.pathname.startsWith("/.well-known/oauth-authorization-server"))
      return json({
        issuer: customDiscovery ? "https://auth.example.test/" : ORIGIN,
        authorization_endpoint: `${customDiscovery ? "https://auth.example.test" : ORIGIN}/authorize`,
        token_endpoint: `${customDiscovery ? "https://auth.example.test" : ORIGIN}/token`,
        registration_endpoint: `${customDiscovery ? "https://auth.example.test" : ORIGIN}/register`,
        response_types_supported: ["code"],
        code_challenge_methods_supported: ["S256"],
        token_endpoint_auth_methods_supported: ["none"],
      });
    if (url.pathname === "/register") {
      const body: unknown = JSON.parse(String(init?.body));
      registrations.push(body);
      return json({ client_id: "registered-client", redirect_uris: [CALLBACK] });
    }
    if (url.pathname === "/token") {
      const params = new URLSearchParams(String(init?.body));
      if (params.get("grant_type") === "refresh_token") {
        refreshRequests.push(params);
        refreshStarted.resolve();
        if (blockRefresh)
          return Promise.race([
            refreshResponse.promise,
            new Promise<Response>((_resolve, reject) => {
              init?.signal?.addEventListener("abort", () => reject(new Error("request aborted")), {
                once: true,
              });
            }),
          ]);
        return json({
          access_token: `refreshed-${refreshRequests.length}`,
          token_type: "Bearer",
          expires_in: 3600,
        });
      }
      exchanges.push(params);
      exchangeStarted.resolve();
      if (blockExchange) return exchangeResponse.promise;
      return json({
        access_token: `grant-${exchanges.length}`,
        token_type: "Bearer",
        ...exchangeTokens,
      });
    }
    return json({}, 404);
  });
  yield* Effect.addFinalizer(() => Effect.sync(() => mock.mockRestore()));
  const store = ServerSecretStore.ServerSecretStore.of({
    get: (name) => Effect.sync(() => Option.fromUndefinedOr(bytes.get(name))),
    set: (name, value) =>
      Effect.gen(function* () {
        bytes.set(name, value);
        if (blockGrantWrite) {
          yield* Deferred.succeed(grantWriteStarted, undefined);
          yield* Deferred.await(finishGrantWrite);
        }
      }),
    remove: (name) =>
      Effect.sync(() => {
        bytes.delete(name);
      }),
    create: () => Effect.die("unused"),
    getOrCreateRandom: () => Effect.die("unused"),
  });
  const layer = McpOAuthClient.layer.pipe(
    Layer.provide(Layer.succeed(ServerSecretStore.ServerSecretStore, store)),
    Layer.provide(NodeCrypto.layer),
  );
  return {
    layer,
    registrations,
    exchanges,
    refreshRequests,
    requests,
    blockGrantWrite: () => {
      blockGrantWrite = true;
    },
    grantWriteStarted: Deferred.await(grantWriteStarted),
    finishGrantWrite: Effect.sync(() => {
      blockGrantWrite = false;
    }).pipe(Effect.andThen(Deferred.succeed(finishGrantWrite, undefined))),
    customDiscovery: () => {
      customDiscovery = true;
    },
    failResourceProbe: () => {
      failResourceProbe = true;
    },
    blockPreparation: (stage: NonNullable<typeof blockedPreparation>) => {
      blockedPreparation = stage;
    },
    preparationStarted: preparationStarted.promise,
    refreshStarted: refreshStarted.promise,
    finishRefresh: refreshResponse.resolve,
    blockRefresh: () => {
      blockRefresh = true;
    },
    exchangeStarted: exchangeStarted.promise,
    finishExchange: exchangeResponse.resolve,
    blockExchange: () => {
      blockExchange = true;
    },
    exchangeTokens: (tokens: typeof exchangeTokens) => {
      exchangeTokens = tokens;
    },
  };
});

const signIn = Effect.fnUntraced(function* (client: McpOAuthClient.McpOAuthClient["Service"]) {
  const flow = yield* client.begin({ ...TARGET, redirectUrl: CALLBACK });
  const authorization = new URL(flow.authorizationUrl);
  const callbackUrl = new URL(CALLBACK);
  callbackUrl.searchParams.set("code", "one-time-code");
  callbackUrl.searchParams.set("state", authorization.searchParams.get("state")!);
  yield* client.complete({
    id: TARGET.id,
    flowId: flow.flowId,
    callbackUrl: callbackUrl.toString(),
  });
  return { flow, authorization };
});

it.effect(
  "sign-in preparation times out during probing, discovery or registration and publishes cleared status",
  () =>
    Effect.gen(function* () {
      for (const stage of ["probe", "discovery", "registration"] as const) {
        yield* Effect.scoped(
          Effect.gen(function* () {
            const harness = yield* makeHarness;
            harness.blockPreparation(stage);
            yield* Effect.gen(function* () {
              const client = yield* McpOAuthClient.McpOAuthClient;
              const nextChange = yield* Stream.toPull(client.changes);
              const authorizing = yield* nextChange.pipe(
                Effect.forkChild({ startImmediately: true }),
              );
              const starting = yield* client
                .begin({ ...TARGET, redirectUrl: CALLBACK })
                .pipe(Effect.result, Effect.forkChild({ startImmediately: true }));
              yield* Effect.promise(() => harness.preparationStarted);
              expect(yield* Fiber.join(authorizing)).toEqual([TARGET.id]);
              expect((yield* client.status(TARGET)).phase).toBe("authorizing");
              const cleared = yield* nextChange.pipe(Effect.forkChild({ startImmediately: true }));
              yield* TestClock.adjust("30 seconds");
              const result = yield* Fiber.join(starting);
              expect(result._tag).toBe("Failure");
              if (result._tag === "Failure") expect(result.failure.reason).toBe("oauth");
              expect(yield* Fiber.join(cleared)).toEqual([TARGET.id]);
              expect((yield* client.status(TARGET)).phase).toBe("signed-out");
            }).pipe(Effect.provide(harness.layer));
          }),
        );
      }
    }),
);

it.effect(
  "disconnecting a preparing sign-in publishes its cleared flow to another subscriber",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const harness = yield* makeHarness;
        harness.blockPreparation("discovery");
        yield* Effect.gen(function* () {
          const client = yield* McpOAuthClient.McpOAuthClient;
          const nextChange = yield* Stream.toPull(client.changes);
          const authorizing = yield* nextChange.pipe(Effect.forkChild({ startImmediately: true }));
          const starting = yield* client
            .begin({ ...TARGET, redirectUrl: CALLBACK })
            .pipe(Effect.forkChild({ startImmediately: true }));
          yield* Effect.promise(() => harness.preparationStarted);
          expect(yield* Fiber.join(authorizing)).toEqual([TARGET.id]);
          expect((yield* client.status(TARGET)).phase).toBe("authorizing");
          const cleared = yield* nextChange.pipe(Effect.forkChild({ startImmediately: true }));
          yield* Fiber.interrupt(starting);
          expect((yield* Fiber.await(starting))._tag).toBe("Failure");
          expect(yield* Fiber.join(cleared)).toEqual([TARGET.id]);
          expect((yield* client.status(TARGET)).phase).toBe("signed-out");
        }).pipe(Effect.provide(harness.layer));
      }),
    ),
);

it.effect(
  "falls back to OAuth metadata when resource probing fails and accepts a callback without a public flow id",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const harness = yield* makeHarness;
        harness.failResourceProbe();
        yield* Effect.gen(function* () {
          const client = yield* McpOAuthClient.McpOAuthClient;
          const flow = yield* client.begin({
            ...TARGET,
            redirectUrl: CALLBACK,
            headers: { "x-api-key": "resource-only-secret" },
          });
          const callback = new URL(CALLBACK);
          callback.searchParams.set("state", callbackState(flow));
          callback.searchParams.set("code", "valid-code");
          yield* client.complete({ id: TARGET.id, callbackUrl: callback.href });
          expect((yield* client.status(TARGET)).phase).toBe("connected");
          expect(
            harness.requests.some((request) =>
              request.url.includes("/.well-known/oauth-protected-resource"),
            ),
          ).toBe(true);
          expect(
            harness.requests.slice(1).every((request) => !request.headers.has("x-api-key")),
          ).toBe(true);
        }).pipe(Effect.provide(harness.layer));
      }),
    ),
);

it.effect(
  "discovers and registers an OAuth client, uses PKCE, and restores the grant across server restarts",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const harness = yield* makeHarness;
        yield* Effect.gen(function* () {
          const client = yield* McpOAuthClient.McpOAuthClient;
          const { authorization } = yield* signIn(client);
          expect(authorization.searchParams.get("code_challenge_method")).toBe("S256");
          expect(authorization.searchParams.get("resource")).toBe(TARGET.url);
          expect(authorization.searchParams.get("scope")).toBe("tools:read");
          expect(harness.registrations).toHaveLength(1);
          expect(harness.exchanges[0]?.get("code_verifier")).toBeTruthy();
          expect(harness.exchanges[0]?.get("redirect_uri")).toBe(CALLBACK);
          expect(yield* client.accessToken(TARGET)).toBe("grant-1");
        }).pipe(Effect.provide(harness.layer));
        yield* Effect.gen(function* () {
          const client = yield* McpOAuthClient.McpOAuthClient;
          expect((yield* client.status(TARGET)).phase).toBe("connected");
          expect(yield* client.accessToken(TARGET)).toBe("grant-1");
          expect(harness.refreshRequests).toHaveLength(0);
        }).pipe(Effect.provide(harness.layer));
      }),
    ),
);

it.effect("uses non-refreshable tokens until expiry and requires sign-in after rejection", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const harness = yield* makeHarness;
      yield* Effect.gen(function* () {
        const client = yield* McpOAuthClient.McpOAuthClient;
        harness.exchangeTokens({ expires_in: 1 });
        yield* signIn(client);
        expect(yield* client.accessToken(TARGET)).toBe("grant-1");
        yield* TestClock.adjust("1 second");
        expect((yield* client.accessToken(TARGET).pipe(Effect.result))._tag).toBe("Failure");
        expect((yield* client.status(TARGET)).phase).toBe("sign-in-required");
        harness.exchangeTokens({});
        yield* signIn(client);
        expect(yield* client.accessToken(TARGET)).toBe("grant-2");
        expect((yield* client.accessToken(TARGET, "grant-2").pipe(Effect.result))._tag).toBe(
          "Failure",
        );
        expect((yield* client.status(TARGET)).phase).toBe("sign-in-required");
        expect(harness.refreshRequests).toHaveLength(0);
      }).pipe(Effect.provide(harness.layer));
    }),
  ),
);

it.effect("rejects callbacks from another flow and makes cancellation and expiry visible", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const harness = yield* makeHarness;
      yield* Effect.gen(function* () {
        const client = yield* McpOAuthClient.McpOAuthClient;
        const flow = yield* client.begin({ ...TARGET, redirectUrl: CALLBACK });
        expect((yield* client.status(TARGET)).phase).toBe("authorizing");
        const result = yield* client
          .complete({
            id: TARGET.id,
            flowId: flow.flowId,
            callbackUrl: `${CALLBACK}?code=code&state=other`,
          })
          .pipe(Effect.result);
        expect(result._tag).toBe("Failure");
        if (result._tag === "Failure") expect(result.failure.reason).toBe("invalid-callback");
        expect(harness.exchanges).toHaveLength(0);
        yield* client.cancel({ id: TARGET.id, flowId: flow.flowId });
        expect((yield* client.status(TARGET)).phase).toBe("signed-out");
        yield* client.begin({ ...TARGET, redirectUrl: CALLBACK });
        yield* TestClock.adjust(300_001);
        expect((yield* client.status(TARGET)).phase).toBe("signed-out");
      }).pipe(Effect.provide(harness.layer));
    }),
  ),
);

it.effect(
  "refreshes expired tokens once for concurrent callers and preserves an omitted refresh token",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const harness = yield* makeHarness;
        yield* Effect.gen(function* () {
          const client = yield* McpOAuthClient.McpOAuthClient;
          yield* signIn(client);
          yield* TestClock.adjust(3_600_001);
          const tokens = yield* Effect.all(
            [client.accessToken(TARGET), client.accessToken(TARGET)],
            { concurrency: "unbounded" },
          );
          expect(tokens).toEqual(["refreshed-1", "refreshed-1"]);
          expect(harness.refreshRequests).toHaveLength(1);
          expect(yield* client.accessToken(TARGET, "grant-1")).toBe("refreshed-1");
          expect(harness.refreshRequests).toHaveLength(1);
          expect(yield* client.accessToken(TARGET, "refreshed-1")).toBe("refreshed-2");
          expect(harness.refreshRequests[1]?.get("refresh_token")).toBe("refresh-grant");
        }).pipe(Effect.provide(harness.layer));
      }),
    ),
);

it.effect("a late exchange cannot recreate credentials after configuration invalidation", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const harness = yield* makeHarness;
      harness.blockExchange();
      yield* Effect.gen(function* () {
        const client = yield* McpOAuthClient.McpOAuthClient;
        const fiber = yield* signIn(client).pipe(Effect.result, Effect.forkChild);
        yield* Effect.promise(() => harness.exchangeStarted);
        yield* client.invalidate(TARGET.id);
        harness.finishExchange(
          json({ access_token: "late-token", token_type: "Bearer", expires_in: 3600 }),
        );
        const result = yield* Fiber.join(fiber);
        expect(result._tag).toBe("Failure");
        expect((yield* client.status(TARGET)).phase).toBe("signed-out");
        expect((yield* client.accessToken(TARGET).pipe(Effect.result))._tag).toBe("Failure");
      }).pipe(Effect.provide(harness.layer));
    }),
  ),
);

it.effect("an old refresh rejection cannot clear a newer successful sign-in", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const harness = yield* makeHarness;
      yield* Effect.gen(function* () {
        const client = yield* McpOAuthClient.McpOAuthClient;
        yield* signIn(client);
        harness.blockRefresh();
        const fiber = yield* client
          .accessToken(TARGET, "grant-1")
          .pipe(Effect.result, Effect.forkChild);
        yield* Effect.promise(() => harness.refreshStarted);
        yield* signIn(client);
        harness.finishRefresh(json({ error: "invalid_grant" }, 400));
        expect((yield* Fiber.join(fiber))._tag).toBe("Failure");
        expect((yield* client.status(TARGET)).phase).toBe("connected");
        expect(yield* client.accessToken(TARGET)).toBe("grant-2");
      }).pipe(Effect.provide(harness.layer));
    }),
  ),
);

it.effect("cancelling a new sign-in preserves the existing grant and its in-flight refresh", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const harness = yield* makeHarness;
      yield* Effect.gen(function* () {
        const client = yield* McpOAuthClient.McpOAuthClient;
        yield* signIn(client);
        harness.blockRefresh();
        const fiber = yield* client.accessToken(TARGET, "grant-1").pipe(Effect.forkChild);
        yield* Effect.promise(() => harness.refreshStarted);
        const flow = yield* client.begin({ ...TARGET, redirectUrl: CALLBACK });
        yield* client.cancel({ id: TARGET.id, flowId: flow.flowId });
        harness.finishRefresh(
          json({
            access_token: "rotated",
            refresh_token: "rotated-refresh",
            token_type: "Bearer",
            expires_in: 3600,
          }),
        );
        expect(yield* Fiber.join(fiber)).toBe("rotated");
        expect((yield* client.status(TARGET)).phase).toBe("connected");
        expect(yield* client.accessToken(TARGET)).toBe("rotated");
      }).pipe(Effect.provide(harness.layer));
    }),
  ),
);

it.effect(
  "a disconnected callback commits its new grant and prevents an older refresh from overwriting it",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const harness = yield* makeHarness;
        yield* Effect.gen(function* () {
          const client = yield* McpOAuthClient.McpOAuthClient;
          yield* signIn(client);
          harness.blockRefresh();
          const refreshing = yield* client
            .accessToken(TARGET, "grant-1")
            .pipe(Effect.result, Effect.forkChild);
          yield* Effect.promise(() => harness.refreshStarted);
          const flow = yield* client.begin({ ...TARGET, redirectUrl: CALLBACK });
          const nextChange = yield* Stream.toPull(client.changes);
          const notification = yield* nextChange.pipe(Effect.forkChild({ startImmediately: true }));
          harness.blockGrantWrite();
          const completing = yield* client
            .completeRedirect({ id: TARGET.id, state: callbackState(flow), code: "valid-code" })
            .pipe(Effect.forkChild);
          yield* harness.grantWriteStarted;
          const disconnected = yield* Fiber.interrupt(completing).pipe(
            Effect.forkChild({ startImmediately: true }),
          );
          yield* harness.finishGrantWrite;
          yield* Fiber.join(disconnected);
          expect((yield* Fiber.await(completing))._tag).toBe("Failure");
          expect(yield* Fiber.join(notification)).toEqual([TARGET.id]);
          harness.finishRefresh(
            json({
              access_token: "old-grant-rotated",
              refresh_token: "old-refresh-rotated",
              token_type: "Bearer",
              expires_in: 3600,
            }),
          );
          const refreshed = yield* Fiber.join(refreshing);
          expect(refreshed._tag).toBe("Failure");
          if (refreshed._tag === "Failure") expect(refreshed.failure.reason).toBe("superseded");
          expect(yield* client.accessToken(TARGET)).toBe("grant-2");
          expect((yield* client.status(TARGET)).phase).toBe("connected");
        }).pipe(Effect.provide(harness.layer));
        yield* Effect.gen(function* () {
          const restarted = yield* McpOAuthClient.McpOAuthClient;
          expect(yield* restarted.accessToken(TARGET)).toBe("grant-2");
          expect((yield* restarted.status(TARGET)).phase).toBe("connected");
        }).pipe(Effect.provide(harness.layer));
      }),
    ),
);

it.effect("a disconnected token caller does not discard a rotated grant", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const harness = yield* makeHarness;
      yield* Effect.gen(function* () {
        const client = yield* McpOAuthClient.McpOAuthClient;
        yield* signIn(client);
        harness.blockRefresh();
        const requesting = yield* client.accessToken(TARGET, "grant-1").pipe(Effect.forkChild);
        yield* Effect.promise(() => harness.refreshStarted);
        yield* Fiber.interrupt(requesting);
        harness.finishRefresh(
          json({
            access_token: "rotated-after-disconnect",
            refresh_token: "rotated-refresh",
            token_type: "Bearer",
            expires_in: 3600,
          }),
        );
        expect(yield* client.accessToken(TARGET, "grant-1")).toBe("rotated-after-disconnect");
        expect(harness.refreshRequests).toHaveLength(1);
        expect((yield* client.status(TARGET)).phase).toBe("connected");
      }).pipe(Effect.provide(harness.layer));
    }),
  ),
);

it.effect("explicit invalidation aborts detached token refresh and removes its grant", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const harness = yield* makeHarness;
      yield* Effect.gen(function* () {
        const client = yield* McpOAuthClient.McpOAuthClient;
        yield* signIn(client);
        harness.blockRefresh();
        const requesting = yield* client
          .accessToken(TARGET, "grant-1")
          .pipe(Effect.result, Effect.forkChild);
        yield* Effect.promise(() => harness.refreshStarted);
        yield* client.invalidate(TARGET.id);
        expect((yield* Fiber.join(requesting))._tag).toBe("Failure");
        expect((yield* client.status(TARGET)).phase).toBe("signed-out");
      }).pipe(Effect.provide(harness.layer));
    }),
  ),
);

it.effect(
  "disposing the OAuth service interrupts pending expiry and detached refresh without waiting for their deadlines",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const harness = yield* makeHarness;
        const stopped = yield* Effect.gen(function* () {
          const client = yield* McpOAuthClient.McpOAuthClient;
          yield* signIn(client);
          harness.blockRefresh();
          yield* client.accessToken(TARGET, "grant-1").pipe(Effect.result, Effect.forkChild);
          yield* Effect.promise(() => harness.refreshStarted);
          yield* client.begin({ ...TARGET, redirectUrl: CALLBACK });
          return "service disposed";
        }).pipe(Effect.provide(harness.layer));
        expect(stopped).toBe("service disposed");
      }),
    ),
);

it.effect("a stalled detached refresh times out and releases the server's next token request", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const harness = yield* makeHarness;
      yield* Effect.gen(function* () {
        const client = yield* McpOAuthClient.McpOAuthClient;
        yield* signIn(client);
        harness.blockRefresh();
        const requesting = yield* client
          .accessToken(TARGET, "grant-1")
          .pipe(Effect.result, Effect.forkChild);
        yield* Effect.promise(() => harness.refreshStarted);
        yield* TestClock.adjust("30 seconds");
        expect((yield* Fiber.join(requesting))._tag).toBe("Failure");
        harness.finishRefresh(
          json({
            access_token: "recovered",
            refresh_token: "next-refresh",
            token_type: "Bearer",
            expires_in: 3600,
          }),
        );
        expect(yield* client.accessToken(TARGET, "grant-1")).toBe("recovered");
        expect(harness.refreshRequests).toHaveLength(2);
      }).pipe(Effect.provide(harness.layer));
    }),
  ),
);

it.effect(
  "discovers custom challenge metadata without sharing configured credentials and validates the discovered issuer",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const harness = yield* makeHarness;
        harness.customDiscovery();
        yield* Effect.gen(function* () {
          const client = yield* McpOAuthClient.McpOAuthClient;
          const flow = yield* client.begin({
            ...TARGET,
            redirectUrl: CALLBACK,
            headers: { "X-Api-Key": "resource-only-secret" },
          });
          expect(new URL(flow.authorizationUrl).origin).toBe("https://auth.example.test");
          expect(new URL(flow.authorizationUrl).searchParams.get("scope")).toBe("tools:custom");
          expect(
            (yield* client
              .completeRedirect({
                id: TARGET.id,
                state: callbackState(flow),
                code: "valid-code",
                iss: "https://auth.example.test",
              })
              .pipe(Effect.result))._tag,
          ).toBe("Failure");
          yield* client.completeRedirect({
            id: TARGET.id,
            state: callbackState(flow),
            code: "valid-code",
            iss: "https://auth.example.test/",
          });
          expect((yield* client.status(TARGET)).phase).toBe("connected");
          expect(harness.requests[0]?.headers.get("x-api-key")).toBe("resource-only-secret");
          expect(
            harness.requests.some(
              (request) => request.url === "https://metadata.example.test/custom",
            ),
          ).toBe(true);
          expect(
            harness.requests.slice(1).every((request) => !request.headers.has("x-api-key")),
          ).toBe(true);
        }).pipe(Effect.provide(harness.layer));
      }),
    ),
);

it.effect("a revoked refresh grant requires a new sign-in without retrying the revoked token", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const harness = yield* makeHarness;
      yield* Effect.gen(function* () {
        const client = yield* McpOAuthClient.McpOAuthClient;
        yield* signIn(client);
        harness.blockRefresh();
        const fiber = yield* client
          .accessToken(TARGET, "grant-1")
          .pipe(Effect.result, Effect.forkChild);
        yield* Effect.promise(() => harness.refreshStarted);
        harness.finishRefresh(json({ error: "invalid_grant" }, 400));
        expect((yield* Fiber.join(fiber))._tag).toBe("Failure");
        expect((yield* client.status(TARGET)).phase).toBe("sign-in-required");
        expect((yield* client.accessToken(TARGET).pipe(Effect.result))._tag).toBe("Failure");
        expect(harness.refreshRequests).toHaveLength(1);
      }).pipe(Effect.provide(harness.layer));
    }),
  ),
);

it.effect(
  "hosted callbacks use the registered redirect URI and a denied sign-in clears its pending flow",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const harness = yield* makeHarness;
        yield* Effect.gen(function* () {
          const client = yield* McpOAuthClient.McpOAuthClient;
          const redirectUrl = `${CALLBACK}?id=test-server`;
          const flow = yield* client.begin({ ...TARGET, redirectUrl });
          expect(callbackState(flow)).not.toBe(flow.flowId);
          expect(
            (yield* client
              .completeRedirect({ id: TARGET.id, state: flow.flowId, error: "access_denied" })
              .pipe(Effect.result))._tag,
          ).toBe("Failure");
          expect((yield* client.status(TARGET)).flowId).toBe(flow.flowId);
          yield* client.completeRedirect({
            id: TARGET.id,
            state: callbackState(flow),
            code: "valid-code",
          });
          expect(harness.exchanges[0]?.get("redirect_uri")).toBe(redirectUrl);
          expect((yield* client.status(TARGET)).phase).toBe("connected");
          yield* client.invalidate(TARGET.id);
          const denied = yield* client.begin({ ...TARGET, redirectUrl });
          expect(
            (yield* client
              .completeRedirect({
                id: TARGET.id,
                state: callbackState(denied),
                error: "access_denied",
              })
              .pipe(Effect.result))._tag,
          ).toBe("Failure");
          expect((yield* client.status(TARGET)).phase).toBe("signed-out");
          expect(harness.exchanges).toHaveLength(1);
        }).pipe(Effect.provide(harness.layer));
      }),
    ),
);
