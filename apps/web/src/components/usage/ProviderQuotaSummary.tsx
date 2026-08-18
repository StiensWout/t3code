import type { ServerProvider } from "@t3tools/contracts";
import { cn } from "../../lib/utils";
import { ProviderInstanceIcon } from "../chat/ProviderInstanceIcon";
import { collectProviderQuotaUsage } from "./providerQuota";

function formattedTimestamp(epochSeconds: number): string {
  return new Intl.DateTimeFormat(undefined, {
    weekday: "short",
    hour: "numeric",
    minute: "2-digit",
  }).format(new Date(epochSeconds * 1_000));
}

function quotaTone(remainingPercent: number): {
  readonly text: string;
  readonly bar: string;
} {
  if (remainingPercent <= 10) {
    return { text: "text-destructive", bar: "bg-destructive" };
  }
  if (remainingPercent < 50) {
    return { text: "text-warning", bar: "bg-warning" };
  }
  return { text: "text-success", bar: "bg-success" };
}

export function ProviderQuotaSummary({ provider }: { readonly provider: ServerProvider | null }) {
  const row = collectProviderQuotaUsage([
    {
      label: "",
      serverConfig: provider === null ? null : { providers: [provider] },
    },
  ])[0];

  if (row === undefined) return null;

  return (
    <div className="px-[var(--floating-content-inset)] py-2 text-left text-xs">
      <div className="flex min-w-0 items-center gap-2">
        <ProviderInstanceIcon
          driverKind={row.driver}
          displayName={row.name}
          iconClassName="size-3.5"
        />
        <span className="min-w-0 flex-1 truncate font-medium text-foreground">{row.name}</span>
        <span className="truncate text-[10px] text-muted-foreground">{row.plan}</span>
      </div>
      <div className="mt-2 grid gap-2">
        {row.windows.map((window) => {
          const tone = quotaTone(window.remainingPercent);
          return (
            <div className="grid gap-1" key={`${window.label}:${window.resetsAt ?? "none"}`}>
              <div className="flex items-baseline justify-between gap-3 text-[11px]">
                <span className="text-muted-foreground">
                  {window.label}
                  {window.resetsAt === undefined ? "" : ` · ${formattedTimestamp(window.resetsAt)}`}
                </span>
                <span className={cn("shrink-0 font-medium tabular-nums", tone.text)}>
                  {window.remainingPercent}% left
                </span>
              </div>
              <div
                aria-label={`${window.label}: ${window.remainingPercent}% remaining`}
                aria-valuemax={100}
                aria-valuemin={0}
                aria-valuenow={window.remainingPercent}
                className="h-1 overflow-hidden rounded-[1px] bg-muted"
                role="progressbar"
              >
                <div
                  className={cn("h-full", tone.bar)}
                  style={{ width: `${window.remainingPercent}%` }}
                />
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
