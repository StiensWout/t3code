import { EnvironmentId, ProviderInstanceId, type ManagedMcpServer } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";
import {
  changeMcpClientSecretDraft,
  changeMcpDraftTransport,
  changeMcpNamedValueDraft,
  createMcpServerDraft,
  mcpNamedValuePlaceholder,
  mcpOAuthRedirectUrl,
  mcpServerFromDraft,
  renameMcpNamedValueDraft,
} from "./mcpManagementDraft.ts";

const knownProvider = ProviderInstanceId.make("codex");
const removedProvider = ProviderInstanceId.make("removed");
const server = {
  id: "docs",
  name: "Docs",
  providerInstanceIds: [knownProvider, removedProvider],
  transport: { type: "stdio", command: "docs-mcp", args: [], env: {} },
} satisfies ManagedMcpServer;

describe("MCP editor configuration", () => {
  it("keeps a public OAuth client's configuration unchanged after clearing a temporary secret", () => {
    const draft = createMcpServerDraft({
      ...server,
      transport: { type: "http", url: "https://mcp.example.com", headers: {}, oauth: {} },
    });
    const cleared = changeMcpClientSecretDraft(changeMcpClientSecretDraft(draft, "temporary"), "");
    expect(mcpServerFromDraft(cleared)).toEqual(mcpServerFromDraft(draft));
    expect(mcpServerFromDraft({ ...draft, clientSecret: { value: "", sensitive: true } })).toEqual(
      mcpServerFromDraft(draft),
    );
  });

  it("keeps stored secrets when a replacement is cleared, and permits explicit removal", () => {
    const draft = createMcpServerDraft({
      ...server,
      transport: {
        type: "http",
        url: "https://mcp.example.com",
        headers: { TOKEN: { value: "", sensitive: true, valueRedacted: true } },
        oauth: { clientSecret: { value: "", sensitive: true, valueRedacted: true } },
      },
    });
    const row = changeMcpNamedValueDraft(
      changeMcpNamedValueDraft(draft.values[0]!, "temporary"),
      "",
    );
    const result = mcpServerFromDraft({
      ...changeMcpClientSecretDraft(changeMcpClientSecretDraft(draft, "temporary"), ""),
      values: [row],
    });
    expect(result.transport).toMatchObject({
      headers: { TOKEN: { value: "", sensitive: true, valueRedacted: true } },
      oauth: { clientSecret: { value: "", sensitive: true, valueRedacted: true } },
    });
    expect(
      mcpServerFromDraft({
        ...draft,
        values: [],
        clientSecret: undefined,
        clientSecretStored: false,
      }).transport,
    ).toMatchObject({ headers: {}, oauth: {} });
  });

  it("keeps unsaved variables and headers separate when switching transports", () => {
    const stdio = createMcpServerDraft({
      ...server,
      transport: { ...server.transport, env: { TOKEN: { value: "stdio-token", sensitive: true } } },
    });
    const http = {
      ...changeMcpDraftTransport(stdio, "http"),
      url: "https://mcp.example.com",
      values: [{ ...stdio.values[0]!, key: "Authorization", value: "http-token" }],
    };
    const restored = changeMcpDraftTransport(http, "stdio");
    expect(mcpServerFromDraft(restored).transport).toMatchObject({
      env: { TOKEN: { value: "stdio-token", sensitive: true } },
    });
    expect(mcpServerFromDraft(changeMcpDraftTransport(restored, "http")).transport).toMatchObject({
      headers: { Authorization: { value: "http-token", sensitive: true } },
    });
  });

  it("requires a replacement value when renaming a stored secret", () => {
    const draft = createMcpServerDraft({
      ...server,
      transport: {
        ...server.transport,
        env: { OLD_TOKEN: { value: "", sensitive: true, valueRedacted: true } },
      },
    });
    const row = draft.values[0]!;
    expect(mcpServerFromDraft(draft).transport).toMatchObject({
      env: { OLD_TOKEN: { value: "", sensitive: true, valueRedacted: true } },
    });
    const renamed = renameMcpNamedValueDraft(row, "NEW_TOKEN");
    expect(mcpNamedValuePlaceholder(renamed)).toBe("Re-enter secret after renaming");
    expect(() => mcpServerFromDraft({ ...draft, values: [renamed] })).toThrow(
      "Re-enter the stored secret for NEW_TOKEN after renaming it.",
    );
    expect(
      mcpServerFromDraft({
        ...draft,
        values: [{ ...renamed, value: "replacement", valueRedacted: false }],
      }).transport,
    ).toMatchObject({ env: { NEW_TOKEN: { value: "replacement", sensitive: true } } });
    expect(
      mcpServerFromDraft({ ...draft, values: [renameMcpNamedValueDraft(renamed, "OLD_TOKEN")] })
        .transport,
    ).toMatchObject({
      env: { OLD_TOKEN: { value: "", sensitive: true, valueRedacted: true } },
    });
  });

  it.each(["first\n\nlast\n", "first\r\n\r\nlast\r\n\r\n"])(
    "keeps internal empty arguments and omits trailing blank lines",
    (args) => {
      const result = mcpServerFromDraft({ ...createMcpServerDraft(server), args });
      expect(result.transport).toMatchObject({ type: "stdio", args: ["first", "", "last"] });
    },
  );

  it("drops removed provider assignments when loading and saving a draft", () => {
    const draft = createMcpServerDraft(server, [knownProvider]);
    expect(draft.providerInstanceIds).toEqual([knownProvider]);
    const result = mcpServerFromDraft(createMcpServerDraft(server), [knownProvider]);
    expect(result.providerInstanceIds).toEqual([knownProvider]);
  });

  it("builds the exact native callback without connection credentials", () => {
    expect(
      mcpOAuthRedirectUrl(
        "https://username:secret@remote.example/base?token=private#private",
        "docs",
      ),
    ).toBe("https://remote.example/oauth/managed-mcp/callback?id=docs");
  });

  it("builds the browser callback for the requesting environment", () => {
    expect(
      mcpOAuthRedirectUrl("https://client.example", "docs", EnvironmentId.make("remote-env")),
    ).toBe("https://client.example/auth/mcp-callback?environmentId=remote-env&id=docs");
  });
});
