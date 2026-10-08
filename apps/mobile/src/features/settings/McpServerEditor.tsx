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
import { useRef, useState } from "react";
import { Keyboard, View, type TextInputInstance } from "react-native";
import { AppText as Text, AppTextInput } from "../../components/AppText";
import { SettingsActionRow } from "./components/SettingsActionRow";
import { SettingsChoiceRow } from "./components/SettingsChoiceRow";
import { SettingsRow } from "./components/SettingsRow";
import { SettingsSection } from "./components/SettingsSection";
import { SettingsSwitchRow } from "./components/SettingsSwitchRow";

/** Native form input with a keyboard exit that preserves multiline arguments. */
export function McpField({
  label,
  value,
  disabled = false,
  secret = false,
  multiline = false,
  placeholder,
  onChange,
}: {
  readonly label: string;
  readonly value: string;
  readonly disabled?: boolean;
  readonly secret?: boolean;
  readonly multiline?: boolean;
  readonly placeholder?: string;
  readonly onChange: (value: string) => void;
}) {
  const input = useRef<TextInputInstance>(null);
  const [focused, setFocused] = useState(false);
  function dismiss() {
    input.current?.blur();
    Keyboard.dismiss();
  }
  return (
    <View>
      <View className="gap-2 px-4 py-3">
        <Text className="text-sm text-foreground-muted">{label}</Text>
        <AppTextInput
          ref={input}
          accessibilityLabel={label}
          autoCapitalize="none"
          autoCorrect={false}
          secureTextEntry={secret}
          multiline={multiline}
          numberOfLines={multiline ? 4 : 1}
          textAlignVertical={multiline ? "top" : "center"}
          returnKeyType={multiline ? "default" : "done"}
          submitBehavior={multiline ? "newline" : "blurAndSubmit"}
          onSubmitEditing={multiline ? undefined : dismiss}
          onFocus={() => setFocused(true)}
          onBlur={() => setFocused(false)}
          editable={!disabled}
          value={value}
          placeholder={placeholder}
          onChangeText={onChange}
        />
      </View>
      {multiline && focused ? (
        <SettingsActionRow icon="checkmark" label="Done editing" onPress={dismiss} />
      ) : null}
    </View>
  );
}

