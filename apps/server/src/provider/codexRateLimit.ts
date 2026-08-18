import type { ServerProviderRateLimit, ServerProviderRateLimitWindow } from "@t3tools/contracts";

interface CodexRateLimitWindowInput {
  readonly usedPercent: number;
  readonly resetsAt?: number | null;
  readonly windowDurationMins?: number | null;
}

export interface CodexRateLimitSnapshotInput {
  readonly primary?: CodexRateLimitWindowInput | null;
  readonly secondary?: CodexRateLimitWindowInput | null;
  readonly rateLimitReachedType?: string | null;
  readonly spendControlReached?: boolean | null;
}

function mapWindow(
  window: CodexRateLimitWindowInput | null | undefined,
): ServerProviderRateLimitWindow | undefined {
  if (window === null || window === undefined) return undefined;
  return {
    usedPercent: window.usedPercent,
    ...(window.resetsAt === null || window.resetsAt === undefined
      ? {}
      : { resetsAt: window.resetsAt }),
    ...(window.windowDurationMins === null || window.windowDurationMins === undefined
      ? {}
      : { windowDurationMins: window.windowDurationMins }),
  };
}

export function mapCodexRateLimitSnapshot(
  input: CodexRateLimitSnapshotInput,
): ServerProviderRateLimit | undefined {
  const primary = mapWindow(input.primary);
  const secondary = mapWindow(input.secondary);
  const isFull =
    input.rateLimitReachedType != null ||
    input.spendControlReached === true ||
    (primary?.usedPercent ?? 0) >= 100 ||
    (secondary?.usedPercent ?? 0) >= 100;

  const windows = [primary, secondary].filter((window) => window !== undefined);
  if (!isFull && windows.length === 0) return undefined;

  return {
    isFull,
    windows,
  };
}
