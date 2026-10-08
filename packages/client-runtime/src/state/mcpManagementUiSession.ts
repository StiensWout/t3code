import type {
  EnvironmentId,
  ManagedMcpServer,
  McpOAuthStartResult,
  ProviderInstanceId,
} from "@t3tools/contracts";
import { Atom, type AtomRegistry } from "effect/reactivity";
import type { McpServerDraft } from "./mcpManagementDraft.ts";

export interface McpManagementUiSession {
  providersView: "accounts" | "mcps";
  lastSearchTargetId: string | null | undefined;
  editorAdvanced: boolean;
  editorClientSettings: boolean;
  editor: {
    draft: McpServerDraft;
    initialDraft: McpServerDraft;
    editing: boolean;
    revision: number;
  } | null;
  expandedId: string | null;
  manualCallback: boolean;
  removeConfirmation: { id: string; revision: number } | null;
  mode: "import" | "copy" | null;
  source: ProviderInstanceId | null;
  target: ProviderInstanceId | null;
  configuration: string;
  preview: { servers: readonly ManagedMcpServer[]; warnings: readonly string[] } | null;
  callbacks: Record<string, string>;
  flows: Record<string, McpOAuthStartResult>;
  pending: boolean;
  error: string | null;
}

function emptySession(): McpManagementUiSession {
  return {
    providersView: "accounts",
    lastSearchTargetId: undefined,
    editorAdvanced: false,
    editorClientSettings: false,
    editor: null,
    expandedId: null,
    manualCallback: false,
    removeConfirmation: null,
    mode: null,
    source: null,
    target: null,
    configuration: "",
    preview: null,
    callbacks: {},
    flows: {},
    pending: false,
    error: null,
  };
}

export function hasMcpManagementDraft(session: McpManagementUiSession) {
  return (
    (session.editor !== null &&
      JSON.stringify(session.editor.draft) !== JSON.stringify(session.editor.initialDraft)) ||
    (session.mode === "import" && session.configuration.trim() !== "")
  );
}

/** Drafts and OAuth recovery stay in memory across connection-gated component remounts. */
export function createMcpManagementUiSessions() {
  const retainedEnvironmentIdsAtom = Atom.make<ReadonlySet<EnvironmentId> | null>(null).pipe(
    Atom.keepAlive,
  );
  const sessionsAtom = Atom.make<ReadonlyMap<EnvironmentId, McpManagementUiSession>>(
    new Map(),
  ).pipe(Atom.keepAlive);
  const sessionAtom = Atom.family((environmentId: EnvironmentId) => {
    const initial = emptySession();
    return Atom.make((get) => get(sessionsAtom).get(environmentId) ?? initial);
  });
  function read(registry: AtomRegistry.AtomRegistry, environmentId: EnvironmentId) {
    return registry.get(sessionAtom(environmentId));
  }
  function setField<K extends keyof McpManagementUiSession>(
    registry: AtomRegistry.AtomRegistry,
    environmentId: EnvironmentId,
    field: K,
    next:
      | McpManagementUiSession[K]
      | ((previous: McpManagementUiSession[K]) => McpManagementUiSession[K]),
  ) {
    const ids = registry.get(retainedEnvironmentIdsAtom);
    if (ids !== null && !ids.has(environmentId)) return;
    const previous = read(registry, environmentId);
    const value = typeof next === "function" ? next(previous[field]) : next;
    registry.set(
      sessionsAtom,
      new Map(registry.get(sessionsAtom)).set(environmentId, { ...previous, [field]: value }),
    );
  }
  function discardDrafts(registry: AtomRegistry.AtomRegistry) {
    registry.set(
      sessionsAtom,
      new Map(
        [...registry.get(sessionsAtom)].map(([id, session]) => [
          id,
          { ...session, editor: null, mode: null, configuration: "", preview: null, error: null },
        ]),
      ),
    );
  }
  function retainEnvironments(
    registry: AtomRegistry.AtomRegistry,
    ids: ReadonlySet<EnvironmentId>,
  ) {
    registry.set(retainedEnvironmentIdsAtom, ids);
    const previous = registry.get(sessionsAtom);
    const retained = new Map([...previous].filter(([id]) => ids.has(id)));
    if (retained.size !== previous.size) registry.set(sessionsAtom, retained);
  }
  return { sessionsAtom, sessionAtom, read, setField, discardDrafts, retainEnvironments };
}
