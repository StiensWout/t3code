import { WS_METHODS } from "@t3tools/contracts";
import type { Atom } from "effect/reactivity";

import type { EnvironmentRegistry } from "../connection/registry.ts";
import {
  createEnvironmentRpcCommand,
  createEnvironmentRpcSubscriptionAtomFamily,
} from "./runtime.ts";

/** The same environment commands back web, desktop, and mobile MCP management. */
export function createMcpManagementAtoms<R, E>(
  runtime: Atom.AtomRuntime<EnvironmentRegistry | R, E>,
) {
  return {
    snapshot: createEnvironmentRpcSubscriptionAtomFamily(runtime, {
      label: "environment-data:mcp-management",
      tag: WS_METHODS.mcpManagementSubscribe,
      idleTtlMs: 0,
    }),
    upsert: createEnvironmentRpcCommand(runtime, {
      label: "environment-command:mcp-management:upsert",
      tag: WS_METHODS.mcpManagementUpsert,
    }),
    remove: createEnvironmentRpcCommand(runtime, {
      label: "environment-command:mcp-management:remove",
      tag: WS_METHODS.mcpManagementRemove,
    }),
    setEnabled: createEnvironmentRpcCommand(runtime, {
      label: "environment-command:mcp-management:set-enabled",
      tag: WS_METHODS.mcpManagementSetEnabled,
    }),
    copy: createEnvironmentRpcCommand(runtime, {
      label: "environment-command:mcp-management:copy",
      tag: WS_METHODS.mcpManagementCopy,
    }),
    importPreview: createEnvironmentRpcCommand(runtime, {
      label: "environment-command:mcp-management:import-preview",
      tag: WS_METHODS.mcpManagementImportPreview,
    }),
    startOAuth: createEnvironmentRpcCommand(runtime, {
      label: "environment-command:mcp-management:oauth-start",
      tag: WS_METHODS.mcpManagementOAuthStart,
      concurrency: {
        mode: "singleFlight",
        key: ({ environmentId, input }) => `${environmentId}:${input.id}`,
      },
    }),
    completeOAuth: createEnvironmentRpcCommand(runtime, {
      label: "environment-command:mcp-management:oauth-complete",
      tag: WS_METHODS.mcpManagementOAuthComplete,
    }),
    cancelOAuth: createEnvironmentRpcCommand(runtime, {
      label: "environment-command:mcp-management:oauth-cancel",
      tag: WS_METHODS.mcpManagementOAuthCancel,
    }),
    logoutOAuth: createEnvironmentRpcCommand(runtime, {
      label: "environment-command:mcp-management:oauth-logout",
      tag: WS_METHODS.mcpManagementOAuthLogout,
    }),
  };
}
