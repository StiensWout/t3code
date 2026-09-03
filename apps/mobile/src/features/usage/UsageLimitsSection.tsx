import { View } from "react-native";

import { AppText as Text } from "../../components/AppText";
import type { EnvironmentProviderLimits } from "../../state/usage";
import { SettingsSection } from "../settings/components/SettingsSection";
import { PROVIDER_LABEL, useProviderColors } from "./usageProviders";

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;

/** `2h 13m`, `3d 4h`, `12m`. */
function formatDuration(ms: number): string {
  const remaining = Math.max(0, ms);
  const days = Math.floor(remaining / DAY);
  const hours = Math.floor((remaining % DAY) / HOUR);
  const minutes = Math.floor((remaining % HOUR) / 60000);
  if (days > 0) return `${days}d ${hours}h`;
  if (hours > 0) return `${hours}h ${minutes}m`;
  return `${minutes}m`;
}

type LimitWindow = EnvironmentProviderLimits["windows"][number];

function resetMillis(window: LimitWindow): number | null {
  if (window.resetsAt === null) return null;
  const at = Date.parse(window.resetsAt);
  return Number.isFinite(at) ? at : null;
}

/** Elapsed share of the window, 0..1, or null when the window has no known length. */
function elapsedShare(window: LimitWindow, now: number): number | null {
  const resetsAt = resetMillis(window);
  if (resetsAt === null || window.windowMinutes === null) return null;
  const length = window.windowMinutes * 60000;
  return Math.max(0, Math.min(1, (length - (resetsAt - now)) / length));
}

/** Usage against the clock: within five points is on pace. */
function paceLabel(window: LimitWindow, now: number): string | null {
  const elapsed = elapsedShare(window, now);
  if (elapsed === null) return null;
  const gap = window.usedPercent - elapsed * 100;
  if (gap > 5) return "ahead of pace";
  if (gap < -5) return "under pace";
  return "on pace";
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
  readonly now: number;
  readonly isPending: boolean;
}) {
  const { providers, failedEnvironments, now, isPending } = props;
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
            <View className="flex-row items-baseline gap-2">
              <View
                className="size-2.5 self-center rounded-full"
                style={{ backgroundColor: colors[entry.provider] }}
              />
              <Text className="text-lg text-foreground">{PROVIDER_LABEL[entry.provider]}</Text>
              {qualifier ? (
                <Text className="text-sm text-foreground-muted">{qualifier}</Text>
              ) : null}
              {entry.plan ? (
                <Text className="text-sm text-foreground-muted">· {entry.plan}</Text>
              ) : null}
            </View>
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
