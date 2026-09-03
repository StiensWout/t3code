import type { UsageLimitsConsumeResetOutcome } from "@t3tools/contracts";
import { elapsedShare, formatDuration, type LimitPace, paceOf } from "@t3tools/shared/usageLimits";
import { GaugeIcon, TrendingDownIcon, TrendingUpIcon } from "lucide-react";
import { Fragment, useState } from "react";

import { cn } from "../../lib/utils";
import { serverEnvironment } from "../../state/server";
import type { EnvironmentProviderLimits } from "../../state/usage";
import { useAtomCommand } from "../../state/use-atom-command";
import {
  AlertDialog,
  AlertDialogClose,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogPopup,
  AlertDialogTitle,
} from "../ui/alert-dialog";
import { Button } from "../ui/button";
import { Popover, PopoverPopup, PopoverTrigger } from "../ui/popover";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { PROVIDER_PRESENTATION, ProviderMark } from "./usageProviders";

function formatUntil(iso: string | null, now: number): string | null {
  if (iso === null) return null;
  const at = Date.parse(iso);
  return Number.isFinite(at) ? formatDuration(at - now) : null;
}

function formatUsed(percent: number): string {
  return `${Math.round(percent)}%`;
}

const RESET_AT = new Intl.DateTimeFormat(undefined, {
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  hour12: false,
});

/** `09/03, 09:40` */
function formatResetAt(iso: string | null): string | null {
  if (iso === null) return null;
  const at = Date.parse(iso);
  return Number.isFinite(at) ? RESET_AT.format(at) : null;
}

const OUTCOME_TEXT: Record<UsageLimitsConsumeResetOutcome, string> = {
  reset: "Reset applied.",
  nothingToReset: "Nothing to reset right now.",
  noCredit: "No reset credit left.",
  alreadyRedeemed: "That credit was already redeemed.",
};

/**
 * Banked Codex reset credits with a confirmed redeem action. Redeeming spends
 * something on the user's subscription, so it never fires on a bare click.
 */
function ResetCredits({
  entry,
  now,
}: {
  readonly entry: EnvironmentProviderLimits;
  readonly now: number;
}) {
  const credits = entry.resetCredits;
  const consume = useAtomCommand(serverEnvironment.consumeUsageLimitReset, {
    reportFailure: false,
  });
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState<string | null>(null);
  if (credits === null || credits.availableCount === 0) return null;

  const expires = formatUntil(credits.nextExpiresAt, now);
  const summary = `${credits.availableCount} ${credits.availableCount === 1 ? "reset" : "resets"} banked${
    expires ? ` · next expires in ${expires}` : ""
  }`;

  const redeem = async () => {
    setConfirming(false);
    setBusy(true);
    setStatus(null);
    const result = await consume({
      environmentId: entry.environmentId,
      input: { instanceId: entry.instanceId },
    });
    setBusy(false);
    if (result._tag === "Success") {
      setStatus(OUTCOME_TEXT[result.value.outcome]);
      return;
    }
    const failure = result.cause;
    setStatus(
      "error" in failure && failure.error instanceof Error
        ? failure.error.message
        : "Could not use the reset.",
    );
  };

  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground">
      <span className="tabular-nums">{summary}</span>
      {credits.availableCount > 0 ? (
        <Button size="xs" variant="outline" disabled={busy} onClick={() => setConfirming(true)}>
          {busy ? "Using reset…" : "Use a reset"}
        </Button>
      ) : null}
      {status ? <span className="text-foreground">{status}</span> : null}
      <AlertDialog open={confirming} onOpenChange={setConfirming}>
        <AlertDialogPopup>
          <AlertDialogHeader>
            <AlertDialogTitle>Use a banked reset?</AlertDialogTitle>
            <AlertDialogDescription>
              This redeems one reset credit on your Codex account and clears the current rate-limit
              windows. It cannot be undone.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogClose render={<Button variant="outline" />}>Cancel</AlertDialogClose>
            <Button onClick={() => void redeem()}>Use reset</Button>
          </AlertDialogFooter>
        </AlertDialogPopup>
      </AlertDialog>
    </div>
  );
}

type LimitWindow = EnvironmentProviderLimits["windows"][number];

function entryKey(entry: EnvironmentProviderLimits): string {
  return `${entry.environmentId}:${entry.provider}:${entry.instanceId}`;
}

