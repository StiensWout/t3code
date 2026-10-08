import {
  ManagedMcpServer,
  type EnvironmentId,
  type McpSecretValue,
  type ProviderInstanceId,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import { environmentEndpointUrl } from "../environment/endpoint.ts";

export interface McpNamedValueDraft {
  draftId: string;
  key: string;
  value: string;
  sensitive: boolean;
  valueRedacted?: boolean;
  storedKey?: string;
}

const decodeServer = Schema.decodeUnknownSync(ManagedMcpServer);
let nextValueId = 0;

export function createMcpNamedValueDraft(
  key = "",
  value: McpSecretValue = { value: "", sensitive: true },
): McpNamedValueDraft {
  return {
    draftId: `mcp-value-${nextValueId++}`,
    key,
    ...value,
    ...(value.valueRedacted ? { storedKey: key } : {}),
  };
}

/** A stored secret can only be retained under its original variable or header name. */
export function renameMcpNamedValueDraft(row: McpNamedValueDraft, key: string) {
  return {
    ...row,
    key,
    ...(row.valueRedacted && row.storedKey === undefined ? { storedKey: row.key.trim() } : {}),
  };
}

/** Clearing a replacement keeps the stored secret; removing the row deletes it. */
export function changeMcpNamedValueDraft(row: McpNamedValueDraft, value: string) {
  return { ...row, value, valueRedacted: value === "" && row.storedKey !== undefined };
}

export function mcpNamedValuePlaceholder(row: McpNamedValueDraft) {
  if (!row.valueRedacted) return "Value";
  return row.key.trim() === row.storedKey
    ? "Stored secret, leave to keep"
    : "Re-enter secret after renaming";
}

export function createMcpServerDraft(
  server?: ManagedMcpServer,
  knownProviderIds?: ReadonlyArray<ProviderInstanceId>,
) {
  const transport = server?.transport;
  return {
    id: server?.id ?? "",
    name: server?.name ?? "",
    type: transport?.type ?? "stdio",
    command: transport?.type === "stdio" ? transport.command : "",
    args: transport?.type === "stdio" ? transport.args.join("\n") : "",
    cwd: transport?.type === "stdio" ? (transport.cwd ?? "") : "",
    url: transport?.type === "http" ? transport.url : "",
    values: Object.entries(
      transport?.type === "stdio" ? transport.env : (transport?.headers ?? {}),
    ).map(([key, value]) => createMcpNamedValueDraft(key, value)),
    transportValues: { stdio: [] as McpNamedValueDraft[], http: [] as McpNamedValueDraft[] },
    oauth: transport?.type === "http" && transport.oauth !== null,
    scope: transport?.type === "http" ? (transport.oauth?.scope ?? "") : "",
    clientId: transport?.type === "http" ? (transport.oauth?.clientId ?? "") : "",
    clientSecret: transport?.type === "http" ? transport.oauth?.clientSecret : undefined,
    clientSecretStored:
      transport?.type === "http" && transport.oauth?.clientSecret?.valueRedacted === true,
    providerInstanceIds: (server?.providerInstanceIds ?? []).filter(
      (id) => knownProviderIds === undefined || knownProviderIds.includes(id),
    ),
  };
}
export type McpServerDraft = ReturnType<typeof createMcpServerDraft>;

/** Switching transport preserves each transport's unsaved variables or headers. */
export function changeMcpDraftTransport(draft: McpServerDraft, type: McpServerDraft["type"]) {
  if (draft.type === type) return draft;
  const transportValues = { ...draft.transportValues, [draft.type]: draft.values };
  return { ...draft, type, values: transportValues[type], transportValues };
}

export function changeMcpClientSecretDraft(draft: McpServerDraft, value: string) {
  return {
    ...draft,
    clientSecret:
      value === "" && !draft.clientSecretStored
        ? undefined
        : {
            value,
            sensitive: true,
            valueRedacted: value === "" && draft.clientSecretStored,
          },
  };
}

/** Draft validation errors contain a short instruction clients can display directly. */
export class McpDraftError extends Error {}

/** Empty redacted values retain the environment's stored secret during edits. */
export function mcpServerFromDraft(
  draft: McpServerDraft,
  knownProviderIds?: ReadonlyArray<ProviderInstanceId>,
) {
  const names = new Set<string>();
  const values = Object.fromEntries(
    draft.values.map((row) => {
      const key = row.key.trim();
      if (!key) throw new McpDraftError("Enter a name for every environment variable or header.");
      if (names.has(key)) throw new McpDraftError(`Duplicate name: ${key}`);
      names.add(key);
      if (row.valueRedacted && key !== row.storedKey)
        throw new McpDraftError(`Re-enter the stored secret for ${key} after renaming it.`);
      return [
        key,
        {
          value: row.value,
          sensitive: row.sensitive,
          ...(row.valueRedacted ? { valueRedacted: true } : {}),
        },
      ] as const;
    }),
  );
  const argsText = draft.args.replace(/(?:\r?\n)+$/, "");
  return decodeServer({
    id: draft.id.trim(),
    name: draft.name.trim(),
    providerInstanceIds: draft.providerInstanceIds.filter(
      (id) => knownProviderIds === undefined || knownProviderIds.includes(id),
    ),
    transport:
      draft.type === "stdio"
        ? {
            type: "stdio",
            command: draft.command.trim(),
            args: argsText === "" ? [] : argsText.split(/\r?\n/),
            env: values,
            ...(draft.cwd.trim() ? { cwd: draft.cwd.trim() } : {}),
          }
        : {
            type: "http",
            url: draft.url.trim(),
            headers: values,
            oauth: draft.oauth
              ? {
                  ...(draft.scope.trim() ? { scope: draft.scope.trim() } : {}),
                  ...(draft.clientId.trim() ? { clientId: draft.clientId.trim() } : {}),
                  ...(draft.clientSecret?.value || draft.clientSecret?.valueRedacted
                    ? { clientSecret: draft.clientSecret }
                    : {}),
                }
              : null,
          },
  });
}

export function toggleMcpDraftProvider(draft: McpServerDraft, instanceId: ProviderInstanceId) {
  return {
    ...draft,
    providerInstanceIds: draft.providerInstanceIds.includes(instanceId)
      ? draft.providerInstanceIds.filter((id) => id !== instanceId)
      : [...draft.providerInstanceIds, instanceId],
  };
}

/** The same address is used for sign-in and manual OAuth client registration. */
export function mcpOAuthRedirectUrl(
  baseUrl: string,
  serverId: string,
  clientEnvironmentId?: EnvironmentId,
) {
  const redirect = new URL(
    environmentEndpointUrl(
      baseUrl,
      clientEnvironmentId === undefined ? "/oauth/managed-mcp/callback" : "/auth/mcp-callback",
    ),
  );
  redirect.username = "";
  redirect.password = "";
  if (clientEnvironmentId !== undefined)
    redirect.searchParams.set("environmentId", clientEnvironmentId);
  redirect.searchParams.set("id", serverId.trim());
  return redirect.toString();
}
