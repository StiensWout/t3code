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
import type {
  EnvironmentId,
  ManagedMcpServer,
  McpManagementSnapshot,
  McpOAuthStartResult,
  ProviderInstanceId,
} from "@t3tools/contracts";
import { Link } from "@tanstack/react-router";
import { isElectron } from "../../env";
import { useEnvironmentHttpBaseUrl } from "../../state/environments";
import { ensureLocalApi } from "../../localApi";
import { mcpManagement, useMcpManagementUiSession } from "../../state/mcpManagement";
import { useEnvironmentQuery } from "../../state/query";
import { useAtomCommand } from "../../state/use-atom-command";
import { Button } from "../ui/button";
import { Checkbox } from "../ui/checkbox";
import { Input } from "../ui/input";
import { Textarea } from "../ui/textarea";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { useSettingsSearchTarget } from "./settingsLayout";
import { McpServerEditor } from "./McpServerEditor";

const commandOptions = { reportFailure: false, reportDefect: false };

/** The subscription remains authoritative, including edits from other connected clients. */
export function McpManagementSection({ environmentId }: { readonly environmentId: EnvironmentId }) {
  const searchTargetRef = useSettingsSearchTarget<HTMLDivElement>("mcp-servers");
  const httpBaseUrl = useEnvironmentHttpBaseUrl(environmentId);
  const callbackBaseUrl = isElectron ? httpBaseUrl : window.location.origin;
  const query = useEnvironmentQuery(mcpManagement.snapshot({ environmentId, input: {} }));
  const snapshot = query.data;
  const canUpsert = useAtomValue(mcpManagement.upsert.permissionAtom(environmentId));
  const canRemove = useAtomValue(mcpManagement.remove.permissionAtom(environmentId));
  const canToggle = useAtomValue(mcpManagement.setEnabled.permissionAtom(environmentId));
  const canCopy = useAtomValue(mcpManagement.copy.permissionAtom(environmentId));
  const canImport = useAtomValue(mcpManagement.importPreview.permissionAtom(environmentId));
  const canComplete = useAtomValue(mcpManagement.completeOAuth.permissionAtom(environmentId));
  const canStart = useAtomValue(mcpManagement.startOAuth.permissionAtom(environmentId));
  const canCancel = useAtomValue(mcpManagement.cancelOAuth.permissionAtom(environmentId));
  const canLogout = useAtomValue(mcpManagement.logoutOAuth.permissionAtom(environmentId));
  const upsert = useAtomCommand(mcpManagement.upsert, commandOptions);
  const remove = useAtomCommand(mcpManagement.remove, commandOptions);
  const setEnabled = useAtomCommand(mcpManagement.setEnabled, commandOptions);
  const copy = useAtomCommand(mcpManagement.copy, commandOptions);
  const importPreview = useAtomCommand(mcpManagement.importPreview, commandOptions);
  const completeOAuth = useAtomCommand(mcpManagement.completeOAuth, commandOptions);
  const startOAuth = useAtomCommand(mcpManagement.startOAuth, commandOptions);
  const cancelOAuth = useAtomCommand(mcpManagement.cancelOAuth, commandOptions);
  const logoutOAuth = useAtomCommand(mcpManagement.logoutOAuth, commandOptions);
  const ui = useMcpManagementUiSession(environmentId);
  const [editor, setEditor] = ui.field("editor");
  const [removeConfirmation, setRemoveConfirmation] = ui.field("removeConfirmation");
  const [mode, setMode] = ui.field("mode");
  const [source, setSource] = ui.field("source");
  const [target, setTarget] = ui.field("target");
  const [configuration, setConfiguration] = ui.field("configuration");
  const [preview, setPreview] = ui.field("preview");
  const [callbacks, setCallbacks] = ui.field("callbacks");
  const [flows, setFlows] = ui.field("flows");
  const [pending, setPending] = ui.field("pending");
  const [error, setError] = ui.field("error");
  const disabled = pending || snapshot === null || query.error !== null;

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
    setMode(null);
    setError(null);
    const draft = createMcpServerDraft(
      server,
      snapshot.providers.map((provider) => provider.instanceId),
    );
    if (!server)
      draft.providerInstanceIds = snapshot.providers
        .filter((provider) => provider.supported)
        .map((provider) => provider.instanceId);
    setEditor({
      draft,
      initialDraft: draft,
      editing: server !== undefined,
      revision: snapshot.revision,
    });
  }
  function providerPicker(
    value: ProviderInstanceId | null,
    onChange: (id: ProviderInstanceId) => void,
    label: string,
  ) {
    return (
      <label className="grid min-w-0 gap-1 text-sm">
        {label}
        <Select
          value={value}
          disabled={disabled}
          onValueChange={(id) => {
            const provider = snapshot?.providers.find((entry) => entry.instanceId === id);
            if (provider) onChange(provider.instanceId);
          }}
        >
          <SelectTrigger>
            <SelectValue placeholder="Select provider" />
          </SelectTrigger>
          <SelectPopup>
            {snapshot?.providers
              .filter((provider) => provider.supported)
              .map((provider) => (
                <SelectItem key={provider.instanceId} value={provider.instanceId}>
                  {provider.name}
                </SelectItem>
              ))}
          </SelectPopup>
        </Select>
      </label>
    );
  }
  async function signIn(id: string) {
    if (!callbackBaseUrl) {
      setError("Reconnect to this environment before starting sign-in.");
      return;
    }
    const redirectUrl = mcpOAuthRedirectUrl(
      callbackBaseUrl,
      id,
      isElectron ? undefined : environmentId,
    );
    const flow = await run(() => startOAuth({ environmentId, input: { id, redirectUrl } }));
    if (!flow) return;
    setFlows((previous) => ({ ...previous, [id]: flow }));
    try {
      await ensureLocalApi().shell.openExternal(flow.authorizationUrl);
    } catch {
      setError("Could not open the sign-in page. Use the sign-in link below.");
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
  const staleSessions =
    snapshot?.sessions.filter((session) => session.revision < snapshot.revision) ?? [];
  return (
    <div id="mcp-servers" ref={searchTargetRef} tabIndex={-1} className="min-w-0">
      <div className="flex flex-wrap items-center justify-between gap-2 p-4">
        <h3 className="text-sm font-medium">MCP servers</h3>
        <div className="flex items-center gap-2">
          <Button
            size="xs"
            variant="ghost"
            disabled={disabled || editor !== null || !canImport}
            onClick={() => {
              setMode(mode === "import" ? null : "import");
              setConfiguration("");
              setEditor(null);
              setPreview(null);
            }}
          >
            Import
          </Button>
          <Button
            size="xs"
            variant="ghost"
            disabled={disabled || editor !== null || !canCopy}
            onClick={() => {
              setMode(mode === "copy" ? null : "copy");
              setEditor(null);
            }}
          >
            Copy assignments
          </Button>
          <Button
            size="xs"
            disabled={disabled || editor !== null || !canUpsert}
            onClick={() => openEditor()}
          >
            Add MCP
          </Button>
        </div>
      </div>
      {error || query.error ? (
        <div role="alert" className="px-4 pb-3 text-sm text-destructive">
          {error ?? query.error}
          <Button size="xs" variant="ghost" onClick={query.refresh}>
            Refresh
          </Button>
          {editor && snapshot && editor.revision !== snapshot.revision ? (
            <Button
              size="xs"
              variant="ghost"
              disabled={pending}
              onClick={() => {
                if (editor.editing) {
                  const current = snapshot.servers.find((server) => server.id === editor.draft.id);
                  if (current) openEditor(current);
                  else setEditor(null);
                } else {
                  setEditor({ ...editor, revision: snapshot.revision });
                  setError(null);
                }
              }}
            >
              Reload editor
            </Button>
          ) : null}
        </div>
      ) : null}
      {!snapshot ? (
        <p className="p-4 text-sm">Loading MCP settings...</p>
      ) : (
        <>
          {snapshot.servers.length === 0 ? (
            <p className="p-4 text-sm">Add a server to make its tools available in T3 sessions.</p>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-y border-border">
                    <th className="px-4 py-3 text-left font-medium">Server</th>
                    {snapshot.providers.map((provider) => (
                      <th
                        key={provider.instanceId}
                        className="min-w-28 px-3 py-3 text-center font-medium"
                      >
                        {provider.name}
                        {!provider.supported ? (
                          <span className="block text-xs font-normal">Unsupported</span>
                        ) : null}
                      </th>
                    ))}
                    <th className="px-4 py-3 text-left font-medium">Authentication</th>
                  </tr>
                </thead>
                <tbody>
                  {snapshot.servers.map((server) => (
                    <tr key={server.id} className="border-b border-border">
                      <td className="min-w-52 px-4 py-3">
                        <Button
                          size="xs"
                          variant="ghost"
                          disabled={disabled || editor !== null}
                          onClick={() => openEditor(server)}
                        >
                          {server.name}
                        </Button>
                        <div className="mt-1 flex items-center gap-2 text-xs">
                          <span>
                            {server.transport.type === "stdio" ? server.transport.command : "HTTP"}
                          </span>
                          <Button
                            size="xs"
                            variant="ghost"
                            disabled={disabled || editor !== null || !canRemove}
                            onClick={() =>
                              setRemoveConfirmation({ id: server.id, revision: snapshot.revision })
                            }
                          >
                            Remove
                          </Button>
                        </div>
                        {removeConfirmation?.id === server.id ? (
                          <div
                            className="mt-2 grid gap-1 text-xs"
                            role="group"
                            aria-label={`Remove ${server.name}`}
                          >
                            <span>Remove from all providers?</span>
                            <div className="flex gap-2">
                              <Button
                                size="xs"
                                variant="ghost"
                                disabled={disabled || editor !== null || !canRemove}
                                onClick={() => {
                                  void run(() =>
                                    remove({
                                      environmentId,
                                      input: {
                                        id: server.id,
                                        expectedRevision: removeConfirmation.revision,
                                      },
                                    }),
                                  ).then((result) => {
                                    if (result) setRemoveConfirmation(null);
                                  });
                                }}
                              >
                                Confirm remove
                              </Button>
                              <Button
                                size="xs"
                                variant="ghost"
                                disabled={pending}
                                onClick={() => setRemoveConfirmation(null)}
                              >
                                Cancel
                              </Button>
                            </div>
                          </div>
                        ) : null}
                      </td>
                      {snapshot.providers.map((provider) => (
                        <td key={provider.instanceId} className="px-3 py-3 text-center">
                          <Checkbox
                            aria-label={`Enable ${server.name} for ${provider.name}`}
                            checked={server.providerInstanceIds.includes(provider.instanceId)}
                            disabled={
                              disabled ||
                              editor !== null ||
                              !canToggle ||
                              (!provider.supported &&
                                !server.providerInstanceIds.includes(provider.instanceId))
                            }
                            onCheckedChange={(enabled) => {
                              void run(() =>
                                setEnabled({
                                  environmentId,
                                  input: {
                                    id: server.id,
                                    providerInstanceId: provider.instanceId,
                                    enabled,
                                  },
                                }),
                              );
                            }}
                          />
                          {issues(server.id, provider.instanceId).map((message) => (
                            <p
                              key={message}
                              role="status"
                              className="mt-2 text-xs text-destructive"
                            >
                              Skipped: {message}
                            </p>
                          ))}
                        </td>
                      ))}
                      <td className="min-w-48 px-4 py-3">
                        <McpAuthentication
                          server={server}
                          flow={flows[server.id]}
                          disabled={disabled || editor !== null}
                          canComplete={canComplete}
                          callback={callbacks[server.id] ?? ""}
                          onCallbackChange={(callback) =>
                            setCallbacks((previous) => ({ ...previous, [server.id]: callback }))
                          }
                          onComplete={() => {
                            const flow = flows[server.id];
                            const flowId = server.authFlowId ?? flow?.flowId;
                            if (!flowId) return;
                            void run(() =>
                              completeOAuth({
                                environmentId,
                                input: {
                                  id: server.id,
                                  flowId,
                                  callbackUrl: (callbacks[server.id] ?? "").trim(),
                                },
                              }),
                            ).then((result) => {
                              if (result)
                                setCallbacks((previous) => ({ ...previous, [server.id]: "" }));
                            });
                          }}
                          canStart={canStart && (!isElectron || httpBaseUrl !== null)}
                          canCancel={canCancel}
                          canLogout={canLogout}
                          onStart={() => {
                            void signIn(server.id);
                          }}
                          onCancel={() => {
                            const flowId = server.authFlowId ?? flows[server.id]?.flowId;
                            if (!flowId) return;
                            void run(() =>
                              cancelOAuth({ environmentId, input: { id: server.id, flowId } }),
                            ).then((result) => {
                              if (result !== undefined)
                                setFlows((previous) => {
                                  const next = { ...previous };
                                  delete next[server.id];
                                  return next;
                                });
                            });
                          }}
                          onLogout={() => {
                            void run(() =>
                              logoutOAuth({ environmentId, input: { id: server.id } }),
                            );
                          }}
                        />
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          {staleSessions.length > 0 ? (
            <div className="grid gap-1 p-4 text-xs">
              <p>
                Saved changes apply to new sessions. {staleSessions.length} running{" "}
                {staleSessions.length === 1 ? "session uses" : "sessions use"} earlier settings.
                Open the session and choose Restart agent session in the command palette to apply
                changes.
              </p>
              {staleSessions.map((session) => (
                <Link
                  key={session.threadId}
                  to="/$environmentId/$threadId"
                  params={{ environmentId, threadId: session.threadId }}
                  className="underline"
                >
                  Open{" "}
                  {snapshot.providers.find(
                    (provider) => provider.instanceId === session.providerInstanceId,
                  )?.name ?? "provider"}{" "}
                  session
                </Link>
              ))}
            </div>
          ) : null}
          {mode === "copy" ? (
            <div className="grid gap-3 border-t border-border p-4 sm:grid-cols-2">
              {providerPicker(source, setSource, "Copy from")}
              {providerPicker(target, setTarget, "Copy to")}
              <p className="text-xs sm:col-span-2">
                Adds the source's assignments. Keeps assignments already on the target.
              </p>
              <div className="sm:col-span-2">
                <Button
                  size="sm"
                  disabled={disabled || !canCopy || !source || !target || source === target}
                  onClick={() => {
                    if (source && target)
                      void run(() => copy({ environmentId, input: { source, target } })).then(
                        (result) => {
                          if (result !== undefined) setMode(null);
                        },
                      );
                  }}
                >
                  Copy assignments
                </Button>
              </div>
            </div>
          ) : null}
          {mode === "import" ? (
            <div className="grid gap-3 border-t border-border p-4">
              {providerPicker(
                source,
                (id) => {
                  setSource(id);
                  setPreview(null);
                },
                "Provider",
              )}
              <label className="grid gap-1 text-sm">
                Provider configuration, JSON or TOML
                <Textarea
                  value={configuration}
                  disabled={disabled}
                  onChange={(event) => {
                    setConfiguration(event.target.value);
                    setPreview(null);
                  }}
                />
              </label>
              <div>
                <Button
                  size="sm"
                  disabled={disabled || !canImport || !source || !configuration.trim()}
                  onClick={() => {
                    if (source)
                      void run(() =>
                        importPreview({
                          environmentId,
                          input: { providerInstanceId: source, configuration },
                        }),
                      ).then((result) => {
                        if (result) setPreview(result);
                      });
                  }}
                >
                  Preview import
                </Button>
              </div>
              {preview ? (
                <div className="grid gap-2">
                  {preview.warnings.map((warning) => (
                    <p key={warning} className="text-sm">
                      {warning}
                    </p>
                  ))}
                  {preview.servers.map((server) => {
                    const exists = snapshot.servers.some((entry) => entry.id === server.id);
                    return (
                      <div
                        key={server.id}
                        className="flex items-center justify-between gap-2 border-t border-border py-2"
                      >
                        <span className="text-sm">
                          {server.name} · {server.transport.type}
                          {exists ? " · ID already exists" : ""}
                        </span>
                        <Button
                          size="xs"
                          disabled={disabled || editor !== null || !canUpsert}
                          onClick={() => {
                            const draft = createMcpServerDraft(
                              server,
                              snapshot.providers.map((provider) => provider.instanceId),
                            );
                            setEditor({
                              draft,
                              initialDraft: draft,
                              editing: false,
                              revision: snapshot.revision,
                            });
                          }}
                        >
                          Review and add
                        </Button>
                      </div>
                    );
                  })}
                  {preview.servers.length === 0 ? (
                    <p className="text-sm">No importable MCP servers found.</p>
                  ) : null}
                </div>
              ) : null}
            </div>
          ) : null}
          {editor ? (
            <McpServerEditor
              draft={editor.draft}
              onChange={(draft) => setEditor({ ...editor, draft })}
              providers={snapshot.providers}
              editing={editor.editing}
              oauthRedirectUrl={
                callbackBaseUrl && editor.draft.id.trim()
                  ? mcpOAuthRedirectUrl(
                      callbackBaseUrl,
                      editor.draft.id,
                      isElectron ? undefined : environmentId,
                    )
                  : null
              }
              disabled={disabled || !canUpsert}
              onCancel={() => setEditor(null)}
              onSave={() => {
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
                  if (result !== undefined) setEditor(null);
                });
              }}
            />
          ) : null}
        </>
      )}
    </div>
  );
}

function McpAuthentication({
  server,
  flow,
  disabled,
  canStart,
  canComplete,
  callback,
  onCallbackChange,
  onComplete,
  canCancel,
  canLogout,
  onStart,
  onCancel,
  onLogout,
}: {
  readonly server: McpManagementSnapshot["servers"][number];
  readonly flow: McpOAuthStartResult | undefined;
  readonly disabled: boolean;
  readonly canStart: boolean;
  readonly canComplete: boolean;
  readonly callback: string;
  readonly onCallbackChange: (value: string) => void;
  readonly onComplete: () => void;
  readonly canCancel: boolean;
  readonly canLogout: boolean;
  readonly onStart: () => void;
  readonly onCancel: () => void;
  readonly onLogout: () => void;
}) {
  if (server.authStatus === "not-required") return <span className="text-xs">Not required</span>;
  const active = server.authStatus === "authorizing";
  const activeFlow =
    flow && (!server.authFlowId || flow.flowId === server.authFlowId) ? flow : undefined;
  return (
    <div className="grid gap-1 text-xs">
      <span>
        {server.authStatus === "connected"
          ? "Signed in"
          : active
            ? "Waiting for sign-in"
            : server.authStatus === "sign-in-required"
              ? "Sign in required"
              : "Signed out"}
      </span>
      <div className="flex flex-wrap gap-2">
        {server.authStatus === "connected" ? (
          <Button size="xs" variant="ghost" disabled={disabled || !canLogout} onClick={onLogout}>
            Sign out
          </Button>
        ) : (
          <Button size="xs" variant="ghost" disabled={disabled || !canStart} onClick={onStart}>
            {active ? "Restart sign-in" : "Sign in"}
          </Button>
        )}
        {active && (activeFlow || server.authFlowId) ? (
          <>
            {activeFlow ? (
              <a
                href={activeFlow.authorizationUrl}
                target="_blank"
                rel="noopener noreferrer"
                className="self-center underline"
              >
                Open sign-in
              </a>
            ) : null}
            <Button size="xs" variant="ghost" disabled={disabled || !canCancel} onClick={onCancel}>
              Cancel
            </Button>
          </>
        ) : null}
      </div>
      {active && (activeFlow || server.authFlowId) ? (
        <details>
          <summary className="cursor-pointer">Paste callback URL</summary>
          <p className="py-2">
            After sign-in, copy the final browser address. If the callback cannot open, copy the
            address from that error page.
          </p>
          <Input
            aria-label={`Callback URL for ${server.name}`}
            type="password"
            autoComplete="off"
            value={callback}
            disabled={disabled || !canComplete}
            onChange={(event) => onCallbackChange(event.target.value)}
          />
          <Button
            size="xs"
            variant="ghost"
            disabled={disabled || !canComplete || !callback.trim()}
            onClick={onComplete}
          >
            Finish sign-in
          </Button>
        </details>
      ) : null}
    </div>
  );
}
