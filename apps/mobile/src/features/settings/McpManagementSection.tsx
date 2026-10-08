import { useAtomValue } from "@effect/atom-react";
import {
  createMcpServerDraft,
  McpDraftError,
  mcpOAuthRedirectUrl,
  mcpServerFromDraft,
} from "@t3tools/client-runtime/state/mcpManagementDraft";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
  type AtomCommandResult,
} from "@t3tools/client-runtime/state/runtime";
import type { EnvironmentId, ManagedMcpServer, ProviderInstanceId } from "@t3tools/contracts";
import { Alert, Keyboard, Linking, View } from "react-native";
import { AppText as Text } from "../../components/AppText";
import { usePreparedConnection } from "../../state/session";
import { mcpManagement, useMcpManagementUiSession } from "../../state/mcpManagement";
import { useEnvironmentQuery } from "../../state/query";
import { useAtomCommand } from "../../state/use-atom-command";
import { McpField, McpServerEditor } from "./McpServerEditor";
import { SettingsActionRow } from "./components/SettingsActionRow";
import { SettingsChoiceRow } from "./components/SettingsChoiceRow";
import { SettingsControlRow } from "./components/SettingsControlRow";
import { SettingsRow } from "./components/SettingsRow";
import { SettingsSection } from "./components/SettingsSection";
import { SettingsSwitchRow } from "./components/SettingsSwitchRow";

const options = { reportFailure: false, reportDefect: false };

