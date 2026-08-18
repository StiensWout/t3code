import type { ReactNode } from "react";
import { useEnvironments } from "../../state/environments";
import { ProviderInstanceIcon } from "../chat/ProviderInstanceIcon";
import {
  collectProviderQuotaUsage,
  providerQuotaSeverity,
  type ProviderQuotaRow,
  type ProviderQuotaWindow,
} from "./providerQuota";

function quotaStroke(remainingPercent: number): string {
  switch (providerQuotaSeverity(remainingPercent)) {
    case "critical":
      return "var(--color-destructive)";
    case "warning":
      return "var(--color-warning)";
    case "healthy":
      return "var(--color-success)";
  }
}

function QuotaRing(props: {
  readonly percentage: number;
  readonly label: string;
  readonly children: ReactNode;
}) {
  return (
    <span
      aria-label={props.label}
      aria-valuemax={100}
      aria-valuemin={0}
      aria-valuenow={props.percentage}
      className="relative grid size-6 shrink-0 place-items-center"
      role="progressbar"
    >
      <svg className="absolute inset-0 size-full -rotate-90" viewBox="0 0 24 24" aria-hidden>
        <circle
          cx="12"
          cy="12"
          fill="none"
          r="9"
          stroke="color-mix(in oklab, var(--color-muted-foreground) 18%, transparent)"
          strokeWidth="2.25"
        />
        <circle
          cx="12"
          cy="12"
          fill="none"
          pathLength="100"
          r="9"
          stroke={quotaStroke(props.percentage)}
          strokeDasharray={`${props.percentage} ${100 - props.percentage}`}
          strokeLinecap="round"
          strokeWidth="2.25"
        />
      </svg>
      {props.children}
    </span>
  );
}

function WindowRing({ window }: { readonly window: ProviderQuotaWindow }) {
  return (
    <span className="flex items-center gap-1">
      <QuotaRing
        label={`${window.label}: ${window.remainingPercent}% remaining`}
        percentage={window.remainingPercent}
      >
        <span className="text-[7px] font-medium text-foreground tabular-nums">
          {window.remainingPercent}
        </span>
      </QuotaRing>
      <span className="text-[9px] text-muted-foreground">{window.label}</span>
    </span>
  );
}

function ProviderWindows({
  row,
  showEnvironmentLabel,
}: {
  readonly row: ProviderQuotaRow;
  readonly showEnvironmentLabel: boolean;
}) {
  const accountContext = showEnvironmentLabel ? `${row.plan} · ${row.environmentLabel}` : row.plan;
  return (
    <div className="min-w-0 bg-background px-2 py-1.5">
      <div className="flex min-w-0 items-center gap-1.5">
        <ProviderInstanceIcon
          displayName={row.name}
          driverKind={row.driver}
          iconClassName="size-3 shrink-0"
        />
        <span className="truncate text-[10px] font-medium text-foreground">{row.name}</span>
        <span className="ml-auto truncate text-[9px] text-muted-foreground">{accountContext}</span>
      </div>
      <div className="mt-1.5 flex min-w-0 items-center gap-3">
        {row.windows.map((window) => (
          <WindowRing key={`${window.label}:${window.resetsAt ?? "none"}`} window={window} />
        ))}
      </div>
    </div>
  );
}

/** Compact provider-reported quota windows, separate from transcript token totals. */
export function ProviderQuotaSection() {
  const { environments } = useEnvironments();
  const rows = collectProviderQuotaUsage(environments);
  const showEnvironmentLabel = new Set(rows.map((row) => row.environmentLabel)).size > 1;

  if (rows.length === 0) return null;

  return (
    <section className="grid gap-1.5">
      <h2 className="text-[10px] font-medium text-muted-foreground">Subscription limits</h2>
      <div className="grid grid-cols-[repeat(auto-fit,minmax(10rem,1fr))] gap-px border-y border-border bg-border">
        {rows.map((row) => (
          <ProviderWindows key={row.key} row={row} showEnvironmentLabel={showEnvironmentLabel} />
        ))}
      </div>
    </section>
  );
}
