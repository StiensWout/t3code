import type { ServerProvider } from "@t3tools/contracts";
import { Button } from "../ui/button";
import { type ContextWindowSnapshot, formatContextWindowTokens } from "~/lib/contextWindow";
import { Popover, PopoverPopup, PopoverTrigger } from "../ui/popover";
import { ProviderQuotaSummary } from "../usage/ProviderQuotaSummary";
import { collectProviderQuotaUsage, providerQuotaSeverity } from "../usage/providerQuota";
import { formatContextWindowCompactionMessage } from "./ContextWindowMeter.logic";

function formatPercentage(value: number | null): string | null {
  if (value === null || !Number.isFinite(value)) {
    return null;
  }
  if (value < 10) {
    return `${value.toFixed(1).replace(/\.0$/, "")}%`;
  }
  return `${Math.round(value)}%`;
}

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

function ConcentricGauge(props: {
  readonly quotaRemaining: number | null;
  readonly usagePercentage: number;
  readonly usageColor: string;
  readonly trackLength: number;
  readonly rotation: number;
  readonly innerRotation?: number;
}) {
  const quotaArcLength = (props.trackLength * (props.quotaRemaining ?? 0)) / 100;
  const usageArcLength = (props.trackLength * props.usagePercentage) / 100;
  const outerRadius = props.quotaRemaining === null ? 8 : 9;
  return (
    <svg viewBox="0 0 24 16" className="size-10 max-w-none" aria-hidden="true">
      <circle
        cx="12"
        cy="12"
        r={outerRadius}
        fill="none"
        pathLength="100"
        stroke="color-mix(in oklab, var(--color-muted-foreground) 22%, transparent)"
        strokeDasharray={`${props.trackLength} ${100 - props.trackLength}`}
        strokeLinecap="round"
        strokeWidth="3"
        transform={`rotate(${props.rotation} 12 12)`}
      />
      <circle
        cx="12"
        cy="12"
        r={outerRadius}
        fill="none"
        pathLength="100"
        stroke={props.usageColor}
        strokeDasharray={`${usageArcLength} ${100 - usageArcLength}`}
        strokeLinecap="round"
        strokeWidth="3"
        transform={`rotate(${props.rotation} 12 12)`}
      />
      {props.quotaRemaining === null ? null : (
        <>
          <circle
            cx="12"
            cy="12"
            r="5"
            fill="none"
            pathLength="100"
            stroke="color-mix(in oklab, var(--color-muted-foreground) 22%, transparent)"
            strokeDasharray={`${props.trackLength} ${100 - props.trackLength}`}
            strokeLinecap="round"
            strokeWidth="3"
            transform={`rotate(${props.innerRotation ?? props.rotation} 12 12)`}
          />
          <circle
            cx="12"
            cy="12"
            r="5"
            fill="none"
            pathLength="100"
            stroke={quotaStroke(props.quotaRemaining)}
            strokeDasharray={`${quotaArcLength} ${100 - quotaArcLength}`}
            strokeLinecap="round"
            strokeWidth="3"
            transform={`rotate(${props.innerRotation ?? props.rotation} 12 12)`}
          />
        </>
      )}
    </svg>
  );
}

export function ContextWindowMeter(props: {
  usage: ContextWindowSnapshot;
  modelDisplayName?: string | null;
  provider: ServerProvider | null;
}) {
  const { usage, modelDisplayName, provider } = props;
  const providerQuota = collectProviderQuotaUsage([
    {
      label: "",
      serverConfig: provider === null ? null : { providers: [provider] },
    },
  ])[0];
  const usedPercentage = formatPercentage(usage.usedPercentage);
  const normalizedPercentage = Math.max(0, Math.min(100, usage.usedPercentage ?? 0));
  const totalProcessedTokens = usage.totalProcessedTokens ?? null;
  const showTotalProcessed = totalProcessedTokens !== null && totalProcessedTokens > 0;
  const isOverloaded = normalizedPercentage > 90;
  const usageColor = isOverloaded ? "var(--color-error)" : "var(--color-info)";
  const quotaRemaining = providerQuota?.remainingPercent ?? null;

  return (
    <Popover>
      <PopoverTrigger
        openOnHover
        delay={0}
        closeDelay={0}
        render={
          <Button
            size="icon"
            variant="link"
            className="overflow-visible rounded-full"
            aria-label={
              usage.maxTokens !== null && usedPercentage
                ? `Context window ${usedPercentage} used${quotaRemaining === null ? "" : `, ${providerQuota?.name} quota ${quotaRemaining}% remaining`}`
                : `Context window ${formatContextWindowTokens(usage.usedTokens)} tokens used`
            }
          >
            <ConcentricGauge
              quotaRemaining={quotaRemaining}
              usagePercentage={normalizedPercentage}
              usageColor={usageColor}
              trackLength={50}
              rotation={180}
            />
          </Button>
        }
      />
      <PopoverPopup
        tooltipStyle
        side="top"
        align="end"
        viewportClassName="p-0"
        className="w-64 max-w-none text-left whitespace-normal"
      >
        <div className="flex flex-col gap-2 p-[var(--floating-content-inset)]">
          <div className="flex items-center justify-between gap-3">
            <div className="font-medium text-muted-foreground text-xs">Context Window</div>
            {usage.maxTokens !== null && usedPercentage ? (
              <div className="text-secondary-label text-[11px] tabular-nums">
                <span>{usedPercentage}</span>
                <span className="mx-1">·</span>
                <span>
                  {formatContextWindowTokens(usage.usedTokens)}/
                  {formatContextWindowTokens(usage.maxTokens ?? null)}
                </span>
              </div>
            ) : (
              <div className="text-secondary-label text-[11px] tabular-nums">
                {formatContextWindowTokens(usage.usedTokens)}
              </div>
            )}
          </div>
          {usage.maxTokens !== null ? (
            <div
              className="h-1.5 w-full overflow-hidden rounded-full bg-muted/60"
              role="progressbar"
              aria-valuemin={0}
              aria-valuemax={100}
              aria-valuenow={Math.round(normalizedPercentage)}
              aria-label="Context window usage"
            >
              <div
                className="h-full rounded-full transition-[width,background-color] duration-500 ease-out motion-reduce:transition-none"
                style={{ width: `${normalizedPercentage}%`, backgroundColor: usageColor }}
              />
            </div>
          ) : null}
          {showTotalProcessed ? (
            <div className="flex items-center justify-between gap-3 text-[11px] leading-4">
              <span className="text-secondary-label">Total processed</span>
              <span className="font-medium tabular-nums text-secondary-label">
                {formatContextWindowTokens(totalProcessedTokens)}
              </span>
            </div>
          ) : null}
          {usage.compactsAutomatically ? (
            <div className="mt-1 text-pretty text-secondary-label text-[11px] font-medium">
              {formatContextWindowCompactionMessage(modelDisplayName)}
            </div>
          ) : null}
        </div>
        <div className="border-border border-t empty:hidden">
          <ProviderQuotaSummary provider={provider} />
        </div>
      </PopoverPopup>
    </Popover>
  );
}
