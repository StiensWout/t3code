// @effect-diagnostics globalFetch:off globalFetchInEffect:off -- The MCP SDK's async OAuth boundary requires FetchLike; requests receive the fiber's abort signal.
import {
  discoverOAuthServerInfo,
  extractWWWAuthenticateParams,
  exchangeAuthorization,
  refreshAuthorization,
  registerClient,
  startAuthorization,
  type OAuthServerInfo,
} from "@modelcontextprotocol/sdk/client/auth.js";
import {
  OAuthClientInformationSchema,
  OAuthMetadataSchema,
  OAuthTokensSchema,
  type OAuthClientInformationMixed,
  type OAuthTokens,
} from "@modelcontextprotocol/sdk/shared/auth.js";
import {
  checkResourceAllowed,
  resourceUrlFromServerUrl,
} from "@modelcontextprotocol/sdk/shared/auth-utils.js";
import {
  InvalidClientError,
  InvalidGrantError,
  UnauthorizedClientError,
} from "@modelcontextprotocol/sdk/server/auth/errors.js";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as PubSub from "effect/PubSub";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";

import * as ServerSecretStore from "../auth/ServerSecretStore.ts";

export class McpOAuthClientError extends Schema.TaggedError<McpOAuthClientError>()(
  "McpOAuthClientError",
  {
    id: Schema.String,
    operation: Schema.Literals(["begin", "complete", "cancel", "status", "token", "invalidate"]),
    reason: Schema.Literals([
      "not-authorized",
      "invalid-callback",
      "expired-flow",
      "superseded",
      "oauth",
      "storage",
    ]),
    cause: Schema.optional(Schema.Defect()),
  },
) {
  override get message() {
    switch (this.reason) {
      case "not-authorized":
        return "Sign in to this MCP server before using it.";
      case "invalid-callback":
        return "This redirect URL does not belong to the active MCP sign-in.";
      case "expired-flow":
        return "This MCP sign-in has expired. Start again.";
      case "superseded":
        return "The MCP configuration or sign-in changed. Start again.";
      case "storage":
        return "Could not store or read MCP sign-in credentials.";
      case "oauth":
        return "MCP sign-in could not be completed. Try again.";
    }
  }
}

type Target = { readonly id: string; readonly url: string };
type FlowTarget = { readonly id: string; readonly flowId: string };

export class McpOAuthClient extends Context.Service<
  McpOAuthClient,
  {
    readonly changes: Stream.Stream<string>;
    readonly begin: (
      input: Target & {
        readonly headers?: Readonly<Record<string, string>>;
        readonly scope?: string;
        readonly clientId?: string;
        readonly clientSecret?: string;
        readonly redirectUrl: string;
        /** The catalog rechecks identity without waiting on the catalog mutation lock. */
        readonly validate?: Effect.Effect<void, McpOAuthClientError>;
      },
    ) => Effect.Effect<
      { readonly flowId: string; readonly authorizationUrl: string; readonly expiresAt: number },
      McpOAuthClientError
    >;
    readonly complete: (input: {
      readonly id: string;
      readonly flowId?: string;
      readonly callbackUrl: string;
    }) => Effect.Effect<void, McpOAuthClientError>;
    /** Server-hosted redirects use the pending flow's registered URI, including its original origin. */
    readonly completeRedirect: (input: {
      readonly id: string;
      readonly state: string;
      readonly code?: string;
      readonly error?: string;
      readonly iss?: string;
    }) => Effect.Effect<void, McpOAuthClientError>;
    readonly cancel: (input: FlowTarget) => Effect.Effect<void, McpOAuthClientError>;
    readonly status: (input: Target) => Effect.Effect<
      {
        readonly phase: "signed-out" | "connected" | "sign-in-required" | "authorizing";
        readonly expiresAt: number | null;
        readonly flowId?: string;
      },
      McpOAuthClientError
    >;
    /** A rejected token requests one refresh; concurrent rejections reuse its replacement. */
    readonly accessToken: (
      input: Target,
      rejectedToken?: string,
    ) => Effect.Effect<string, McpOAuthClientError>;
    readonly invalidate: (id: string) => Effect.Effect<void, McpOAuthClientError>;
  }
