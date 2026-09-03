/**
 * Pace maths for provider limit windows, shared by the web and mobile Limits
 * views so both agree on what "ahead of pace" means.
 *
 * @module usageLimits
 */
import type { UsageLimitWindow } from "@t3tools/contracts";

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;

/** `2h 13m`, `3d 4h`, `12m`. */
export function formatDuration(ms: number): string {
  const remaining = Math.max(0, ms);
  const days = Math.floor(remaining / DAY);
  const hours = Math.floor((remaining % DAY) / HOUR);
  const minutes = Math.floor((remaining % HOUR) / 60000);
  if (days > 0) return `${days}d ${hours}h`;
  if (hours > 0) return `${hours}h ${minutes}m`;
  return `${minutes}m`;
}

export function resetMillis(window: UsageLimitWindow): number | null {
  if (window.resetsAt === null) return null;
  const at = Date.parse(window.resetsAt);
  return Number.isFinite(at) ? at : null;
}

/** Elapsed share of the window, 0..1, or null when the window has no known length or reset. */
export function elapsedShare(window: UsageLimitWindow, now: number): number | null {
  const resetsAt = resetMillis(window);
  if (resetsAt === null || window.windowMinutes === null) return null;
  const length = window.windowMinutes * 60000;
  return Math.max(0, Math.min(1, (length - (resetsAt - now)) / length));
}

export type LimitPace = "ahead" | "on" | "under";

/**
 * Usage against the clock. The window's bar is its whole span, so the elapsed
 * share is also where even spending would have put the fill; within five
 * points of it counts as on pace.
 */
export function paceOf(window: UsageLimitWindow, now: number): LimitPace | null {
  const elapsed = elapsedShare(window, now);
  if (elapsed === null) return null;
  const gap = window.usedPercent - elapsed * 100;
  if (gap > 5) return "ahead";
  if (gap < -5) return "under";
  return "on";
}
