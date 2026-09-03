import { elapsedShare, formatDuration, paceOf, resetMillis } from "@t3tools/shared/usageLimits";
import { View } from "react-native";

import { AppText as Text } from "../../components/AppText";
import type { EnvironmentProviderLimits } from "../../state/usage";
import { SettingsSection } from "../settings/components/SettingsSection";
import { PROVIDER_LABEL, useProviderColors } from "./usageProviders";

type LimitWindow = EnvironmentProviderLimits["windows"][number];

const PACE_LABEL = { ahead: "ahead of pace", on: "on pace", under: "under pace" } as const;

function paceLabel(window: LimitWindow, now: number): string | null {
  const pace = paceOf(window, now);
  return pace === null ? null : PACE_LABEL[pace];
}

/**
 * One window as a full-width bar from the moment it opened to its reset.
 * Usage fills from the left; the hairline sits at the elapsed fraction, which
 * is also where even spending would have put the fill.
 */
function WindowBar({
  window,
  now,
  color,
}: {
  readonly window: LimitWindow;
  readonly now: number;
  readonly color: string;
}) {
  const elapsed = elapsedShare(window, now);
  const used = Math.max(0, Math.min(100, window.usedPercent)) / 100;
  return (
    <View className="h-4 justify-center">
      <View className="h-2 flex-row overflow-hidden rounded-full bg-subtle">
        <View className="h-full rounded-full" style={{ flex: used, backgroundColor: color }} />
        <View style={{ flex: 1 - used }} />
      </View>
      {elapsed !== null ? (
        <View
          className="absolute top-0 bottom-0 w-px bg-foreground"
          style={{ left: `${elapsed * 100}%`, opacity: 0.6 }}
        />
      ) : null}
    </View>
  );
}

/**
 * Limits card: one block per provider with a bar per window in use, the pace
 * against the clock, and the reset countdown. Unused windows have nothing to
 * show and stay out.
 */
export function UsageLimitsSection(props: {
  readonly providers: readonly EnvironmentProviderLimits[];
  readonly failedEnvironments: readonly string[];
  readonly pendingEnvironments: readonly string[];
  readonly now: number;
  readonly isPending: boolean;
}) {
  const { providers, failedEnvironments, pendingEnvironments, now, isPending } = props;
  const colors = useProviderColors();
  const environmentCount = new Set(providers.map((entry) => entry.environmentId)).size;
  const instanceCounts = new Map<string, number>();
  for (const entry of providers) {
    const key = `${entry.environmentId}:${entry.provider}`;
    instanceCounts.set(key, (instanceCounts.get(key) ?? 0) + 1);
  }

  return (
    <SettingsSection title="Limits" card>
      {failedEnvironments.map((label) => (
        <Text key={label} className="p-4 text-sm text-foreground-muted">
          {label} could not report limits.
        </Text>
      ))}
      {providers.length > 0
        ? pendingEnvironments.map((label) => (
            <Text key={label} className="p-4 text-sm text-foreground-muted">
              {label} is still reading its limits.
            </Text>
          ))
        : null}
      {providers.length === 0 && failedEnvironments.length === 0 ? (
        <Text className="p-4 text-sm text-foreground-muted">
          {isPending ? "Reading limits…" : "No limits reported yet."}
        </Text>
      ) : null}
      {providers.map((entry, index) => {
        const qualifier = [
          environmentCount > 1 ? entry.environmentLabel : null,
          (instanceCounts.get(`${entry.environmentId}:${entry.provider}`) ?? 0) > 1
            ? (entry.instanceLabel ?? entry.instanceId)
            : null,
        ]
          .filter(Boolean)
          .join(" · ");
        const windows = entry.windows.filter((window) => window.usedPercent > 0);
        return (
          <View
            key={`${entry.environmentId}:${entry.provider}:${entry.instanceId}`}
            className={index === 0 ? "gap-3 p-4" : "gap-3 border-t border-border-subtle p-4"}
          >
            <View className="flex-row flex-wrap items-baseline gap-x-2 gap-y-0.5">
              <View
                className="size-2.5 self-center rounded-full"
                style={{ backgroundColor: colors[entry.provider] }}
              />
              <Text className="shrink text-lg text-foreground" numberOfLines={1}>
                {PROVIDER_LABEL[entry.provider]}
              </Text>
              {qualifier ? (
                <Text className="shrink text-sm text-foreground-muted" numberOfLines={1}>
                  {qualifier}
                </Text>
              ) : null}
              {entry.plan ? (
                <Text className="text-sm text-foreground-muted">· {entry.plan}</Text>
              ) : null}
            </View>
            {entry.readError ? (
              <Text className="text-xs text-foreground-muted">
                Could not read limits.
                {entry.windows.length > 0
                  ? ` Showing the last report from ${formatDuration(now - Date.parse(entry.observedAt))} ago.`
                  : ""}
              </Text>
            ) : null}
            {windows.length === 0 ? (
              <Text className="text-sm text-foreground-muted">No usage in any window.</Text>
            ) : (
              windows.map((window) => {
                const resetsAt = resetMillis(window);
                const pace = paceLabel(window, now);
                return (
                  <View key={window.id} className="gap-1.5">
                    <View className="flex-row items-baseline justify-between gap-3">
                      <Text className="text-sm text-foreground-muted">{window.label}</Text>
                      <Text className="text-sm tabular-nums text-foreground">
                        {Math.round(window.usedPercent)}%
                      </Text>
                    </View>
                    <WindowBar window={window} now={now} color={colors[entry.provider]} />
                    <Text className="text-xs tabular-nums text-foreground-muted">
                      {[
                        pace,
                        resetsAt === null ? null : `resets in ${formatDuration(resetsAt - now)}`,
                      ]
                        .filter(Boolean)
                        .join(" · ")}
                    </Text>
                  </View>
                );
              })
            )}
            {entry.resetCredits && entry.resetCredits.availableCount > 0 ? (
              <Text className="text-xs tabular-nums text-foreground-muted">
                {entry.resetCredits.availableCount}{" "}
                {entry.resetCredits.availableCount === 1 ? "reset" : "resets"} banked
              </Text>
            ) : null}
          </View>
        );
      })}
    </SettingsSection>
  );
}