>()("t3/mcpManagement/McpOAuthClient") {}

const StoredGrant = Schema.Struct({
  url: Schema.String,
  issuer: Schema.String,
  metadata: Schema.optionalKey(Schema.Unknown),
  client: Schema.Unknown,
  resource: Schema.NullOr(Schema.String),
  tokens: Schema.NullOr(Schema.Unknown),
  expiresAt: Schema.NullOr(Schema.Number),
});
const decodeGrant = Schema.decodeSync(Schema.fromJsonString(StoredGrant));
const encodeGrant = Schema.encodeSync(Schema.fromJsonString(StoredGrant));
type Grant = typeof StoredGrant.Type;
const FLOW_TTL_MS = 5 * 60_000;
const TOKEN_REFRESH_MARGIN_MS = 30_000;

interface Authorization {
  readonly url: string;
  readonly redirectUrl: string;
  readonly info: OAuthServerInfo;
  readonly client: OAuthClientInformationMixed;
  readonly resource?: URL;
  readonly verifier: string;
}

interface PendingFlow {
  readonly id: string;
  readonly state: string;
  readonly generation: number;
  readonly expiresAt: number;
  readonly controller: AbortController;
  authorization?: Authorization;
  exchanging?: boolean;
  expiry?: Fiber.Fiber<void>;
}

interface RecordState {
  generation: number;
  grantGeneration: number;
  readonly writes: Semaphore.Semaphore;
  readonly refresh: Semaphore.Semaphore;
  flow?: PendingFlow | undefined;
  refreshController?: AbortController | undefined;
}