/** Changes belong to the environment running the agents, including remote devices. */
export function McpManagementSection({
  environmentId,
  onNavigate,
}: {
  readonly environmentId: EnvironmentId;
  readonly onNavigate: () => void;
}) {
  const preparedConnection = usePreparedConnection(environmentId);
  const httpBaseUrl =
    preparedConnection._tag === "Some" ? preparedConnection.value.httpBaseUrl : null;
  const query = useEnvironmentQuery(mcpManagement.snapshot({ environmentId, input: {} }));
  const snapshot = query.data;
  const canUpsert = useAtomValue(mcpManagement.upsert.permissionAtom(environmentId));
  const canRemove = useAtomValue(mcpManagement.remove.permissionAtom(environmentId));
  const canToggle = useAtomValue(mcpManagement.setEnabled.permissionAtom(environmentId));
  const canCopy = useAtomValue(mcpManagement.copy.permissionAtom(environmentId));
  const canImport = useAtomValue(mcpManagement.importPreview.permissionAtom(environmentId));
  const canStart = useAtomValue(mcpManagement.startOAuth.permissionAtom(environmentId));
  const canComplete = useAtomValue(mcpManagement.completeOAuth.permissionAtom(environmentId));
  const canCancel = useAtomValue(mcpManagement.cancelOAuth.permissionAtom(environmentId));
  const canLogout = useAtomValue(mcpManagement.logoutOAuth.permissionAtom(environmentId));
  const upsert = useAtomCommand(mcpManagement.upsert, options);
  const remove = useAtomCommand(mcpManagement.remove, options);
  const toggle = useAtomCommand(mcpManagement.setEnabled, options);
  const copy = useAtomCommand(mcpManagement.copy, options);
  const previewImport = useAtomCommand(mcpManagement.importPreview, options);
  const start = useAtomCommand(mcpManagement.startOAuth, options);
  const complete = useAtomCommand(mcpManagement.completeOAuth, options);
  const cancel = useAtomCommand(mcpManagement.cancelOAuth, options);
  const logout = useAtomCommand(mcpManagement.logoutOAuth, options);
  const ui = useMcpManagementUiSession(environmentId);
  const [editor, setEditor] = ui.field("editor");
  const [advanced, setAdvanced] = ui.field("editorAdvanced");
  const [clientSettings, setClientSettings] = ui.field("editorClientSettings");
  const [expandedId, setExpandedId] = ui.field("expandedId");
  const [manualCallback, setManualCallback] = ui.field("manualCallback");
  const [mode, setMode] = ui.field("mode");
  const [source, setSource] = ui.field("source");
  const [target, setTarget] = ui.field("target");
  const [configuration, setConfiguration] = ui.field("configuration");
  const [preview, setPreview] = ui.field("preview");
  const [callbacks, setCallbacks] = ui.field("callbacks");
  const [flows, setFlows] = ui.field("flows");
  const [pending, setPending] = ui.field("pending");
  const [error, setError] = ui.field("error");
  const disabled = pending || !snapshot || query.error !== null;
  async function run<A>(
    operation: () => Promise<AtomCommandResult<A, unknown>>,
  ): Promise<A | undefined> {
    if (ui.read().pending) return;
    setPending(true);
    setError(null);
    try {
      const result = await operation();
      if (result._tag === "Success") return result.value;
      if (!isAtomCommandInterrupted(result)) {
        const failure = squashAtomCommandFailure(result);
        setError(failure instanceof Error ? failure.message : "Could not update MCP settings.");
      }
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not update MCP settings.");
    } finally {
      setPending(false);
    }
  }
  function openEditor(server?: ManagedMcpServer) {
    if (!snapshot) return;
    const draft = createMcpServerDraft(
      server,
      snapshot.providers.map((provider) => provider.instanceId),
    );
    if (!server)
      draft.providerInstanceIds = snapshot.providers
        .filter((provider) => provider.supported)
        .map((provider) => provider.instanceId);
    setAdvanced(false);
    setClientSettings(false);
    setEditor({
      draft,
      initialDraft: draft,
      editing: server !== undefined,
      revision: snapshot.revision,
    });
    setMode(null);
    if (!server) setExpandedId(null);
    onNavigate();
  }
  async function signIn(id: string) {
    if (!httpBaseUrl) {
      setError("Reconnect to this environment before starting sign-in.");
      return;
    }
    const redirectUrl = mcpOAuthRedirectUrl(httpBaseUrl, id);
    const flow = await run(() => start({ environmentId, input: { id, redirectUrl } }));
    if (!flow) return;
    setFlows((previous) => ({ ...previous, [id]: flow }));
    try {
      await Linking.openURL(flow.authorizationUrl);
    } catch {
      setError("Could not open the sign-in page. Tap Open sign-in to retry.");
    }
  }
  function issues(serverId: string, providerInstanceId: ProviderInstanceId) {
    return [
      ...new Set(
        snapshot?.sessions
          .filter((session) => session.providerInstanceId === providerInstanceId)
          .flatMap((session) =>
            (session.issues ?? [])
              .filter((issue) => issue.serverId === serverId)
              .map((issue) => issue.message),
          ) ?? [],
      ),
    ];
  }
  function backToList() {
    Keyboard.dismiss();
    setEditor(null);
    setMode(null);
    setConfiguration("");
    setPreview(null);
    setExpandedId(null);
    setError(null);
    onNavigate();
  }
  function chooseProvider(
    value: ProviderInstanceId | null,
    onChange: (id: ProviderInstanceId) => void,
    label: string,
  ) {
    return (
      <SettingsSection title={label}>
        {snapshot?.providers
          .filter((provider) => provider.supported)
          .map((provider, index) => (
            <SettingsChoiceRow
              key={provider.instanceId}
              label={provider.name}
              description={provider.driver}
              selected={value === provider.instanceId}
              separated={index > 0}
              disabled={disabled}
              onPress={() => onChange(provider.instanceId)}
            />
          ))}
      </SettingsSection>
    );
  }
  function saveEditor() {
    if (!editor || !snapshot) return;
    let server: ManagedMcpServer;
    try {
      server = mcpServerFromDraft(
        editor.draft,
        snapshot.providers.map((provider) => provider.instanceId),
      );
      if (!editor.editing && snapshot.servers.some((entry) => entry.id === server.id)) {
        setError("This server ID already exists. Choose a different ID to add a copy.");
        return;
      }
    } catch (cause) {
      setError(
        cause instanceof McpDraftError
          ? cause.message
          : "Check the server ID, name, command or URL, and named values.",
      );
      return;
    }
    void run(() =>
      upsert({ environmentId, input: { server, expectedRevision: editor.revision } }),
    ).then((result) => {
      if (result) {
        setEditor(null);
        onNavigate();
      }
    });
  }
  const server = snapshot?.servers.find((entry) => entry.id === expandedId);
  const localFlow = server ? flows[server.id] : undefined;
  const flow =
    localFlow && (!server?.authFlowId || localFlow.flowId === server.authFlowId)
      ? localFlow
      : undefined;
  const flowId = server?.authFlowId ?? flow?.flowId;
  const active = server?.authStatus === "authorizing";
  const authLabel =
    server?.authStatus === "connected"
      ? "Signed in"
      : active
        ? "Waiting for sign-in"
        : server?.authStatus === "sign-in-required"
          ? "Sign in required"
          : "Signed out";
  return (
    <View className="gap-6">
      {error || query.error ? (
        <SettingsSection>
          <Text accessibilityRole="alert" className="px-4 py-3 text-danger-foreground">
            {error ?? query.error}
          </Text>
          <SettingsActionRow
            icon="arrow.clockwise"
            label="Refresh"
            disabled={pending}
            onPress={query.refresh}
          />
          {editor && snapshot && editor.revision !== snapshot.revision ? (
            <SettingsActionRow
              icon="arrow.clockwise"
              label="Reload editor"
              disabled={pending}
              onPress={() => {
                if (editor.editing) {
                  const current = snapshot.servers.find((entry) => entry.id === editor.draft.id);
                  if (current) openEditor(current);
                  else setEditor(null);
                } else setEditor({ ...editor, revision: snapshot.revision });
                setError(null);
              }}
            />
          ) : null}
        </SettingsSection>
      ) : null}
      {!snapshot ? (
        <SettingsSection>
          <Text className="p-4 text-foreground-muted">Loading MCP settings...</Text>
        </SettingsSection>
      ) : editor ? (
        <McpServerEditor
          key={`${editor.editing}:${editor.revision}`}
          draft={editor.draft}
          providers={snapshot.providers}
          editing={editor.editing}
          advanced={advanced}
          onAdvancedChange={setAdvanced}
          clientSettings={clientSettings}
          onClientSettingsChange={setClientSettings}
          oauthRedirectUrl={
            httpBaseUrl && editor.draft.id.trim()
              ? mcpOAuthRedirectUrl(httpBaseUrl, editor.draft.id)
              : null
          }
          disabled={disabled || !canUpsert}
          onChange={(draft) => setEditor({ ...editor, draft })}
          onCancel={() => {
            setEditor(null);
            setError(null);
            onNavigate();
          }}
          onSave={saveEditor}
        />
      ) : mode === "copy" ? (
        <>
          <Text className="px-2 text-lg font-t3-medium text-foreground">Copy assignments</Text>
          <SettingsSection>
            <SettingsActionRow icon="arrow.left" label="MCP servers" onPress={backToList} />
          </SettingsSection>
          {chooseProvider(source, setSource, "Copy from")}
          {chooseProvider(target, setTarget, "Copy to")}
          <Text className="px-2 text-sm text-foreground-muted">
            Adds assignments from the source. Keeps existing target assignments.
          </Text>
          <SettingsSection>
            <SettingsActionRow
              icon="doc.on.doc"
              label="Copy assignments"
              disabled={disabled || !canCopy || !source || !target || source === target}
              onPress={() => {
                if (source && target)
                  void run(() => copy({ environmentId, input: { source, target } })).then(
                    (result) => {
                      if (result) backToList();
                    },
                  );
              }}
            />
          </SettingsSection>
        </>
      ) : mode === "import" ? (
        <>
          <Text className="px-2 text-lg font-t3-medium text-foreground">Import configuration</Text>
          <SettingsSection>
            <SettingsActionRow icon="arrow.left" label="MCP servers" onPress={backToList} />
          </SettingsSection>
          {chooseProvider(
            source,
            (id) => {
              setSource(id);
              setPreview(null);
            },
            "Provider",
          )}
          <SettingsSection>
            <McpField
              label="Provider configuration, JSON or TOML"
              value={configuration}
              multiline
              disabled={disabled || !canImport}
              onChange={(value) => {
                setConfiguration(value);
                setPreview(null);
              }}
            />
            <SettingsActionRow
              icon="arrow.down"
              label="Preview import"
              disabled={disabled || !canImport || !source || !configuration.trim()}
              onPress={() => {
                Keyboard.dismiss();
                if (source)
                  void run(() =>
                    previewImport({
                      environmentId,
                      input: { providerInstanceId: source, configuration },
                    }),
                  ).then((result) => {
                    if (result) setPreview(result);
                  });
              }}
            />
          </SettingsSection>
          {preview ? (
            <>
              {preview.warnings.length > 0 ? (
                <SettingsSection>
                  {preview.warnings.map((warning) => (
                    <Text key={warning} className="px-4 py-3 text-sm text-foreground-muted">
                      {warning}
                    </Text>
                  ))}
                </SettingsSection>
              ) : null}
              <SettingsSection title="Review servers">
                {preview.servers.map((imported) => (
                  <SettingsRow
                    key={imported.id}
                    icon={imported.transport.type === "stdio" ? "terminal" : "server.rack"}
                    label={imported.name}
                    truncateLabel
                    value={
                      snapshot.servers.some((entry) => entry.id === imported.id)
                        ? "Rename ID to add"
                        : imported.transport.type
                    }
                    disabled={disabled || !canUpsert}
                    onPress={() => {
                      const draft = createMcpServerDraft(
                        imported,
                        snapshot.providers.map((provider) => provider.instanceId),
                      );
                      setEditor({
                        draft,
                        initialDraft: draft,
                        editing: false,
                        revision: snapshot.revision,
                      });
                      onNavigate();
                    }}
                  />
                ))}
                {preview.servers.length === 0 ? (
                  <Text className="p-4 text-foreground-muted">
                    No importable MCP servers found.
                  </Text>
                ) : null}
              </SettingsSection>
            </>
          ) : null}
        </>
      ) : server ? (
        <>
          <Text className="px-2 text-lg font-t3-medium text-foreground">{server.name}</Text>
          <SettingsSection>
            <SettingsActionRow icon="arrow.left" label="MCP servers" onPress={backToList} />
          </SettingsSection>
          {server.authStatus !== "not-required" ? (
            <SettingsSection>
              <SettingsControlRow icon="person.crop.circle" label="Sign-in">
                <Text className="text-sm text-foreground-muted">{authLabel}</Text>
              </SettingsControlRow>
              {server.authStatus === "connected" ? (
                <SettingsActionRow
                  icon="person.crop.circle"
                  label="Sign out"
                  disabled={disabled || !canLogout}
                  onPress={() => {
                    void run(() => logout({ environmentId, input: { id: server.id } }));
                  }}
                />
              ) : (
                <SettingsActionRow
                  icon="person.crop.circle"
                  label={active ? "Restart sign-in" : "Sign in"}
                  disabled={disabled || !canStart || !httpBaseUrl}
                  onPress={() => {
                    void signIn(server.id);
                  }}
                />
              )}
              {active && flowId ? (
                <>
                  {flow ? (
                    <SettingsActionRow
                      icon="globe"
                      label="Open sign-in"
                      onPress={() => {
                        void Linking.openURL(flow.authorizationUrl).catch(() =>
                          setError("Could not open sign-in."),
                        );
                      }}
                    />
                  ) : null}
                  <SettingsActionRow
                    icon="xmark"
                    label="Cancel sign-in"
                    disabled={disabled || !canCancel}
                    onPress={() => {
                      void run(() => cancel({ environmentId, input: { id: server.id, flowId } }));
                    }}
                  />
                  <Text className="px-4 py-3 text-sm text-foreground-muted">
                    Finish signing in in your browser, then return to T3 Code.
                  </Text>
                  <SettingsRow
                    icon="link"
                    label="Callback recovery"
                    value={manualCallback ? "Hide" : "Optional"}
                    onPress={() => setManualCallback(!manualCallback)}
                  />
                  {manualCallback ? (
                    <>
                      <Text className="px-4 py-3 text-sm text-foreground-muted">
                        If the callback cannot reach this environment, copy its final address and
                        paste it here.
                      </Text>
                      <McpField
                        label="Callback URL"
                        value={callbacks[server.id] ?? ""}
                        secret
                        disabled={disabled || !canComplete}
                        onChange={(value) =>
                          setCallbacks((previous) => ({ ...previous, [server.id]: value }))
                        }
                      />
                      <SettingsActionRow
                        icon="checkmark"
                        label="Finish sign-in"
                        disabled={disabled || !canComplete || !callbacks[server.id]?.trim()}
                        onPress={() => {
                          Keyboard.dismiss();
                          void run(() =>
                            complete({
                              environmentId,
                              input: {
                                id: server.id,
                                flowId,
                                callbackUrl: (callbacks[server.id] ?? "").trim(),
                              },
                            }),
                          ).then((result) => {
                            if (result) {
                              setCallbacks((previous) => ({ ...previous, [server.id]: "" }));
                              setManualCallback(false);
                            }
                          });
                        }}
                      />
                    </>
                  ) : null}
                </>
              ) : null}
            </SettingsSection>
          ) : null}
          <SettingsSection title="Providers">
            {snapshot.providers.map((provider) => {
              const enabled = server.providerInstanceIds.includes(provider.instanceId);
              return (
                <View key={provider.instanceId}>
                  <SettingsSwitchRow
                    icon="server.rack"
                    label={provider.name}
                    subtitle={provider.supported ? undefined : (provider.reason ?? "Unsupported")}
                    value={enabled}
                    disabled={disabled || !canToggle || (!provider.supported && !enabled)}
                    onValueChange={(value) => {
                      void run(() =>
                        toggle({
                          environmentId,
                          input: {
                            id: server.id,
                            providerInstanceId: provider.instanceId,
                            enabled: value,
                          },
                        }),
                      );
                    }}
                  />
                  {issues(server.id, provider.instanceId).map((message) => (
                    <Text
                      key={message}
                      accessibilityRole="alert"
                      className="px-4 pb-3 text-sm text-danger-foreground"
                    >
                      Skipped: {message}
                    </Text>
                  ))}
                </View>
              );
            })}
          </SettingsSection>
          <SettingsSection>
            <SettingsRow
              icon="pencil"
              label="Edit configuration"
              disabled={disabled || !canUpsert}
              onPress={() => openEditor(server)}
            />
            <SettingsActionRow
              icon="trash"
              label="Remove MCP"
              tone="danger"
              disabled={disabled || !canRemove}
              onPress={() =>
                Alert.alert("Remove MCP server?", `Remove ${server.name} from all providers?`, [
                  { text: "Cancel", style: "cancel" },
                  {
                    text: "Remove",
                    style: "destructive",
                    onPress: () => {
                      void run(() =>
                        remove({
                          environmentId,
                          input: { id: server.id, expectedRevision: snapshot.revision },
                        }),
                      ).then((result) => {
                        if (result) backToList();
                      });
                    },
                  },
                ])
              }
            />
          </SettingsSection>
        </>
      ) : (
        <>
          <SettingsSection>
            {snapshot.servers.map((entry) => (
              <SettingsRow
                key={entry.id}
                icon={entry.transport.type === "stdio" ? "terminal" : "server.rack"}
                label={entry.name}
                truncateLabel
                value={`${entry.transport.type === "http" ? "HTTP" : "stdio"} · ${entry.providerInstanceIds.length} providers`}
                onPress={() => {
                  setExpandedId(entry.id);
                  setManualCallback(false);
                  setError(null);
                  onNavigate();
                }}
              />
            ))}
            {snapshot.servers.length === 0 ? (
              <Text className="p-4 text-foreground-muted">
                Add a server to make its tools available in T3 sessions.
              </Text>
            ) : null}
          </SettingsSection>
          <SettingsSection>
            <SettingsActionRow
              icon="plus"
              label="Add MCP"
              disabled={disabled || !canUpsert}
              onPress={() => openEditor()}
            />
            <SettingsActionRow
              icon="arrow.down"
              label="Import configuration"
              disabled={disabled || !canImport}
              onPress={() => {
                setMode("import");
                setPreview(null);
                setError(null);
                onNavigate();
              }}
            />
            <SettingsActionRow
              icon="doc.on.doc"
              label="Copy assignments"
              disabled={disabled || !canCopy}
              onPress={() => {
                setMode("copy");
                setError(null);
                onNavigate();
              }}
            />
          </SettingsSection>
        </>
      )}
      {snapshot?.sessions.some((session) => session.revision < snapshot.revision) ? (
        <Text className="px-2 text-sm text-foreground-muted">
          Saved changes apply to new agent sessions.
        </Text>
      ) : null}
    </View>
  );
}
