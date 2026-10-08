import { useAtomValue } from "@effect/atom-react";
import { useNavigation, usePreventRemove } from "@react-navigation/native";
import { hasMcpManagementDraft } from "@t3tools/client-runtime/state/mcpManagementUiSession";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
  type AtomCommandResult,
} from "@t3tools/client-runtime/state/runtime";
import type { ProviderAuthResponse, ServerProvider } from "@t3tools/contracts";
import { useRef, useState } from "react";
import {
  Alert,
  Keyboard,
  Linking,
  Platform,
  Pressable,
  ScrollView,
  TextInput,
  View,
  type ScrollViewInstance,
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { McpManagementSection } from "./McpManagementSection";
import { AppText as Text } from "../../components/AppText";
import { ScreenScrollView } from "../../components/ScreenScrollView";
import { SegmentedControl } from "../../components/SegmentedControl";
import { useNativeColumnLayoutMetrics } from "../../native/native-layout-metrics";
import { useEnvironmentQuery } from "../../state/query";
import { appAtomRegistry } from "../../state/atom-registry";
import {
  mcpManagementUiSessions,
  useMcpManagementUiSessionsCleanup,
} from "../../state/mcpManagement";
import { NativeStackScreenOptions } from "../../native/StackHeader";
import { withNativeGlassHeaderItem } from "../layout/native-glass-header-items";
import { serverEnvironment } from "../../state/server";
import { useAtomCommand } from "../../state/use-atom-command";
import { SettingsActionRow } from "./components/SettingsActionRow";
import {
  AndroidSettingsEnvironmentFilter,
  SettingsEnvironmentFilterHeader,
} from "./components/SettingsEnvironmentFilterHeader";
import { SettingsScreen } from "./components/SettingsScreen";
import { SettingsSection } from "./components/SettingsSection";
import { useSettingsEnvironmentFilter, type SettingsTarget } from "./settings-environment-filter";

export function SettingsProviderAccountsRouteScreen() {
  useMcpManagementUiSessionsCleanup();
  const navigation = useNavigation();
  const sessions = useAtomValue(mcpManagementUiSessions.sessionsAtom);
  const updating = [...sessions.values()].some((session) => session.pending);
  const preventRemove = updating || [...sessions.values()].some(hasMcpManagementDraft);
  usePreventRemove(preventRemove, ({ data }) => {
    if (updating) {
      Alert.alert("Updating MCP settings", "Wait for the update to finish before leaving.");
      return;
    }
    Alert.alert("Discard changes?", "Your unsaved MCP changes will be lost.", [
      { text: "Keep editing", style: "cancel" },
      {
        text: "Discard changes",
        style: "destructive",
        onPress: () => {
          mcpManagementUiSessions.discardDrafts(appAtomRegistry);
          navigation.dispatch(data.action);
        },
      },
    ]);
  });
  const [view, setView] = useState<"accounts" | "mcps">("accounts");
  const { selectedTargets } = useSettingsEnvironmentFilter();
  const insets = useSafeAreaInsets();
  const nativeColumnMetrics = useNativeColumnLayoutMetrics();
  // UIKit's automatic header inset is absent from the JS scroll event's contentInset.
  const navigationTopInset =
    Platform.OS === "ios" ? (nativeColumnMetrics?.safeArea.top ?? insets.top) : 0;
  const scroll = useRef<ScrollViewInstance>(null);
  const environmentOffsets = useRef(new Map<string, number>());
  const pendingEnvironmentScroll = useRef<string | null>(null);
  return (
    <>
      <SettingsEnvironmentFilterHeader />
      <SettingsScreen title="Providers" trailing={<AndroidSettingsEnvironmentFilter />}>
        {Platform.OS === "ios" ? (
          <NativeStackScreenOptions
            options={{
              headerBackVisible: false,
              gestureEnabled: !preventRemove,
              unstable_headerLeftItems: () => [
                withNativeGlassHeaderItem({
                  type: "button",
                  label: "",
                  accessibilityLabel: "Back",
                  icon: { type: "sfSymbol", name: "chevron.backward" },
                  onPress: () => navigation.goBack(),
                }),
              ],
            }}
          />
        ) : null}
        <ScreenScrollView
          ref={scroll}
          className="flex-1"
          contentInsetAdjustmentBehavior="automatic"
          automaticallyAdjustKeyboardInsets
          keyboardDismissMode="on-drag"
          keyboardShouldPersistTaps="handled"
          onContentSizeChange={() => {
            const environmentId = pendingEnvironmentScroll.current;
            if (environmentId === null || !scroll.current) return;
            pendingEnvironmentScroll.current = null;
            if (!selectedTargets.some((target) => target.environmentId === environmentId)) return;
            // Wait for the replacement pane, and keep its heading below native navigation.
            scroll.current.scrollTo({
              y: Math.max(
                -navigationTopInset,
                (environmentOffsets.current.get(environmentId) ?? 0) - navigationTopInset - 8,
              ),
              animated: false,
            });
          }}
          contentContainerClassName="gap-6 px-5 pt-4"
          contentContainerStyle={{ paddingBottom: Math.max(insets.bottom, 18) + 18 }}
        >
          <SegmentedControl
            options={[
              { value: "accounts", label: "Accounts" },
              { value: "mcps", label: "MCPs" },
            ]}
            selected={view}
            role="tab"
            onSelect={(value) => {
              pendingEnvironmentScroll.current = null;
              Keyboard.dismiss();
              setView(value);
              scroll.current?.scrollTo({ y: -navigationTopInset, animated: false });
            }}
          />
          {selectedTargets.length === 0 ? (
            <Text className="text-foreground-muted">Select a connected environment.</Text>
          ) : (
            selectedTargets.map((environment) => (
              <View
                key={environment.environmentId}
                className="gap-2"
                onLayout={(event) =>
                  environmentOffsets.current.set(
                    environment.environmentId,
                    event.nativeEvent.layout.y,
                  )
                }
              >
                {view === "mcps" ? (
                  <>
                    <Text className="px-2 text-sm font-t3-medium text-foreground-muted">
                      {environment.label}
                    </Text>
                    <McpManagementSection
                      environmentId={environment.environmentId}
                      onNavigate={() => {
                        Keyboard.dismiss();
                        pendingEnvironmentScroll.current = environment.environmentId;
                      }}
                    />
                  </>
                ) : (
                  <SettingsSection title={environment.label}>
                    {environment.serverConfig.providers
                      .filter(
                        (provider) =>
                          provider.setup?.canAuthenticate ||
                          (provider.driver === "acpRegistry" && provider.installed),
                      )
                      .map((provider) => (
                        <ProviderAccount
                          key={provider.instanceId}
                          environment={environment}
                          provider={provider}
                        />
                      ))}
                    {!environment.serverConfig.providers.some(
                      (provider) =>
                        provider.setup?.canAuthenticate ||
                        (provider.driver === "acpRegistry" && provider.installed),
                    ) ? (
                      <Text className="p-4 text-foreground-muted">
                        Configure a provider with in-app sign-in in web or desktop Settings.
                      </Text>
                    ) : null}
                  </SettingsSection>
                )}
              </View>
            ))
          )}
        </ScreenScrollView>
      </SettingsScreen>
    </>
  );
}

function ProviderAccount({
  environment,
  provider,
}: {
  readonly environment: SettingsTarget;
  readonly provider: ServerProvider;
}) {
  const environmentId = environment.environmentId;
  const instanceId = provider.instanceId;
  const target = { environmentId, input: { instanceId } };
  const auth = useEnvironmentQuery(serverEnvironment.providerAuthState(target));
  const options = { reportFailure: false, reportDefect: false };
  const start = useAtomCommand(serverEnvironment.startProviderAuth, options);
  const respond = useAtomCommand(serverEnvironment.respondProviderAuth, options);
  const complete = useAtomCommand(serverEnvironment.completeProviderAuth, options);
  const cancel = useAtomCommand(serverEnvironment.cancelProviderAuth, options);
  const logout = useAtomCommand(serverEnvironment.logoutProviderAuth, options);
  const [pending, setPending] = useState(false);
  const [choosingMethod, setChoosingMethod] = useState(false);
  const pendingRef = useRef(false);
  const [error, setError] = useState<string | null>(null);
  const [draft, setDraft] = useState({ id: "", values: {} as Record<string, string> });
  const state = auth.data;
  const interaction = state?.interaction;
  const draftId = `${state?.flowId ?? ""}:${interaction?.id ?? ""}`;
  const values = draft.id === draftId ? draft.values : {};
  const active =
    state?.phase === "starting" || state?.phase === "waiting" || state?.phase === "verifying";
  const signedIn =
    provider.auth.status === "authenticated" ||
    (provider.auth.status === "unknown" && state?.phase === "succeeded");
  const isDiscovering =
    provider.driver === "acpRegistry" &&
    !active &&
    !signedIn &&
    !auth.error &&
    state?.methods === undefined;
  const needsExternalSetup =
    !active &&
    !signedIn &&
    (provider.setup?.canAuthenticate === false ||
      (provider.driver === "acpRegistry" && state?.methods?.length === 0));
  const url =
    interaction?.type === "browser" || interaction?.type === "deviceCode"
      ? interaction.url
      : state?.authorizationUrl;
  const disabled = pending || auth.error !== null || isDiscovering;
  async function run(command: () => Promise<AtomCommandResult<unknown, unknown>>) {
    if (pendingRef.current) return false;
    pendingRef.current = true;
    setPending(true);
    setError(null);
    let succeeded = false;
    try {
      const result = await command();
      if (result._tag === "Success") succeeded = true;
      else if (!isAtomCommandInterrupted(result)) {
        const failure = squashAtomCommandFailure(result);
        setError(failure instanceof Error ? failure.message : "Could not update provider sign-in.");
      }
    } catch {
      setError("Could not update provider sign-in.");
    }
    pendingRef.current = false;
    setPending(false);
    return succeeded;
  }
  function send(response: ProviderAuthResponse) {
    if (!state?.flowId || !interaction) return Promise.resolve(false);
    return run(() =>
      respond({
        environmentId,
        input: { instanceId, flowId: state.flowId!, interactionId: interaction.id, response },
      }),
    );
  }
  function field(name: string, label: string, secret: boolean) {
    return (
      <TextInput
        accessibilityLabel={label}
        className="rounded-lg border border-border-subtle px-3 py-2 text-base text-foreground"
        placeholderTextColorClassName="accent-foreground-muted"
        placeholder={label}
        secureTextEntry={secret}
        autoCapitalize="none"
        autoCorrect={false}
        editable={!disabled}
        maxLength={secret && interaction?.type === "terminal" ? 4_095 : 16_384}
        value={values[name] ?? ""}
        onChangeText={(value) => setDraft({ id: draftId, values: { ...values, [name]: value } })}
      />
    );
  }
  function chooseMethod() {
    const methods = state?.methods ?? [];
    if (methods.length <= 1) {
      void run(() => start(target));
      return;
    }
    setChoosingMethod(true);
  }
  return (
    <View className="border-b border-border-subtle">
      <View className="gap-2 p-4">
        <Text className="text-lg font-semibold text-foreground">
          {provider.displayName ?? provider.driver}
        </Text>
        <Text accessibilityLiveRegion="polite" className="text-sm text-foreground-muted">
          {active || state?.phase === "failed" || state?.phase === "cancelled"
            ? state.message
            : signedIn
              ? "Signed in."
              : isDiscovering
                ? "Discovering sign-in methods…"
                : needsExternalSetup
                  ? "No in-app sign-in advertised. Follow the provider's docs to finish setup."
                  : "Connect this provider."}
        </Text>
        {signedIn && !active && provider.auth.email?.trim() ? (
          <ProviderAccountEmail key={provider.auth.email} email={provider.auth.email} />
        ) : null}
        {interaction?.type === "deviceCode" ? (
          <Text selectable className="text-foreground">
            Enter code {interaction.userCode} on the sign-in page.
          </Text>
        ) : null}
        {interaction?.type === "terminal" ? (
          <>
            <ScrollView className="max-h-64" nestedScrollEnabled>
              <Text selectable className="font-mono text-sm text-foreground">
                {interaction.output.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "")}
              </Text>
            </ScrollView>
            {field("input", "Terminal response", true)}
            <SettingsActionRow
              icon="arrow.up"
              label="Send response"
              disabled={disabled}
              onPress={() => {
                void send({ type: "terminal", data: `${values.input ?? ""}\r` }).then((sent) => {
                  if (sent) setDraft({ id: "", values: {} });
                });
              }}
            />
          </>
        ) : null}
        {interaction?.type === "credentials" ? (
          <>
            {interaction.fields.map((entry) => (
              <View key={entry.name}>{field(entry.name, entry.label, entry.secret)}</View>
            ))}
            <SettingsActionRow
              icon="person.crop.circle"
              label="Connect"
              disabled={disabled}
              onPress={() => {
                void send({ type: "credentials", values }).then((sent) => {
                  if (sent) setDraft({ id: "", values: {} });
                });
              }}
            />
          </>
        ) : null}
        {url && (interaction?.type === "browser" ? interaction.acceptsCallback : !interaction) ? (
          <>
            {field("callback", "Final localhost URL", false)}
            <SettingsActionRow
              icon="arrow.right"
              label="Continue"
              disabled={disabled || !values.callback?.trim()}
              onPress={() => {
                if (!state?.flowId) return;
                void run(() =>
                  complete({
                    environmentId,
                    input: { instanceId, flowId: state.flowId!, callbackUrl: values.callback! },
                  }),
                ).then((sent) => {
                  if (sent) setDraft({ id: "", values: {} });
                });
              }}
            />
          </>
        ) : null}
        {error || auth.error ? (
          <Text accessibilityRole="alert" className="text-danger-foreground">
            {error ?? auth.error}
          </Text>
        ) : null}
      </View>
      {choosingMethod && !active ? (
        <View>
          {state?.methods?.map((method) => (
            <SettingsActionRow
              key={method.id}
              icon="person.crop.circle"
              label={method.name}
              disabled={disabled}
              onPress={() => {
                setChoosingMethod(false);
                void run(() =>
                  start({ environmentId, input: { instanceId, methodId: method.id } }),
                );
              }}
            />
          ))}
          <SettingsActionRow icon="xmark" label="Cancel" onPress={() => setChoosingMethod(false)} />
        </View>
      ) : null}
      {url ? (
        <SettingsActionRow
          icon="globe"
          label="Open sign-in page"
          disabled={disabled}
          onPress={() => {
            void (async () => {
              if (
                interaction?.type === "browser" &&
                interaction.requiresConsent &&
                !(await send({ type: "browser", action: "accept" }))
              )
                return;
              await Linking.openURL(url);
            })().catch(() => setError("Could not open the sign-in page."));
          }}
        />
      ) : null}
      {needsExternalSetup && provider.setup?.documentationUrl ? (
        <SettingsActionRow
          icon="globe"
          label="Open docs"
          onPress={() => {
            void Linking.openURL(provider.setup!.documentationUrl!).catch(() =>
              setError("Could not open the provider docs."),
            );
          }}
        />
      ) : active && state?.flowId ? (
        <SettingsActionRow
          icon="xmark"
          label="Cancel sign-in"
          disabled={disabled}
          onPress={() => {
            void run(() => cancel({ environmentId, input: { instanceId, flowId: state.flowId! } }));
          }}
        />
      ) : !active && !needsExternalSetup && provider.setup?.canAuthenticate !== false ? (
        <SettingsActionRow
          icon="person.crop.circle"
          label={signedIn ? "Change account" : "Sign in"}
          disabled={disabled || !provider.enabled || !provider.installed || state === null}
          loading={pending}
          onPress={chooseMethod}
        />
      ) : null}
      {!active && signedIn && (provider.auth.canLogout ?? provider.setup?.canAuthenticate) ? (
        <SettingsActionRow
          icon="person.crop.circle"
          label="Sign out"
          tone="danger"
          disabled={disabled || state === null}
          onPress={() =>
            Alert.alert(
              "Sign out?",
              `Running threads sharing this sign-in on ${environment.label} will stop. Thread history is kept.`,
              [
                { text: "Cancel", style: "cancel" },
                {
                  text: "Sign out",
                  style: "destructive",
                  onPress: () => {
                    void run(() => logout(target));
                  },
                },
              ],
            )
          }
        />
      ) : null}
    </View>
  );
}

function ProviderAccountEmail({ email }: { readonly email: string }) {
  const [revealed, setRevealed] = useState(false);
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={revealed ? "Hide account email" : "Reveal account email"}
      onPress={() => setRevealed((value) => !value)}
      className="min-h-[44px] justify-center"
    >
      <Text className="text-sm text-foreground-muted">{revealed ? email : "••••••@••••••"}</Text>
    </Pressable>
  );
}
