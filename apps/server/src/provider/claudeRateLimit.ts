import type { ServerProviderRateLimit, ServerProviderRateLimitWindow } from "@t3tools/contracts";
import type { SDKControlGetUsageResponse } from "@anthropic-ai/claude-agent-sdk";

type ClaudeRateLimits = NonNullable<SDKControlGetUsageResponse["rate_limits"]>;
type ClaudeRateLimitWindow = NonNullable<ClaudeRateLimits["five_hour"]>;

function resetEpochSeconds(resetsAt: string | null): number | undefined {
  if (resetsAt === null) return undefined;
  const timestamp = Date.parse(resetsAt);
  return Number.isFinite(timestamp) && timestamp >= 0 ? Math.floor(timestamp / 1_000) : undefined;
}

function mapWindow(
  window: ClaudeRateLimitWindow | null | undefined,
  label: string,
  windowDurationMins: number,
): ServerProviderRateLimitWindow | undefined {
  if (window?.utilization === null || window?.utilization === undefined) return undefined;
  const resetsAt = resetEpochSeconds(window.resets_at);
  return {
    label,
    usedPercent: window.utilization,
    windowDurationMins,
    ...(resetsAt === undefined ? {} : { resetsAt }),
  };
}

/** Map Claude's plan utilization into a provider-neutral quota snapshot. */
export function mapClaudeRateLimitSnapshot(
  usage: SDKControlGetUsageResponse,
): ServerProviderRateLimit | undefined {
  if (!usage.rate_limits_available || usage.rate_limits === null) return undefined;

  const primary = mapWindow(usage.rate_limits.five_hour, "5-hour", 300);
  const weekly = [
    mapWindow(usage.rate_limits.seven_day, "Weekly", 10_080),
    mapWindow(usage.rate_limits.seven_day_oauth_apps, "OAuth apps weekly", 10_080),
    mapWindow(usage.rate_limits.seven_day_opus, "Opus weekly", 10_080),
    mapWindow(usage.rate_limits.seven_day_sonnet, "Sonnet weekly", 10_080),
    ...(usage.rate_limits.model_scoped ?? []).map((window) =>
      mapWindow(window, `${window.display_name} weekly`, 10_080),
    ),
  ]
    .filter((window) => window !== undefined)
    .toSorted((left, right) => right.usedPercent - left.usedPercent)[0];
  const windows = [primary, weekly].filter((window) => window !== undefined);

  if (windows.length === 0) return undefined;
  return {
    isFull: windows.some((window) => window.usedPercent >= 100),
    windows,
  };
}