type SectionProps = {
  readonly providers: readonly EnvironmentProviderLimits[];
  readonly now: number;
  /** Only when two environments report, so a single machine shows no label. */
  readonly showEnvironment: boolean;
  /** Only when one environment runs two instances of the same provider. */
  readonly instanceCounts: ReadonlyMap<string, number>;
};

/** Qualifier after the provider name: which environment, which instance. */
function providerQualifier(entry: EnvironmentProviderLimits, props: SectionProps): string | null {
  const parts: string[] = [];
  if (props.showEnvironment) parts.push(entry.environmentLabel);
  if ((props.instanceCounts.get(`${entry.environmentId}:${entry.provider}`) ?? 0) > 1) {
    parts.push(entry.instanceLabel ?? entry.instanceId);
  }
  return parts.length === 0 ? null : parts.join(" · ");
}

/** Section heading: provider name, tier, and qualifier. */
function ProviderHeading({
  entry,
  props,
  size = "sm",
}: {
  readonly entry: EnvironmentProviderLimits;
  readonly props: SectionProps;
  readonly size?: "sm" | "xs";
}) {
  const qualifier = providerQualifier(entry, props);
  return (
    <div className="flex items-baseline justify-between gap-3">
      <h2
        className={cn(
          "flex min-w-0 items-center gap-2 font-medium text-foreground",
          size === "sm" ? "text-sm" : "text-xs",
        )}
      >
        <ProviderMark provider={entry.provider} className={size === "sm" ? "size-4" : "size-3.5"} />
        <span className="truncate">{PROVIDER_PRESENTATION[entry.provider].label}</span>
        {qualifier ? (
          <span className="truncate font-normal text-muted-foreground">{qualifier}</span>
        ) : null}
        {entry.plan && size === "sm" ? (
          <span className="shrink-0 font-normal text-muted-foreground">· {entry.plan}</span>
        ) : null}
      </h2>
    </div>
  );
}

const PACE: Record<LimitPace, { readonly label: string; readonly icon: typeof GaugeIcon }> = {
  ahead: { label: "Ahead of pace: spending faster than the window elapses", icon: TrendingUpIcon },
  on: { label: "On pace with the window", icon: GaugeIcon },
  under: { label: "Under pace: headroom left for the rest of the window", icon: TrendingDownIcon },
};

/** Pace as a glyph with the words on hover. */
function PaceIcon({ pace }: { readonly pace: LimitPace }) {
  const Icon = PACE[pace].icon;
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <span
            role="img"
            aria-label={PACE[pace].label}
            className="inline-flex text-muted-foreground"
          />
        }
      >
        <Icon className="size-3.5" aria-hidden />
      </TooltipTrigger>
      <TooltipPopup side="top">{PACE[pace].label}</TooltipPopup>
    </Tooltip>
  );
}

/**
 * One window as a full-width bar from the moment it opened to its reset.
 * Usage fills from the left in the provider's chart colour; the hairline sits
 * at the elapsed fraction, which is also where even spending would have put
 * the fill. Hovering explains exactly that.
 */
function WindowBar({
  entry,
  window,
  now,
}: {
  readonly entry: EnvironmentProviderLimits;
  readonly window: LimitWindow;
  readonly now: number;
}) {
  const elapsed = elapsedShare(window, now);
  const used = Math.max(0, Math.min(100, window.usedPercent)) / 100;
  const at = formatResetAt(window.resetsAt);
  const until = formatUntil(window.resetsAt, now);
  const summary = `${window.label}: ${formatUsed(window.usedPercent)} used${
    elapsed === null ? "" : `, ${Math.round(elapsed * 100)}% of the window elapsed`
  }${until ? `, resets in ${until}` : ""}`;
  return (
    <Popover>
      <PopoverTrigger
        openOnHover
        delay={150}
        closeDelay={0}
        render={
          <div
            role="img"
            aria-label={summary}
            tabIndex={0}
            className="relative h-6 cursor-default rounded-full outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background"
          />
        }
      >
        <div className="absolute inset-x-0 inset-y-1.5 rounded-full bg-muted" />
        {used > 0 ? (
          <div
            className="absolute inset-y-1.5 left-0 rounded-full"
            style={{
              width: `${used * 100}%`,
              // The same series colour the cost chart uses for this provider.
              backgroundColor: PROVIDER_PRESENTATION[entry.provider].color,
            }}
          />
        ) : null}
        {elapsed !== null ? (
          <span
            aria-hidden
            className="absolute inset-y-0.5 w-px -translate-x-1/2 bg-foreground/60"
            style={{ left: `${elapsed * 100}%` }}
          />
        ) : null}
      </PopoverTrigger>
      <PopoverPopup tooltipStyle side="top" align="center" className="text-xs">
        <div className="flex flex-col gap-0.5">
          <span className="text-foreground">
            {formatUsed(window.usedPercent)} used
            {elapsed !== null ? ` · ${Math.round(elapsed * 100)}% of the window elapsed` : ""}
          </span>
          {elapsed !== null ? (
            <span className="text-muted-foreground">The line is where even spending would be.</span>
          ) : null}
          {at ? (
            <span className="text-muted-foreground">
              Resets {at}
              {until ? ` · in ${until}` : ""}
            </span>
          ) : null}
        </div>
      </PopoverPopup>
    </Popover>
  );
}

