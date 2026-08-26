import {
  type EditorId,
  type EnvironmentId,
  type ProjectScript,
  type ProviderInstanceId,
  type ProviderUsageLimitWindow,
  type ProviderUsageLimits,
  type ResolvedKeybindingsConfig,
  type ServerProvider,
  type ThreadId,
} from "@t3tools/contracts";
import type { EnvironmentConnectionPresentation } from "@t3tools/client-runtime/connection";
import { AlertTriangleIcon, ChevronDownIcon, XIcon } from "lucide-react";
import { useRef, useState } from "react";

import type { DraftId } from "../../composerDraftStore";
import { useT3ProjectFileScripts } from "../../hooks/useT3ProjectFileScripts";
import type { EnvMode, EnvironmentOption } from "../BranchToolbar.logic";
import { BranchToolbar } from "../BranchToolbar";
import { BranchToolbarEnvironmentSelector } from "../BranchToolbarEnvironmentSelector";
import GitActionsControl from "../GitActionsControl";
import ProjectScriptsControl, {
  type NewProjectScriptInput,
  type ProjectScriptActionResult,
} from "../ProjectScriptsControl";
import { Button } from "../ui/button";
import { Popover, PopoverPopup, PopoverTrigger } from "../ui/popover";
import { ScrollArea } from "../ui/scroll-area";
import { cn } from "../../lib/utils";
import { formatElapsedDurationLabel, formatRelativeTimeUntilLabel } from "../../timestampFormat";
import { OpenInPicker } from "./OpenInPicker";
import { ProviderInstanceIcon } from "./ProviderInstanceIcon";
import {
  THREAD_DETAILS_PANEL_CHEVRON_CLASS,
  THREAD_DETAILS_PANEL_ICON_CLASS,
  THREAD_DETAILS_PANEL_ROW_POPUP_CLASS,
  THREAD_DETAILS_PANEL_SPLIT_GROUP_CLASS,
  THREAD_DETAILS_PANEL_SPLIT_PRIMARY_CLASS,
  THREAD_DETAILS_PANEL_SPLIT_SECONDARY_CLASS,
  THREAD_DETAILS_PANEL_SPLIT_SEPARATOR_CLASS,
} from "./threadDetailsPanelStyles";
import { ThreadAutomationsPanel } from "./ThreadAutomationsPanel";
import { ThreadRelationshipsPanel } from "./ThreadRelationshipsControl";

interface VersionMismatchIssue {
  readonly clientVersion: string;
  readonly serverVersion: string;
  readonly serverLabel: string;
}

function formatLimitReset(resetsAt: string | null): string | null {
  if (resetsAt === null) return null;
  const remaining = formatRelativeTimeUntilLabel(resetsAt);
  if (!remaining) return null;
  if (remaining === "Expired") return "resets soon";
  return `resets in ${remaining.replace(/ left$/, "")}`;
}

function LimitBar({ window }: { window: ProviderUsageLimitWindow }) {
  const reset = formatLimitReset(window.resetsAt);
  const meterColor = window.remainingPercent <= 30 ? "bg-warning" : "bg-foreground/55";

  return (
    <div className="grid gap-1.5">
      <div className="flex items-baseline gap-2 text-[11px]">
        <span className="font-medium text-foreground/80">{window.label}</span>
        {reset ? <span className="text-muted-foreground">{reset}</span> : null}
        <span className="ml-auto font-mono tabular-nums text-foreground">
          {window.remainingPercent}% left
        </span>
      </div>
      <div
        aria-label={`${window.label} provider limit: ${window.remainingPercent}% remaining`}
        aria-valuemax={100}
        aria-valuemin={0}
        aria-valuenow={window.remainingPercent}
        className="h-1.5 w-full overflow-hidden rounded-full bg-muted/60"
        role="progressbar"
      >
        <div
          className={cn("h-full rounded-full", meterColor)}
          style={{ width: `${window.remainingPercent}%` }}
        />
      </div>
    </div>
  );
}

