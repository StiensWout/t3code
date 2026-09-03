/**
 * Normalises one Claude Code `rate_limit_event` into a sparse usage limits
 * update. The SDK reports a single window per event, so callers merge by id.
 * Only claude.ai subscriptions emit these; API key sessions never do.
 *
 * @module provider/Layers/claudeRateLimits
 */
import type { UsageLimitsUpdate } from "@t3tools/contracts";

import { epochToIso } from "./codexRateLimits.ts";

export interface ClaudeRateLimitInfo {
  readonly status: "allowed" | "allowed_warning" | "rejected";
  readonly resetsAt?: number;
  readonly rateLimitType?: string;
  /** Fraction of the window used, 0..1, as the unified rate-limit headers report it. */
  readonly utilization?: number;
}

const WINDOWS: Record<string, { readonly label: string; readonly windowMinutes: number | null }> = {
  five_hour: { label: "5 hour", windowMinutes: 300 },
  seven_day: { label: "Weekly", windowMinutes: 10080 },
  seven_day_opus: { label: "Weekly Opus", windowMinutes: 10080 },
  seven_day_sonnet: { label: "Weekly Sonnet", windowMinutes: 10080 },
  overage: { label: "Extra usage", windowMinutes: null },
};

/** `seven_day_fable` → `Weekly Fable`, matching the ids the on-demand read produces. */
function scopedWeekly(
  type: string,
): { readonly label: string; readonly windowMinutes: number } | null {
  const scope = type.startsWith("seven_day_") ? type.slice("seven_day_".length) : "";
  if (scope.length === 0) return null;
  const name = scope
    .split("_")
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
  return { label: `Weekly ${name}`, windowMinutes: 10080 };
}

export function normalizeClaudeRateLimit(info: ClaudeRateLimitInfo): UsageLimitsUpdate | null {
  if (info.rateLimitType === undefined) return null;
  const kind = WINDOWS[info.rateLimitType] ?? scopedWeekly(info.rateLimitType);
  if (kind === null) return null;
  const usedPercent =
    info.utilization === undefined
      ? info.status === "rejected"
        ? 100
        : null
      : Math.max(0, Math.min(100, info.utilization * 100));
  if (usedPercent === null) return null;
  return {
    // One window per event: everything else is unchanged.
    complete: false,
    windows: [
      {
        id: info.rateLimitType,
        label: kind.label,
        usedPercent,
        resetsAt: epochToIso(info.resetsAt),
        windowMinutes: kind.windowMinutes,
      },
    ],
  };
}
