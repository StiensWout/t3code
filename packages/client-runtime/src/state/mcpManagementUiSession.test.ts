import { EnvironmentId } from "@t3tools/contracts";
import { AtomRegistry } from "effect/reactivity";
import { describe, expect, it } from "vite-plus/test";
import { createMcpServerDraft } from "./mcpManagementDraft.ts";
import { createMcpManagementUiSessions, hasMcpManagementDraft } from "./mcpManagementUiSession.ts";

const first = EnvironmentId.make("first");
const second = EnvironmentId.make("second");

describe("MCP management UI sessions", () => {
  it("retains each environment's draft, import, detail and sign-in recovery after subscribers leave", () => {
    const registry = AtomRegistry.make();
    const sessions = createMcpManagementUiSessions();
    try {
      const unsubscribe = registry.subscribe(sessions.sessionAtom(first), () => {});
      const initialDraft = createMcpServerDraft();
      const editor = {
        initialDraft,
        draft: { ...initialDraft, command: "docs-mcp" },
        editing: false,
        revision: 2,
      };
      sessions.setField(registry, first, "editor", editor);
      sessions.setField(registry, first, "providersView", "mcps");
      sessions.setField(registry, first, "expandedId", "docs");
      sessions.setField(registry, first, "flows", {
        docs: {
          flowId: "flow-id",
          authorizationUrl: "https://oauth.example/authorize?state=private",
          expiresAt: 1_791_460_800_000,
        },
      });
      sessions.setField(registry, second, "mode", "import");
      sessions.setField(registry, second, "configuration", '{"mcpServers":{}}');
      unsubscribe();

      // A fresh subscription stands in for the connection-gated view returning.
      const remounted = registry.subscribe(sessions.sessionAtom(first), () => {});
      expect(sessions.read(registry, first)).toMatchObject({
        editor,
        providersView: "mcps",
        expandedId: "docs",
        flows: { docs: { flowId: "flow-id" } },
      });
      expect(sessions.read(registry, second)).toMatchObject({
        mode: "import",
        configuration: '{"mcpServers":{}}',
        editor: null,
      });
      expect(hasMcpManagementDraft(sessions.read(registry, first))).toBe(true);
      expect(hasMcpManagementDraft(sessions.read(registry, second))).toBe(true);
      remounted();
    } finally {
      registry.dispose();
    }
  });

  it("explicit discard clears unsaved forms while preserving sign-in recovery and environment isolation", () => {
    const registry = AtomRegistry.make();
    const sessions = createMcpManagementUiSessions();
    try {
      const draft = createMcpServerDraft();
      sessions.setField(registry, first, "editor", {
        draft,
        initialDraft: draft,
        editing: false,
        revision: 0,
      });
      expect(hasMcpManagementDraft(sessions.read(registry, first))).toBe(false);
      sessions.setField(registry, first, "editor", (editor) =>
        editor ? { ...editor, draft: { ...editor.draft, name: "Unsaved" } } : editor,
      );
      sessions.setField(registry, first, "callbacks", {
        docs: "https://callback.example?code=one",
      });
      sessions.setField(registry, second, "mode", "import");
      sessions.setField(registry, second, "configuration", "pasted configuration");
      sessions.discardDrafts(registry);
      expect(sessions.read(registry, first)).toMatchObject({
        editor: null,
        callbacks: { docs: "https://callback.example?code=one" },
      });
      expect(sessions.read(registry, second)).toMatchObject({ mode: null, configuration: "" });
      expect([...registry.get(sessions.sessionsAtom).values()].some(hasMcpManagementDraft)).toBe(
        false,
      );
    } finally {
      registry.dispose();
    }
  });

  it("forgets a removed environment's sensitive draft without clearing a reconnecting environment", () => {
    const registry = AtomRegistry.make();
    const sessions = createMcpManagementUiSessions();
    try {
      sessions.setField(registry, first, "callbacks", { docs: "private removed callback" });
      sessions.setField(registry, second, "configuration", "private retained configuration");
      sessions.retainEnvironments(registry, new Set([first, second]));
      expect(sessions.read(registry, first).callbacks.docs).toBe("private removed callback");
      sessions.retainEnvironments(registry, new Set([second]));
      // A sign-in response arriving after removal cannot recreate its recovery state.
      sessions.setField(registry, first, "callbacks", { docs: "late private callback" });
      expect(sessions.read(registry, first).callbacks).toEqual({});
      expect(sessions.read(registry, second).configuration).toBe("private retained configuration");
    } finally {
      registry.dispose();
    }
  });
});