function usageSummary(usageLimits: ProviderUsageLimits): string {
  if (usageLimits.status === "loading") return "Checking…";
  if (usageLimits.status === "unavailable") return "Unavailable";
  const lowestRemaining = usageLimits.windows.reduce<number | null>(
    (lowest, window) =>
      lowest === null ? window.remainingPercent : Math.min(lowest, window.remainingPercent),
    null,
  );
  if (lowestRemaining === null) return "Unavailable";
  return lowestRemaining === 0 ? "Limit reached" : `${lowestRemaining}% left`;
}

function ProviderLimitRow({
  provider,
  usageLimits,
}: {
  provider: ServerProvider;
  usageLimits: ProviderUsageLimits;
}) {
  const [open, setOpen] = useState(false);
  const anchorRef = useRef<HTMLDivElement | null>(null);
  const displayName = provider.displayName ?? String(provider.driver);
  const staleAge = usageLimits.observedAt ? formatElapsedDurationLabel(usageLimits.observedAt) : "";

  return (
    <div
      aria-label={`${displayName} provider limits`}
      className={THREAD_DETAILS_PANEL_SPLIT_GROUP_CLASS}
      ref={anchorRef}
      role="group"
    >
      <Button
        aria-expanded={open}
        aria-label={`Show ${displayName} provider limits`}
        className={THREAD_DETAILS_PANEL_SPLIT_PRIMARY_CLASS}
        onClick={() => setOpen(true)}
        size="sm"
        type="button"
        variant="ghost"
      >
        <ProviderInstanceIcon
          displayName={displayName}
          driverKind={provider.driver}
          iconClassName={THREAD_DETAILS_PANEL_ICON_CLASS}
        />
        <span className="ml-0.5 min-w-0 truncate">{displayName}</span>
        {usageLimits.planLabel ? (
          <span className="min-w-0 truncate text-[10px] font-normal text-muted-foreground/70">
            {usageLimits.planLabel}
          </span>
        ) : null}
        <span
          className={cn(
            "ml-auto shrink-0 font-mono text-[10px] tabular-nums",
            usageLimits.windows.some((window) => window.remainingPercent <= 30)
              ? "text-warning"
              : "text-muted-foreground",
          )}
        >
          {usageSummary(usageLimits)}
        </span>
      </Button>
      <span aria-hidden="true" className={THREAD_DETAILS_PANEL_SPLIT_SEPARATOR_CLASS} />
      <Popover onOpenChange={setOpen} open={open}>
        <PopoverTrigger
          render={
            <Button
              aria-label={`Show ${displayName} provider limit details`}
              className={THREAD_DETAILS_PANEL_SPLIT_SECONDARY_CLASS}
              size="sm"
              type="button"
              variant="ghost"
            />
          }
        >
          <ChevronDownIcon aria-hidden className={THREAD_DETAILS_PANEL_CHEVRON_CLASS} />
        </PopoverTrigger>
        <PopoverPopup
          align="end"
          anchor={anchorRef}
          className={THREAD_DETAILS_PANEL_ROW_POPUP_CLASS}
          positionerClassName="w-(--anchor-width)"
          viewportClassName="p-0"
        >
          <div className="grid gap-3 p-2">
            {usageLimits.windows.length > 0 ? (
              usageLimits.windows.map((window) => <LimitBar key={window.id} window={window} />)
            ) : (
              <span className="px-0.5 py-1 text-[11px] text-muted-foreground">
                {usageSummary(usageLimits)}
              </span>
            )}
            {usageLimits.status === "stale" ? (
              <span className="text-[10px] text-muted-foreground">
                Last checked {staleAge === "just now" ? staleAge : `${staleAge || "earlier"} ago`}
              </span>
            ) : null}
          </div>
        </PopoverPopup>
      </Popover>
    </div>
  );
}

