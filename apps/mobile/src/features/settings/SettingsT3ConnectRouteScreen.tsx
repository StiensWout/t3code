import { findErrorTraceId } from "@t3tools/client-runtime/errors";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import type { EnvironmentId } from "@t3tools/contracts";
import type { RelayClientEnvironmentRecord } from "@t3tools/contracts/relay";
import { useNavigation } from "@react-navigation/native";
import { useRef, useState } from "react";
import { Alert, Platform, Pressable, RefreshControl, ScrollView, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { AndroidScreenHeader } from "../../components/AndroidScreenHeader";
import { AppText as Text } from "../../components/AppText";
import { showConfirmDialog } from "../../components/ConfirmDialogHost";
import { copyTextWithHaptic } from "../../lib/copyTextWithHaptic";
import { NativeStackScreenOptions } from "../../native/StackHeader";
import {
  deregisterManagedRelayEnvironmentCommand,
  useManagedRelayEnvironments,
} from "../cloud/managedRelayState";
import { useAtomCommand } from "../../state/use-atom-command";

const linkedAtFormatter = new Intl.DateTimeFormat(undefined, { dateStyle: "medium" });

function linkedAtLabel(value: string): string {
  const linkedAt = new Date(value);
  return Number.isNaN(linkedAt.getTime())
    ? "Link date unavailable"
    : `Linked ${linkedAtFormatter.format(linkedAt)}`;
}

function endpointLabel(environment: RelayClientEnvironmentRecord): string {
  return environment.endpoint.providerKind === "cloudflare_tunnel"
    ? "Managed tunnel"
    : "Activity publishing only";
}

export function SettingsT3ConnectRouteScreen() {
  const navigation = useNavigation();
  const insets = useSafeAreaInsets();
  const environmentsState = useManagedRelayEnvironments();
  const deregisterEnvironment = useAtomCommand(deregisterManagedRelayEnvironmentCommand, {
    reportFailure: false,
  });
  const mutationPendingRef = useRef(false);
  const [deregisteringEnvironmentId, setDeregisteringEnvironmentId] =
    useState<EnvironmentId | null>(null);
  const [removedEnvironments, setRemovedEnvironments] = useState<{
    readonly accountId: string | null;
    readonly ids: ReadonlySet<EnvironmentId>;
  }>({ accountId: null, ids: new Set() });

  const deregister = async (environment: RelayClientEnvironmentRecord) => {
    const accountId = environmentsState.accountId;
    if (!accountId || mutationPendingRef.current) return;

    mutationPendingRef.current = true;
    setDeregisteringEnvironmentId(environment.environmentId);
    const result = await deregisterEnvironment({
      accountId,
      environmentId: environment.environmentId,
    });
    mutationPendingRef.current = false;
    setDeregisteringEnvironmentId(null);

    if (result._tag === "Success") {
      setRemovedEnvironments((current) => ({
        accountId,
        ids: new Set(current.accountId === accountId ? current.ids : []).add(
          environment.environmentId,
        ),
      }));
      environmentsState.refresh();
      Alert.alert(
        "Server deregistered",
        `${environment.label} no longer has T3 Connect access. A host space is now available.`,
      );
      return;
    }
    if (isAtomCommandInterrupted(result)) return;

    const cause = squashAtomCommandFailure(result);
    const message = cause instanceof Error ? cause.message : "Could not deregister the server.";
    const traceId = findErrorTraceId(cause);
    console.error("[t3-connect] Could not deregister environment", {
      environmentId: environment.environmentId,
      message,
      traceId,
      cause,
    });
    Alert.alert(
      "Could not deregister server",
      message,
      traceId
        ? [
            { text: "Dismiss", style: "cancel" },
            {
              text: "Copy trace ID",
              onPress: () => copyTextWithHaptic(traceId, { target: "trace ID" }),
            },
          ]
        : undefined,
    );
  };

  const confirmDeregister = (environment: RelayClientEnvironmentRecord) => {
    const title = `Deregister “${environment.label}”?`;
    const message =
      "This revokes this server’s T3 Connect access, removes any managed tunnel, and frees a host space. Local connections on your devices are not changed.";
    const onConfirm = () => void deregister(environment);
    if (Platform.OS === "ios") {
      Alert.alert(title, message, [
        { text: "Cancel", style: "cancel" },
        { text: "Deregister", style: "destructive", onPress: onConfirm },
      ]);
      return;
    }
    showConfirmDialog({
      title,
      message,
      confirmText: "Deregister",
      destructive: true,
      onConfirm,
    });
  };

  const removedEnvironmentIds =
    removedEnvironments.accountId === environmentsState.accountId
      ? removedEnvironments.ids
      : new Set<EnvironmentId>();
  const environments = (environmentsState.data ?? []).filter(
    (environment) => !removedEnvironmentIds.has(environment.environmentId),
  );
  const isInitialLoad =
    environmentsState.accountId !== null &&
    environmentsState.data === null &&
    !environmentsState.error;

  return (
    <View collapsable={false} className="flex-1 bg-sheet">
      {Platform.OS === "android" ? (
        <>
          <NativeStackScreenOptions options={{ headerShown: false }} />
          <AndroidScreenHeader title="T3 Connect" onBack={() => navigation.goBack()} />
        </>
      ) : null}
      <ScrollView
        contentInsetAdjustmentBehavior="automatic"
        showsVerticalScrollIndicator={false}
        className="flex-1"
        contentContainerClassName="px-5 pt-4"
        contentContainerStyle={{ paddingBottom: Math.max(insets.bottom, 18) + 18 }}
        refreshControl={
          environmentsState.accountId ? (
            <RefreshControl
              refreshing={environmentsState.isPending}
              onRefresh={environmentsState.refresh}
            />
          ) : undefined
        }
      >
        <View className="gap-1 pb-5">
          <Text className="text-lg font-t3-bold text-foreground">Account environments</Text>
          <Text className="text-sm leading-normal text-foreground-muted">
            Servers registered to your account. Connections on this device stay in Environments.
          </Text>
        </View>

        {environmentsState.error ? (
          <View className="border-y border-danger-border py-4">
            <Text className="text-base font-t3-medium text-danger-foreground">
              Could not load T3 Connect environments
            </Text>
            <Text className="mt-1 text-sm text-foreground-muted">{environmentsState.error}</Text>
          </View>
        ) : environmentsState.accountId === null ? (
          <Text className="border-y border-border py-6 text-sm text-foreground-muted">
            Sign in to T3 Connect to manage account environments.
          </Text>
        ) : isInitialLoad ? (
          <Text className="border-y border-border py-6 text-sm text-foreground-muted">
            Loading environments…
          </Text>
        ) : environments.length > 0 ? (
          <View>
            {environments.map((environment, index) => (
              <View
                key={environment.environmentId}
                className={index === 0 ? "py-4" : "border-t border-border py-4"}
              >
                <View className="flex-row items-center gap-4">
                  <View className="min-w-0 flex-1">
                    <Text className="text-base font-t3-medium text-foreground" numberOfLines={1}>
                      {environment.label}
                    </Text>
                    <Text className="mt-1 text-sm text-foreground-muted" numberOfLines={1}>
                      {linkedAtLabel(environment.linkedAt)} · {endpointLabel(environment)}
                    </Text>
                  </View>
                  <Pressable
                    accessibilityLabel={`Deregister ${environment.label}`}
                    accessibilityRole="button"
                    disabled={deregisteringEnvironmentId !== null}
                    className="px-2 py-2 disabled:opacity-40"
                    onPress={() => confirmDeregister(environment)}
                  >
                    <Text className="font-t3-medium text-danger-foreground">
                      {deregisteringEnvironmentId === environment.environmentId
                        ? "Deregistering…"
                        : "Deregister"}
                    </Text>
                  </Pressable>
                </View>
              </View>
            ))}
          </View>
        ) : (
          <Text className="border-y border-border py-6 text-sm text-foreground-muted">
            No environments are registered to this T3 Connect account.
          </Text>
        )}
      </ScrollView>
    </View>
  );
}
