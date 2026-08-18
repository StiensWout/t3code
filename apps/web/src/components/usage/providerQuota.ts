import type { ProviderDriverKind, ServerProvider } from "@t3tools/contracts";

export interface QuotaEnvironment {
  readonly label: string;
  readonly serverConfig: { readonly providers: ReadonlyArray<ServerProvider> } | null;
}

export interface ProviderQuotaRow {
  readonly key: string;
  readonly driver: ProviderDriverKind;
  readonly providerLabel: string;
  readonly name: string;
  readonly plan: string;
  readonly environmentLabel: string;
  readonly remainingPercent: number | null;
  readonly windowLabel: string;
  readonly isFull: boolean;
  readonly checkedAt: string;
  readonly windows: ReadonlyArray<ProviderQuotaWindow>;
}

export interface ProviderQuotaWindow {
  readonly key: string;
  readonly label: string;
  readonly remainingPercent: number;
  readonly resetsAt: number | undefined;
}

export type ProviderQuotaSeverity = "critical" | "warning" | "healthy";

export function providerQuotaSeverity(remainingPercent: number): ProviderQuotaSeverity {
  if (remainingPercent <= 10) return "critical";
  if (remainingPercent < 50) return "warning";
  return "healthy";
}

export function providerQuotaStroke(remainingPercent: number): string {
  switch (providerQuotaSeverity(remainingPercent)) {
    case "critical":
      return "var(--color-destructive)";
    case "warning":
      return "var(--color-warning)";
    case "healthy":
      return "var(--color-success)";
  }
}

function providerLabel(driver: ProviderDriverKind): string {
  switch (driver) {
    case "codex":
      return "Codex";
    case "claudeAgent":
      return "Claude";
    case "cursor":
      return "Cursor";
    case "grok":
      return "Grok";
    case "opencode":
      return "OpenCode";
    default:
      return driver;
  }
}

function planLabel(provider: ServerProvider): string {
  return (provider.auth.label ?? providerLabel(provider.driver))
    .replace(/^ChatGPT /, "")
    .replace(/ Subscription$/, "");
}

function quotaWindowLabel(
  label: string | undefined,
  windowDurationMins: number | undefined,
): string {
  if (label !== undefined) return label;
  if (windowDurationMins === undefined) return "Quota";
  if (windowDurationMins === 300) return "5-hour";
  if (windowDurationMins === 10_080) return "Weekly";
  if (windowDurationMins % 1_440 === 0) return `${windowDurationMins / 1_440}-day`;
  if (windowDurationMins % 60 === 0) return `${windowDurationMins / 60}-hour`;
  return `${windowDurationMins}-minute`;
}

function quotaPresentation(provider: ServerProvider): {
  readonly remainingPercent: number | null;
  readonly windowLabel: string;
  readonly windows: ReadonlyArray<ProviderQuotaWindow>;
} {
  const rateLimit = provider.rateLimit;
  if (rateLimit === undefined) {
    return { remainingPercent: null, windowLabel: "Quota", windows: [] };
  }
  const windows = rateLimit.windows.map((window, index) => ({
    key: `${window.label ?? window.windowDurationMins ?? "quota"}:${window.resetsAt ?? "none"}:${index}`,
    label: quotaWindowLabel(window.label, window.windowDurationMins),
    remainingPercent: Math.round(Math.max(0, Math.min(100, 100 - window.usedPercent))),
    resetsAt: window.resetsAt,
  }));
  const limitingWindow = windows.toSorted(
    (left, right) => left.remainingPercent - right.remainingPercent,
  )[0];
  return {
    remainingPercent: rateLimit.isFull
      ? 0
      : limitingWindow === undefined
        ? null
        : limitingWindow.remainingPercent,
    windowLabel: limitingWindow?.label ?? "Quota",
    windows,
  };
}

/** Collect only providers that report real subscription quota snapshots. */
export function collectProviderQuotaUsage(
  environments: ReadonlyArray<QuotaEnvironment>,
): ReadonlyArray<ProviderQuotaRow> {
  return environments.flatMap((environment) =>
    (environment.serverConfig?.providers ?? []).flatMap((provider) => {
      if (provider.rateLimit === undefined) return [];
      const quota = quotaPresentation(provider);
      return [
        {
          key: `${environment.label}:${provider.instanceId}`,
          driver: provider.driver,
          providerLabel: providerLabel(provider.driver),
          name: provider.displayName ?? providerLabel(provider.driver),
          plan: planLabel(provider),
          environmentLabel: environment.label,
          remainingPercent: quota.remainingPercent,
          windowLabel: quota.windowLabel,
          isFull: provider.rateLimit.isFull,
          checkedAt: provider.checkedAt,
          windows: quota.windows,
        },
      ];
    }),
  );
}