function ProviderUsageSection({
  providers,
  providerInstanceIds,
  show,
}: {
  providers: ReadonlyArray<ServerProvider>;
  providerInstanceIds: ReadonlyArray<ProviderInstanceId>;
  show: boolean;
}) {
  if (!show) return null;

  const providersById = new Map(providers.map((provider) => [provider.instanceId, provider]));
  const relevantProviders = providerInstanceIds.flatMap((providerInstanceId, index) => {
    const provider = providersById.get(providerInstanceId);
    const usageLimits = provider?.usageLimits;
    if (
      !provider ||
      !usageLimits ||
      usageLimits.status === "unsupported" ||
      (index > 0 && usageLimits.status === "unavailable")
    ) {
      return [];
    }
    return [{ provider, usageLimits }];
  });

  if (relevantProviders.length === 0) return null;

  return (
    <section aria-labelledby="thread-details-usage-heading" className="border-t border-border/65">
      <div className="px-3.5 pb-1 pt-3">
        <h3
          id="thread-details-usage-heading"
          className="text-[11px] font-medium text-muted-foreground"
        >
          Usage
        </h3>
      </div>
      <div aria-label="Provider limits" className="flex flex-col px-2 pb-2.5">
        {relevantProviders.map(({ provider, usageLimits }) => (
          <ProviderLimitRow
            key={provider.instanceId}
            provider={provider}
            usageLimits={usageLimits}
          />
        ))}
      </div>
    </section>
  );
}

export interface ThreadDetailsPanelProps {
  mode: "inline" | "popover";
  onClose?: () => void;
  environmentId: EnvironmentId;
  environmentConnection: EnvironmentConnectionPresentation | null;
  threadId: ThreadId;
  draftId?: DraftId;
  activeProjectName: string | undefined;
  activeProjectScripts: ReadonlyArray<ProjectScript> | undefined;
  providers: ReadonlyArray<ServerProvider>;
  providerInstanceIds: ReadonlyArray<ProviderInstanceId>;
  showProviderUsage: boolean;
  preferredScriptId: string | null;
  keybindings: ResolvedKeybindingsConfig;
  availableEditors: ReadonlyArray<EditorId>;
  showOpenInPicker: boolean;
  gitCwd: string | null;
  isGitRepo: boolean;
  envLocked: boolean;
  availableEnvironments: readonly EnvironmentOption[];
  onEnvironmentChange: (environmentId: EnvironmentId) => void;
  onEnvModeChange: (mode: EnvMode) => void;
  effectiveEnvModeOverride?: EnvMode;
  activeThreadBranchOverride?: string | null;
  onActiveThreadBranchOverrideChange?: (branch: string | null) => void;
  startFromOrigin: boolean;
  onStartFromOriginChange: (startFromOrigin: boolean) => void;
  onCheckoutPullRequestRequest?: (reference: string) => void;
  onComposerFocusRequest: () => void;
  onOpenChanges?: () => void;
  onReconnectEnvironment: () => void;
  onOpenConnectionSettings: () => void;
  versionMismatch: VersionMismatchIssue | null;
  onDismissVersionMismatch: () => void;
  onRunProjectScript: (script: ProjectScript) => void;
  onAddProjectScript: (input: NewProjectScriptInput) => Promise<ProjectScriptActionResult>;
  onUpdateProjectScript: (
    scriptId: string,
    input: NewProjectScriptInput,
  ) => Promise<ProjectScriptActionResult>;
  onDeleteProjectScript: (scriptId: string) => Promise<ProjectScriptActionResult>;
}

