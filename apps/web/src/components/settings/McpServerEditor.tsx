import {
  changeMcpClientSecretDraft,
  changeMcpDraftTransport,
  changeMcpNamedValueDraft,
  createMcpNamedValueDraft,
  mcpNamedValuePlaceholder,
  renameMcpNamedValueDraft,
  type McpServerDraft,
  toggleMcpDraftProvider,
} from "@t3tools/client-runtime/state/mcpManagementDraft";
import type { McpManagementSnapshot } from "@t3tools/contracts";
import { Button } from "../ui/button";
import { Checkbox } from "../ui/checkbox";
import { Input } from "../ui/input";
import { Textarea } from "../ui/textarea";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";

export function McpServerEditor({
  draft,
  onChange,
  providers,
  editing,
  oauthRedirectUrl,
  disabled,
  onSave,
  onCancel,
}: {
  readonly draft: McpServerDraft;
  readonly onChange: (draft: McpServerDraft) => void;
  readonly providers: McpManagementSnapshot["providers"];
  readonly editing: boolean;
  readonly oauthRedirectUrl: string | null;
  readonly disabled: boolean;
  readonly onSave: () => void;
  readonly onCancel: () => void;
}) {
  function field(
    key: "id" | "name" | "command" | "cwd" | "url" | "scope" | "clientId",
    label: string,
  ) {
    return (
      <label className="grid gap-1 text-sm">
        {label}
        <Input
          value={draft[key]}
          disabled={disabled || (key === "id" && editing)}
          onChange={(event) => onChange({ ...draft, [key]: event.target.value })}
        />
      </label>
    );
  }
  return (
    <form
      className="grid gap-4 border-t border-border p-4"
      onSubmit={(event) => {
        event.preventDefault();
        onSave();
      }}
    >
      <div className="flex items-center justify-between">
        <h3 className="text-sm font-medium">{editing ? "Edit MCP server" : "Add MCP server"}</h3>
        <Button size="xs" variant="ghost" onClick={onCancel}>
          Cancel
        </Button>
      </div>
      <div className="grid gap-3 sm:grid-cols-2">
        {field("id", "Server ID")}
        {field("name", "Name")}
      </div>
      <label className="grid gap-1 text-sm">
        Transport
        <Select
          value={draft.type}
          disabled={disabled}
          onValueChange={(value) => {
            if (value === "stdio" || value === "http")
              onChange(changeMcpDraftTransport(draft, value));
          }}
        >
          <SelectTrigger>
            <SelectValue />
          </SelectTrigger>
          <SelectPopup>
            <SelectItem value="stdio">stdio</SelectItem>
            <SelectItem value="http">HTTP</SelectItem>
          </SelectPopup>
        </Select>
      </label>
      {draft.type === "stdio" ? (
        <>
          {field("command", "Command")}
          <label className="grid gap-1 text-sm">
            Arguments, one per line
            <Textarea
              value={draft.args}
              disabled={disabled}
              onChange={(event) => onChange({ ...draft, args: event.target.value })}
            />
          </label>
          {field("cwd", "Working directory, optional")}
        </>
      ) : (
        field("url", "Server URL")
      )}
      <div className="grid gap-2">
        <div className="flex items-center justify-between">
          <span className="text-sm">
            {draft.type === "stdio" ? "Environment variables" : "Headers"}
          </span>
          <Button
            size="xs"
            variant="ghost"
            disabled={disabled}
            onClick={() =>
              onChange({
                ...draft,
                values: [...draft.values, createMcpNamedValueDraft()],
              })
            }
          >
            Add value
          </Button>
        </div>
        {draft.values.map((row, index) => (
          <div
            key={row.draftId}
            className="grid grid-cols-[minmax(0,1fr)_minmax(0,2fr)_auto_auto] items-center gap-2"
          >
            <Input
              aria-label={`Value ${index + 1} name`}
              value={row.key}
              disabled={disabled}
              placeholder="Name"
              onChange={(event) =>
                onChange({
                  ...draft,
                  values: draft.values.map((entry, i) =>
                    i === index ? renameMcpNamedValueDraft(entry, event.target.value) : entry,
                  ),
                })
              }
            />
            <Input
              aria-label={`Value ${index + 1}`}
              type={row.sensitive ? "password" : "text"}
              autoComplete="off"
              value={row.value}
              disabled={disabled}
              placeholder={mcpNamedValuePlaceholder(row)}
              onChange={(event) =>
                onChange({
                  ...draft,
                  values: draft.values.map((entry, i) =>
                    i === index ? changeMcpNamedValueDraft(entry, event.target.value) : entry,
                  ),
                })
              }
            />
            <label className="flex items-center gap-1 text-xs">
              <Checkbox
                checked={row.sensitive}
                disabled={disabled || row.valueRedacted}
                onCheckedChange={(checked) =>
                  onChange({
                    ...draft,
                    values: draft.values.map((entry, i) =>
                      i === index ? { ...entry, sensitive: checked } : entry,
                    ),
                  })
                }
              />
              Secret
            </label>
            <Button
              aria-label={`Remove value ${index + 1}`}
              size="xs"
              variant="ghost"
              disabled={disabled}
              onClick={() =>
                onChange({ ...draft, values: draft.values.filter((_, i) => i !== index) })
              }
            >
              Remove
            </Button>
          </div>
        ))}
      </div>
      {draft.type === "http" ? (
        <>
          <label className="flex items-center gap-2 text-sm">
            <Checkbox
              checked={draft.oauth}
              disabled={disabled}
              onCheckedChange={(oauth) => onChange({ ...draft, oauth })}
            />
            OAuth sign-in
          </label>
          {draft.oauth ? (
            <div className="grid gap-3 sm:grid-cols-2">
              {field("scope", "Scopes, optional")}
              {field("clientId", "Client ID, optional")}
              {draft.clientId.trim() ? (
                <div className="grid gap-1 text-xs sm:col-span-2">
                  <p>Register this redirect URL with your OAuth client.</p>
                  {oauthRedirectUrl ? (
                    <p className="break-all font-mono">{oauthRedirectUrl}</p>
                  ) : (
                    <p>Enter a server ID and connect this environment to see its redirect URL.</p>
                  )}
                </div>
              ) : null}
              <label className="grid gap-1 text-sm">
                Client secret, optional
                <Input
                  type="password"
                  autoComplete="off"
                  value={draft.clientSecret?.value ?? ""}
                  placeholder={
                    draft.clientSecret?.valueRedacted
                      ? "Stored secret, leave to keep"
                      : "Client secret"
                  }
                  disabled={disabled}
                  onChange={(event) =>
                    onChange(changeMcpClientSecretDraft(draft, event.target.value))
                  }
                />
              </label>
              {draft.clientSecretStored ? (
                <Button
                  size="xs"
                  variant="ghost"
                  disabled={disabled}
                  onClick={() =>
                    onChange({ ...draft, clientSecret: undefined, clientSecretStored: false })
                  }
                >
                  Remove stored client secret
                </Button>
              ) : null}
            </div>
          ) : null}
        </>
      ) : null}
      <div className="grid gap-2">
        <div className="flex items-center justify-between">
          <span className="text-sm">Providers</span>
          <Button
            size="xs"
            variant="ghost"
            disabled={disabled}
            onClick={() =>
              onChange({
                ...draft,
                providerInstanceIds: providers
                  .filter((provider) => provider.supported)
                  .map((provider) => provider.instanceId),
              })
            }
          >
            Select all supported
          </Button>
        </div>
        <div className="flex flex-wrap gap-4">
          {providers.map((provider) => (
            <label key={provider.instanceId} className="flex items-center gap-2 text-sm">
              <Checkbox
                checked={draft.providerInstanceIds.includes(provider.instanceId)}
                disabled={
                  disabled ||
                  (!provider.supported && !draft.providerInstanceIds.includes(provider.instanceId))
                }
                onCheckedChange={() => onChange(toggleMcpDraftProvider(draft, provider.instanceId))}
              />
              {provider.name}
              {!provider.supported ? " · unsupported" : ""}
            </label>
          ))}
        </div>
      </div>
      <div className="flex justify-end">
        <Button type="submit" size="sm" disabled={disabled}>
          Save MCP
        </Button>
      </div>
    </form>
  );
}
