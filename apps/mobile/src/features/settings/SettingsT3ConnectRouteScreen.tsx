import type { RelayClientEnvironmentRecord } from "@t3tools/contracts/relay";
import { useAuth } from "@clerk/expo";
import { StackActions, useNavigation } from "@react-navigation/native";
import { useLayoutEffect } from "react";
import { Platform, RefreshControl, ScrollView, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { AndroidScreenHeader } from "../../components/AndroidScreenHeader";
import { AppText as Text } from "../../components/AppText";
import { NativeStackScreenOptions } from "../../native/StackHeader";
import { useManagedRelayEnvironments } from "../cloud/managedRelayState";
import { hasCloudPublicConfig } from "../cloud/publicConfig";

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

  useLayoutEffect(() => {
    if (hasCloudPublicConfig()) return;

    if (navigation.canGoBack()) {
      navigation.goBack();
    } else {
      navigation.dispatch(StackActions.replace("Settings"));
    }
  }, [navigation]);

  return hasCloudPublicConfig() ? <ConfiguredSettingsT3ConnectRouteScreen /> : null;
}

function ConfiguredSettingsT3ConnectRouteScreen() {
  const { isLoaded: isAuthLoaded, isSignedIn } = useAuth({ treatPendingAsSignedOut: false });
  const navigation = useNavigation();
  const insets = useSafeAreaInsets();
  const environmentsState = useManagedRelayEnvironments();
  const environments = environmentsState.data ?? [];
  const isSignedOut = isAuthLoaded && !isSignedIn;
  const isAccountLoading = !isSignedOut && environmentsState.accountId === null;
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
        ) : null}

        {isSignedOut ? (
          <Text className="border-y border-border py-6 text-sm text-foreground-muted">
            Sign in to T3 Connect to view account environments.
          </Text>
        ) : isAccountLoading || isInitialLoad ? (
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
                <View className="min-w-0">
                  <Text className="text-base font-t3-medium text-foreground" numberOfLines={1}>
                    {environment.label}
                  </Text>
                  <Text className="mt-1 text-sm text-foreground-muted" numberOfLines={1}>
                    {linkedAtLabel(environment.linkedAt)} · {endpointLabel(environment)}
                  </Text>
                </View>
              </View>
            ))}
          </View>
        ) : environmentsState.error ? null : (
          <Text className="border-y border-border py-6 text-sm text-foreground-muted">
            No environments are registered to this T3 Connect account.
          </Text>
        )}
      </ScrollView>
    </View>
  );
}
