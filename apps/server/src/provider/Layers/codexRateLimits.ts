/**
 * Normalises Codex app-server rate-limit payloads into the usage limits
 * contract. Both the `account/rateLimits/updated` notification and the
 * `account/rateLimits/read` response carry the same snapshot shape; only the
 * read response adds banked reset credits.
 *
 * @module provider/Layers/codexRateLimits
 */
import type { UsageLimitWindow, UsageLimitsUpdate } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";

interface CodexRateLimitWindow {
  readonly usedPercent: number;
  readonly resetsAt?: number | null;
  readonly windowDurationMins?: number | null;
}

interface CodexRateLimitSnapshot {
  readonly planType?: string | null;
  readonly primary?: CodexRateLimitWindow | null;
  readonly secondary?: CodexRateLimitWindow | null;
}

interface CodexResetCredits {
  readonly availableCount: number;
  readonly credits?: ReadonlyArray<{
    readonly expiresAt?: number | null;
    readonly status: string;
  }> | null;
}

export interface CodexRateLimitsInput {
  readonly rateLimits: CodexRateLimitSnapshot;
  /** Only the read response carries this; absent means "unchanged". */
  readonly rateLimitResetCredits?: CodexResetCredits | null;
}

const MINUTES_PER_HOUR = 60;
const MINUTES_PER_DAY = 24 * MINUTES_PER_HOUR;
const MINUTES_PER_WEEK = 7 * MINUTES_PER_DAY;

/** Codex timestamps are unix seconds; tolerate milliseconds defensively. */
export function epochToIso(value: number | null | undefined): string | null {
  if (value === null || value === undefined || !Number.isFinite(value)) return null;
  const ms = value > 1e12 ? value : value * 1000;
  return DateTime.formatIso(DateTime.makeUnsafe(ms));
}

function windowLabel(minutes: number | null, fallback: string): string {
  if (minutes === null) return fallback;
  if (minutes === MINUTES_PER_WEEK) return "Weekly";
  if (minutes < MINUTES_PER_HOUR) return `${minutes} min`;
  if (minutes < MINUTES_PER_DAY) return `${Math.round(minutes / MINUTES_PER_HOUR)} hour`;
  return `${Math.round(minutes / MINUTES_PER_DAY)} day`;
}

function toWindow(
  id: string,
  fallbackLabel: string,
  window: CodexRateLimitWindow,
): UsageLimitWindow {
  const windowMinutes = window.windowDurationMins ?? null;
  return {
    id,
    label: windowLabel(windowMinutes, fallbackLabel),
    usedPercent: Math.max(0, Math.min(100, window.usedPercent)),
    resetsAt: epochToIso(window.resetsAt),
    windowMinutes,
  };
}

function planLabel(planType: string): string | null {
  if (planType === "unknown") return null;
  return planType
    .split("_")
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
}

/**
 * `complete` marks a full `account/rateLimits/read` response. The rolling
 * `account/rateLimits/updated` notification is documented as sparse, so its
 * missing windows mean "unchanged" rather than "gone".
 */
export function normalizeCodexRateLimits(
  input: CodexRateLimitsInput,
  options: { readonly complete: boolean },
): UsageLimitsUpdate {
  const { rateLimits } = input;
  const windows: UsageLimitWindow[] = [];
  if (rateLimits.primary) windows.push(toWindow("primary", "5 hour", rateLimits.primary));
  if (rateLimits.secondary) windows.push(toWindow("secondary", "Weekly", rateLimits.secondary));

  const credits = input.rateLimitResetCredits;
  const expiries =
    credits?.credits
      ?.filter((credit) => credit.status === "available")
      .map((credit) => credit.expiresAt)
      .filter((value): value is number => typeof value === "number") ?? [];

  return {
    complete: options.complete,
    windows,
    ...(rateLimits.planType === undefined || rateLimits.planType === null
      ? {}
      : { plan: planLabel(rateLimits.planType) }),
    ...(credits === undefined
      ? {}
      : {
          resetCredits:
            credits === null
              ? null
              : {
                  availableCount: Math.max(0, credits.availableCount),
                  nextExpiresAt: expiries.length === 0 ? null : epochToIso(Math.min(...expiries)),
                },
        }),
  };
}
