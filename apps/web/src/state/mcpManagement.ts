import { RegistryContext, useAtomValue } from "@effect/atom-react";
import { useContext, useEffect } from "react";
import { environmentCatalog } from "../connection/catalog";
import type { EnvironmentId } from "@t3tools/contracts";
import {
  createMcpManagementUiSessions,
  type McpManagementUiSession,
} from "@t3tools/client-runtime/state/mcpManagementUiSession";
import { createMcpManagementAtoms } from "@t3tools/client-runtime/state/mcp-management";
import { connectionAtomRuntime } from "../connection/runtime";

export const mcpManagement = createMcpManagementAtoms(connectionAtomRuntime);

export const mcpManagementUiSessions = createMcpManagementUiSessions();

export function useMcpManagementUiSession(environmentId: EnvironmentId) {
  const registry = useContext(RegistryContext);
  const session = useAtomValue(mcpManagementUiSessions.sessionAtom(environmentId));
  function field<K extends keyof McpManagementUiSession>(key: K) {
    return [
      session[key],
      (
        next:
          | McpManagementUiSession[K]
          | ((previous: McpManagementUiSession[K]) => McpManagementUiSession[K]),
      ) => mcpManagementUiSessions.setField(registry, environmentId, key, next),
    ] as const;
  }
  return { field, read: () => mcpManagementUiSessions.read(registry, environmentId) };
}

/** Drop drafts only when an environment leaves the catalog, never while reconnecting. */
export function useMcpManagementUiSessionsCleanup() {
  const registry = useContext(RegistryContext);
  const catalog = useAtomValue(environmentCatalog.catalogValueAtom);
  useEffect(() => {
    if (catalog.isReady)
      mcpManagementUiSessions.retainEnvironments(registry, new Set(catalog.entries.keys()));
  }, [catalog, registry]);
}