export function ThreadDetailsPanel(props: ThreadDetailsPanelProps) {
  const fileScripts = useT3ProjectFileScripts(
    props.environmentId,
    props.activeProjectScripts ? props.gitCwd : null,
  );
  const connectionIssue =
    props.environmentConnection !== null &&
    props.environmentConnection.phase !== "connected" &&
    props.environmentConnection.phase !== "available";
  const isReconnecting =
    props.environmentConnection?.phase === "connecting" ||
    props.environmentConnection?.phase === "reconnecting";
  const branchToolbarProps = {
    showGitControls: props.isGitRepo,
    environmentId: props.environmentId,
    threadId: props.threadId,
    ...(props.draftId ? { draftId: props.draftId } : {}),
    onEnvModeChange: props.onEnvModeChange,
    startFromOrigin: props.startFromOrigin,
    onStartFromOriginChange: props.onStartFromOriginChange,
    ...(props.effectiveEnvModeOverride
      ? { effectiveEnvModeOverride: props.effectiveEnvModeOverride }
      : {}),
    ...(props.activeThreadBranchOverride !== undefined
      ? { activeThreadBranchOverride: props.activeThreadBranchOverride }
      : {}),
    ...(props.onActiveThreadBranchOverrideChange
      ? { onActiveThreadBranchOverrideChange: props.onActiveThreadBranchOverrideChange }
      : {}),
    envLocked: props.envLocked,
    onComposerFocusRequest: props.onComposerFocusRequest,
    ...(props.onCheckoutPullRequestRequest
      ? { onCheckoutPullRequestRequest: props.onCheckoutPullRequestRequest }
      : {}),
  };

  const card = (
    <div
      className={cn(
        // A single-track grid, because a grid area is a definite containing block: the card's own
        // height is "content, clamped by max-height", which percentages treat as indefinite — as
        // a plain block (or even a flex column) every `h-full`/`max-h-full` down the chain
        // resolved to nothing, the scroll area's viewport stayed at its content height, and the
        // card's overflow-hidden clipped the content instead of scrolling it. `minmax(0,1fr)`
        // still shrink-wraps short content while letting the clamp bite on tall content.
        "dropdown-glass isolate contain-paint grid max-h-full grid-rows-[minmax(0,1fr)] overflow-hidden rounded-[20px]",
        // The popup's real ceiling is what base-ui measured for it — the anchor's clipping
        // ancestors, which is how an open terminal drawer shrinks it — less the popover
        // viewport's own p-2. The dvh term is the fallback's fallback, from before.
        props.mode === "popover" &&
          "max-h-[min(calc(100dvh-6.5rem),calc(var(--available-height,100dvh)-1rem))]",
      )}
      data-thread-details-card
    >
      <ScrollArea scrollFade className="min-h-0">
        <section aria-labelledby="thread-details-workspace-heading">
          <div className="flex min-h-10 items-center justify-between gap-3 px-3.5 pb-1 pt-3">
            <h3
              id="thread-details-workspace-heading"
              className="text-[11px] font-medium text-muted-foreground"
            >
              Workspace
            </h3>
          </div>

          {connectionIssue ? (
            <div className="mx-3 mb-2 rounded-xl border border-warning/30 bg-warning/6 p-3">
              <div className="flex gap-2">
                <AlertTriangleIcon className="mt-0.5 size-3.5 shrink-0 text-warning" />
                <div className="min-w-0 flex-1">
                  <p className="text-xs font-medium">Environment unavailable</p>
                  <p className="mt-1 text-[11px] leading-relaxed text-muted-foreground">
                    {props.environmentConnection?.error ??
                      "Reconnect this environment before sending messages or running actions."}
                  </p>
                  <div className="mt-2 flex items-center gap-1.5">
                    <Button
                      size="xs"
                      disabled={isReconnecting}
                      onClick={props.onReconnectEnvironment}
                    >
                      {isReconnecting ? "Reconnecting..." : "Reconnect"}
                    </Button>
                    <Button size="xs" variant="ghost" onClick={props.onOpenConnectionSettings}>
                      Connections
                    </Button>
                  </div>
                </div>
              </div>
            </div>
          ) : null}

          {props.versionMismatch ? (
            <div className="mx-3 mb-2 flex gap-2 rounded-xl border border-warning/30 bg-warning/6 p-3">
              <AlertTriangleIcon className="mt-0.5 size-3.5 shrink-0 text-warning" />
              <div className="min-w-0 flex-1">
                <p className="text-xs font-medium">Client and server versions differ</p>
                <p className="mt-1 text-[11px] leading-relaxed text-muted-foreground">
                  Client {props.versionMismatch.clientVersion} · {props.versionMismatch.serverLabel}{" "}
                  {props.versionMismatch.serverVersion}
                </p>
              </div>
              <Button
                size="icon-xs"
                variant="ghost"
                aria-label="Dismiss version mismatch warning"
                onClick={props.onDismissVersionMismatch}
              >
                <XIcon className="size-3.5" />
              </Button>
            </div>
          ) : null}

          <div className="flex flex-col px-2 pb-2.5">
            {props.availableEnvironments.length > 1 ? (
              <BranchToolbarEnvironmentSelector
                displayMode="panel"
                envLocked={props.envLocked}
                environmentId={props.environmentId}
                availableEnvironments={props.availableEnvironments}
                onEnvironmentChange={props.onEnvironmentChange}
              />
            ) : null}

            <BranchToolbar layout="panel" panelSection="workspace" {...branchToolbarProps} />

            {props.showOpenInPicker ? (
              <OpenInPicker
                environmentId={props.environmentId}
                keybindings={props.keybindings}
                availableEditors={props.availableEditors}
                openInCwd={props.gitCwd}
                displayMode="panel"
              />
            ) : null}

            {props.activeProjectScripts ? (
              <ProjectScriptsControl
                displayMode="panel"
                scripts={props.activeProjectScripts}
                fileScripts={fileScripts}
                keybindings={props.keybindings}
                preferredScriptId={props.preferredScriptId}
                onRunScript={props.onRunProjectScript}
                onAddScript={props.onAddProjectScript}
                onUpdateScript={props.onUpdateProjectScript}
                onDeleteScript={props.onDeleteProjectScript}
              />
            ) : null}
          </div>
        </section>

        {!props.draftId && props.activeProjectName ? (
          <ProviderUsageSection
            providers={props.providers}
            providerInstanceIds={props.providerInstanceIds}
            show={props.showProviderUsage}
          />
        ) : null}

        {props.gitCwd ? (
          <section
            aria-labelledby="thread-details-version-control-heading"
            className="border-t border-border/65"
          >
            <div className="px-3.5 pb-1 pt-3">
              <h3
                id="thread-details-version-control-heading"
                className="text-[11px] font-medium text-muted-foreground"
              >
                Version Control
              </h3>
            </div>
            <div className="flex flex-col px-2 pb-2.5">
              {props.isGitRepo ? (
                <BranchToolbar layout="panel" panelSection="branch" {...branchToolbarProps} />
              ) : null}
              {props.activeProjectName ? (
                <GitActionsControl
                  displayMode="panel"
                  gitCwd={props.gitCwd}
                  activeThreadRef={{ environmentId: props.environmentId, threadId: props.threadId }}
                  {...(props.draftId ? { draftId: props.draftId } : {})}
                  {...(props.onOpenChanges ? { onOpenChanges: props.onOpenChanges } : {})}
                />
              ) : null}
            </div>
          </section>
        ) : null}

        {!props.draftId ? (
          <ThreadAutomationsPanel environmentId={props.environmentId} threadId={props.threadId} />
        ) : null}

        {!props.draftId ? (
          <ThreadRelationshipsPanel environmentId={props.environmentId} threadId={props.threadId} />
        ) : null}
      </ScrollArea>
    </div>
  );

  if (props.mode === "popover") {
    return <div data-thread-details-panel="popover">{card}</div>;
  }

  return (
    <aside
      aria-label="Thread details"
      className="absolute inset-y-0 right-[var(--app-scrollbar-width)] z-20 w-[var(--thread-details-panel-width)] p-3"
      data-thread-details-panel="inline"
    >
      {card}
    </aside>
  );
}