/** One provider's used windows, one bar each. An unused window has nothing to show. */
function ProviderWindows({
  entry,
  now,
}: {
  readonly entry: EnvironmentProviderLimits;
  readonly now: number;
}) {
  const windows = entry.windows.filter((window) => window.usedPercent > 0);
  if (windows.length === 0) {
    return <span className="text-xs text-muted-foreground">No usage in any window.</span>;
  }
  return (
    <div className="grid grid-cols-[11rem_minmax(0,1fr)_6rem] gap-x-4 gap-y-1">
      {windows.map((window, index) => {
        // Windows that reset together show the countdown once.
        const previous = windows[index - 1];
        const sharesReset =
          previous !== undefined &&
          previous.resetsAt !== null &&
          previous.resetsAt === window.resetsAt;
        const pace = paceOf(window, now);
        return (
          <Fragment key={window.id}>
            <span className="flex min-w-0 items-center gap-2 text-xs">
              <span className="truncate text-muted-foreground">{window.label}</span>
              <span className="ms-auto shrink-0 font-medium text-foreground tabular-nums">
                {formatUsed(window.usedPercent)}
              </span>
            </span>
            <WindowBar entry={entry} window={window} now={now} />
            <span className="flex items-center gap-2 text-xs text-muted-foreground tabular-nums">
              {pace ? <PaceIcon pace={pace} /> : null}
              <span className="ms-auto shrink-0">
                {sharesReset ? "" : (formatUntil(window.resetsAt, now) ?? "")}
              </span>
            </span>
          </Fragment>
        );
      })}
    </div>
  );
}

/**
 * Limits tab body: one section per provider with its heading, a bar per
 * window in use, and banked resets where the provider offers them.
 */
export function UsageLimitsSection({
  providers,
  failedEnvironments,
  pendingEnvironments,
  now,
  isPending,
}: {
  readonly providers: readonly EnvironmentProviderLimits[];
  readonly failedEnvironments: readonly string[];
  readonly pendingEnvironments: readonly string[];
  readonly now: number;
  readonly isPending: boolean;
}) {
  const environmentCount = new Set(providers.map((entry) => entry.environmentId)).size;
  const instanceCounts = new Map<string, number>();
  for (const entry of providers) {
    const key = `${entry.environmentId}:${entry.provider}`;
    instanceCounts.set(key, (instanceCounts.get(key) ?? 0) + 1);
  }
  const props: SectionProps = {
    providers,
    now,
    showEnvironment: environmentCount > 1,
    instanceCounts,
  };
  return (
    <div className="flex flex-col gap-8">
      {failedEnvironments.map((label) => (
        <span key={label} className="text-sm text-muted-foreground">
          {label} could not report limits.
        </span>
      ))}
      {providers.length > 0
        ? pendingEnvironments.map((label) => (
            <span key={label} className="text-sm text-muted-foreground">
              {label} is still reading its limits.
            </span>
          ))
        : null}
      {providers.length === 0 && failedEnvironments.length === 0 ? (
        <span className="text-sm text-muted-foreground">
          {isPending ? "Reading limits…" : "No limits reported yet."}
        </span>
      ) : null}
      {providers.map((entry) => (
        <section key={entryKey(entry)} className="flex flex-col gap-3">
          <ProviderHeading entry={entry} props={props} />
          {entry.readError ? (
            <span className="text-xs text-muted-foreground">
              Could not read limits.
              {entry.windows.length > 0
                ? ` Showing the last report from ${formatDuration(now - Date.parse(entry.observedAt))} ago.`
                : ""}
            </span>
          ) : null}
          <ProviderWindows entry={entry} now={now} />
          <ResetCredits entry={entry} now={now} />
        </section>
      ))}
    </div>
  );
}
