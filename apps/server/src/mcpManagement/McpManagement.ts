import {
  ManagedMcpServer,
  ManagedMcpTransport,
  McpManagementError,
  type McpManagementSnapshot,
  type McpUpsertInput,
  type McpSecretValue,
  ProviderInstanceId,
  type ThreadId,
  type McpImportPreviewInput,
  type McpImportPreviewResult,
  type McpOAuthStartInput,
  type McpOAuthStartResult,
  type McpOAuthCompleteInput,
  type McpOAuthCancelInput,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as PubSub from "effect/PubSub";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";
import { HttpServerRequest, HttpServerResponse } from "effect/http";
import { parse as parseToml } from "smol-toml";
import { parse as parseJsonc, type ParseError } from "jsonc-parser";

import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import * as ServerSettings from "../serverSettings.ts";
import { deriveProviderInstanceConfigMap } from "../provider/ProviderInstanceRegistryHydration.ts";
import { mergeProviderInstanceEnvironment } from "../provider/ProviderInstanceEnvironment.ts";
import type { McpProviderSessionConfig } from "../mcp/McpProviderSession.ts";
import * as McpSessionRegistry from "../mcp/McpSessionRegistry.ts";
import * as McpOAuthClient from "./McpOAuthClient.ts";
import * as ManagedMcpHttp from "./ManagedMcpHttp.ts";
import type { ManagedMcpRuntimeConfig } from "./ManagedMcpRuntime.ts";

const Catalog = Schema.Struct({ revision: Schema.Number, servers: Schema.Array(ManagedMcpServer) });
const decodeCatalog = Schema.decodeUnknownEffect(Schema.fromJsonString(Catalog));
const encodeCatalog = Schema.encodeSync(Schema.fromJsonString(Catalog));
const decodeServer = Schema.decodeEffect(ManagedMcpServer);
const decodeImportedServer = Schema.decodeUnknownSync(ManagedMcpServer);
type Catalog = typeof Catalog.Type;
const CATALOG_SECRET = "managed-mcp-catalog";
const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();

interface Session {
  readonly threadId: ThreadId;
  readonly providerInstanceId: ProviderInstanceId;
  readonly revision: number;
  readonly servers: ReadonlyArray<ManagedMcpServer>;
  readonly httpHeaders: ReadonlyMap<string, Readonly<Record<string, string>>>;
  readonly issues: ReadonlyArray<{ readonly serverId: string; readonly message: string }>;
}

class MissingMcpEnvironmentVariable extends Error {
  readonly variableName: string;
  constructor(variableName: string) {
    super("Unset MCP environment variable.");
    this.variableName = variableName;
  }
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);
const isManagementError = Schema.is(McpManagementError);
const headerValues = (values: Readonly<Record<string, string>>) =>
  Object.fromEntries(new Headers(values));

export class McpManagement extends Context.Service<
  McpManagement,
  {
    readonly list: Effect.Effect<McpManagementSnapshot, McpManagementError>;
    readonly subscribe: Stream.Stream<McpManagementSnapshot, McpManagementError>;
    readonly upsert: (
      input: McpUpsertInput,
    ) => Effect.Effect<McpManagementSnapshot, McpManagementError>;
    readonly remove: (input: {
      readonly id: string;
      readonly expectedRevision: number;
    }) => Effect.Effect<McpManagementSnapshot, McpManagementError>;
    readonly setEnabled: (input: {
      readonly id: string;
      readonly providerInstanceId: ProviderInstanceId;
      readonly enabled: boolean;
    }) => Effect.Effect<McpManagementSnapshot, McpManagementError>;
    readonly copy: (input: {
      readonly source: ProviderInstanceId;
      readonly target: ProviderInstanceId;
    }) => Effect.Effect<McpManagementSnapshot, McpManagementError>;
    readonly importPreview: (
      input: McpImportPreviewInput,
    ) => Effect.Effect<McpImportPreviewResult, McpManagementError>;
    readonly startOAuth: (
      input: McpOAuthStartInput,
    ) => Effect.Effect<McpOAuthStartResult, McpManagementError>;
    readonly completeOAuth: (
      input: McpOAuthCompleteInput,
    ) => Effect.Effect<McpManagementSnapshot, McpManagementError>;
    readonly completeOAuthRedirect: (input: {
      readonly id: string;
      readonly state: string;
      readonly code?: string;
      readonly error?: string;
      readonly iss?: string;
    }) => Effect.Effect<McpManagementSnapshot, McpManagementError>;
    readonly cancelOAuth: (
      input: McpOAuthCancelInput,
    ) => Effect.Effect<McpManagementSnapshot, McpManagementError>;
    readonly logoutOAuth: (id: string) => Effect.Effect<McpManagementSnapshot, McpManagementError>;
    /** Snapshot once per new provider credential, before its adapter opens. */
    readonly resolveSession: (
      config: McpProviderSessionConfig,
    ) => Effect.Effect<ManagedMcpRuntimeConfig, McpManagementError>;
    readonly releaseSession: (threadId: ThreadId, credentialId?: string) => Effect.Effect<void>;
    readonly forward: (
      id: string,
      request: HttpServerRequest.HttpServerRequest,
    ) => Effect.Effect<
      HttpServerResponse.HttpServerResponse,
      ManagedMcpHttp.ManagedMcpHttpError | McpOAuthClient.McpOAuthClientError,
      Scope.Scope
    >;
  }
>()("t3/mcpManagement/McpManagement") {}

function redact(value: McpSecretValue): McpSecretValue {
  return value.sensitive
    ? { value: "", sensitive: true, ...(value.value.length > 0 ? { valueRedacted: true } : {}) }
    : { value: value.value, sensitive: false };
}

function mapValues(
  values: Readonly<Record<string, McpSecretValue>>,
  transform: (value: McpSecretValue, key: string) => McpSecretValue,
) {
  return Object.fromEntries(
    Object.entries(values).map(([key, value]) => [key, transform(value, key)]),
  );
}

function redactServer(server: ManagedMcpServer): ManagedMcpServer {
  const transport = server.transport;
  return {
    ...server,
    transport:
      transport.type === "stdio"
        ? { ...transport, env: mapValues(transport.env, redact) }
        : {
            ...transport,
            headers: mapValues(transport.headers, redact),
            oauth:
              transport.oauth === null
                ? null
                : {
                    ...transport.oauth,
                    ...(transport.oauth.clientSecret
                      ? {
                          clientSecret: redact({
                            ...transport.oauth.clientSecret,
                            sensitive: true,
                          }),
                        }
                      : {}),
                  },
          },
  };
}

function materializeServer(
  server: ManagedMcpServer,
  previous: ManagedMcpServer | undefined,
): ManagedMcpServer {
  const keep = (next: McpSecretValue, old: McpSecretValue | undefined): McpSecretValue => {
    if (next.valueRedacted) {
      if (!old || next.value !== "")
        throw new McpManagementError({ operation: "upsert", reason: "invalid-config" });
      return { value: old.value, sensitive: old.sensitive };
    }
    return { value: next.value, sensitive: next.sensitive };
  };
  const transport = server.transport;
  const old = previous?.transport;
  return {
    ...server,
    providerInstanceIds: [...new Set(server.providerInstanceIds)],
    transport:
      transport.type === "stdio"
        ? {
            ...transport,
            env: mapValues(transport.env, (value, key) =>
              keep(value, old?.type === "stdio" ? old.env[key] : undefined),
            ),
          }
        : {
            ...transport,
            headers: mapValues(transport.headers, (value, key) =>
              keep(value, old?.type === "http" ? old.headers[key] : undefined),
            ),
            oauth:
              transport.oauth === null
                ? null
                : {
                    ...transport.oauth,
                    ...(transport.oauth.clientSecret
                      ? {
                          clientSecret: {
                            ...keep(
                              transport.oauth.clientSecret,
                              old?.type === "http" ? old.oauth?.clientSecret : undefined,
                            ),
                            sensitive: true,
                          },
                        }
                      : {}),
                  },
          },
  };
}

const effectiveServers = (servers: ReadonlyArray<ManagedMcpServer>, provider: ProviderInstanceId) =>
  servers
    .filter((server) => server.providerInstanceIds.includes(provider))
    .map(({ providerInstanceIds: _omit, name: _name, ...server }) => server);
const authenticationIdentity = (server: ManagedMcpServer | undefined) => {
  if (server?.transport.type !== "http") return null;
  const { url, headers, oauth } = server.transport;
  return JSON.stringify({
    url,
    headers: Object.entries(headers)
      .map(([key, value]) => ({ name: key.toLowerCase(), value: value.value.trim() }))
      .sort((left, right) => left.name.localeCompare(right.name)),
    oauth:
      oauth === null
        ? null
        : {
            scope: oauth.scope ?? null,
            clientId: oauth.clientId ?? null,
            clientSecret: oauth.clientSecret?.value || null,
          },
  });
};

/** Imports definitions only. Native settings and native sign-in credentials remain independent. */
function parseImport(input: McpImportPreviewInput): McpImportPreviewResult {
  const errors: ParseError[] = [];
  const json: unknown = parseJsonc(input.configuration, errors, { allowTrailingComma: true });
  const parsed: unknown =
    errors.length === 0 && isRecord(json) ? json : parseToml(input.configuration);
  if (!isRecord(parsed))
    throw new McpManagementError({ operation: "import", reason: "invalid-config" });
  const mcp = isRecord(parsed.mcp) ? parsed.mcp : undefined;
  const raw = parsed.mcpServers ?? parsed.mcp_servers ?? mcp?.servers ?? mcp ?? parsed;
  if (!isRecord(raw))
    throw new McpManagementError({ operation: "import", reason: "invalid-config" });
  const servers: ManagedMcpServer[] = [];
  const warnings = [
    "Imported servers are T3-managed copies. Native configuration and sign-ins remain independent.",
  ];
  const secretValues = (record: unknown) => {
    if (record === undefined) return {};
    if (!isRecord(record))
      throw new McpManagementError({ operation: "import", reason: "invalid-config" });
    return Object.fromEntries(
      Object.entries(record).map(([key, value]) => {
        if (typeof value !== "string")
          throw new McpManagementError({ operation: "import", reason: "invalid-config" });
        return [key, { value, sensitive: true }];
      }),
    );
  };
  for (const [id, value] of Object.entries(raw)) {
    if (!isRecord(value)) {
      warnings.push(`${id}: invalid configuration was skipped.`);
      continue;
    }
    if (id === "t3-code" || id.startsWith("t3-code-")) {
      warnings.push("T3's orchestration server was skipped.");
      continue;
    }
    if (value.type === "sse" || value.type === "sdk") {
      warnings.push(`${id}: this transport cannot be imported.`);
      continue;
    }
    const known = new Set([
      "type",
      "command",
      "args",
      "env",
      "environment",
      "cwd",
      "url",
      "headers",
      "http_headers",
      "oauth",
      "enabled",
      "disabled",
      "bearer_token_env_var",
    ]);
    const unknown = Object.keys(value).filter((key) => !known.has(key));
    if (unknown.length > 0)
      warnings.push(`${id}: review provider-specific fields ${unknown.join(", ")} before saving.`);
    try {
      const headers = secretValues(value.headers ?? value.http_headers);
      if (typeof value.bearer_token_env_var === "string")
        headers.Authorization = {
          value: `Bearer \${${value.bearer_token_env_var}}`,
          sensitive: true,
        };
      let oauth: Extract<ManagedMcpTransport, { readonly type: "http" }>["oauth"] = null;
      if (isRecord(value.oauth)) {
        const rawSecret = value.oauth.clientSecret ?? value.oauth.client_secret;
        const rawClientId = value.oauth.clientId ?? value.oauth.client_id;
        oauth = {
          ...(typeof value.oauth.scope === "string" ? { scope: value.oauth.scope } : {}),
          ...(typeof rawClientId === "string" ? { clientId: rawClientId } : {}),
          ...(typeof rawSecret === "string"
            ? { clientSecret: { value: rawSecret, sensitive: true } }
            : {}),
        };
      }
      const command = value.command;
      const server = decodeImportedServer({
        id,
        name: id,
        providerInstanceIds:
          value.enabled === false || value.disabled === true ? [] : [input.providerInstanceId],
        transport:
          value.url !== undefined
            ? { type: "http", url: value.url, headers, oauth }
            : {
                type: "stdio",
                command: Array.isArray(command) ? command[0] : command,
                args: Array.isArray(command) ? command.slice(1) : (value.args ?? []),
                env: secretValues(value.env ?? value.environment),
                ...(value.cwd ? { cwd: value.cwd } : {}),
              },
      });
      servers.push(server);
    } catch {
      warnings.push(`${id}: invalid configuration was skipped.`);
    }
  }
  if (servers.length === 0)
    throw new McpManagementError({ operation: "import", reason: "invalid-config" });
  return { servers, warnings };
}

const make = Effect.gen(function* () {
  const secrets = yield* ServerSecretStore.ServerSecretStore;
  const settings = yield* ServerSettings.ServerSettingsService;
  const oauth = yield* McpOAuthClient.McpOAuthClient;
  const http = yield* ManagedMcpHttp.ManagedMcpHttp;
  const registry = yield* McpSessionRegistry.McpSessionRegistry;
  const mutex = yield* Semaphore.make(1);
  const changes = yield* PubSub.sliding<void>(1);
  const loaded = yield* secrets.get(CATALOG_SECRET).pipe(
    Effect.flatMap((bytes) =>
      Option.isSome(bytes)
        ? decodeCatalog(textDecoder.decode(bytes.value))
        : Effect.succeed({ revision: 0, servers: [] } satisfies Catalog),
    ),
    Effect.mapError(() => new McpManagementError({ operation: "load", reason: "storage" })),
    Effect.result,
  );
  const catalogError = loaded._tag === "Failure" ? loaded.failure : undefined;
  let catalog: Catalog = loaded._tag === "Success" ? loaded.success : { revision: 0, servers: [] };
  const requireCatalog = Effect.suspend(() =>
    catalogError ? Effect.fail(catalogError) : Effect.void,
  );
  const sessions = new Map<string, Session>();
  // Catalog edits fence OAuth starts before invalidating credentials or awaiting durable writes.
  const invalidating = new Set<string>();
  const notify = PubSub.publish(changes, undefined).pipe(Effect.asVoid);
  const authError = (cause: McpOAuthClient.McpOAuthClientError) =>
    new McpManagementError({ operation: cause.operation, reason: "authentication" });
  const providers = Effect.gen(function* () {
    const current = yield* settings.getSettings.pipe(
      Effect.mapError(() => new McpManagementError({ operation: "providers", reason: "storage" })),
    );
    const instances = deriveProviderInstanceConfigMap(current);
    return Object.entries(instances).map(([id, instance]) => {
      const external =
        instance.driver === "opencode" &&
        isRecord(instance.config) &&
        typeof instance.config.serverUrl === "string" &&
        instance.config.serverUrl.trim().length > 0;
      const supported =
        !external &&
        [
          "codex",
          "claudeAgent",
          "cursor",
          "grok",
          "opencode",
          "antigravity",
          "pi",
          "acpRegistry",
        ].includes(instance.driver);
      return {
        instanceId: ProviderInstanceId.make(id),
        driver: instance.driver,
        name: instance.displayName ?? id,
        supported,
        ...(!supported
          ? {
              reason: external
                ? "Managed MCPs require a T3-owned OpenCode server."
                : "This driver has no managed MCP integration.",
            }
          : {}),
      };
    });
  });
  const validateProvider = Effect.fnUntraced(function* (id: ProviderInstanceId) {
    const provider = (yield* providers).find((entry) => entry.instanceId === id);
    if (!provider)
      return yield* new McpManagementError({ operation: "assign", reason: "not-found" });
    if (!provider.supported)
      return yield* new McpManagementError({ operation: "assign", reason: "unsupported" });
  });
  const find = (id: string) => {
    const server = catalog.servers.find((entry) => entry.id === id);
    return requireCatalog.pipe(
      Effect.andThen(
        server
          ? Effect.succeed(server)
          : Effect.fail(new McpManagementError({ operation: "read", reason: "not-found" })),
      ),
    );
  };
  const list = Effect.gen(function* () {
    yield* requireCatalog;
    const current = catalog;
    const servers = yield* Effect.forEach(current.servers, (server) =>
      Effect.gen(function* () {
        const auth =
          server.transport.type === "http" && server.transport.oauth !== null
            ? yield* oauth.status({ id: server.id, url: server.transport.url }).pipe(
                Effect.catch(() =>
                  Effect.succeed({
                    phase: "sign-in-required" as const,
                    expiresAt: null,
                    flowId: undefined,
                  }),
                ),
              )
            : undefined;
        return {
          ...redactServer(server),
          authStatus: auth?.phase ?? ("not-required" as const),
          ...(auth?.flowId ? { authFlowId: auth.flowId } : {}),
          ...(auth?.expiresAt != null ? { authExpiresAt: auth.expiresAt } : {}),
        };
      }),
    );
    return {
      revision: current.revision,
      servers,
      providers: yield* providers,
      sessions: [...sessions.values()].map((session) => ({
        threadId: session.threadId,
        providerInstanceId: session.providerInstanceId,
        revision:
          JSON.stringify(effectiveServers(session.servers, session.providerInstanceId)) ===
          JSON.stringify(effectiveServers(current.servers, session.providerInstanceId))
            ? current.revision
            : session.revision,
        ...(session.issues.length > 0 ? { issues: session.issues } : {}),
      })),
    } satisfies McpManagementSnapshot;
  });
  const persist = Effect.fnUntraced(function* (servers: ReadonlyArray<ManagedMcpServer>) {
    const next = { revision: catalog.revision + 1, servers };
    // One secured atomic write commits the catalog and its credentials together.
    yield* secrets
      .set(CATALOG_SECRET, textEncoder.encode(encodeCatalog(next)))
      .pipe(
        Effect.mapError(() => new McpManagementError({ operation: "save", reason: "storage" })),
      );
    catalog = next;
    yield* notify;
  }, Effect.uninterruptible);
  const checkRevision = (revision: number) =>
    catalog.revision === revision
      ? Effect.void
      : Effect.fail(new McpManagementError({ operation: "save", reason: "conflict" }));
  const mutate = <A>(effect: Effect.Effect<A, McpManagementError>) =>
    mutex.withPermit(requireCatalog.pipe(Effect.andThen(effect))).pipe(Effect.andThen(list));
  const withInvalidation = <A>(id: string, effect: Effect.Effect<A, McpManagementError>) =>
    Effect.acquireUseRelease(
      Effect.sync(() => {
        invalidating.add(id);
      }),
      () => effect,
      () =>
        Effect.sync(() => {
          invalidating.delete(id);
        }),
    );
  const validateServer = (server: ManagedMcpServer) =>
    Effect.gen(function* () {
      const transport = server.transport;
      if (transport.type === "http") {
        yield* Effect.try({
          try: () => {
            const url = new URL(transport.url);
            if (
              !["http:", "https:"].includes(url.protocol) ||
              url.username ||
              url.password ||
              url.hash
            )
              throw new Error("transport");
            headerValues(
              Object.fromEntries(
                Object.entries(transport.headers).map(([key, value]) => [key, value.value]),
              ),
            );
          },
          catch: () => new McpManagementError({ operation: "validate", reason: "invalid-config" }),
        });
      } else if (Object.keys(transport.env).some((key) => !/^[A-Za-z_][A-Za-z0-9_]*$/.test(key))) {
        return yield* new McpManagementError({ operation: "validate", reason: "invalid-config" });
      }
    });
  const upsert: McpManagement["Service"]["upsert"] = (input) =>
    mutate(
      Effect.gen(function* () {
        yield* checkRevision(input.expectedRevision);
        const previous = catalog.servers.find((server) => server.id === input.server.id);
        let server = yield* Effect.try({
          try: () => materializeServer(input.server, previous),
          catch: (cause) =>
            isManagementError(cause)
              ? cause
              : new McpManagementError({ operation: "upsert", reason: "invalid-config" }),
        }).pipe(
          Effect.flatMap(decodeServer),
          Effect.mapError((cause) =>
            isManagementError(cause)
              ? cause
              : new McpManagementError({ operation: "upsert", reason: "invalid-config" }),
          ),
        );
        const available = yield* providers;
        server = {
          ...server,
          providerInstanceIds: server.providerInstanceIds.filter((id) =>
            available.some((provider) => provider.instanceId === id),
          ),
        };
        yield* Effect.forEach(
          server.providerInstanceIds.filter((id) => !previous?.providerInstanceIds.includes(id)),
          validateProvider,
        );
        yield* validateServer(server);
        const save = persist(
          previous
            ? catalog.servers.map((entry) => (entry.id === server.id ? server : entry))
            : [...catalog.servers, server],
        );
        if (authenticationIdentity(previous) !== authenticationIdentity(server)) {
          yield* withInvalidation(
            server.id,
            oauth.invalidate(server.id).pipe(Effect.mapError(authError), Effect.andThen(save)),
          );
        } else yield* save;
      }),
    );
  const remove: McpManagement["Service"]["remove"] = (input) =>
    mutate(
      Effect.gen(function* () {
        yield* checkRevision(input.expectedRevision);
        yield* find(input.id);
        yield* withInvalidation(
          input.id,
          oauth
            .invalidate(input.id)
            .pipe(
              Effect.mapError(authError),
              Effect.andThen(persist(catalog.servers.filter((server) => server.id !== input.id))),
            ),
        );
      }),
    );
  const setEnabled: McpManagement["Service"]["setEnabled"] = (input) =>
    mutate(
      Effect.gen(function* () {
        const server = yield* find(input.id);
        const ids = new Set(server.providerInstanceIds);
        if (input.enabled === ids.has(input.providerInstanceId)) return;
        if (input.enabled) yield* validateProvider(input.providerInstanceId);
        if (input.enabled) ids.add(input.providerInstanceId);
        else ids.delete(input.providerInstanceId);
        yield* persist(
          catalog.servers.map((entry) =>
            entry.id === server.id ? { ...entry, providerInstanceIds: [...ids] } : entry,
          ),
        );
      }),
    );
  const copy: McpManagement["Service"]["copy"] = (input) =>
    mutate(
      Effect.gen(function* () {
        yield* validateProvider(input.source);
        yield* validateProvider(input.target);
        const servers = catalog.servers.map((server) =>
          server.providerInstanceIds.includes(input.source) &&
          !server.providerInstanceIds.includes(input.target)
            ? { ...server, providerInstanceIds: [...server.providerInstanceIds, input.target] }
            : server,
        );
        if (servers.some((server, index) => server !== catalog.servers[index]))
          yield* persist(servers);
      }),
    );
  const importPreview: McpManagement["Service"]["importPreview"] = (input) =>
    Effect.gen(function* () {
      yield* validateProvider(input.providerInstanceId);
      return yield* Effect.try({
        try: () => parseImport(input),
        catch: (cause) =>
          isManagementError(cause)
            ? cause
            : new McpManagementError({ operation: "import", reason: "invalid-config" }),
      });
    });
  const oauthServer = Effect.fnUntraced(function* (id: string) {
    const server = yield* find(id);
    if (invalidating.has(id))
      return yield* new McpManagementError({ operation: "oauth", reason: "conflict" });
    if (server.transport.type !== "http" || server.transport.oauth === null)
      return yield* new McpManagementError({ operation: "oauth", reason: "invalid-config" });
    return {
      id: server.id,
      url: server.transport.url,
      identity: authenticationIdentity(server),
      headers: server.transport.headers,
      ...(server.transport.oauth.scope ? { scope: server.transport.oauth.scope } : {}),
      ...(server.transport.oauth.clientId ? { clientId: server.transport.oauth.clientId } : {}),
      ...(server.transport.oauth.clientSecret
        ? { clientSecret: server.transport.oauth.clientSecret.value }
        : {}),
    };
  });
  const startOAuth: McpManagement["Service"]["startOAuth"] = (input) =>
    Effect.gen(function* () {
      const { identity, headers: configuredHeaders, ...server } = yield* oauthServer(input.id);
      // The catalog spans provider accounts. Missing account-only values omit this optional probe header.
      const headers = Object.fromEntries(
        Object.entries(configuredHeaders).flatMap(([key, value]) => {
          let missing = false;
          const expanded = value.value.replace(
            /\$\{([A-Za-z_][A-Za-z0-9_]*)\}|\{env:([A-Za-z_][A-Za-z0-9_]*)\}/g,
            (_match, dollar: string | undefined, opencode: string | undefined) => {
              const value = process.env[dollar ?? opencode ?? ""];
              if (value === undefined) missing = true;
              return value ?? "";
            },
          );
          return missing ? [] : [[key, expanded]];
        }),
      );
      const validate = Effect.suspend(() =>
        !invalidating.has(input.id) &&
        authenticationIdentity(catalog.servers.find((entry) => entry.id === input.id)) === identity
          ? Effect.void
          : Effect.fail(
              new McpOAuthClient.McpOAuthClientError({
                id: input.id,
                operation: "begin",
                reason: "superseded",
              }),
            ),
      );
      const result = yield* oauth
        .begin({ ...server, headers, redirectUrl: input.redirectUrl, validate })
        .pipe(Effect.mapError(authError));
      yield* notify;
      return result;
    });
  const completeOAuth: McpManagement["Service"]["completeOAuth"] = (input) =>
    Effect.gen(function* () {
      yield* oauthServer(input.id);
      yield* oauth.complete(input).pipe(Effect.mapError(authError));
      yield* notify;
      return yield* list;
    });
  const completeOAuthRedirect: McpManagement["Service"]["completeOAuthRedirect"] = (input) =>
    Effect.gen(function* () {
      yield* oauthServer(input.id);
      yield* oauth.completeRedirect(input).pipe(Effect.mapError(authError));
      yield* notify;
      return yield* list;
    });
  const cancelOAuth: McpManagement["Service"]["cancelOAuth"] = (input) =>
    Effect.gen(function* () {
      yield* oauth.cancel(input).pipe(Effect.mapError(authError));
      yield* notify;
      return yield* list;
    });
  const logoutOAuth: McpManagement["Service"]["logoutOAuth"] = (id) =>
    Effect.gen(function* () {
      yield* mutex.withPermit(
        Effect.gen(function* () {
          yield* find(id);
          yield* withInvalidation(id, oauth.invalidate(id).pipe(Effect.mapError(authError)));
        }),
      );
      yield* notify;
      return yield* list;
    });
  const resolveSession: McpManagement["Service"]["resolveSession"] = (config) =>
    Effect.gen(function* () {
      const providerSettings = yield* settings.getSettings.pipe(
        Effect.mapError(() => new McpManagementError({ operation: "resolve", reason: "storage" })),
      );
      const current = catalog;
      const instance = deriveProviderInstanceConfigMap(providerSettings)[config.providerInstanceId];
      const provider = (yield* providers).find(
        (entry) => entry.instanceId === config.providerInstanceId,
      );
      const env = mergeProviderInstanceEnvironment(instance?.environment);
      const expand = (value: string) =>
        value.replace(
          /\$\{([A-Za-z_][A-Za-z0-9_]*)\}|\{env:([A-Za-z_][A-Za-z0-9_]*)\}/g,
          (_match, dollar: string | undefined, opencode: string | undefined) => {
            const variableName = dollar ?? opencode ?? "";
            const value = env[variableName];
            if (value === undefined) throw new MissingMcpEnvironmentVariable(variableName);
            return value;
          },
        );
      const valueRecord = (values: Readonly<Record<string, McpSecretValue>>) =>
        Object.fromEntries(
          Object.entries(values).map(([key, value]) => [key, expand(value.value)]),
        );
      const httpHeaders = new Map<string, Readonly<Record<string, string>>>();
      const issues: Array<{ serverId: string; message: string }> = catalogError
        ? [{ serverId: "catalog", message: "Stored MCP configuration could not be read." }]
        : [];
      const resolved: ManagedMcpRuntimeConfig = {
        revision: current.revision,
        servers: current.servers.map((server) => {
          const assigned = server.providerInstanceIds.includes(config.providerInstanceId);
          const resolve = (enabled: boolean) => {
            const transport = server.transport;
            if (enabled && transport.type === "http") {
              const expanded = headerValues(valueRecord(transport.headers));
              httpHeaders.set(server.id, expanded);
            }
            return {
              id: server.id,
              enabled,
              transport:
                transport.type === "stdio"
                  ? {
                      type: "stdio",
                      command: transport.command,
                      args: transport.args,
                      env: enabled ? valueRecord(transport.env) : {},
                      ...(transport.cwd ? { cwd: transport.cwd } : {}),
                    }
                  : transport.oauth === null || !enabled
                    ? {
                        type: "http",
                        url: transport.url,
                        headers: enabled ? valueRecord(transport.headers) : {},
                      }
                    : {
                        type: "http",
                        url: new URL(
                          `/mcp/managed/${encodeURIComponent(server.id)}`,
                          config.endpoint,
                        ).href,
                        headers: { Authorization: config.authorizationHeader },
                      },
            } satisfies ManagedMcpRuntimeConfig["servers"][number];
          };
          if (!assigned) return resolve(false);
          if (!provider?.supported) {
            issues.push({
              serverId: server.id,
              message: provider?.reason ?? "This provider has no managed MCP integration.",
            });
            return resolve(false);
          }
          try {
            return resolve(true);
          } catch (cause) {
            httpHeaders.delete(server.id);
            issues.push({
              serverId: server.id,
              message:
                cause instanceof MissingMcpEnvironmentVariable
                  ? `Set the ${cause.variableName} environment variable for this provider.`
                  : "This MCP has an invalid header.",
            });
            return resolve(false);
          }
        }),
      };
      sessions.set(config.providerSessionId, {
        threadId: config.threadId,
        providerInstanceId: config.providerInstanceId,
        revision: current.revision,
        servers: current.servers,
        httpHeaders,
        issues,
      });
      yield* notify;
      return resolved;
    });
  const releaseSession: McpManagement["Service"]["releaseSession"] = (threadId, credentialId) =>
    Effect.gen(function* () {
      for (const [id, session] of sessions)
        if (session.threadId === threadId && (credentialId === undefined || credentialId === id))
          sessions.delete(id);
      yield* notify;
    });
  const forward: McpManagement["Service"]["forward"] = (id, request) =>
    Effect.gen(function* () {
      const token = request.headers.authorization?.replace(/^Bearer\s+/, "") ?? "";
      const invocation = yield* registry.resolve(token);
      const caller = invocation?.thread;
      const session = caller ? sessions.get(caller.providerSessionId) : undefined;
      const server = session?.servers.find(
        (entry) =>
          entry.id === id && entry.providerInstanceIds.includes(session.providerInstanceId),
      );
      if (
        !caller ||
        !session ||
        !session.httpHeaders.has(id) ||
        !server ||
        server.transport.type !== "http" ||
        server.transport.oauth === null
      )
        return yield* new ManagedMcpHttp.ManagedMcpHttpError({ reason: "not-allowed" });
      const transport = server.transport;
      const validate = Effect.gen(function* () {
        const current = yield* registry.resolve(token);
        if (
          current?.thread?.providerSessionId !== caller.providerSessionId ||
          !sessions.has(caller.providerSessionId) ||
          invalidating.has(id) ||
          authenticationIdentity(catalog.servers.find((entry) => entry.id === id)) !==
            authenticationIdentity(server)
        )
          return yield* new ManagedMcpHttp.ManagedMcpHttpError({ reason: "not-allowed" });
      });
      return yield* http.forward({
        url: transport.url,
        headers: session.httpHeaders.get(id) ?? {},
        request,
        validate,
        accessToken: oauth.accessToken({ id, url: transport.url }),
        refreshToken: (rejectedToken) =>
          oauth.accessToken({ id, url: transport.url }, rejectedToken),
      });
    });
  const subscribe = Stream.unwrap(
    Effect.gen(function* () {
      const subscription = yield* PubSub.subscribe(changes);
      return Stream.concat(
        Stream.fromEffect(list),
        Stream.fromSubscription(subscription).pipe(Stream.mapEffect(() => list)),
      );
    }),
  );
  // Provider account changes also refresh columns without mutating MCP assignments.
  yield* settings.streamChanges.pipe(
    Stream.runForEach(() => notify),
    Effect.forkScoped,
  );
  yield* oauth.changes.pipe(
    Stream.runForEach(() => notify),
    Effect.forkScoped,
  );
  return McpManagement.of({
    list,
    subscribe,
    upsert,
    remove,
    setEnabled,
    copy,
    importPreview,
    startOAuth,
    completeOAuth,
    completeOAuthRedirect,
    cancelOAuth,
    logoutOAuth,
    resolveSession,
    releaseSession,
    forward,
  });
});

export const layer = Layer.effect(McpManagement, make);