export function McpServerEditor({
  draft,
  onChange,
  providers,
  editing,
  advanced,
  onAdvancedChange,
  clientSettings,
  onClientSettingsChange,
  oauthRedirectUrl,
  disabled,
  onSave,
  onCancel,
}: {
  readonly draft: McpServerDraft;
  readonly onChange: (draft: McpServerDraft) => void;
  readonly providers: McpManagementSnapshot["providers"];
  readonly editing: boolean;
  readonly advanced: boolean;
  readonly onAdvancedChange: (advanced: boolean) => void;
  readonly clientSettings: boolean;
  readonly onClientSettingsChange: (expanded: boolean) => void;
  readonly oauthRedirectUrl: string | null;
  readonly disabled: boolean;
  readonly onSave: () => void;
  readonly onCancel: () => void;
}) {
  function field(
    key: "id" | "name" | "command" | "args" | "cwd" | "url" | "scope" | "clientId",
    label: string,
  ) {
    return (
      <McpField
        label={label}
        value={draft[key]}
        disabled={disabled || (key === "id" && editing)}
        multiline={key === "args"}
        onChange={(value) => onChange({ ...draft, [key]: value })}
      />
    );
  }
  return (
    <View className="gap-6">
      <Text className="px-2 text-lg font-t3-medium text-foreground">
        {editing ? "Edit MCP" : "Add MCP"}
      </Text>
      <SettingsSection>
        <SettingsActionRow
          icon="checkmark"
          label="Save MCP"
          disabled={disabled}
          onPress={() => {
            Keyboard.dismiss();
            onSave();
          }}
        />
        <SettingsActionRow
          icon="xmark"
          label="Cancel"
          onPress={() => {
            Keyboard.dismiss();
            onCancel();
          }}
        />
      </SettingsSection>
      <SettingsSection>
        {field("name", "Name")}
        {field("id", "Server ID")}
        {draft.type === "stdio" ? field("command", "Command") : field("url", "Server URL")}
        {draft.type === "stdio" ? field("args", "Arguments, one per line") : null}
      </SettingsSection>
      <SettingsSection title="Transport">
        {(["stdio", "http"] as const).map((type, index) => (
          <SettingsChoiceRow
            key={type}
            label={type === "http" ? "HTTP" : "stdio"}
            description={
              type === "http" ? "Connect to a server URL" : "Run a command in this environment"
            }
            selected={draft.type === type}
            separated={index > 0}
            disabled={disabled}
            onPress={() => {
              if (draft.type !== type) onChange(changeMcpDraftTransport(draft, type));
            }}
          />
        ))}
      </SettingsSection>
      {draft.type === "http" ? (
        <SettingsSection>
          <SettingsSwitchRow
            icon="person.crop.circle"
            label="OAuth sign-in"
            value={draft.oauth}
            disabled={disabled}
            onValueChange={(oauth) => onChange({ ...draft, oauth })}
          />
          {draft.oauth ? (
            <>
              <SettingsRow
                icon="slider.horizontal.3"
                label="Client settings"
                value={clientSettings ? "Hide" : "Optional"}
                onPress={() => onClientSettingsChange(!clientSettings)}
              />
              {clientSettings ? (
                <>
                  {field("scope", "Scopes, optional")}
                  {field("clientId", "Client ID, optional")}
                  {draft.clientId.trim() ? (
                    <View className="gap-2 px-4 py-3">
                      <Text className="text-sm text-foreground-muted">
                        Register this redirect URL with your OAuth client.
                      </Text>
                      <Text selectable className="text-sm text-foreground">
                        {oauthRedirectUrl ??
                          "Enter a server ID and connect this environment to see its redirect URL."}
                      </Text>
                    </View>
                  ) : null}
                  <McpField
                    label="Client secret, optional"
                    value={draft.clientSecret?.value ?? ""}
                    secret
                    disabled={disabled}
                    placeholder={
                      draft.clientSecret?.valueRedacted
                        ? "Stored secret, leave to keep"
                        : "Client secret"
                    }
                    onChange={(value) => onChange(changeMcpClientSecretDraft(draft, value))}
                  />
                  {draft.clientSecretStored ? (
                    <SettingsActionRow
                      icon="trash"
                      label="Remove stored client secret"
                      tone="danger"
                      disabled={disabled}
                      onPress={() =>
                        onChange({ ...draft, clientSecret: undefined, clientSecretStored: false })
                      }
                    />
                  ) : null}
                </>
              ) : null}
            </>
          ) : null}
        </SettingsSection>
      ) : null}
      <SettingsSection title="Providers">
        <SettingsActionRow
          icon="checkmark"
          label="Select all supported"
          disabled={disabled}
          onPress={() =>
            onChange({
              ...draft,
              providerInstanceIds: providers
                .filter((provider) => provider.supported)
                .map((provider) => provider.instanceId),
            })
          }
        />
        {providers.map((provider) => (
          <SettingsSwitchRow
            key={provider.instanceId}
            icon="server.rack"
            label={provider.name}
            subtitle={provider.supported ? undefined : (provider.reason ?? "Unsupported")}
            value={draft.providerInstanceIds.includes(provider.instanceId)}
            disabled={
              disabled ||
              (!provider.supported && !draft.providerInstanceIds.includes(provider.instanceId))
            }
            onValueChange={() => onChange(toggleMcpDraftProvider(draft, provider.instanceId))}
          />
        ))}
      </SettingsSection>
      <SettingsSection>
        <SettingsRow
          icon="slider.horizontal.3"
          label={draft.type === "stdio" ? "Environment & advanced" : "Headers & advanced"}
          value={
            advanced
              ? "Hide"
              : `${draft.values.length} ${draft.type === "stdio" ? "variables" : "headers"}`
          }
          onPress={() => onAdvancedChange(!advanced)}
        />
        {advanced && draft.type === "stdio" ? field("cwd", "Working directory, optional") : null}
      </SettingsSection>
      {advanced ? (
        <View className="gap-6">
          {draft.values.map((row, index) => (
            <SettingsSection
              key={row.draftId}
              title={`${draft.type === "stdio" ? "Variable" : "Header"} ${index + 1}`}
            >
              <McpField
                label="Name"
                value={row.key}
                disabled={disabled}
                onChange={(key) =>
                  onChange({
                    ...draft,
                    values: draft.values.map((entry) =>
                      entry.draftId === row.draftId ? renameMcpNamedValueDraft(entry, key) : entry,
                    ),
                  })
                }
              />
              <McpField
                label="Value"
                value={row.value}
                secret={row.sensitive}
                disabled={disabled}
                placeholder={mcpNamedValuePlaceholder(row)}
                onChange={(value) =>
                  onChange({
                    ...draft,
                    values: draft.values.map((entry) =>
                      entry.draftId === row.draftId
                        ? changeMcpNamedValueDraft(entry, value)
                        : entry,
                    ),
                  })
                }
              />
              <SettingsSwitchRow
                icon="eye"
                label="Secret"
                value={row.sensitive}
                disabled={disabled || Boolean(row.valueRedacted)}
                onValueChange={(sensitive) =>
                  onChange({
                    ...draft,
                    values: draft.values.map((entry) =>
                      entry.draftId === row.draftId ? { ...entry, sensitive } : entry,
                    ),
                  })
                }
              />
              <SettingsActionRow
                icon="trash"
                label={draft.type === "stdio" ? "Remove variable" : "Remove header"}
                tone="danger"
                disabled={disabled}
                onPress={() =>
                  onChange({
                    ...draft,
                    values: draft.values.filter((entry) => entry.draftId !== row.draftId),
                  })
                }
              />
            </SettingsSection>
          ))}
          <SettingsSection>
            <SettingsActionRow
              icon="plus"
              label={draft.type === "stdio" ? "Add variable" : "Add header"}
              disabled={disabled}
              onPress={() =>
                onChange({ ...draft, values: [...draft.values, createMcpNamedValueDraft()] })
              }
            />
          </SettingsSection>
        </View>
      ) : null}
    </View>
  );
}
