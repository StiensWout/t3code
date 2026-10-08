import * as Schema from "effect/Schema";

import { NonNegativeInt, ThreadId, TrimmedNonEmptyString } from "./baseSchemas.ts";
import { ProviderDriverKind, ProviderInstanceId } from "./providerInstance.ts";

/** Stable catalog identity. Adapters use their own namespace; T3's names are reserved. */
export const ManagedMcpServerId = TrimmedNonEmptyString.check(
  Schema.isMaxLength(64),
  Schema.isPattern(/^(?!t3-code(?:-|$))[a-zA-Z0-9][a-zA-Z0-9_-]*$/),
);
export type ManagedMcpServerId = typeof ManagedMcpServerId.Type;

export const McpSecretValue = Schema.Struct({
  value: Schema.String,
  sensitive: Schema.Boolean,
  valueRedacted: Schema.optionalKey(Schema.Boolean),
});
export type McpSecretValue = typeof McpSecretValue.Type;

const HttpUrl = TrimmedNonEmptyString.check(Schema.isPattern(/^https?:\/\/[^\s]+$/));
const NamedValues = Schema.Record(TrimmedNonEmptyString, McpSecretValue);

export const ManagedMcpTransport = Schema.Union([
  Schema.Struct({
    type: Schema.Literal("stdio"),
    command: TrimmedNonEmptyString,
    args: Schema.Array(Schema.String),
    env: NamedValues,
    cwd: Schema.optionalKey(TrimmedNonEmptyString),
  }),
  Schema.Struct({
    type: Schema.Literal("http"),
    url: HttpUrl,
    headers: NamedValues,
    oauth: Schema.NullOr(
      Schema.Struct({
        scope: Schema.optionalKey(TrimmedNonEmptyString),
        clientId: Schema.optionalKey(TrimmedNonEmptyString),
        clientSecret: Schema.optionalKey(McpSecretValue),
      }),
    ),
  }),
]);
export type ManagedMcpTransport = typeof ManagedMcpTransport.Type;

export const ManagedMcpServer = Schema.Struct({
  id: ManagedMcpServerId,
  name: TrimmedNonEmptyString.check(Schema.isMaxLength(100)),
  transport: ManagedMcpTransport,
  providerInstanceIds: Schema.Array(ProviderInstanceId),
});
export type ManagedMcpServer = typeof ManagedMcpServer.Type;

export class McpManagementError extends Schema.TaggedError<McpManagementError>()(
  "McpManagementError",
  {
    operation: Schema.String,
    reason: Schema.Literals([
      "not-found",
      "conflict",
      "invalid-config",
      "unsupported",
      "storage",
      "authentication",
      "not-allowed",
    ]),
  },
) {
  override get message(): string {
    switch (this.reason) {
      case "not-found":
        return "This MCP server no longer exists.";
      case "conflict":
        return "MCP settings changed elsewhere. Refresh and try again.";
      case "invalid-config":
        return "The MCP configuration is invalid.";
      case "unsupported":
        return "This provider does not support managed MCP servers.";
      case "storage":
        return "MCP settings could not be saved or read.";
      case "authentication":
        return "MCP authentication failed. Try signing in again.";
      case "not-allowed":
        return "This MCP operation is not allowed.";
    }
  }
}

export const ManagedMcpServerSnapshot = Schema.Struct({
  ...ManagedMcpServer.fields,
  authStatus: Schema.Literals([
    "not-required",
    "signed-out",
    "connected",
    "sign-in-required",
    "authorizing",
  ]),
  authFlowId: Schema.optionalKey(Schema.String),
  authExpiresAt: Schema.optionalKey(Schema.Number),
});

export const McpManagementSnapshot = Schema.Struct({
  revision: NonNegativeInt,
  servers: Schema.Array(ManagedMcpServerSnapshot),
  providers: Schema.Array(
    Schema.Struct({
      instanceId: ProviderInstanceId,
      driver: ProviderDriverKind,
      name: Schema.String,
      supported: Schema.Boolean,
      reason: Schema.optionalKey(Schema.String),
    }),
  ),
  sessions: Schema.Array(
    Schema.Struct({
      threadId: ThreadId,
      providerInstanceId: ProviderInstanceId,
      revision: NonNegativeInt,
      issues: Schema.optionalKey(
        Schema.Array(Schema.Struct({ serverId: ManagedMcpServerId, message: Schema.String })),
      ),
    }),
  ),
});
export type McpManagementSnapshot = typeof McpManagementSnapshot.Type;

export const McpUpsertInput = Schema.Struct({
  server: ManagedMcpServer,
  expectedRevision: NonNegativeInt,
});
export type McpUpsertInput = typeof McpUpsertInput.Type;
export const McpRemoveInput = Schema.Struct({
  id: ManagedMcpServerId,
  expectedRevision: NonNegativeInt,
});
export type McpRemoveInput = typeof McpRemoveInput.Type;
export const McpSetEnabledInput = Schema.Struct({
  id: ManagedMcpServerId,
  providerInstanceId: ProviderInstanceId,
  enabled: Schema.Boolean,
});
export type McpSetEnabledInput = typeof McpSetEnabledInput.Type;
export const McpCopyInput = Schema.Struct({
  source: ProviderInstanceId,
  target: ProviderInstanceId,
});
export type McpCopyInput = typeof McpCopyInput.Type;

/** Native configuration is imported as a preview, then saved through the normal upsert. */
export const McpImportPreviewInput = Schema.Struct({
  providerInstanceId: ProviderInstanceId,
  configuration: Schema.String.check(Schema.isMaxLength(256_000)),
});
export type McpImportPreviewInput = typeof McpImportPreviewInput.Type;
export const McpImportPreviewResult = Schema.Struct({
  servers: Schema.Array(ManagedMcpServer),
  warnings: Schema.Array(Schema.String),
});
export type McpImportPreviewResult = typeof McpImportPreviewResult.Type;

export const McpOAuthStartInput = Schema.Struct({ id: ManagedMcpServerId, redirectUrl: HttpUrl });
export type McpOAuthStartInput = typeof McpOAuthStartInput.Type;
export const McpOAuthStartResult = Schema.Struct({
  flowId: TrimmedNonEmptyString,
  authorizationUrl: HttpUrl,
  expiresAt: Schema.Number,
});
export type McpOAuthStartResult = typeof McpOAuthStartResult.Type;
export const McpOAuthCompleteInput = Schema.Struct({
  id: ManagedMcpServerId,
  flowId: Schema.optionalKey(TrimmedNonEmptyString),
  callbackUrl: HttpUrl,
});
export type McpOAuthCompleteInput = typeof McpOAuthCompleteInput.Type;
export const McpOAuthCancelInput = Schema.Struct({
  id: ManagedMcpServerId,
  flowId: TrimmedNonEmptyString,
});
export type McpOAuthCancelInput = typeof McpOAuthCancelInput.Type;
export const McpOAuthLogoutInput = Schema.Struct({ id: ManagedMcpServerId });
export type McpOAuthLogoutInput = typeof McpOAuthLogoutInput.Type;