/** Owns one environment-local grant per MCP server. Providers receive only an opaque T3 credential. */
const make = Effect.gen(function* () {
  const store = yield* ServerSecretStore.ServerSecretStore;
  const crypto = yield* Crypto.Crypto;
  const scope = yield* Scope.Scope;
  const changes = yield* PubSub.sliding<string>(128);
  const notify = (id: string) => PubSub.publish(changes, id).pipe(Effect.asVoid);
  const records = new Map<string, RecordState>();
  const recordFor = (id: string) => {
    let record = records.get(id);
    if (!record) {
      record = {
        generation: 0,
        grantGeneration: 0,
        writes: Semaphore.makeUnsafe(1),
        refresh: Semaphore.makeUnsafe(1),
      };
      records.set(id, record);
    }
    return record;
  };
  yield* Effect.addFinalizer(() =>
    Effect.sync(() => {
      for (const record of records.values()) {
        record.flow?.controller.abort();
        record.refreshController?.abort();
      }
    }),
  );

  const nameFor = (id: string) =>
    crypto.digest("SHA-256", new TextEncoder().encode(id)).pipe(
      Effect.map(
        (digest) =>
          `managed-mcp-oauth-${Array.from(digest, (byte) => byte.toString(16).padStart(2, "0")).join("")}`,
      ),
      Effect.orDie,
    );
  const readGrant = Effect.fnUntraced(function* (
    id: string,
    operation: McpOAuthClientError["operation"],
  ) {
    const value = yield* store
      .get(yield* nameFor(id))
      .pipe(
        Effect.mapError(
          (cause) => new McpOAuthClientError({ id, operation, reason: "storage", cause }),
        ),
      );
    return yield* Effect.try({
      try: () =>
        Option.isSome(value) ? decodeGrant(new TextDecoder().decode(value.value)) : undefined,
      catch: (cause) => new McpOAuthClientError({ id, operation, reason: "storage", cause }),
    });
  });
  const writeGrant = (id: string, operation: McpOAuthClientError["operation"], grant: Grant) =>
    Effect.gen(function* () {
      const value = yield* Effect.try({
        try: () => new TextEncoder().encode(encodeGrant(grant)),
        catch: (cause) => new McpOAuthClientError({ id, operation, reason: "storage", cause }),
      });
      yield* store
        .set(yield* nameFor(id), value)
        .pipe(
          Effect.mapError(
            (cause) => new McpOAuthClientError({ id, operation, reason: "storage", cause }),
          ),
        );
    });
  const requireGeneration = (
    id: string,
    operation: McpOAuthClientError["operation"],
    current: number,
    generation: number,
  ) =>
    current === generation
      ? Effect.void
      : Effect.fail(new McpOAuthClientError({ id, operation, reason: "superseded" }));

  // SDK functions are the async network boundary. Redirects never forward a code, token, or client secret.
  const fetchFor =
    (signal: AbortSignal, controller: AbortController) =>
    (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) =>
      fetch(input, {
        ...init,
        redirect: "error",
        signal: AbortSignal.any([signal, controller.signal]),
      });
  const expiryFor = (tokens: OAuthTokens, now: number) =>
    tokens.expires_in === undefined ? null : now + tokens.expires_in * 1_000;
  const parseTokens = (id: string, operation: McpOAuthClientError["operation"], value: unknown) =>
    Effect.try({
      try: () => {
        const tokens = OAuthTokensSchema.parse(value);
        if (tokens.token_type.toLowerCase() !== "bearer") throw new Error("Unsupported token type");
        return tokens;
      },
      catch: (cause) => new McpOAuthClientError({ id, operation, reason: "oauth", cause }),
    });

  const begin: McpOAuthClient["Service"]["begin"] = Effect.fn("McpOAuthClient.begin")(
    function* (input) {
      const record = recordFor(input.id);
      const generation = yield* record.writes.withPermit(
        Effect.gen(function* () {
          if (input.validate) yield* input.validate;
          record.flow?.controller.abort();
          record.generation += 1;
          return record.generation;
        }),
      );
      const state = yield* crypto.randomBytes(32).pipe(
        Effect.map((bytes) => Buffer.from(bytes).toString("base64url")),
        Effect.orDie,
      );
      const flowId = yield* crypto.randomBytes(32).pipe(
        Effect.map((bytes) => Buffer.from(bytes).toString("base64url")),
        Effect.orDie,
      );
      const flow: PendingFlow = {
        id: flowId,
        state,
        generation,
        expiresAt: (yield* Clock.currentTimeMillis) + FLOW_TTL_MS,
        controller: new AbortController(),
      };
      yield* record.writes.withPermit(
        Effect.gen(function* () {
          yield* requireGeneration(input.id, "begin", record.generation, generation);
          record.flow = flow;
        }),
      );
      yield* notify(input.id);
      const expiry = yield* Effect.sleep(FLOW_TTL_MS).pipe(
        Effect.andThen(
          record.writes.withPermit(
            Effect.sync(() => {
              if (record.flow !== flow) return;
              record.flow = undefined;
              flow.controller.abort();
            }).pipe(Effect.andThen(notify(input.id))),
          ),
        ),
        Effect.forkIn(scope),
      );
      flow.expiry = expiry;
      const prepare = Effect.gen(function* () {
        const challenge = yield* Effect.tryPromise({
          try: async (signal) => {
            // Custom credentials belong only to the configured resource, never its authorization server.
            const response = await fetchFor(signal, flow.controller)(input.url, {
              method: "GET",
              ...(input.headers ? { headers: input.headers } : {}),
            });
            const params = extractWWWAuthenticateParams(response);
            await response.body?.cancel();
            return params;
          },
          catch: (cause) =>
            new McpOAuthClientError({ id: input.id, operation: "begin", reason: "oauth", cause }),
        }).pipe(
          Effect.catch(() => Effect.succeed({ resourceMetadataUrl: undefined, scope: undefined })),
        );
        const info = yield* Effect.tryPromise({
          try: (signal) =>
            discoverOAuthServerInfo(input.url, {
              ...(challenge.resourceMetadataUrl
                ? { resourceMetadataUrl: challenge.resourceMetadataUrl }
                : {}),
              fetchFn: fetchFor(signal, flow.controller),
            }),
          catch: (cause) =>
            new McpOAuthClientError({ id: input.id, operation: "begin", reason: "oauth", cause }),
        });
        const resource = yield* Effect.try({
          try: () => {
            if (!info.resourceMetadata) return undefined;
            if (
              !checkResourceAllowed({
                requestedResource: resourceUrlFromServerUrl(input.url),
                configuredResource: info.resourceMetadata.resource,
              })
            )
              throw new Error("Mismatched OAuth resource");
            return new URL(info.resourceMetadata.resource);
          },
          catch: (cause) =>
            new McpOAuthClientError({ id: input.id, operation: "begin", reason: "oauth", cause }),
        });
        const scope =
          input.scope ?? challenge.scope ?? info.resourceMetadata?.scopes_supported?.join(" ");
        const client = input.clientId
          ? {
              client_id: input.clientId,
              ...(input.clientSecret ? { client_secret: input.clientSecret } : {}),
            }
          : yield* Effect.tryPromise({
              try: (signal) =>
                registerClient(info.authorizationServerUrl, {
                  ...(info.authorizationServerMetadata
                    ? { metadata: info.authorizationServerMetadata }
                    : {}),
                  clientMetadata: {
                    client_name: "T3 Code",
                    redirect_uris: [input.redirectUrl],
                    grant_types: ["authorization_code", "refresh_token"],
                    response_types: ["code"],
                    token_endpoint_auth_method: "none",
                    ...(scope ? { scope } : {}),
                  },
                  fetchFn: fetchFor(signal, flow.controller),
                }),
              catch: (cause) =>
                new McpOAuthClientError({
                  id: input.id,
                  operation: "begin",
                  reason: "oauth",
                  cause,
                }),
            });
        const authorization = yield* Effect.tryPromise({
          try: () =>
            startAuthorization(info.authorizationServerUrl, {
              ...(info.authorizationServerMetadata
                ? { metadata: info.authorizationServerMetadata }
                : {}),
              clientInformation: client,
              redirectUrl: input.redirectUrl,
              state,
              ...(scope ? { scope } : {}),
              ...(resource ? { resource } : {}),
            }),
          catch: (cause) =>
            new McpOAuthClientError({ id: input.id, operation: "begin", reason: "oauth", cause }),
        });
        yield* record.writes.withPermit(
          Effect.gen(function* () {
            yield* requireGeneration(input.id, "begin", record.generation, generation);
            if (input.validate) yield* input.validate;
            if (record.flow !== flow || flow.controller.signal.aborted)
              return yield* new McpOAuthClientError({
                id: input.id,
                operation: "begin",
                reason: "expired-flow",
              });
            flow.authorization = {
              url: input.url,
              redirectUrl: input.redirectUrl,
              info,
              client,
              ...(resource ? { resource } : {}),
              verifier: authorization.codeVerifier,
            };
          }),
        );
        return {
          flowId: flow.id,
          authorizationUrl: authorization.authorizationUrl.toString(),
          expiresAt: flow.expiresAt,
        };
      });
      return yield* prepare.pipe(
        Effect.timeoutOrElse({
          duration: "30 seconds",
          orElse: () =>
            Effect.fail(
              new McpOAuthClientError({
                id: input.id,
                operation: "begin",
                reason: "oauth",
              }),
            ),
        }),
        Effect.onExit((exit) =>
          Exit.isSuccess(exit)
            ? Effect.void
            : record.writes
                .withPermit(
                  Effect.sync(() => {
                    if (record.flow === flow) record.flow = undefined;
                    flow.controller.abort();
                  }),
                )
                .pipe(
                  Effect.andThen(Fiber.interrupt(expiry)),
                  Effect.andThen(notify(input.id)),
                  Effect.asVoid,
                ),
        ),
      );
    },
  );

  const complete: McpOAuthClient["Service"]["complete"] = Effect.fn("McpOAuthClient.complete")(
    function* (input) {
      const record = recordFor(input.id);
      const flow = record.flow;
      const now = yield* Clock.currentTimeMillis;
      if (
        !flow ||
        (input.flowId !== undefined && flow.id !== input.flowId) ||
        !flow.authorization ||
        now >= flow.expiresAt
      )
        return yield* new McpOAuthClientError({
          id: input.id,
          operation: "complete",
          reason: "expired-flow",
        });
      const authorization = flow.authorization;
      const response = yield* Effect.try({
        try: () => {
          const url = new URL(input.callbackUrl);
          const redirect = new URL(authorization.redirectUrl);
          if (
            input.callbackUrl.length > 16_384 ||
            url.origin !== redirect.origin ||
            url.pathname !== redirect.pathname ||
            url.username ||
            url.password ||
            url.hash ||
            url.searchParams.getAll("state").length !== 1 ||
            url.searchParams.get("state") !== flow.state ||
            !(
              (url.searchParams.getAll("code").length === 1 &&
                Boolean(url.searchParams.get("code")) &&
                !url.searchParams.has("error")) ||
              (url.searchParams.getAll("error").length === 1 &&
                Boolean(url.searchParams.get("error")) &&
                !url.searchParams.has("code"))
            ) ||
            flow.exchanging
          )
            throw new Error("Invalid OAuth callback");
          const issuer = url.searchParams.getAll("iss");
          if (
            issuer.length > 1 ||
            (issuer.length === 1 &&
              issuer[0] !==
                (authorization.info.authorizationServerMetadata?.issuer ??
                  authorization.info.authorizationServerUrl))
          )
            throw new Error("Invalid OAuth issuer");
          return { code: url.searchParams.get("code"), error: url.searchParams.get("error") };
        },
        catch: (cause) =>
          new McpOAuthClientError({
            id: input.id,
            operation: "complete",
            reason: "invalid-callback",
            cause,
          }),
      });
      if (response.error !== null) {
        yield* cancel({ id: input.id, flowId: flow.id });
        return yield* new McpOAuthClientError({
          id: input.id,
          operation: "complete",
          reason: "oauth",
        });
      }
      flow.exchanging = true;
      let committed = false;
      yield* Effect.gen(function* () {
        const tokens = yield* Effect.tryPromise({
          try: (signal) =>
            exchangeAuthorization(authorization.info.authorizationServerUrl, {
              ...(authorization.info.authorizationServerMetadata
                ? { metadata: authorization.info.authorizationServerMetadata }
                : {}),
              clientInformation: authorization.client,
              authorizationCode: response.code!,
              codeVerifier: authorization.verifier,
              redirectUri: authorization.redirectUrl,
              ...(authorization.resource ? { resource: authorization.resource } : {}),
              fetchFn: fetchFor(signal, flow.controller),
            }),
          catch: (cause) =>
            new McpOAuthClientError({
              id: input.id,
              operation: "complete",
              reason: "oauth",
              cause,
            }),
        }).pipe(Effect.flatMap((value) => parseTokens(input.id, "complete", value)));
        const receivedAt = yield* Clock.currentTimeMillis;
        yield* record.writes.withPermit(
          Effect.gen(function* () {
            yield* requireGeneration(input.id, "complete", record.generation, flow.generation);
            if (record.flow !== flow || receivedAt >= flow.expiresAt)
              return yield* new McpOAuthClientError({
                id: input.id,
                operation: "complete",
                reason: "expired-flow",
              });
            yield* writeGrant(input.id, "complete", {
              url: authorization.url,
              issuer: authorization.info.authorizationServerUrl,
              ...(authorization.info.authorizationServerMetadata
                ? { metadata: authorization.info.authorizationServerMetadata }
                : {}),
              client: authorization.client,
              resource: authorization.resource?.toString() ?? null,
              tokens,
              expiresAt: expiryFor(tokens, receivedAt),
            });
            // A refresh already in flight belongs to the previous grant.
            record.generation += 1;
            record.grantGeneration += 1;
            if (record.flow === flow) record.flow = undefined;
            flow.controller.abort();
            yield* notify(input.id);
            committed = true;
          }).pipe(Effect.uninterruptible),
        );
      }).pipe(
        Effect.ensuring(
          Effect.sync(() => {
            if (record.flow === flow) record.flow = undefined;
            flow.controller.abort();
          }).pipe(
            Effect.andThen(flow.expiry ? Fiber.interrupt(flow.expiry) : Effect.void),
            Effect.andThen(Effect.suspend(() => (committed ? Effect.void : notify(input.id)))),
            Effect.asVoid,
          ),
        ),
      );
    },
  );

  const completeRedirect: McpOAuthClient["Service"]["completeRedirect"] = Effect.fn(
    "McpOAuthClient.completeRedirect",
  )(function* (input) {
    const flow = recordFor(input.id).flow;
    if (!flow || flow.state !== input.state || !flow.authorization)
      return yield* new McpOAuthClientError({
        id: input.id,
        operation: "complete",
        reason: "expired-flow",
      });
    const callback = new URL(flow.authorization.redirectUrl);
    callback.searchParams.set("state", input.state);
    if (input.code !== undefined) callback.searchParams.set("code", input.code);
    if (input.error !== undefined) callback.searchParams.set("error", input.error);
    if (input.iss !== undefined) callback.searchParams.set("iss", input.iss);
    yield* complete({ id: input.id, callbackUrl: callback.toString() });
  });

  const cancel: McpOAuthClient["Service"]["cancel"] = Effect.fn("McpOAuthClient.cancel")(
    function* (input) {
      const record = recordFor(input.id);
      const flow = yield* record.writes.withPermit(
        Effect.gen(function* () {
          const active = record.flow;
          if (!active || active.id !== input.flowId)
            return yield* new McpOAuthClientError({
              id: input.id,
              operation: "cancel",
              reason: "expired-flow",
            });
          record.generation += 1;
          record.flow = undefined;
          active.controller.abort();
          return active;
        }),
      );
      if (flow.expiry) yield* Fiber.interrupt(flow.expiry);
      yield* notify(input.id);
    },
  );

  const status: McpOAuthClient["Service"]["status"] = Effect.fn("McpOAuthClient.status")(
    function* (input) {
      const record = recordFor(input.id);
      const now = yield* Clock.currentTimeMillis;
      if (record.flow && record.flow.expiresAt > now)
        return { phase: "authorizing", expiresAt: record.flow.expiresAt, flowId: record.flow.id };
      const grant = yield* readGrant(input.id, "status");
      if (!grant || grant.url !== input.url) return { phase: "signed-out", expiresAt: null };
      if (!grant.tokens) return { phase: "sign-in-required", expiresAt: null };
      const tokens = yield* parseTokens(input.id, "status", grant.tokens);
      return {
        phase:
          grant.expiresAt !== null && grant.expiresAt <= now && !tokens.refresh_token
            ? "sign-in-required"
            : "connected",
        expiresAt: grant.expiresAt,
      };
    },
  );

  const accessToken: McpOAuthClient["Service"]["accessToken"] = Effect.fn(
    "McpOAuthClient.accessToken",
  )(function* (input, rejectedToken) {
    const record = recordFor(input.id);
    // Token rotation belongs to the environment. A disconnected HTTP caller only stops awaiting it.
    const refresh = yield* record.refresh
      .withPermit(
        Effect.gen(function* () {
          const generation = record.grantGeneration;
          const grant = yield* readGrant(input.id, "token");
          yield* requireGeneration(input.id, "token", record.grantGeneration, generation);
          if (!grant || grant.url !== input.url || !grant.tokens)
            return yield* new McpOAuthClientError({
              id: input.id,
              operation: "token",
              reason: "not-authorized",
            });
          const tokens = yield* parseTokens(input.id, "token", grant.tokens);
          const now = yield* Clock.currentTimeMillis;
          const refreshMargin = tokens.refresh_token
            ? Math.min(TOKEN_REFRESH_MARGIN_MS, (tokens.expires_in ?? 300) * 100)
            : 0;
          if (
            (rejectedToken === undefined || tokens.access_token !== rejectedToken) &&
            (grant.expiresAt === null || grant.expiresAt > now + refreshMargin)
          )
            return tokens.access_token;
          if (!tokens.refresh_token)
            return yield* record.writes.withPermit(
              Effect.gen(function* () {
                yield* requireGeneration(input.id, "token", record.grantGeneration, generation);
                yield* writeGrant(input.id, "token", { ...grant, tokens: null, expiresAt: null });
                yield* notify(input.id);
                return yield* new McpOAuthClientError({
                  id: input.id,
                  operation: "token",
                  reason: "not-authorized",
                });
              }),
            );
          const client = yield* Effect.try({
            try: () => OAuthClientInformationSchema.parse(grant.client),
            catch: (cause) =>
              new McpOAuthClientError({
                id: input.id,
                operation: "token",
                reason: "storage",
                cause,
              }),
          });
          const metadata = yield* Effect.try({
            try: () => (grant.metadata ? OAuthMetadataSchema.parse(grant.metadata) : undefined),
            catch: (cause) =>
              new McpOAuthClientError({
                id: input.id,
                operation: "token",
                reason: "storage",
                cause,
              }),
          });
          const controller = new AbortController();
          record.refreshController = controller;
          const refreshed = yield* Effect.tryPromise({
            try: (signal) =>
              refreshAuthorization(grant.issuer, {
                ...(metadata ? { metadata } : {}),
                clientInformation: client,
                refreshToken: tokens.refresh_token!,
                ...(grant.resource ? { resource: new URL(grant.resource) } : {}),
                fetchFn: fetchFor(signal, controller),
              }),
            catch: (cause) =>
              new McpOAuthClientError({ id: input.id, operation: "token", reason: "oauth", cause }),
          }).pipe(
            Effect.timeoutOrElse({
              duration: "30 seconds",
              orElse: () =>
                Effect.fail(
                  new McpOAuthClientError({
                    id: input.id,
                    operation: "token",
                    reason: "oauth",
                  }),
                ),
            }),
            Effect.flatMap((value) => parseTokens(input.id, "token", value)),
            Effect.catchTags({
              McpOAuthClientError: (error) => {
                if (
                  !(
                    error.cause instanceof InvalidGrantError ||
                    error.cause instanceof InvalidClientError ||
                    error.cause instanceof UnauthorizedClientError
                  )
                )
                  return Effect.fail(error);
                return record.writes.withPermit(
                  Effect.gen(function* () {
                    yield* requireGeneration(input.id, "token", record.grantGeneration, generation);
                    yield* writeGrant(input.id, "token", {
                      ...grant,
                      tokens: null,
                      expiresAt: null,
                    });
                    yield* notify(input.id);
                    return yield* new McpOAuthClientError({
                      id: input.id,
                      operation: "token",
                      reason: "not-authorized",
                    });
                  }),
                );
              },
            }),
            Effect.ensuring(
              Effect.sync(() => {
                if (record.refreshController === controller) record.refreshController = undefined;
                controller.abort();
              }),
            ),
          );
          const receivedAt = yield* Clock.currentTimeMillis;
          yield* record.writes.withPermit(
            Effect.gen(function* () {
              yield* requireGeneration(input.id, "token", record.grantGeneration, generation);
              yield* writeGrant(input.id, "token", {
                ...grant,
                tokens: refreshed,
                expiresAt: expiryFor(refreshed, receivedAt),
              });
            }),
          );
          yield* notify(input.id);
          return refreshed.access_token;
        }),
      )
      .pipe(Effect.forkIn(scope));
    return yield* Fiber.join(refresh);
  });

  const invalidate: McpOAuthClient["Service"]["invalidate"] = Effect.fn(
    "McpOAuthClient.invalidate",
  )(function* (id) {
    const record = recordFor(id);
    const flow = yield* record.writes.withPermit(
      Effect.gen(function* () {
        record.generation += 1;
        record.grantGeneration += 1;
        const active = record.flow;
        record.flow = undefined;
        active?.controller.abort();
        record.refreshController?.abort();
        yield* Effect.flatMap(nameFor(id), (name) => store.remove(name)).pipe(
          Effect.mapError(
            (cause) =>
              new McpOAuthClientError({ id, operation: "invalidate", reason: "storage", cause }),
          ),
        );
        return active;
      }),
    );
    if (flow?.expiry) yield* Fiber.interrupt(flow.expiry);
    yield* notify(id);
  });

  return McpOAuthClient.of({
    changes: Stream.fromPubSub(changes),
    begin,
    complete,
    completeRedirect,
    cancel,
    status,
    accessToken,
    invalidate,
  });
});

export const layer = Layer.effect(McpOAuthClient, make);
